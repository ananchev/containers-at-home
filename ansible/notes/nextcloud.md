## Topology

Everything runs on vhost's local **NVMe** (`{{ docker_data_root }}` = `/nvme/containers`):

| Container | Purpose | Volume |
|---|---|---|
| `nextcloud-app` | Apache + PHP (official `nextcloud:*-apache`) | `…/nextcloud/html` → `/var/www/html` |
| `nextcloud-cron` | background jobs (`/cron.sh`) | shares the `html` + `data` volumes |
| `nextcloud-postgres` | database | `…/nextcloud/postgres` |
| `nextcloud-redis` | file locking + distributed cache | `…/nextcloud/redis` |
| `nextcloud-onlyoffice` | OnlyOffice Document Server (in-place Office editing) | `…/nextcloud/onlyoffice/{data,log,lib}` |

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

# Shared JWT secret signing every Nextcloud <-> Document Server request.
# Generate once: openssl rand -hex 32  — see "OnlyOffice in-place editing" below.
nextcloud_onlyoffice_jwt_secret: "<openssl rand -hex 32>"
```

Reused from the existing vault: `backup_private_key`, `backup_user`.

## Image versions & DIUN watching

`nextcloud.yml` reads its images from the vaulted `app_versions.yml` keys
`nextcloud_app`, `nextcloud_db`, `nextcloud_redis`, `nextcloud_elasticsearch` and
`nextcloud_onlyoffice` (the Document Server) — so those entries are the single source
of truth for both the deployed tags and DIUN's watchlist. Add e.g.:

```yaml
  nextcloud_onlyoffice:
    image: "onlyoffice/documentserver:latest"
    diun_include_pattern: '^\d+\.\d+\.\d+$'
``` Each entry pins the `image:` tag and carries a `diun_include_pattern` (and
optional `diun_watch: false`) in the usual `app_versions.yml` style; there are no
versions hardcoded here or in the playbook to keep in sync.

> **Pin `nextcloud_app` to a major the FTS apps support.** `fulltextsearch` &co. lag
> the newest Nextcloud by weeks to months. As of 2026-10 they support **34**
> (`fulltextsearch` 34.0.3, `fulltextsearch_elasticsearch` 34.0.3,
> `files_fulltextsearch` 34.0.1); nothing official for **35** yet. Check the app store
> (`apps.nextcloud.com/api/v1/platform/<ver>/apps.json`) before bumping a major.

`nextcloud_elasticsearch` is run **as-is** — document-content extraction
(`ingest-attachment`) is a bundled module since ES 8.4, so there's no plugin install
or local build. (`elasticsearch-plugin list` is therefore empty; check it with
`curl -s 'localhost:9200/_nodes/plugins?filter_path=nodes.*.modules.name'` inside the
container instead.) It must be real **Elasticsearch**, not OpenSearch — the `fulltextsearch_elasticsearch` app's
elastic client does a product-check that rejects OpenSearch. We run **ES 9.4.x**:
the app's README still says "Elasticsearch 8 only", but that's stale — app ≥ 31.0.1
uses an ES 9 client and works against 9 (validated by `occ fulltextsearch:test`).
Stay on 9.x patch releases; trial a 9.x **minor** bump on its own deploy. E.g.:

```yaml
  nextcloud_elasticsearch:
    image: "elasticsearch:9.4.8"
    diun_include_pattern: '^\d+\.\d+\.\d+$'
    diun_watch: false   # bumped together with the nextcloud stack
```

> Upgrade Nextcloud **one major at a time** (never skip a major) by bumping the
> `nextcloud_app` tag in `app_versions.yml` and re-running the playbook. The image
> runs `occ upgrade` automatically on start; the playbook waits for `occ status` to
> report `installed: true` before continuing.

> **Postgres: stay on the major (17.x).** A minor/Alpine bump (e.g. `17.3-alpine3.21`
> → `17.11-alpine3.24`) is just a container recreate. A **major** bump (→ 18) changes
> the on-disk format and needs `pg_upgrade` or a dump/restore — never just a tag change.

### Upgrade log

* **2026-10-24 — PHP2Shell (CVE-2026-109618 / CVE-2026-109619).** Unauthenticated
  RCE in the PHP engine, exploited in the wild; fixed in PHP 8.5.12 / 8.4.27 / 8.3.36
  / 8.2.35 (released 2026-10-21). We were on `nextcloud:33.0.5-apache` = PHP 8.4.22.
  `33.0.10-apache` was **not** a safe fix: Docker Hub pushed it (2026-10-23 17:17Z)
  before the patched `php:8.4-apache-trixie` base (18:57Z), so it likely still had
  8.4.26. NC 34 builds on `php:8.5-apache-trixie` (8.5.12 pushed 15:58Z, before
  `34.0.5-apache`), so we went 33.0.5 → **34.0.5** (one major) and verified PHP 8.5.12
  via `docker exec nextcloud-app php -v`. **Lesson:** after a PHP CVE, check the image
  ships the fixed PHP (`php -v`); a newer Nextcloud tag doesn't guarantee it.
  * The post-upgrade `occ fulltextsearch:test` failed only at *Locking process*
    (`Index is already running`) — platform + ES checks passed. Either the cron was
    indexing or a lock was orphaned by the container swap; cleared with
    `occ fulltextsearch:stop`, then the test passed.
  * Follow-up deploy: `postgres` 17.3-alpine3.21 → 17.11-alpine3.24, `redis`
    alpine3.21 → alpine3.23, `elasticsearch` 9.4.2 → 9.4.8. The MCP server + shim
    were retired in the same change (see below).
  * Dropped the local `nextcloud-elasticsearch:local` build: its only step,
    `elasticsearch-plugin install ingest-attachment`, has been a no-op since ES 8.4
    (now a bundled module). The container runs the stock image directly.

## Playbook structure

`applications/nextcloud.yml` is a thin orchestrator: the play header + all vars,
then a block that `import_tasks` the phases in dependency order from
`applications/tasks/nextcloud/`. Each import is **tagged** so a single concern can
be (re)deployed alone:

| Include | Tag | Contents |
|---|---|---|
| `prep.yml` | `prep` / `restore` | NVMe dirs, restore detection + config-tar restore |
| `datastores.yml` | `datastores` | network, Elasticsearch build/run, Redis, Postgres, DB restore |
| `app.yml` | `app` | app + cron containers, install-wait, post-install `occ`, backup SSH key |
| `fulltextsearch.yml` | `fts` | ES-wait, install/wire FTS apps, validate |
| `onlyoffice.yml` | `onlyoffice` | DS dirs + container + health-wait + connector |

A full run (no `--tags`) executes every phase in order, exactly as the old
single-file playbook did. Scoped runs assume the shared bits an earlier phase
created (the docker network, the app container) already exist — true after any
prior full deploy; a first-ever deploy must run the whole play.

## Deploy

```bash
# full deploy (all phases, dependency order)
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost

# scoped — just one phase, e.g. OnlyOffice (no image-rebuild churn)
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost --tags onlyoffice
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

## OnlyOffice in-place editing

Renders/edits `docx`/`xlsx`/`pptx` in the browser. The editor is **client-side**, so
the **Document Server** (`nextcloud-onlyoffice`) is the one Nextcloud component that
must be browser-reachable — the single new public hostname. Everything heavy stays
off Cloudflare:

| Direction | URL (connector key) | Path |
|---|---|---|
| Browser → DS | `https://office.tonio.cc/` (`DocumentServerUrl`) | NPM on fed → CF (editor JS + websockets only) |
| NC → DS | `http://nextcloud-onlyoffice/` (`DocumentServerInternalUrl`) | docker `nextcloud-net` |
| DS → NC | `http://192.168.2.3:8080/` (`StorageUrl`) | host LAN IP — file download/save |

`StorageUrl` is the **LAN IP, not the container name**, on purpose: `192.168.2.3` is
already a trusted domain, so the DS's file fetch/save never trips Nextcloud's
untrusted-domain guard and never needs a `NEXTCLOUD_TRUSTED_DOMAINS` edit.

**Security boundary:** a shared **JWT secret** (`nextcloud_onlyoffice_jwt_secret` in
the vault, `openssl rand -hex 32`) signs every NC↔DS request, set on both the DS
container (`JWT_SECRET`) and the connector (`jwt_secret`). The playbook waits on the
DS `/healthcheck` before wiring the connector.

### Exposure (NPM on fed)

Add a proxy host `office.tonio.cc` → `http://192.168.2.3:8082`, **Websockets on**,
attach the `*.tonio.cc` wildcard cert with Force SSL, and reuse the **Cloudflare-IP
allowlist + `deny all`** block in the Advanced tab — same front-door pattern as the
other CF-fronted hosts. (Single-label so CF Universal SSL / the wildcard covers it.)

> **Don't** add `proxy_*` / `chunked_transfer_encoding` directives
> to NPM's Advanced tab — they fail `nginx -t` in that context and NPM silently skips
> writing the host (→ Cloudflare 525). Websockets toggle + the CF allowlist is all it
> needs.

After deploy, verify in Nextcloud **Settings → Administration → ONLYOFFICE** that the
connection check is green, then open any Office file.

**Backups: nothing to add to `backup_definitions.yml`.** OnlyOffice introduces no new
source-of-truth state. The connector's *config* (jwt_secret + URLs) lives in the NC DB
(`oc_appconfig`) — captured by the existing `nextcloud-postgres` dump *and* re-applied
every deploy from the vault — and its *app code* installs into `custom_apps`, captured
by the existing `nextcloud-app` `config custom_apps` tar. The documents themselves are
in the data dir already rsynced to the NAS. The `…/onlyoffice/{data,log,lib}` volumes
are the DS's own pg/redis/cache — **derived/rebuildable**, deliberately not backed up
(same treatment as the FTS apps). Because the jwt_secret is re-applied from the vault to
both the DS env and the connector on every run, a restored DB can't drift out of sync.

### Deploy

The five OnlyOffice tasks are tagged `onlyoffice` and self-contained (they create
their own dirs), so once the stack exists you can redeploy *just* this slice without
paying the full playbook's image-rebuild churn:

```bash
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost --tags onlyoffice
```

(A scoped run assumes `nextcloud-net` already exists — true after any prior full
deploy. A first-ever deploy runs the whole playbook.) A full re-run is also safe and
idempotent.

## Roadmap: content indexing & search

Planned as a follow-up phase (the design keeps it first-class because everything is
local NVMe):

1. **Full-text search — DONE.** `nextcloud-elasticsearch` (single node, security
   disabled, internal-only) runs on `nextcloud-net` from the stock `nextcloud_elasticsearch`
   image, whose bundled `ingest-attachment` module indexes document *contents*. (Must be
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
3. **Context Chat / MCP — RETIRED (2026-10).** Built and ran for a while (MCP server
   + auth shim for claude.ai web), then removed as unused. See the section below.

## MCP access for claude.ai (web) — retired 2026-10

The `nextcloud-mcp` server (built from the `ananchev/nextcloud-mcp-server`
`feat/full-text-search` fork) and the `nextcloud-mcp-shim` OAuth Resource Server
(exposed as `ncmcp.tonio.cc`, gated by the shared `mcp-auth` AS on unas) were removed
because they weren't used. A one-off teardown run removed the containers, images and
`…/nextcloud/mcp-{shim,fork}` checkouts, after which `tasks/nextcloud/mcp.yml` was
deleted. Both containers were stateless, so there was no data to migrate.

Manual leftovers (outside the playbook):

* **NPM on fed:** delete the `ncmcp.tonio.cc` proxy host (→ `192.168.2.3:8093`), and its
  Cloudflare DNS record if it has one.
* **Nextcloud:** delete the `mcp` user (its app password dies with it). This also drops
  the read-only shares to it and its `/AI` sandbox — check `/AI` for anything worth
  keeping first.
* **Vault:** remove `nextcloud_mcp_app_password` from `vault.yml`. Leave
  `mcp_auth_server.*` — `mcp-auth` still serves the cycling-stack / healthbridge MCPs.
* **claude.ai:** remove the Nextcloud (`ncmcp`) connector.

If it's ever revived, the design (shim as RS for `mcp-auth`, least privilege via
read-only shares + an owned `/AI` sandbox, the fixed `mcp-oauth-client` client ID to
skip DCR, no `proxy_*` directives in NPM's Advanced tab) is in git history before
this change, and in the [`ananchev/nextcloud-mcp-shim`] repo.

[`ananchev/nextcloud-mcp-shim`]: https://github.com/ananchev/nextcloud-mcp-shim
