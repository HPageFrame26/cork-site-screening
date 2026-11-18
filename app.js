/* Site screening prototype: interface. The map is drawn on the GPU by MapLibre and all
   scoring runs in score-worker.js, so dragging the map never waits on data. */
(function () {
  'use strict';
  var RZLT = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/Residential_Zoned_Land_Tax_Final_Map2026_view/FeatureServer/0/query';
  var BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
  // The published copy decrypts the data first (gate.js) and hands over in-memory addresses for each file.
  var URLS = window.DATA_URLS || null;
  function dataUrl(file) { return (URLS && URLS[file]) || 'data/app/' + file; }
  var WEIGHTS = { zoning: 30, flood: 15, waste: 15, supply: 10, market: 10, protected: 5, access: 10, planning: 5 };
  var weights = load('weights') || JSON.parse(JSON.stringify(WEIGHTS));
  Object.keys(WEIGHTS).forEach(function (k) { if (!(k in weights)) weights[k] = WEIGHTS[k]; });
  var saved = load('sites') || [];
  var GOOD = 'rgb(0,128,0)', MID = 'rgb(255,140,0)', BAD = 'rgb(200,16,46)';
  var ZCOL = { R: '#f0cf4a', M: '#e39a52', C: '#8d83d6', S: '#dc7fb0', N: '#a3a3a3', G: '#7cc081', P: '#dfe7c2', O: '#cfcfcf' };
  var ZNAME = { R: 'Residential', M: 'Mixed use', C: 'Commercial', S: 'Community', N: 'Infrastructure', G: 'Green', P: 'Rural', O: 'Other' };
  var DEC = { G: 'Granted', R: 'Refused', S: 'Split decision', W: 'Withdrawn', I: 'Invalid', P: 'No decision recorded' };
  var DCOL = { G: GOOD, R: BAD };

  function load(k) { try { return JSON.parse(localStorage.getItem('sitescreen.' + k)); } catch (e) { return null; } }
  function store(k, v) { try { localStorage.setItem('sitescreen.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function km(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km'; }
  function eur(n) { return '€' + Math.round(n).toLocaleString('en-IE'); }
  function band(s) { return s == null ? '#bbb' : s >= 70 ? GOOD : s >= 40 ? MID : BAD; }

  // ---------- map ----------
  var map = new maplibregl.Map({
    container: 'map', style: BASEMAP, center: [-8.6, 51.93], zoom: 9.3, minZoom: 7.5, maxZoom: 18.5,
    maxBounds: [[-11.6, 50.9], [-6.6, 52.9]], fadeDuration: 0, preserveDrawingBuffer: true, attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.dragRotate.disable(); map.touchZoomRotate.disableRotation();

  var LAYERS = [ // key, label, map layer ids, on at start, legend
    ['zoning', 'Zoning', ['zoning-fill', 'zoning-line'], true, Object.keys(ZCOL).map(function (k) { return [ZCOL[k], ZNAME[k]]; })],
    ['flood', 'Flood extents', ['flood-low', 'flood-med'], true, [['#2f7fd8', 'Medium'], ['#9cc8f2', 'Low']]],
    ['protected', 'Protected sites', ['prot-fill', 'prot-line'], true, null],
    ['candidates', 'Open zoned sites', ['cand-fill', 'cand-line'], true, [['#1c1c1c', 'Black outline']]],
    ['planning', 'Housing scheme applications', ['planning-small', 'planning'], true, [[GOOD, 'Granted'], [BAD, 'Refused'], ['#8a8a8a', 'Other']]],
    ['starts', 'Construction started', ['starts'], true, [['#1c1c1c', 'Start notice']]],
    ['monuments', 'Recorded monuments', ['monuments'], false, [['#7a4a1e', 'Monument']]],
    ['aerial', 'Aerial photo', ['aerial'], false, null],
    ['waste', 'Wastewater capacity', ['waste'], false, [[GOOD, 'Green'], [MID, 'Amber'], [BAD, 'Red']]]
  ];
  var visible = load('layers') || {};
  LAYERS.forEach(function (l) { if (!(l[0] in visible)) visible[l[0]] = l[3]; });

  map.on('load', function () {
    var firstLabel = (map.getStyle().layers.filter(function (l) { return l.type === 'symbol'; })[0] || {}).id;
    function src(name, file, opts) { var o = { type: 'geojson', data: dataUrl(file), tolerance: 0.5, buffer: 32 }; for (var k in opts) o[k] = opts[k]; map.addSource(name, o); }
    function add(layer) { map.addLayer(layer, firstLabel); }
    src('zoning', 'zoning.geojson'); src('flood', 'flood.geojson'); src('protected', 'protected.geojson');
    src('boundary', 'boundary.geojson'); src('planning', 'planning.geojson', { buffer: 8 }); src('waste', 'waste.geojson'); src('candidates', 'candidates.geojson'); src('starts', 'starts.geojson'); src('monuments', 'monuments.geojson', { buffer: 8 });
    map.addSource('ring', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    map.addSource('aerial', { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] });
    var firstRoad = (map.getStyle().layers.filter(function (l) { return l['source-layer'] === 'transportation'; })[0] || {}).id || firstLabel;
    map.addLayer({ id: 'aerial', type: 'raster', source: 'aerial', layout: { visibility: 'none' } }, firstRoad);
    var zmatch = ['match', ['slice', ['get', 'g'], 0, 1]];
    Object.keys(ZCOL).forEach(function (k) { zmatch.push(k, ZCOL[k]); }); zmatch.push('#cccccc');
    add({ id: 'zoning-fill', type: 'fill', source: 'zoning', paint: { 'fill-color': zmatch, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 13, 0.5, 16, 0.35] } });
    add({ id: 'zoning-line', type: 'line', source: 'zoning', minzoom: 12, paint: { 'line-color': '#6b6b6b', 'line-width': 0.5, 'line-opacity': 0.6 } });
    add({ id: 'flood-low', type: 'fill', source: 'flood', filter: ['==', ['get', 'prob'], 'low'], paint: { 'fill-color': '#9cc8f2', 'fill-opacity': 0.55 } });
    add({ id: 'flood-med', type: 'fill', source: 'flood', filter: ['==', ['get', 'prob'], 'medium'], paint: { 'fill-color': '#2f7fd8', 'fill-opacity': 0.5 } });
    add({ id: 'prot-fill', type: 'fill', source: 'protected', paint: { 'fill-color': '#1f7a3a', 'fill-opacity': 0.1 } });
    add({ id: 'prot-line', type: 'line', source: 'protected', paint: { 'line-color': '#1f7a3a', 'line-width': 1.4, 'line-dasharray': [3, 2] } });
    add({ id: 'boundary-line', type: 'line', source: 'boundary', paint: { 'line-color': '#1c1c1c', 'line-width': 1.2, 'line-opacity': 0.7 } });
    add({ id: 'ring-line', type: 'line', source: 'ring', paint: { 'line-color': '#1c1c1c', 'line-width': 1, 'line-dasharray': [2, 3] } });
    add({ id: 'cand-fill', type: 'fill', source: 'candidates', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.25 } });
    add({ id: 'cand-line', type: 'line', source: 'candidates', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#1c1c1c', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 2.4] } });
    var dcol = ['match', ['get', 'd'], 'G', GOOD, 'R', BAD, '#8a8a8a'];
    map.addLayer({ id: 'planning-small', type: 'circle', source: 'planning', minzoom: 14.5, filter: ['<', ['get', 'u'], 10],
      paint: { 'circle-radius': 2.5, 'circle-color': dcol, 'circle-opacity': 0.55 } });
    map.addLayer({ id: 'planning', type: 'circle', source: 'planning', minzoom: 10, filter: ['>=', ['get', 'u'], 10],
      paint: { 'circle-color': dcol, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['interpolate', ['linear'], ['get', 'u'], 10, 2, 300, 5], 15, ['interpolate', ['linear'], ['get', 'u'], 10, 5, 300, 14]] } });
    map.addLayer({ id: 'monuments', type: 'circle', source: 'monuments', minzoom: 12,
      paint: { 'circle-color': '#7a4a1e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 5] } });
    map.addLayer({ id: 'starts', type: 'circle', source: 'starts', minzoom: 10,
      paint: { 'circle-color': '#ffffff', 'circle-stroke-color': '#1c1c1c', 'circle-stroke-width': 2.5,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 15, ['interpolate', ['linear'], ['get', 'u'], 5, 5, 300, 13]] } });
    map.addLayer({ id: 'waste', type: 'circle', source: 'waste',
      paint: { 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5, 'circle-color': ['match', ['get', 'status'], 'Green', GOOD, 'Amber', MID, 'Red', BAD, '#888'] } });
    LAYERS.forEach(function (l) { setVisible(l[0], visible[l[0]]); });
    ['planning', 'planning-small', 'waste', 'starts', 'monuments'].forEach(function (id) {
      map.on('mouseenter', id, function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, function () { map.getCanvas().style.cursor = ''; });
    });
    drawRing(); candLayer();
  });
  function setVisible(key, on) {
    LAYERS.forEach(function (l) { if (l[0] === key) l[2].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }); });
  }
  function layerPanel() {
    $('layerrows').innerHTML = LAYERS.map(function (l) {
      return '<label><input type="checkbox" data-k="' + l[0] + '"' + (visible[l[0]] ? ' checked' : '') + '> ' + l[1] + '</label>' +
        (l[4] && visible[l[0]] ? '<div class="legend">' + l[4].map(function (s) { return '<span><i class="sw" style="background:' + s[0] + '"></i>' + s[1] + '</span>'; }).join('') + '</div>' : '');
    }).join('');
    $('layerrows').querySelectorAll('input').forEach(function (el) {
      el.addEventListener('change', function () { visible[el.dataset.k] = el.checked; store('layers', visible); setVisible(el.dataset.k, el.checked); layerPanel(); });
    });
  }
  layerPanel();

  var popup = new maplibregl.Popup({ closeButton: false, offset: 10 });
  map.on('click', function (e) {
    var ids = ['starts', 'planning', 'planning-small', 'waste', 'monuments'].filter(function (id) { return map.getLayer(id); });
    var f = map.queryRenderedFeatures(e.point, { layers: ids })[0];
    if (!f) { popup.remove(); drop(e.lngLat.lng, e.lngLat.lat); return; }
    var q = f.properties, html;
    if (f.layer.id === 'monuments') html = '<b>' + esc(q.c) + '</b>Recorded monument ' + esc(q.s);
    else if (f.layer.id === 'starts') html = '<b>Construction started ' + q.y + '</b>' + q.u + ' homes' + (q.done ? ', ' + q.done + ' certified complete' : '') + (q.stalled ? '<br>No completions on record: possibly stalled' : '') + (q.town ? '<br>' + esc(q.town) : '') + (q.ref ? '<br>Planning ref ' + esc(q.ref) : '');
    else if (f.layer.id === 'waste') html = '<b>' + esc(q.s) + '</b>' + esc(q.plant) + ' (' + esc(q.reg) + ')<br>Wastewater capacity: ' + esc(q.status) + (q.project === 'Yes' ? '<br>Project planned or under way' : '');
    else html = '<b>' + esc(q.r) + ' · ' + DEC[q.d] + '</b>' + q.y + (q.u >= 2 ? ' · about ' + q.u + ' homes' : '') + (q.a ? ' · appeal: ' + esc(q.a.toLowerCase()) : '') + '<br>' + esc(q.t) + (q.l ? '<br><a href="' + esc(q.l) + '" target="_blank" rel="noopener">Open the planning file</a>' : '');
    popup.setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  });

  // ---------- scoring worker ----------
  var cands = null, view = 'score', minHa = 0.5, openOnly = true, noPerm = false, addStalled = false;
  var worker = new Worker('score-worker.js' + (URLS ? '#' + encodeURIComponent(JSON.stringify(URLS)) : '')), reqId = 0, current = null, result = null, meta = { layers: {} }, marker = null;
  worker.onmessage = function (e) {
    var m = e.data;
    if (m.type === 'progress') $('status').textContent = 'Loading data… ' + m.done + ' of ' + m.total;
    else if (m.type === 'ready') { meta = m.meta; $('status').hidden = true; sources(); }
    else if (m.type === 'backtest') { window.__backtest = m; }
    else if (m.type === 'candidates') { cands = m.rows; candLayer(); if (view === 'best') render(); }
    else if (m.type === 'error') $('status').textContent = 'Data failed to load: ' + m.message;
    else if (m.type === 'result' && m.id === reqId) { result = m; checkWater(); render(); map.once('idle', function () { if (checkWater()) render(); }); }
  };
  // The background map knows where rivers, lakes and the sea are. A pin on water is ruled out.
  function checkWater() {
    if (!result || !result.inCork || result.water || !map.isStyleLoaded()) return false;
    var ids = map.getStyle().layers.filter(function (l) { return l['source-layer'] === 'water' && l.type === 'fill'; }).map(function (l) { return l.id; });
    if (!ids.length || !map.queryRenderedFeatures(map.project(result.p), { layers: ids }).length) return false;
    result.water = true;
    result.caps.push({ limit: 0, why: 'the pin is on open water (river, lake or sea on the background map)', key: 'water' });
    return true;
  }
  function drop(lon, lat, fly) {
    current = [lon, lat]; result = null; setView('score', true);
    if (!marker) { var el = document.createElement('div'); el.className = 'pin'; marker = new maplibregl.Marker({ element: el }); }
    marker.setLngLat(current).addTo(map);
    if (fly) map.flyTo({ center: current, zoom: Math.max(map.getZoom(), 14.5), speed: 1.6 });
    drawRing();
    $('body').innerHTML = '<div class="empty"><b>Scoring…</b></div>';
    worker.postMessage({ type: 'score', id: ++reqId, p: current });
    history.replaceState(null, '', '?pin=' + lat.toFixed(5) + ',' + lon.toFixed(5));
  }
  function drawRing() {
    var s = map.getSource && map.getSource('ring'); if (!s) return;
    if (!current) { s.setData({ type: 'FeatureCollection', features: [] }); return; }
    var pts = [], r = 2000, dLat = r / 111320, dLon = r / (111320 * Math.cos(current[1] * Math.PI / 180));
    for (var i = 0; i <= 72; i++) { var a = 2 * Math.PI * i / 72; pts.push([current[0] + dLon * Math.cos(a), current[1] + dLat * Math.sin(a)]); }
    s.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts } });
  }

  // ---------- result panel ----------
  function totals(src) {
    src = src || result;
    var sumW = 0, sumWS = 0, parts = [];
    src.factors.forEach(function (f) { var w = weights[f.key]; if (f.score != null && w) { sumW += w; sumWS += w * f.score; parts.push(w + ' × ' + f.score); } });
    var avg = sumW ? sumWS / sumW : 0, cap = null;
    src.caps.forEach(function (c) { if (!cap || c.limit < cap.limit) cap = c; });
    var final = cap && cap.limit < avg ? cap.limit : avg;
    return { avg: avg, final: Math.round(final), cap: cap && cap.limit < avg ? cap : null, sumW: sumW, parts: parts };
  }
  function verdict(t) {
    if (t.cap && t.cap.limit === 0) return ['Ruled out', 'A hard constraint applies'];
    if (t.final >= 75) return ['Strong candidate', 'On the public data'];
    if (t.final >= 50) return ['Worth a closer look', 'Mixed on the public data'];
    return ['Weak candidate', 'On the public data'];
  }
  function ring(score) {
    var c = 2 * Math.PI * 42;
    return '<div class="ring"><svg width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="42" fill="none" stroke="#ececec" stroke-width="9"/>' +
      '<circle cx="48" cy="48" r="42" fill="none" stroke="' + band(score) + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (c * score / 100).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg><b>' + score + '</b></div>';
  }
  function headHtml() {
    var t = totals(), v = verdict(t), h = '<div class="scorebox">' + ring(t.final) + '<div class="verdict"><b>' + v[0] + '</b><span>' + v[1] + '</span></div></div>';
    if (t.cap) h += '<div class="cap' + (t.cap.limit ? ' soft' : '') + '">' + (t.cap.limit === 0 ? '<b>Ruled out:</b> ' : '<b>Capped at ' + t.cap.limit + ':</b> ') + esc(t.cap.why) + '. The factors alone would give ' + Math.round(t.avg) + '.</div>';
    return h;
  }
  function workingsHtml() {
    var t = totals();
    return 'Workings: (' + t.parts.join(' + ') + ') ÷ ' + t.sumW + ' = ' + t.avg.toFixed(1) + (t.cap ? ', then capped at ' + t.cap.limit : '') + '. Weight × mark for each factor.';
  }
  function render() {
    var body = $('body');
    if (view === 'best') { renderBest(); return; }
    if (!result) { body.innerHTML = emptyHtml(); bindSaved(); return; }
    if (!result.inCork) { body.innerHTML = '<div class="empty"><b>Outside Cork</b>Only Cork City and County are loaded in this prototype.</div>' + savedHtml(); bindSaved(); return; }
    var p = result.p, name = result.place ? (result.place.d < 1500 ? result.place.name : 'Near ' + result.place.name) : 'Selected site';
    var h = '<div class="place"><h1>' + esc(name) + '</h1><small>' + p[1].toFixed(5) + ', ' + p[0].toFixed(5) + (result.place ? ' · ' + km(result.place.d) + ' from ' + esc(result.place.name) + ' centre' : '') + '</small></div>';
    h += '<div id="head">' + headHtml() + '</div>';
    h += '<div class="actions"><button class="btn" id="save">Save to compare</button><button class="btn ghost" id="copy">Copy link</button><button class="btn ghost" id="print">Site report</button><a class="btn ghost" id="sv" target="_blank" rel="noopener" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + p[1].toFixed(6) + ',' + p[0].toFixed(6) + '">Street View</a></div>';
    var mk = result.market || {};
    if (mk.price) h += '<span class="chip">Median sale price, ' + esc(mk.price.place) + ' <b>' + eur(mk.price.value) + '</b></span> ';
    if (mk.rent) h += '<span class="chip">Average rent, ' + esc(mk.rent.place) + ' <b>' + eur(mk.rent.value) + ' a month</b></span> ';
    if (result.parcel) { h += parcelHtml(result.parcel); }
    if (result.town) { h += townHtml(result.town); }
    if (false) { var pc = result.parcel; h += '<span class="chip">Zoned parcel ' + esc(pc.id) + ' <b>' + pc.ha.toFixed(2) + ' ha, about ' + pc.homes + ' homes</b> at ' + pc.density + ' per hectare · ' + (pc.open ? 'open land' : pc.cn ? 'construction of ' + pc.cn.u + ' homes started ' + pc.cn.y : pc.nb + ' buildings' + (pc.nr > 2 ? ' and estate roads' : '') + ' on it') + '</span> '; }
    h += '<span class="chip" id="rzlt">Land tax map: checking…</span>';
    if (result.notes && result.notes.length) h += '<h2>Check before going further</h2><ul class="notes">' + result.notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
    h += '<h2>Factors</h2>';
    result.factors.forEach(function (f) {
      h += '<details class="factor"><summary><span><span class="fname">' + f.label + '</span><span class="fsum">' + esc(f.summary) + '</span></span>' +
        '<span class="fmark" style="color:' + band(f.score) + '">' + (f.score == null ? '–' : f.score) + '</span><span class="bar"><i style="width:' + (f.score || 0) + '%;background:' + band(f.score) + '"></i></span></summary>' +
        '<div class="fbody">' + f.evidence + (f.key === 'planning' ? schemesHtml(f) : '') +
        '<div class="weight">Weight <input type="range" min="0" max="50" step="5" value="' + weights[f.key] + '" data-f="' + f.key + '"><output>' + weights[f.key] + '</output></div></div></details>';
    });
    h += '<p id="workings">' + workingsHtml() + '</p>';
    h += savedHtml();
    body.innerHTML = h; body.scrollTop = 0;
    body.querySelectorAll('input[type=range]').forEach(function (el) {
      el.addEventListener('input', function () {
        weights[el.dataset.f] = +el.value; el.nextElementSibling.textContent = el.value; store('weights', weights);
        $('head').innerHTML = headHtml(); $('workings').innerHTML = workingsHtml(); candLayer();
      });
    });
    $('save').addEventListener('click', saveSite);
    $('print').addEventListener('click', printReport);
    $('copy').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(function () { $('copy').textContent = 'Link copied'; }); });
    bindSaved(); rzlt(p); streetView(); map.once('idle', streetView);
  }
  // Street View only exists along roads. Point the link at the nearest road on the map, looking towards the pin.
  function streetView() {
    var a = $('sv'); if (!a || !result || !map.isStyleLoaded()) return;
    var p = result.p, c = map.project(p), R = 400, best = null;
    var ids = map.getStyle().layers.filter(function (l) { return l['source-layer'] === 'transportation' && l.type === 'line'; }).map(function (l) { return l.id; });
    var feats = map.queryRenderedFeatures([[c.x - R, c.y - R], [c.x + R, c.y + R]], { layers: ids });
    feats.forEach(function (f) {
      var cls = f.properties.class;
      if (cls === 'path' || cls === 'track' || cls === 'rail' || cls === 'transit' || cls === 'ferry' || f.properties.brunnel === 'tunnel') return;
      var lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      lines.forEach(function (line) {
        for (var i = 0; i < line.length - 1; i++) {
          var u = map.project(line[i]), v = map.project(line[i + 1]), dx = v.x - u.x, dy = v.y - u.y, L = dx * dx + dy * dy;
          var t = L ? Math.max(0, Math.min(1, ((c.x - u.x) * dx + (c.y - u.y) * dy) / L)) : 0;
          var x = u.x + t * dx, y = u.y + t * dy, d = (x - c.x) * (x - c.x) + (y - c.y) * (y - c.y);
          if (!best || d < best.d) best = { d: d, x: x, y: y };
        }
      });
    });
    var from = p, label = 'Street View';
    if (best) {
      var ll = map.unproject([best.x, best.y]); from = [ll.lng, ll.lat];
      var t = Math.PI / 180, y2 = Math.sin((p[0] - from[0]) * t) * Math.cos(p[1] * t);
      var x2 = Math.cos(from[1] * t) * Math.sin(p[1] * t) - Math.sin(from[1] * t) * Math.cos(p[1] * t) * Math.cos((p[0] - from[0]) * t);
      var heading = (Math.atan2(y2, x2) / t + 360) % 360;
      var dLat = (p[1] - from[1]) * 111320, dLon = (p[0] - from[0]) * 111320 * Math.cos(p[1] * t), m = Math.sqrt(dLat * dLat + dLon * dLon);
      a.href = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + from[1].toFixed(6) + ',' + from[0].toFixed(6) + '&heading=' + Math.round(heading) + '&fov=90';
      if (m > 25) label = 'Street View from the road, ' + km(m) + ' away';
    }
    a.textContent = label;
  }
  function schemesHtml(f) {
    if (!f.list || !f.list.length) return '';
    return '<div style="margin-top:8px">' + f.list.map(function (a) {
      return '<div class="app"><div class="top"><span><i class="dot" style="background:' + (DCOL[a.dec] || '#8a8a8a') + '"></i>' + (a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.ref) + '</a>' : esc(a.ref)) +
        ' · ' + DEC[a.dec] + (a.appeal ? ' · appeal: ' + esc(a.appeal.toLowerCase()) : '') + '</span><span class="dim">' + a.year + ' · ' + km(a.d) + '</span></div><p><b>About ' + a.units + ' homes.</b> ' + esc(a.text) + '</p></div>';
    }).join('') + (f.total > f.list.length ? '<p class="dim">Showing the nearest ' + f.list.length + ' of ' + f.total + '.</p>' : '') + '</div>';
  }
  function emptyHtml() {
    return '<div class="empty"><b>Pick a site</b>Click anywhere on the map or search for a place. You get a score out of 100 for a housing scheme, with the evidence behind every factor.</div>' + savedHtml();
  }
  function rzlt(p) {
    var q = RZLT + '?f=json&returnGeometry=false&outFields=PARCEL_ID,ZONE_DESC&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&geometry=' + p[0] + ',' + p[1];
    fetch(q).then(function (r) { return r.json(); }).then(function (d) {
      var el = $('rzlt'); if (!el || current !== p && (current[0] !== p[0] || current[1] !== p[1])) return;
      var f = (d.features || [])[0];
      el.innerHTML = f ? 'Land tax map 2026: <b>on it</b> (' + esc(f.attributes.PARCEL_ID) + ')' : 'Land tax map 2026: <b>not on it</b>';
      el.title = 'Residential Zoned Land Tax final map for 2026, live lookup. Land on the map is treated by the Department as zoned for housing and serviced.';
    }).catch(function () { var el = $('rzlt'); if (el) el.textContent = 'Land tax map: lookup failed'; });
  }

  // ---------- one-page site report ----------
  function printReport() {
    if (!result || !result.inCork) return;
    var t = totals(), v = verdict(t), p = result.p, mk = result.market || {}, img = '';
    try { img = map.getCanvas().toDataURL('image/jpeg', 0.85); } catch (e) { img = ''; }
    var name = result.place ? (result.place.d < 1500 ? result.place.name : 'Near ' + result.place.name) : 'Selected site';
    var client = (/[?&]client=([^&]+)/.exec(location.search) || [])[1];
    var h = '<div class="rhead"><div><h1>' + esc(name) + '</h1><p>' + p[1].toFixed(5) + ', ' + p[0].toFixed(5) + ' · Site screening report · ' + new Date().toLocaleDateString('en-IE', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      (client ? ' · Prepared for ' + esc(decodeURIComponent(client)) : '') + '</p></div><div class="rscore" style="border-color:' + band(t.final) + '"><b>' + t.final + '</b><span>' + v[0] + '</span></div></div>';
    if (t.cap) h += '<p class="rcap"><b>' + (t.cap.limit === 0 ? 'Ruled out: ' : 'Capped at ' + t.cap.limit + ': ') + '</b>' + esc(t.cap.why) + '. The factors alone would give ' + Math.round(t.avg) + '.</p>';
    h += '<div class="rcols"><div>' + (img ? '<img src="' + img + '" alt="Map of the site">' : '') + '<p class="rsmall">Map: zoning, flood extents, protected sites and open zoned parcels. Background © OpenStreetMap contributors.</p></div><div>';
    h += '<table>' + (mk.price ? '<tr><td>Median sale price, ' + esc(mk.price.place) + '</td><td class="num">' + eur(mk.price.value) + '</td></tr>' : '') +
      (mk.rent ? '<tr><td>Average monthly rent, ' + esc(mk.rent.place) + '</td><td class="num">' + eur(mk.rent.value) + '</td></tr>' : '') + '</table>';
    if (result.parcel) h += parcelHtml(result.parcel);
    if (result.town) h += townHtml(result.town);
    h += '</div></div>';
    if (result.notes && result.notes.length) h += '<h2>Check before going further</h2><ul>' + result.notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
    h += '<h2>Factors</h2><table><tr><th>Factor</th><th>Evidence</th><th class="num">Mark</th><th class="num">Weight</th></tr>';
    result.factors.forEach(function (f) { h += '<tr><td><b>' + f.label + '</b><br>' + esc(f.summary) + '</td><td>' + f.evidence + '</td><td class="num">' + (f.score == null ? 'n/a' : f.score) + '</td><td class="num">' + weights[f.key] + '</td></tr>'; });
    h += '</table><p class="rsmall">' + workingsHtml() + '</p>';
    var pl = result.factors.filter(function (f) { return f.key === 'planning'; })[0];
    if (pl && pl.list && pl.list.length) {
      h += '<h2>Nearest comparable schemes</h2><table><tr><th>Reference</th><th>Decision</th><th class="num">Homes</th><th class="num">Year</th><th class="num">Distance</th></tr>';
      pl.list.slice(0, 8).forEach(function (a) { h += '<tr><td>' + esc(a.ref) + '</td><td>' + DEC[a.dec] + '</td><td class="num">' + a.units + '</td><td class="num">' + a.year + '</td><td class="num">' + km(a.d) + '</td></tr>'; });
      h += '</table>';
    }
    h += '<h2>Sources</h2><p class="rsmall">' + Object.keys(meta.layers).map(function (k) { return esc(meta.layers[k].source) + ' (downloaded ' + meta.layers[k].fetched + ')'; }).join('. ') + '.</p>' +
      '<p class="rsmall"><b>Basis of this report.</b> A desktop screening from public data. Every mark, weight, cap and density assumption is a starting value to be agreed. It does not establish ownership, availability, site-level services or ground conditions, and it is no substitute for planning, engineering or legal advice. Zoning is the Department of Housing generalised version. The council development plan is the authority.</p>';
    $('report').innerHTML = h;
    setTimeout(function () { window.print(); }, 150);
  }

  // ---------- parcel and town blocks ----------
  function parcelHtml(pc) {
    var m = pc.m, o = pc.obj || {}, lost = [];
    if (m.floodPct) lost.push(m.floodPct + '% in a flood extent');
    if (m.protPct) lost.push(m.protPct + '% in a designated site');
    if (m.steepPct) lost.push(m.steepPct + '% steeper than 15%');
    if (m.usePct) lost.push(m.usePct + '% in use as a ' + esc(pc.use[1]));
    if (m.monPct) lost.push(m.monPct + '% within 30 m of a recorded monument');
    var extra = '';
    if (pc.mon && pc.mon[0]) extra += '<tr><td>Recorded monuments on the parcel</td><td class="num">' + pc.mon[0] + '<br><span class="dim">' + esc(pc.mon.slice(1).join(', ')) + '</span></td></tr>';
    if (pc.nat) extra += '<tr><td>Fronts a national road</td><td class="num">' + esc(pc.nat) + '</td></tr>';
    if (pc.state) extra += '<tr><td>State-owned</td><td class="num">' + esc(pc.state) + '</td></tr>';
    var status = pc.open ? 'Open land' : pc.use && pc.use[0] >= 30 ? pc.use[0] + '% in use as a ' + pc.use[1] : pc.cn ? 'Construction of ' + pc.cn.u + ' homes started ' + pc.cn.y : pc.nb + ' buildings' + (pc.nr > 2 ? ' and estate roads' : '') + ' on it';
    var planUrl = o.vol ? 'https://www.corkcoco.ie/sites/default/files/2022-06/' + o.vol + '.pdf#page=' + o.page : '';
    return '<div class="parcel"><b>Zoned parcel ' + esc(pc.id) + '</b>' +
      '<table class="mini"><tr><td>Gross area</td><td class="num">' + pc.ha.toFixed(2) + ' ha</td></tr>' +
      '<tr><td>Developable area' + (lost.length ? '<br><span class="dim">' + lost.join(', ') + '</span>' : '') + '</td><td class="num">' + m.netHa.toFixed(2) + ' ha (' + m.clearPct + '%)</td></tr>' +
      '<tr><td>Density' + (o.band ? '<br><span class="dim">' + esc(o.band) + ' in the county plan</span>' : '<br><span class="dim">No band stated for this site, assumed</span>') + '</td><td class="num">' + o.lo + ' to ' + o.hi + ' per ha</td></tr>' +
      '<tr><td><b>Capacity</b></td><td class="num"><b>' + m.homesLo + ' to ' + m.homesHi + ' homes</b></td></tr>' +
      '<tr><td>Status</td><td class="num">' + esc(status) + '</td></tr>' + extra + '</table>' +
      (o.text ? '<p class="dim"><b>' + esc(o.code) + ' in the plan:</b> ' + esc(o.text.replace(/([a-z])- ([a-z])/g, '$1$2')) + (planUrl ? ' <a href="' + planUrl + '" target="_blank" rel="noopener">Open the plan</a>' : '') + '</p>' : '') +
      '<p class="dim">Measured at ' + m.n + ' points across the parcel. Capacity = developable area × density.</p></div>';
  }
  function townHtml(t) {
    var warn = t.pct >= 100;
    return '<div class="parcel' + (warn ? ' warn' : '') + '"><b>' + esc(t.s) + ' housing target</b>' +
      '<table class="mini"><tr><td>Plan target, 2022 to 2028</td><td class="num">' + t.target.toLocaleString('en-IE') + ' homes</td></tr>' +
      '<tr><td>Homes started since 06/2022<br><span class="dim">Commencement notices within 3 km</span></td><td class="num">' + t.started.toLocaleString('en-IE') + ' (' + t.pct + '%)</td></tr></table>' +
      (warn ? '<p class="dim"><b>The target is already met on starts.</b> The council may treat further schemes as premature.</p>' : '') + '</div>';
  }

  // ---------- best open sites ----------
  function shortlist() {
    if (!cands) return [];
    return cands.filter(function (c) { return c.ha >= minHa && (!openOnly || c.open || (addStalled && c.cn && c.cn.stalled && c.built < 5)) && (!noPerm || !c.perm); })
      .map(function (c) { var t = totals(c); c.final = t.final; c.cap = t.cap; return c; })
      .filter(function (c) { return c.final > 0; })
      .sort(function (a, b) { return b.final - a.final || b.ha - a.ha; });
  }
  function candLayer() {
    if (!map.getLayer || !map.getLayer('cand-line') || !cands) return;
    var f = ['in', ['get', 'id'], ['literal', shortlist().map(function (c) { return c.id; })]];
    map.setFilter('cand-line', f); map.setFilter('cand-fill', f);
  }
  function renderBest() {
    var body = $('body');
    if (!cands) { body.innerHTML = '<div class="empty"><b>Ranking sites…</b>Scoring every large zoned parcel in Cork.</div>'; return; }
    var list = shortlist(), total = cands.filter(function (c) { return c.ha >= minHa; }).length;
    var h = '<div class="filters"><label>Minimum size <select id="minha">' + [0.25, 0.5, 1, 2, 5].map(function (v) { return '<option value="' + v + '"' + (v === minHa ? ' selected' : '') + '>' + v + ' ha</option>'; }).join('') + '</select></label>' +
      '<label><input type="checkbox" id="openonly"' + (openOnly ? ' checked' : '') + '> Open land only</label>' +
      '<label><input type="checkbox" id="noperm"' + (noPerm ? ' checked' : '') + '> Hide sites with a granted scheme</label>' +
      '<label><input type="checkbox" id="stalled"' + (addStalled ? ' checked' : '') + '> Add possibly stalled sites</label></div>' +
      '<p class="dim" style="font-size:12px;margin:0 0 6px">' + list.length + ' of ' + total + ' zoned and serviced parcels of this size pass. Ruled-out parcels are hidden. Showing the top ' + Math.min(list.length, 60) + '.</p>';
    list.slice(0, 60).forEach(function (c, i) {
      h += '<button class="site" data-i="' + i + '"><span class="rk">' + (i + 1) + '</span><span><b>' + esc(c.place || 'Cork') + ' · ' + c.m.homesLo + ' to ' + c.m.homesHi + ' homes</b><small>' + c.m.netHa.toFixed(2) + ' ha developable of ' + c.ha.toFixed(2) + ' · ' + esc(c.obj && c.obj.band ? c.obj.code + ', ' + c.obj.band + ' density' : (c.zone || c.z)) +
        (c.z === 'R2' ? ' · existing residential area, check it is not estate open space' : '') + (c.town && c.town.pct >= 100 ? ' · town target met' : '') + (c.mon && c.mon[0] ? ' · ' + c.mon[0] + ' monument' + (c.mon[0] > 1 ? 's' : '') : '') + (c.nat ? ' · fronts ' + esc(c.nat) : '') + (c.state ? ' · State-owned' : '') + (c.cn && c.cn.stalled ? ' · possibly stalled since ' + c.cn.y : '') + (c.open ? '' : (c.use && c.use[0] >= 30 ? ' · in use as a ' + esc(c.use[1]) : '') + ' · ' + c.nb + ' buildings' + (c.nr > 2 ? ', estate roads' : '') + (c.cn ? ', construction started ' + c.cn.y : '')) + (c.perm ? ' · scheme of about ' + c.perm.units + ' homes ' + (c.perm.unused ? 'granted' + (c.perm.granted ? ' ' + c.perm.granted : '') + ', not started' : 'applied for ' + c.perm.year + ', granted') : '') + (c.price ? ' · median sale ' + eur(c.price) : '') + (c.cap ? ' · capped at ' + c.cap.limit : '') + '</small></span><span class="sc" style="color:' + band(c.final) + '">' + c.final + '</span></button>';
    });
    if (!list.length) h += '<div class="empty">No parcels pass at this size.</div>';
    h += '<p class="dim" style="font-size:12px">Parcels are from the Residential Zoned Land Tax 2026 final map. Open land means at most one building, under 2% building cover, no estate road, no construction start on record and not in use as a pitch, park, school or similar, checked against two building datasets and the national commencement notices. A granted scheme on a parcel is noted because the land may already be spoken for. Capacity is the area clear of flood extents, designated sites and steep ground, multiplied by the county plan density band for the site, or 25 to 45 homes per hectare where no band is stated. Being listed does not mean the land is for sale.</p>';
    body.innerHTML = h;
    $('minha').addEventListener('change', function (e) { minHa = +e.target.value; candLayer(); render(); });
    $('openonly').addEventListener('change', function (e) { openOnly = e.target.checked; candLayer(); render(); });
    $('stalled').addEventListener('change', function (e) { addStalled = e.target.checked; candLayer(); render(); });
    $('noperm').addEventListener('change', function (e) { noPerm = e.target.checked; candLayer(); render(); });
    body.querySelectorAll('.site').forEach(function (b) { b.addEventListener('click', function () { var c = list[+b.dataset.i]; drop(c.rep[0], c.rep[1], true); }); });
  }
  function setView(v, quiet) {
    view = v;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === v); });
    if (!quiet) render();
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.v); }); });

  // ---------- saved sites and comparison ----------
  function saveSite() {
    if (!result || !result.inCork) return;
    var t = totals(), marks = {};
    result.factors.forEach(function (f) { marks[f.key] = f.score; });
    var name = result.place ? result.place.name : 'Site';
    var same = saved.filter(function (s) { return s.name.replace(/ \d+$/, '') === name; }).length;
    saved.push({ name: same ? name + ' ' + (same + 1) : name, p: result.p, final: t.final, ruled: !!(t.cap && t.cap.limit === 0), marks: marks, price: result.market && result.market.price ? result.market.price.value : null });
    if (saved.length > 4) saved.shift();
    store('sites', saved); render();
  }
  function savedHtml() {
    if (!saved.length) return '';
    var labels = result && result.factors ? result.factors.map(function (f) { return [f.key, f.label]; }) :
      [['zoning', 'Zoning'], ['flood', 'Flood'], ['waste', 'Wastewater'], ['supply', 'Water supply'], ['market', 'Market values'], ['protected', 'Protected sites'], ['access', 'Access and services'], ['planning', 'Comparable schemes']];
    var h = '<h2>Saved sites</h2><table class="cmp"><tr><th></th>' + saved.map(function (s, i) { return '<th><button data-go="' + i + '">' + esc(s.name) + '</button><br><button class="x" data-del="' + i + '">remove</button></th>'; }).join('') + '</tr>';
    h += '<tr class="total"><td>Score</td>' + saved.map(function (s) { return '<td style="color:' + band(s.final) + '">' + s.final + '</td>'; }).join('') + '</tr>';
    labels.forEach(function (l) { h += '<tr><td>' + l[1] + '</td>' + saved.map(function (s) { var v = s.marks[l[0]]; return '<td>' + (v == null ? '–' : v) + '</td>'; }).join('') + '</tr>'; });
    h += '<tr><td>Median sale price</td>' + saved.map(function (s) { return '<td>' + (s.price ? eur(s.price) : '–') + '</td>'; }).join('') + '</tr></table>';
    return h + '<p class="dim" style="font-size:12px">Scores are as saved, with the weights in use at the time. Up to four sites.</p>';
  }
  function bindSaved() {
    $('body').querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { var s = saved[+b.dataset.go]; drop(s.p[0], s.p[1], true); }); });
    $('body').querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { saved.splice(+b.dataset.del, 1); store('sites', saved); render(); }); });
  }

  // ---------- search ----------
  $('searchform').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('search').value.trim(), msg = $('searchmsg'); if (!q) return;
    msg.textContent = 'Searching…';
    fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ie&viewbox=-10.3,52.42,-7.8,51.35&bounded=1&q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.length) { msg.textContent = 'Nothing found in Cork for that search.'; return; }
        msg.textContent = ''; drop(+d[0].lon, +d[0].lat, true);
      }).catch(function () { msg.textContent = 'Search is unavailable. Click the map instead.'; });
  });

  // ---------- sources dialog ----------
  function sources() {
    var h = '<h3>Data and sources</h3><table><tr><th>Layer</th><th class="num">Records</th><th>Downloaded</th></tr>';
    Object.keys(meta.layers).forEach(function (k) {
      var l = meta.layers[k];
      h += '<tr><td><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.source) + '</a>' + (l.latest_received ? '<br><span class="dim">Applications received from ' + l.from + ' to ' + l.latest_received + '.</span>' : '') + '</td><td class="num">' + l.count.toLocaleString('en-IE') + '</td><td>' + l.fetched + '</td></tr>';
    });
    h += '</table><div id="bt"></div><p><b>How the score works.</b> Each factor gets a mark out of 100. The score is the weighted average of the marks, and you can change the weights. A pin inside a flood extent or a designated site is ruled out. Land that is already built on, or in use as a pitch, park, school, cemetery or similar, is capped at 15, land with no housing zoning or outside any settlement at 35, and a low probability flood extent caps the score at 60. Every mark, weight and cap is a starting assumption to be agreed, not a published standard.</p>' +
      '<p><b>Not covered.</b> Ownership, land asking prices, sewer and mains capacity at the site, electricity capacity, archaeology and ground conditions. Zoning is the Department\'s generalised version, and the council\'s development plan is the authority. Background map: OpenFreeMap, from OpenStreetMap data.</p>' +
      '<form method="dialog"><button class="btn">Close</button></form>';
    $('sources').innerHTML = h;
    fetch(dataUrl('backtest.json')).then(function (r) { return r.json(); }).then(function (b) {
      var t = '<p><b>Checked against real decisions.</b> The sites of ' + (b.granted + b.refused) + ' Cork housing schemes of 10 or more homes decided since 2016 (' + b.granted + ' granted, ' + b.refused + ' refused) were scored without the comparable-schemes factor. Run on ' + b.run + '.</p><table><tr><th>Score band</th><th class="num">Granted</th><th class="num">Refused</th><th class="num">Grant rate</th></tr>';
      b.bands.forEach(function (x) { t += '<tr><td>' + (x.to === 0 ? 'Ruled out (0)' : x.from + ' to ' + x.to) + '</td><td class="num">' + x.granted + '</td><td class="num">' + x.refused + '</td><td class="num">' + Math.round(100 * x.grantRate) + '%</td></tr>'; });
      t += '</table><p class="dim">Higher bands were granted more often, but the difference is modest. Developers mostly apply on sites that already look viable, and refusals often turn on design, which no map can see.</p>';
      var el = document.getElementById('bt'); if (el) el.innerHTML = t;
    }).catch(function () {});
  }
  $('srcbtn').addEventListener('click', function () { if (!$('sources').innerHTML) sources(); $('sources').showModal(); });

  window.__shortlist = shortlist;
  window.__runBacktest = function () { window.__backtest = null; worker.postMessage({ type: 'backtest', weights: WEIGHTS }); };
  render();
  var mm = /[?&]pin=(-?[\d.]+),(-?[\d.]+)/.exec(location.search);
  if (mm) { map.jumpTo({ center: [+mm[2], +mm[1]], zoom: 14.5 }); drop(+mm[2], +mm[1]); }
})();
