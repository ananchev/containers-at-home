# openHAB

Runs on pi5 (`applications/openhab.yml`), image pinned in `app_versions.yml`. Data lives in
`/data/docker/openhab/{addons,conf,userdata}`.

## Backup and restore

* The nightly backup is automated (`backups/backup_definitions.yml`, application `openhab`): a
  tar of `userdata` + `conf` without `userdata/{backup,tmp,cache,logs}`. It lands as
  `backup.tar.gz` in the application's backup folder.
* The playbook restores that archive **only** into an empty target (no
  `userdata/etc/version.properties`). With an empty target and no staged archive it fails,
  unless you pass `-e allow_empty_deploy=true` for a deliberate fresh install. Re-running the
  playbook after a version bump therefore never overwrites live data.

## Upgrades

* Bump the image tag and run the playbook. On first start, the image's entrypoint compares
  `userdata/etc/version.properties`, runs the upgrade tool and keeps a copy in
  `userdata/backup/`. Delete that copy once the new version is stable.
* After a major upgrade, restart the container once more (`docker restart -t 120 openhab`).
  The first start on 5.2.4 logged `FrameworkEvent ERROR ... Invalid class loader from a
  refreshed bundle` while the DSL rules loaded; the second start was clean.
* A clean stop takes about 30s, so the container has `stop_timeout: 120`. A SIGKILL can lose
  pending jsondb writes. Always use `docker stop -t 120` / `docker restart -t 120`.
* History: 4.3.3 -> 5.2.4 on 2026-11-14. JRuby was dropped; the hood and garden-watering rules
  are now DSL (`conf/rules/hood.rules`, `conf/rules/gardenWatering.rules`).

## Karaf console

Port 8101 is not published. Use it from the host:

```shell
sudo docker exec -it openhab /openhab/runtime/bin/client -u openhab -p <console password>
```

Gotchas:
* `openhab:automation removeRule` reports success, but managed rules come back after a
  restart. Stop the container and edit `userdata/jsondb/automation_rules.json` instead.
* `config:property-set -p <pid> ...` replaces the whole config of that pid (it wiped
  `org.openhab.addons`). `config:delete <pid>` is safe.
* Links: `openhab:links link <item> <channelUID>` (default profile).

## Related devices

* Modbus RS485 gateway: USR-DR302 at 192.168.5.100. It is a TCP server on 502 with Modbus
  TCP->RTU and 9600 8N1. Its web UI "TX count" stays 0 even when it works. It forwards every
  serial reply to all connected TCP clients.
* zigbee2mqtt and mosquitto upgrade independently of openHAB: openHAB uses only generic
  `mqtt:topic` things. With z2m 2.x, the `/click` topics (`bedroom_night_light_switch`,
  `test_switch`) become `/action`; update `BedroomNightLightSwitch_Click` in `lights.rules`.
