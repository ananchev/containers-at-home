// Home calendar reader: pulls the shared "Home" calendar (Nextcloud CalDAV, user `home`) and
// publishes the upcoming events as JSON in HomeCal_Events for the tablet dashboard.
//
// Why not the iCalendar binding: it only exposes title/begin/end per event, no CATEGORIES,
// no all-day flag and no UID (needed later for editing from the dashboard). Nextcloud
// expands recurring events server side (CalDAV <expand>), so no RRULE handling is needed here.
//
// Credentials: conf/services/homecal.secret.json  {"url": ".../calendars/home/Home/", "user", "password"}
// (Nextcloud app password, NOT in git). Public holidays are written INTO Home by the holiday sync at the end
// (category "Holiday" + country codes) and come back here as o.h = "NL, BG".
// Docs: notes/openhab/home-calendar/README.md
const { rules, triggers, items, log, time, actions, cache } = require('openhab');
const logger = log('homeCalendar');

const SECRET = '/openhab/conf/services/homecal.secret.json';
const DAYS_AHEAD = 60;
const MAX_EVENTS = 150;

const Files = Java.type('java.nio.file.Files');
const Paths = Java.type('java.nio.file.Paths');
const HttpClient = Java.type('java.net.http.HttpClient');
const HttpRequest = Java.type('java.net.http.HttpRequest');
const BodyPublishers = Java.type('java.net.http.HttpRequest.BodyPublishers');
const BodyHandlers = Java.type('java.net.http.HttpResponse.BodyHandlers');
const Duration = Java.type('java.time.Duration');
const Base64 = Java.type('java.util.Base64');
const JString = Java.type('java.lang.String');

const pad = (n) => (n < 10 ? '0' : '') + n;
const utcStamp = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
  pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';

function xmlUnescape(s) {
  return s.replace(/&#13;/g, '').replace(/&#10;/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
}
function textUnescape(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}
// CATEGORIES:School,Birthday  (may repeat; commas can be escaped)
function splitList(s) {
  return s.split(/(?<!\\),/).map((x) => textUnescape(x).trim()).filter((x) => x);
}

// "20261120" -> all-day date string; "20261120T100000Z" -> epoch ms; TZID / floating -> via java.time
function parseDt(value, params) {
  if (/^\d{8}$/.test(value)) return { allDay: true, date: value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8) };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  if (m[7]) return { allDay: false, ms: Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
  const tz = /TZID=([^;:]+)/.exec(params || '');
  const zone = Java.type('java.time.ZoneId');
  const ldt = Java.type('java.time.LocalDateTime').of(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  let z;
  try { z = tz ? zone.of(tz[1].replace(/"/g, '')) : zone.systemDefault(); } catch (e) { z = zone.systemDefault(); }
  return { allDay: false, ms: ldt.atZone(z).toInstant().toEpochMilli() };
}

function addDays(dateStr, n) {
  return Java.type('java.time.LocalDate').parse(dateStr).plusDays(n).toString();
}

// "PT1H30M", "P1D" -> ms
function durationMs(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s || '');
  if (!m) return 0;
  return ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
}

function parseEvents(ics) {
  const lines = ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let ev = null, depth = 0, alarm = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { cats: [], alarms: [] }; depth = 0; continue; }
    if (!ev) continue;
    if (line === 'BEGIN:VALARM' && depth === 0) { alarm = {}; depth++; continue; }
    if (line === 'END:VALARM' && alarm) { if (alarm.trigger) ev.alarms.push(alarm); alarm = null; depth--; continue; }
    if (line.indexOf('BEGIN:') === 0) { depth++; continue; }   // other nested components
    if (line.indexOf('END:') === 0 && depth > 0) { depth--; continue; }
    if (line === 'END:VEVENT') { out.push(ev); ev = null; continue; }
    const c = line.indexOf(':');
    if (c < 0) continue;
    const head = line.slice(0, c), value = line.slice(c + 1);
    const semi = head.indexOf(';');
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? '' : head.slice(semi + 1);
    if (alarm && depth === 1) {
      if (name === 'TRIGGER') alarm.trigger = { value: value, params: params };
      continue;
    }
    if (depth > 0) continue;
    switch (name) {
      case 'UID': ev.uid = value; break;
      case 'RECURRENCE-ID': ev.rid = value; break;
      case 'SUMMARY': ev.title = textUnescape(value); break;
      case 'LOCATION': ev.loc = textUnescape(value); break;
      case 'CATEGORIES': ev.cats = ev.cats.concat(splitList(value)); break;
      case 'STATUS': ev.status = value; break;
      case 'DTSTART': ev.start = parseDt(value, params); break;
      case 'DTEND': ev.end = parseDt(value, params); break;
      case 'DURATION': ev.dur = value; break;
    }
  }
  return out;
}

// "-PT1H" -> -3600000 (signed, unlike durationMs)
function signedMs(s) { return (/^-/.test(s) ? -1 : 1) * durationMs(s); }

// VALARM TRIGGER -> epoch ms: relative to start (default) or end (RELATED=END), or absolute (VALUE=DATE-TIME)
function alarmTimes(ev, startMs, endMs) {
  const out = [];
  ev.alarms.forEach((a) => {
    const t = a.trigger;
    if (/VALUE=DATE-TIME/i.test(t.params)) { const d = parseDt(t.value, ''); if (d && !d.allDay) out.push(d.ms); return; }
    out.push((/RELATED=END/i.test(t.params) ? endMs : startMs) + signedMs(t.value));
  });
  return out.filter((x, i) => out.indexOf(x) === i).sort((a, b) => a - b);
}
function dayStartMs(dateStr) {
  return Java.type('java.time.LocalDate').parse(dateStr).atStartOfDay(Java.type('java.time.ZoneId').systemDefault()).toInstant().toEpochMilli();
}

// compact shape for the dashboard: s/e are 'YYYY-MM-DD' (all-day, e exclusive) or epoch ms
function toItem(ev) {
  if (!ev.start || ev.status === 'CANCELLED') return null;
  const o = { uid: ev.uid || '', t: ev.title || '(no title)' };
  if (ev.rid) o.rid = ev.rid;
  if (ev.start.allDay) {
    o.ad = true;
    o.s = ev.start.date;
    o.e = ev.end && ev.end.allDay ? ev.end.date : addDays(ev.start.date, Math.max(1, Math.round(durationMs(ev.dur) / 86400000)));
  } else {
    o.s = ev.start.ms;
    o.e = ev.end && !ev.end.allDay ? ev.end.ms : ev.start.ms + durationMs(ev.dur);
  }
  if (ev.cats.length) o.c = ev.cats;
  if (ev.loc) o.loc = ev.loc;
  // public holidays (written by the holiday sync below): category "Holiday" + country codes -> o.h = "NL, BG"
  if (ev.cats.some((c) => /^holidays?$/i.test(c))) o.h = ev.cats.filter((c) => !/^holidays?$/i.test(c)).join(', ') || 'Holiday';
  // alarm times (epoch ms) for the Telegram reminder rule below
  const a = alarmTimes(ev, o.ad ? dayStartMs(o.s) : o.s, o.ad ? dayStartMs(o.e) : o.e);
  if (a.length) o.a = a;
  return o;
}

function sortKey(o) {
  return o.ad ? dayStartMs(o.s) : o.s;
}

function dav(cfg, method, url, depth, body, extraHeaders, okCodes) {
  const auth = Base64.getEncoder().encodeToString(new JString(cfg.user + ':' + cfg.password).getBytes('UTF-8'));
  const req = HttpRequest.newBuilder(Java.type('java.net.URI').create(url))
    .timeout(Duration.ofSeconds(20))
    .header('Authorization', 'Basic ' + auth)
    .header('Content-Type', method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8');
  if (depth !== null) req.header('Depth', String(depth));
  Object.keys(extraHeaders || {}).forEach((k) => req.header(k, extraHeaders[k]));
  req.method(method, body === null ? BodyPublishers.noBody() : BodyPublishers.ofString(body));
  const res = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build().send(req.build(), BodyHandlers.ofString());
  if ((okCodes || [207]).indexOf(res.statusCode()) < 0) throw new Error(`CalDAV ${method} ${url.replace(/^.*\/calendars\//, '')} HTTP ${res.statusCode()}`);
  return String(res.body());
}

function readCalendar(cfg, url, from, to) {
  const range = `start="${utcStamp(from)}" end="${utcStamp(to)}"`;
  const xml = dav(cfg, 'REPORT', url, 1, '<?xml version="1.0" encoding="utf-8"?>' +
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data>' +
    `<c:expand ${range}/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR">` +
    `<c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`);
  const re = /<([a-z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/([a-z0-9]+:)?calendar-data>/gi;
  let m, events = [];
  while ((m = re.exec(xml)) !== null) events = events.concat(parseEvents(xmlUnescape(m[2])));
  return events.map(toItem).filter((o) => o);
}

function fetchCalendar() {
  const cfg = JSON.parse(String(new JString(Files.readAllBytes(Paths.get(SECRET)), 'UTF-8')));
  const now = new Date();
  const from = new Date(now.getTime() - 86400000), to = new Date(now.getTime() + DAYS_AHEAD * 86400000);
  let list = readCalendar(cfg, cfg.url, from, to);
  const nowMs = now.getTime(), today = Java.type('java.time.LocalDate').now().toString();
  list = list.filter((o) => (o.ad ? o.e > today : o.e > nowMs))
    .sort((a, b) => sortKey(a) - sortKey(b)).slice(0, MAX_EVENTS);
  return list;
}

function refresh(why) {
  try {
    const list = fetchCalendar();
    const json = JSON.stringify(list);
    if (items.getItem('HomeCal_Events').state !== json) items.getItem('HomeCal_Events').postUpdate(json);
    items.getItem('HomeCal_Status').postUpdate('OK · ' + list.filter((o) => !o.h).length + ' events, ' + list.filter((o) => o.h).length + ' holidays');
    items.getItem('HomeCal_Updated').postUpdate(time.ZonedDateTime.now());
    logger.debug(`refreshed (${why}): ${list.length} events`);
  } catch (e) {
    // keep the last good HomeCal_Events, so a Nextcloud restart does not blank the dashboard
    items.getItem('HomeCal_Status').postUpdate('Error: ' + e.message);
    logger.warn(`refresh (${why}) failed: ${e.message}`);
  }
}

// cheap change check every minute: the calendar's ctag changes on every add / edit / delete
let lastCtag = null;
rules.JSRule({
  name: 'Home calendar: change check',
  description: 'Re-read the Home calendar within a minute of any change (CalDAV getctag)',
  triggers: [triggers.GenericCronTrigger('40 * * * * ?')],
  execute: () => {
    try {
      const cfg = JSON.parse(String(new JString(Files.readAllBytes(Paths.get(SECRET)), 'UTF-8')));
      const xml = dav(cfg, 'PROPFIND', cfg.url, 0,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>');
      const m = /getctag>([^<]+)</.exec(xml);
      const ctag = m ? m[1] : null;
      if (ctag && lastCtag !== null && ctag !== lastCtag) refresh('changed');
      lastCtag = ctag;
    } catch (e) {
      logger.debug('ctag check failed: ' + e.message);   // the 10-min refresh reports errors
    }
  },
  id: 'home-calendar-ctag',
});

rules.JSRule({
  name: 'Home calendar: refresh',
  description: 'Read the Nextcloud Home calendar into HomeCal_Events (every 10 min, at startup, on HomeCal_Refresh)',
  triggers: [
    triggers.GenericCronTrigger('0 3/10 * * * ?'),
    triggers.SystemStartlevelTrigger(100),
    triggers.ItemCommandTrigger('HomeCal_Refresh'),
  ],
  execute: (event) => refresh(event.eventType || 'cron'),
  id: 'home-calendar-refresh',
});

// ------------------------------------------------------------------ Telegram reminders
// 1. Per event: the event's own Alert(s) (VALARM, "1 hour before" etc. in any calendar app) are sent to
//    Telegram when due. Checked every minute against HomeCal_Events, so an alert set less than ~10 min
//    ahead can arrive up to 10 min late (next calendar read). Alerts more than LATE_MS overdue are dropped.
// 2. Evening digest at DIGEST_CRON: tomorrow's events + holidays, only when there is something.
const BOT = 'telegram:telegramBot:home';
const LATE_MS = 15 * 60 * 1000;
const DIGEST_CRON = '0 0 19 * * ?';   // set DIGEST_ENABLED = false to switch the digest off
const DIGEST_ENABLED = true;
const sent = cache.private;          // alert keys already sent (lost on restart: at most one repeat)

function telegram(text) {
  const bot = actions.thingActions('telegram', BOT);
  if (!bot) { logger.warn('Telegram Thing ' + BOT + ' missing; message was: ' + text); return; }
  // sendTelegram treats its text as a format string: escape %
  if (bot.sendTelegram(text.replace(/%/g, '%%')) !== true) logger.warn('Telegram send failed: ' + text);
  else logger.info('Telegram: ' + text);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function localParts(ms) {
  const z = Java.type('java.time.Instant').ofEpochMilli(ms).atZone(Java.type('java.time.ZoneId').systemDefault());
  return { y: z.getYear(), mo: z.getMonthValue(), d: z.getDayOfMonth(), dow: z.getDayOfWeek().getValue() % 7,
    hm: pad(z.getHour()) + ':' + pad(z.getMinute()), date: z.toLocalDate().toString() };
}
function dayWord(dateStr) {
  const LD = Java.type('java.time.LocalDate'), d = LD.parse(dateStr), today = LD.now();
  if (d.equals(today)) return 'today';
  if (d.equals(today.plusDays(1))) return 'tomorrow';
  return DOW[d.getDayOfWeek().getValue() % 7] + ' ' + d.getDayOfMonth() + ' ' + MON[d.getMonthValue() - 1];
}
function whenText(o) {
  if (o.ad) return dayWord(o.s) + (o.e > addDays(o.s, 1) ? ' until ' + dayWord(addDays(o.e, -1)) : ' (all day)');
  const s = localParts(o.s);
  return dayWord(s.date) + ' ' + s.hm;
}
function currentEvents() {
  try { return JSON.parse(items.getItem('HomeCal_Events').state || '[]'); } catch (e) { return []; }
}

rules.JSRule({
  name: 'Home calendar: Telegram alerts',
  description: 'Send the calendar events\' own alerts (VALARM) to Telegram when they are due',
  triggers: [triggers.GenericCronTrigger('15 * * * * ?')],
  execute: () => {
    const now = Date.now();
    currentEvents().forEach((o) => {
      if (o.h || !o.a) return;
      o.a.forEach((at) => {
        if (at > now || at < now - LATE_MS) return;
        const key = o.uid + '|' + (o.rid || '') + '|' + at;
        if (sent.get(key)) return;
        sent.put(key, now);
        telegram('⏰ ' + o.t + ' · ' + whenText(o) + (o.loc ? ' · ' + o.loc : ''));
      });
    });
  },
  id: 'home-calendar-alerts',
});

rules.JSRule({
  name: 'Home calendar: evening digest',
  description: 'Telegram summary of tomorrow\'s Home calendar events and holidays',
  triggers: [triggers.GenericCronTrigger(DIGEST_CRON)],
  execute: () => {
    if (!DIGEST_ENABLED) return;
    const tomorrow = Java.type('java.time.LocalDate').now().plusDays(1).toString();
    const onDay = (o) => (o.ad ? o.s <= tomorrow && o.e > tomorrow : localParts(o.s).date === tomorrow);
    const evs = currentEvents().filter(onDay);
    const hol = {};
    evs.filter((o) => o.h).forEach((o) => { (hol[o.t] = hol[o.t] || []).push(o.h); });
    const lines = evs.filter((o) => !o.h).map((o) => '• ' + o.t + ' · ' +
      (o.ad ? (o.s < tomorrow ? 'continues' : 'all day') : localParts(o.s).hm) + (o.loc ? ' · ' + o.loc : ''));
    Object.keys(hol).forEach((t) => lines.push('★ ' + t + ' (' + hol[t].join(', ') + ')'));
    const td = Java.type('java.time.LocalDate').parse(tomorrow);
    const head = '📅 Tomorrow, ' + DOW[td.getDayOfWeek().getValue() % 7] + ' ' + td.getDayOfMonth() + ' ' + MON[td.getMonthValue() - 1] + ':';
    if (lines.length) telegram(head + '\n' + lines.join('\n'));
  },
  id: 'home-calendar-digest',
});

// ------------------------------------------------------------------ public holidays -> Home calendar
// Weekly: this year's and next year's public holidays of HOLIDAY_COUNTRIES from Nager.Date (free, no key;
// only country code + year are sent) are written INTO the Home calendar, so every device that has Home
// sees them (a Nextcloud holiday subscription is per user and a separate calendar). One all-day event per
// day + English name, countries merged: "Christmas Day", CATEGORIES:Holiday,NL,BG, local names in the
// description. Objects are named holiday-<date>-<slug>.ics; only those are ever created or deleted.
// Holidays that vanish from the source are deleted from today on; past ones are left alone.
const HOLIDAY_COUNTRIES = ['NL', 'BG'];
// same day, different English names per country -> one name, so the entries merge
const HOLIDAY_ALIAS = { "St. Stephen's Day": 'Second day of Christmas' };

function httpGetJson(url) {
  const req = HttpRequest.newBuilder(Java.type('java.net.URI').create(url)).timeout(Duration.ofSeconds(20))
    .header('Accept', 'application/json').GET().build();
  const res = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(Java.type('java.net.http.HttpClient.Redirect').NORMAL)
    .build().send(req, BodyHandlers.ofString());
  if (res.statusCode() !== 200) throw new Error('GET ' + url + ' HTTP ' + res.statusCode());
  return JSON.parse(String(res.body()));
}
const icsText = (t) => t.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
// fold lines at 73 octets-ish (characters; good enough for Nextcloud, which re-serialises anyway)
const fold = (line) => line.length <= 73 ? line : line.match(/.{1,73}/g).join('\r\n ');

function holidaySync() {
  const cfg = JSON.parse(String(new JString(Files.readAllBytes(Paths.get(SECRET)), 'UTF-8')));
  const LD = Java.type('java.time.LocalDate'), today = LD.now(), year = today.getYear();
  const want = {};   // file name -> {date, name, countries, local}
  [year, year + 1].forEach((y) => HOLIDAY_COUNTRIES.forEach((cc) => {
    httpGetJson(`https://date.nager.at/api/v3/PublicHolidays/${y}/${cc}`).forEach((h) => {
      if (h.global === false) return;   // regional only
      h.name = HOLIDAY_ALIAS[h.name] || h.name;
      const slug = h.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const file = `holiday-${h.date}-${slug}.ics`;
      const w = want[file] = want[file] || { date: h.date, name: h.name, countries: [], local: [] };
      if (w.countries.indexOf(cc) < 0) { w.countries.push(cc); w.local.push(cc + ': ' + h.localName); }
    });
  }));

  // what is there now (hrefs + etags of holiday-* objects)
  const xml = dav(cfg, 'PROPFIND', cfg.url, 1, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>');
  const have = {};
  const re = /<(?:[a-z0-9]+:)?href>[^<]*\/(holiday-[^<\/]+\.ics)<\/(?:[a-z0-9]+:)?href>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) have[m[1]] = true;

  const base = cfg.url.replace(/\/?$/, '/'), stamp = utcStamp(new Date());
  let added = 0, updated = 0, removed = 0;
  Object.keys(want).forEach((file) => {
    const w = want[file];
    const d = w.date.replace(/-/g, ''), d2 = addDays(w.date, 1).replace(/-/g, '');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//openHAB homeCalendar.js//holiday sync//EN', 'BEGIN:VEVENT',
      'UID:' + file.replace(/\.ics$/, '') + '@home', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + d2,
      'SUMMARY:' + icsText(w.name), 'CATEGORIES:Holiday,' + w.countries.join(','),
      'DESCRIPTION:' + icsText('Public holiday · ' + w.local.join(' · ')),
      'TRANSP:TRANSPARENT', 'CLASS:PUBLIC', 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
    if (!have[file]) {
      dav(cfg, 'PUT', base + file, null, body, { 'If-None-Match': '*' }, [201, 204]);
      added++;
    } else if (w.countries.length > 1) {
      // a holiday shared by several countries may have been written with fewer first: rewrite only when it differs
      const cur = dav(cfg, 'GET', base + file, null, null, {}, [200]);
      if (!/CATEGORIES:Holiday,/.test(cur) || cur.indexOf('CATEGORIES:Holiday,' + w.countries.join(',')) < 0) {
        dav(cfg, 'PUT', base + file, null, body, {}, [201, 204]);
        updated++;
      }
    }
  });
  Object.keys(have).forEach((file) => {
    const date = file.slice(8, 18);
    if (!want[file] && date >= today.toString() && date.slice(0, 4) <= String(year + 1)) {
      dav(cfg, 'DELETE', base + file, null, null, {}, [200, 204]);
      removed++;
    }
  });
  logger.info(`holiday sync: ${Object.keys(want).length} wanted, ${added} added, ${updated} updated, ${removed} removed`);
  if (added || updated || removed) refresh('holiday sync');
}

rules.JSRule({
  name: 'Home calendar: public holiday sync',
  description: 'Write NL + BG public holidays (Nager.Date) into the Home calendar, weekly and at startup',
  triggers: [triggers.GenericCronTrigger('0 30 4 ? * MON'), triggers.SystemStartlevelTrigger(100)],
  execute: () => {
    try { holidaySync(); } catch (e) { logger.warn('holiday sync failed: ' + e.message); }
  },
  id: 'home-calendar-holidays',
});
