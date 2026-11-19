// Dashboard iPad (wall tablet, iPad Air 1, jailbroken iOS 12.5.8) battery control: keeps the battery
// between TabletBattery_Low and _High by switching the zigbee plug TabletPlug_State.
//
// The battery % is READ from the iPad, not estimated: openHAB ssh's in as root and runs ioreg.
// Key + ssh config live in userdata/ssh/ (deployed by applications/openhab.yml from the vault vars
// dashboard_ipad.ip / dashboard_ipad.ssh_private_key); the container gets openssh-client from
// cont-init.d. Docs: notes/openhab/tablet-battery/README.md
//
// Failsafe: the plug goes ON whenever the reading cannot be trusted (a full iPad is harmless, a flat
// one needs a re-jailbreak from a computer):
//   - the first failed / unparsable read -> plug ON at once
//   - FAIL_ALERT failed reads in a row     -> TabletBattery_Reachable OFF + alert (iPad rebooted?)
//   - level stuck below 95 % for STALE_MIN -> reading not trusted, plug ON + alert
//   - every day at 09:00 while unreadable  -> reminder; a "readable again" message when it returns
// The jailbreak (and with it sshd) is gone after every iPad reboot; everything installed stays on disk,
// so re-running checkra1n brings it all back.
//
// Alerts: TabletBattery_Alert holds the active alert keys ("unreadable,no_charger" or "-"). A key that
// appears sends its message once, a key that goes away sends its "resolved" message.
//
// Telegram (Thing telegram:telegramBot:home): /ipad = status card with buttons (Refresh, Enable/Disable
// control). The command is registered in the shared menu of telegramBot.js (/help).
const { rules, triggers, items, log, time, actions, cache } = require('openhab');
const logger = log('tabletBattery');

const NAME = 'Dashboard iPad';
const Duration = Java.type('java.time.Duration');
const SSH = ['ssh', '-F', '/openhab/userdata/ssh/config', 'dashboard-ipad'];
const REMOTE = 'ioreg -rn AppleARMPMUCharger | grep -E \'"(CurrentCapacity|IsCharging|ExternalConnected|FullyCharged)" =\'';
const BOT = 'telegram:telegramBot:home';
const MQTT_BROKER = 'mqtt:broker:c60e6d09';

const FAIL_ALERT = 3;        // failed reads (= minutes) before the "unreadable" alert
const STALE_MIN = 120;       // level unchanged this long below 95 % = reading not trusted
const NO_POWER_MIN = 5;      // plug ON but the iPad sees no charger for this long = alert
const MISMATCH_ALERT = 4;    // minutes the plug ignores our command before an alert

const CMD = '/ipad';
const REPLY_ID = 'ipad';     // sendTelegramQuery replyId for the status card buttons
const BTN_REFRESH = '🔄 Refresh';
const BTN_ENABLE = '▶️ Enable control';
const BTN_DISABLE = '⏸ Disable control';

const st = cache.private;    // counters; lost on restart, which only restarts the counting

// ------------------------------------------------------------------ helpers
function bot() {
  const b = actions.thingActions('telegram', BOT);
  if (!b) logger.warn('Telegram Thing ' + BOT + ' missing');
  return b;
}
// the single-String sendTelegram sends the text as is (no format string)
function telegram(text) {
  const b = bot();
  if (!b) { logger.warn('message was: ' + text); return; }
  if (b.sendTelegram(text) !== true) logger.warn('Telegram send failed: ' + text);
  else logger.info('Telegram: ' + text.replace(/\n/g, ' / '));
}

const state = (name) => String(items.getItem(name).state);
const num = (name, d) => { const n = parseFloat(state(name)); return isNaN(n) ? d : n; };
const pct = (name) => Math.round(num(name, 0)) + '%';
const valid = (s) => s !== 'NULL' && s !== 'UNDEF' && s !== '-' && s !== '';
function setIf(name, value) {
  const it = items.getItem(name);
  if (String(it.state) !== String(value)) it.postUpdate(value);
}
const two = (n) => (n < 10 ? '0' : '') + n;
const hhmm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const dayHhmm = (ms) => { const d = new Date(ms); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + hhmm(ms); };
function itemMs(name) {
  const s = state(name);
  if (!valid(s)) return 0;
  const t = Date.parse(s.replace(/\[.*\]$/, '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return isNaN(t) ? 0 : t;
}
function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

// ------------------------------------------------------------------ alert texts
// raise(ctx) / clear(ctx, sinceMs): ctx = { level, charging, plugW, want, mm }
const ALERTS = {
  unreadable: {
    raise: (c) => '⚠️ ' + NAME + ': battery unreadable\n' +
      'Since ' + hhmm(c.since) + ' openHAB cannot read the battery over SSH.\n' +
      'Failsafe: the charger plug is kept ON.\n' +
      'Likely the iPad rebooted and lost the jailbreak: re-run checkra1n (Mac → USB-A hub → DFU).',
    clear: (c, since) => '✅ ' + NAME + ': battery readable again\n' +
      'Battery ' + c.level + '%' + (c.charging ? ', charging' : '') + '.' +
      (since ? ' Unreadable for ' + duration(Date.now() - since) + ' (' + hhmm(since) + '–' + hhmm(Date.now()) + ').' : '') +
      ' Normal control resumed.',
  },
  stale: {
    raise: (c) => '⚠️ ' + NAME + ': battery reading stuck\n' +
      'The level has stayed at ' + c.level + '% for ' + STALE_MIN / 60 + ' h, which should not happen while it charges or drains.\n' +
      'Failsafe: the charger plug is kept ON until the reading moves again.',
    clear: (c) => '✅ ' + NAME + ': battery reading moving again (' + c.level + '%). Normal control resumed.',
  },
  no_charger: {
    raise: (c) => '⚠️ ' + NAME + ': not receiving power\n' +
      'The plug is ON (' + c.plugW + ') but the iPad sees no charger for ' + NO_POWER_MIN + ' min (battery ' + c.level + '%).\n' +
      'Check the cable at the iPad, the charger and the plug.',
    clear: (c) => '✅ ' + NAME + ': charger power is back (battery ' + c.level + '%' + (c.charging ? ', charging' : '') + ').',
  },
  plug_ignores: {
    raise: (c) => '⚠️ ' + NAME + ': charger plug does not respond\n' +
      'openHAB has wanted the plug ' + c.want + ' for ' + c.mm + ' min, but it does not switch.\n' +
      'Check the plug in zigbee2mqtt.',
    clear: () => '✅ ' + NAME + ': charger plug follows commands again.',
  },
  plug_offline: {
    raise: () => '⚠️ ' + NAME + ': charger plug offline in zigbee2mqtt\n' +
      'openHAB cannot switch it; the iPad keeps whatever state the plug is in.',
    clear: () => '✅ ' + NAME + ': charger plug back online.',
  },
};

function publishAlerts(active, ctx) {
  const prevS = state('TabletBattery_Alert');
  const prev = valid(prevS) ? prevS.split(',').filter((k) => ALERTS[k]) : [];
  const now = Object.keys(active);
  for (const k of now.filter((x) => !prev.includes(x))) {
    st.put('since.' + k, active[k].since || Date.now());
    telegram(ALERTS[k].raise(Object.assign({}, ctx, active[k])));
  }
  for (const k of prev.filter((x) => !now.includes(x))) {
    // after a restart the cache is empty: the unreadable start is also in an item
    const since = st.get('since.' + k) || (k === 'unreadable' ? itemMs('TabletBattery_UnreadableSince') : 0);
    telegram(ALERTS[k].clear(ctx, since));
    st.remove('since.' + k);
  }
  setIf('TabletBattery_Alert', now.length ? now.join(',') : '-');
}

// ------------------------------------------------------------------ battery reading
// one ssh round trip (~1 s); returns {level, charging, connected, full} or {error}
function readBattery() {
  let out;
  try {
    out = actions.Exec.executeCommandLine(Duration.ofSeconds(12), ...SSH, REMOTE);
  } catch (e) {
    return { error: 'exec: ' + e };
  }
  out = out === null || out === undefined ? '' : String(out);
  const v = {};
  out.replace(/"(\w+)" = (\S+)/g, (m, k, val) => { v[k] = val; return m; });
  const level = parseInt(v.CurrentCapacity, 10);
  if (isNaN(level) || level < 0 || level > 100) return { error: (out.trim() || 'no output (timeout?)').slice(0, 200) };
  return { level, charging: v.IsCharging === 'Yes', connected: v.ExternalConnected === 'Yes', full: v.FullyCharged === 'Yes' };
}

function tick() {
  const nowMs = Date.now();
  const enabled = state('TabletBattery_Enabled') === 'ON';
  const plug = state('TabletPlug_State');
  const active = {};
  let want, reason, failsafe = false;

  const r = readBattery();
  if (r.error) {
    // ---- failsafe: no reading -> plug ON
    const fails = (st.get('fails') || 0) + 1;
    st.put('fails', fails);
    if (fails === 1 || r.error !== st.get('lastError')) logger.warn('Battery read failed (' + fails + '): ' + r.error);
    st.put('lastError', r.error);
    want = true;
    failsafe = true;
    reason = 'failsafe: no battery reading';
    if (fails >= FAIL_ALERT) {
      const since = nowMs - (fails - 1) * 60000;
      if (state('TabletBattery_Reachable') !== 'OFF') {
        items.getItem('TabletBattery_Reachable').postUpdate('OFF');
        items.getItem('TabletBattery_UnreadableSince').postUpdate(time.ZonedDateTime.now().minusMinutes(fails - 1));
      }
      active.unreadable = { since: itemMs('TabletBattery_UnreadableSince') || since };
    } else if (valid(state('TabletBattery_Alert')) && state('TabletBattery_Alert').includes('unreadable')) {
      active.unreadable = {};   // keep an existing alert until a read succeeds
    }
  } else {
    if (st.get('fails')) logger.info('Battery readable again: ' + r.level + '%');
    st.put('fails', 0);
    st.remove('lastError');
    setIf('TabletBattery_Reachable', 'ON');
    setIf('TabletBattery_Level', r.level);
    setIf('TabletBattery_Charging', r.charging ? 'ON' : 'OFF');
    setIf('TabletBattery_Connected', r.connected ? 'ON' : 'OFF');
    items.getItem('TabletBattery_LastRead').postUpdate(time.ZonedDateTime.now());

    // ---- stale: a live reading should move while it charges or drains
    if (st.get('lastLevel') !== r.level) { st.put('lastLevel', r.level); st.put('levelSince', nowMs); }
    const stuckMin = Math.floor((nowMs - (st.get('levelSince') || nowMs)) / 60000);

    // ---- decide (hysteresis: between the marks keep what we had)
    const low = num('TabletBattery_Low', 40), high = num('TabletBattery_High', 70);
    if (r.level < 95 && stuckMin >= STALE_MIN) {
      want = true; failsafe = true; reason = 'failsafe: reading stuck';
      active.stale = {};
    } else if (r.level <= low) {
      want = true; reason = 'low mark ' + low + '%';
    } else if (r.level >= high) {
      want = false; reason = 'high mark ' + high + '%';
    } else {
      want = state('TabletBattery_Desired') !== 'OFF';
      reason = state('TabletBattery_Reason');
      // between the marks the last mark explains the direction; anything else is history
      if (!/^(low|high) mark/.test(reason)) reason = 'between the marks';
    }

    // ---- plug ON but no power at the iPad: cable, charger or plug fault
    if (plug === 'ON' && !r.connected) {
      if (!st.get('noPowerSince')) st.put('noPowerSince', nowMs);
      if (nowMs - st.get('noPowerSince') >= NO_POWER_MIN * 60000) active.no_charger = {};
    } else {
      st.remove('noPowerSince');
    }
  }

  // ---- reconcile the plug with the decision
  const wantCmd = want ? 'ON' : 'OFF';
  if (state('TabletBattery_Desired') !== wantCmd) {
    items.getItem('TabletBattery_Desired').postUpdate(wantCmd);
    // failsafe switches are covered by their alert; only normal control is announced
    if (enabled && !failsafe && state('TabletBattery_Notify') !== 'OFF') {
      telegram((want ? '🔌 ' : '🔋 ') + NAME + ': charging ' + wantCmd + ', battery ' + r.level + '% (' + reason + ').');
    }
  }
  setIf('TabletBattery_Reason', reason);
  let mm = 0;
  if (enabled) {
    if (plug !== wantCmd) {
      mm = (st.get('mismatch') || 0) + 1;
      st.put('mismatch', mm);
      if (mm >= MISMATCH_ALERT) active.plug_ignores = { want: wantCmd, mm };
      items.getItem('TabletPlug_State').sendCommand(wantCmd);
    } else {
      st.put('mismatch', 0);
    }
  }
  if (state('TabletPlug_Online') === 'offline') active.plug_offline = {};

  publishAlerts(active, {
    level: r.error ? Math.round(num('TabletBattery_Level', 0)) : r.level,
    charging: r.error ? false : r.charging,
    plugW: state('TabletPlug_Power'),
    want: wantCmd,
    mm,
  });
}

// ------------------------------------------------------------------ status card
function statusText() {
  const readable = state('TabletBattery_Reachable') === 'ON';
  const lastRead = itemMs('TabletBattery_LastRead');
  const alerts = state('TabletBattery_Alert');
  const lines = ['📱 ' + NAME];
  if (readable) {
    lines.push('Battery: ' + pct('TabletBattery_Level') +
      (state('TabletBattery_Charging') === 'ON' ? ' · charging' : ' · not charging') +
      (state('TabletBattery_Connected') === 'ON' ? ' · charger connected' : ' · no charger'));
  } else {
    const since = itemMs('TabletBattery_UnreadableSince');
    lines.push('Battery: UNREADABLE' + (since ? ' since ' + dayHhmm(since) : '') +
      ' (last ' + pct('TabletBattery_Level') + ')');
  }
  if (lastRead) lines.push('Last read: ' + dayHhmm(lastRead));
  lines.push('Plug: ' + state('TabletPlug_State') + ' (' + state('TabletPlug_Power') + ') · wanted ' +
    state('TabletBattery_Desired') + ': ' + state('TabletBattery_Reason'));
  lines.push('Control: ' + (state('TabletBattery_Enabled') === 'ON' ? 'enabled' : 'DISABLED (hands off)') +
    ' · ' + num('TabletBattery_Low', 40) + '–' + num('TabletBattery_High', 70) + '%');
  lines.push('Alerts: ' + (valid(alerts) ? alerts.split(',').join(', ') : 'none'));
  return lines.join('\n');
}

function sendCard() {
  const b = bot();
  if (!b) return;
  const toggle = state('TabletBattery_Enabled') === 'ON' ? BTN_DISABLE : BTN_ENABLE;
  if (b.sendTelegramQuery(statusText(), REPLY_ID, BTN_REFRESH, toggle) !== true) logger.warn('Telegram status card failed');
}

// ------------------------------------------------------------------ rules
// Fills NULL settings and asks the plug for its state (z2m attribute topics are not retained).
function applyDefaults() {
  const defaults = { TabletBattery_Enabled: 'ON', TabletBattery_Notify: 'ON', TabletBattery_Low: 40,
    TabletBattery_High: 70, TabletBattery_Alert: '-' };
  for (const [name, value] of Object.entries(defaults)) {
    const s = state(name);
    if (s === 'NULL' || s === 'UNDEF') items.getItem(name).postUpdate(value);
  }
  // pre-2026-11-20 alert texts are not keys: start clean
  const a = state('TabletBattery_Alert');
  if (valid(a) && !a.split(',').every((k) => ALERTS[k])) items.getItem('TabletBattery_Alert').postUpdate('-');
  const mqtt = actions.thingActions('mqtt', MQTT_BROKER);
  if (mqtt) mqtt.publishMQTT('zigbee2mqtt/smart_plug/set', '{"read":{"cluster":"genOnOff","attributes":["onOff"]}}');
}

// shared command menu for /help (telegramBot.js): cache.shared 'telegram.commands' = JSON {cmd: description}
function registerCommand() {
  let cmds = {};
  try { cmds = JSON.parse(cache.shared.get('telegram.commands') || '{}'); } catch (e) { cmds = {}; }
  cmds[CMD] = NAME + ': battery, charger plug, control';
  cache.shared.put('telegram.commands', JSON.stringify(cmds));
}

rules.JSRule({
  name: 'Dashboard iPad: defaults after startup',
  description: 'Fills NULL settings and asks the plug for its state',
  triggers: [triggers.SystemStartlevelTrigger(100)],
  execute: () => { applyDefaults(); registerCommand(); },
  id: 'tablet-battery-startup',
});

rules.JSRule({
  name: 'Dashboard iPad: battery tick',
  description: 'Every minute: read the iPad battery over ssh and switch the plug (failsafe ON)',
  triggers: [triggers.GenericCronTrigger('20 * * * * ?')],
  execute: () => {
    try { tick(); } catch (e) { logger.error('tick failed: ' + e); }
  },
  id: 'tablet-battery-tick',
});

rules.JSRule({
  name: 'Dashboard iPad: daily reminder while unreadable',
  description: 'At 09:00, if the battery has been unreadable (jailbreak lost), remind by Telegram',
  triggers: [triggers.GenericCronTrigger('0 0 9 * * ?')],
  execute: () => {
    if (state('TabletBattery_Reachable') !== 'OFF') return;
    const since = itemMs('TabletBattery_UnreadableSince');
    telegram('🔁 ' + NAME + ': battery still unreadable' + (since ? ' since ' + dayHhmm(since) : '') + '.\n' +
      'The charger plug stays ON meanwhile. Re-run checkra1n when you can (Mac → USB-A hub → DFU).');
  },
  id: 'tablet-battery-reminder',
});

rules.JSRule({
  name: 'Dashboard iPad: Telegram command',
  description: CMD + ' = status card with buttons',
  triggers: [triggers.ChannelEventTrigger(BOT + ':messageEvent')],
  execute: (event) => {
    let msg;
    try { msg = JSON.parse(String(event.receivedEvent)); } catch (e) { return; }
    const cmd = String(msg.text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    if (cmd === CMD) sendCard();
  },
  id: 'tablet-battery-telegram',
});

rules.JSRule({
  name: 'Dashboard iPad: Telegram buttons',
  description: 'Answers the status card buttons',
  triggers: [triggers.ChannelEventTrigger(BOT + ':callbackEvent')],
  execute: (event) => {
    let cb;
    try { cb = JSON.parse(String(event.receivedEvent)); } catch (e) { return; }
    if (cb.reply_id && cb.reply_id !== REPLY_ID) return;
    const b = bot();
    if (!b) return;
    const text = String(cb.text || '');
    if (text === BTN_ENABLE) {
      items.getItem('TabletBattery_Enabled').postUpdate('ON');
      b.sendTelegramAnswer(REPLY_ID, '▶️ ' + NAME + ': control enabled, openHAB switches the plug (' +
        num('TabletBattery_Low', 40) + '–' + num('TabletBattery_High', 70) + '%).');
    } else if (text === BTN_DISABLE) {
      items.getItem('TabletBattery_Enabled').postUpdate('OFF');
      b.sendTelegramAnswer(REPLY_ID, '⏸ ' + NAME + ': control disabled. The plug is left as it is; readings and alerts continue.');
    } else if (text === BTN_REFRESH) {
      b.sendTelegramAnswer(REPLY_ID, null);
      sendCard();
    } else {
      logger.info('unknown button: ' + JSON.stringify(cb));
      b.sendTelegramAnswer(REPLY_ID, null);
    }
  },
  id: 'tablet-battery-buttons',
});

// the start level trigger does not fire when the file is (re)loaded into a running openHAB
try { applyDefaults(); registerCommand(); } catch (e) { logger.warn('init on load: ' + e); }
