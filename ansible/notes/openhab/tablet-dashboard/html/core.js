/* Shared core for the tablet pages (index.html, page.html) — iPad Air 1 / Safari 12, plain ES2015.
   - item state store fed by /rest/items + the SSE event stream (anonymous read)
   - commands (anonymous POST, implicit user role)
   - the 1024x768 canvas scaled to the window, the icon sprite, version.txt auto-reload, 04:00 reload */
(function () {
  'use strict';

  var S = {};                 // item name -> { s: state string, lc: last change ms, label }
  var $ = function (id) { return document.getElementById(id); };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function st(name) { var e = S[name]; return e ? e.s : undefined; }
  function has(name) { var v = st(name); return v !== undefined && v !== 'NULL' && v !== 'UNDEF' && v !== ''; }
  function num(name) { return has(name) ? parseFloat(st(name)) : NaN; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function icon(id, cls) { return '<svg class="ic' + (cls ? ' ' + cls : '') + '"><use xlink:href="#' + id + '"/></svg>'; }
  function fmt(n, d) { return isNaN(n) ? '--' : n.toFixed(d); }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + pad(m % 60) + ' ago';
  }
  // Safari 12 parses "2026-11-15T17:00" as UTC and rejects "+0100": parse by hand (local wall time).
  function parseLocal(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
  }
  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  // ------------------------------------------------------------------ commands
  // ON/OFF are applied locally at once (the event stream confirms or corrects them).
  function command(item, cmd) {
    if (cmd === 'ON' || cmd === 'OFF') { var e = S[item] || (S[item] = { s: undefined, lc: 0, label: item }); e.s = cmd; rerender(); }
    return fetch('/rest/items/' + item, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: String(cmd) })
      .then(function (r) { if (!r.ok) throw new Error(item + ' ' + r.status); });
  }

  // ------------------------------------------------------------------ state + event stream
  var render = function () {}, renderTimer = null, es = null, lastMsg = 0;
  var diag = { opened: 0, errors: 0, reconnects: 0, polls: 0, lastPoll: 0, lastError: 0 };
  function rerender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = null; render(); }, 200);
  }
  // dot: green = live stream, amber = stream down but polling works, red = no data at all
  function setConn(ok) { var c = $('conn'); if (c) c.className = 'conn ' + (ok === true ? 'ok' : ok === 'poll' ? 'poll' : 'bad'); }
  function loadAll() {
    return getJSON('/rest/items?fields=name,state,label,lastStateChange').then(function (list) {
      list.forEach(function (i) { S[i.name] = { s: i.state, lc: i.lastStateChange || 0, label: i.label }; });
      render();
    });
  }
  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource('/rest/events?topics=openhab/items/*/statechanged,openhab/items/*/*/statechanged');
    diag.reconnects++;
    es.onopen = function () { lastMsg = Date.now(); diag.opened = Date.now(); setConn(true); loadAll().catch(function () {}); };
    es.onerror = function () { diag.errors++; diag.lastError = Date.now(); setConn(false); };
    es.onmessage = function (ev) {
      lastMsg = Date.now();
      setConn(true);
      var d, p;
      try { d = JSON.parse(ev.data); p = JSON.parse(d.payload); } catch (e) { return; }
      if (!d.topic || !p || p.value === undefined) return;
      var name = d.topic.split('/')[2];
      var e0 = S[name] || (S[name] = { s: undefined, lc: 0, label: name });
      e0.s = p.value; e0.lc = Date.now();
      rerender();
    };
  }

  // ------------------------------------------------------------------ canvas scaling
  // Size from the fixed full-screen #stage: in an iOS 12 home-screen app with the translucent status
  // bar, window.innerHeight is too small, which left a band at the bottom (2026-11-15).
  var STANDALONE_BOTTOM_RESERVE = 20;
  function fit() {
    var c = $('canvas'); if (!c) return;
    // iOS 12 home-screen apps disagree between measurements (the fixed #stage was seen growing to
    // 768 while only 748 px are visible), so take the smallest, and in home-screen mode never more
    // than the screen minus the 20 px opaque status bar.
    var stg = $('stage'), r = stg ? stg.getBoundingClientRect() : null, de = document.documentElement;
    var ws = [window.innerWidth, de.clientWidth], hs = [window.innerHeight, de.clientHeight];
    if (r && r.width) { ws.push(r.width); hs.push(r.height); }
    if (navigator.standalone && window.screen) {
      var landscape = window.innerWidth > window.innerHeight;
      hs.push((landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height)) - 20);
    }
    var pos = function (a) { return a.filter(function (v) { return v > 0; }); };
    var w = Math.min.apply(null, pos(ws)), h = Math.min.apply(null, pos(hs));
    // iOS 12 home-screen app started in landscape: every measurement says 748 at y 0, yet the
    // bottom ~20 px are hidden (the web view is shifted down by the status bar height). It cannot
    // be detected from script, so keep that strip free. Seen on the iPad Air 1, 2026-11-15.
    if (navigator.standalone) h -= STANDALONE_BOTTOM_RESERVE;
    fit.last = { w: w, h: h, reserve: navigator.standalone ? STANDALONE_BOTTOM_RESERVE : 0, inner: window.innerHeight, client: de.clientHeight, stage: r ? Math.round(r.height) : 0 };
    // Design size is 1024 wide; the canvas takes the screen's real proportions (at least 1024x768
    // design px), so a screen that is relatively taller or wider is filled by the flexible rows
    // instead of leaving a band.
    // minimum design height 720: the iPad home-screen app (748 minus the reserve = 728) renders at scale 1
    var s = Math.min(w / 1024, h / 720);
    c.style.width = (w / s) + 'px'; c.style.height = (h / s) + 'px';
    var t = 'scale(' + s + ')';
    c.style.webkitTransform = t; c.style.transform = t;
  }

  // ------------------------------------------------------------------ version.txt: reload open pages after a deploy
  var version = null;
  function checkVersion() {
    fetch('version.txt?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (v) {
      if (v === null) return;
      v = v.trim();
      if (version === null) version = v; else if (v !== version) location.reload();
    }).catch(function () {});
  }

  // ------------------------------------------------------------------ icon sprite (24px grid, stroke icons)
  var SPRITE = {
    'i-thermo': '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
    'i-bulb': '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
    'i-bolt': '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    'i-washer': '<rect x="4" y="2.5" width="16" height="19" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M7.5 6h.01M10.5 6h3"/>',
    'i-dryer': '<rect x="4" y="2.5" width="16" height="19" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M10 11.5c1.3 0 1.3 1.5 2.6 1.5M10 14c1.3 0 1.3 1.5 2.6 1.5M7.5 6h.01"/>',
    'i-dish': '<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M4 7h16"/><path d="M8 11v6M12 11v6M16 11v6"/>',
    'i-fan': '<path d="M3 9h18l-3-5H6z"/><path d="M10 9v4h4V9"/><path d="M8 17c1-1 2-1 3 0s2 1 3 0M7 20c1.3-1 2.7-1 4 0s2.7 1 4 0"/>',
    'i-camera': '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3"/>',
    'i-sprout': '<path d="M12 21v-9"/><path d="M12 12c0-4 3-7 8-7 0 4-3 7-8 7z"/><path d="M12 15c0-3-2.5-5.5-7-5.5 0 3 2.5 5.5 7 5.5z"/>',
    'i-drop': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    'i-moon': '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    'i-sunrise': '<path d="M5 18a7 7 0 0 1 14 0M2 18h20M12 3v5M9 6l3-3 3 3M4.2 10.2l1.4 1.4M19.8 10.2l-1.4 1.4"/>',
    'i-sunset': '<path d="M5 18a7 7 0 0 1 14 0M2 18h20M12 3v5M9 5l3 3 3-3M4.2 10.2l1.4 1.4M19.8 10.2l-1.4 1.4"/>',
    'i-home': '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
    'i-bin': '<path d="M4 6h16M9 6V4h6v2M6 6l1 15h10l1-15"/><path d="M10 10v7M14 10v7"/>',
    'i-alert': '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
    'i-person': '<circle cx="12" cy="7" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    'i-flame': '<path d="M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4.5 2-7 2 1 3 3 3 3 1-2 1-5 1-7z"/>',
    'i-check': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    'i-back': '<path d="M15 5l-7 7 7 7"/>',
    'i-chev': '<path d="M9 5l7 7-7 7"/>',
    'i-plus': '<path d="M12 5v14M5 12h14"/>',
    'i-minus': '<path d="M5 12h14"/>',
    'i-calendar': '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    'i-hand': '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 15.5a1.5 1.5 0 0 1 2.3-1.9L8 16"/>',
    'i-sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    'i-temp-k': '<path d="M12 3v2M12 19v2M3 12h2M19 12h2"/><circle cx="12" cy="12" r="5"/><path d="M12 7a5 5 0 0 1 0 10z"/>',
    'i-plug': '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
    'i-star': '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
    'i-stop': '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    'i-door': '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14 12h.01"/>',
    'i-clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'i-air': '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>',
    'i-gauge': '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/>',
    'i-tree': '<path d="M12 21v-4"/><path d="M12 3 6.5 11H9l-3.5 6h13L15 11h2.5z"/>',
    'i-umbrella': '<path d="M3 12a9 9 0 0 1 18 0z"/><path d="M12 12v7a2 2 0 0 1-4 0"/>',
    'i-leaf': '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19 13 11"/>',
    'i-cake': '<path d="M4 21h16M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/><path d="M5 16c1.2 1 2.3 1 3.5 0s2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0M12 12V8M12 5.5c-.8-1-.4-2 0-2.5.4.5.8 1.5 0 2.5z"/>',
    'i-heart': '<path d="M12 20s-7.5-4.5-7.5-10A4.2 4.2 0 0 1 12 7.5 4.2 4.2 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10z"/>',
    'i-book': '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
    'i-plane': '<path d="M10.5 13.5 3 11l1.5-1.5 8 1L17 6a2.1 2.1 0 0 1 3 3l-4.5 4.5 1 8L15 23l-2.5-7.5L9 19v3l-1.5 1L6 19l-4-1.5L3 16h3z"/>',
    'i-ball': '<circle cx="12" cy="12" r="9"/><path d="M3.5 9.5c5 1 12 1 17 0M3.5 14.5c5-1 12-1 17 0M12 3c-3 5-3 13 0 18"/>'
  };
  function injectSprite() {
    if ($('oh-sprite')) return;
    var html = '<svg id="oh-sprite" width="0" height="0" style="position:absolute" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs>';
    Object.keys(SPRITE).forEach(function (k) { html += '<symbol id="' + k + '" viewBox="0 0 24 24">' + SPRITE[k] + '</symbol>'; });
    var d = document.createElement('div');
    d.innerHTML = html + '</defs></svg>';
    document.body.insertBefore(d.firstChild, document.body.firstChild);
  }

  // ------------------------------------------------------------------ links
  // In an iOS home-screen app a tap on <a href> leaves the app and opens Safari. Navigating from
  // script stays inside the app, so same-origin links are followed that way.
  function keepLinksInApp() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (!a || a.target || a.origin !== location.origin) return;
      e.preventDefault();
      if (a.pathname === location.pathname && a.hash) location.hash = a.hash; else location.href = a.href;
    }, true);
  }

  // ------------------------------------------------------------------ diagnostics (tap the dot)
  function showDiag() {
    var box = $('oh-diag');
    if (box) { box.parentNode.removeChild(box); return; }
    var age = function (t) { return t ? Math.round((Date.now() - t) / 1000) + ' s ago' : 'never'; };
    var rs = es ? ['connecting', 'open', 'closed'][es.readyState] : 'none';
    var r = $('stage') ? $('stage').getBoundingClientRect() : { width: 0, height: 0 };
    box = document.createElement('div');
    box.id = 'oh-diag';
    box.innerHTML = 'Stream: <b>' + rs + '</b> · last event ' + age(lastMsg) + '<br>opened ' + age(diag.opened) +
      ' · connects ' + diag.reconnects + ' · errors ' + diag.errors + ' (last ' + age(diag.lastError) + ')<br>' +
      'Polling: ' + diag.polls + ' (last ' + age(diag.lastPoll) + ')<br>' +
      'Fit ' + (fit.last ? fit.last.w + '×' + fit.last.h + ' (bottom reserve ' + fit.last.reserve + ', inner ' + fit.last.inner + ', client ' + fit.last.client + ', stage ' + fit.last.stage + ')' : '-') + '<br>' +
      'Screen ' + Math.round(r.width) + '×' + Math.round(r.height) + ' at y ' + Math.round(r.top) + ' · device ' + screen.width + '×' + screen.height + ' · inner ' + window.innerWidth + '×' + window.innerHeight +
      ' · standalone ' + (!!navigator.standalone) + '<br>' + esc(navigator.userAgent);
    box.addEventListener('click', function () { box.parentNode.removeChild(box); });
    document.body.appendChild(box);
  }

  // ------------------------------------------------------------------ start
  // opts.onVisible: called when the page becomes visible again (screen wake)
  function start(renderFn, opts) {
    opts = opts || {};
    render = renderFn;
    injectSprite();
    keepLinksInApp();
    fit();
    setTimeout(fit, 500); setTimeout(fit, 2000);   // iOS settles the viewport late in home-screen apps
    window.addEventListener('resize', fit);
    var dot = $('conn');
    if (dot) dot.addEventListener('click', function (e) { e.stopPropagation(); showDiag(); });
    window.addEventListener('orientationchange', function () { setTimeout(fit, 300); });
    loadAll().catch(function () { setConn(false); });
    connect();
    checkVersion();
    setInterval(checkVersion, 60000);
    // energy meters change every few seconds, so a silent stream means it died: reconnect, and
    // meanwhile poll the item states every 15 s so the page never shows stale values
    setInterval(function () { if (Date.now() - lastMsg > 90000) { setConn(false); connect(); } }, 30000);
    setInterval(function () {
      if (Date.now() - lastMsg < 45000) return;
      loadAll().then(function () { diag.polls++; diag.lastPoll = Date.now(); setConn('poll'); }).catch(function () { setConn(false); });
    }, 15000);
    setInterval(rerender, 60000);       // "x min ago" texts, time-based expiry
    // a fresh page every night (memory leaks on a 1 GB iPad)
    setInterval(function () { var d = new Date(); if (d.getHours() === 4 && d.getMinutes() === 0) location.reload(); }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      fit();
      loadAll().catch(function () {});
      if (Date.now() - lastMsg > 30000) connect();
      if (opts.onVisible) opts.onVisible();
    });
  }

  // ------------------------------------------------------------------ shared config
  // preview switches for design work: ?cams=N repeats the cameras, ?appl=N the appliances, ?areas=N the light areas
  var Q = {};
  location.search.replace(/[?&]([^=&]+)=([^&]*)/g, function (m, k, v) { Q[k] = parseInt(v, 10) || 0; });
  function demo(list, n) {
    if (!n) return list;
    var out = [];
    for (var i = 0; i < n; i++) {
      var o = {}, src = list[i % list.length];
      Object.keys(src).forEach(function (k) { o[k] = src[k]; });
      if (i >= list.length) { o.name = o.name + ' ' + (i + 1); if (o.short) o.short = o.short + ' ' + (i + 1); }
      out.push(o);
    }
    return out;
  }

  // cameras: the landing page shows up to 3, the Cameras page has a tab per camera
  var CAMERAS = demo([
    { id: 'terrace', name: 'Terrace', persons: 'Camera_Terrace_Persons', personImage: 'Camera_Terrace_Person', personTime: 'Camera_Terrace_PersonTime' }
  ], Q.cams);

  // appliances (Home Connect via homeconnect-proxy): items <key>_State/_Program/_Remaining/_Progress/_Door/_Online/_Unemptied
  var APPLIANCES = demo([
    { key: 'Washer',     name: 'Washing machine', short: 'Washer',     icon: 'i-washer' },
    { key: 'Dryer',      name: 'Dryer',           short: 'Dryer',      icon: 'i-dryer' },
    { key: 'Dishwasher', name: 'Dishwasher',      short: 'Dishwasher', icon: 'i-dish' }
  ], Q.appl);

  // near-live camera view: fetch the next snapshot as soon as the previous one has loaded (the
  // ipcamera Thing polls go2rtc every second, so this gives about 1 frame/s). Returns a stop function.
  function camLoop(img, id, onFrame) {
    var stopped = false, timer = null;
    var next = function () {
      if (stopped) return;
      var t0 = Date.now(), pic = new Image();
      pic.onload = function () {
        if (stopped) return;
        img.src = pic.src;
        if (onFrame) onFrame(Date.now());
        timer = setTimeout(next, Math.max(0, 900 - (Date.now() - t0)));
      };
      pic.onerror = function () { timer = setTimeout(next, 3000); };
      pic.src = '/ipcamera/' + id + '/ipcamera.jpg?t=' + Date.now();
    };
    next();
    return function () { stopped = true; clearTimeout(timer); };
  }

  // ------------------------------------------------------------------ weather (Open-Meteo), shared by the landing page and page.html#weather
  var LOCATION = { lat: 52.08, lon: 5.06 };        // rounded (~1 km): only used for the forecast
  // open-meteo via the NPM proxy host meteo.iot on pi5 (the iPad has no internet; tablet-dashboard.md)
  var METEO = 'http://meteo.iot';
  var WX_TEXT = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };

  function wxIcon(code, day) {
    var sun = function (cx, cy, r) {
      var s = '<circle class="wx-sun" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>';
      for (var i = 0; i < 8; i++) {
        var a = i * Math.PI / 4, r1 = r + 4, r2 = r + 8;
        s += '<line class="wx-ray" x1="' + (cx + r1 * Math.cos(a)).toFixed(1) + '" y1="' + (cy + r1 * Math.sin(a)).toFixed(1) +
             '" x2="' + (cx + r2 * Math.cos(a)).toFixed(1) + '" y2="' + (cy + r2 * Math.sin(a)).toFixed(1) + '"/>';
      }
      return s;
    };
    var moon = function (tx, ty, k) {
      return '<path class="wx-moon" transform="translate(' + tx + ' ' + ty + ') scale(' + k + ')" d="M38 12a20 20 0 1 0 14 32A16 16 0 0 1 38 12z"/>';
    };
    var cloud = function (dy, cls) {
      return '<path class="' + (cls || 'wx-cloud') + '" transform="translate(0 ' + dy + ')" d="M18 50h28a10 10 0 0 0 1-20 14 14 0 0 0-27-3A11.5 11.5 0 0 0 18 50z"/>';
    };
    var lines = function (cls, y1, y2) {
      return '<line class="' + cls + '" x1="25" y1="' + y1 + '" x2="22" y2="' + y2 + '"/>' +
             '<line class="' + cls + '" x1="34" y1="' + y1 + '" x2="31" y2="' + y2 + '"/>' +
             '<line class="' + cls + '" x1="43" y1="' + y1 + '" x2="40" y2="' + y2 + '"/>';
    };
    var body;
    if (code <= 1) body = day ? sun(32, 32, 12) : moon(0, 0, 1);
    else if (code === 2) body = (day ? sun(24, 22, 9) : moon(-8, -6, 0.75)) + cloud(6);
    else if (code === 3) body = cloud(-4, 'wx-cloud-dark') + cloud(4);
    else if (code === 45 || code === 48) body = cloud(-8) + '<line class="wx-fog" x1="14" y1="50" x2="50" y2="50"/><line class="wx-fog" x1="20" y1="57" x2="44" y2="57"/>';
    else if (code >= 71 && code <= 77 || code === 85 || code === 86)
      body = cloud(-8) + '<circle class="wx-snow" cx="24" cy="52" r="3"/><circle class="wx-snow" cx="34" cy="57" r="3"/><circle class="wx-snow" cx="44" cy="52" r="3"/>';
    else if (code >= 95) body = cloud(-8, 'wx-cloud-dark') + '<polygon class="wx-bolt" points="35,40 25,54 32,54 28,63 41,48 34,48 38,40"/>';
    else body = cloud(-8) + lines('wx-rain', 48, 58);   // drizzle, rain, showers
    return '<svg viewBox="0 0 64 64">' + body + '</svg>';
  }
  function compass(deg) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }

  // ------------------------------------------------------------------ bin pickups
  // afvalwijzer sets one item per bin, Garbagebinscollectiondates_<Bin>, to "Friday, 20 Nov" (no year).
  // Same year rule as garbage.rules: a date more than a day in the past belongs to next year.
  var MON3 = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  function bins() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var out = [];
    Object.keys(S).forEach(function (k) {
      if (k.indexOf('Garbagebinscollectiondates_') !== 0) return;
      var m = /(\d{1,2}) ([A-Z][a-z]{2})/.exec(has(k) ? st(k) : ''), d = null;
      if (m && MON3[m[2]] !== undefined) {
        d = new Date(today.getFullYear(), MON3[m[2]], +m[1]);
        if (d.getTime() < today.getTime() - 86400000) d = new Date(today.getFullYear() + 1, MON3[m[2]], +m[1]);
      }
      var days = d ? Math.round((d.getTime() - today.getTime()) / 86400000) : NaN;
      out.push({ name: S[k].label || k.split('_')[1], date: d, days: days < 0 ? NaN : days });
    });
    out.sort(function (x, y) { return (isNaN(x.days) ? 1e9 : x.days) - (isNaN(y.days) ? 1e9 : y.days); });
    return out;
  }

  // Home calendar (HomeCal_Events, homeCalendar.js in openHAB): events with Date start/end, days from
  // today to the start day (0 while an event is ongoing), sorted by start. Category -> icon: first match.
  var CAL_ICONS = [
    [/birthday|verjaardag|anniversary/i, 'i-cake'],
    [/health|doctor|dentist|medical|arts/i, 'i-heart'],
    [/school|kids|study/i, 'i-book'],
    [/travel|holiday|vacation|vakantie|trip/i, 'i-plane'],
    [/sport|swim|football|gym/i, 'i-ball'],
    [/visit|guest|friends|family/i, 'i-person'],
    [/home|house|repair|maintenance/i, 'i-home']
  ];
  function calIcon(cats) {
    for (var i = 0; i < CAL_ICONS.length; i++) for (var j = 0; j < cats.length; j++) if (CAL_ICONS[i][0].test(cats[j])) return CAL_ICONS[i][1];
    return 'i-calendar';
  }
  function ymd(s) { var p = s.split('-'); return new Date(+p[0], p[1] - 1, +p[2]); }
  var evCache = { raw: null, list: [] };
  var DAY_MS = 86400000;
  function midnight(d) { var m = new Date(d.getTime()); m.setHours(0, 0, 0, 0); return m; }
  function dayDiff(a, b) { return Math.round((midnight(a).getTime() - midnight(b).getTime()) / DAY_MS); }   // DST-safe enough (rounded)
  // events still to come or running. days: start day - today (0 once started); span: calendar days covered;
  // dayNo: which of those days today is (1 before / on the first day); holiday: country code (NL, BG) or ''
  function events() {
    var raw = has('HomeCal_Events') ? st('HomeCal_Events') : '';
    if (raw !== evCache.raw) {
      evCache.raw = raw;
      try { evCache.list = JSON.parse(raw || '[]'); } catch (e) { evCache.list = []; }
    }
    var now = Date.now(), today = midnight(new Date());
    return evCache.list.map(function (o) {
      var s = o.ad ? ymd(o.s) : new Date(o.s), e = o.ad ? ymd(o.e) : new Date(o.e);
      var last = o.ad ? new Date(e.getTime() - DAY_MS) : new Date(Math.max(s.getTime(), e.getTime() - 1));
      var span = Math.max(1, dayDiff(last, s) + 1), d = dayDiff(s, today);
      var cats = o.c || [];
      return { title: o.t, uid: o.uid, allDay: !!o.ad, start: s, end: e, last: last, span: span, cats: cats, loc: o.loc || '',
        icon: o.h ? 'i-star' : calIcon(cats), holiday: o.h || '', days: d < 0 ? 0 : d, dayNo: d < 0 ? 1 - d : 1,
        ongoing: s.getTime() <= now };
    }).filter(function (ev) { return ev.end.getTime() > now; });
  }

  // openHAB /static sends Cache-Control max-age=1 year, so a plain link to page.html / index.html
  // can open a stale copy that loads old scripts (2026-11-17: the new weather page bounced back
  // home). Links between the pages carry this version: bump it on every deploy that changes them.
  var PAGES_V = '17';
  function link(href) { var i = href.indexOf('#'); return (i < 0 ? href : href.slice(0, i)) + '?v=' + PAGES_V + (i < 0 ? '' : href.slice(i)); }

  window.OH = {
    link: link, LOCATION: LOCATION, METEO: METEO, WX_TEXT: WX_TEXT, wxIcon: wxIcon, compass: compass, bins: bins, events: events, dayDiff: dayDiff,
    Q: Q, demo: demo, CAMERAS: CAMERAS, APPLIANCES: APPLIANCES, camLoop: camLoop,
    S: S, $: $, pad: pad, hm: hm, st: st, has: has, num: num, esc: esc, icon: icon, fmt: fmt, ago: ago,
    parseLocal: parseLocal, getJSON: getJSON, command: command, rerender: rerender, start: start,
    DAYS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    DAYS_LONG: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    MONTHS: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  };
})();
