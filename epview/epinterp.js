/* Scattered mapping points onto the surface.
 *
 * OpenEP's generateInterpData. The Python side is epcore/epview/interpolate.py.
 *
 * A converted export arrives with the vendor's own interpolation already baked
 * in: their method, their radius, their rule for a vertex nobody measured, none
 * of it stated. Doing it here means a map built from the points with the
 * choices in the open.
 *
 * Inverse-distance weighting over the nearest few points, cut off at a radius.
 * Chosen over a radial basis fit because it cannot overshoot: an RBF through
 * noisy contact points will happily produce a voltage below zero or an
 * activation time outside the window, and a map with an impossible value in it
 * is worse than one with a hole.
 *
 * A vertex with no point within the radius gets NaN. Not the nearest value, not
 * zero, not the mean of the map: a chamber where one wall was never touched
 * should come out with that wall blank.
 */

/** How far a vertex may be from a point and still take a value from it, mm. */
export const RADIUS_MM = 10.0;

/** How many points a vertex takes its value from. */
export const NEIGHBOURS = 5;

export function interpolate(positions, faces, xyz, values,
                            { radiusMm = RADIUS_MM, neighbours = NEIGHBOURS } = {}) {
  if (xyz.length / 3 !== values.length) {
    throw new Error(`${xyz.length / 3} positions against ${values.length} values`);
  }
  const n = positions.length / 3;
  const field = new Float64Array(n).fill(NaN);

  // A measurement that is NaN is not a measurement.
  const px = [], pv = [];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    px.push([xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]);
    pv.push(values[i]);
  }
  if (!px.length || !n) {
    return { values: field, coverage: 0, sources: 0, radiusMm, geodesic: false };
  }

  const take = Math.min(neighbours, px.length);
  let covered = 0;
  const distances = new Array(px.length);
  for (let v = 0; v < n; v++) {
    const vx = positions[v * 3], vy = positions[v * 3 + 1], vz = positions[v * 3 + 2];
    for (let p = 0; p < px.length; p++) {
      distances[p] = [Math.hypot(vx - px[p][0], vy - px[p][1], vz - px[p][2]), p];
    }
    distances.sort((a, b) => a[0] - b[0]);

    let weighted = 0, total = 0;
    for (let k = 0; k < take; k++) {
      const [d, p] = distances[k];
      if (d > radiusMm) break;
      const w = 1 / Math.max(d, 1e-9) ** 2;
      weighted += w * pv[p];
      total += w;
    }
    if (total > 0) { field[v] = weighted / total; covered++; }
  }

  const coverage = covered / n;
  if (coverage < 0.5) {
    console.info(`[epview] interpolated ${px.length} point(s) onto `
      + `${(coverage * 100).toFixed(0)}% of the surface; the rest is further `
      + `than ${radiusMm} mm from any of them`);
  }
  return { values: field, coverage, sources: px.length, radiusMm, geodesic: false };
}
