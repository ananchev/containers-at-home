### Conditional Backup Execution

The backup system is designed to run from a single playbook (`take_backups.yml`) across multiple hosts. It selectively performs backups by dynamically checking if an application belongs to the host the playbook is currently running on.

This is achieved by:

1.  **Centralized Host Mapping**: A central variable file (`app_services.yml`) defines which host(s) each application is assigned to. This provides a single source of truth for application placement.

    ```yaml
    # app_services.yml
    application_services:
      zigbee2mqtt: { hosts: [fed] }
      rustdesk: { hosts: [unraid] }
      # ...
    ```

2.  **Decoupled Backup Definitions**: The `backup_definitions.yml` file only contains the technical steps for backing up an application, without any host information.

    ```yaml
    # backup_definitions.yml
    backup_definitions:
      - application: zigbee2mqtt
        container: zigbee2mqtt
        # ...
    ```

3.  **Dynamic `when` condition**: The main backup task in `take_backups.yml` loops through all backup definitions. It uses a `when` condition to look up the application's assigned host from the central mapping and compares it to the `inventory_hostname` of the machine it's currently running on.

    ```yaml
    # take_backups.yml
    - name: Backup containers
      include_tasks: backup_tasks.yml
      loop: "{{ backup_definitions }}"
      # This condition checks whether the current host runs the application
      when: inventory_hostname in application_services[item.application].hosts
      # ...
    ```

4.  **Leveraging `inventory_hostname`**: Ansible's `inventory_hostname` magic variable provides the name of the current host as defined in the inventory file (e.g., `fed`, `unraid`). This allows the `when` condition to dynamically filter and execute only the relevant backups for each host.

    **Trap**: `application_services[<app>]` must key off the *exact* `application:` value used in `backup_definitions.yml`, not some other name for the same app. If an app is deployed as a bundled unit (e.g. `arr-stack`, `cycling-stack`) but its `backup_definitions.yml` entries used the individual container names instead, the `.get(item.application, {})` lookup silently returns `{}` and the `when` is always false on every host — the backup is skipped forever with no error. (This happened to radarr/sonarr/bazarr for ~2 months before being caught — fixed 2026-07 by using `application: arr-stack` for all three, matching the multi-container-per-application pattern already used by cycling-stack/nextcloud/immich.)

### The node→ZFS mirror never deletes anything

The `host_commands` rsync step in `take_backups.yml` (staging dir → `zfs_backup_target_host`) does **not** use `--delete`. This is deliberate — it means a run where an app's definition is temporarily broken/missing can never *delete* that app's last good backup from the live mirror, only fail to refresh it. The trade-off: if an app is permanently renamed or removed from `backup_definitions.yml`, its old directory on the live mirror (`{{ zfs_backup_target_location }}`, e.g. `/mnt/zfspool/containers-backup/<app>/`) is never cleaned up — it just sits there, unchanged, and gets copied into **every future daily ZFS snapshot** forever (not just the snapshots that already existed before the rename).

This is easy to mistake for "history that will age out via retention" — it won't. ZFS/Unraid retention only expires whole dated *snapshots*; it has no visibility into stale content inside the live dataset that keeps getting freshly re-snapshotted every night. Already-taken snapshots are unaffected by any of this (they're immutable), so deleting an orphaned directory from the live mirror never loses real history — it only stops that orphan from being duplicated into snapshots that haven't been taken yet.

**When you rename or remove an app from `backup_definitions.yml`**: manually `rm` its old directory under the live mirror path on the ZFS host once. (Cleaned up 2026-07 for `cycling-coach` → `cycling-stack` and the legacy `memos/backup.tar.gz` → `memos.sql`/`postgres_globals.sql` switch.)

### backup-audit (staleness/integrity check)

A separate script, `/boot/config/plugins/user.scripts/scripts/backup-audit/script` on `unas` (Unraid User Scripts plugin — **not tracked in this git repo**, edit it in place over SSH), runs nightly and Telegram-alerts on: missing snapshot paths, apps that vanished vs. yesterday, hollow/empty app dirs, zero-size files, checksum mismatches between the ZFS snapshot and the Unraid array copy, and files older than 24h ("stale").

Two known false-positive sources and how they're handled:
- **`docker cp` preserves the container's file mtime**, not the copy time. A low-churn hand-edited file (e.g. `homepage/bookmarks.yaml`) can look "stale" for weeks even though it's copied correctly every night. Fixed at the source (2026-07): `backup_tasks.yml`'s copy-file task now `touch`es the destination right after `docker cp`, for every app — not a per-file exclusion.
- **Apps intentionally torn down but kept for a future rebuild** (e.g. `guacamole` — stack removed 2026-06-22, backups deliberately kept so it can be restored later) will always look stale since nothing writes to them anymore, but the backup itself is exactly what you want preserved. Handled via an `EXCLUDE_STALE` array at the top of the audit script — it only suppresses the staleness warning for that app; checksum/size/existence checks still run, so corruption of the frozen backup still alerts. Add an app's directory name to `EXCLUDE_STALE` when you intentionally freeze it; remove the entry once it's redeployed and backing up normally again.