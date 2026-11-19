# Dashboard iPad battery control

The iPad Air 1 behind the wall dashboard (`../tablet-dashboard.md`) hangs on a Zigbee plug
(Elivco LSPA9, z2m `smart_plug`, see `../smart-plug-lspa9.md`). openHAB keeps the battery between
**40 and 70 %** by switching the plug, using the battery % **read from the iPad itself**.

Replaced on 2026-11-19 the predictive version (estimate from the plug's wall Wh, drain model, taper
re-sync, Telegram calibration bot). That needed constant recalibration and once drifted by 55 %.

## How it reads the battery

The iPad is jailbroken (checkra1n 0.12.4, iOS 12.5.8) with OpenSSH from Cydia. Every minute
`automation/js/tabletBattery.js` runs:

```
ssh -F /openhab/userdata/ssh/config dashboard-ipad \
  "ioreg -rn AppleARMPMUCharger | grep -E '\"(CurrentCapacity|IsCharging|ExternalConnected|FullyCharged)\" ='"
```

* `CurrentCapacity` = battery %, `IsCharging`, `ExternalConnected` = the iPad sees power from the charger.
* Extras for the wear/drain review (items `TabletBattery_Temperature/Voltage/Current/Power`):
  `Temperature` (1/100 °C), `Voltage` (mV), `InstantAmperage` (mA, printed as unsigned 64-bit: decode as
  signed, negative = draining; -491 mA ≈ -1.96 W with the screen on). `CycleCount` and the capacity keys are
  not read: the battery is an aftermarket replacement and its gauge reports 1 cycle / 100 % health.
* openHAB side, all from `applications/openhab.yml`:
  * `openssh-client` is installed by `cont-init.d/10-openssh-client.sh` (mounted at `/etc/cont-init.d`)
    when the container is created; the image has no ssh.
  * `userdata/ssh/dashboard_ipad` (key, from vault `dashboard_ipad.ssh_private_key`),
    `userdata/ssh/config` (host `dashboard-ipad` -> vault `dashboard_ipad.ip`, user root).
    `known_hosts` is pinned on the first connection (`accept-new`).
* iPad side: the public key in `/var/root/.ssh/authorized_keys`; `/etc/ssh/sshd_config` has
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`.
  The checkra1n dropbear (port 44) listens on localhost only (USB).

## Logic (every minute)

| Situation | Plug | Telegram |
|---|---|---|
| reading OK, level <= Low (40) | ON | "plug -> ON" (if `TabletBattery_Notify`) |
| reading OK, level >= High (70) | OFF | "plug -> OFF" |
| reading OK, in between | unchanged (hysteresis) | - |
| **read failed** (first time) | **ON at once** | - |
| 3 failed reads in a row | stays ON, `TabletBattery_Reachable` OFF | ⚠️ unreadable, re-run checkra1n |
| still unreadable at 09:00 | stays ON | daily reminder |
| readings back | normal control | ✅ resolved + level |
| level stuck < 95 % for 2 h | ON | ⚠️ reading not trusted |
| plug ON, iPad sees no charger for 5 min | - | ⚠️ cable / charger / plug |
| plug ignores commands 4 min / plug offline in z2m | - | ⚠️ |

Alerts: `TabletBattery_Alert` holds the active alert keys (`unreadable`, `stale`, `no_charger`,
`plug_ignores`, `plug_offline`, or `-`). When a key appears, its message is sent once, saying what is
wrong, what the failsafe did and what to do. When the key clears, a ✅ message is sent with the
duration. Switches made by the failsafe are not announced separately, because the alert covers them.
Normal switching sends `🔌 Dashboard iPad: plug ON at 40%, charging up to 70%.` or
`🔋 … plug OFF at 70%, draining down to 40%.`
(turn these off with `TabletBattery_Notify` OFF).

`TabletBattery_Enabled` OFF = hands off: openHAB does not switch the plug, but readings and alerts continue.

Telegram: `/ipad` sends a status card with the buttons 🔄 Refresh and ⏸ Disable / ▶️ Enable control.
The bot's shared command menu and the pattern for adding more devices are in `../telegram-bot/README.md`.

## When the iPad reboots

checkra1n is semi-tethered: after a reboot iOS starts unjailbroken, sshd does not run, readings fail,
the plug goes ON and Telegram asks to re-jailbreak. Nothing has to be reconfigured, everything
installed stays on disk:

1. Connect the iPad to the Mac through a **USB-A hub** (the M3's USB-C ports do not get an A7 into
   DFU reliably), run checkra1n.
2. DFU: hold Power + Home 8 s, release Power, keep Home 10 s; the screen stays black.
3. After the boot readings resume within a minute.

Never use "Restore System" in the checkra1n loader app: it removes the jailbreak and everything installed.

## Files

* `automation/js/tabletBattery.js` -> `conf/automation/js/`
* `items/tabletBattery.items` -> `conf/items/` (plug items, battery readings, control settings)
* `things/tabletPlug.things` -> `conf/things/`
* `things/telegram.things.example` -> `conf/things/telegram.things` (holds the token, not in git; also used
  by `homeCalendar.js`)

SELinux on pi5: new conf files need `chcon --reference=<an existing conf file>`.
