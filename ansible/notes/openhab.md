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

## UI layout (Main UI, since 2026-11-14)

Built for a laptop and a phone (cards are 1 column on a phone, 2–3 on a laptop).

* **Overview** (home): a "Now" row (outside temperature, metered power with today's kWh/€,
  system status, watering while it runs), the main lights and the room temperatures. Tapping
  power or system opens the detail page.
* **House** (sidebar): a tabs page with Lights, Climate, Energy, Garden, TV, System. The
  individual pages (`lights`, `climate`, `energy`, `garden`, `system`, the TV remote) are hidden
  from the sidebar.
* `overview_2024` is the previous overview, kept hidden for comparison. Delete it once the new
  one has settled.
* Pages live only in jsondb (`uicomponents_ui_page.json`), covered by the nightly backup. Edit
  them in the UI. To change them in bulk, stop openHAB (`docker stop -t 120`) and edit the file:
  the REST API needs an admin token for writes.
* Light tiles show "ON" until the brightness arrives, then "ON at x%". The Hue v1 API polls every
  10 s, so a light switched on from openHAB briefly reports brightness 0.

Data behind the pages, all file-based:
* `conf/items/energyMeters.items`: `gEnergyPower` is a `SUM` group (metered house power);
  `EnergyToday_kWh/_Cost` and `EnergyMonth_kWh/_Cost` are computed every minute by the rule
  "Energy: today and this month" in `energy.rules` (counter minus its lowest value since midnight
  or the 1st, from InfluxDB).
* `conf/things/system.things`, `conf/items/system.items`, `conf/rules/system.rules`: one
  `System_*` item per service with "OK" or what is wrong (Thing status of the Hue bridge, MQTT
  broker, Modbus meters and Metriful; the zigbee2mqtt bridge state over MQTT; price age over 48 h;
  room sensors and Evohome without data). `System_Issues_Count` drives the Overview's System tile.

Semantic model: the energy meters are `ElectricMeter` equipment under `MeterBox` (with power,
energy, cost, voltage, ... points); Evohome has a `RadiatorControl` per room (new locations
`Bathroom` and `Attic`); the TV is `LoungeTV` in the living room. The bedroom wall-switch gang
items are deliberately outside the model.

Round 2 (same evening):
* Overview: Now (outside, Energy ›, Next bin ›, System ›, watering), Lights grouped by room,
  Appliances (washer, dryer, hood), Cameras (one card per camera, room for three), Climate.
  Tabs: Lights, Climate, Energy, Appliances, Garden, Cameras, TV, System. `energy_chart` is a
  chart page (stacked power per circuit, 24 h) used instead of the Grafana embed: Grafana has
  `allow_embedding = false`, so it can't be framed.
* Kitchen: the UI never toggles the kitchen lights directly. `KitchenLights_Scene`
  (FULL/DIM/OFF) goes through a rule in `lights.rules` that sets the lights and
  `kitchenLightsMode` together. The wall-switch rules ignore state changes for 4 s after
  their own commands. Before this, the fixture's delayed report of a UI tap looked like a wall
  press and the lights cycled dimmed <-> all on for ~40 s.
* Appliances: `appliances.things/items` read the homeconnect-proxy events
  (`hc-proxy/<haId>/+`). They are filtered per key (REGEX, then JSONPATH). The events are not
  retained, so the states stay NULL until the appliance next reports; mapdb restores them.
* Cameras: `cameras.things/items/rules` read Frigate's retained `frigate/<cam>/person/snapshot`
  (last person, not a live view) and `frigate/available`.
* Bins: `garbage.rules` computes `Garbage_Next/_NextDate/_NextInDays`, and mapdb restores the
  dates. afvalwijzer only publishes when started with `--pub2mqtt`, which its cron line lacked
  (2026-11-14).
* Energy: per circuit `EnergyMeterNN_TodayKwh/_TodayCost/_MonthKwh/_MonthCost`, with a
  today/month switch on the Energy tab.

Round 3 (same evening):
* Overview order: Now, Climate, Lights per room (Bedroom purple, Kitchen orange, Outside teal),
  Appliances, Cameras. Tile colours carry meaning: temperature bands, appliance
  running/finished/attention, bins (yellow = today/tomorrow), system red with issues.
* Appliances: washer, dryer and dishwasher (`014040394371002509`, no brand prefix in its haId).
  `appliances.rules` polls the proxy: `/homeappliances` every 10 min for `<App>_Online`, and
  `/<haId>/status` plus `/programs/active` at startup, hourly and when an appliance comes
  online. MQTT events update in between.
* Kitchen rules: changes from NULL (first report after a restart) are ignored, and the 22:00
  dim rule counts as an own command. On 2026-11-14 a NULL -> ON report at 22:00 had switched the
  hood lights back on.
* Cameras: ipcamera Things `ipcamera:generic:<id>` read go2rtc on unas:1984 (frame.jpeg /
  stream.mjpeg, basic auth user `openhab`) and are served by openHAB at
  `/ipcamera/<id>/ipcamera.jpg|autofps.mjpeg`. Overview: snapshot every 10 s; Cameras tab:
  `autofps.mjpeg` (built from snapshots, faster on motion). `ipcamera.mjpeg` needs ffmpeg, which
  the openHAB image does not have, so it serves nothing.
* Evohome: `binding-evohome` is installed. The account bridge holds the Honeywell login and is
  created in the UI, not in files. The managed `Evohome_Actual*`/`Evohome_Setpoint*` items are
  linked to the zone channels (their history is kept); `conf/items/evohome.items` adds the system
  mode (`SystemMode`: Auto, AutoWithEco, Away, DayOff, HeatingOff, Custom), the setpoint status
  per zone (FollowSchedule / TemporaryOverride / PermanentOverride) and Lu's room temperature.
  A SetPoint command is a permanent override; 0 cancels it. The binding does not expose the
  schedule. The old MQTT `Evohome` Thing (`mqtt:topic:8153076b`, no publisher) is disabled.
  After many restarts in a short time the cloud login can fail ("Authentication failed",
  OFFLINE/COMMUNICATION_ERROR; likely throttling) and the binding never retries by itself.
  `automation/js/evohomeHeal.js` disables + enables the account bridge every 30 min while it is
  in that state. Not the decommissioned-URL bug (openhab-addons #20338, fixed by #20298 in 5.2):
  the 5.2.4 jar already uses `tccna.resideo.com`.
* Cell colours: oh-label-cells only paint `color` while `on` is true, so every coloured cell
  carries an `on` expression. A label cell's heading is `title` (not `header`); the big text is
  `label`.

Round 5:
* Detail popups (`action: popup`, `actionModal: page:<uid>`): `appliance_washer/_dryer/_dishwasher/_hood`
  from the Appliances tiles, `bins` from the bin tile. `energy_meters` holds per-meter voltage,
  current, PF, frequency, reading and Modbus id. The Overview has `sidebar: true, order 0`, so it
  is listed above House.
* Room temperatures come from the room sensors: Metriful (living room), Zigbee (bedroom,
  Lu's room, attic office: `atticOffice.things/items`, z2m `attic_thsensor`). Only the bathroom
  uses the Evohome thermostat's own reading (no sensor there).
* "Attic" is labelled "Attic office" (location, heating group, pages). The room under the
  dakkapel gets its own location later, together with its sensor and lights.
* Front garden: `frontDrip.things/items/rules` for the micro-drip controller at 192.168.5.30
  (`start?interval=1hr|2hrs|3hrs`, `off`, `remainingWateringTime`), plus the Zigbee outlet
  (`garden_power_socket`, item `SONOFFPowerSocket_State`, "Front garden socket"). The irrigation
  controller at 192.168.5.10 (sprinkler + drip) stays in `gardenWatering.rules`.
* The Energy tile colour follows the metered power: green < 500 W, orange < 2 kW, red above.

Rounds 6-8:
* Main UI expressions have no `isNaN()`: test `items.X.state == 'NULL'` instead. A bare
  `oh-stepper-item` on a Number:Temperature item never sent a command; the heating holds use list
  items whose `actionCommand` is an expression (`=(setpoint + 0.5).toFixed(1) + ' °C'`).
* Overview Climate/Lights: one card per room (`f7-card` with a coloured left border), built
  from own tiles (`div` + `oh-link` + `Label`, flex width, background
  `rgba(var(--f7-color-<name>-rgb), 0.38)`), and `oh-slider` under dimmable lights. Standard
  oh-cells keep a fixed narrow width inside a card, so they were not used there. Heating tiles
  open `heating_<zone>` popups.
* Round 9-10: the room cards are vertical lists (icon, name, value; colour only for out-of-range
  values), with an 8 px margin and a 6 px room-coloured left stripe. Dimmable lights open a popup
  (`light_bedroom_main/_night`, `light_front_door`, `light_veranda`: on/off, brightness, colour
  temperature); non-dimmable lights toggle on tap. The Now tiles are neutral and light up only
  for alerts.
* Hood: `Hood_FanLevel` (stages 1-3, from the hood's VentingLevel events; hood.rules "Set fan
  stage" restarts venting at that stage).
* A z2m humidity channel must not get `unit="%"`: the item then stores 0.55 instead of 55.
* After an openHAB restart the miio downlights (front door) can stay UNINITIALIZED
  (NOT_YET_READY), although they are reachable. `openhab:things disable` + `enable` of both
  `miio:generic:*` things fixes it; `automation/js/miioHeal.js` does that every 10 min.
* Start level 100 is reached about 2 min after the container starts, so startup-triggered rules
  run late (and did not run at all after one restart). Zigbee lights only report on change:
  lights.rules asks zigbee2mqtt (`<dev>/get`) after startup and, every 5 min, while a kitchen light
  is still NULL.
* Icons: MDI has no range hood; the hood uses `iconify:material-symbols:range-hood-outline`.

Round 4: Climate tab = heating mode buttons + per room a setpoint stepper and "Back to schedule";
the Overview Climate row starts with a Heating tile (tap to change the mode) and shows the
setpoint and overrides per room.

Known gaps (2026-11-15): Hue Go is unreachable. (The heating items come from the Evohome
binding; the garbage dates are restored from mapdb and refreshed by afvalwijzer at 19:00.)

## Related devices

* Wall tablet dashboard (iPad, `/static/tablet/`) and its charging plug: see
  `openhab/tablet-dashboard.md` and `openhab/smart-plug-lspa9.md`.

* Energy meters, price and cost: see `energy-monitoring/README.md` (things, items, `energy.rules`,
  persistence, the `energy-tariff` container). The garden soil sensor's Modbus thing is
  disabled while the sensor is broken, because its timeouts block the shared RS485 bus.

* Modbus RS485 gateway: USR-DR302 at 192.168.5.100. It is a TCP server on 502 with Modbus
  TCP->RTU and 9600 8N1. Its web UI "TX count" stays 0 even when it works. It forwards every
  serial reply to all connected TCP clients.
* **Command loop on 5.x:** never link an MQTT channel that has "Is command" (`postCommand`) to
  an item that also commands the same channel. openHAB 5 sends the command back to its source
  channel; the device echoes its state; that becomes a new command. Since the 5.2.4 restart the
  bedroom wall switch looped like this at about 5 commands a second. Fix (2026-11-14): "Is
  command" is off on both gangs. Each gang has its own item
  (`conf/items/bedroomWallSwitch.items`). `conf/rules/bedroomWallSwitch.rules` syncs it with the
  Hue `_Power` item, on `changed` only and ignoring changes from NULL. The left gang is a relay
  that powers the Bedroom L/R bulbs, so Hue -> switch only ever turns that relay ON. Otherwise an
  "off" from the app would cut power, and an unreachable bulb's flapping state would cycle it.
* The Bedroom L/R bulbs (Hue LTA001) had joined zigbee2mqtt by mistake, so Hue lost them.
  Recovery: force-remove them in z2m, then add them in the Hue app by serial number with the
  relay ON. They kept their Hue light IDs 9 and 10, so group 3 stayed intact.
* zigbee2mqtt and mosquitto upgrade independently of openHAB: openHAB uses only generic
  `mqtt:topic` things. They rely on z2m `advanced.output: attribute` (one topic per
  property). Since z2m 2.x (2026-11-20) the bedroom night light switch thing
  (`mqtt:topic:02be5417`) reads `bedroom_night_light_switch/action` instead of `/click`.
  The rule in `lights.rules` ignores empty, NULL and UNDEF action updates, so a blank update
  cannot toggle the light again. `mqtt:topic:fc0460de` (`test_switch/click`) is stale:
  no z2m device has that name.
