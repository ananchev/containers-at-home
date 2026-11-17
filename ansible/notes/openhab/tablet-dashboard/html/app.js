/* Tablet dashboard for openHAB — iPad Air 1 / Safari 12.
   Plain ES2015 only (no optional chaining, no ??, no Object.fromEntries, no flex gap in CSS).
   Data: openHAB REST (anonymous read) + the SSE event stream; weather from Open-Meteo (browser fetch). */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config
  var CFG = {
    location: window.OH.LOCATION,                   // core.js
    weatherEveryMs: 30 * 60 * 1000,
    camEveryMs: 10 * 1000,
    sparkEveryMs: 10 * 60 * 1000,
    nightItem: 'Tablet_NightMode',
    outsideTemp: 'VerandaTemperatureHumidity_Temperature',
    outsideHum: 'VerandaTemperatureHumidity_Humidity',
    insideTemp: 'MetrifulSensor_Temperature',
    power: 'gEnergyPower',
    meters: [
      { item: 'EnergyMeter2_Power',  name: 'Living, kitchen, WC' },
      { item: 'EnergyMeter3_Power',  name: 'Oven + bedroom & bath' },
      { item: 'EnergyMeter4_Power',  name: 'Washer & dryer' },
      { item: 'EnergyMeter5_Power',  name: 'Lu\'s room + attic office' },
      { item: 'EnergyMeter10_Power', name: 'Hob right' },
      { item: 'EnergyMeter11_Power', name: 'Hob left' }
    ],
    // up to 3 are shown; a camera that sees a person gets double width
    cameras: window.OH.CAMERAS.slice(),             // defined in core.js
    // bottom row, left to right (Night is always pinned on the right).
    // Up to 8 share the width; more get compact, and past ~9 the row scrolls sideways.
    nav: [
      { name: 'Climate',    icon: 'i-thermo', href: 'page.html#climate' },
      { name: 'Lights',     icon: 'i-bulb',   href: 'page.html#lights' },
      { name: 'Energy',     icon: 'i-bolt',   href: 'page.html#energy' },
      { name: 'Appliances', icon: 'i-washer', href: 'page.html#appliances' },
      { name: 'Cameras',    icon: 'i-camera', href: 'page.html#cameras' },
      { name: 'Garden',     icon: 'i-sprout', href: 'page.html#garden' }
    ],
    // Now panel: up to 4 full chips; 5-6 compact; more -> 5 compact + "+N more" (opens the full list)
    nowFull: 4,
    nowCompact: 6,
    appliances: window.OH.APPLIANCES,               // defined in core.js
    // "finished" chips follow <App>_Unemptied (appliancesUnload.rules); after this long they turn orange
    unemptiedWarnMs: 60 * 60 * 1000,
    // bin chip in "Now": grey from this many days ahead, orange the day before and on the day
    binAheadDays: 3
  };

  // ------------------------------------------------------------------ preview switches (design only)
  // index.html?demo=7  -> 7 fake indicators;  ?cams=3 -> repeat the cameras;  ?nav=10 -> extra buttons
  var Q = window.OH.Q;   // ?cams= and ?appl= are applied in core.js
  if (Q.nav) { var nx = ['Security', 'Media', 'Scenes', 'Weather', 'Car', 'System']; for (var qn = 0; CFG.nav.length < Q.nav; qn++) CFG.nav.push({ name: nx[qn % nx.length], icon: 'i-home', href: 'page.html' }); }
  CFG.cameras = CFG.cameras.slice(0, 3);

  // ------------------------------------------------------------------ helpers (from core.js)
  var OH = window.OH, S = OH.S, $ = OH.$, pad = OH.pad, hm = OH.hm, st = OH.st, has = OH.has, num = OH.num, esc = OH.esc,
    icon = OH.icon, fmt = OH.fmt, ago = OH.ago, parseLocal = OH.parseLocal, getJSON = OH.getJSON, sendCommand = OH.command;
  var DAYS = OH.DAYS, DAYS_LONG = OH.DAYS_LONG, MONTHS = OH.MONTHS;

  // ------------------------------------------------------------------ clock
  function renderClock() {
    var d = new Date();
    $('clk-hm').textContent = hm(d);
    $('clk-date').textContent = DAYS_LONG[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
    $('n-hm').textContent = hm(d);
    $('n-date').textContent = $('clk-date').textContent;
  }

  function binText() {
    if (!has('Garbage_Next')) return null;
    var n = num('Garbage_NextInDays');
    var when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : (st('Garbage_NextDate') || '');
    return { text: st('Garbage_Next') + ' · ' + when, days: n };
  }

  function renderMeta() {
    var t = num(CFG.insideTemp);
    $('in-temp').textContent = isNaN(t) ? '--' : fmt(t, 1) + '° inside';
    var o = num(CFG.outsideTemp);
    $('out-meta').textContent = isNaN(o) ? '--' : fmt(o, 1) + '° outside';
  }

  // ------------------------------------------------------------------ weather (Open-Meteo)
  var WX = null;
  var WX_TEXT = OH.WX_TEXT, wxIcon = OH.wxIcon;

  function loadWeather() {
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + CFG.location.lat + '&longitude=' + CFG.location.lon +
      '&current=temperature_2m,weather_code,is_day,wind_speed_10m' +
      '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
      '&timezone=Europe%2FAmsterdam&forecast_days=4';
    return getJSON(u).then(function (j) { WX = j; renderWeather(); }).catch(function () {});
  }

  function renderWeather() {
    var t = num(CFG.outsideTemp);
    var hum = num(CFG.outsideHum);
    if (isNaN(t) && WX && WX.current) t = WX.current.temperature_2m;
    $('out-temp').textContent = fmt(t, 1);
    if (!WX) { $('w-cond').textContent = 'Veranda'; $('w-sub').textContent = isNaN(hum) ? '' : 'Humidity ' + Math.round(hum) + '%'; return; }

    var c = WX.current || {};
    $('w-now-icon').innerHTML = wxIcon(c.weather_code, c.is_day === 1);
    $('w-cond').textContent = WX_TEXT[c.weather_code] || '';
    var sub = [];
    if (!isNaN(hum)) sub.push('Humidity ' + Math.round(hum) + '%');
    if (c.wind_speed_10m !== undefined) sub.push('Wind ' + Math.round(c.wind_speed_10m) + ' km/h');
    $('w-sub').innerHTML = sub.map(esc).join('<br>');

    // next 12 h in 2 h steps
    var h = WX.hourly, now = Date.now(), i0 = 0;
    for (var i = 0; i < h.time.length; i++) { if (parseLocal(h.time[i]).getTime() > now) { i0 = i; break; } }
    var html = '';
    for (var k = 0; k < 6; k++) {
      var j = i0 + k * 2;
      if (j >= h.time.length) break;
      var p = h.precipitation_probability[j];
      html += '<div class="w-hour"><div class="t">' + pad(parseLocal(h.time[j]).getHours()) + ':00</div>' +
        '<div class="wi">' + wxIcon(h.weather_code[j], h.is_day[j] === 1) + '</div>' +
        '<div>' + Math.round(h.temperature_2m[j]) + '°</div>' +
        '<div class="rain">' + (p >= 20 ? p + '%' : '') + '</div></div>';
    }
    $('w-hours').innerHTML = html;

    // next three days
    var d = WX.daily, dh = '';
    for (var n = 1; n <= 3 && n < d.time.length; n++) {
      dh += '<div class="w-day"><span class="d">' + DAYS[parseLocal(d.time[n]).getDay()] + '</span>' +
        '<span class="wi">' + wxIcon(d.weather_code[n], true) + '</span>' +
        '<span class="hi">' + Math.round(d.temperature_2m_max[n]) + '°</span>' +
        '<span class="lo">' + Math.round(d.temperature_2m_min[n]) + '°</span></div>';
    }
    $('w-days').innerHTML = dh;

    if (d.sunrise && d.sunrise[0]) {
      $('sun-rise').textContent = hm(parseLocal(d.sunrise[0]));
      $('sun-set').textContent = hm(parseLocal(d.sunset[0]));
    }
  }

  // ------------------------------------------------------------------ power
  function renderPower() {
    var w = num(CFG.power);
    var el = $('pw-w');
    el.textContent = isNaN(w) ? '--' : Math.round(w);
    el.parentNode.className = 'pw-val' + (isNaN(w) ? '' : w < 500 ? ' lvl-ok' : w < 2000 ? ' lvl-warn' : ' lvl-bad');

    var top = null;
    CFG.meters.forEach(function (m) { var v = num(m.item); if (!isNaN(v) && (!top || v > top.v)) top = { v: v, name: m.name }; });
    $('pw-top').textContent = top && top.v > 0 ? 'Most: ' + top.name + ' ' + Math.round(top.v) + ' W' : ' ';

    $('pw-today').textContent = fmt(num('EnergyToday_kWh'), 1) + ' kWh';
    $('pw-today-c').textContent = has('EnergyToday_Cost') ? '€ ' + fmt(num('EnergyToday_Cost'), 2) : '';
    $('pw-month').textContent = fmt(num('EnergyMonth_kWh'), 0) + ' kWh';
    $('pw-month-c').textContent = has('EnergyMonth_Cost') ? '€ ' + fmt(num('EnergyMonth_Cost'), 2) : '';
  }

  // 24 h of house power: the meters are persisted (influxdb, 1-min), the SUM group is not
  function loadSpark() {
    var end = Date.now(), start = end - 24 * 3600 * 1000, N = 144, step = (end - start) / N;
    var since = new Date(start).toISOString();
    return Promise.all(CFG.meters.map(function (m) {
      return getJSON('/rest/persistence/items/' + m.item + '?serviceId=influxdb&starttime=' + encodeURIComponent(since))
        .then(function (j) { return j.data || []; }).catch(function () { return []; });
    })).then(function (series) {
      var total = [];
      for (var b = 0; b < N; b++) total.push(0);
      series.forEach(function (data) {
        var sum = [], cnt = [];
        for (var b = 0; b < N; b++) { sum.push(0); cnt.push(0); }
        data.forEach(function (p) {
          var b2 = Math.floor((p.time - start) / step);
          if (b2 >= 0 && b2 < N) { sum[b2] += parseFloat(p.state); cnt[b2]++; }
        });
        var last = 0;
        for (var b3 = 0; b3 < N; b3++) { if (cnt[b3]) last = sum[b3] / cnt[b3]; total[b3] += last; }
      });
      drawSpark(total);
    });
  }
  function drawSpark(v) {
    var max = Math.max.apply(null, v.concat([100])), W = 360, H = 64, n = v.length;
    var pts = v.map(function (y, i) { return (i * W / (n - 1)).toFixed(1) + ',' + (H - 2 - y / max * (H - 6)).toFixed(1); });
    $('pw-spark').innerHTML = '<path class="area" d="M0,' + H + ' L' + pts.join(' L') + ' L' + W + ',' + H + ' Z"/>' +
      '<polyline class="line" points="' + pts.join(' ') + '"/>';
    $('pw-peak').textContent = 'peak ' + (max >= 1000 ? (max / 1000).toFixed(1) + ' kW' : Math.round(max) + ' W');
  }

  // ------------------------------------------------------------------ cameras
  function buildCams() {
    var box = $('p-cams');
    if (!CFG.cameras.length) { box.innerHTML = '<div class="cams-empty">No cameras</div>'; return; }
    box.className = 'panel cams n' + CFG.cameras.length;
    box.innerHTML = CFG.cameras.map(function (c, i) {
      return '<div class="cam" id="cam-' + i + '" data-cam="' + i + '"><img alt=""><div class="cam-label"><span>' +
        esc(c.name) + '</span><span class="age"></span></div></div>';
    }).join('');
    CFG.cameras.forEach(function (c) { c.ok = 0; });
  }
  function refreshCams() {
    if (document.hidden || night.on) return;
    CFG.cameras.forEach(function (c, i) {
      var img = new Image();
      img.onload = function () {
        var el = $('cam-' + i);
        el.querySelector('img').src = img.src;
        c.ok = Date.now();
      };
      img.src = '/ipcamera/' + c.id + '/ipcamera.jpg?t=' + Date.now();
    });
    renderCamLabels();
  }
  function renderCamLabels() {
    CFG.cameras.forEach(function (c, i) {
      var el = $('cam-' + i);
      if (!el) return;
      var stale = !c.ok || Date.now() - c.ok > 60000;
      var persons = num(c.persons);
      el.className = 'cam' + (stale ? ' stale' : '') + (persons > 0 ? ' alert' : '');
      el.querySelector('.age').textContent = stale ? (c.ok ? 'no signal' : 'loading') : (persons > 0 ? persons + ' person' + (persons > 1 ? 's' : '') : 'live');
    });
  }
  function openCam(i) {
    var c = CFG.cameras[i];
    if (!c) return;
    if (openCam.stop) openCam.stop();
    openCam.stop = OH.camLoop($('cam-full-img'), c.id);
    $('cam-full-label').textContent = c.name;
    $('cam-full').hidden = false;
    clearTimeout(openCam.t);
    openCam.t = setTimeout(closeCam, 2 * 60 * 1000);
  }
  function closeCam() { $('cam-full').hidden = true; if (openCam.stop) { openCam.stop(); openCam.stop = null; } }

  // ------------------------------------------------------------------ dynamic indicators
  var RANK = { 'c-bad': 0, 'c-warn': 1, 'c-violet': 2, 'c-info': 3, 'c-ok': 4, 'c-mute': 5 };

  function collectChips() {
    var out = [];
    if (Q.demo) {
      var D = [['c-bad', 'i-alert', '2 system issues', 'Hue bridge, MQTT broker'], ['c-warn', 'i-bin', 'GFT bin goes out tonight', 'Then Paper Fri 20 Nov'],
        ['c-violet', 'i-flame', 'Heating: Away', 'Not following the schedule'], ['c-info', 'i-dryer', 'Dryer · Cotton', '39 min left · 72%'],
        ['c-info', 'i-fan', 'Hood on', 'Fan stage 2'], ['c-info', 'i-drop', 'Front garden drip', '25 min left'],
        ['c-ok', 'i-washer', 'Washer finished', 'Colour · 12 min ago'], ['c-ok', 'i-dish', 'Dishwasher finished', 'Eco50 · 1 h 05 ago']];
      for (var di = 0; di < Q.demo; di++) { var dd = D[di % D.length]; out.push({ cls: dd[0], icon: dd[1], t1: dd[2], t2: dd[3], bar: di === 3 ? 72 : 0 }); }
      out.sort(function (x, y) { return RANK[x.cls] - RANK[y.cls]; });
      return out;
    }
    var now = Date.now();

    CFG.appliances.forEach(function (a0) {
      var a = { key: a0.key, name: a0.short || a0.name, icon: a0.icon };
      var s = st(a.key + '_State'), prog = st(a.key + '_Program') || '';
      if (!s || s === 'NULL') return;
      var rem = num(a.key + '_Remaining'), pr = num(a.key + '_Progress');
      var left = !isNaN(rem) && rem > 0 ? Math.round(rem / 60) + ' min left' : '';
      if (s === 'Run') {
        out.push({ cls: 'c-info', icon: a.icon, t1: a.name + (prog ? ' · ' + prog : ''),
          t2: [left, pr > 0 ? Math.round(pr) + '%' : ''].filter(Boolean).join(' · ') || 'Running', bar: pr });
      } else if (s === 'Pause' || s === 'DelayedStart') {
        out.push({ cls: 'c-warn', icon: a.icon, t1: a.name + (s === 'Pause' ? ' paused' : ' waiting to start'), t2: prog + (left ? ' · ' + left : '') });
      } else if (s === 'ActionRequired' || s === 'Error') {
        out.push({ cls: 'c-bad', icon: a.icon, t1: a.name + (s === 'Error' ? ': error' : ' needs attention'), t2: prog });
      }
      // finished and not yet emptied: openHAB keeps <App>_Unemptied (ON at Finished, OFF when the door
      // opens, a programme starts, after 12 h, or when cleared here with two taps)
      var un = a.key + '_Unemptied';
      if (st(un) === 'ON' && s !== 'Run') {
        var lc = S[un].lc, late = lc && now - lc > CFG.unemptiedWarnMs;
        var confirm = pendingClear.item === un && now < pendingClear.until;
        out.push({ cls: late ? 'c-warn' : 'c-ok', icon: a.icon, clear: un,
          t1: a.name + (late ? ' still full' : ' finished'),
          t2: confirm ? 'Tap again to clear' : (prog ? prog + ' · ' : '') + (lc ? 'finished ' + ago(lc) : '') });
      }
    });

    if (st('Hood_Power') === 'ON') out.push({ cls: 'c-info', icon: 'i-fan', t1: 'Hood on', t2: has('Hood_FanLevel') ? 'Fan stage ' + st('Hood_FanLevel') : '' });

    // tomorrow / today: orange (as before); 2-3 days ahead: grey. A tap opens all pickups.
    var b = binText();
    if (b && b.days <= CFG.binAheadDays) {
      var soon = b.days <= 1;
      out.push({ cls: soon ? 'c-warn' : 'c-mute', icon: 'i-bin', bins: true,
        t1: st('Garbage_Next') + (b.days === 0 ? ' bin today' : b.days === 1 ? ' bin goes out tonight' : ' bin in ' + b.days + ' days'),
        t2: soon ? (has('Garbage_Following') && st('Garbage_Following') !== '-' ? 'Then ' + st('Garbage_Following') : '') : st('Garbage_NextDate') || '' });
    }

    var issues = num('System_Issues_Count');
    if (issues > 0) {
      var bad = Object.keys(S).filter(function (k) { return k.indexOf('System_') === 0 && k !== 'System_Issues_Count' && has(k) && st(k) !== 'OK'; })
        .map(function (k) { return S[k].label || k; });
      out.push({ cls: 'c-bad', icon: 'i-alert', t1: issues + ' system issue' + (issues > 1 ? 's' : ''), t2: bad.join(', ') });
    }

    CFG.cameras.forEach(function (c) {
      var p = num(c.persons);
      if (p > 0) out.push({ cls: 'c-bad', icon: 'i-person', t1: (p > 1 ? p + ' people' : 'Person') + ' on the ' + c.name.toLowerCase(), t2: 'Tap the camera for live view' });
    });

    var mode = st('Evohome_SystemMode');
    if (mode && mode !== 'Auto' && mode !== 'NULL') out.push({ cls: 'c-violet', icon: 'i-flame', t1: 'Heating: ' + mode.replace(/([a-z])([A-Z])/g, '$1 $2'), t2: 'Not following the schedule' });

    var drip = num('FrontDrip_Remaining');
    if (drip > 0) out.push({ cls: 'c-info', icon: 'i-drop', t1: 'Front garden drip', t2: Math.round(drip / 60) + ' min left' });   // seconds
    if (st('sprinkler') === 'ON' || st('dripIrrigation') === 'ON') {
      var wc = num('wateringCounter');
      out.push({ cls: 'c-info', icon: 'i-drop', t1: st('sprinkler') === 'ON' ? 'Sprinkler on' : 'Drip irrigation on', t2: wc > 0 ? wc + ' min' : '' });
    }

    out.sort(function (x, y) { return RANK[x.cls] - RANK[y.cls]; });
    return out;
  }

  // two taps clear a "finished" chip: the first arms it for 4 s
  var pendingClear = { item: null, until: 0 };
  function chipTap(e) {
    var el = e.target.closest('[data-clear]');
    if (!el) return false;
    var item = el.getAttribute('data-clear');
    if (pendingClear.item === item && Date.now() < pendingClear.until) {
      pendingClear = { item: null, until: 0 };
      sendCommand(item, 'OFF').catch(function () {});
    } else {
      pendingClear = { item: item, until: Date.now() + 4000 };
      setTimeout(OH.rerender, 4100);
    }
    renderAll();
    return true;
  }
  function chipHtml(c) {
    return '<div class="chip ' + c.cls + (c.clear ? ' clearable' : '') + '"' + (c.clear ? ' data-clear="' + c.clear + '"' : '') + (c.bins ? ' data-bins="1"' : '') + '><div class="ci">' + icon(c.icon) + '</div><div class="ct"><div class="t1">' + esc(c.t1) +
      '</div>' + (c.t2 ? '<div class="t2">' + esc(c.t2) + '</div>' : '') + '</div>' +
      (c.bar > 0 ? '<div class="bar" style="width:' + Math.min(100, c.bar) + '%"></div>' : '') + '</div>';
  }
  // chips arrive sorted by importance, so whatever is cut off is the least urgent
  var lastChips = [];
  function renderNow(chips) {
    lastChips = chips;
    var n = chips.length, list = $('now-list'), shown, more = 0;
    if (n <= CFG.nowFull) { shown = chips; list.className = ''; }
    else if (n <= CFG.nowCompact) { shown = chips; list.className = 'compact'; }
    else { shown = chips.slice(0, CFG.nowCompact - 1); more = n - shown.length; list.className = 'compact'; }
    list.innerHTML = shown.map(chipHtml).join('') +
      (more ? '<div class="chip-more" id="now-more">+ ' + more + ' more</div>' : '');
    $('now-empty').hidden = n > 0;
    if (!$('sheet').hidden) {
      if (sheetMode === 'bins') $('sheet-list').innerHTML = binsHtml();
      else if (n <= CFG.nowCompact) closeSheet(); else $('sheet-list').innerHTML = chips.map(chipHtml).join('');
    }
  }
  var sheetMode = null;   // 'now' | 'bins'
  function openSheet(mode) {
    sheetMode = mode || 'now';
    $('sheet-title').textContent = sheetMode === 'bins' ? 'Bin pickups' : 'Now';
    $('sheet-list').innerHTML = sheetMode === 'bins' ? binsHtml() : lastChips.map(chipHtml).join('');
    $('sheet').hidden = false;
    clearTimeout(openSheet.t);
    openSheet.t = setTimeout(closeSheet, 60000);
  }
  function closeSheet() { $('sheet').hidden = true; sheetMode = null; }

  // all bins with their next pickup (tap the date under the clock, or a bin chip)
  function binsHtml() {
    var list = OH.bins();
    if (!list.length) return '<div class="now-empty">No bin dates from afvalwijzer</div>';
    return list.map(function (b) {
      var cls = isNaN(b.days) ? 'c-mute' : b.days <= 1 ? 'c-warn' : b.days <= CFG.binAheadDays ? 'c-mute' : 'c-plain';
      var when = isNaN(b.days) ? 'no date' : DAYS[b.date.getDay()] + ' ' + b.date.getDate() + ' ' + MONTHS[b.date.getMonth()].slice(0, 3);
      var rel = isNaN(b.days) ? '' : b.days === 0 ? 'today' : b.days === 1 ? 'tomorrow (out tonight)' : 'in ' + b.days + ' days';
      return '<div class="chip ' + cls + '"><div class="ci">' + icon('i-bin') + '</div><div class="ct"><div class="t1">' + esc(b.name) +
        ' · ' + esc(when) + '</div>' + (rel ? '<div class="t2">' + esc(rel) + '</div>' : '') + '</div></div>';
    }).join('');
  }

  // ------------------------------------------------------------------ nav
  function buildNav() {
    var box = $('nav-links');
    box.innerHTML = CFG.nav.map(function (b) {
      return '<a class="btn" href="' + esc(OH.link(b.href)) + '">' + icon(b.icon) + '<span>' + esc(b.name) + '</span></a>';
    }).join('');
    box.className = 'nav-links' + (CFG.nav.length > 8 ? ' dense' : '');
    var wrap = box.parentNode;
    var upd = function () { wrap.className = 'nav-wrap' + (box.scrollWidth - box.scrollLeft - box.clientWidth > 4 ? ' scroll' : ''); };
    box.addEventListener('scroll', upd);
    setTimeout(upd, 0);
  }

  // ------------------------------------------------------------------ night mode
  // openHAB owns the schedule (Tablet_NightMode, tablet.rules); a tap sends a command to the item.
  // If the command fails the page still switches locally until the item next changes.
  var night = { on: false, item: undefined, local: null };
  function renderNight(chips) {
    var it = st(CFG.nightItem);
    if (it !== night.item) { night.item = it; night.local = null; }
    var on = night.local !== null ? night.local : it === 'ON';
    if (on !== night.on) {
      night.on = on;
      $('day').hidden = on; $('night').hidden = !on;
      document.body.className = on ? 'night' : '';
      if (!on) refreshCams();
    }
    if (!on) return;
    var line = [];
    var t = num(CFG.outsideTemp);
    if (!isNaN(t)) line.push(fmt(t, 1) + '° outside');
    var b = binText();
    if (b) line.push('Next bin: ' + b.text);
    $('n-line').textContent = line.join('   ·   ');
    $('n-alerts').innerHTML = chips.filter(function (c) { return c.cls === 'c-bad' || c.cls === 'c-warn' || c.cls === 'c-info'; })
      .slice(0, 4).map(function (c) { return '<span class="n-alert ' + c.cls + '">' + icon(c.icon) + esc(c.t1) + '</span>'; }).join('');
  }
  function setNight(on) {
    night.local = on;
    renderAll();
    sendCommand(CFG.nightItem, on ? 'ON' : 'OFF').catch(function () {});
  }

  // ------------------------------------------------------------------ render + timers
  function renderAll() {
    renderClock(); renderMeta(); renderWeather(); renderPower(); renderCamLabels();
    var chips = collectChips();
    renderNow(chips);
    renderNight(chips);
  }

  function wire() {
    $('btn-night').addEventListener('click', function () { setNight(true); });
    $('night').addEventListener('click', function () { setNight(false); });
    $('p-cams').addEventListener('click', function (e) {
      var el = e.target.closest('.cam');
      if (el) openCam(el.getAttribute('data-cam'));
    });
    $('cam-full').addEventListener('click', closeCam);
    $('p-now').addEventListener('click', function (e) {
      if (chipTap(e)) return;
      if (e.target.closest('[data-bins]')) openSheet('bins'); else if (e.target.closest('#now-more')) openSheet();
    });
    $('clk-date').addEventListener('click', function () { openSheet('bins'); });
    $('sheet').addEventListener('click', function (e) {
      if (chipTap(e)) return;
      if (e.target.closest('[data-bins]')) { openSheet('bins'); return; }
      if (!e.target.closest('.sheet-list') || e.target.closest('.sheet-close')) closeSheet();
    });
    $('p-power').addEventListener('click', function () { location.href = OH.link(this.getAttribute('data-href')); });
    $('p-weather').addEventListener('click', function () { location.href = OH.link(this.getAttribute('data-href')); });
  }

  function start() {
    OH.start(renderAll, { onVisible: refreshCams });
    buildCams();
    buildNav();
    wire();
    renderClock();
    loadWeather();
    loadSpark().catch(function () {});
    refreshCams();

    // clock: tick on the minute boundary
    (function tick() { renderClock(); setTimeout(tick, 60000 - Date.now() % 60000 + 50); })();
    setInterval(refreshCams, CFG.camEveryMs);
    setInterval(loadWeather, CFG.weatherEveryMs);
    setInterval(function () { loadSpark().catch(function () {}); }, CFG.sparkEveryMs);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
