/* Ablation records out of a CARTO VisiTag export.
 *
 * OpenEP's importvisitag and read_visitag_sites. The Python side is
 * epcore/epview/ablation.py, and the format is not documented — what is
 * implemented here is what the corpus export actually contains:
 *
 *  * AblationSites.txt — sites with three timestamps and no coordinates
 *  * AblationData.txt — impedance, power and two temperatures over time
 *  * AdjustedPositions.txt — the coordinates, and empty in that export
 *
 * So the lesions can be measured and cannot be placed, and that is reported
 * rather than worked around: a lesion drawn at a guessed position is worse than
 * one not drawn.
 */

/** CARTO timestamps are milliseconds. */
export const MS_PER_SECOND = 1000;

/** A whitespace-aligned VisiTag table: one header row, then rows. */
export function parseTable(text) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return { header: [], rows: [] };
  return { header: lines[0].trim().split(/\s+/),
           rows: lines.slice(1).map(line => line.trim().split(/\s+/)) };
}

function statistics(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return {};
  return {
    mean: usable.reduce((a, b) => a + b, 0) / usable.length,
    min: Math.min(...usable), max: Math.max(...usable), n: usable.length,
  };
}

/** Sites with what was measured at each, from the three VisiTag files. */
export function readVisitag({ sites, data = "", positions = "" }) {
  const { header, rows } = parseTable(sites);
  const at = Object.fromEntries(header.map((name, i) => [name, i]));
  if (!("Session" in at) || !("ChannelID" in at) || !("SiteIndex" in at)) return [];

  const placed = new Map();
  const positionTable = parseTable(positions);
  const pat = Object.fromEntries(positionTable.header.map((name, i) => [name, i]));
  if (["Session", "ChannelID", "X", "Y", "Z"].every(name => name in pat)) {
    for (const row of positionTable.rows) {
      if ("Valid" in pat && !["1", "true", "True"].includes(row[pat.Valid])) continue;
      placed.set(`${row[pat.Session]},${row[pat.ChannelID]}`,
                 [Number(row[pat.X]), Number(row[pat.Y]), Number(row[pat.Z])]);
    }
  }

  const during = new Map();
  const dataTable = parseTable(data);
  const dat = Object.fromEntries(dataTable.header.map((name, i) => [name, i]));
  if (["TimeStamp", "Session", "ChannelID"].every(name => name in dat)) {
    for (const row of dataTable.rows) {
      const key = `${row[dat.Session]},${row[dat.ChannelID]}`;
      if (!during.has(key)) during.set(key, []);
      during.get(key).push({
        time: Number(row[dat.TimeStamp]),
        power: "Power" in dat ? Number(row[dat.Power]) : NaN,
        impedance: "Impedance" in dat ? Number(row[dat.Impedance]) : NaN,
        // The distal sensor is the one at the tissue; the proximal reads the
        // shaft and is not what anybody means by lesion temperature.
        temperature: "DistalTemperature" in dat ? Number(row[dat.DistalTemperature]) : NaN,
      });
    }
  }

  return rows.filter(row => row.length >= header.length).map(row => {
    const key = `${row[at.Session]},${row[at.ChannelID]}`;
    // From the moment the stability filter was first satisfied, not from
    // arrival: the approach adds seconds, in the direction that flatters the
    // ablation.
    const start = "FirstPosPassedFilterTimeStamp" in at
      ? Number(row[at.FirstPosPassedFilterTimeStamp]) : NaN;
    const end = "LastPosTimeStamp" in at ? Number(row[at.LastPosTimeStamp]) : NaN;
    const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? (end - start) / MS_PER_SECOND : null;

    const samples = (during.get(key) || []).filter(
      s => Number.isFinite(start) && Number.isFinite(end)
        && s.time >= start && s.time <= end);

    return {
      session: Number(row[at.Session]),
      channel: Number(row[at.ChannelID]),
      index: Number(row[at.SiteIndex]),
      durationS: duration,
      xyz: placed.get(key) || null,
      samples: samples.length,
      powerW: statistics(samples.map(s => s.power)),
      impedanceOhm: statistics(samples.map(s => s.impedance)),
      temperatureC: statistics(samples.map(s => s.temperature)),
    };
  });
}

/** The numbers a report quotes. `placed` is the first thing to look at. */
export function summarise(sites) {
  if (!sites || !sites.length) return { sites: 0, placed: 0, totalDeliveryS: null };
  const durations = sites.map(s => s.durationS).filter(Number.isFinite);
  return {
    sites: sites.length,
    placed: sites.filter(s => s.xyz).length,
    totalDeliveryS: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
    durationS: statistics(durations),
    powerW: statistics(sites.map(s => s.powerW.mean).filter(Number.isFinite)),
    impedanceOhm: statistics(sites.map(s => s.impedanceOhm.mean).filter(Number.isFinite)),
  };
}
