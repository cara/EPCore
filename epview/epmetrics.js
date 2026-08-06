/* Measurements over a mapped surface: area, volume, scar, activation.
 *
 * The same quantities epcore/epview/metrics.py computes, by the same rules, so
 * a number read off the screen and one printed by `epcore epview metrics` are
 * the same number. tests/corpus checks that on the real map rather than
 * trusting that two ports of the same idea stayed together.
 *
 * Three decisions change the answer, and each is here for a reason:
 *
 *  * Low-voltage area cuts every triangle along the isoline instead of
 *    counting vertices below the threshold. Counting makes the result jump as
 *    the threshold moves and biases it towards wherever the mesh is dense; a
 *    clinician moving 0.5 -> 0.6 mV would see a cliff that is an artefact.
 *  * Mean voltage is weighted by area. Vertex density is an artefact of
 *    reconstruction, not of anatomy.
 *  * A missing value is not a zero. Triangles touching an unmeasured vertex
 *    leave both the numerator and the denominator, and the area that removed
 *    is reported. A scar fraction quoted against a half-mapped surface is
 *    worse than no number.
 */

/** The conventional bipolar threshold for dense scar, in millivolts. */
export const SCAR_MV = 0.5;

/** For a triangle, the other two corners given the index of the odd one out. */
const OTHERS = [[1, 2], [2, 0], [0, 1]];

/** Area of each triangle, in mm² when the mesh is in millimetres. */
export function triangleAreas(positions, faces) {
  const n = faces.length / 3;
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    out[f] = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return out;
}

export function surfaceArea(positions, faces) {
  let sum = 0;
  for (const a of triangleAreas(positions, faces)) sum += a;
  return sum;
}

/** Whether the surface encloses a volume, and why not if it does not.
 *
 *  Two things have to hold: every edge shared by exactly two triangles (no
 *  holes), and those two traversing it in opposite directions (consistent
 *  winding). The second is the nastier one — the surface still looks closed
 *  while the signed volume it implies is wrong.
 */
export function meshClosure(positions, faces) {
  const seen = new Map();          // "lo,hi" -> [count, forwardCount]
  const n = faces.length / 3;
  for (let f = 0; f < n; f++) {
    const v = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const rec = seen.get(key) || [0, 0];
      rec[0]++;
      if (a < b) rec[1]++;
      seen.set(key, rec);
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const [count, forward] of seen.values()) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
    else if (forward !== 1) inconsistent++;   // both same way round
  }
  return {
    closed: boundary === 0 && nonManifold === 0 && inconsistent === 0,
    boundaryEdges: boundary, nonManifoldEdges: nonManifold,
    inconsistentlyWoundEdges: inconsistent,
  };
}

/** The centroid of the surface, weighted by triangle area.
 *
 * OpenEP's `getCentreOfMass`. Weighted by area and not by vertex: a mesh is
 * denser where the reconstruction had more to say, and an unweighted mean of
 * the vertices drifts towards whichever wall was sampled hardest rather than
 * towards the middle of the chamber.
 */
export function centreOfMass(positions, faces) {
  const areas = triangleAreas(positions, faces);
  let total = 0;
  const out = [0, 0, 0];
  for (let f = 0; f < areas.length; f++) {
    const a = areas[f];
    if (!(a > 0)) continue;
    total += a;
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k] * 3;
      out[0] += (positions[v] * a) / 3;
      out[1] += (positions[v + 1] * a) / 3;
      out[2] += (positions[v + 2] * a) / 3;
    }
  }
  if (!(total > 0)) return [NaN, NaN, NaN];
  return out.map(x => x / total);
}

/** Edges belonging to exactly one triangle, as [a, b] pairs. */
function boundaryEdges(faces) {
  const seen = new Map();
  const n = faces.length / 3;
  for (let f = 0; f < n; f++) {
    const v = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const out = [];
  for (const [key, count] of seen) {
    if (count === 1) out.push(key.split(",").map(Number));
  }
  return out;
}

/** Chain boundary edges into closed loops — one per hole in the surface.
 *
 * Walked rather than clustered, so two rings that share a vertex come out as
 * two rings. A reconstruction that pinched produces exactly that.
 */
function boundaryRings(edges) {
  const neighbours = new Map();
  const unused = new Set();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [a, b] of edges) {
    if (!neighbours.has(a)) neighbours.set(a, []);
    if (!neighbours.has(b)) neighbours.set(b, []);
    neighbours.get(a).push(b);
    neighbours.get(b).push(a);
    unused.add(key(a, b));
  }
  const rings = [];
  while (unused.size) {
    const [start, next] = unused.values().next().value.split(",").map(Number);
    unused.delete(key(start, next));
    const ring = [start, next];
    for (;;) {
      const here = ring[ring.length - 1];
      const step = (neighbours.get(here) || []).find(n => unused.has(key(here, n)));
      if (step === undefined) break;
      unused.delete(key(here, step));
      if (step === ring[0]) break;
      ring.push(step);
    }
    rings.push(ring);
  }
  return rings;
}

/** The holes in the surface — valve rings, vein ostia, the transseptal cut.
 *
 * OpenEP's `getAnatomicalStructures`. A clinical system marks these; a
 * converted export does not, so they are recovered from the geometry.
 *
 * They are deliberately not named. Which ostium is which is a clinical
 * judgement, and a label invented from a size would be wrong exactly when it
 * mattered.
 */
export function anatomicalStructures(positions, faces) {
  const edges = boundaryEdges(faces);
  const atRim = new Uint8Array(positions.length / 3);
  if (!edges.length) return { count: 0, rings: [], rimVertices: atRim };
  for (const [a, b] of edges) { atRim[a] = 1; atRim[b] = 1; }

  const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const rings = boundaryRings(edges).map(loop => {
    const points = loop.map(at);
    let circumference = 0;
    const centre = [0, 0, 0];
    for (const p of points) { centre[0] += p[0]; centre[1] += p[1]; centre[2] += p[2]; }
    for (let k = 0; k < 3; k++) centre[k] /= points.length;
    const fan = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];
      circumference += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const u = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
      const v = [q[0] - centre[0], q[1] - centre[1], q[2] - centre[2]];
      fan[0] += u[1] * v[2] - u[2] * v[1];
      fan[1] += u[2] * v[0] - u[0] * v[2];
      fan[2] += u[0] * v[1] - u[1] * v[0];
    }
    return {
      vertices: loop,
      circumferenceMm: circumference,
      areaMm2: Math.hypot(fan[0], fan[1], fan[2]) / 2,
      centre,
      diameterMm: circumference / Math.PI,
    };
  });
  rings.sort((a, b) => b.circumferenceMm - a.circumferenceMm);
  return { count: rings.length, rings, rimVertices: atRim };
}

/** Volume enclosed by the surface in mm³, or null when it encloses none. */
export function enclosedVolume(positions, faces) {
  if (!meshClosure(positions, faces).closed) return null;
  let sum = 0;
  const n = faces.length / 3;
  for (let f = 0; f < n; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    sum += positions[a] * (by * cz - bz * cy)
         + positions[a + 1] * (bz * cx - bx * cz)
         + positions[a + 2] * (bx * cy - by * cx);
  }
  return Math.abs(sum) / 6;
}

/** Fraction of one triangle's area whose value is below the threshold.
 *
 *  Exact for a field interpolated linearly across it. The isoline cuts off a
 *  corner: with one vertex below, that corner is the region; with two, it is
 *  everything but the opposite corner.
 */
function fractionBelow(v0, v1, v2, threshold) {
  const v = [v0, v1, v2];
  const below = v.map(x => x < threshold);
  const count = below[0] + below[1] + below[2];
  if (count === 3) return 1;
  if (count === 0) return 0;
  const oddIsBelow = count === 1;
  const apex = below.findIndex(b => b === oddIsBelow);
  const [p, q] = OTHERS[apex];
  // Both endpoints straddle the threshold, so neither denominator is zero.
  const s1 = (threshold - v[apex]) / (v[p] - v[apex]);
  const s2 = (threshold - v[apex]) / (v[q] - v[apex]);
  const corner = s1 * s2;
  return oddIsBelow ? corner : 1 - corner;
}

/** Area below a voltage threshold, and as a fraction of what was measured. */
export function lowVoltageArea(positions, faces, voltage, threshold = SCAR_MV) {
  const areas = triangleAreas(positions, faces);
  let low = 0, measured = 0, unmeasured = 0, total = 0;
  const n = faces.length / 3;
  for (let f = 0; f < n; f++) {
    const area = areas[f];
    total += area;
    const a = voltage[faces[f * 3]], b = voltage[faces[f * 3 + 1]],
          c = voltage[faces[f * 3 + 2]];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
      unmeasured += area;
      continue;
    }
    measured += area;
    low += fractionBelow(a, b, c, threshold) * area;
  }
  return {
    thresholdMv: threshold, areaMm2: low,
    fraction: measured > 0 ? low / measured : null,
    measuredMm2: measured, unmeasuredMm2: unmeasured, totalMm2: total,
  };
}

/** Area-weighted mean voltage over the measured surface, or null. */
export function meanVoltage(positions, faces, voltage) {
  const areas = triangleAreas(positions, faces);
  let sum = 0, weight = 0;
  const n = faces.length / 3;
  for (let f = 0; f < n; f++) {
    const a = voltage[faces[f * 3]], b = voltage[faces[f * 3 + 1]],
          c = voltage[faces[f * 3 + 2]];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    sum += ((a + b + c) / 3) * areas[f];
    weight += areas[f];
  }
  return weight > 0 ? sum / weight : null;
}

/** Total activation time and where the surface activates first and last. */
export function activation(positions, lat) {
  let first = -1, last = -1, lo = Infinity, hi = -Infinity, known = 0;
  for (let i = 0; i < lat.length; i++) {
    const v = lat[i];
    if (!Number.isFinite(v)) continue;
    known++;
    if (v < lo) { lo = v; first = i; }
    if (v > hi) { hi = v; last = i; }
  }
  if (!known) {
    return { totalActivationTimeMs: null, earliest: null, latest: null,
             coverage: 0, measuredVertices: 0 };
  }
  const at = (i) => ({ vertex: i, latMs: lat[i],
                       xyz: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] });
  return {
    totalActivationTimeMs: hi - lo,
    earliest: at(first), latest: at(last),
    coverage: known / lat.length, measuredVertices: known,
  };
}

/* Wieviel Fläche wann aktiv ist — die Kurve, die Rhythmia SKYLINE nennt.
 *
 * Für jeden Zeitpunkt im Mapping-Fenster: welcher Anteil der Karte hat gerade
 * dort seine Aktivierungszeit. Bei einem Makroreentry läuft die Welle
 * gleichmäßig durch und die Kurve ist flach; bricht sie irgendwo ein, aktiviert
 * dort für eine Weile fast nichts — und genau diese Lücke ist die Stelle, an der
 * die Isthmus-Frage entschieden wird.
 *
 * Gewichtet nach Fläche, nicht nach Vertexzahl: ein feines Netz an der
 * Vorderwand und ein grobes am Dach würden sonst behaupten, vorne aktiviere
 * dreimal so viel Gewebe.
 */
export function activationHistogram(positions, faces, lat, bins = 60) {
  const areas = triangleAreas(positions, faces);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    const v = lat[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return { bins: [], lo: null, hi: null, totalAreaMm2: 0 };

  const width = (hi - lo) / bins;
  const counts = new Float64Array(bins);
  let total = 0;

  for (let f = 0; f < faces.length; f += 3) {
    const area = areas[f / 3];
    if (!(area > 0)) continue;
    // Ein Dreieck aktiviert nicht in einem Augenblick, sondern über die Spanne
    // seiner drei Ecken. Es auf einen einzigen Zeitpunkt zu buchen, machte aus
    // einer durchlaufenden Welle eine Reihe von Zacken.
    let min = Infinity, max = -Infinity, known = 0;
    for (let k = 0; k < 3; k++) {
      const v = lat[faces[f + k]];
      if (!Number.isFinite(v)) continue;
      known++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (known < 3) continue;                 // teilweise unbelegt: nicht raten
    total += area;
    const from = Math.max(0, Math.min(bins - 1, Math.floor((min - lo) / width)));
    const to = Math.max(0, Math.min(bins - 1, Math.floor((max - lo) / width)));
    const share = area / (to - from + 1);
    for (let b = from; b <= to; b++) counts[b] += share;
  }

  const out = [];
  for (let b = 0; b < bins; b++) {
    out.push({ tMs: lo + (b + 0.5) * width, areaMm2: counts[b],
               fraction: total > 0 ? counts[b] / total : 0 });
  }
  return { bins: out, lo, hi, totalAreaMm2: total };
}

/** Die stillste Strecke der Kurve — dort, wo am wenigsten Gewebe aktiviert.
 *
 * Kein Befund, sondern ein Hinweis, wo man hinsehen sollte: bei einem
 * vollständig erfassten Kreis liegt hier die langsame Leitung.
 */
export function quietestWindow(histogram, spanMs = 20) {
  const bins = histogram.bins || [];
  if (bins.length < 2) return null;
  const width = bins[1].tMs - bins[0].tMs;
  const count = Math.max(1, Math.round(spanMs / width));
  if (count > bins.length) return null;

  let best = null, sum = 0;
  for (let i = 0; i < bins.length; i++) {
    sum += bins[i].fraction;
    if (i >= count) sum -= bins[i - count].fraction;
    if (i >= count - 1 && (best === null || sum < best.fraction)) {
      best = { fraction: sum, fromMs: bins[i - count + 1].tMs - width / 2,
               toMs: bins[i].tMs + width / 2 };
    }
  }
  return best;
}

/* Was an einer Öffnung hängt — der Stumpf, den man wegschneiden will.
 *
 * Eine Lungenvene oder eine Klappenebene endet im Export als Röhre, die vom
 * Rand der Öffnung aus in die Karte hineinragt. Auf dem Bild verdeckt sie die
 * Wand dahinter, und in der Flächenzahl steht sie mit drin, obwohl niemand sie
 * abladiert.
 *
 * Gemessen wird der Weg *über die Oberfläche*, nicht der Abstand durch den
 * Raum: eine Vene, die sich an die Wand anlegt, wäre sonst mitsamt der Wand
 * markiert, an der sie anliegt.
 */
export function vertsWithinOfRing(positions, adjacency, ringVertices, depthMm) {
  const csr = adjacency && adjacency.offsets ? adjacency : null;
  const marked = new Set();
  if (!csr || !ringVertices || !ringVertices.length || !(depthMm > 0)) return marked;

  const count = positions.length / 3;
  const distance = new Float64Array(count).fill(Infinity);
  // Eine schlichte Warteschlange statt eines Heaps: die Kanten eines
  // Mapping-Netzes sind alle ähnlich lang, und der Fehler dadurch liegt unter
  // einer Kantenlänge — bei 1,3 mm Kanten und 8 mm Tiefe belanglos.
  const queue = [];
  for (const v of ringVertices) { distance[v] = 0; queue.push(v); marked.add(v); }

  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    const base = distance[v];
    for (let n = csr.offsets[v]; n < csr.offsets[v + 1]; n++) {
      const j = csr.neighbors[n];
      const dx = positions[j * 3] - positions[v * 3];
      const dy = positions[j * 3 + 1] - positions[v * 3 + 1];
      const dz = positions[j * 3 + 2] - positions[v * 3 + 2];
      const step = base + Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (step >= distance[j] || step > depthMm) continue;
      distance[j] = step;
      marked.add(j);
      queue.push(j);
    }
  }
  return marked;
}

/** Die Dreiecke ohne die markierten Vertices — die zugeschnittene Karte.
 *
 * Ein Dreieck fällt weg, sobald *eine* seiner Ecken im Schnitt liegt: bliebe es
 * stehen, ragte am Rand ein Zackensaum aus halb abgeschnittenen Dreiecken.
 */
export function facesWithout(faces, removed) {
  if (!removed || !removed.size) return faces;
  const kept = [];
  for (let f = 0; f < faces.length; f += 3) {
    if (removed.has(faces[f]) || removed.has(faces[f + 1]) || removed.has(faces[f + 2])) continue;
    kept.push(faces[f], faces[f + 1], faces[f + 2]);
  }
  return faces instanceof Uint32Array ? Uint32Array.from(kept) : kept;
}

/** Everything computable from this surface. Absent measurements are null. */
/** Fill the holes so the surface encloses a volume.
 *
 * OpenEP's `getClosedSurface`. Each ring is capped with a fan to a new vertex
 * at its centre, wound against the triangle already on the ring — wound the
 * other way the mesh still looks closed and the signed volume is wrong, which
 * is the nastier failure because nothing looks amiss.
 *
 * The added vertices are appended, so everything from the original count on is
 * filler and a caller measuring over the result can leave it out.
 */
export function closeSurface(positions, faces) {
  const edges = boundaryEdges(faces);
  if (!edges.length) return { positions, faces };

  const orientation = new Set();
  for (let f = 0; f < faces.length / 3; f++) {
    const v = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
    for (let e = 0; e < 3; e++) orientation.add(`${v[e]},${v[(e + 1) % 3]}`);
  }

  const out = [...positions];
  const outFaces = [...faces];
  for (const loop of boundaryRings(edges)) {
    const centre = [0, 0, 0];
    for (const i of loop) {
      centre[0] += positions[i * 3];
      centre[1] += positions[i * 3 + 1];
      centre[2] += positions[i * 3 + 2];
    }
    const index = out.length / 3;
    out.push(centre[0] / loop.length, centre[1] / loop.length, centre[2] / loop.length);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      if (orientation.has(`${a},${b}`)) outFaces.push(b, a, index);
      else outFaces.push(a, b, index);
    }
  }
  return { positions: out, faces: outFaces };
}

/** How close to the extreme a vertex has to be to count as part of a site. */
export const SITE_TOLERANCE_MS = 5.0;

/** The earliest and latest activation *regions*, not the extreme vertices.
 *
 * OpenEP's `getEarliestActivationSite` and `getLatestActivationSite`. One
 * mis-annotated point moves the extreme vertex across the chamber and the
 * number says nothing about it; a region is what somebody would point at.
 */
export function activationSites(positions, faces, lat,
                                toleranceMs = SITE_TOLERANCE_MS) {
  const n = positions.length / 3;
  let lowest = Infinity, highest = -Infinity, known = 0;
  for (let i = 0; i < n; i++) {
    const t = lat[i];
    if (!Number.isFinite(t)) continue;
    known++;
    if (t < lowest) lowest = t;
    if (t > highest) highest = t;
  }
  if (!known) return { earliest: null, latest: null, toleranceMs };

  const areas = triangleAreas(positions, faces);
  const site = (extreme, inside) => {
    const chosen = [];
    for (let i = 0; i < n; i++) if (inside(lat[i])) chosen.push(i);
    const centre = [0, 0, 0];
    for (const i of chosen) {
      centre[0] += positions[i * 3];
      centre[1] += positions[i * 3 + 1];
      centre[2] += positions[i * 3 + 2];
    }
    for (let k = 0; k < 3; k++) centre[k] /= chosen.length || 1;
    const member = new Uint8Array(n);
    for (const i of chosen) member[i] = 1;
    let area = 0;
    for (let f = 0; f < faces.length / 3; f++) {
      if (member[faces[f * 3]] && member[faces[f * 3 + 1]] && member[faces[f * 3 + 2]]) {
        area += areas[f];
      }
    }
    return { latMs: extreme, centre, vertices: chosen.length, areaMm2: area };
  };

  return {
    earliest: site(lowest, t => Number.isFinite(t) && t <= lowest + toleranceMs),
    latest: site(highest, t => Number.isFinite(t) && t >= highest - toleranceMs),
    toleranceMs,
  };
}

/** How long an electrogram is active for, in milliseconds.
 *
 * OpenEP's `getElectrogramDuration`. The baseline is the median rather than the
 * mean: a signal sits on its baseline most of the time and deflects for a
 * fraction of it, so the mean is dragged into the deflection.
 */
export function electrogramDuration(samples, sampleRateHz, fraction = 0.1) {
  if (!(sampleRateHz > 0)) throw new Error(`sample rate must be positive, got ${sampleRateHz}`);
  if (!samples || samples.length < 2) {
    return { durationMs: null, windowMs: null, amplitudeMv: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const baseline = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  let largest = 0;
  for (const s of samples) largest = Math.max(largest, Math.abs(s - baseline));
  const amplitude = sorted[sorted.length - 1] - sorted[0];
  if (!(largest > 0)) return { durationMs: 0, windowMs: null, amplitudeMv: 0 };

  const cut = largest * fraction;
  let start = -1, end = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] - baseline) >= cut) { if (start < 0) start = i; end = i; }
  }
  const perSample = 1000 / sampleRateHz;
  return {
    durationMs: (end - start) * perSample,
    windowMs: [start * perSample, end * perSample],
    amplitudeMv: amplitude,
    thresholdFraction: fraction,
  };
}

/** The conventional border-zone band, in millivolts. */
export const BORDER_MV = [0.5, 1.5];

/** How much surface lies in each voltage band.
 *
 * OpenEP's `voltageHistogramAnalysis`. One threshold hides how much the answer
 * depends on the threshold, which is the thing the literature argues about.
 * Each band is cut along its isolines by the same routine the single threshold
 * uses.
 */
export function voltageHistogram(positions, faces, voltage, edges = null) {
  const cuts = (edges || BORDER_MV).map(Number);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] <= cuts[i - 1]) {
      throw new Error(`histogram edges must increase, got ${cuts}`);
    }
  }
  const below = cuts.map(e => lowVoltageArea(positions, faces, voltage, e));
  const total = below.length ? below[0].measuredMm2 : 0;

  const bands = [];
  let previous = 0;
  cuts.forEach((edge, i) => {
    bands.push({ fromMv: i === 0 ? null : cuts[i - 1], toMv: edge,
                 areaMm2: below[i].areaMm2 - previous });
    previous = below[i].areaMm2;
  });
  bands.push({ fromMv: cuts.length ? cuts[cuts.length - 1] : null, toMv: null,
               areaMm2: total - previous });
  for (const band of bands) band.fraction = total > 0 ? band.areaMm2 / total : null;

  return { edgesMv: cuts, bands, measuredMm2: total,
           unmeasuredMm2: below.length ? below[0].unmeasuredMm2 : null };
}

/** Whether the bipolar and unipolar maps were handed over the wrong way round.
 *
 * OpenEP's `fixVoltageAnnotations`. Reports; does not swap. The two are close
 * over much of a healthy chamber, so only a lopsided result means anything, and
 * silently exchanging two maps on a heuristic is not something to do.
 */
export function voltagesLookSwapped(bipolar, unipolar) {
  if (bipolar.length !== unipolar.length) {
    throw new Error(`${bipolar.length} bipolar against ${unipolar.length} unipolar`);
  }
  let both = 0, larger = 0;
  for (let i = 0; i < bipolar.length; i++) {
    if (!Number.isFinite(bipolar[i]) || !Number.isFinite(unipolar[i])) continue;
    both++;
    if (bipolar[i] > unipolar[i]) larger++;
  }
  if (!both) return { swapped: null, comparableVertices: 0, bipolarLarger: null };
  const share = larger / both;
  return { swapped: share > 0.9, bipolarLarger: share, comparableVertices: both };
}

export function summarise(positions, faces, { voltage = null, lat = null,
                                              threshold = SCAR_MV } = {}) {
  const closure = meshClosure(positions, faces);
  return {
    vertices: positions.length / 3,
    faces: faces.length / 3,
    surfaceAreaMm2: surfaceArea(positions, faces),
    closed: closure.closed,
    closure,
    volumeMm3: closure.closed ? enclosedVolume(positions, faces) : null,
    lowVoltage: voltage ? lowVoltageArea(positions, faces, voltage, threshold) : null,
    meanVoltageMv: voltage ? meanVoltage(positions, faces, voltage) : null,
    voltageHistogram: voltage ? voltageHistogram(positions, faces, voltage) : null,
    activation: lat ? activation(positions, lat) : null,
    activationSites: lat ? activationSites(positions, faces, lat) : null,
    centreOfMass: centreOfMass(positions, faces),
    // Reported whether or not any scalar is: a surface with four openings and
    // one with none are different objects.
    openings: (() => {
      const found = anatomicalStructures(positions, faces);
      return {
        count: found.count,
        rings: found.rings.map(({ vertices: _v, ...rest }) => rest),
        rimVertices: found.rimVertices.reduce((a, b) => a + b, 0),
      };
    })(),
  };
}
