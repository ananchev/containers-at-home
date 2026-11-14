# Grafana

Runs on pi5 (`applications/grafana.yml`), image `grafana` in `app_versions.yml`. Its data
(`grafana.db`, plugins) lives in `/data/docker/grafana/data`. The only datasource is
InfluxDB (uid `TSXICM2Gk`, `http://influxdb:8086`, on the `influx-grafana` network).

## Backup and restore

* The nightly backup is automated (`backups/backup_definitions.yml`, application `grafana`): a
  tar of `/var/lib/grafana`, including the dashboards. Dashboards are kept in Grafana's own
  database, not provisioned from the repo.
* The playbook restores **only** into an empty target (no `data/grafana.db`). With an empty
  target and no staged backup it fails, unless you pass `-e allow_empty_deploy=true`.
* The energy dashboard has a reference copy in `notes/energy-dashboard.json`, for rebuilding or
  comparing. Import it via Dashboards -> New -> Import.

## Upgrades

* One major version per step, with a cold copy of `data/` taken while the container is stopped.
  `grafana.db` migrates forward only.
* History: 11.5.1 -> 12.4.15 -> 13.3.1 on 2026-11-14.
  * Grafana 12 removed Angular. The legacy *Graph* panels were converted automatically.
  * `GF_INSTALL_PLUGINS` was dropped: it installed an unused panel. Unused third-party plugins
    were deleted from `data/plugins`.
  * Service-account tokens and dashboards survived both steps.
* Grafana 13 turns off the datasource APIs that address datasources by numeric id. Use the uid.
