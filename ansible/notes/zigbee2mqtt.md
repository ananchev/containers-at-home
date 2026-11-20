# zigbee2mqtt

* Runs on pi5. Data is in `/data/docker/zigbee2mqtt/data`, and the frontend is on port 8070.
* Coordinator: SMLIGHT SLZB-06M at 192.168.5.101. It connects over Ethernet, on TCP port
  6638, with the `ember` adapter. The radio is an EFR32MG21 running EmberZNet 7.4.5. The
  Zigbee channel is 20. The network lives in the coordinator's NVRAM, so a z2m upgrade or
  restore does not change it. Change the coordinator firmware in a separate step from z2m
  upgrades. Its web UI has no auth.
* openHAB depends on `advanced.output: attribute`, which gives one topic per property, such as
  `zigbee2mqtt/<dev>/state`. Availability and `bridge/state` are JSON (`$.state`).
* Deploy: `applications/zigbee2mqtt.yml`.
  * It restores the staged `application_data/zigbee2mqtt/backup.tar.gz` only into an empty
    data dir. The check is for a missing `configuration.yaml`.
  * If the data dir is empty and no backup is staged, it fails. Pass
    `-e allow_empty_deploy=true` to override, which means a new network.

## Upgrade 1.42.0 -> 2.14.3 (2026-11-20)

* Before the upgrade, these were removed from `configuration.yaml`: `external_converters`
  (`mtReader.js`, which no device used), `legacy: true` on `bedroom_night_light_switch`, and
  `device_options.legacy`. `experimental.output` was moved to `advanced.output`.
* On first start, z2m migrated the settings from v1 to v5. `permit_join` was removed, so joining
  is off by default. It left `configuration_backup_v*.yaml` and `migration-*.log` in the data
  dir. The pre-upgrade copies are `configuration.yaml.pre-2x` and
  `/data/docker/zigbee2mqtt/zigbee2mqtt-1.42-preupgrade-20261120.tgz`.
* openHAB: the night light switch thing moved from `/click` to `/action`. See `openhab.md`.
* The Hoftronic HD300W-ZB dimmer (`0x04e3e5fffe92c4ce`) has been supported since zhc 25.42.0.

## Manual backup

* Create a backup of the container data:
```shell
docker exec -it zigbee2mqtt /bin/sh -c '
  tar \
    -czf /tmp/backup.tar.gz -C /app/data .
'
```

* When the backup is done, copy the file from the container to the host:
```shell
docker cp zigbee2mqtt:/tmp/backup.tar.gz /mnt/docker/zigbee2mqtt
```
