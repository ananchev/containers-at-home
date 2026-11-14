# InfluxDB

Runs on pi5 (`applications/influxdb.yml`), image `influx-grafana` in `app_versions.yml`. It stays
on the **1.x** line: 2.x and 3.x are different products with other query languages. The DIUN
pattern is `^1\.\d+\.\d+$`. The data lives in `/data/docker/influxdb/data`; the database
`openhab` holds everything (openHAB persistence, energy monitoring).

## Backup and restore

* The nightly backup is automated (`backups/backup_definitions.yml`, application `influxdb`):
  `influxd backup -portable` plus `influxdb.conf`. They are staged as `backup.tar.gz` and
  `influxdb.conf` in the application's backup folder.
* The playbook restores **only** into an empty target (no `data/meta/meta.db`). With an empty
  target and no staged backup it fails, unless you pass `-e allow_empty_deploy=true`. Re-running
  it after a version bump therefore leaves live data alone.
* A portable backup has no users or privileges. On a restore the playbook recreates `admin` and
  `openhab`, sending the passwords over stdin, so they never land in a file.

## Upgrades

* **Since 1.11, the official image runs as `influxdb` (uid/gid 1500), not as root.** The playbook
  sets the data directory's owner to 1500 on every run. It also pre-creates `/backup` inside the
  container, owned by 1500. The nightly backup runs `influxd backup -portable /backup` through
  `docker exec` as that user, and a non-root user can't create a directory in `/`. Without it,
  the backup fails, and the missing archive then aborts the rest of pi5's nightly backups.
* Before a bump: run `influxd backup -portable` from the running container and make a cold copy
  of `data/` while it is stopped. Check the config against the release notes.
* History: 1.8.10 -> 1.13.2 on 2026-11-14, a direct jump. It needed no config changes (the
  `inmem` index is still supported) and had 37 s of downtime.
* Admin-only statements (DROP/DELETE) need the `admin` user, whose password is in the vault.
  Run them from a throwaway playbook with `no_log: true`, passing the password as an environment
  variable (`docker exec -e INFLUX_USERNAME -e INFLUX_PASSWORD influxdb influx -execute ...`) so it
  never appears in output or on a command line.
