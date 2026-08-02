/* How fast activation spreads across the surface.
 *
 * OpenEP's getConductionVelocity and cvHistogram. The Python side is
 * epcore/epview/conduction.py and the two are pinned to each other by
 * tests/python/epview/test_conduction_conformance.py — a wavefront that comes
 * out at one speed in the viewer and another on the command line is worse than
 * either being wrong alone.
 *
 * The gradient of the activation field is fitted per triangle, where a linearly
 * interpolated field has exactly one and it has a closed form, then averaged
 * onto the vertices weighted by area.
 *
 * Two things worth stating because they are easy to get backwards:
 *
 *  * A wavefront arrives *later* further along, so it travels **up** the time
 *    gradient. Pointing every vector the other way produces a map that looks
 *    entirely normal and is reversed.
 *  * A gradient near zero divides into thousands of millimetres per second,
 *    which is the annotation's resolution showing through rather than fast
 *    conduction. Those become NaN, not a clipped value: clipping piles the
 *    artefacts onto the edge of the plausible range and makes the histogram
 *    there look like a finding.
 */
import { triangleAreas } from './epmetrics.js?v=e9ff85e64fdc';

/** Velocities outside this are the annotation's resolution rather than tissue. */
export const PLAUSIBLE_MM_S = [10.0, 5000.0];

function cross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/** Conduction velocity per vertex in mm/s, with its direction. */
export function conductionVelocity(positions, faces, lat, bounds = PLAUSIBLE_MM_S) {
  const n = positions.length / 3;
  if (lat.length !== n) {
    throw new Error(`expected ${n} activation times, got ${lat.length}`);
  }
  const speed = new Float64Array(n).fill(NaN);
  const direction = new Float64Array(n * 3).fill(NaN);
  const faceCount = faces.length / 3;
  if (!faceCount) {
    return { speedMmS: speed, direction, measuredVertices: 0,
             implausibleVertices: 0, boundsMmS: bounds };
  }

  const summed = new Float64Array(n * 3);
  const total = new Float64Array(n);

  for (let f = 0; f < faceCount; f++) {
    const i = faces[f * 3], j = faces[f * 3 + 1], k = faces[f * 3 + 2];
    const ta = lat[i], tb = lat[j], tc = lat[k];
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || !Number.isFinite(tc)) continue;

    const ax = positions[i * 3], ay = positions[i * 3 + 1], az = positions[i * 3 + 2];
    const bx = positions[j * 3], by = positions[j * 3 + 1], bz = positions[j * 3 + 2];
    const cx = positions[k * 3], cy = positions[k * 3 + 1], cz = positions[k * 3 + 2];

    const nrm = cross(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
    const twice = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (!(twice > 0)) continue;
    const ux = nrm[0] / twice, uy = nrm[1] / twice, uz = nrm[2] / twice;

    // Perpendicular to each edge, in the plane of the triangle.
    const pa = cross(ux, uy, uz, cx - bx, cy - by, cz - bz);
    const pb = cross(ux, uy, uz, ax - cx, ay - cy, az - cz);
    const pc = cross(ux, uy, uz, bx - ax, by - ay, bz - az);
    const gx = (pa[0] * ta + pb[0] * tb + pc[0] * tc) / twice;
    const gy = (pa[1] * ta + pb[1] * tb + pc[1] * tc) / twice;
    const gz = (pa[2] * ta + pb[2] * tb + pc[2] * tc) / twice;

    const area = twice / 2;
    for (const vertex of [i, j, k]) {
      total[vertex] += area;
      summed[vertex * 3] += gx * area;
      summed[vertex * 3 + 1] += gy * area;
      summed[vertex * 3 + 2] += gz * area;
    }
  }

  let implausible = 0;
  for (let v = 0; v < n; v++) {
    if (!(total[v] > 0)) continue;
    const gx = summed[v * 3] / total[v];
    const gy = summed[v * 3 + 1] / total[v];
    const gz = summed[v * 3 + 2] / total[v];
    const magnitude = Math.hypot(gx, gy, gz);       // ms per mm
    if (!(magnitude > 0)) continue;
    const raw = 1000 / magnitude;                    // mm per second
    if (!Number.isFinite(raw)) continue;
    if (raw < bounds[0] || raw > bounds[1]) { implausible++; continue; }
    speed[v] = raw;
    // Along the gradient: later times are further along the wavefront.
    direction[v * 3] = gx / magnitude;
    direction[v * 3 + 1] = gy / magnitude;
    direction[v * 3 + 2] = gz / magnitude;
  }

  let measured = 0;
  for (let v = 0; v < n; v++) if (Number.isFinite(speed[v])) measured++;
  return { speedMmS: speed, direction, measuredVertices: measured,
           implausibleVertices: implausible, boundsMmS: [bounds[0], bounds[1]] };
}

/** How much surface conducts in each speed band. Weighted by area. */
export function velocityHistogram(positions, faces, speed, edges = null) {
  const cuts = (edges || [200.0, 400.0, 800.0]).map(Number);
  const areas = triangleAreas(positions, faces);
  const faceCount = faces.length / 3;

  const usable = new Uint8Array(faceCount);
  const mean = new Float64Array(faceCount);
  let measured = 0, unmeasured = 0;
  for (let f = 0; f < faceCount; f++) {
    const a = speed[faces[f * 3]], b = speed[faces[f * 3 + 1]], c = speed[faces[f * 3 + 2]];
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) {
      usable[f] = 1;
      mean[f] = (a + b + c) / 3;
      measured += areas[f];
    } else {
      unmeasured += areas[f];
    }
  }

  const bands = [];
  let lower = null;
  for (const edge of [...cuts, null]) {
    let area = 0;
    for (let f = 0; f < faceCount; f++) {
      if (!usable[f]) continue;
      const value = mean[f];
      const inside = edge === null
        ? value >= cuts[cuts.length - 1]
        : (lower === null ? value < edge : value >= lower && value < edge);
      if (inside) area += areas[f];
    }
    bands.push({ fromMmS: lower, toMmS: edge, areaMm2: area,
                 fraction: measured > 0 ? area / measured : null });
    lower = edge;
  }
  return { edgesMmS: cuts, bands, measuredMm2: measured, unmeasuredMm2: unmeasured };
}
