# docs-bridge

The full RAG stack, one app = one playbook (`applications/docs-bridge.yml`), all on
`docs-bridge-net`: **Qdrant** (vector store) · **ingest-worker** (one-shot ingestion) ·
**docs-bridge server** (hybrid search+rerank, MCP+REST) · **LibreChat** front-end (chat UI +
OpenRouter synthesis, calls the server over `/mcp`) with its **MongoDB** + **Meilisearch**.
The config contract is inline in `vars: docs_bridge`, per-host knobs in `host_tuning`.
Host: `application_services['docs-bridge'].hosts` (vhost2). A host **systemd timer** runs the
daily incremental ingest (below).

**Structure:** `applications/docs-bridge.yml` is a thin master (vars + tagged imports). The
tasks live in `applications/tasks/docs-bridge/*.yml`, imported in dependency order with tags so
a single concern can be (re)run alone — `prep · images · qdrant · restore · server · librechat ·
schedule · ingest`. E.g. `--tags server` or `--tags librechat`; a full run (no `--tags`) does
all. Scoped runs assume earlier phases (images, network, config) already ran.

## Backup — derived state only
Backs up what is expensive to recompute: **Qdrant collections** (snapshot API, consistent)
+ the **SQLite manifest** (`state.tar.gz`). The corpus under `/data/docs` is NOT backed up
(re-ingestable source) — but each run emits `docs-manifest.tsv` (`sha256<TAB>bytes<TAB>relpath`)
so a restored index can be traced back to its source files.

- Runs from a **co-located `backup-node`** on each host in `application_services['containers-backup'].hosts`
  (incl. vhost2), crond **daily 03:00** → `take_backups.yml` → rsync to ZFS
  (`192.168.2.2:/mnt/zfspool/containers-backup/`). Collections are discovered live
  (`GET /collections`), so backup needs no per-collection config.
- Definition: the `docs-bridge` entry in `backups/backup_definitions.yml`.
- Run it now (don't wait for cron):
  `sudo docker exec containers-backup-node /ansible/backups/run-backup-playbook.sh`

## Restore — in the deploy playbook, idempotent
Per subject on deploy: snapshot staged + collection missing → recover; collection present →
leave it; manifest restored only if absent.

- Restore reads staged archives from the **control node** at `application_data/docs-bridge/`,
  NOT from ZFS automatically. Manual hop: mount ZFS on the control node (or copy) so
  `<collection>.snapshot` + `state.tar.gz` are there **before** running the deploy.
- Restore is **subject-driven** (loops `docs_bridge.subjects`); backup is live-discovery. A
  collection must be a listed subject to be restorable.
- Good round-trip proof: after restore, `points_count` matches AND a sync prints
  `0/0/0 unchanged` (collection + manifest consistent → no re-embed).

## Add a new subject (collection) — config only
1. Add a block to `docs_bridge.subjects` in the playbook with name/dir/collection +
   a `description:` (the single source of truth for what the corpus is — surfaced via
   `list_subjects()` and auto-composed into the MCP instructions catalog the model sees).
   The `server.instructions` policy text stays corpus-agnostic; don't name corpora there.
2. Re-run the deploy → creates the `/data/docs/X` drop dir + re-renders config.
3. `scp` docs to `<host>:/data/docs/X/`.
4. Ingest: `-e run_sync=true` (or `docker run … sync --subject X`).

Auto picked up by backup next run; restorable because it's now a listed subject. Removing a
subject does NOT drop its Qdrant collection (no GC) — delete by hand if unwanted.

## Daily delta re-ingest (host systemd timer)
Ingest is incremental (hash-delta): `sync --subject all` only parses+embeds new/changed files
and drops removed ones. The deploy installs a host **systemd timer** that runs the same
`podman run … sync --subject all` as the `run_sync` task:
- Units: `/etc/systemd/system/docs-bridge-ingest.{service,timer}` (rendered from
  `_templates/docs-bridge/ingest.{service,timer}.j2`). `Type=oneshot` (no overlap),
  `Persistent=true` (catch-up after downtime). Default `OnCalendar=*-*-* 03:30:00` (after the
  03:00 backup, low traffic to avoid BGE-M3 ingest/query contention); override via
  `-e docs_bridge_ingest_oncalendar=...`.
- Verify: `systemctl list-timers 'docs-bridge-ingest*'`; fire now with
  `sudo systemctl start docs-bridge-ingest.service`; logs via `journalctl -u docs-bridge-ingest`
  (expect `0 new / 0 changed / 0 deleted` when nothing changed).

## LibreChat front-end
Chat UI + OpenRouter synthesis; calls docs-bridge as an MCP tool so answers cite the corpus.
LAN-only at **http://192.168.2.199:3080** (no CF/NPM; off-LAN = VPN). Runs on `docs-bridge-net`
so the `/mcp` call is in-host container DNS (`http://docs-bridge:8080/mcp`).

**Secrets** — add to `vault.yml`:
```yaml
librechat_secrets:
  creds_key: "<openssl rand -hex 32>"   # 64 hex chars
  creds_iv:  "<openssl rand -hex 16>"   # 32 hex chars
  jwt_secret: "<openssl rand -hex 32>"
  jwt_refresh_secret: "<openssl rand -hex 32>"
  meili_master_key: "<openssl rand -hex 32>"
  openrouter_api_key: "sk-or-..."       # openrouter.ai/keys
```
`creds_key`/`creds_iv` MUST be exactly 32/16 bytes. The docs-bridge bearer is **reused** from
`docs_bridge_secrets.bearer_token` (read only when `librechat_enable_mcp=true`).

**Image pins** — add to vaulted `app_versions.yml` (pin exact tags once validated):
```yaml
librechat:       { image: ghcr.io/danny-avila/librechat:latest }
librechat-mongo: { image: docker.io/arm64v8/mongo:7.0 }
librechat-meili: { image: docker.io/getmeili/meilisearch:v1.12 }
```
MONGO IMAGE GOTCHA (vhost2 = Apple M2, Asahi, 16K-page kernel 6.19+). Two images that do
NOT work, and the one that does:
- `library/mongo` (Docker Hub official) — amd64 + Windows manifests only, **no linux/arm64**;
  the pull falls through to a Windows `nanoserver` variant and fails.
- `mongodb/mongodb-community-server` — has arm64, but its entrypoint has a hard guard that
  **refuses to start on kernel ≥ 6.19** ("allocator compatibility issues"), same family as the
  Qdrant jemalloc-on-16K problem.
- **`arm64v8/mongo:7.0`** (arch-specific official image) — an older build WITHOUT that guard;
  boots and serves fine. (Prints a benign "ARMv8.2-A features not detected" warning — Asahi
  doesn't advertise the flags, but the M2 implements the instructions, so mongod runs.) Ships
  `mongosh` (restore wait) and stores data at `/data/db` — drop-in. Pin a specific 7.0.x once happy.

**Deploy (staged):**
- **2.1** plain chat: `./run-playbook.sh vhost2 docs-bridge ~/.ssh/id_ed25519_vhost -K` → open
  http://192.168.2.199:3080, register, then re-run with `-e librechat_allow_registration=false`.
- **2.2** docs-bridge MCP: re-run with `-e librechat_enable_mcp=true` (renders the
  `mcpServers.docs-bridge` block + injects `DOCS_BRIDGE_TOKEN`; same network, no re-create churn
  beyond the app container). Ask an aig question → grounded answer; `docker logs docs-bridge`
  shows an authenticated `/mcp` call (no 401).
  GOTCHA 1 (SSRF): LibreChat blocks private/internal MCP hosts ("Domain http://docs-bridge:8080
  is not allowed") — the template exempts it via root-level `mcpSettings.allowedAddresses:
  ['docs-bridge:8080']` (an exemption list, not a strict whitelist, so public targets stay reachable).
  GOTCHA 2 (OAuth misdetection): for a STATIC-bearer server, the mcpServers entry MUST set
  `requiresOAuth: false` — else LibreChat probes WITHOUT the headers, gets docs-bridge's
  401+WWW-Authenticate, misclassifies it as OAuth-protected, and the (nonexistent) OAuth flow fails.

LibreChat uid: the image runs as `node` (uid 1000); the deploy chowns `images/uploads/logs` to
1000. If `docker exec librechat id` differs, adjust that task.

**Backup**: the `librechat-mongodb` entry in `backup_definitions.yml` (`mongodump --gzip`) is the
only LibreChat state backed up (meili is derived). Restored on a fresh deploy by the playbook.
