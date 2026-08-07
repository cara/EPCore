/* =====================================================================
 *  epmap.js — pure color-mapping, windowing & activation-animation math.
 *  No DOM, no Three.js. Imported by viewer.html; unit-tested under Node.
 * ===================================================================== */

// Rhythmia / EAM color ramps. Stops: [t (0..1), [r,g,b] (0..255)].
export const LUTS = {
  rhythmia_voltage: [
    [0.00, [220,   0,   0]],
    [0.15, [255, 100,   0]],
    [0.30, [255, 200,   0]],
    [0.50, [  0, 200,  50]],
    [0.70, [  0, 100, 255]],
    [1.00, [180,   0, 180]],
  ],
  rhythmia_lat: [
    [0.00, [255,   0,   0]],
    [0.25, [255, 165,   0]],
    [0.50, [255, 255,   0]],
    [0.75, [  0, 200, 255]],
    [1.00, [180,   0, 180]],
  ],
  jet: [
    [0.00, [0, 0, 131]], [0.125,[0,60,170]], [0.375,[5,255,255]],
    [0.625,[255,255,0]], [0.875,[255,0,0]], [1.00,[128,0,0]],
  ],
  turbo: [
    [0.00,[48,18,59]], [0.25,[31,180,229]], [0.5,[164,252,60]],
    [0.75,[249,123,35]], [1.00,[122,4,3]],
  ],
};

export const UNMAPPED = [128, 128, 128];

// sRGB(0..255) -> linear float, so vertex colors look right under physical lights.
export function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

export function buildLUT(stops, n = 256) {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let a = stops[0], b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    }
    const span = (b[0] - a[0]) || 1;
    const f = Math.min(1, Math.max(0, (t - a[0]) / span));
    out[i * 3]     = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
    out[i * 3 + 1] = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
    out[i * 3 + 2] = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
  }
  return out;
}

const _lutCache = {}, _linCache = {};
export function lut(name) { return _lutCache[name] || (_lutCache[name] = buildLUT(LUTS[name])); }

// Precomputed sRGB->linear LUT (256*3 Float32). The pow runs 256x at build time,
// never per-vertex-per-frame -> the animation recolor stays cheap (perf option A).
export function linLut(name) {
  if (_linCache[name]) return _linCache[name];
  const u8 = lut(name);
  const out = new Float32Array(256 * 3);
  for (let i = 0; i < 256 * 3; i++) out[i] = srgbToLinear(u8[i]);
  return (_linCache[name] = out);
}

export function dataRange(arr) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (Number.isNaN(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  return [lo, hi];
}

// Clamp a [vmin,vmax] window into [lo,hi] with a minimum gap (eps). Swaps if inverted.
export function clampWindow(vmin, vmax, lo, hi, eps = 1e-6) {
  if (vmax < vmin) { const t = vmin; vmin = vmax; vmax = t; }
  vmin = Math.max(lo, Math.min(vmin, hi));
  vmax = Math.max(lo, Math.min(vmax, hi));
  if (vmax - vmin < eps) {
    vmax = Math.min(hi, vmin + eps);
    vmin = Math.max(lo, vmax - eps);   // pull vmin back when vmax is pinned at hi
  }
  return { vmin, vmax };
}

/* --- the window slider's scale -------------------------------------------
 *
 * Voltage is read at the bottom of its range. Scar is under 0.5 mV, healthy
 * tissue over 1.5, and the data goes to 8 — on a linear slider the whole
 * decision lives in the first fifth of the track and one pixel is 40 µV. The
 * position is therefore raised to a power: the low end gets most of the travel
 * and the top keeps its reach.
 *
 * Time does not work that way. An activation map spans 0-300 ms and every
 * millisecond is worth the same, so LAT stays linear — a curved time axis
 * would make the middle of a wavefront jump.
 */
const WINDOW_CURVE = 2.6;

/** How the slider is scaled for this field: 1 is linear, higher bends it. */
export function windowCurve(field) {
  const f = (field || '').toLowerCase();
  return (f === 'lat' || f === 'activation') ? 1 : WINDOW_CURVE;
}

/** Slider position (0..1) -> value. */
export function positionToValue(position, lo, hi, curve = 1) {
  const t = position < 0 ? 0 : position > 1 ? 1 : position;
  return lo + (hi - lo) * Math.pow(t, curve);
}

/** Value -> slider position (0..1). The inverse, so a value set by a preset or
 *  typed into the field puts the handle where it belongs. */
export function valueToPosition(value, lo, hi, curve = 1) {
  if (hi <= lo) return 0;
  const t = (value - lo) / (hi - lo);
  return Math.pow(t < 0 ? 0 : t > 1 ? 1 : t, 1 / curve);
}

/** Ein runder Schritt in der Nähe von `raw`: 1, 2 oder 5 mal eine Zehnerpotenz. */
function niceStep(raw) {
  const decade = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const mantissa = Math.abs(raw) / decade;
  const rounded = mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10;
  return rounded * decade;
}

/** Marken auf einer geraden Achse — auch über die Null hinweg. */
function linearTicks(lo, hi, wanted) {
  // Divided by `wanted`, not `wanted - 1`: the round step is always at least
  // as coarse as asked for, so dividing by the smaller number leaves three
  // marks where five were wanted.
  const step = niceStep((hi - lo) / Math.max(1, wanted));
  const out = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi + step * 1e-9; value += step) {
    // Der Schritt ist rund, die Summe nach zehn Additionen nicht mehr ganz.
    out.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return out;
}

/** Values worth labelling under the slider, in the field's own units.
 *
 * Two scales, two kinds of mark. A straight axis gets a round step laid across
 * it, and that has to survive crossing zero: an activation window runs from
 * -120 to 150 ms, and a decade-based scheme produced "1e-12" there and no
 * negative marks at all. A curved axis gets the 1/2/3/5 decades inside its
 * range instead — evenly spaced numbers would bunch at the top, where the
 * curve has almost no travel — thinned to the ones nearest to evenly spaced
 * *positions*.
 */
export function windowTicks(lo, hi, curve = 1, wanted = 5) {
  if (!(hi > lo)) return [];
  if (curve === 1 || lo <= 0) return linearTicks(lo, hi, wanted);

  // The floor is measured along the track, not along the values: on a curved
  // scale 0.05 mV is a fifth of the way up and worth a label.
  const floor = Math.max(positionToValue(0.02, lo, hi, curve), 1e-12);
  const candidates = [];
  for (let decade = Math.floor(Math.log10(floor)); decade <= Math.ceil(Math.log10(hi)); decade++) {
    for (const mantissa of [1, 2, 3, 5]) {
      const value = mantissa * Math.pow(10, decade);
      if (value >= floor && value <= hi) candidates.push(value);
    }
  }
  if (candidates.length <= wanted) return candidates.sort((a, b) => a - b);

  const chosen = [];
  for (let i = 0; i < wanted; i++) {
    const target = positionToValue(i / (wanted - 1), lo, hi, curve);
    const nearest = candidates.reduce(
      (best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best);
    if (!chosen.includes(nearest)) chosen.push(nearest);
  }
  return chosen.sort((a, b) => a - b);
}

// Preset windows per field type. {label, lo, hi}; lo/hi === null means "Auto" (data range).
export function voltagePresets(field) {
  const f = (field || '').toLowerCase();
  const auto = { label: 'Auto', lo: null, hi: null };
  if (f === 'voltage') return [{ label: 'Atrial 0.05/0.5', lo: 0.05, hi: 0.5 }, { label: 'Ventr. 0.5/1.5', lo: 0.5, hi: 1.5 }, { label: 'Voll 0.01/20', lo: 0.01, hi: 20 }, auto];
  if (f === 'unipolar') return [{ label: '0.3 / 8.3', lo: 0.3, hi: 8.3 }, auto];
  return [auto];
}

export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  let t = (x - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function linearDistance(L, t) { return Math.abs(L - t); }

// Distance on a cyclic window of length W (for seamless re-entry wrap).
export function cyclicDistance(L, t, W) {
  if (!(W > 0)) return Math.abs(L - t);
  const d = Math.abs(L - t) % W;
  return Math.min(d, W - d);
}

// Wavefront highlight [0..1] for a vertex with LAT L at cursor t. Peak 1 at the
// front (d=0), 0 at band/2 away. NaN L -> 0 (unmapped vertices never light up).
export function highlightFactor(L, t, W, band, mode) {
  if (Number.isNaN(L)) return 0;
  const d = mode === 'loop' ? cyclicDistance(L, t, W) : linearDistance(L, t);
  return 1 - smoothstep(0, band / 2, d);
}

// Advance the playback cursor by dt seconds at `speed` LAT-units/second.
// loop: wraps within [t0,t1]. linear: clamps and resets to t0 at the end.
export function advanceCursor(t, t0, t1, dt, speed, mode) {
  const W = t1 - t0;
  let nt = t + dt * speed;
  if (mode === 'loop') {
    if (W <= 0) return t0;
    nt = t0 + (((nt - t0) % W) + W) % W;   // wrap, tolerant of negatives
  } else {
    if (nt >= t1 || nt < t0) nt = t0;       // linear restart
  }
  return nt;
}

// clamp to [0,1]
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// orbit azimuth (radians) for `turns` seamless revolutions at the given progress.
export function orbitAzimuth(progress, turns = 1) { return 2 * Math.PI * progress * turns; }

// activation cursor time at the given progress over window [t0,t1].
// loop: wraps cyclically `cycles` times (seamless — progress 1 maps to t0).
// linear: one sweep t0 -> t1 (cycles ignored).
export function activationCursor(progress, t0, t1, mode, cycles = 1) {
  const W = t1 - t0;
  const p = clamp01(progress);
  if (mode === 'loop') { const phase = (p * cycles) % 1; return t0 + W * phase; }
  return t0 + W * p;
}

// Parse an EAM hex color ("#ff00ff", "#ffb223ff", "#abc", "#ff") to [r,g,b] 0..255.
// Alpha (8-nybble) ignored; 2-nybble -> grey. Returns null if unparseable.
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');  // #abc->aabbcc, #abcd->aabbccdd
  else if (h.length === 2) h = h + h + h;                                          // #ff -> ffffff (grey)
  if (h.length < 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Tag-marker sphere radius as a fraction of the mesh radius, clamped to [0.4, 3].
export function tagMarkerRadius(meshRadius) {
  const r = meshRadius * 0.012;
  return r < 0.4 ? 0.4 : r > 3 ? 3 : r;
}

// Parse "x y z" -> [x,y,z] (tolerant of extra whitespace). null if <3 finite numbers.
export function parseXyz(str) {
  if (typeof str !== 'string') return null;
  const n = str.trim().split(/\s+/).map(Number);
  if (n.length < 3 || !Number.isFinite(n[0]) || !Number.isFinite(n[1]) || !Number.isFinite(n[2])) return null;
  return [n[0], n[1], n[2]];
}

// Default marker color [r,g,b] 0..255 per category.
/* Marker colours. Ablation is a dark wine red rather than the bright red it
 * was: the voltage scale ends in bright red at its low end, so ablation
 * markers on a voltage map were the same colour as the scar they sit on. A
 * marker has to be readable as a marker before it is readable as red. */
export function tagCategoryColor(cat) {
  switch (String(cat == null ? '' : cat).toLowerCase()) {
    case 'ablation': return [122, 24, 44];
    case 'annotation': return [240, 180, 40];
    case 'landmark': return [60, 200, 220];
    // Messpunkte sind keine Aussage, sondern das Rohmaterial der Karte: gedeckt,
    // damit sie die Farbskala darunter nicht überstimmen.
    case 'measurement': return [150, 160, 175];
    default: return [180, 180, 180];
  }
}

/** Farbe für einen Impedanzabfall: von „kaum gefallen" nach „deutlich".
 *
 * Eine Reihe im selben Farbton statt eines Ampelverlaufs. Ablationsstellen sind
 * weinrot — das ist ihre Farbe, und wer sie nach dem Abfall einfärbt, will
 * unterscheiden können, ohne dass die Marker zu etwas anderem werden. Blass
 * heißt wenig gefallen, das bekannte Weinrot heißt deutlich.
 *
 * Grün-Rot wäre außerdem eine Bewertung („gut/schlecht"), und die trifft der
 * Export nicht: ein kleiner Abfall kann Kontakt oder Gewebe oder Leistung
 * gewesen sein.
 *
 * `full` ist der Abfall, ab dem nicht weiter eingefärbt wird — 15 Ω lokale
 * Impedanz ist die Größenordnung, die in der gemessenen Studie an einer Stelle
 * mit Wirkung stand (146,5 → 130,6 Ω). Eine Darstellungsschwelle, kein Urteil
 * über die Läsion. Ohne Messwert bleibt der Punkt grau, statt eine Null zu
 * zeigen, die wie ein Befund aussähe.
 */
export const DROP_FULL_OHM = 15.0;

export function impedanceDropColor(ohm, full = DROP_FULL_OHM) {
  if (!Number.isFinite(ohm)) return [150, 150, 150];
  const t = Math.max(0, Math.min(1, ohm / (full > 0 ? full : 1)));
  // Blassrot → Weinrot, dieselbe Farbe wie ein gewöhnlicher Ablationsmarker.
  const pale = [236, 176, 168], wine = tagCategoryColor('ablation');
  return [0, 1, 2].map(i => Math.round(pale[i] + (wine[i] - pale[i]) * t));
}

// base64 of a UTF-8 string (works in Node and the browser — both have btoa/atob + TextEncoder).
export function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function b64decodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// A label is "identifying" if it looks like a time, date, or long digit run (epoch / id).
export function isIdentifyingLabel(s) {
  if (typeof s !== 'string') return false;
  return /\d{1,2}:\d{2}(:\d{2})?/.test(s)              // time 15:53(:59)
      || /\d{4}[-_/.]\d{1,2}[-_/.]\d{1,2}/.test(s)     // 2026-03-04
      || /\d{1,2}[-_/.]\d{1,2}[-_/.]\d{2,4}/.test(s)   // 04.03.2026
      || /\d{9,}/.test(s);                             // epoch / long id
}

// Replace identifying tag labels with generic ones; keep positions, color, category, clean labels.
export function scrubTagGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map(g => {
    const abl = (g.category || '').toLowerCase() === 'ablation';
    const glabel = isIdentifyingLabel(g.label) ? (abl ? 'Ablation' : 'Annotation') : g.label;
    const points = Array.isArray(g.points) ? g.points.map((p, i) => ({
      position: p.position,
      label: isIdentifyingLabel(p.label) ? (abl ? 'Abl ' + (i + 1) : 'P ' + (i + 1)) : p.label,
    })) : [];
    return { label: glabel, category: g.category, color: g.color, points };  // id intentionally dropped — it can mirror an unscrubbed label/GUID
  });
}

// "EPVIEW_TAGS <base64(JSON of scrubbed groups)>" header-comment payload (scrubs internally).
export function encodeTagComment(groups) {
  return 'EPVIEW_TAGS ' + b64encodeUtf8(JSON.stringify(scrubTagGroups(groups)));
}
// Decode an "EPVIEW_TAGS <b64>" comment back to groups; null on anything unexpected.
export function decodeTagComment(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^EPVIEW_TAGS\s+(\S+)/);
  if (!m) return null;
  try { const g = JSON.parse(b64decodeUtf8(m[1])); return Array.isArray(g) ? g : null; }
  catch { return null; }
}

// Area of a triangle from its 9 vertex coordinates = 0.5 * |(b-a) x (c-a)|.
export function triangleArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(x * x + y * y + z * z);
}

// Bucket total mesh surface area by a per-vertex scalar against [lo, hi].
// Per-face value = mean of its 3 vertex scalars; any NaN vertex -> face counted as 'unmapped'.
// Returns areas in the same units as positions^2 (mm^2). scar=v<lo, border=lo<=v<=hi, healthy=v>hi.
export function areaByThreshold(positions, faces, scalar, lo, hi) {
  let total = 0, scar = 0, border = 0, healthy = 0, unmapped = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const i = faces[f], j = faces[f + 1], k = faces[f + 2];
    const A = triangleArea(
      positions[i*3], positions[i*3+1], positions[i*3+2],
      positions[j*3], positions[j*3+1], positions[j*3+2],
      positions[k*3], positions[k*3+1], positions[k*3+2]);
    total += A;
    const a = scalar ? scalar[i] : NaN, b = scalar ? scalar[j] : NaN, c = scalar ? scalar[k] : NaN;
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) { unmapped += A; continue; }
    const v = (a + b + c) / 3;
    if (v < lo) scar += A;
    else if (v <= hi) border += A;
    else healthy += A;
  }
  return { total, scar, border, healthy, unmapped };
}

// Smoothstep easing, clamped to [0,1]. 0->0, 1->1, 0.5->0.5.
export function ease(p) { const t = p < 0 ? 0 : p > 1 ? 1 : p; return t * t * (3 - 2 * t); }

// Camera azimuth + pitch (radians) for a recorded path at progress p.
// theta0 = starting azimuth, basePitch = starting elevation.
//   turntable: 360deg around vertical at the current pitch
//   tilt:      360deg at a fixed ~20deg cinematic pitch
//   rock:      pendulum +-30deg around theta0 (returns to start -> seamless)
export function orbitPath(name, p, theta0, basePitch = 0) {
  const TWO_PI = 2 * Math.PI;
  if (name === 'tilt') return { az: theta0 + TWO_PI * p, pitch: 0.35 };
  if (name === 'rock') return { az: theta0 + (Math.PI / 6) * Math.sin(TWO_PI * p), pitch: basePitch };
  return { az: theta0 + TWO_PI * p, pitch: basePitch };  // turntable (default)
}

// Centroid [cx,cy,cz] of a positions Float32Array (n*3).
export function meshCentroid(positions) {
  const n = positions.length / 3; if (!n) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < positions.length; i += 3) { x += positions[i]; y += positions[i+1]; z += positions[i+2]; }
  return [x / n, y / n, z / n];
}
// Squared distance from a point to the nearest vertex of a mesh. Stride-sampled
// when the mesh is large (caps at ~512 sampled vertices) so cost stays O(1) per query.
function minSqDistToMeshVerts(positions, px, py, pz) {
  const nv = positions.length / 3;
  if (!nv) return Infinity;
  const stride = Math.max(1, Math.floor(nv / 512));
  let bd = Infinity;
  for (let i = 0; i < positions.length; i += 3 * stride) {
    const dx = positions[i] - px, dy = positions[i+1] - py, dz = positions[i+2] - pz;
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bd) bd = d;
  }
  return bd;
}

/* ---------- nearest-vertex lookup (uniform grid) ----------
 * Tag projection used to brute-force every vertex per tag point — 120 ms at
 * 500k vertices, paid on every load. A uniform grid gives the identical answer
 * ~10x faster, and the build is amortized over all points of all groups.
 */
export function buildVertexGrid(pos) {
  const n = pos.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i+1], z = pos[i+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const div = Math.max(1, Math.min(128, Math.round(Math.cbrt(n / 2))));   // ~2 vertices per cell
  const cell = ext / div;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const nc = nx * ny * nz;
  const offsets = new Uint32Array(nc + 1);
  const cellIdx = new Uint32Array(n);
  for (let v = 0, i = 0; v < n; v++, i += 3) {
    const ix = Math.min(nx - 1, (pos[i]   - minX) / cell | 0);
    const iy = Math.min(ny - 1, (pos[i+1] - minY) / cell | 0);
    const iz = Math.min(nz - 1, (pos[i+2] - minZ) / cell | 0);
    const c = (iz * ny + iy) * nx + ix;
    cellIdx[v] = c; offsets[c + 1]++;
  }
  for (let c = 0; c < nc; c++) offsets[c + 1] += offsets[c];
  const cursor = offsets.slice(0, nc);
  const items = new Uint32Array(n);
  for (let v = 0; v < n; v++) items[cursor[cellIdx[v]]++] = v;
  return { minX, minY, minZ, cell, nx, ny, nz, offsets, items };
}

// Index of the mesh vertex closest to (px,py,pz); -1 only for an empty mesh.
// Scans cell shells outward and stops as soon as no further shell can beat the
// current best — so the answer is exact, not approximate.
export function nearestVertexIndex(grid, pos, px, py, pz) {
  const { minX, minY, minZ, cell, nx, ny, nz, offsets, items } = grid;
  const cx = Math.max(0, Math.min(nx - 1, (px - minX) / cell | 0));
  const cy = Math.max(0, Math.min(ny - 1, (py - minY) / cell | 0));
  const cz = Math.max(0, Math.min(nz - 1, (pz - minZ) / cell | 0));
  let bd = Infinity, bi = -1;
  const scanCell = (ix, iy, iz) => {
    const c = (iz * ny + iy) * nx + ix;
    for (let k = offsets[c]; k < offsets[c + 1]; k++) {
      const v = items[k], j = v * 3;
      const dx = pos[j] - px, dy = pos[j+1] - py, dz = pos[j+2] - pz;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < bd) { bd = d; bi = v; }
    }
  };
  const maxR = Math.max(nx, ny, nz);
  for (let r = 0; r <= maxR; r++) {
    const x0 = Math.max(0, cx - r), x1 = Math.min(nx - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(ny - 1, cy + r);
    const z0 = Math.max(0, cz - r), z1 = Math.min(nz - 1, cz + r);
    for (let iz = z0; iz <= z1; iz++) {
      const onZ = (iz === cz - r || iz === cz + r);
      for (let iy = y0; iy <= y1; iy++) {
        const onY = (iy === cy - r || iy === cy + r);
        if (onZ || onY) { for (let ix = x0; ix <= x1; ix++) scanCell(ix, iy, iz); }
        else { // only the two edge columns of this row belong to the shell
          if (cx - r >= 0) scanCell(cx - r, iy, iz);
          if (r > 0 && cx + r <= nx - 1) scanCell(cx + r, iy, iz);
        }
      }
    }
    // A cell of the next shell is at least r*cell away — if the best hit is
    // closer than that, no further shell can beat it.
    if (bi >= 0) { const lim = r * cell; if (bd <= lim * lim) break; }
  }
  return bi;
}

// Distribute tag groups across meshes. Each POINT goes to the mesh whose surface
// (nearest vertex) is closest to that point, so a single group with points on
// multiple anatomies (e.g. Rhythmia's one global Ablation set spanning LA+LV) is
// split per mesh instead of being lumped onto whichever anatomy happens to hold the
// group centroid. Returns groups-per-mesh (array parallel to meshes); each emitted
// group is a shallow clone of the source with only its assigned points. Empty-point
// groups are skipped and meshes with no assigned points get no sub-group.
export function assignTagsToMeshes(meshes, tagGroups) {
  const out = meshes.map(() => []);
  for (const g of (tagGroups || [])) {
    const pts = g.points || []; if (!pts.length) continue;
    const buckets = meshes.map(() => []);
    for (const p of pts) {
      const [px, py, pz] = p.position;
      let best = 0, bd = Infinity;
      for (let i = 0; i < meshes.length; i++) {
        const d = minSqDistToMeshVerts(meshes[i].positions, px, py, pz);
        if (d < bd) { bd = d; best = i; }
      }
      buckets[best].push(p);
    }
    for (let i = 0; i < meshes.length; i++) {
      if (buckets[i].length) out[i].push({ ...g, points: buckets[i] });
    }
  }
  return out;
}

// Vertex adjacency as a CSR pair of flat typed arrays: neighbors of vertex v are
// `neighbors[offsets[v] .. offsets[v+1]]`, sorted and deduplicated.
// Counting + prefix sum + fill beats one Set per vertex by ~5x at 500k vertices
// (172 ms -> 36 ms) — that cost lands on the first drag of the interpolation slider.
export function buildAdjacencyCSR(faces, nVerts) {
  const nf = (faces.length / 3) | 0;
  const counts = new Uint32Array(nVerts + 1);
  for (let f = 0; f < nf * 3; f += 3) {
    counts[faces[f] + 1] += 2; counts[faces[f + 1] + 1] += 2; counts[faces[f + 2] + 1] += 2;
  }
  for (let v = 0; v < nVerts; v++) counts[v + 1] += counts[v];
  const raw = new Uint32Array(counts[nVerts]);
  const cursor = counts.slice(0, nVerts);
  for (let f = 0; f < nf * 3; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2];
    raw[cursor[a]++] = b; raw[cursor[a]++] = c;
    raw[cursor[b]++] = a; raw[cursor[b]++] = c;
    raw[cursor[c]++] = a; raw[cursor[c]++] = b;
  }
  // sort + dedupe each vertex slice, compacting into the final CSR
  const offsets = new Uint32Array(nVerts + 1);
  const neighbors = new Uint32Array(raw.length);
  let w = 0;
  for (let v = 0; v < nVerts; v++) {
    offsets[v] = w;
    const s = counts[v], e = counts[v + 1];
    if (e > s) {
      const slice = raw.subarray(s, e).sort();
      let prev = -1;
      for (let i = 0; i < slice.length; i++) {
        const nb = slice[i];
        if (nb !== prev && nb !== v) { neighbors[w++] = nb; prev = nb; }
      }
    }
  }
  offsets[nVerts] = w;
  return { offsets, neighbors: neighbors.subarray(0, w), length: nVerts };
}

// Vertex adjacency (neighbor index arrays) from a triangle index array.
// Convenience wrapper over the CSR build for callers that want plain arrays.
export function buildAdjacency(faces, nVerts) {
  const { offsets, neighbors } = buildAdjacencyCSR(faces, nVerts);
  const adj = new Array(nVerts);
  for (let v = 0; v < nVerts; v++) {
    const out = [];
    for (let k = offsets[v]; k < offsets[v + 1]; k++) out.push(neighbors[k]);
    adj[v] = out;
  }
  return adj;
}
// Laplacian smoothing of a per-vertex scalar: new = (1-lambda)*v + lambda*mean(finite neighbors).
// NaN values are preserved and excluded from neighbor means. iterations 0 -> a copy.
// `adjacency` is either an array-of-arrays or a CSR object from buildAdjacencyCSR.

/* Interpolation, ohne die Grenze mit wegzuwischen.
 *
 * Die Laplace-Glättung oben mittelt jeden Punkt mit allen seinen Nachbarn.
 * Rauschen verschwindet damit, die Narbengrenze aber auch: bei Stufe 10 ist
 * eine Karte gleichmäßig unscharf, und genau die Kante, an der 0,5 mV nach
 * 1,5 mV wird, war das, was man sehen wollte.
 *
 * Also werden Nachbarn danach gewichtet, wie ähnlich sie sind. Innerhalb eines
 * Gebiets zählt jeder mit, über eine Kante hinweg fast keiner — dieselbe Idee
 * wie ein bilateraler Filter, auf einem Netz statt auf einem Bild. `sigma` ist
 * der Abstand, ab dem zwei Werte als "verschiedenes Gewebe" gelten; es kommt
 * aus dem eingestellten Fenster, damit die Kante dort liegt, wo der Betrachter
 * sie ohnehin abliest.
 */
/* Glättung in einem Zug, über eine Strecke statt über Nachbarschaftsringe.
 *
 * Wiederholte bilaterale Durchgänge treppen — das ist ihre bekannte Eigenart
 * und auf dieser Karte gemessen: bei zehn Durchgängen wächst die Zahl der
 * Stufen über 0,5 mV von 2.100 auf 2.820. Der Filter *erzeugt* die Kanten, die
 * er erhalten soll, und die Karte sieht gepflastert aus.
 *
 * Ein einziger Durchgang kann das nicht. Gemittelt wird über alles, was
 * innerhalb eines Radius liegt (in Millimetern, nicht in Kanten — ein Netz mit
 * 1,3 mm Kanten und eines mit 4 mm sollen gleich stark geglättet werden),
 * gewichtet nach Abstand und nach Wertunterschied. Gemessen bei 6 mm und
 * σ = 0,3 mV: Plateaugrenzen −38 %, echte Kanten zu 86 % erhalten, keine neuen.
 *
 * Das ist auch näher an dem, was OpenEP und CARTO tun: von den Messpunkten aus
 * über eine Strecke interpolieren, mit einer Schwelle darüber hinaus.
 */
export function smoothScalarSpatial(values, adjacency, positions, radius, sigmaValue,
                                    limit = 400) {
  const csr = adjacency && adjacency.offsets ? adjacency : null;
  if (!csr || !positions || !(radius > 0)) return Float32Array.from(values);

  const out = Float32Array.from(values);
  const sigmaSpace = radius / 2;
  const spaceFalloff = -1 / (2 * sigmaSpace * sigmaSpace);
  const valueFalloff = sigmaValue > 0 ? -1 / (2 * sigmaValue * sigmaValue) : 0;
  const radiusSquared = radius * radius;

  // Wiederverwendet statt je Vertex neu angelegt: bei 18.000 Vertices wären das
  // 18.000 Allokationen pro Durchgang.
  const seen = new Int32Array(values.length).fill(-1);
  const queue = new Int32Array(limit + 1);

  for (let v = 0; v < values.length; v++) {
    const cv = values[v];
    if (Number.isNaN(cv)) continue;
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];

    let head = 0, tail = 0, sum = cv, weight = 1;
    queue[tail++] = v;
    seen[v] = v;
    while (head < tail && tail < limit) {
      const at = queue[head++];
      for (let n = csr.offsets[at]; n < csr.offsets[at + 1]; n++) {
        const j = csr.neighbors[n];
        if (seen[j] === v) continue;
        const dx = positions[j * 3] - x;
        const dy = positions[j * 3 + 1] - y;
        const dz = positions[j * 3 + 2] - z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > radiusSquared) continue;
        seen[j] = v;
        if (tail < limit) queue[tail++] = j;         // weiter nach außen
        const nv = values[j];
        if (Number.isNaN(nv)) continue;
        const d = nv - cv;
        const w = Math.exp(distanceSquared * spaceFalloff
                           + (valueFalloff ? d * d * valueFalloff : 0));
        sum += w * nv; weight += w;
      }
    }
    out[v] = sum / weight;
  }
  return out;
}

/** Die mittlere Kantenlänge — der Maßstab, in dem ein Radius Sinn ergibt. */
export function medianEdgeLength(positions, adjacency, sample = 4000) {
  const csr = adjacency && adjacency.offsets ? adjacency : null;
  if (!csr || !positions) return 0;
  const lengths = [];
  const count = positions.length / 3;
  const stride = Math.max(1, Math.floor(count / sample));
  for (let v = 0; v < count; v += stride) {
    for (let n = csr.offsets[v]; n < csr.offsets[v + 1]; n++) {
      const j = csr.neighbors[n];
      if (j <= v) continue;
      const dx = positions[j * 3] - positions[v * 3];
      const dy = positions[j * 3 + 1] - positions[v * 3 + 1];
      const dz = positions[j * 3 + 2] - positions[v * 3 + 2];
      lengths.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
  }
  if (!lengths.length) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}

/** Wie groß ein Wertunterschied zwischen Nachbarn typischerweise ist.
 *
 * Die Schwelle für "gleiches Gewebe" darf nicht aus dem Farbfenster kommen —
 * gemessen an dieser Karte liegt der Median bei 0,023 mV, das Fenster-Fünftel
 * aber bei 0,29: damit galt jeder Nachbar als gleich und die Glättung war
 * wieder die gleichmäßige. Aus den Daten genommen trennt sie sauber: Plateau-
 * Stufen liegen darunter und verschwinden, die Narbengrenze (hier 0,42 mV)
 * liegt viereinhalbfach darüber und bleibt.
 *
 * Das 75. Perzentil, nicht der Mittelwert: eine einzelne Grenze mit 6 mV soll
 * die Schwelle nicht nach oben ziehen.
 */
export function edgeStepScale(values, adjacency, quantile = 0.75, limit = 200000) {
  const csr = adjacency && adjacency.offsets ? adjacency : null;
  if (!csr) return 0;
  const steps = [];
  // Bei großen Netzen jede k-te Kante: die Verteilung braucht keine Vollzählung.
  const edges = csr.neighbors.length / 2;
  const stride = Math.max(1, Math.ceil(edges / limit));
  let seen = 0;
  for (let a = 0; a < values.length; a++) {
    for (let n = csr.offsets[a]; n < csr.offsets[a + 1]; n++) {
      const b = csr.neighbors[n];
      if (b <= a) continue;
      if ((seen++ % stride) !== 0) continue;
      const d = Math.abs(values[a] - values[b]);
      if (Number.isFinite(d)) steps.push(d);
    }
  }
  if (!steps.length) return 0;
  steps.sort((x, y) => x - y);
  return steps[Math.min(steps.length - 1, Math.floor(steps.length * quantile))];
}

