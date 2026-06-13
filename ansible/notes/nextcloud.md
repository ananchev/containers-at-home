## Topology

Everything runs on vhost's local **NVMe** (`{{ docker_data_root }}` = `/nvme/containers`):

| Container | Purpose | Volume |
|---|---|---|
| `nextcloud-app` | Apache + PHP (official `nextcloud:*-apache`) | `…/nextcloud/html` → `/var/www/html` |
| `nextcloud-cron` | background jobs (`/cron.sh`) | shares the `html` + `data` volumes |
| `nextcloud-postgres` | database | `…/nextcloud/postgres` |
| `nextcloud-redis` | file locking + distributed cache | `…/nextcloud/redis` |

The **user file archive** (data dir) is `…/nextcloud/data` on the same NVMe — so the
live instance touches **no NFS**: no hard-mount hangs, no array spin-up stalls, and
content indexing stays fully local and fast. This mirrors the immich model on this host.

> Decision history: we deliberately chose primary-on-NVMe + backup-to-NAS over
> data-on-NFS. NFS (even over the solid 2.5Gbit link) makes Nextcloud's `appdata`
> previews + future full-text/Recognize indexing second-class and exposes the
> instance to NAS blips. The archive is capped by vhost's NVMe (~760G free) instead
> of the 3.7T array — an accepted trade for speed + first-class search.

## Reverse proxy (nginx-proxy-manager on fed)

* Proxy host: `cloud.tonio.cc` → `http://192.168.2.3:8080`, **Websockets on**, **Block Common Exploits off** (NC has its own headers), request body size raised (`client_max_body_size 16G` in the Advanced tab to match `PHP_UPLOAD_LIMIT`).
* The container is told it sits behind a proxy via `TRUSTED_PROXIES` (fed/NPM
  `192.168.2.8` **+ Cloudflare's published ranges**, so brute-force / rate-limit
  protection records the real visitor IP, not the CF/NPM hop), `OVERWRITEPROTOCOL=https`,
  `OVERWRITEHOST`/`OVERWRITECLIURL=https://cloud.tonio.cc`, `APACHE_DISABLE_REWRITE_IP=1`.
* After first start, verify `occ config:list system` shows the `overwrite*` keys and
  that the **Security & setup warnings** admin page is clean (esp. the reverse-proxy
  and `.well-known/{caldav,carddav}` checks — add the well-known redirects in NPM's
  Advanced tab if flagged).

## Required vault variables

`app_versions.yml` and `vault.yml` are vault-encrypted, so the playbook can't edit
them. Add these to `group_vars/all/vault.yml`:

```yaml
nextcloud_admin_password: "<admin password>"
nextcloud_db_password:    "<postgres password>"
nextcloud_redis_password: "<redis password>"
```

Reused from the existing vault: `backup_private_key`, `backup_user`.

## Image versions & DIUN watching

`nextcloud.yml` reads its images from the vaulted `app_versions.yml` keys
`nextcloud_app`, `nextcloud_db`, `nextcloud_redis`, and `nextcloud_elasticsearch` — so
those entries are the single source of truth for both the deployed tags and DIUN's
watchlist. Each entry pins the `image:` tag and carries a `diun_include_pattern` (and
optional `diun_watch: false`) in the usual `app_versions.yml` style; there are no
versions hardcoded here or in the playbook to keep in sync.

> **Pin `nextcloud_app` to a major the FTS apps support.** `fulltextsearch` &co. lag
> the newest Nextcloud — they support up to **33**, not 34. Check the app store
> (`apps.nextcloud.com/api/v1/platform/<ver>/apps.json`) before bumping a major.

`nextcloud_elasticsearch` is the **base** image for the locally-built
`nextcloud-elasticsearch:local` (the playbook bakes in `ingest-attachment`). It must be
real **Elasticsearch**, not OpenSearch — the `fulltextsearch_elasticsearch` app's
elastic client does a product-check that rejects OpenSearch. E.g.:

```yaml
  nextcloud_elasticsearch:
    image: "docker.elastic.co/elasticsearch/elasticsearch:8.15.3"
    diun_include_pattern: '^\d+\.\d+\.\d+$'
    diun_watch: false   # bumped together with the nextcloud stack
```

> Upgrade Nextcloud **one major at a time** (never skip a major) by bumping the
> `nextcloud_app` tag in `app_versions.yml` and re-running the playbook. The image
> runs `occ upgrade` automatically on start; the playbook waits for `occ status` to
> report `installed: true` before continuing.

## Deploy

```bash
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost
```

## Backups

Captured by `ansible/backups/backup_definitions.yml` and the normal pipeline:

* **Database** (`nextcloud-postgres`): `pg_dump … | gzip` → `nextcloud_db.sql.gz`,
  rsynced to the ZFS target and rolled into borg.
* **App config** (`nextcloud-app`): `tar` of `/var/www/html/{config,custom_apps}`
  → `backup.tar.gz` (contains `config.php` with `instanceid`/`secret`/`passwordsalt`
  — required for a consistent restore).
* **File archive** (`nextcloud-app` `host_commands`): `rsync --delete` of
  `{{ docker_data_root }}/nextcloud/data/` to
  `{{ large_backups_host }}:{{ large_backups_location }}nextcloud` over the 2.5Gbit
  link (identical to the immich media job). The array copy is then **versioned +
  offsite via borg** through the `nextcloud` repo in `borg_repos` (`global_vars.yml`).
  The SSH key (`~/.ssh/nextcloud_backup_key`) is deployed by `nextcloud.yml` from
  `{{ backup_private_key }}`.


### Restore

The playbook auto-restores **DB + config** when the backup files are present in
`{{ application_data }}/nextcloud/` (`nextcloud_db.sql.gz`, `backup.tar.gz`) — same
flow as immich. The **data dir** is restored manually by rsyncing it back from the
array before the first run:

```bash
# on vhost, as ananchev
rsync -av \
  -e "ssh -i ~/.ssh/nextcloud_backup_key -o StrictHostKeyChecking=no" \
  {{ backup_user }}@{{ large_backups_host }}:{{ large_backups_location }}nextcloud/ \
  /nvme/containers/nextcloud/data/
sudo chown -R 33:33 /nvme/containers/nextcloud/data
```

After any restore, run `occ maintenance:data-fingerprint` (forces clients to
re-sync) and `occ files:scan --all` if the data dir was touched out-of-band.

## Roadmap: content indexing & search

Planned as a follow-up phase (the design keeps it first-class because everything is
local NVMe):

1. **Full-text search — DONE.** `nextcloud-elasticsearch` (single node, security
   disabled, internal-only) runs on `nextcloud-net`, built from `nextcloud_elasticsearch`
   with the `ingest-attachment` plugin so document *contents* are indexed. (Must be
   Elasticsearch, not OpenSearch — the app's elastic client product-check rejects
   OpenSearch.) The playbook sets `vm.max_map_count`, caps the JVM heap
   (`elasticsearch_heap`, 2g ≈ 50% of the limit) and the container memory
   (`elasticsearch_mem_limit`, 4g), installs `fulltextsearch` +
   `fulltextsearch_elasticsearch` + `files_fulltextsearch`, points the platform at
   `http://nextcloud-elasticsearch:9200`, and validates with `occ fulltextsearch:test`.
   * **Run the initial full index once** (heavy/long, so kept manual):
     ```bash
     ssh vhost 'docker exec -u www-data nextcloud-app php occ fulltextsearch:index'
     ```
     Because the data dir is primary storage (not external), the background cron keeps
     the index current automatically afterwards.
   * The index is **derived/rebuildable** — not backed up. After a restore, just re-run
     `fulltextsearch:index`. If large PDFs OOM the Tika parser at 512m, raise
     `elasticsearch_heap` / `elasticsearch_mem_limit`.
2. **Recognize** — *excluded by design*: it's local-only ML and photos live in immich,
   not Nextcloud.
3. **Context Chat / MCP** — the AI stays external (Claude API); only a lightweight **MCP
   server** would run locally to expose "search my Nextcloud" tooling, in the style of
   the cycling-stack / healthbridge MCP servers already on the estate.

