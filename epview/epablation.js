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
  const sorted = [...usable].sort((a, b) => a - b);
  return {
    mean: usable.reduce((a, b) => a + b, 0) / usable.length,
    // Der Median steht dabei, weil er für Abstände die ehrlichere Zahl ist:
    // die beiden Enden einer Kette haben nur einen Nachbarn und ziehen den
    // Mittelwert nach oben.
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0], max: sorted[sorted.length - 1], n: usable.length,
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

/* Wie dicht die Läsionen liegen, und wo die Linie aufhört, eine zu sein.
 *
 * Die Zahlen zu Dauer und Leistung sagen, wie kräftig abgegeben wurde; sie
 * sagen nichts darüber, ob dabei eine geschlossene Linie entstanden ist. Genau
 * das ist aber die Frage nach einer Isolation: eine Kette mit einer Lücke
 * leitet weiter, egal wie gut jede einzelne Stelle war.
 *
 * Gerechnet wird auf den verorteten Stellen; Stellen ohne Koordinaten fließen
 * nicht ein und werden gezählt, damit niemand eine Aussage über eine Linie
 * bekommt, von der die Hälfte nicht bekannt ist.
 */
const DEFAULT_GAP_MM = 6;

function distance(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Abstand jeder Läsion zur nächsten, in Millimetern, aufsteigend. */
export function neighbourDistances(sites) {
  const placed = (sites || []).filter(s => s.xyz).map(s => s.xyz);
  if (placed.length < 2) return [];
  const out = [];
  for (let i = 0; i < placed.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < placed.length; j++) {
      if (i === j) continue;
      const d = distance(placed[i], placed[j]);
      if (d < nearest) nearest = d;
    }
    out.push(nearest);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Zusammenhängende Ketten: Läsionen, die höchstens `maxGapMm` auseinander
 * liegen, gehören zur selben. Mehr als eine Kette heißt, dass die Linie an
 * mindestens einer Stelle unterbrochen ist.
 */
export function segments(sites, maxGapMm = DEFAULT_GAP_MM) {
  const placed = (sites || []).filter(s => s.xyz);
  const parent = placed.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (distance(placed[i].xyz, placed[j].xyz) <= maxGapMm) {
        const a = find(i), b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  placed.forEach((site, i) => {
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(site);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/**
 * Die Lücken: der kürzeste Weg zwischen je zwei Ketten, mit den beiden Stellen,
 * die ihn bilden. Das ist die Strecke, die geschlossen werden müsste.
 */
export function gaps(sites, maxGapMm = DEFAULT_GAP_MM) {
  const chains = segments(sites, maxGapMm);
  if (chains.length < 2) return [];
  const out = [];
  for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      let best = null;
      for (const a of chains[i]) {
        for (const b of chains[j]) {
          const d = distance(a.xyz, b.xyz);
          if (!best || d < best.mm) best = { mm: d, from: a, to: b };
        }
      }
      if (best) out.push(best);
    }
  }
  return out.sort((a, b) => a.mm - b.mm);
}

/** The numbers a report quotes. `placed` is the first thing to look at. */
/** Wieviel die Impedanz je Stelle gefallen ist, und wie oft kaum.
 *
 * Ein Abfall unter der Schwelle heißt nicht „keine Läsion" — er heißt, dass die
 * Abgabe an dieser Stelle nichts gezeigt hat, was auf eine hinweist. Deshalb
 * steht die Zahl der schwachen Stellen dabei und nicht ein Urteil.
 *
 * Nur aus einer Quelle: lokale Impedanz (DirectSense) und Generatorimpedanz
 * fallen um verschiedene Beträge, und ein Median über beide wäre eine Zahl über
 * nichts.
 */
export const WEAK_DROP_OHM = 5.0;

export function dropSummary(sites, weakOhm = WEAK_DROP_OHM) {
  const drops = (sites || []).map(s => s.impedanceDrop).filter(d => d && Number.isFinite(d.ohm));
  if (!drops.length) return null;
  const sources = new Set(drops.map(d => d.source));
  const source = sources.size === 1 ? [...sources][0] : 'mixed';
  const use = source === 'mixed'
    ? drops.filter(d => d.source === 'directsense')     // die lokale gewinnt
    : drops;
  return {
    source: source === 'mixed' ? 'directsense' : source,
    mixed: sources.size > 1,
    measured: use.length,
    ohm: statistics(use.map(d => d.ohm)),
    percent: statistics(use.map(d => d.percent)),
    weak: use.filter(d => d.ohm < weakOhm).length,
    weakOhm,
  };
}

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
    impedanceDrop: dropSummary(sites),
    // Ob daraus eine Linie geworden ist — siehe segments()/gaps().
    spacingMm: statistics(neighbourDistances(sites)),
    segments: sites.some(s => s.xyz) ? segments(sites).length : 0,
    largestGapMm: (() => {
      const found = sites.some(s => s.xyz) ? gaps(sites) : [];
      return found.length ? found[found.length - 1].mm : null;
    })(),
  };
}
