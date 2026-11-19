# Wall tablet dashboard (iPad Air 1)

A custom landing page for an old iPad Air 1 (iPadOS 12.5.8, Safari 12, 1 GB RAM). It is
not the Main UI: Main UI is too heavy for this device, so the page is plain HTML/CSS/JS.

* URL: `http://192.168.2.11:1234/static/tablet/index.html`
  (openHAB serves `conf/html/` at `/static/`).
* Source of truth: `tablet-dashboard/html/` (copy to `/data/docker/openhab/conf/html/tablet/`
  on pi5) and `tablet-dashboard/openhab/` (`items/tablet.items`, `rules/tablet.rules`).
* Deploy: `scp` the changed files, then write a new `version.txt`. An open page checks it
  every minute and reloads itself when it changes.

## Layout (1024 x 768, landscape, scaled to fit any other window)

* Clock with date, sunrise/sunset, inside temperature (Metriful) and outside temperature (veranda).
  Tap the date for "Upcoming": bins (`Garbagebinscollectiondates_*`) + Home calendar events (`HomeCal_Events`, see `home-calendar/README.md`) for 30 days, grouped by day.
* Weather: outside temperature from the veranda sensor; conditions, the next 12 h (2 h
  steps) and 3 days from Open-Meteo, fetched by the browser with rounded coordinates. A tap opens
  `page.html#weather` (not a tab): now (veranda temp/humidity + model feels-like, wind/gusts,
  pressure, clouds, UV), rain next 3 h (Open-Meteo `minutely_15`), air quality + pollen
  (air-quality-api.open-meteo.com, EAQI + CAMS pollen), next 24 h chart, 7 days.
* Power: `gEnergyPower` (colour < 500 W / < 2 kW / above), the biggest meter, `EnergyToday_*`,
  `EnergyMonth_*`, and a 24 h sparkline summed from the meters' influxdb history (the SUM group
  is not persisted).
* Cameras: `/ipcamera/<id>/ipcamera.jpg` every 10 s; a tap opens `autofps.mjpeg` full screen
  (closes after 2 min). Up to 3 from `CFG.cameras` in `app.js` share the panel; one that sees a
  person gets double width.
* "Now": indicators that only appear when relevant. Appliances running, paused, needing
  attention, or finished within 3 h; hood on; bin within 3 days (grey 2-3 days ahead, orange tomorrow/today); Home calendar events within 3 days (grey 2-3 days, blue tomorrow, orange today; icon by category); a tap on either opens Upcoming; system issues; a person
  on a camera; heating mode not Auto; watering.
* "Now" overflow: the indicators are sorted by importance (red, orange, violet, blue, green). Up to
  4 show at full size, 5-6 compact; with more, 5 compact plus a "+N more" row that opens
  the full list (closes after 60 s). No scrolling inside the panel: on a wall screen hidden content goes
  unnoticed.
* Buttons: `CFG.nav` in `app.js` (Climate, Lights, Energy, Appliances, Cameras, Garden →
  `page.html#<name>`); Night is pinned on the right. Up to 8 share the
  width, 9+ are compact, and past that the row scrolls sideways with a fade at the edge.
* Preview switches for design work: `?demo=N` (fake indicators), `?cams=N`, `?nav=N`.

## Subpages (`page.html#climate|lights|energy|appliances|cameras|garden`)

Content follows the Main UI pages of the same name; the code is in `pages.js` (styles `pages.css`).
Each page builds its DOM once and updates bound elements in place, so a slider is never redrawn
while it is dragged. Header: Home, the page title, one icon per page, clock. After 2 minutes
without a touch the page goes back to the landing page.

* Climate: heating mode (Schedule/Eco/Away/Day off/Off), one card per room (sensor temperature,
  humidity, thermostat reading, Schedule/Hold pill). The -/+ buttons change the setpoint in 0.5°
  steps and send it 1.5 s after the last tap; Evohome keeps it as a permanent override until
  "Back to schedule" (sends 0).
* Lights: Bedroom, Kitchen (scenes via `KitchenLights_Scene`, dimmed brightness), Entrance, Garden.
  Sliders send on release.
* Energy: power now, today, month, price (ct/kWh, "STALE" after 48 h); a 24 h house-power line
  (sum of the meters' influxdb history, touch for a crosshair) and per-circuit power plus a
  today/month kWh bar per circuit.
* Appliances: washer, dryer, dishwasher (status, progress, programme, door, "waiting to be
  emptied" with Clear), the hood (venting, fan stage 1-3, work light) and the laundry circuit.
* Cameras: live `autofps.mjpeg` (stopped when leaving the page), the last person snapshot
  (`Camera_Terrace_Person`) and Frigate status. Cameras are listed once, in `core.js`.
* Garden: sprinkler/drip runs (`runNNmin` toggles, `abortRun`), front-garden micro-drip,
  the outlet, soil sensors, garden lights.

Growing the lists:
* Light areas: `AREAS` in `pages.js`. Up to 4 areas show as columns with the sliders inline; from 5,
  compact cards (3 per row) and a dimmable light (or the kitchen's dimmed brightness) opens a
  popup with its sliders via the chevron.
* Appliances: `APPLIANCES` in `core.js` (shared with the landing page's Now chips). 1-4 in one row;
  5-6 three per row without the Progress row; the page scrolls if needed.
* Cameras: `CAMERAS` in `core.js`. Landing page: up to 3 thumbnails. Cameras page: one tab per camera
  with a red person badge.
* Camera view: a snapshot loop (`OH.camLoop`, next `ipcamera.jpg` as soon as the last one loaded,
  about 1 frame/s; the Thing polls go2rtc every second). `autofps.mjpeg` was too slow (a frame every
  ~15 s without motion). Real video would need ffmpeg in the openHAB image or a LAN-only proxy to
  go2rtc that adds its password.
* Preview switches: `?areas=N`, `?appl=N`, `?cams=N` (core/pages), `?demo=N`, `?nav=N` (landing).

Code layout: `core.js` (state store, event stream, commands, icon sprite, canvas scaling,
`version.txt` reload, 04:00 reload, the camera list), `app.js` (landing page), `pages.js`
(subpages).

## "Finished, waiting to be emptied"

`Washer_Unemptied`, `Dryer_Unemptied`, `Dishwasher_Unemptied` (`appliancesUnload.items/.rules`,
copies in `tablet-dashboard/openhab/`):
* ON when `<App>_State` changes to Finished; OFF when the door opens or a programme starts;
  `expire` turns them OFF after 12 h. Changes from NULL (mapdb restores after a restart) are
  ignored. Members of the Washer/Dryer/Dishwasher groups, so mapdb restores them too.
* Why not the state alone: the dishwasher goes Finished -> Ready by itself after a minute, and the
  washer powers off ~7 minutes after finishing and never reports its door after that (seen in
  events.log, 2026-11-15).
* Observed 2026-11-15 18:49: the dryer went Run -> Ready on door open without a Finished event
  (lost between Home Connect and openHAB; homeconnect-proxy MQTT fix still to be redeployed), so
  no "finished" chip appeared. The door-open path did work.
* Landing page: green "finished" for the first hour, then orange "still full"; two taps on the
  chip clear it (the first arms it for 4 s). The Appliances page has a Clear button.

## Data

* Reads anonymously: `/rest/items` once at load and after reconnects, then the SSE stream
  `/rest/events` (item `statechanged`). A watchdog reconnects after 90 s of silence. The dot in the
  bottom-right corner shows the connection.
* Writes: item commands from the subpages and `Tablet_NightMode` (anonymous POST works with the
  default implicit user role).

## Night mode

* `Tablet_NightMode` goes ON at 23:00 and OFF at 06:30 (`tablet.rules`); after a restart it is
  set from the time of day if NULL.
* On the page, the Night button sends ON, and a tap on the night screen sends OFF, so a manual
  change lasts until the next scheduled switch.
* Night screen: black, a dim warm clock, outside temperature, the next bin, today's/tomorrow's first calendar event and active alerts.
  The page cannot dim the backlight. Use the iPad brightness setting or Guided Access auto-lock.

## iOS home-screen app quirks (seen 2026-11-15)

* A tap on a plain `<a href>` leaves the home-screen app and opens Safari. `core.js` catches
  same-origin link taps and navigates from script (`location.href`), which stays in the app.
* `window.innerHeight` is too small there (translucent status bar), which left a band at the
  bottom. The canvas is sized from the fixed full-screen `#stage` element and takes the screen's
  real proportions (at least 1024x768 design px): extra height goes to the flexible rows (landing:
  power + cameras; Climate rooms, Energy, Cameras). Refitted 0.5 s and 2 s after load and on wake.
* The iPad home-screen app reports 1024x748 (status bar excluded) at y 0 in every measurement
  (inner, client, the fixed #stage), yet the bottom ~20 px are hidden: iOS 12 shifts the web view
  of a landscape-launched home-screen app down by the status bar height. Not detectable from
  script, so `core.js` keeps `STANDALONE_BOTTOM_RESERVE` (20 px) free in home-screen mode. The
  design minimum is 1024x720, so 728 renders at scale 1. If a dark strip ever shows at the bottom
  instead (iOS not shifting), lower the reserve.
* Status bar: `apple-mobile-web-app-status-bar-style` is `black` (opaque). With `black-translucent`
  the page was drawn under the status bar with a 748 px viewport and the bottom ~20 px (the
  buttons) ended up off-screen. iOS reads this tag when the app is added, so after changing it,
  delete and re-add the home-screen icon.
* Safari 12 grid: flexible rows must be `minmax(0, 1fr)`, not `1fr`, and images inside them
  absolutely positioned; otherwise a row is sized by the camera snapshot's natural 1920x1080
  height and the layout explodes (seen on the iPad 2026-11-15).
* Connection dot (bottom right): green = live event stream, amber = stream down but polling
  `/rest/items` every 15 s, red = no data. Tap it for a status panel (stream state, last event,
  errors, polls, screen size, standalone, user agent). Tap the panel to close it.

## Safari 12 rules for this code

ES2015 only: no `?.`, `??`, `Object.fromEntries`. No CSS flex `gap`, `aspect-ratio` or `inset`.
Use `xlink:href` in `<use>`. Parse local date strings by hand (Safari 12 reads
`2026-11-15T17:00` as UTC). The page reloads itself at 04:00.

## iPad setup

1. In Safari open the URL, then Share > Add to Home Screen. Start it from the icon: full screen,
   no browser bar.
2. Settings > General > Accessibility > Guided Access on; start it in the app (triple-click home).
3. Charging: the smart plug, see `smart-plug-lspa9.md`.

## Weather via the meteo.iot proxy (no internet on the iPad)

The iPad is cut off from the internet (edge `WAN_OUT rule 6`; disable that rule to give it internet
temporarily). The page fetches open-meteo through `http://meteo.iot` (`OH.METEO` in `core.js`), which is an NPM proxy
host on pi5. It is kept only in NPM's database, so rebuild it by hand if it gets lost:

* edge dnsmasq `30-iot-dhcp.conf`: `host-record=meteo.iot,192.168.2.11`; `LAN_IN rule 130` allows the iPad to pi5:80,1234.
* NPM proxy host `meteo.iot`, HTTP only, Publicly Accessible (the filter is in Advanced), Advanced:

```nginx
resolver 192.168.2.254 ipv6=off valid=60s;   # pi5 has no IPv6 route; AAAA answers made requests fail
allow 192.168.2.0/24;
allow 192.168.5.106;
deny  all;
proxy_ssl_server_name on;
location /v1/forecast {
    set $om_host api.open-meteo.com;
    proxy_set_header Host $om_host;
    proxy_ssl_name $om_host;
    proxy_pass https://$om_host$request_uri;
}
location /v1/air-quality {
    set $om_host air-quality-api.open-meteo.com;
    proxy_set_header Host $om_host;
    proxy_ssl_name $om_host;
    proxy_pass https://$om_host$request_uri;
}
location / { return 404; }
```

NPM always sends the client's `Host` upstream, and open-meteo rejects `meteo.iot`, so the locations are written
by hand in Advanced. A `location /` there makes NPM drop its own default location. Test:
`curl -H 'Host: meteo.iot' 'http://192.168.2.11/v1/forecast?latitude=52&longitude=5&current=temperature_2m'`.
