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

# App password (NOT the login password) of the dedicated `mcp` Nextcloud user.
# Generated manually once — see "MCP access for claude.ai (web)" below.
nextcloud_mcp_app_password: "<mcp user app password>"

# Shared JWT secret signing every Nextcloud <-> Document Server request.
# Generate once: openssl rand -hex 32  — see "OnlyOffice in-place editing" below.
nextcloud_onlyoffice_jwt_secret: "<openssl rand -hex 32>"
```

Reused from the existing vault: `backup_private_key`, `backup_user`. The MCP shim
also reads `mcp_auth_server.public_url` and `mcp_auth_server.oauth_signing_key` from
the **shared (symlinked) vault** — the same keys the `mcp-auth` AS uses on unas.

## Image versions & DIUN watching

`nextcloud.yml` reads its images from the vaulted `app_versions.yml` keys
`nextcloud_app`, `nextcloud_db`, `nextcloud_redis`, `nextcloud_elasticsearch`,
`nextcloud_mcp` (the stock upstream MCP server), and `nextcloud_onlyoffice` (the
Document Server) — so those entries are the single source of truth for both the
deployed tags and DIUN's watchlist. The shim image is
**built locally** from its git repo, so it has no `app_versions` entry. Add e.g.:

```yaml
  nextcloud_mcp:
    image: "ghcr.io/cbcoutinho/nextcloud-mcp-server:latest"
    diun_include_pattern: '^\d+\.\d+\.\d+$'

  nextcloud_onlyoffice:
    image: "onlyoffice/documentserver:latest"
    diun_include_pattern: '^\d+\.\d+\.\d+$'
``` Each entry pins the `image:` tag and carries a `diun_include_pattern` (and
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
| `mcp.yml` | `mcp` | MCP-server fork build/run, shim build/run |

A full run (no `--tags`) executes every phase in order, exactly as the old
single-file playbook did. Scoped runs assume the shared bits an earlier phase
created (the docker network, the app container) already exist — true after any
prior full deploy; a first-ever deploy must run the whole play.

## Deploy

```bash
# full deploy (all phases, dependency order)
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost

# scoped — just one phase, e.g. OnlyOffice or MCP (no image-rebuild churn)
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost --tags onlyoffice
./run-playbook.sh vhost nextcloud ~/.ssh/id_ed25519_vhost --tags mcp
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
untrusted-domain guard and never needs a `NEXTCLOUD_TRUSTED_DOMAINS` edit — same way
`nextcloud-mcp` reaches Nextcloud.

**Security boundary:** a shared **JWT secret** (`nextcloud_onlyoffice_jwt_secret` in
the vault, `openssl rand -hex 32`) signs every NC↔DS request, set on both the DS
container (`JWT_SECRET`) and the connector (`jwt_secret`). The playbook waits on the
DS `/healthcheck` before wiring the connector.

### Exposure (NPM on fed)

Add a proxy host `office.tonio.cc` → `http://192.168.2.3:8082`, **Websockets on**,
attach the `*.tonio.cc` wildcard cert with Force SSL, and reuse the **Cloudflare-IP
allowlist + `deny all`** block in the Advanced tab — same front-door pattern as the
other CF-fronted hosts. (Single-label so CF Universal SSL / the wildcard covers it.)

> Like the MCP shim, **don't** add `proxy_*` / `chunked_transfer_encoding` directives
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
idempotent; it just rebuilds the ES/shim/MCP-fork images every time (`force_source`/
`force: true`), so it's slower and noisier in the `changed=` count.

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
3. **Context Chat / MCP — DONE.** The AI stays external (claude.ai web); a stock MCP
   server + a thin auth shim run locally to expose "search/read/draft my Nextcloud"
   tooling, in the style of the cycling-stack / healthbridge MCP servers. See the
   dedicated section below.

## MCP access for claude.ai (web)

Lets claude.ai (web) reach Nextcloud as a remote MCP connector — "search this
directory… read that file… write a draft" — gated by the **existing** `mcp-auth`
OAuth Authorization Server (cycling-stack on unas). Two containers join `nextcloud-net`:

| Container | Role | Exposed? |
|---|---|---|
| `nextcloud-mcp` | stock [`cbcoutinho/nextcloud-mcp-server`] (single-user, Basic Auth, `:8000` `/mcp`) | no — internal only |
| `nextcloud-mcp-shim` | [`ananchev/nextcloud-mcp-shim`] OAuth Resource Server: RFC 9728 discovery + HS256 bearer gate + transparent proxy (`:8093`) | yes — via NPM |

**Why a shim:** the stock server can't validate `mcp-auth`'s tokens or emit RFC 9728
metadata, so it can't slot into the "one AS, many RS" model on its own. The shim is
that RS half; it reuses `mcp-auth` unchanged (audience-less HS256 — same signing key +
issuer is all it needs) and keeps the upstream stock/upgradable. It strips the caller's
`Authorization` header before proxying, so the bearer never leaks to the upstream (which
authenticates to Nextcloud with its own app password).

### Setup assumptions (manual bootstrap — do once)

The auth gate is **all-or-nothing**: a valid token grants the upstream's *full* toolset.
Least privilege is therefore enforced **downstream at the Nextcloud share layer**, so the
`mcp` user must own nothing of the real data. In the Nextcloud admin UI:

1. **Create a dedicated, NON-admin user** `mcp` (Settings → Users). It must **not** be
   in the `admin` group. This is the identity the upstream MCP server logs in as.
2. **Generate an app password** for it (sign in as `mcp` → Settings → Security → Devices
   & sessions → *Create new app password*), and put it in the vault as
   `nextcloud_mcp_app_password`. Never use the login password.
3. **Share the corpus READ-ONLY into `mcp`.** From your own account, share the folders
   the AI may read to the `mcp` user with **Read only** permission (no create/edit/
   delete/reshare). Nextcloud enforces the permission bitmask server-side, below MCP.
4. **Give it an owned `/AI` sandbox** for drafts. As `mcp`, create a top-level `/AI`
   folder — the AI *owns* this, so worst case is junk in the sandbox, never deletion of
   real files. Point "write a draft" workflows here.

> Blast-radius model: read-only everywhere that matters + a throwaway sandbox it owns.
> Tightening further (a per-tool denylist) is a designed-in shim extension, not built.

### Exposure (NPM on fed)

Add a proxy host for the shim's single-label hostname → `http://192.168.2.3:8093`,
**Websockets on**, and **attach an SSL cert** (the `*.tonio.cc` wildcard, or a fresh
Let's Encrypt one) with Force SSL — same front-door pattern as `mcp-auth` (single-label
so Cloudflare Universal SSL covers it; `mcp-auth` already allows the
`claude.ai/api/mcp/auth_callback` redirect, so no AS change is needed).

The Advanced tab gets **only** the **Cloudflare-IP allowlist + `deny all`** (reuse the
same block as the other CF-fronted hosts).

> **Do NOT put `proxy_*` / `chunked_transfer_encoding` directives in the Advanced tab.**
> NPM runs `nginx -t` before writing the host's `.conf`; those fail the test in that
> context, so NPM silently skips writing the file and the host returns Cloudflare
> **525** (no origin TLS for that SNI) — which looks like a cert problem but isn't.
> If MCP's SSE streaming ever buffers, fix it at the **shim** (emit
> `X-Accel-Buffering: no` on streamed responses — nginx honours it per-response with
> no NPM custom config), not in NPM.

Verify from outside, then add the connector in claude.ai pointing at `https://ncmcp.tonio.cc/mcp`:

```bash
curl -s https://ncmcp.tonio.cc/.well-known/oauth-protected-resource | python3 -m json.tool
# resource == https://ncmcp.tonio.cc ; authorization_servers == [the mcp-auth URL]
curl -i https://ncmcp.tonio.cc/mcp   # 401 + WWW-Authenticate: Bearer resource_metadata="…"
curl -s https://ncmcp.tonio.cc/healthz   # {"status":"ok"}
```

### Adding the connector in claude.ai — set the OAuth Client ID manually

In the connector's advanced settings, set **OAuth Client ID** = `mcp-oauth-client`
(leave the secret blank — it's a public, PKCE-only client).

Why: claude.ai first tries **Dynamic Client Registration** (RFC 7591) against the AS to
get a client_id automatically. `mcp-auth`'s `/register` is a non-validating stub that
always returns the *fixed* id `mcp-oauth-client` and keeps no client registry — its
authorize/token endpoints don't check client_id at all (auth is operator login + the
redirect-URI allowlist + PKCE). When the auto-registration step hiccups (it's rate-limited
per IP, and claude.ai aborts on any non-clean DCR response with *"Couldn't register with
…'s sign-in service"*), entering the known fixed id skips DCR entirely and the flow goes
straight to authorize + PKCE. Because the AS ignores client_id everywhere except echoing
it, the static value works identically to a registered one — so it's the reliable path.

> No new backups: both containers are stateless and the `/AI` sandbox lives in the
> Nextcloud data dir already rsynced to the NAS.

[`cbcoutinho/nextcloud-mcp-server`]: https://github.com/cbcoutinho/nextcloud-mcp-server
[`ananchev/nextcloud-mcp-shim`]: https://github.com/ananchev/nextcloud-mcp-shim

