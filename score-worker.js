/* Scoring worker. Loads every dataset off the main thread and answers score requests,
   so the map never stalls while data loads or a pin is scored. */
'use strict';

// ---------- scoring assumptions (all starting values, none from a published standard) ----------
var ZONE_SCORE = { R1: 100, R3: 90, M1: 85, M2: 85, M3: 80, R2: 70, M4: 60, M5: 60, R4: 45, O1: 40, O2: 30 };
var ZONE_GROUP_SCORE = { C: 30, S: 20, N: 10, P: 10, G: 0 };
var UNZONED_SCORE = 5;
var VILLAGE_SCORE = 55;           // unzoned land inside a built-up settlement (county villages have a boundary but no zoning map)
var VILLAGE_MIN_BUILDINGS = 25, VILLAGE_RADIUS_M = 300;
var HOUSING_ZONES = { R1: 1, R2: 1, R3: 1, R4: 1, M1: 1, M2: 1, M3: 1, M4: 1, M5: 1, O1: 1 }; // zonings where housing is plausible
var WASTE_SCORE = { Green: 100, Amber: 50, Red: 0 };
var SUPPLY_SCORE = {
  'Capacity Available': 100,
  'Capacity Available - LoS improvement required': 75,
  'Potential Capacity Available - LoS improvement required': 45,
  'Capital Investment Required': 10
};
var SETTLEMENT_RADIUS_M = 5000;
var NO_SETTLEMENT_SCORE = 15;
var SCHEME_MIN_HOMES = 10;       // an application counts as a comparable scheme at this many homes
var SCHEME_RADIUS_M = 2000;      // comparable schemes are searched for within this distance
var SCHEME_MIN_DECISIONS = 3;    // fewer decided schemes than this gives a neutral 50
var ON_SITE_M = 150;             // a decided scheme this close is treated as being on the site
var ON_SITE_REFUSED_MAX = 20, ON_SITE_GRANTED_MIN = 90;
var MARKET_RADIUS_M = 6000;      // nearest settlement with sales data must be this close to be used
var RENT_RADIUS_M = 8000;        // beyond this the county rent is shown
var ACCESS = [ // key, label, full marks within (m), zero marks beyond (m)
  ['rail', 'Rail station', 1000, 10000],
  ['bus', 'Bus stop', 400, 2000],
  ['schools', 'School', 800, 5000],
  ['shops', 'Shop', 800, 5000],
  ['health', 'GP, pharmacy or hospital', 1000, 8000],
  ['junctions', 'Motorway junction', 3000, 20000]
];
// Caps applied after the weighted average. A cap of 0 rules the site out.
var CAP_RULED_OUT = 0, CAP_NO_HOUSING_ZONING = 35, CAP_LOW_FLOOD = 60, CAP_BUILT = 15;
var DENSITY_PER_HA = 35;         // homes per hectare used for the capacity estimate
var MONUMENT_AT_M = 30, MONUMENT_NEAR_M = 100, CAP_MONUMENT = 40;   // a recorded monument at the pin caps the score
var NATIONAL_ROAD_M = 40;         // a national road this close is flagged as an access question
var UNUSED_PERMISSION_M = 150;
var STEEP_PCT = 15;               // ground steeper than this (about 1 in 7) is not counted as developable
var TOWN_RADIUS_M = 3000;         // a site this close to a plan town is counted against that town's housing target
var OPEN_MAX_IN_USE_PCT = 30;      // a parcel with this share or more in another active use is not open land
var OPEN_MAX_BUILDINGS = 1, OPEN_MAX_COVER_PCT = 2, OPEN_MAX_ROAD_POINTS = 2;  // a parcel counts as open land below these

// ---------- geometry ----------
function bboxOf(g) {
  var b = [180, 90, -180, -90];
  (function walk(c) {
    if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; }
    else for (var i = 0; i < c.length; i++) walk(c[i]);
  })(g.coordinates);
  return b;
}
function inRing(p, r) {
  var x = p[0], y = p[1], inside = false;
  for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
    var xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPoly(p, c) {
  if (!inRing(p, c[0])) return false;
  for (var k = 1; k < c.length; k++) if (inRing(p, c[k])) return false;
  return true;
}
function inGeom(p, g) {
  if (g.type === 'Polygon') return inPoly(p, g.coordinates);
  if (g.type === 'MultiPolygon') { for (var i = 0; i < g.coordinates.length; i++) if (inPoly(p, g.coordinates[i])) return true; }
  return false;
}
function index(fc) { fc.features.forEach(function (f) { f._b = bboxOf(f.geometry); }); return fc.features; }
function hits(feats, p) {
  var out = [];
  for (var i = 0; i < feats.length; i++) { var f = feats[i], b = f._b; if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inGeom(p, f.geometry)) out.push(f); }
  return out;
}
function dist(a, b) {
  var R = 6371008.8, t = Math.PI / 180, dLat = (b[1] - a[1]) * t, dLon = (b[0] - a[0]) * t;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}
function ringAround(p, metres, n) {
  var out = [], dLat = metres / 111320, dLon = metres / (111320 * Math.cos(p[1] * Math.PI / 180));
  for (var i = 0; i < n; i++) { var a = 2 * Math.PI * i / n; out.push([p[0] + dLon * Math.cos(a), p[1] + dLat * Math.sin(a)]); }
  return out;
}
function nearest(rows, p, get) {
  var best = null, bd = Infinity;
  for (var i = 0; i < rows.length; i++) { var d = dist(p, get(rows[i])); if (d < bd) { bd = d; best = rows[i]; } }
  return best ? { item: best, d: bd } : null;
}
function km(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function link(url, text) { return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text) + '</a>' : esc(text); }
function self_id(r) { return r; }

var boundary = [], zoning = [], flood = [], prot = [], water = { waste: [], supply: [] }, pts = {}, planning = [], market = {}, towns = [], monuments = [], mgrid = {}, ngrid = {}, stateland = [], inuse = [], meta = { layers: {} };

// ---------- factors: each returns {score, summary, evidence, cap?} ----------
function zoneScore(code) {
  if (code in ZONE_SCORE) return ZONE_SCORE[code];
  var g = code.charAt(0);
  return g in ZONE_GROUP_SCORE ? ZONE_GROUP_SCORE[g] : UNZONED_SCORE;
}
function scoreZoning(p) {
  var h = hits(zoning, p);
  if (!h.length && countBuildings(p, VILLAGE_RADIUS_M) >= VILLAGE_MIN_BUILDINGS) return { score: VILLAGE_SCORE, summary: 'Unzoned, inside a settlement',
    evidence: 'No zoning polygon at this point, but ' + countBuildings(p, VILLAGE_RADIUS_M) + ' buildings stand within ' + VILLAGE_RADIUS_M + ' m, so the pin is treated as inside a settlement. Cork County villages have a development boundary but no zoning map, and housing is decided against the village objectives in the county plan. Check that the site is inside the boundary.' };
  if (!h.length) return { score: UNZONED_SCORE, summary: 'Not zoned', cap: [CAP_NO_HOUSING_ZONING, 'the land is not zoned'],
    evidence: 'No zoning polygon at this point. Land outside zoned settlement areas is generally not open to residential schemes. Check the development plan.' };
  h.sort(function (a, b) { return zoneScore(b.properties.g) - zoneScore(a.properties.g); });
  var z = h[0].properties;
  var ev = '<b>' + esc(z.g) + '</b> ' + esc(z.gd) + '. Council wording: ' + esc(z.o || 'not given') + '. ' + link(z.link, z.plan) + (z.to ? ', plan runs to ' + z.to : '') + '.';
  if (h.length > 1) ev += ' ' + (h.length - 1) + ' other zoning polygon(s) overlap here (' + h.slice(1).map(function (f) { return esc(f.properties.g); }).join(', ') + '). The highest scoring one is used.';
  var out = { score: zoneScore(z.g), summary: z.g + ' ' + z.gd, evidence: ev };
  if (!HOUSING_ZONES[z.g]) out.cap = [CAP_NO_HOUSING_ZONING, 'the zoning (' + z.g + ' ' + z.gd + ') does not provide for housing'];
  return out;
}
function scoreFlood(p) {
  var h = hits(flood, p), med = [], low = [];
  h.forEach(function (f) { (f.properties.prob === 'medium' ? med : low).push(f.properties.src); });
  if (med.length) return { score: 0, summary: 'Inside a flood extent', cap: [CAP_RULED_OUT, 'the pin is inside a mapped medium probability flood extent'],
    evidence: 'Pin is inside: ' + esc(med.join('; ')) + '.' };
  if (low.length) return { score: 40, summary: 'Inside a low probability extent', cap: [CAP_LOW_FLOOD, 'the pin is inside a mapped low probability flood extent'],
    evidence: 'Pin is inside a low probability extent only: ' + esc(low.join('; ')) + '.' };
  var near = ringAround(p, 100, 12).some(function (q) { return hits(flood, q).length > 0; });
  if (near) return { score: 70, summary: 'Extent within 100 m', evidence: 'Not inside a mapped extent, but one lies within about 100 m.' };
  return { score: 100, summary: 'Clear of mapped extents', evidence: 'Not inside or within about 100 m of a mapped river or coastal flood extent (current scenario). Surface water and groundwater flooding are not mapped here.' };
}
function scoreProtected(p) {
  var h = hits(prot, p);
  var names = function (a) { return a.map(function (f) { return link(f.properties.url, f.properties.name) + ' (' + esc(f.properties.tl) + ')'; }).join('; '); };
  var strong = h.filter(function (f) { return f.properties.t !== 'pnha'; });
  if (strong.length) return { score: 0, summary: 'Inside ' + strong[0].properties.name, cap: [CAP_RULED_OUT, 'the pin is inside a designated site (' + strong[0].properties.name + ')'],
    evidence: 'Pin is inside ' + names(strong) + '.' };
  if (h.length) return { score: 20, summary: 'Inside a proposed NHA', evidence: 'Pin is inside ' + names(h) + '.' };
  var seen = {}, nearby = [];
  ringAround(p, 500, 16).concat(ringAround(p, 250, 8)).forEach(function (q) { hits(prot, q).forEach(function (f) { var k = f.properties.code + f.properties.t; if (!seen[k]) { seen[k] = 1; nearby.push(f); } }); });
  if (nearby.length) return { score: 60, summary: 'Designated site within 500 m', evidence: 'Within about 500 m of ' + names(nearby) + '. Appropriate assessment screening is likely to matter.' };
  return { score: 100, summary: 'None within 500 m', evidence: 'No SAC, SPA, NHA or proposed NHA within about 500 m.' };
}
function scoreWaste(p) {
  var n = nearest(water.waste, p, function (r) { return r.ll; });
  if (!n) return { score: null, summary: 'No data', evidence: 'Register not loaded.' };
  var w = n.item, head = 'Nearest settlement on the register: ' + esc(w.s) + ', ' + km(n.d) + ' from the pin. Plant: ' + esc(w.plant) + ' (' + esc(w.reg) + '), rated <b>' + esc(w.status) + '</b>' + (w.project === 'Yes' ? ', project planned or under way' : '') + '. ' + link(w.url, 'Register') + '.';
  if (n.d > SETTLEMENT_RADIUS_M) return { score: NO_SETTLEMENT_SCORE, summary: 'No served settlement within 5 km', evidence: head + ' That is more than ' + km(SETTLEMENT_RADIUS_M) + ' away, so a public sewer connection is treated as unlikely.' };
  return { score: WASTE_SCORE[w.status] != null ? WASTE_SCORE[w.status] : null, summary: w.plant + ': ' + w.status, evidence: head + ' The register rates the treatment plant only, not the sewers.' };
}
function scoreSupply(p) {
  var n = nearest(water.supply, p, function (r) { return r.ll; });
  if (!n) return { score: null, summary: 'No data', evidence: 'Register not loaded.' };
  var w = n.item, head = 'Nearest settlement on the register: ' + esc(w.s) + ', ' + km(n.d) + ' from the pin. Water resource zone: ' + esc(w.wrz) + '. Rated <b>' + esc(w.status) + '</b>. ' + link(w.url, 'Register') + '.';
  if (n.d > SETTLEMENT_RADIUS_M) return { score: NO_SETTLEMENT_SCORE, summary: 'No served settlement within 5 km', evidence: head + ' That is more than ' + km(SETTLEMENT_RADIUS_M) + ' away.' };
  return { score: SUPPLY_SCORE[w.status] != null ? SUPPLY_SCORE[w.status] : null, summary: w.status.replace(' - LoS improvement required', ', improvement needed'), evidence: head };
}
function scoreAccess(p) {
  var rows = [], total = 0, count = 0;
  ACCESS.forEach(function (a) {
    var n = nearest(pts[a[0]] || [], p, self_id);
    if (!n) return;
    var s = n.d <= a[2] ? 100 : n.d >= a[3] ? 0 : Math.round(100 * (a[3] - n.d) / (a[3] - a[2]));
    total += s; count++;
    rows.push('<tr><td>' + esc(a[1]) + '</td><td>' + km(n.d) + (n.item[2] ? ' <span class="dim">' + esc(n.item[2]) + '</span>' : '') + '</td><td class="num">' + s + '</td></tr>');
  });
  if (!count) return { score: null, summary: 'No data', evidence: 'OpenStreetMap layer not loaded.' };
  var sub = nearest(pts.substations || [], p, self_id), score = Math.round(total / count);
  return { score: score, summary: score >= 70 ? 'Well served' : score >= 40 ? 'Partly served' : 'Remote',
    evidence: 'Straight-line distance to the nearest of each. The mark is the average of the ' + count + ' rows.<table class="mini">' + rows.join('') + '</table>' + (sub ? 'Nearest electricity substation (not scored): ' + km(sub.d) + '.' : '') };
}
function scorePlanning(p) {
  // Only housing schemes of SCHEME_MIN_HOMES or more count. Extensions and one-off houses say nothing about a large scheme.
  var dLat = SCHEME_RADIUS_M / 111320, dLon = dLat / Math.cos(p[1] * Math.PI / 180), near = [], small = 0;
  for (var i = 0; i < planning.length; i++) {
    var r = planning[i];
    if (Math.abs(r[1] - p[1]) > dLat || Math.abs(r[0] - p[0]) > dLon) continue;
    var d = dist(p, r);
    if (d > SCHEME_RADIUS_M) continue;
    if (r[5] >= SCHEME_MIN_HOMES) near.push({ r: r, d: d }); else if (d <= 500) small++;
  }
  near.sort(function (a, b) { return a.d - b.d; });
  var g = 0, rf = 0, homesGranted = 0, onSite = null;
  near.forEach(function (n) {
    if (n.r[3] === 'G') { g++; homesGranted += n.r[5]; } else if (n.r[3] === 'R') rf++;
    if (!onSite && n.d <= ON_SITE_M && (n.r[3] === 'G' || n.r[3] === 'R')) onSite = n;
  });
  var from = (meta.layers.planning || {}).from || 2016;
  var head = near.length + ' housing scheme application(s) of ' + SCHEME_MIN_HOMES + ' or more homes received since ' + from + ' within ' + km(SCHEME_RADIUS_M) + ': ' + g + ' granted, ' + rf + ' refused, ' + (near.length - g - rf) + ' other. About ' + homesGranted.toLocaleString('en-IE') + ' homes in the granted schemes (repeat applications on one site are counted each time).';
  var tail = ' ' + small + ' smaller application(s) within 500 m are ignored. Home counts are read from the description text and are approximate.';
  var list = near.slice(0, 15).map(function (n) { return { ref: n.r[2], dec: n.r[3], year: n.r[4], units: n.r[5], text: n.r[6], url: n.r[7], appeal: n.r[8], d: Math.round(n.d), ll: [n.r[0], n.r[1]] }; });
  var out = { list: list, total: near.length };
  if (g + rf < SCHEME_MIN_DECISIONS) { out.score = 50; out.summary = near.length ? 'Few comparable schemes nearby' : 'No comparable schemes nearby'; out.evidence = head + ' Fewer than ' + SCHEME_MIN_DECISIONS + ' decisions, so a neutral 50 is used.' + tail; }
  else { out.score = Math.round(100 * g / (g + rf)); out.summary = g + ' of ' + (g + rf) + ' schemes granted nearby'; out.evidence = head + ' The mark is the grant rate: ' + g + ' ÷ ' + (g + rf) + ' = ' + out.score + '.' + tail; }
  if (onSite) {
    var os = onSite.r, was = out.score;
    if (os[3] === 'R') { out.score = Math.min(out.score, ON_SITE_REFUSED_MAX); out.summary = 'Scheme refused at this site'; }
    else { out.score = Math.max(out.score, ON_SITE_GRANTED_MIN); out.summary = 'Scheme granted at this site'; }
    out.evidence = '<b>At or beside this site (' + km(onSite.d) + '):</b> ' + link(os[7], os[2]) + ', ' + os[4] + ', about ' + os[5] + ' homes, ' + (os[3] === 'R' ? 'refused' : 'granted') + '.' + (was !== out.score ? ' This moves the mark from ' + was + ' to ' + out.score + '.' : '') + ' ' + out.evidence;
  }
  return out;
}
function eur(n) { return '€' + Math.round(n).toLocaleString('en-IE'); }
function scoreMarket(p) {
  // Sale prices: nearest settlement with at least 10 recorded sales. Rents: nearest RTB location.
  var pr = nearest(market.prices || [], p, function (r) { return r.ll; });
  var located = (market.rents || []).filter(function (r) { return r.ll && !r.county; });
  var rn = nearest(located, p, function (r) { return r.ll; });
  var county = (market.rents || []).filter(function (r) { return r.county; })[0];
  var out = { score: null, summary: 'No sales data nearby', evidence: '', market: {} }, bits = [];
  if (pr && pr.d <= MARKET_RADIUS_M) {
    var m = pr.item;
    out.score = m.pct; out.summary = 'Median sale ' + eur(m.median) + ' in ' + m.s;
    out.market.price = { value: m.median, place: m.s, n: m.n, d: Math.round(pr.d) };
    bits.push('<b>' + esc(m.s) + '</b>, ' + km(pr.d) + ' from the pin: median sale price ' + eur(m.median) + ' across ' + m.n + ' sales from ' + market.sales_from + ' to ' + market.sales_to + '.' +
      (m.median_new ? ' New homes: ' + eur(m.median_new) + ' (' + m.n_new + ' sales, generally recorded excluding VAT).' : '') +
      (m.median_old ? ' Second-hand: ' + eur(m.median_old) + ' (' + m.n_old + ' sales).' : '') +
      ' That median is at or above ' + m.pct + '% of the ' + market.prices.length + ' Cork settlements with 10 or more sales, which is the mark. A higher mark means stronger sale values. It says nothing about land cost.');
  } else bits.push('No settlement with 10 or more recorded sales within ' + km(MARKET_RADIUS_M) + ', so this factor is not scored here.');
  var r = rn && rn.d <= RENT_RADIUS_M ? rn.item : county;
  if (r) {
    out.market.rent = { value: r.rent, place: r.s, prev: r.prev };
    bits.push('Average monthly rent, ' + esc(r.s) + ', ' + market.rent_quarter + ': ' + eur(r.rent) + (r.prev ? ' (' + eur(r.prev) + ' a year earlier, a change of ' + ((r.rent / r.prev - 1) * 100).toFixed(1) + '%)' : '') + '. Rent is shown for reference and is not in the mark.' + (r.county ? ' No RTB location within ' + km(RENT_RADIUS_M) + ', so the county figure is shown.' : ''));
  }
  out.evidence = bits.join(' ');
  return out;
}
var FACTORS = [['zoning', 'Zoning', scoreZoning], ['flood', 'Flood', scoreFlood], ['waste', 'Wastewater', scoreWaste], ['supply', 'Water supply', scoreSupply],
  ['market', 'Market values', scoreMarket], ['protected', 'Protected sites', scoreProtected], ['access', 'Access and services', scoreAccess], ['planning', 'Comparable schemes', scorePlanning]];

// ---------- what already stands on the land ----------
var bgrid = {}, BCELL = 0.004, candidates = [];
function indexBuildings(list) { list.forEach(function (b) { var k = Math.floor(b[0] / BCELL) + ',' + Math.floor(b[1] / BCELL); (bgrid[k] || (bgrid[k] = [])).push(b); }); }
function buildingsNear(p, metres) {
  var out = [], cx = Math.floor(p[0] / BCELL), cy = Math.floor(p[1] / BCELL);
  for (var i = cx - 1; i <= cx + 1; i++) for (var j = cy - 1; j <= cy + 1; j++) {
    var cell = bgrid[i + ',' + j]; if (!cell) continue;
    for (var k = 0; k < cell.length; k++) { var d = dist(p, cell[k]); if (d <= metres) out.push({ b: cell[k], d: d }); }
  }
  return out;
}
var starts = [], START_RADIUS_M = 120;   // a construction start this close to the pin means the site is taken
function countBuildings(p, metres) {
  var n = 0, cx = Math.floor(p[0] / BCELL), cy = Math.floor(p[1] / BCELL);
  for (var i = cx - 2; i <= cx + 2; i++) for (var j = cy - 1; j <= cy + 1; j++) {
    var cell = bgrid[i + ',' + j]; if (!cell) continue;
    for (var k = 0; k < cell.length; k++) if (dist(p, cell[k]) <= metres) n++;
  }
  return n;
}
function builtCheck(p) {
  var st = nearest(starts, p, function (s) { return s.geometry.coordinates; });
  if (st && st.d <= START_RADIUS_M) { var q = st.item.properties; return { built: true, why: 'construction of ' + q.u + ' homes started here in ' + q.y + (q.done ? ', with ' + q.done + ' certified complete' : '') + ' (commencement notice' + (q.ref ? ', planning ref ' + q.ref : '') + ')' }; }
  var near = buildingsNear(p, 60);
  var on = near.some(function (n) { return n.d < Math.sqrt(n.b[2] / Math.PI) + 8; });
  if (on) return { built: true, why: 'a building already stands at this point' };
  var use = hits(inuse, p)[0];
  if (use) return { built: true, why: 'the land is in use as a ' + use.properties.u + (use.properties.n ? ' (' + use.properties.n + ')' : '') + ', according to OpenStreetMap' };
  if (near.length >= 5) return { built: true, why: near.length + ' buildings stand within 60 m, so the land is already developed' };
  return { built: false, n: near.length };
}
function parcelInfo(q) {
  var o = q.obj || { lo: 25, hi: 45, band: '', text: '', code: '' };
  return { id: q.id, ha: q.ha, homes: Math.round(q.ha * (o.lo + o.hi) / 2), density: (o.lo + o.hi) / 2, obj: o, nb: q.nb, nr: q.nr || 0, built: q.built, zone: q.zo,
    mon: q.mon || [0], nat: q.nat || '', state: q.state || '', use: q.use || [0, ''], cn: q.cn || null, open: (q.use ? q.use[0] : 0) < OPEN_MAX_IN_USE_PCT && q.nb <= OPEN_MAX_BUILDINGS && q.built < OPEN_MAX_COVER_PCT && (q.nr || 0) <= OPEN_MAX_ROAD_POINTS && !q.cn };
}

// Measure a parcel across all its sample points: how much is flooded, protected or steep, and what is left.
function measureParcel(f) {
  var q = f.properties, ptsIn = q.pts && q.pts.length ? q.pts : [q.rep], wet = 0, lowWet = 0, prot_ = 0, steep = 0, monu = 0, used = 0, clear = 0, firstClear = null;
  ptsIn.forEach(function (s) {
    var fl = hits(flood, s), med = fl.some(function (h) { return h.properties.prob === 'medium'; });
    var pr = hits(prot, s).some(function (h) { return h.properties.t !== 'pnha'; });
    var st = s[2] != null && s[2] > STEEP_PCT, mo = !!s[3], us = !!s[4];
    if (us) used++;
    if (med) wet++; else if (fl.length) lowWet++;
    if (pr) prot_++;
    if (st) steep++;
    if (mo) monu++;
    if (!med && !pr && !st && !mo && !us) { clear++; if (!firstClear) firstClear = s; }
  });
  var n = ptsIn.length, o = q.obj || { lo: 25, hi: 45 }, share = clear / n, netHa = q.ha * share;
  var repBad = hits(flood, q.rep).some(function (h) { return h.properties.prob === 'medium'; }) || hits(prot, q.rep).some(function (h) { return h.properties.t !== 'pnha'; });
  return { n: n, floodPct: Math.round(100 * wet / n), lowFloodPct: Math.round(100 * lowWet / n), protPct: Math.round(100 * prot_ / n), steepPct: Math.round(100 * steep / n), monPct: Math.round(100 * monu / n), usePct: Math.round(100 * used / n),
    clearPct: Math.round(100 * share), netHa: Math.round(netHa * 100) / 100, homesLo: Math.round(netHa * o.lo), homesHi: Math.round(netHa * o.hi),
    homes: Math.round(netHa * (o.lo + o.hi) / 2), rep: repBad && firstClear ? [firstClear[0], firstClear[1]] : q.rep };
}
function gridNear(grid, p, metres) {
  var out = [], cx = Math.floor(p[0] / 0.004), cy = Math.floor(p[1] / 0.004);
  for (var i = cx - 1; i <= cx + 1; i++) for (var j = cy - 1; j <= cy + 1; j++) {
    var cell = grid[i + ',' + j]; if (!cell) continue;
    for (var k = 0; k < cell.length; k++) { var d = dist(p, cell[k]); if (d <= metres) out.push({ r: cell[k], d: d }); }
  }
  return out.sort(function (a, b) { return a.d - b.d; });
}
// Things a developer would check next. They are shown on the scorecard and are not part of the mark, except the monument cap.
function pinNotes(p, out) {
  var notes = [];
  var mons = gridNear(mgrid, p, MONUMENT_NEAR_M);
  if (mons.length) {
    var m = mons[0];
    notes.push('<b>Recorded monument ' + km(m.d) + ' away:</b> ' + esc(m.r[2]) + ' (' + esc(m.r[3]) + ')' + (mons.length > 1 ? ', and ' + (mons.length - 1) + ' more within ' + MONUMENT_NEAR_M + ' m' : '') + '. Works near a recorded monument need notice to the National Monuments Service and usually an archaeological assessment.');
    if (m.d <= MONUMENT_AT_M) out.caps.push({ limit: CAP_MONUMENT, why: 'a recorded monument (' + m.r[2] + ') stands at this point', key: 'monument' });
  }
  var nat = gridNear(ngrid, p, NATIONAL_ROAD_M);
  if (nat.length) notes.push('<b>National road ' + esc(nat[0].r[2]) + ' is ' + km(nat[0].d) + ' away.</b> New accesses onto national roads are generally resisted, so check for another way in.');
  var sl = hits(stateland, p)[0];
  if (sl) notes.push('<b>State-owned land:</b> ' + esc(sl.properties.owner || 'State body') + (sl.properties.name ? ', ' + esc(sl.properties.name) : '') + ' (State lands register).');
  var st = nearest(starts, p, function (s) { return s.geometry.coordinates; });
  if (st && st.d <= START_RADIUS_M && st.item.properties.stalled) notes.push('<b>Possibly stalled:</b> the start notice here dates from ' + st.item.properties.y + ' and no homes are certified complete. The site may be available.');
  var un = null;
  planning.forEach(function (r) { if (r[10] === 1 && Math.abs(r[1] - p[1]) < 0.002 && Math.abs(r[0] - p[0]) < 0.003) { var d = dist(p, r); if (d <= UNUSED_PERMISSION_M && (!un || r[4] > un.r[4])) un = { r: r, d: d }; } });
  if (un) notes.push('<b>Unused permission ' + km(un.d) + ' away:</b> ' + link(un.r[7], un.r[2]) + ', about ' + un.r[5] + ' homes' + (un.r[9] ? ', granted ' + un.r[9] : '') + ', with no construction start on record. The land may be spoken for, or the owner may be open to selling with permission in place.');
  return notes;
}
function townFor(p) {
  var t = nearest(towns, p, function (r) { return r.ll; });
  if (!t || t.d > TOWN_RADIUS_M) return null;
  return { s: t.item.s, target: t.item.target, started: t.item.started, pct: t.item.target ? Math.round(100 * t.item.started / t.item.target) : null, d: Math.round(t.d) };
}

function score(p, forParcel) {
  if (!hits(boundary, p).length) return { inCork: false };
  var out = { inCork: true, factors: [], caps: [] };
  FACTORS.forEach(function (f) {
    var r = f[2](p); r.key = f[0]; r.label = f[1];
    if (r.market) { out.market = r.market; delete r.market; }
    if (r.cap) out.caps.push({ limit: r.cap[0], why: r.cap[1], key: f[0] });
    delete r.cap;
    out.factors.push(r);
  });
  var pl = nearest(pts.places || [], p, self_id);
  out.place = pl ? { name: pl.item[2], d: Math.round(pl.d) } : null;
  out.town = townFor(p);
  if (!forParcel) {
    var bc = builtCheck(p);
    if (bc.built) out.caps.push({ limit: CAP_BUILT, why: bc.why, key: 'built' });
    var ph = hits(candidates, p)[0];
    if (ph) { out.parcel = parcelInfo(ph.properties); out.parcel.m = measureParcel(ph); }
    out.notes = pinNotes(p, out);
    if (!bc.built && out.parcel && out.parcel.cn) out.caps.push({ limit: CAP_BUILT, why: 'construction of ' + out.parcel.cn.u + ' homes started on this parcel in ' + out.parcel.cn.y + ' (commencement notice)', key: 'built' });
  }
  return out;
}

// Score every candidate parcel once the data is in, so the page can list the best open sites.
function rankCandidates() {
  var rows = [], schemes = planning.filter(function (r) { return r[5] >= SCHEME_MIN_HOMES && r[3] === 'G'; });
  candidates.forEach(function (f) {
    var q = f.properties, m = measureParcel(f);
    var r = score(m.rep, true); if (!r.inCork) return;
    // the parcel as a whole decides flood and protected-site caps, not the single scoring point
    r.caps = r.caps.filter(function (c) { return c.key !== 'flood' && c.key !== 'protected'; });
    if (m.clearPct < 25) r.caps.push({ limit: CAP_RULED_OUT, why: 'only ' + m.clearPct + '% of the parcel is clear of flood extents, designated sites and steep ground', key: 'net' });
    var info = parcelInfo(q);
    info.m = m; info.rep = m.rep; info.z = q.z; info.la = q.la; info.place = r.place ? r.place.name : ''; info.town = r.town;
    info.homes = m.homes;
    info.factors = r.factors.map(function (x) { return { key: x.key, score: x.score }; });
    // a housing scheme already granted inside the parcel: the land may be spoken for
    var b = f._b, perm = null;
    schemes.forEach(function (s) { if (s[0] >= b[0] && s[0] <= b[2] && s[1] >= b[1] && s[1] <= b[3] && inGeom(s, f.geometry) && (!perm || s[4] > perm[4])) perm = s; });
    if (perm) info.perm = { ref: perm[2], year: perm[4], units: perm[5], granted: perm[9] || '', unused: perm[10] === 1 };
    info.caps = r.caps; info.price = r.market && r.market.price ? r.market.price.value : null;
    rows.push(info);
  });
  postMessage({ type: 'candidates', rows: rows });
}

// Back-test: score the site of every decided housing scheme and compare granted with refused.
// The comparable-schemes factor and the built-on check are left out, because both would use the outcome itself.
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  var all = pos.map(function (v) { return [v, 1]; }).concat(neg.map(function (v) { return [v, 0]; })).sort(function (a, b) { return a[0] - b[0]; });
  var rankSum = 0, i = 0;
  while (i < all.length) { var j = i; while (j < all.length && all[j][0] === all[i][0]) j++; var rk = (i + j + 1) / 2; for (var k = i; k < j; k++) if (all[k][1]) rankSum += rk; i = j; }
  return (rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
function backtest(weights) {
  var seen = {}, sites = [];
  planning.forEach(function (r) {
    if (r[5] < SCHEME_MIN_HOMES || (r[3] !== 'G' && r[3] !== 'R')) return;
    var k = r[0].toFixed(3) + ',' + r[1].toFixed(3) + r[3];        // one entry per site and outcome (about 100 m)
    if (seen[k]) return; seen[k] = 1; sites.push(r);
  });
  var keys = FACTORS.map(function (f) { return f[0]; }).filter(function (k) { return k !== 'planning'; });
  var G = { overall: [] }, R = { overall: [] }, capG = { out: 0, capped: 0 }, capR = { out: 0, capped: 0 };
  keys.forEach(function (k) { G[k] = []; R[k] = []; });
  sites.forEach(function (r) {
    var p = [r[0], r[1]], sc = {}, caps = [], sumW = 0, sumWS = 0;
    FACTORS.forEach(function (f) { if (f[0] === 'planning') return; var x = f[2](p); sc[f[0]] = x.score; if (x.cap) caps.push(x.cap[0]); });
    keys.forEach(function (k) { if (sc[k] != null) { sumW += weights[k]; sumWS += weights[k] * sc[k]; } });
    var avg = sumW ? sumWS / sumW : 0, lim = caps.length ? Math.min.apply(null, caps) : 100, fin = Math.min(avg, lim);
    var T = r[3] === 'G' ? G : R, C = r[3] === 'G' ? capG : capR;
    T.overall.push(fin); keys.forEach(function (k) { if (sc[k] != null) T[k].push(sc[k]); });
    if (lim === 0) C.out++; else if (lim < avg) C.capped++;
  });
  var out = { granted: G.overall.length, refused: R.overall.length, rows: [], ruledOut: { granted: capG.out, refused: capR.out }, capped: { granted: capG.capped, refused: capR.capped } };
  ['overall'].concat(keys).forEach(function (k) { out.rows.push({ key: k, meanGranted: mean(G[k]), meanRefused: mean(R[k]), auc: auc(G[k], R[k]) }); });
  var bands = [[0, 0], [1, 49], [50, 74], [75, 100]];
  out.bands = bands.map(function (b) {
    var g = G.overall.filter(function (v) { var x = Math.round(v); return x >= b[0] && x <= b[1]; }).length, r = R.overall.filter(function (v) { var x = Math.round(v); return x >= b[0] && x <= b[1]; }).length;
    return { from: b[0], to: b[1], granted: g, refused: r, grantRate: g + r ? g / (g + r) : null };
  });
  return out;
}

// ---------- loading ----------
var URLS = self.location.hash ? JSON.parse(decodeURIComponent(self.location.hash.slice(1))) : {};
function get(name) { return fetch(URLS[name] || 'data/app/' + name).then(function (r) { if (!r.ok) throw new Error(name + ' ' + r.status); return r.json(); }); }
var steps = [
  ['meta.json', function (d) { meta = d; }],
  ['boundary.geojson', function (d) { boundary = index(d); }],
  ['water.json', function (d) { water = d; }],
  ['points.json', function (d) { pts = d; }],
  ['market.json', function (d) { market = d; }],
  ['towns.json', function (d) { towns = d.towns || []; }],
  ['monuments.geojson', function (d) { d.features.forEach(function (f) { var c = f.geometry.coordinates, m = [c[0], c[1], f.properties.c, f.properties.s]; var k = Math.floor(c[0] / 0.004) + ',' + Math.floor(c[1] / 0.004); (mgrid[k] || (mgrid[k] = [])).push(m); }); }],
  ['nroads.json', function (d) { d.forEach(function (r) { var k = Math.floor(r[0] / 0.004) + ',' + Math.floor(r[1] / 0.004); (ngrid[k] || (ngrid[k] = [])).push(r); }); }],
  ['stateland.geojson', function (d) { stateland = index(d); }],
  ['inuse.geojson', function (d) { inuse = index(d); }],
  ['zoning.geojson', function (d) { zoning = index(d); }],
  ['protected.geojson', function (d) { prot = index(d); }],
  ['flood.geojson', function (d) { flood = index(d); }],
  ['buildings.json', function (d) { indexBuildings(d); }],
  ['starts.geojson', function (d) { starts = d.features; }],
  ['candidates.geojson', function (d) { candidates = index(d); }],
  ['planning.geojson', function (d) { planning = d.features.map(function (f) { var q = f.properties; return [f.geometry.coordinates[0], f.geometry.coordinates[1], q.r, q.d, q.y, q.u, q.t, q.l, q.a, q.g, q.ns]; }); }]
];
var done = 0, ready = false, queue = [];
Promise.all(steps.map(function (s) {
  return get(s[0]).then(function (d) { s[1](d); done++; postMessage({ type: 'progress', done: done, total: steps.length }); });
})).then(function () {
  ready = true;
  postMessage({ type: 'ready', meta: meta });
  queue.forEach(answer); queue = [];
  rankCandidates();
}).catch(function (e) { postMessage({ type: 'error', message: String(e) }); });

function answer(m) { var r = score(m.p); r.type = 'result'; r.id = m.id; r.p = m.p; postMessage(r); }
onmessage = function (e) {
  if (e.data.type === 'score') { ready ? answer(e.data) : queue.push(e.data); }
  if (e.data.type === 'backtest') { var b = backtest(e.data.weights); b.type = 'backtest'; postMessage(b); }
};
