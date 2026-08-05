/* Where a mapping point sits, and whether it belongs in the map.
 *
 * OpenEP's getWindowOfInterest, getMappingPointsWithinWoI, pointStatus,
 * getMappingPointsWithinMesh and distanceBetweenPoints. The Python side is
 * epcore/epview/points.py and a conformance test holds the two together.
 *
 * These decide whether a map means anything before any statistic is computed
 * over it: a point annotated outside its window belongs to a different beat,
 * and a point off the wall is a measurement of blood.
 */
import { meshClosure } from './epmetrics.js?v=76e45eb3ef80';

/** How far outside the surface a point may sit and still count as on it, mm. */
export const ON_SURFACE_MM = 3.0;

/** The window a point's annotation has to fall in, in ms. */
export function windowOfInterest(point) {
  const woi = point && (point.woiMs || point.woi_ms);
  if (!woi || woi.length !== 2) return null;
  const [start, end] = [Number(woi[0]), Number(woi[1])];
  // A window that ends before it starts is not a window. Swapping the ends
  // would invent one the vendor never wrote.
  if (!(end > start)) return null;
  return [start, end];
}

function annotationOf(point, reader) {
  const value = reader ? reader(point)
    : (point.mapAnnotation !== undefined ? point.mapAnnotation : point.map_annotation);
  return value === undefined || value === null ? null : Number(value);
}

/** Which points have their annotation inside their own window.
 *
 * A point with no window is kept: absence of the constraint is not evidence it
 * was violated. A filter that rejects everything is warned about rather than
 * applied quietly — on the corpus CARTO export every point carries an
 * annotation of -8000 ms against a window of 20 to 180, which is a clock
 * problem and not a map where every point missed the beat.
 */
export function withinWindow(points, reader = null) {
  const keep = points.map(() => true);
  let considered = 0;
  points.forEach((point, i) => {
    const window = windowOfInterest(point);
    if (!window) return;
    const value = annotationOf(point, reader);
    if (value === null) return;
    considered++;
    keep[i] = value >= window[0] && value <= window[1];
  });
  if (considered && !keep.some(Boolean)) {
    console.warn(`[epview] every one of the ${considered} point(s) with both a `
      + `window and an annotation falls outside it — check that the annotation `
      + `and the window are on the same clock before using this mask`);
  }
  return keep;
}

/** The window filter with its working shown.
 *
 * "Three points missed the beat" and "the clock is wrong" produce the same mask
 * and mean opposite things; the counts are what tell them apart.
 */
export function windowReport(points, reader = null) {
  const mask = withinWindow(points, reader);
  const withWindow = points.filter(p => windowOfInterest(p)).length;
  const withAnnotation = points.filter(p => annotationOf(p, reader) !== null).length;
  const checkable = points.filter(
    p => windowOfInterest(p) && annotationOf(p, reader) !== null).length;
  return {
    mask, points: points.length, withWindow, withAnnotation, checkable,
    kept: mask.filter(Boolean).length,
    allRejected: Boolean(checkable) && !mask.some(Boolean),
  };
}

/** Squared distance from a point to one triangle, clamped into it. */
function closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const d00 = abx * abx + aby * aby + abz * abz;
  const d01 = abx * acx + aby * acy + abz * acz;
  const d11 = acx * acx + acy * acy + acz * acz;
  const denominator = d00 * d11 - d01 * d01;
  let u = 0, v = 0;
  if (denominator !== 0) {
    u = (d11 * d1 - d01 * d2) / denominator;
    v = (d00 * d2 - d01 * d1) / denominator;
  }
  u = Math.min(1, Math.max(0, u));
  v = Math.min(1, Math.max(0, v));
  if (u + v > 1) { const scale = u + v; u /= scale; v /= scale; }
  const qx = ax + u * abx + v * acx;
  const qy = ay + u * aby + v * acy;
  const qz = az + u * abz + v * acz;
  return (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
}

/** How far each point is from the surface, in mm.
 *
 * To the surface, not to a vertex: on a coarse mesh the nearest vertex can be
 * millimetres further away, and this number decides whether a point counts as
 * on the wall.
 */
export function distanceToSurface(xyz, positions, faces) {
  const out = new Float64Array(xyz.length / 3).fill(NaN);
  const faceCount = faces.length / 3;
  if (!faceCount) return out;
  for (let p = 0; p < xyz.length / 3; p++) {
    let best = Infinity;
    for (let f = 0; f < faceCount; f++) {
      const i = faces[f * 3] * 3, j = faces[f * 3 + 1] * 3, k = faces[f * 3 + 2] * 3;
      const d = closestOnTriangle(
        xyz[p * 3], xyz[p * 3 + 1], xyz[p * 3 + 2],
        positions[i], positions[i + 1], positions[i + 2],
        positions[j], positions[j + 1], positions[j + 2],
        positions[k], positions[k + 1], positions[k + 2]);
      if (d < best) best = d;
    }
    out[p] = Math.sqrt(best);
  }
  return out;
}

//: Ray directions tried in turn. A ray along an axis through the middle of a
//: box hits the diagonal shared by the two triangles of the far wall exactly,
//: counts it twice, and reports the centre of the chamber as outside it — which
//: is what a quad-derived mesh and a point on its axis produce every time.
const RAY_DIRECTIONS = [
  [1.0, 0.0187, 0.00731],
  [0.0331, 1.0, 0.0122],
  [0.00917, 0.0264, 1.0],
  [0.577, 0.575, 0.580],
];

function castRay(px, py, pz, positions, faces, direction) {
  const [dx, dy, dz] = direction;
  let crossings = 0, grazing = false;
  for (let f = 0; f < faces.length / 3; f++) {
    const i = faces[f * 3] * 3, j = faces[f * 3 + 1] * 3, k = faces[f * 3 + 2] * 3;
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const e1x = positions[j] - ax, e1y = positions[j + 1] - ay, e1z = positions[j + 2] - az;
    const e2x = positions[k] - ax, e2y = positions[k + 1] - ay, e2z = positions[k + 2] - az;
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = px - ax, sy = py - ay, sz = pz - az;
    const u = inv * (sx * hx + sy * hy + sz * hz);
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = inv * (dx * qx + dy * qy + dz * qz);
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    if (!(t > 1e-9)) continue;
    const edge = 1e-9;
    if (Math.abs(u) < edge || Math.abs(v) < edge || Math.abs(u + v - 1) < edge) {
      grazing = true;
    }
    if (u >= 0 && u <= 1 && v >= 0 && u + v <= 1) crossings++;
  }
  return { crossings, grazing };
}

/** Whether each point is inside the chamber, outside it, or on the wall.
 *
 * An open surface gets no verdict at all: a ray leaving through the hole
 * crosses nothing and every point reads as outside, which is how a whole map of
 * contact points ends up labelled as blood.
 */
export function pointStatus(xyz, positions, faces, toleranceMm = ON_SURFACE_MM) {
  const distance = distanceToSurface(xyz, positions, faces);
  const closed = meshClosure(positions, faces).closed;
  const status = [];

  for (let p = 0; p < xyz.length / 3; p++) {
    if (distance[p] <= toleranceMm) { status.push('on_surface'); continue; }
    if (!closed) { status.push('unknown'); continue; }
    let verdict = null;
    for (const direction of RAY_DIRECTIONS) {
      const length = Math.hypot(...direction);
      const { crossings, grazing } = castRay(
        xyz[p * 3], xyz[p * 3 + 1], xyz[p * 3 + 2], positions, faces,
        direction.map(x => x / length));
      if (!grazing) { verdict = crossings % 2 === 1; break; }
    }
    // Undecidable beats a coin toss.
    status.push(verdict === null ? 'unknown' : (verdict ? 'inside' : 'outside'));
  }
  return { status, distanceMm: distance, surfaceIsClosed: closed,
           toleranceMm };
}

/** Distance between two positions, straight or along the surface.
 *
 * The geodesic walks the mesh edges, which is an upper bound on the true
 * geodesic — a path along edges cannot cut across a face. Said so nobody quotes
 * it as exact.
 */
export function distanceBetween(a, b, positions = null, faces = null,
                                geodesic = false) {
  if (!geodesic) return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (!positions || !faces) throw new Error('a geodesic distance needs the surface');

  const n = positions.length / 3;
  const nearest = (p) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (positions[i * 3] - p[0]) ** 2 + (positions[i * 3 + 1] - p[1]) ** 2
              + (positions[i * 3 + 2] - p[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const start = nearest(a), goal = nearest(b);
  if (start === goal) return 0;

  const neighbours = new Map();
  const link = (i, j) => {
    const length = Math.hypot(positions[i * 3] - positions[j * 3],
                              positions[i * 3 + 1] - positions[j * 3 + 1],
                              positions[i * 3 + 2] - positions[j * 3 + 2]);
    if (!neighbours.has(i)) neighbours.set(i, []);
    neighbours.get(i).push([j, length]);
  };
  for (let f = 0; f < faces.length / 3; f++) {
    const v = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
    for (let e = 0; e < 3; e++) { link(v[e], v[(e + 1) % 3]); link(v[(e + 1) % 3], v[e]); }
  }

  const best = new Float64Array(n).fill(Infinity);
  best[start] = 0;
  const queue = [[0, start]];
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0]);
    const [cost, here] = queue.shift();
    if (here === goal) return cost;
    if (cost > best[here]) continue;
    for (const [other, length] of neighbours.get(here) || []) {
      const through = cost + length;
      if (through < best[other]) { best[other] = through; queue.push([through, other]); }
    }
  }
  // Two components of a broken mesh have no path between them, and infinity is
  // the honest answer rather than the straight-line distance.
  return Infinity;
}
