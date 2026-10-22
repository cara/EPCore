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
 *
 * A position belongs to a site by time, not by channel. AdjustedPositions.txt
 * is one row per sample (TimeStamp Session ChannelID X Y Z Valid), like
 * AblationData.txt, and every lesion of a procedure is made with the same
 * catheter — keyed by (Session, ChannelID) alone the last row wins and the
 * whole line collapses onto one point, with every site counted as placed.
 */

/** CARTO timestamps are milliseconds. */
export const MS_PER_SECOND = 1000;

/* A key cell is a whole number or names no site. Number() alone takes "1.0",
 * "0x10" and "1e3", which Python's reader refuses, so the two would keep
 * different sites. */
const INTEGER = /^[+-]?[0-9]+$/;

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
  const mid = Math.floor(sorted.length / 2);
  return {
    mean: usable.reduce((a, b) => a + b, 0) / usable.length,
    // Der Median steht dabei, weil er für Abstände die ehrlichere Zahl ist:
    // die beiden Enden einer Kette haben nur einen Nachbarn und ziehen den
    // Mittelwert nach oben. Bei gerader Anzahl die Mitte der beiden mittleren
    // Werte — der obere allein läge immer auf der Seite, die der Ablation
    // schmeichelt (größerer Impedanzabfall).
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0], max: sorted[sorted.length - 1], n: usable.length,
  };
}

/** Sites with what was measured at each, from the three VisiTag files.
 *
 * The array carries `skipped`: how many rows of AblationSites.txt named no site
 * because a key cell is not a whole number. A count beside the sites rather
 * than a different return value, as `unassignedPointTables` sits beside the
 * Rhythmia meshes — every caller reads this as a list of sites. */
export function readVisitag({ sites, data = "", positions = "" }) {
  const { header, rows } = parseTable(sites);
  const at = Object.fromEntries(header.map((name, i) => [name, i]));
  if (!("Session" in at) || !("ChannelID" in at) || !("SiteIndex" in at)) return [];

  const placed = new Map();
  const positionTable = parseTable(positions);
  const pat = Object.fromEntries(positionTable.header.map((name, i) => [name, i]));
  const timed = "TimeStamp" in pat;
  if (["Session", "ChannelID", "X", "Y", "Z"].every(name => name in pat)) {
    for (const row of positionTable.rows) {
      if ("Valid" in pat && !["1", "true", "True"].includes(row[pat.Valid])) continue;
      const xyz = [Number(row[pat.X]), Number(row[pat.Y]), Number(row[pat.Z])];
      // A row that is not numbers would turn the mean of its window into NaN.
      if (!xyz.every(Number.isFinite)) continue;
      const key = `${row[pat.Session]},${row[pat.ChannelID]}`;
      if (!placed.has(key)) placed.set(key, []);
      placed.get(key).push({ time: timed ? Number(row[pat.TimeStamp]) : NaN, xyz });
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

  const complete = rows.filter(row => row.length >= header.length);
  // Read anyway, a row with an unreadable key is a lesion with index NaN that
  // looks like every other one. Skipped and counted, the gap is visible — and
  // ablation.py skips the same rows.
  const readable = complete.filter(row =>
    [at.Session, at.ChannelID, at.SiteIndex].every(i => INTEGER.test(row[i])));
  const skipped = complete.length - readable.length;
  if (skipped) {
    console.warn(`[epview] ${skipped} row(s) of `
      + `AblationSites.txt skipped: Session, ChannelID or SiteIndex is not a whole number`);
  }

  // Over the readable rows only, as ablation.py counts the sites it read.
  const sitesOn = new Map();
  for (const row of readable) {
    const key = `${row[at.Session]},${row[at.ChannelID]}`;
    sitesOn.set(key, (sitesOn.get(key) || 0) + 1);
  }
  let ambiguous = 0;

  const out = readable.map(row => {
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

    // The site sits where the catheter was on average while it was made. A
    // site with no row in its window stays unplaced: a row recorded between
    // deliveries is where the catheter was moved through, not a lesion.
    const rowsOf = placed.get(key) || [];
    let near = [];
    if (timed) {
      near = rowsOf.filter(p => Number.isFinite(start) && Number.isFinite(end)
        && p.time >= start && p.time <= end);
    } else if (rowsOf.length && sitesOn.get(key) === 1) {
      // No clock to match on, and nothing else on this channel it could be.
      near = rowsOf;
    } else if (rowsOf.length) {
      ambiguous++;
    }
    const xyz = near.length
      ? [0, 1, 2].map(k => near.reduce((sum, p) => sum + p.xyz[k], 0) / near.length)
      : null;

    return {
      session: Number(row[at.Session]),
      channel: Number(row[at.ChannelID]),
      index: Number(row[at.SiteIndex]),
      durationS: duration,
      xyz,
      samples: samples.length,
      powerW: statistics(samples.map(s => s.power)),
      impedanceOhm: statistics(samples.map(s => s.impedance)),
      temperatureC: statistics(samples.map(s => s.temperature)),
    };
  });
  if (ambiguous) {
    try {
      console.warn(`[epablation] AdjustedPositions.txt hat keine TimeStamp-Spalte; `
        + `${ambiguous} Ablationsstelle(n) teilen sich einen Kanal und bleiben unverortet`);
    } catch (e) {}
  }
  // The console is no place for this: the viewer shows what it was handed, and
  // without the count fewer sites and less delivery time read as complete.
  out.skipped = skipped;
  return out;
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

function distanceSquared(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
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
 * The holes: for each pair of chains the shortest link between them that no
 * other lesion lies across, with the two sites that form it, ascending by
 * length. That is the stretch somebody would have to close.
 *
 * A lesion lies across a link when it is inside the sphere that has the link
 * as its diameter (|pa|² + |pb|² < |ab|², the Gabriel test), which is when it
 * sees the two ends of the link at more than a right angle. Along a straight line
 * every link from the first chain to the third has the middle chain inside its
 * sphere, so that pair has no hole: the span of half the line is not one.
 *
 * The links of a pair are tried shortest first until one is clear, because the
 * shortest is not always the hole. Round a ring the two chains beside a hole
 * can be closer to each other the other way round, past the chains between
 * them; that link is ruled out, and the longer one across the hole is clear.
 * Trying only the shortest link lost exactly this hole. A minimum spanning tree
 * over the chains loses the largest hole of every ring, since it drops the
 * longest link of every cycle, and that is the number shown as "größte Lücke".
 * The stricter lune test (a lesion closer than |ab| to both ends) drops ring
 * holes wider than about a third of the ring as well.
 *
 * Every spanning-tree link is the shortest of its pair and passes the test (a
 * lesion inside its sphere would close a cycle in which that link is the
 * longest), so it is the one taken for its pair, and the holes always connect
 * all chains.
 *
 * Limits. A lesion on a ring sees the ends of a hole at half the hole's arc.
 * - A ring broken into only two chains has both its holes between the same
 *   pair of chains and reports the smaller.
 * - A hole of half the ring or more is not reported: every other lesion sees
 *   its ends at a right angle or more.
 * - Short of that, the lesion next to either end of a hole lies outside the
 *   sphere by only a fraction of its spacing, a fraction that shrinks as the
 *   hole approaches half the ring, so scatter in the positions can put it
 *   inside, and then that hole is not reported either. The more scatter, the
 *   smaller the holes this reaches.
 * - An open line bent so far that some link between chains that do not follow
 *   each other along it has no lesion inside its sphere reports that span as a
 *   hole too; that errs towards a warning.
 */
export function gaps(sites, maxGapMm = DEFAULT_GAP_MM) {
  const chains = segments(sites, maxGapMm);
  if (chains.length < 2) return [];
  const placed = chains.flat();
  const inside = (p, { from, to, span }) => p !== from && p !== to
    && distanceSquared(p.xyz, from.xyz) + distanceSquared(p.xyz, to.xyz) < span;
  // The lesion that ruled out the last link. The next link, of this pair or
  // the next, mostly runs past the same lesions, so it is tested first; that
  // keeps the walk near the cost of testing one link per pair.
  let witness = null;
  const clear = (link) => {
    if (witness && inside(witness, link)) return false;
    const found = placed.find(p => inside(p, link));
    if (found) witness = found;
    return !found;
  };
  const out = [];
  for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      const links = [];
      for (const from of chains[i]) {
        for (const to of chains[j]) links.push({ span: distanceSquared(from.xyz, to.xyz), from, to });
      }
      links.sort((a, b) => a.span - b.span);
      const hole = links.find(clear);
      if (hole) out.push({ mm: Math.sqrt(hole.span), from: hole.from, to: hole.to });
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
