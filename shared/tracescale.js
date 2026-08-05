/* How tall each trace is drawn.
 *
 * Every trace used to be normalised to its own 98th percentile, so each one
 * filled its lane whatever it carried. Measured on a real study: the surface
 * leads run 2.4 to 7 mV and a cryo channel 90 µV — drawn that way, the 90 µV
 * signal is as tall as lead III, and the amplitude comparison that tells a
 * low-voltage potential from a healthy one is gone.
 *
 * So one scale per group, which is how a lab reads them: all surface leads
 * share a gain, each catheter shares its own. Within a group the relative
 * heights are the signal's; between groups they are not comparable anyway,
 * because a surface lead and an intracardiac electrode do not measure the same
 * thing.
 *
 * Per-trace stays available. Hunting a small potential in one channel is a real
 * job, and for that the normalisation is the point rather than the problem.
 */

/** Above this a sample is the converter's limit, not the heart's signal. */
export const RAIL_LSB = 32000;

/** The floor. Below it the scale explodes and noise fills the lane. */
export const MIN_SCALE = 20;

/**
 * @param traces      [{index, group}], the traces being drawn
 * @param amplitude   index -> 98th percentile of |sample|, in LSB
 * @param perTrace    true for the old behaviour: each trace on its own scale
 * @returns index -> the value that should reach the top of the lane
 */
export function traceScales(traces, amplitude, { perTrace = false } = {}) {
  const out = {};
  if (perTrace) {
    for (const trace of traces) {
      out[trace.index] = Math.max(amplitude[trace.index] || 0, MIN_SCALE);
    }
    return out;
  }

  const byGroup = new Map();
  for (const trace of traces) {
    const value = amplitude[trace.index];
    if (!Number.isFinite(value)) continue;
    // A channel sitting at the rail is a disconnected input or a saturated
    // amplifier. Letting it set the group's scale would flatten every real
    // trace beside it — measured on a study where one channel sat at 32767
    // while its neighbours were at 2000.
    if (value >= RAIL_LSB) continue;
    const seen = byGroup.get(trace.group) || [];
    seen.push(value);
    byGroup.set(trace.group, seen);
  }

  const scaleOf = new Map();
  for (const [group, values] of byGroup) {
    values.sort((a, b) => a - b);
    // The largest of the group, not the mean: the tallest trace has to fit in
    // its lane, and everything quieter is then drawn to the same rule.
    scaleOf.set(group, Math.max(values[values.length - 1], MIN_SCALE));
  }

  for (const trace of traces) {
    const group = scaleOf.get(trace.group);
    // A group of nothing but railed channels falls back to its own value, so
    // it is drawn clipped rather than not at all.
    out[trace.index] = group ?? Math.max(amplitude[trace.index] || 0, MIN_SCALE);
  }
  return out;
}

export default { traceScales, RAIL_LSB, MIN_SCALE };
