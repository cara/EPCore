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

/** Everything computable from this surface. Absent measurements are null. */
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
    activation: lat ? activation(positions, lat) : null,
  };
}
