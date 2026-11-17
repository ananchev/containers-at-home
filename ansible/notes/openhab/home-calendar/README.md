# Home calendar (shared family calendar → openHAB → tablet)

One shared calendar for the household. Events show up on the tablet dashboard the same way the
bin pickups do:
- **Now panel:** grey from 3 days ahead, blue the day before, orange on the day.
- **Upcoming sheet:** tap the date under the clock, or any bin/event chip, for the next 30 days of bins and events, grouped by day.
- **Night mode:** the line shows today's or tomorrow's first event.

## Pieces

| What | Where |
|---|---|
| Calendar | Nextcloud (vhost), user **`home`**, calendar URI `Home` (display name "Home"). Nextcloud Calendar app 6.6.5 installed 2026-11-17 |
| openHAB credentials | `pi5:/data/docker/openhab/conf/services/homecal.secret.json`: `{url, user, password}`. The password is a Nextcloud app password named `openhab-pi5` (owner uid 1001, mode 600). **Not in git** |
| Rules | `automation/js/homeCalendar.js` → `pi5:…/conf/automation/js/`. Reader: every 10 min, at startup, on `HomeCal_Refresh`, **and within ~1 min of any change** (a getctag check every minute). It also holds the Telegram alerts, the 19:00 digest and the weekly holiday sync |
| Items | `items/homeCalendar.items` → `pi5:…/conf/items/`: `HomeCal_Events` (JSON), `HomeCal_Status`, `HomeCal_Updated`, `HomeCal_Refresh` |
| Dashboard | `tablet-dashboard/html/core.js` `OH.events()` (parse + category icon) and `app.js` (Now chips, `agendaHtml`, night line) |

The rule sends a CalDAV `REPORT` with `<c:expand>` to `http://192.168.2.3:8080/remote.php/dav/calendars/home/Home/`.
Nextcloud expands recurring events itself, so the rule does no RRULE handling. The window is now − 1 day to + 60 days, capped at 100 events.
`HomeCal_Events` is a sorted JSON array:

```json
{"uid": "...", "rid": "20261124T160000Z", "t": "Swimming", "s": 1795536000000, "e": 1795539600000, "c": ["Sport"], "loc": "..."}
{"uid": "...", "t": "Birthday", "ad": true, "s": "2026-11-19", "e": "2026-11-20", "c": ["Birthday"]}
```

- `s` and `e` are epoch ms for timed events, and `YYYY-MM-DD` with `e` exclusive for all-day events (`ad: true`).
- `rid` is only present on occurrences of recurring events.
- Ended and cancelled events are dropped.
- On an error, the rule keeps the last good `HomeCal_Events` and writes `Error: …` to `HomeCal_Status`.

The stock iCalendar binding is not used because it exposes only title, begin and end: no CATEGORIES, no all-day flag, and no UID (the UID is needed for editing from the dashboard later).

## Categories

Categories are standard iCal `CATEGORIES`, the "Categories" field in Nextcloud Calendar and most phone apps.
An event can have several. The dashboard picks an icon from the first category that matches (`CAL_ICONS` in `core.js`):

| Category (matches, case-insensitive) | Icon |
|---|---|
| birthday, verjaardag, anniversary | cake |
| health, doctor, dentist, medical | heart |
| school, kids, study | book |
| travel, holiday, vacation, vakantie, trip | plane |
| sport, swim, football, gym | ball |
| visit, guest, friends, family | person |
| home, house, repair, maintenance | house |
| anything else / none | calendar |

The Upcoming sheet lists the categories after the time. To add a category, add a line to `CAL_ICONS`. Nothing in openHAB needs to change.

## Display rules

| Kind | Now panel | Upcoming sheet |
|---|---|---|
| Timed (1 h) | grey 2–3 days ahead, blue tomorrow, orange today; "now, until 15:00" while running | on its day: "14:00–15:00 · location · categories" |
| All-day | same colours, "all day" | on its day |
| Multi-day (all-day Thu–Sat, or timed Fri 18:00 → Sun 14:00) | orange on the first day; later days grey "Day 2 of 3"; longer than 4 days (`CFG.longEventDays`): gone from Now after day 1 | on every day it covers, "(2/3)"; only the start day is coloured |
| Holiday (category Holiday) | grey star chip today / tomorrow only, countries merged ("NL, BG") | violet label in the day header: "★ Christmas Day (NL, BG)" |

## Accounts and setup (done in the Nextcloud UI)

1. As admin `ananchev`: Users → `home` → set a password. It is only needed to log in to the web UI as `home`.
2. Log in as `home` (private window) → Calendar:
   - **Share:** Home → ⋯ → Share with `ananchev`, *can edit*. You then manage Home from your own account (web and phone).
   - **Holidays: nothing to do.** Do *not* use Nextcloud's "Add holiday calendar": that creates a separate subscription per user. See *Public holidays* below.
3. Still as `home`: Personal settings → Security → *Create new app password*, one per family phone (revocable on its own).
   - **iOS:** Settings → Calendar → Accounts → Add → Other → *Add CalDAV account*. Server `cloud.tonio.cc`, user `home`, the app password.
   - **Android:** DAVx5 → "Login with URL and user name". URL `https://cloud.tonio.cc/remote.php/dav`, user `home`, the app password.
4. Changes reach the tablet within about a minute (ctag check).

For openHAB *rules* that should behave differently on holidays (heating, watering), use Ephemeris (`isBankHoliday`), not this calendar.

## Public holidays (NL + BG, written into Home)

The rule *Home calendar: public holiday sync* runs Mon 04:30 and at startup. It fetches this year's and next year's public holidays from [Nager.Date](https://date.nager.at); only the country code and year are sent.
It writes them **into the Home calendar**, so every device with Home sees them:
- One all-day event per day and English name, with countries merged: "Christmas Day", `CATEGORIES:Holiday,NL,BG`, and the local names in the description.
- Objects are named `holiday-<date>-<slug>.ics`. The sync only ever creates or deletes those.
- Upcoming holidays that vanish from the source are deleted. Past ones are kept.
- Countries: `HOLIDAY_COUNTRIES`. When two countries use different English names for the same day, `HOLIDAY_ALIAS` merges them (St. Stephen's Day → Second day of Christmas).
- Only nationwide holidays are included (`global`), so NL Good Friday and Liberation Day are in, regional ones are out.
- The reader turns `CATEGORIES:Holiday,…` into `h: "NL, BG"`. Don't edit these events by hand: the next sync recreates any you delete.

For openHAB *rules* that should behave differently on holidays, Ephemeris (`isBankHoliday`) is still the right tool.

## Telegram reminders

Sent by the Telegram bot `telegram:telegramBot:home` (`conf/things/telegram.things`) to its configured `chatIds`.
These are the same chats that get the tablet-charge alerts.

- **Per event:** set an **Alert** on the event in any calendar app ("15 minutes before", "1 day before", "at 9:00 on the day" for all-day events).
  The reader stores the alert times (`a` in `HomeCal_Events`). The rule *Home calendar: Telegram alerts* checks them every minute and sends
  "⏰ Dentist · tomorrow 09:20 · Tandarts Centrum".
  - An alert set less than ~1 min ahead can arrive up to a minute late.
  - Alerts more than 15 min overdue are dropped.
  - After an openHAB restart, an alert due in the last 15 min can be sent a second time.
- **Evening digest:** at 19:00 (`DIGEST_CRON` / `DIGEST_ENABLED` in the rule), a list of tomorrow's events and holidays. It is only sent when there is something.
- **Phones:** they still show their own notifications for the same alert. Telegram is for whoever doesn't have the calendar on their phone, or for the shared family chat.
- **Family chat:** create a Telegram group, add the bot, and add the group's chat id to `chatIds`. Every listed chat then gets *all* bot messages, including the tablet-charge alerts.
  To send calendar messages to the group only, the rule would need `sendTelegram(chatId, text)`; that is a small change.

## Next (step 3, not built yet)

Add, edit and delete from the dashboard through a small bridge service with a JSON API over CalDAV PUT/DELETE, using the UID.
After each write it sends a command to `HomeCal_Refresh`.
