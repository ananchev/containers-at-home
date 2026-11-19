# Smart plug for the tablet dashboard: Elivco LSPA9

The plug that cycle-charges the iPad Air 1 behind the wall dashboard (see `tablet-dashboard.md`).
Control logic: `tablet-battery/README.md` (since 2026-11-19 it reads the battery % from the
jailbroken iPad; the plug's power reading is no longer used for decisions).

zigbee2mqtt friendly name: `smart_plug` (z2m on pi5, web UI port 8070).

## What it is

* Elivco LSPA9 is a white-label Tuya **TS011F_plug_1**, manufacturer id `_TZ3000_okaz9tjs`
  (also sold as Girier JR-ZPM03). Source: zigbee-herdsman-converters `tuya.ts`.
* zigbee2mqtt exposes `state`, `power` (W), `current`, `voltage` and `energy`.
  Device page: https://zigbee2mqtt.io/devices/LSPA9.html
* Metering chip BL0937; power is reported in whole watts. 1 W steps are enough to tell
  charging (~10 W) from near-full (2–3 W). No low-watt accuracy measurements were found for this
  exact variant: verify with the overnight test.
* Not in the Blakadder database.

## Known caveats (research 2026-11-15)

* **Reporting:** zigbee2mqtt deliberately does *not* configure reporting for this id. Before
  the fix of Oct 2025 (issue https://github.com/Koenkk/zigbee2mqtt/issues/29034) current and
  energy read about 1000x too high. So the plug may only send values when it decides to, and the
  polling workaround used for other TS011F plugs may not apply to this definition. Measure how
  often it updates on its own and whether `smart_plug/get` returns fresh values.
* **Random switch-off:** the device page warns the plug can switch off by itself; one user saw
  it on firmware `0122052017`. Check the firmware in the z2m UI (About tab).
* **Wi-Fi lookalikes:** some units sold under this name are Wi-Fi (an LN882H teardown). Ours
  pairs with z2m, so it is the Zigbee one.
* Integration: zigbee2mqtt + the MQTT binding (best supported). The openHAB Zigbee binding is
  not an option here (z2m owns the coordinator).

## Alternatives considered (if the LSPA9 fails the test)

Prices taken from search results on 2026-11-15 (not checked in the shops):

1. **Shelly Plug S Gen3** (S3PL-00112EU), about EUR 17 (Proshop.nl). Fully local
   (HTTP/websocket/MQTT), has an openHAB Shelly binding, sends updates quickly. Listed as discontinued;
   the "Plug S MTR Gen3" seems to replace it.
2. **IKEA INSPELNING**, about EUR 10 (price unverified). Zigbee, so it uses the existing z2m;
   readings down to 0.1 W reported, some users see noisy or slow values. Update its firmware first.
3. **Tapo P110**, about EUR 12.50 (123inkt.nl). Whole watts, polled (30 s, min 10 s). The
   tapocontrol binding needs the Tapo cloud login, and firmware updates have broken it before
   (switch protocol to KLAP; turn off auto-update). Avoid the P110M: its metering does not work
   over Matter.

The **Tapo P100** we already have has no metering at all (only the P110/P115 measure), so it can
only be a plain on/off plug.
