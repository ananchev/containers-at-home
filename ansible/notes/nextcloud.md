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
* The container is told it sits behind a proxy via `TRUSTED_PROXIES=192.168.2.8`,
  `OVERWRITEPROTOCOL=https`, `OVERWRITEHOST`/`OVERWRITECLIURL=https://cloud.tonio.cc`,
  `APACHE_DISABLE_REWRITE_IP=1`.
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
`nextcloud_app`, `nextcloud_db`, `nextcloud_redis` — so those entries are the single
source of truth for both the deployed tags and DIUN's watchlist. Each entry pins the
`image:` tag and carries a `diun_include_pattern` (and optional `diun_watch: false`)
in the usual `app_versions.yml` style; there are no versions hardcoded here or in the
playbook to keep in sync.

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

1. **Full-text search** — add an `opensearch` container to `nextcloud-net`, then
   install `fulltextsearch` + `fulltextsearch_elasticsearch` + `files_fulltextsearch`;
   index with `occ fulltextsearch:index`. Because the data dir is primary storage
   (not external), live update hooks keep the index current automatically.
2. **Recognize** — AI tagging / object & face recognition for photos and documents
   (TensorFlow; heavy first run, then incremental).
3. **Context Chat / Assistant** — semantic search + LLM Q&A over documents; the
   natural bridge to an **MCP** layer (cf. the cycling-stack / healthbridge MCP
   servers already on the estate) for "search my Nextcloud" tools.

