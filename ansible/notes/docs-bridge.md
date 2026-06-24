# docs-bridge

RAG stack (Qdrant + one-shot ingest-worker). One app = one playbook
(`applications/docs-bridge.yml`); the config contract is inline in its `vars: docs_bridge`,
per-host knobs in `host_tuning`. Host: `application_services['docs-bridge'].hosts` (vhost2).

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
1. Add to `docs_bridge.subjects` in the playbook: `- { name: X, dir: /data/docs/X, collection: X }`.
2. Re-run the deploy → creates the `/data/docs/X` drop dir + re-renders config.
3. `scp` docs to `<host>:/data/docs/X/`.
4. Ingest: `-e run_sync=true` (or `docker run … sync --subject X`).

Auto picked up by backup next run; restorable because it's now a listed subject. Removing a
subject does NOT drop its Qdrant collection (no GC) — delete by hand if unwanted.

## Daily delta re-ingest (TODO, later)
Ingest is incremental (hash-delta): re-running `sync --subject all` only parses+embeds
new/changed files and drops removed ones. To automate, schedule the one-shot daily (after the
03:00 backup) via a host systemd timer / cron running the same `docker run … sync --subject all`
as the playbook's `run_sync` task. Not yet wired.
