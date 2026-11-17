/* Subpages for the tablet (page.html#climate|lights|energy|appliances|cameras|garden).
   Content mirrors the Main UI pages of the same name. Plain ES2015 for Safari 12.
   Each page builds its DOM once; bound elements are then updated in place on every state change,
   so a slider being dragged is never re-rendered under the finger. */
(function () {
  'use strict';
  var OH = window.OH, st = OH.st, has = OH.has, num = OH.num, esc = OH.esc, icon = OH.icon, fmt = OH.fmt, $ = OH.$;

  // ------------------------------------------------------------------ binding
  var binds = [], seq = 0;
  function bind(fn) { var id = 'b' + (seq++); binds.push({ id: id, fn: fn, el: null }); return id; }
  function update() {
    binds.forEach(function (b) {
      if (!b.el) b.el = document.getElementById(b.id);
      if (b.el) { try { b.fn(b.el); } catch (e) { /* one broken binding must not stop the rest */ } }
    });
  }
  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
  function cls(el, c) { if (el.className !== c) el.className = c; }

  // ------------------------------------------------------------------ formatting
  function deg(item, d) { var v = num(item); return isNaN(v) ? '--' : v.toFixed(d === undefined ? 1 : d) + '°'; }
  function pct(item) { var v = num(item); return isNaN(v) ? '--' : Math.round(v) + '%'; }
  function watts(v) { return isNaN(v) ? '--' : v >= 1000 ? (v / 1000).toFixed(2) + ' kW' : Math.round(v) + ' W'; }
  function minsFromSec(v) { return Math.round(v / 60) + ' min'; }
  function timeOf(item) { var d = OH.parseLocal(st(item)); return d ? OH.hm(d) : '--'; }

  // ------------------------------------------------------------------ builders
  function card(o) {
    return '<section class="card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + '>' +
      (o.title ? '<div class="card-h">' + (o.dot ? '<span class="dot ' + o.dot + '"></span>' : '') + (o.icon ? icon(o.icon) : '') +
        '<span>' + esc(o.title) + '</span>' + (o.aside ? '<span class="aside" id="' + o.aside + '"></span>' : '') + '</div>' : '') +
      (o.body || '') + (o.footer ? '<div class="card-f">' + esc(o.footer) + '</div>' : '') + '</section>';
  }

  // on/off row; tapping toggles the item
  function more(popKey) { return popKey ? '<span class="more" data-act="pop" data-arg="' + popKey + '">' + icon('i-chev') + '</span>' : ''; }
  function toggle(title, item, ic, popKey) {
    var id = bind(function (el) {
      var on = st(item) === 'ON';
      cls(el, 'row' + (on ? ' on' : '') + (has(item) ? '' : ' na'));
      setText(el.querySelector('.rv'), has(item) ? (on ? 'On' : 'Off') : 'no data');
    });
    return '<div class="row" id="' + id + '" data-toggle="' + item + '">' + icon(ic || 'i-bulb') + '<span class="rt">' + esc(title) +
      '</span><span class="rv"></span>' + more(popKey) + '<span class="sw"><i></i></span></div>';
  }

  // read-only row; fn returns the value text
  function label(title, fn, ic, strong, popKey) {
    var id = bind(function (el) { setText(el, fn()); });
    return '<div class="row">' + (ic ? icon(ic) : '') + '<span class="rt">' + esc(title) + '</span><span class="rv' + (strong ? ' strong' : '') + '" id="' + id + '"></span>' + more(popKey) + '</div>';
  }

  // slider; sends the value when released. o.power: dims the slider while that switch is OFF
  var sliding = {};
  function slider(title, item, o) {
    o = o || {};
    var min = o.min || 0, max = o.max === undefined ? 100 : o.max;
    var id = bind(function (el) {
      var r = el.querySelector('input');
      if (o.power) cls(el, 'sl' + (st(o.power) === 'ON' ? '' : ' off'));
      if (sliding[item]) return;
      var v = num(item);
      if (!isNaN(v)) { r.value = v; paint(r, min, max); setText(el.querySelector('b'), Math.round(v) + (o.unit || '%')); }
    });
    return '<div class="sl" id="' + id + '"><div class="sl-top"><span>' + esc(title) + '</span><b>--</b></div>' +
      '<input type="range" min="' + min + '" max="' + max + '" step="' + (o.step || 1) + '" data-slider="' + item + '" data-unit="' + (o.unit || '%') + '"></div>';
  }
  function paint(r, min, max) {
    var p = ((r.value - min) / (max - min)) * 100;
    r.style.setProperty('--fill', 'linear-gradient(to right, var(--accent) ' + p + '%, var(--panel-2) ' + p + '%)');
  }

  // segmented buttons: [{label, item, cmd, on: fn, sub: fn|string, cls}] or {label, act, arg, on} for page-local actions
  function seg(opts, tall) {
    return '<div class="seg' + (tall ? ' tall' : '') + '">' + opts.map(function (b) {
      var id = bind(function (el) {
        cls(el, 'sb' + (b.cls ? ' ' + b.cls : '') + (b.on && b.on() ? ' on' : ''));
        if (b.visible) el.style.display = b.visible() ? '' : 'none';
        if (typeof b.sub === 'function') setText(el.querySelector('small'), b.sub());
      });
      var attrs = b.act ? ' data-act="' + b.act + '" data-arg="' + esc(b.arg) + '"'
        : ' data-cmd="' + esc(b.cmd) + '" data-item="' + b.item + '"' + (b.toggle ? ' data-tog="1"' : '');
      return '<div class="sb" id="' + id + '"' + attrs + '>' +
        esc(b.label) + (b.sub ? '<small>' + (typeof b.sub === 'string' ? esc(b.sub) : '') + '</small>' : '') + '</div>';
    }).join('') + '</div>';
  }

  // ------------------------------------------------------------------ actions (one delegated handler)
  var ACT = {};
  function onTap(e) {
    var el;
    if (e.target.closest('#popup') && (!e.target.closest('.pop-box') || e.target.closest('.sheet-close'))) { closePopup(); return; }
    if ((el = e.target.closest('[data-act]'))) {
      var f = ACT[el.getAttribute('data-act')];
      if (f) f(el);
    } else if ((el = e.target.closest('[data-cmd]'))) {
      var item = el.getAttribute('data-item'), cmd = el.getAttribute('data-cmd');
      // "toggle" buttons (watering) send OFF when already ON, like the Main UI's toggle action
      if (el.getAttribute('data-tog') && st(item) === 'ON') cmd = 'OFF';
      OH.command(item, cmd).catch(function () {});
    } else if ((el = e.target.closest('[data-toggle]'))) {
      var it = el.getAttribute('data-toggle');
      OH.command(it, st(it) === 'ON' ? 'OFF' : 'ON').catch(function () {});
    }
    OH.rerender();
  }
  function wireSliders(root) {
    var list = root.querySelectorAll('input[data-slider]');
    for (var i = 0; i < list.length; i++) (function (r) {
      var item = r.getAttribute('data-slider'), unit = r.getAttribute('data-unit');
      var min = +r.min, max = +r.max;
      var hold = function () { sliding[item] = Date.now(); };
      r.addEventListener('touchstart', hold); r.addEventListener('mousedown', hold);
      r.addEventListener('input', function () {
        hold(); paint(r, min, max);
        r.parentNode.querySelector('b').textContent = Math.round(r.value) + unit;
      });
      r.addEventListener('change', function () {
        OH.command(item, String(Math.round(r.value))).catch(function () {});
        // keep the slider where it was let go until the device reports back
        setTimeout(function () { delete sliding[item]; OH.rerender(); }, 2500);
      });
    })(list[i]);
  }

  // ------------------------------------------------------------------ heating setpoint (+/- 0.5, sent after a pause)
  var pendingSp = {};
  ACT.sp = function (el) {
    var item = el.getAttribute('data-item'), d = parseFloat(el.getAttribute('data-d'));
    var p = pendingSp[item] || { v: num(item) };
    if (isNaN(p.v)) return;
    p.v = Math.round((p.v + d) * 2) / 2;
    clearTimeout(p.t);
    p.t = setTimeout(function () {
      OH.command(item, p.v.toFixed(1) + ' °C').catch(function () {});
      p.sentAt = Date.now();
    }, 1500);
    pendingSp[item] = p;
  };
  function setpoint(zone) {
    var item = 'Evohome_Setpoint' + zone;
    var id = bind(function (el) {
      var p = pendingSp[item], cur = num(item);
      // drop the pending value once Evohome reports it (or after a minute)
      if (p && p.sentAt && (Math.abs(cur - p.v) < 0.01 || Date.now() - p.sentAt > 60000)) { delete pendingSp[item]; p = null; }
      var v = p ? p.v : cur;
      setText(el.querySelector('b'), isNaN(v) ? '--' : v.toFixed(1) + '°');
      setText(el.querySelector('div'), p ? (p.sentAt ? 'sending…' : 'hold at') : 'setpoint');
      cls(el, 'spv' + (p ? ' pending' : ''));
    });
    var stat = 'Evohome_Status' + zone;
    var bid = bind(function (el) { var s = st(stat); el.style.display = s && s !== 'FollowSchedule' && s !== 'NULL' ? '' : 'none'; });
    return '<div class="sp"><div class="spb" data-act="sp" data-item="' + item + '" data-d="-0.5">' + icon('i-minus') + '</div>' +
      '<div class="spv" id="' + id + '"><b>--</b><div>setpoint</div></div>' +
      '<div class="spb" data-act="sp" data-item="' + item + '" data-d="0.5">' + icon('i-plus') + '</div></div>' +
      '<div class="back-sched" id="' + bid + '" data-cmd="0" data-item="' + item + '">Back to schedule</div>';
  }
  function zonePill(zone) {
    var stat = 'Evohome_Status' + zone;
    var id = bind(function (el) {
      var s = st(stat), hold = s && s !== 'FollowSchedule' && s !== 'NULL';
      cls(el, 'pill ' + (hold ? 'warn' : 'ok'));
      el.innerHTML = icon(hold ? 'i-hand' : 'i-calendar') + (hold ? (s === 'TemporaryOverride' ? 'Temporary hold' : 'Hold') : 'Schedule');
    });
    return '<span class="pill" id="' + id + '"></span>';
  }

  // ------------------------------------------------------------------ pages
  var PAGES = {};
  var TABS = [['climate', 'i-thermo'], ['lights', 'i-bulb'], ['energy', 'i-bolt'], ['appliances', 'i-washer'], ['cameras', 'i-camera'], ['garden', 'i-sprout']];

  // ---------- Climate
  PAGES.climate = { title: 'Climate', build: function () {
    var modes = [['Schedule', 'Auto'], ['Eco', 'AutoWithEco'], ['Away', 'Away'], ['Day off', 'DayOff'], ['Off', 'HeatingOff']];
    var modeBar = card({ title: 'Heating mode', icon: 'i-flame', cls: 'inline', body: seg(modes.map(function (m) {
      return { label: m[0], item: 'Evohome_SystemMode', cmd: m[1], on: function () { return st('Evohome_SystemMode') === m[1]; } };
    })) });

    function room(o) {
      var nowId = bind(function (el) {
        setText(el.querySelector('.t'), deg(o.temp));
        setText(el.querySelector('.h'), o.hum ? 'Humidity ' + pct(o.hum) : (o.note || ''));
      });
      return card({ title: o.name, dot: o.dot, cls: 'room', body:
        '<div class="room-now" id="' + nowId + '"><div><div class="big"><span class="t">--</span></div><div class="sub2 h"></div></div>' + (o.zone ? zonePill(o.zone) : '') + '</div>' +
        (o.extra || '') + (o.zone ? setpoint(o.zone) : '') });
    }
    function kv(title, fn) { var id = bind(function (el) { setText(el, fn()); }); return '<div class="kv"><span>' + esc(title) + '</span><b id="' + id + '"></b></div>'; }

    return modeBar + '<div class="g g3 mt rooms">' +
      room({ name: 'Living room', dot: 'c-living', temp: 'MetrifulSensor_Temperature', hum: 'MetrifulSensor_Humidity',
        extra: kv('Air quality', function () { return st('MetrifulSensor_AirQualityInterpretation') || '--'; }) +
               kv('CO₂ (estimated)', function () { var v = num('MetrifulSensor_EstimatedCO2'); return isNaN(v) ? '--' : Math.round(v) + ' ppm'; }) +
               kv('Pressure', function () { var v = num('MetrifulSensor_AthmosphericPressure'); return isNaN(v) ? '--' : Math.round(v) + ' hPa'; }) }) +
      room({ name: 'Bedroom', dot: 'c-bedroom', temp: 'BedroomTemperatureHumidity_Temperature', hum: 'BedroomTemperatureHumidity_Humidity', zone: 'Bedroom',
        extra: kv('Thermostat', function () { return deg('Evohome_ActualBedroom'); }) }) +
      room({ name: "Lu's room", dot: 'c-lu', temp: 'LusRoomTemperatureHumidity_Temperature', hum: 'LusRoomTemperatureHumidity_Humidity', zone: 'DruSRoom',
        extra: kv('Thermostat', function () { return deg('Evohome_ActualDruSRoom'); }) }) +
      room({ name: 'Bathroom', dot: 'c-bath', temp: 'Evohome_ActualBathroom', note: 'Thermostat reading (no room sensor)', zone: 'Bathroom' }) +
      room({ name: 'Attic office', dot: 'c-attic', temp: 'AtticOffice_Temperature', hum: 'AtticOffice_Humidity', zone: 'Attic',
        extra: kv('Thermostat', function () { return deg('Evohome_ActualAttic'); }) }) +
      room({ name: 'Outside', dot: 'c-outside', temp: 'VerandaTemperatureHumidity_Temperature', hum: 'VerandaTemperatureHumidity_Humidity',
        extra: kv('Pressure', function () { var v = num('VerandaTemperatureHumidity_AtmosphericPressure'); return isNaN(v) ? '--' : Math.round(v) + ' hPa'; }) +
               kv('Sunrise', function () { return timeOf('Astro_Rise_StartTime'); }) +
               kv('Dusk', function () { return timeOf('Astro_CivilDusk_StartTime'); }) }) +
      '</div>';
  } };

  // ---------- Lights
  // Areas left to right. A light: { name, power, bright?, ct?, icon? }; the kitchen is special (scenes).
  // Up to 4 areas: one column each with the sliders inline. 5 and more: compact cards, 3 per row,
  // and a dimmable light opens a popup with its sliders (like the Main UI).
  var AREAS = [
    { name: 'Bedroom', dot: 'c-bedroom', lights: [
      { name: 'Main lights', power: 'BedroomMainLights_Power', bright: 'BedroomMainLights_Brightness', ct: 'BedroomMainLights_ColorTemperature' },
      { name: 'Night light', power: 'BedroomNightLight_Power', bright: 'BedroomNightLight_Brightness', ct: 'BedroomNightLight_Color_Temperature' } ] },
    { name: 'Kitchen', dot: 'c-kitchen', kitchen: true },
    { name: 'Entrance', dot: 'c-entrance', note: function () { return 'Automation: ' + (st('outdoorlightsNextStatusChange') || '--'); }, lights: [
      { name: 'Front door', power: 'EntranceLightsPower', bright: 'EntranceLightsBrightness', ct: 'EntranceLightsColorTemperature' } ] },
    { name: 'Garden', dot: 'c-outside', lights: [
      { name: 'Veranda', power: 'VerandaMainLights_Power', bright: 'VerandaMainLights_Brightness', ct: 'VerandaMainLights_Color_Temperature' },
      { name: 'Shed', power: 'ShedLight_ShedLightsPower', icon: 'i-home' },
      { name: 'Christmas', power: 'VerandaChristmasLights_power', icon: 'i-star' },
      { name: 'Hue Christmas', power: 'HueChristmas_Power', icon: 'i-star' },
      { name: 'Garden socket', power: 'SONOFFPowerSocket_State', icon: 'i-plug' } ] }
  ];
  var kitchenState = function () {
    if (st('Kitchenlightsabovethecountertop_State') !== 'ON') return 'Off';
    return st('Kitchenlightsabovethehood_State') === 'ON' ? 'All on' : 'Dimmed ' + pct('Kitchenlightsabovethecountertop_Brightness');
  };
  function kitchenScenes() {
    var scene = function (lbl, cmd) {
      return { label: lbl, item: 'KitchenLights_Scene', cmd: cmd, on: function () {
        var s0 = kitchenState(); return cmd === 'FULL' ? s0 === 'All on' : cmd === 'DIM' ? s0.indexOf('Dimmed') === 0 : s0 === 'Off';
      } };
    };
    return seg([scene('All on', 'FULL'), scene('Dimmed', 'DIM'), scene('Off', 'OFF')]);
  }
  function lightSliders(l) {
    return slider('Brightness', l.bright, { power: l.power }) + (l.ct ? slider('Colour temperature', l.ct, { power: l.power }) : '');
  }
  PAGES.lights = { title: 'Lights', build: function () {
    var areas = OH.demo(AREAS, OH.Q.areas), compact = areas.length > 4;
    POP = {};
    function light(l) {
      if (!l.bright) return toggle(l.name, l.power, l.icon || 'i-bulb');
      if (!compact) return toggle(l.name, l.power, 'i-bulb') + lightSliders(l);
      var k = popKey(l.name, function () { return toggle(l.name, l.power, 'i-bulb') + lightSliders(l); });
      return toggle(l.name, l.power, 'i-bulb', k);
    }
    function area(a) {
      var body;
      if (a.kitchen) {
        var k = compact ? popKey('Kitchen', function () {
          return label('Now', kitchenState, 'i-bulb', true) + kitchenScenes() + slider('Dimmed brightness', 'Kitchenlightsabovethecountertop_Brightness', { min: 5 });
        }) : null;
        body = label('Now', kitchenState, 'i-bulb', true, k) + kitchenScenes() +
          (compact ? '' : slider('Dimmed brightness', 'Kitchenlightsabovethecountertop_Brightness', { min: 5 }));
      } else {
        body = a.lights.map(light).join('');
      }
      if (a.note) body += '<div class="card-f" id="' + bind(function (el) { setText(el, a.note()); }) + '"></div>';
      return card({ title: a.name, dot: a.dot, body: body,
        aside: a.kitchen ? bind(function (el) { setText(el, num('kitchenLightsMode') > 0 ? 'Night mode' : 'Day mode'); }) : null,
        footer: a.kitchen && !compact ? 'Wall switch: by day all kitchen lights on/off; from 22:00 it toggles dimmed.' : null });
    }
    var cols = compact ? 3 : areas.length;
    return '<div class="g' + (compact ? ' compact' : '') + '" style="grid-template-columns: repeat(' + cols + ', 1fr)">' + areas.map(area).join('') + '</div>';
  } };

  // ------------------------------------------------------------------ popup (detail controls)
  var POP = {}, popSeq = 0, popup = null;
  function popKey(title, html) { var k = 'p' + (popSeq++); POP[k] = { title: title, html: html }; return k; }
  ACT.pop = function (el) { var p = POP[el.getAttribute('data-arg')]; if (p) openPopup(p.title, p.html()); };
  function openPopup(title, html) {
    closePopup();
    var mark = binds.length;
    var ov = document.createElement('div');
    ov.id = 'popup';
    ov.innerHTML = '<div class="pop-box"><div class="sheet-head"><span class="label">' + esc(title) + '</span><span class="sheet-close">Close</span></div>' + html + '</div>';
    $('canvas').appendChild(ov);
    wireSliders(ov);
    update();
    popup = { el: ov, mark: mark, t: setTimeout(closePopup, 60000) };
  }
  function closePopup() {
    if (!popup) return;
    clearTimeout(popup.t);
    if (popup.el.parentNode) popup.el.parentNode.removeChild(popup.el);
    binds.length = popup.mark;
    popup = null;
  }

  // ---------- Energy
  var CIRCUITS = [
    { n: 'Hob right', m: 10 }, { n: 'Hob left', m: 11 }, { n: 'Oven + master bedroom', m: 3 },
    { n: 'Living, kitchen, WC', m: 2 }, { n: 'Washer & dryer', m: 4 }, { n: 'Lu\'s room + attic office', m: 5 }
  ];
  var period = 'today';
  ACT.period = function (el) { period = el.getAttribute('data-arg'); };
  PAGES.energy = { title: 'Energy', build: function () {
    function tile(title, big, sub) {
      var id = bind(function (el) { el.querySelector('.big').innerHTML = big(); setText(el.querySelector('.sub2'), sub()); });
      return card({ cls: 'tile', title: title, body: '<div id="' + id + '"><div class="big"></div><div class="sub2"></div></div>' });
    }
    var priceStale = function () {
      var d = OH.parseLocal(st('ElectricityTariffUpdated'));
      return !d || Date.now() - d.getTime() > 48 * 3600 * 1000;
    };
    var circList = bind(function (el) {
      var key = period === 'month' ? 'Month' : 'Today';
      var rows = CIRCUITS.map(function (c) {
        return { n: c.n, w: num('EnergyMeter' + c.m + '_Power'), k: num('EnergyMeter' + c.m + '_' + key + 'Kwh'), e: num('EnergyMeter' + c.m + '_' + key + 'Cost') };
      });
      var max = Math.max.apply(null, rows.map(function (r) { return isNaN(r.k) ? 0 : r.k; }).concat([0.01]));
      el.innerHTML = rows.map(function (r) {
        return '<div class="circ"><div class="circ-top"><span class="n">' + esc(r.n) + '</span><span class="w">' + watts(r.w) + '</span>' +
          '<span class="k">' + fmt(r.k, period === 'month' ? 1 : 2) + ' kWh<br><small>€ ' + fmt(r.e, 2) + '</small></span></div>' +
          '<div class="circ-bar"><i style="width:' + (isNaN(r.k) ? 0 : (r.k / max * 100).toFixed(1)) + '%"></i></div></div>';
      }).join('');
    });
    return '<div class="g g4">' +
      tile('Power now', function () { var w = num('gEnergyPower'); return isNaN(w) ? '--' : w >= 1000 ? (w / 1000).toFixed(2) + '<small>kW</small>' : Math.round(w) + '<small>W</small>'; },
        function () { return 'All metered circuits'; }) +
      tile('Today', function () { return fmt(num('EnergyToday_kWh'), 2) + '<small>kWh</small>'; }, function () { return '€ ' + fmt(num('EnergyToday_Cost'), 2); }) +
      tile('This month', function () { return fmt(num('EnergyMonth_kWh'), 1) + '<small>kWh</small>'; }, function () { return '€ ' + fmt(num('EnergyMonth_Cost'), 2); }) +
      tile('Price', function () { var p = num('ElectricityTariff'); return isNaN(p) ? '--' : (p * 100).toFixed(2) + '<small>ct/kWh</small>'; },
        function () { return priceStale() ? 'STALE: not updated for 48 h' : 'Updated ' + timeOf('ElectricityTariffUpdated'); }) +
      '</div><div class="g mt e-low">' +
      card({ title: 'House power, last 24 h', icon: 'i-bolt', body: '<svg id="e-chart" viewBox="0 0 580 400"></svg><div class="e-tip" id="e-tip" hidden></div>' }) +
      card({ title: 'Per circuit', body: seg([
          { label: 'Today', act: 'period', arg: 'today', on: function () { return period === 'today'; } },
          { label: 'This month', act: 'period', arg: 'month', on: function () { return period === 'month'; } }
        ]) +
        '<div id="' + circList + '"></div>' }) +
      '</div>';
  }, after: function () { loadChart(); this.timer = setInterval(loadChart, 5 * 60 * 1000); } };

  // 24 h of total metered power: the meters are persisted (influxdb, 1 min), the SUM group is not
  var chart = null;
  function loadChart() {
    var end = Date.now(), start = end - 24 * 3600 * 1000, N = 288, step = (end - start) / N;
    var since = encodeURIComponent(new Date(start).toISOString());
    Promise.all(CIRCUITS.map(function (c) {
      return OH.getJSON('/rest/persistence/items/EnergyMeter' + c.m + '_Power?serviceId=influxdb&starttime=' + since)
        .then(function (j) { return j.data || []; }).catch(function () { return []; });
    })).then(function (series) {
      var tot = [];
      for (var b = 0; b < N; b++) tot.push(0);
      series.forEach(function (data) {
        var sum = [], cnt = [], last = 0, i;
        for (i = 0; i < N; i++) { sum.push(0); cnt.push(0); }
        data.forEach(function (p) { var k = Math.floor((p.time - start) / step); if (k >= 0 && k < N) { sum[k] += parseFloat(p.state); cnt[k]++; } });
        for (i = 0; i < N; i++) { if (cnt[i]) last = sum[i] / cnt[i]; tot[i] += last; }
      });
      chart = { v: tot, start: start, step: step };
      drawChart();
    });
  }
  function drawChart() {
    var svg = $('e-chart'); if (!svg || !chart) return;
    var W = 580, H = 400, L = 44, R = 8, T = 10, B = 26, v = chart.v, n = v.length;
    var max = Math.max.apply(null, v.concat([100]));
    var stepY = max > 4000 ? 1000 : max > 2000 ? 500 : max > 800 ? 250 : 100;
    var top = Math.ceil(max / stepY) * stepY;
    var x = function (i) { return L + i * (W - L - R) / (n - 1); }, y = function (w) { return T + (H - T - B) * (1 - w / top); };
    var g = '';
    for (var w = 0; w <= top; w += stepY) {
      g += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(w).toFixed(1) + '" y2="' + y(w).toFixed(1) + '"/>' +
        '<text class="axis" x="' + (L - 6) + '" y="' + (y(w) + 4).toFixed(1) + '" text-anchor="end">' + (w >= 1000 ? w / 1000 + 'k' : w) + '</text>';
    }
    // x labels on whole hours, every 6 h
    for (var i = 0; i < n; i++) {
      var t = new Date(chart.start + i * chart.step), t0 = new Date(chart.start + (i - 1) * chart.step);
      if (i > 0 && t.getHours() % 6 === 0 && t0.getHours() !== t.getHours())
        g += '<text class="axis" x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + OH.pad(t.getHours()) + ':00</text>';
    }
    var pts = v.map(function (w, k) { return x(k).toFixed(1) + ',' + y(w).toFixed(1); });
    svg.innerHTML = g + '<path class="area" d="M' + L + ',' + y(0) + ' L' + pts.join(' L') + ' L' + (W - R) + ',' + y(0) + ' Z"/>' +
      '<polyline class="line" points="' + pts.join(' ') + '"/><g id="e-cross"></g>';
    chart.x = x; chart.y = y; chart.L = L; chart.R = R; chart.W = W; chart.T = T; chart.B = B; chart.H = H;
  }
  // touch crosshair (no hover on a tablet): touch/drag over the chart shows time + power
  function chartTouch(e) {
    var svg = $('e-chart'); if (!svg || !chart || !chart.x) return;
    var tch = e.touches ? e.touches[0] : e;
    var r = svg.getBoundingClientRect();
    var fx = (tch.clientX - r.left) / r.width * chart.W;
    var n = chart.v.length, i = Math.round((fx - chart.L) / (chart.W - chart.L - chart.R) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    var px = chart.x(i), py = chart.y(chart.v[i]);
    $('e-cross').innerHTML = '<line class="cross" x1="' + px + '" x2="' + px + '" y1="' + chart.T + '" y2="' + (chart.H - chart.B) + '"/>' +
      '<circle class="dotm" cx="' + px + '" cy="' + py + '" r="5"/>';
    var tip = $('e-tip'), t = new Date(chart.start + i * chart.step);
    tip.innerHTML = OH.hm(t) + ' &nbsp;<b>' + watts(chart.v[i]) + '</b>';
    tip.hidden = false;
    var left = (px / chart.W) * r.width / (r.width / svg.clientWidth) + 16;
    tip.style.left = Math.min(left, svg.clientWidth - 110) + 'px';
    if (e.cancelable) e.preventDefault();
  }
  function chartEnd() { setTimeout(function () { var c = $('e-cross'), t = $('e-tip'); if (c) c.innerHTML = ''; if (t) t.hidden = true; }, 2500); }

  // ---------- Appliances
  // the list is in core.js (shared with the landing page). 1-4 appliances: one row; 5-6: 3 per row,
  // compact (the progress row is dropped, the bar shows it); hood and laundry stay below, the page scrolls.
  function applStatus(k) {
    var s = st(k + '_State'), rem = num(k + '_Remaining');
    if (st(k + '_Online') === 'OFF') return ['Offline', ''];
    if (s === 'Run') return [rem > 0 ? minsFromSec(rem) + ' left' : 'Running', 'run'];
    if (s === 'Finished') return ['Finished', 'done'];
    if (s === 'DelayedStart') return ['Starts later', 'wait'];
    if (s === 'Pause') return ['Paused', 'wait'];
    if (s === 'ActionRequired') return ['Needs attention', 'att'];
    if (s === 'Error') return ['Error', 'att'];
    if (s === 'Ready') return ['Ready', ''];
    return ['Idle', ''];
  }
  PAGES.appliances = { title: 'Appliances', build: function () {
    var list = OH.APPLIANCES, compactA = list.length > 4, colsA = list.length <= 4 ? list.length : 3;
    function appl(a) {
      var k = a.key;
      var sid = bind(function (el) {
        var s = applStatus(k);
        setText(el, s[0]); cls(el, 'status ' + s[1]);
      });
      var pid = bind(function (el) {
        var run = st(k + '_State') === 'Run', p = num(k + '_Progress');
        el.style.display = run && p > 0 ? '' : 'none';   // the dryer reports 0 % throughout
        el.firstChild.style.width = (isNaN(p) ? 0 : Math.min(100, p)) + '%';
      });
      var uid = bind(function (el) {
        var on = st(k + '_Unemptied') === 'ON', lc = OH.S[k + '_Unemptied'] ? OH.S[k + '_Unemptied'].lc : 0;
        el.style.display = on ? '' : 'none';
        if (!on) return;
        cls(el, 'unload' + (lc && Date.now() - lc > 3600000 ? ' late' : ''));
        setText(el.querySelector('span'), 'Waiting to be emptied' + (lc ? ' · finished ' + OH.ago(lc) : ''));
      });
      return card({ cls: 'appl', title: a.name, icon: a.icon, body:
        '<div class="status" id="' + sid + '"></div><div class="prog" id="' + pid + '"><i></i></div>' +
        '<div class="unload" id="' + uid + '"><span></span><b class="clr" data-cmd="OFF" data-item="' + k + '_Unemptied">Clear</b></div>' +
        label('Programme', function () { return st(k + '_Program') || '--'; }) +
        (compactA ? '' : label('Progress', function () { var p = num(k + '_Progress'); return st(k + '_State') === 'Run' && !isNaN(p) ? Math.round(p) + '%' : '--'; })) +
        label('Door', function () { return st(k + '_Door') || '--'; }) });
    }
    var stage = function (n) {
      return { label: 'Stage ' + n, item: 'Hood_FanLevel', cmd: String(n), on: function () { return st('Hood_Power') === 'ON' && st('Hood_FanLevel') === String(n); } };
    };
    return '<div class="g" style="grid-template-columns: repeat(' + colsA + ', 1fr)">' + list.map(appl).join('') + '</div><div class="g mt" style="grid-template-columns: 2fr 1fr">' +
      card({ title: 'Hood', icon: 'i-fan', footer: 'Venting on starts fan stage 2; choosing a stage (re)starts venting at that stage.', body:
        '<div class="g g2" style="grid-gap: 0 24px"><div>' + toggle('Venting', 'Hood_Power', 'i-fan') + toggle('Work light', 'Hood_WorkLight', 'i-bulb') + '</div>' +
        '<div>' + seg([stage(1), stage(2), stage(3)]) + label('Hob now', function () { return watts(num('EnergyMeter10_Power') + num('EnergyMeter11_Power')); }, 'i-bolt') + '</div></div>' }) +
      card({ title: 'Laundry circuit', icon: 'i-bolt', body:
        '<div class="big" id="' + bind(function (el) { el.innerHTML = Math.round(num('EnergyMeter4_Power')) + '<small>W</small>'; }) + '"></div>' +
        label('Today', function () { return fmt(num('EnergyMeter4_TodayKwh'), 2) + ' kWh'; }) +
        label('This month', function () { return fmt(num('EnergyMeter4_MonthKwh'), 1) + ' kWh'; }) }) +
      '</div>';
  } };

  // ---------- Cameras
  // One tab per camera (with a person badge), a near-live view (snapshot loop, ~1 frame/s; the
  // openHAB image has no ffmpeg, so ipcamera.mjpeg is not available) and that camera's last person.
  var camIdx = 0, camStop = null, lastFrame = 0, lastPerson = null;
  ACT.cam = function (el) { camIdx = +el.getAttribute('data-arg'); showCam(); };
  function showCam() {
    var c = OH.CAMERAS[camIdx], img = $('cam-live-img');
    if (!c || !img) return;
    if (camStop) camStop();
    lastFrame = 0; lastPerson = null;
    camStop = OH.camLoop(img, c.id, function (t) { lastFrame = t; });
    OH.rerender();
  }
  function stopCam() { if (camStop) { camStop(); camStop = null; } }
  PAGES.cameras = { title: 'Cameras', build: function () {
    var cur = function () { return OH.CAMERAS[camIdx] || OH.CAMERAS[0]; };
    if (camIdx >= OH.CAMERAS.length) camIdx = 0;
    var tabs = OH.CAMERAS.length > 1 ? '<div class="seg cam-tabs">' + OH.CAMERAS.map(function (c, i) {
      var id = bind(function (el) {
        var p = num(c.persons);
        cls(el, 'sb' + (i === camIdx ? ' on' : ''));
        el.innerHTML = esc(c.name) + (p > 0 ? ' <span class="badge">' + p + '</span>' : '');
      });
      return '<div class="sb" id="' + id + '" data-act="cam" data-arg="' + i + '"></div>';
    }).join('') + '</div>' : '';
    var lbl = bind(function (el) {
      var c = cur(), ok = lastFrame && Date.now() - lastFrame < 6000;
      setText(el, c.name + (ok ? ' · live' : lastFrame ? ' · no signal' : ' · loading'));
    });
    var pid = bind(function (el) {
      var v = st(cur().personImage);
      if (v && v !== lastPerson && v.indexOf('data:') === 0) { el.src = v; lastPerson = v; }
    });
    return tabs + '<div class="g cam-grid" style="grid-template-columns: 2.1fr 1fr">' +
      '<div class="cam-live"><img id="cam-live-img" alt=""><div class="lbl" id="' + lbl + '"></div></div>' +
      '<div class="stack">' +
        card({ title: 'Last person', icon: 'i-person', body: '<img class="person-img" id="' + pid + '" alt="">' +
          label('Seen', function () { var d = OH.parseLocal(st(cur().personTime)); return d ? OH.DAYS[d.getDay()] + ' ' + OH.hm(d) : '--'; }, 'i-clock') +
          label('Persons now', function () { var v = num(cur().persons); return isNaN(v) ? '0' : String(v); }, 'i-person', true) +
          label('Frigate', function () { var a = st('Frigate_Available'), sys = st('System_Frigate'); return (a || '--') + (sys && sys !== 'OK' ? ' · ' + sys : ''); }, 'i-camera') }) +
      '</div></div>';
  }, after: showCam, leave: stopCam };

  // ---------- Garden
  PAGES.garden = { title: 'Garden', build: function () {
    function water(name, item) {
      return label(name, function () {
        if (st(item) !== 'ON') return 'Off';
        var m = num('wateringCounter'); return 'Running' + (m > 0 ? ' · ' + Math.round(m) + ' min left' : '');
      }, 'i-drop', true);
    }
    var run = function (lbl, item, btn) {
      return { label: lbl, item: item, cmd: 'ON', toggle: true, on: function () { return st(btn) === 'ON'; } };
    };
    var dripOpt = function (lbl, cmd) {
      return { label: lbl, item: 'FrontDrip_Command', cmd: cmd, on: function () { return num('FrontDrip_Remaining') > 0 && st('FrontDrip_Interval') === cmd; } };
    };
    var soilNA = bind(function (el) {
      var any = ['Soil_Sensor_Grass_Area_Moisture', 'frontGardenSoilHumidity'].some(has);
      el.style.display = any ? 'none' : '';
    });
    return '<div class="g g3">' +
      card({ title: 'Sprinkler & drip irrigation', icon: 'i-drop', body:
        water('Sprinkler', 'sprinkler') + water('Drip irrigation', 'dripIrrigation') +
        '<div class="card-h" style="margin-top:10px">Sprinkler</div>' +
        seg([run('10 min', 'run10min', 'btn10status'), run('15 min', 'run15min', 'btn15status'), run('30 min', 'run30min', 'btn30status')]) +
        '<div class="card-h" style="margin-top:6px">Drip irrigation</div>' +
        seg([run('45 min', 'run45min', 'btn45status'), run('60 min', 'run60min', 'btn60status')]) +
        seg([{ label: 'Stop watering', item: 'abortRun', cmd: 'ON', cls: 'stop' }]) }) +
      '<div class="stack">' +
        card({ title: 'Front garden micro-drip', icon: 'i-sprout', footer: 'Stops by itself when the time is up.', body:
          label('Now', function () { var r = num('FrontDrip_Remaining'); return r > 0 ? 'Running · ' + minsFromSec(r) + ' left' : 'Off'; }, 'i-drop', true) +
          seg([dripOpt('1 hour', '1hr'), dripOpt('2 hours', '2hrs'), dripOpt('3 hours', '3hrs')]) +
          seg([{ label: 'Stop', item: 'FrontDrip_Command', cmd: 'OFF', cls: 'stop', visible: function () { return num('FrontDrip_Remaining') > 0; } }]) }) +
        card({ title: 'Power outlet', icon: 'i-plug', body: toggle('Front garden socket', 'SONOFFPowerSocket_State', 'i-plug') }) +
      '</div><div class="stack">' +
        card({ title: 'Soil', icon: 'i-sprout', body:
          '<div class="note" id="' + soilNA + '">Soil sensors are offline.</div>' +
          label('Grass: moisture', function () { return pct('Soil_Sensor_Grass_Area_Moisture'); }) +
          label('Grass: temperature', function () { return deg('Soil_Sensor_Grass_Area_Temperature'); }) +
          label('Front: moisture', function () { return pct('frontGardenSoilHumidity'); }) +
          label('Front: temperature', function () { return deg('frontGardenSoilTemperature'); }) }) +
        card({ title: 'Lights', icon: 'i-bulb', body:
          toggle('Veranda', 'VerandaMainLights_Power', 'i-bulb') + slider('Brightness', 'VerandaMainLights_Brightness', { power: 'VerandaMainLights_Power' }) +
          toggle('Shed', 'ShedLight_ShedLightsPower', 'i-home') + toggle('Christmas lights', 'VerandaChristmasLights_power', 'i-star') }) +
      '</div></div>';
  } };

  // ---------- Weather (from the landing page's weather panel; not a tab)
  // Open-Meteo forecast + air quality, fetched by the browser. Temperature and humidity "now" come
  // from the veranda sensor; everything else is the model's.
  var WXP = { f: null, aq: null };
  var OUT_T = 'VerandaTemperatureHumidity_Temperature', OUT_H = 'VerandaTemperatureHumidity_Humidity';
  function loadWx() {
    var L = OH.LOCATION, base = '?latitude=' + L.lat + '&longitude=' + L.lon + '&timezone=Europe%2FAmsterdam';
    OH.getJSON('https://api.open-meteo.com/v1/forecast' + base +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m,pressure_msl,cloud_cover,uv_index' +
      '&minutely_15=precipitation&forecast_minutely_15=12' +
      '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunshine_duration' +
      '&forecast_days=7').then(function (j) { WXP.f = j; WXP.t = Date.now(); drawWx(); }).catch(function () { var e = $('wx-upd'); if (e) e.textContent = 'Forecast unavailable'; });
    OH.getJSON('https://air-quality-api.open-meteo.com/v1/air-quality' + base +
      '&current=european_aqi,pm2_5,pm10,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,ragweed_pollen')
      .then(function (j) { WXP.aq = j; drawAq(); }).catch(function () {});
  }
  function drawWx() {
    var f = WXP.f; if (!f || !$('wx-now')) return;
    var c = f.current || {};
    $('wx-now-icon').innerHTML = OH.wxIcon(c.weather_code, c.is_day === 1);
    $('wx-cond').textContent = OH.WX_TEXT[c.weather_code] || '';
    var det = [
      ['Feels like', Math.round(c.apparent_temperature) + '°'],
      ['Wind', Math.round(c.wind_speed_10m) + ' km/h ' + OH.compass(c.wind_direction_10m) + '<small> · gusts ' + Math.round(c.wind_gusts_10m) + '</small>'],
      ['Pressure', Math.round(c.pressure_msl) + ' hPa'],
      ['Clouds', Math.round(c.cloud_cover) + '%'],
      ['UV now', fmt(c.uv_index, 1)]
    ];
    $('wx-det').innerHTML = det.map(function (d) { return '<div class="wx-kv"><span>' + d[0] + '</span><b>' + d[1] + '</b></div>'; }).join('');
    $('wx-upd').textContent = 'Open-Meteo · ' + OH.hm(new Date(WXP.t));
    drawRain(); drawHours(); drawDays();
    update();   // veranda fallbacks use the forecast
  }
  // next 3 h of precipitation in 15 min steps (central Europe gets real 15-min model data)
  function drawRain() {
    var m = WXP.f.minutely_15; if (!m) return;
    var now = Date.now(), v = [], t = [];
    for (var i = 0; i < m.time.length && v.length < 12; i++) {
      var ts = OH.parseLocal(m.time[i]).getTime();
      if (ts + 15 * 60000 <= now) continue;
      v.push(m.precipitation[i] || 0); t.push(ts);
    }
    var first = -1, last = -1;
    v.forEach(function (x, k) { if (x >= 0.1) { if (first < 0) first = k; last = k; } });
    var txt;
    if (first < 0) txt = 'Dry for the next ' + Math.round(v.length / 4) + ' h';
    else if (first === 0) txt = last === v.length - 1 ? 'Rain for the next ' + Math.round(v.length / 4) + ' h' : 'Rain, dry from ' + OH.hm(new Date(t[last] + 15 * 60000));
    else txt = 'Rain from ' + OH.hm(new Date(t[first]));
    $('wx-rain-txt').textContent = txt;
    var max = Math.max.apply(null, v.concat([1]));   // mm per 15 min; 1 mm = heavy
    $('wx-rain').innerHTML = v.map(function (x, k) {
      var h = x > 0 ? Math.max(4, x / max * 100) : 0;
      return '<div class="rb"><i style="height:' + h.toFixed(0) + '%"></i><span>' + (k % 4 === 0 ? OH.hm(new Date(t[k])) : '') + '</span></div>';
    }).join('');
  }
  // next 24 h: temperature line, precipitation bars, icon every 3 h
  function drawHours() {
    var h = WXP.f.hourly, svg = $('wx-hours'); if (!svg) return;
    var now = Date.now(), i0 = 0;
    for (var i = 0; i < h.time.length; i++) { if (OH.parseLocal(h.time[i]).getTime() + 3600000 > now) { i0 = i; break; } }
    var N = 25, T = [], P = [], PP = [], W = 600, H = 300, L = 14, R = 14, top = 70, bot = 250;
    for (var k = 0; k < N && i0 + k < h.time.length; k++) { T.push(h.temperature_2m[i0 + k]); P.push(h.precipitation[i0 + k] || 0); PP.push(h.precipitation_probability[i0 + k]); }
    var n = T.length, tmin = Math.min.apply(null, T), tmax = Math.max.apply(null, T);
    if (tmax - tmin < 4) { tmin -= 2; tmax += 2; }
    var x = function (k) { return L + k * (W - L - R) / (n - 1); };
    var y = function (v) { return top + 18 + (bot - 70 - top) * (1 - (v - tmin) / (tmax - tmin)); };
    var pmax = Math.max.apply(null, P.concat([2])), g = '';
    for (k = 0; k < n; k++) {   // rain bars along the bottom (mm per hour)
      if (P[k] > 0) { var bh = Math.max(2, P[k] / pmax * 60); g += '<rect class="wx-pb" x="' + (x(k) - 8).toFixed(1) + '" y="' + (bot - bh).toFixed(1) + '" width="16" height="' + bh.toFixed(1) + '" rx="2"/>'; }
    }
    g += '<line class="wx-base" x1="' + L + '" x2="' + (W - R) + '" y1="' + bot + '" y2="' + bot + '"/>';
    var pts = T.map(function (v, k) { return x(k).toFixed(1) + ',' + y(v).toFixed(1); });
    g += '<polyline class="wx-tl" points="' + pts.join(' ') + '"/>';
    for (k = 0; k < n; k += 3) {
      var hr = OH.parseLocal(h.time[i0 + k]).getHours();
      g += '<circle class="wx-td" cx="' + x(k).toFixed(1) + '" cy="' + y(T[k]).toFixed(1) + '" r="3.5"/>' +
        '<text class="wx-tv" x="' + x(k).toFixed(1) + '" y="' + (y(T[k]) - 12).toFixed(1) + '" text-anchor="middle">' + Math.round(T[k]) + '°</text>' +
        '<svg x="' + (x(k) - 17).toFixed(1) + '" y="4" width="34" height="34" viewBox="0 0 64 64">' + OH.wxIcon(h.weather_code[i0 + k], h.is_day[i0 + k] === 1).replace(/^<svg viewBox="0 0 64 64">|<\/svg>$/g, '') + '</svg>' +
        '<text class="wx-ax" x="' + x(k).toFixed(1) + '" y="' + (bot + 20) + '" text-anchor="middle">' + (k === 0 ? 'Now' : OH.pad(hr) + ':00') + '</text>' +
        '<text class="wx-pp" x="' + x(k).toFixed(1) + '" y="' + (bot + 40) + '" text-anchor="middle">' + (PP[k] >= 20 ? PP[k] + '%' : '') + '</text>';
    }
    svg.innerHTML = g;
    var tot = P.reduce(function (a, b) { return a + b; }, 0);
    $('wx-hours-aside').textContent = tot >= 0.1 ? fmt(tot, 1) + ' mm in 24 h' : 'No rain expected';
  }
  function drawDays() {
    var d = WXP.f.daily, el = $('wx-days'); if (!el) return;
    var lo = Math.min.apply(null, d.temperature_2m_min), hi = Math.max.apply(null, d.temperature_2m_max), span = Math.max(1, hi - lo);
    var html = '';
    for (var n = 0; n < d.time.length && n < 7; n++) {
      var day = OH.parseLocal(d.time[n]), mn = d.temperature_2m_min[n], mx = d.temperature_2m_max[n];
      var rain = d.precipitation_sum[n], sun = d.sunshine_duration[n] / 3600;
      html += '<div class="wd"><div class="wd-top"><span class="d">' + (n === 0 ? 'Today' : OH.DAYS[day.getDay()] + ' ' + day.getDate()) + '</span>' +
        '<span class="wi">' + OH.wxIcon(d.weather_code[n], true) + '</span>' +
        '<span class="lo">' + Math.round(mn) + '°</span><span class="rng"><i style="left:' + ((mn - lo) / span * 100).toFixed(1) + '%;width:' + Math.max(4, (mx - mn) / span * 100).toFixed(1) + '%"></i></span>' +
        '<span class="hi">' + Math.round(mx) + '°</span></div>' +
        '<div class="wd-sub"><span class="' + (rain >= 0.5 ? 'wet' : '') + '">' + icon('i-umbrella') + (rain >= 0.1 ? fmt(rain, 1) + ' mm · ' + d.precipitation_probability_max[n] + '%' : 'dry') + '</span>' +
        '<span>' + icon('i-air') + Math.round(d.wind_speed_10m_max[n]) + '<small>/' + Math.round(d.wind_gusts_10m_max[n]) + '</small></span>' +
        '<span>' + icon('i-sun') + fmt(sun, 1) + ' h</span></div></div>';
    }
    el.innerHTML = html;
    if (d.sunrise && d.sunrise[0]) $('wx-sun').textContent = '↑ ' + OH.hm(OH.parseLocal(d.sunrise[0])) + '   ↓ ' + OH.hm(OH.parseLocal(d.sunset[0]));
  }
  // European AQI bands; pollen in grains/m³ (the highest of the five)
  function drawAq() {
    var a = WXP.aq && WXP.aq.current, el = $('wx-aq'); if (!a || !el) return;
    var q = a.european_aqi, band = q <= 20 ? ['Good', 'ok'] : q <= 40 ? ['Fair', 'ok'] : q <= 60 ? ['Moderate', 'warn'] : q <= 80 ? ['Poor', 'warn'] : q <= 100 ? ['Very poor', 'bad'] : ['Extremely poor', 'bad'];
    var pol = [['Alder', a.alder_pollen], ['Birch', a.birch_pollen], ['Grass', a.grass_pollen], ['Mugwort', a.mugwort_pollen], ['Ragweed', a.ragweed_pollen]]
      .filter(function (p) { return p[1] >= 1; }).sort(function (x, y) { return y[1] - x[1]; });
    var pl = function (v) { return v < 10 ? 'low' : v < 50 ? 'moderate' : v < 200 ? 'high' : 'very high'; };
    el.innerHTML = '<div class="aq-top"><span class="big">' + Math.round(q) + '</span><span class="aq-b ' + band[1] + '">' + band[0] + '</span></div>' +
      '<div class="wx-kv"><span>PM2.5 / PM10</span><b>' + fmt(a.pm2_5, 0) + ' / ' + fmt(a.pm10, 0) + '<small> µg/m³</small></b></div>' +
      '<div class="wx-kv"><span>' + icon('i-leaf') + 'Pollen</span><b>' + (pol.length ? esc(pol[0][0]) + ' ' + pl(pol[0][1]) + (pol.length > 1 ? '<small> +' + (pol.length - 1) + '</small>' : '') : 'none') + '</b></div>';
  }
  PAGES.weather = { title: 'Weather', build: function () {
    var tNow = bind(function (el) { var v = num(OUT_T); setText(el, isNaN(v) ? (WXP.f ? fmt(WXP.f.current.temperature_2m, 1) : '--') : fmt(v, 1)); });
    var hNow = bind(function (el) { var v = num(OUT_H); setText(el, isNaN(v) ? (WXP.f ? Math.round(WXP.f.current.relative_humidity_2m) + '%' : '--') : Math.round(v) + '%'); });
    return '<div class="g wx-top">' +
      card({ id: 'wx-now', cls: 'wx-nowc', body:
        '<div class="wx-head"><div class="w-icon" id="wx-now-icon"></div><div class="w-temp"><span id="' + tNow + '">--</span><span class="deg">°</span></div>' +
        '<div class="wx-c"><div id="wx-cond">&nbsp;</div><div class="muted small">Veranda · humidity <span id="' + hNow + '">--</span></div><div class="muted small" id="wx-sun"></div></div></div>' +
        '<div class="wx-det" id="wx-det"></div><div class="card-f" id="wx-upd">Loading…</div>' }) +
      card({ title: 'Rain, next 3 h', icon: 'i-umbrella', body: '<div class="wx-rain-txt" id="wx-rain-txt">&nbsp;</div><div class="wx-rain" id="wx-rain"></div>' }) +
      card({ title: 'Air', icon: 'i-leaf', body: '<div id="wx-aq"><div class="muted small">Loading…</div></div>' }) +
      '</div><div class="g mt wx-low">' +
      card({ title: 'Next 24 h', icon: 'i-clock', aside: 'wx-hours-aside', body: '<svg id="wx-hours" viewBox="0 0 600 300"></svg>' }) +
      card({ title: '7 days', icon: 'i-calendar', body: '<div id="wx-days"></div>' }) +
      '</div>';
  }, after: function () {
    if (WXP.f && Date.now() - WXP.t < 10 * 60000) { drawWx(); drawAq(); } else loadWx();
    clearInterval(this.timer);   // after() runs again on screen wake
    this.timer = setInterval(loadWx, 15 * 60 * 1000);
  } };

  // ------------------------------------------------------------------ router
  var current = null;
  function show() {
    var name = location.hash.slice(1), p = PAGES[name];
    if (!p) { location.replace(OH.link('index.html')); return; }
    closePopup();
    if (current && current.leave) current.leave();
    if (current && current.timer) clearInterval(current.timer);
    binds = []; seq = 0;
    current = p;
    $('title').textContent = p.title;
    $('tabs').innerHTML = TABS.map(function (t) {
      return '<a class="sub-tab' + (t[0] === name ? ' on' : '') + '" href="#' + t[0] + '">' + icon(t[1]) + '</a>';
    }).join('');
    var body = $('body');
    body.className = 'sub-body pg-' + name;   // per-page layout hooks in pages.css
    body.innerHTML = p.build();
    body.scrollTop = 0;
    wireSliders(body);
    update();
    if (p.after) p.after.call(p);
  }
  function clock() { $('clock').textContent = OH.hm(new Date()); }

  function start() {
    document.querySelector('.back').href = OH.link('index.html');
    OH.start(update, { onVisible: function () { if (current && current.after) current.after.call(current); } });
    document.body.addEventListener('click', onTap);
    var body = $('body');
    body.addEventListener('touchstart', function (e) { if (e.target.closest('#e-chart')) chartTouch(e); }, { passive: false });
    body.addEventListener('touchmove', function (e) { if (e.target.closest('#e-chart')) chartTouch(e); }, { passive: false });
    body.addEventListener('touchend', function (e) { if (e.target.closest('#e-chart')) chartEnd(); });
    body.addEventListener('mousemove', function (e) { if (e.target.closest('#e-chart')) chartTouch(e); });
    body.addEventListener('mouseleave', chartEnd);
    window.addEventListener('hashchange', show);
    show();
    clock();
    (function tick() { clock(); setTimeout(tick, 60000 - Date.now() % 60000 + 50); })();
    // back to the landing page after 2 minutes without a touch
    var t;
    var arm = function () { clearTimeout(t); t = setTimeout(function () { location.href = OH.link('index.html'); }, 120000); };
    ['touchstart', 'mousedown'].forEach(function (ev) { document.addEventListener(ev, arm, true); });
    arm();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
