/* Reannotierung: was jemand an den Messpunkten einer Studie geändert hat.
 *
 * Hier wird nichts in eine Herstellerdatei geschrieben. Eine Reannotierung ist eine
 * eigene Datei neben der Studie (ADR-0009); dieses Modul ist ihr Format, ihre
 * Schlüssel und ihre Prüfung. Die Python-Seite ist `epcore/epview/annotations.py`,
 * und ein Konformanztest hält beide zusammen.
 *
 * Warum die Form so ist:
 *
 * **Der Verlauf ist die Wahrheit, `points` sein Ergebnis.** Den Verlauf von leer
 * abzuspielen muss genau den gespeicherten Stand ergeben, sonst wird die Datei
 * benannt abgelehnt. Eine Datei, die einen Stand trägt, den niemand herleiten kann,
 * ist von Hand bearbeitet — und ein Leser, der stillschweigend eine der beiden
 * Hälften vorzieht, würde raten, welche.
 *
 * **Ein Schlüssel ist nie ein Listenindex.** Gemessen am 2026-09-17: diese Seite
 * sortierte ihre fertige Punktliste numerisch nach `Point ID`, Python lieferte
 * Aufzählungsreihenfolge — bei zwei Karten mit derselben Kennung kam derselbe Export
 * hier als `1,1,2` und dort als `1,2,1` heraus. Ein Schlüssel benennt den Punkt
 * deshalb aus dem, was die *Datei* festlegt.
 *
 * **Ein Fingerabdruck ist ein Änderungsmelder, kein Sicherheitsmittel.** Er
 * beantwortet eine Frage: sind die Herstellerzahlen, gegen die diese Bearbeitung
 * gemacht wurde, noch die der Studie? Eine Leserkorrektur, die die Bedeutung einer
 * Spalte ändert, darf eine Bearbeitung nicht still auf eine andere Messung umhängen.
 *
 * **Kein Freitext.** Kein Name, keine Uhrzeit der Bearbeitung (sie läge Minuten neben
 * der Prozedurzeit), kein Pfad, und kein Kanalname, der nicht dem geprüften
 * Elektrodenpaar-Muster entspricht.
 */

/** Die Fassung, die dieser Stand schreibt und höchstens liest. */
export const VERSION = 1;

/** Wie ein Punkt je Hersteller benannt wird. Die Zeichenkette reist in der Datei mit,
 *  damit ein Stand, der eine Regel nicht kennt, ablehnt statt falsch zuzuordnen. */
export const KEYSPACES = {
  carto: 'carto:file_ordinal+id',
  ensite: 'ensite:column',
  rhythmia: 'rhythmia:table+row',
};

/** Was mit einem Punkt geschehen kann. Unbekanntes ist eine Ablehnung. */
export const OPERATIONS = ['set_lat', 'clear_lat', 'hide', 'show', 'exclude', 'include'];

/** Worin ein gesetzter Zeitpunkt steht — in der Größe des Herstellers, nie in
 *  Millisekunden: CARTOs Rate ist angenommen, und eine ms-wertige Datei würde diese
 *  Annahme dort einbacken, wo sie niemand mehr sieht. */
export const SPACES = {
  carto: 'carto:map_annotation',
  ensite: 'ensite:rov_lat_seconds',
  rhythmia: 'rhythmia:archive_seconds',
};

/** Wie ein Zeitpunkt zustande kam. */
export const BASES = ['manual', 'assisted:steepest_negative', 'assisted:peak'];

/** Ein Kanalname reist nur in dieser Form mit — als Elektrodenpaar. Alles andere ist
 *  Herstellertext, der getippt sein kann; dann bleibt nur der Index. */
export const CHANNEL_NAME = /^[A-Za-z0-9]{1,6}(-[A-Za-z0-9]{1,6})?$/;

/** Darüber ist der skalierte Wert nicht mehr exakt, und die beiden Sprachen würden
 *  verschieden runden. Ein Fingerabdruck darüber wird abgelehnt. */
export const CANON_LIMIT = 9e9;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** Eine Datei, die dieser Stand nicht als seine Annotationen lesen kann. */
export class AnnotationError extends Error {}

/** Eine Zahl als eine Zeichenkette, in beiden Sprachen dieselbe.
 *
 * `floor(x * 1e6 + 0.5)` und kein Formatierer: `"%.6f"` rundet zur geraden Ziffer,
 * `toFixed(6)` von der Null weg — die beiden gehen bei jeder exakten Hälfte
 * auseinander. Die Gefahr liegt auf der *Python*-Seite, deren `round` halb-zur-
 * geraden-Ziffer rundet (0.5 -> 0, 2.5 -> 2), während `Math.round` aufwärts geht;
 * `floor(x + 0.5)` ist in beiden Sprachen halb-aufwärts. Gemessen für ±5e-7,
 * ±2.5e-6, ±0 und 1.5.
 *
 * Hier hätte `Math.round(x * 1e6)` dasselbe getan — die beiden Formen trennen sich
 * in JS erst bei 4503599627370497 —, weshalb eine Verwechslung nur der
 * Konformanztest gegen Python auffängt und nicht die Tests dieser Seite.
 */
export function canon(value) {
  if (value === null || value === undefined) return 'null';
  const number = Number(value);
  if (!Number.isFinite(number)) return 'null';
  if (Math.abs(number) >= CANON_LIMIT) {
    throw new AnnotationError(
      `${number} ist zu groß für einen Fingerabdruck: über ${CANON_LIMIT} ist der `
      + 'skalierte Wert nicht mehr exakt, und zwei Leser würden ihn verschieden runden');
  }
  return String(Math.floor(number * 1e6 + 0.5));
}

/** FNV-1a über UTF-8, als sechzehn Hex-Ziffern.
 *
 * Zwanzig Zeilen, synchron, ohne Abhängigkeit — und überall verfügbar.
 * `crypto.subtle` ist das nicht: asynchron, und außerhalb eines sicheren Kontexts
 * gar nicht vorhanden, sodass eine aus einer Datei geöffnete Seite den Fingerabdruck
 * ganz verlöre.
 */
export function fnv1a64(text) {
  let digest = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    digest = ((digest ^ BigInt(byte)) * FNV_PRIME) & MASK64;
  }
  return digest.toString(16).padStart(16, '0');
}

/** `carto:<k>:<ID>` — die Stelle der Punktdatei in der Aufzählung und ihre eigene ID.
 *
 * Beide Hälften sind nötig: die ID allein wiederholt sich über Karten hinweg, die
 * Stelle allein ist eine Position — und genau darüber waren die beiden Leser uneins.
 */
export function cartoKey(fileOrdinal, pointId) {
  if (!(fileOrdinal >= 0)) {
    throw new AnnotationError(`eine Dateinummer ist nicht negativ: ${fileOrdinal}`);
  }
  return `carto:${Math.trunc(fileOrdinal)}:${pointId}`;
}

/** `ensite:<column>` — die DxL-Spalte, die ein Punkt in diesem Export *ist*. */
export function ensiteKey(column) {
  if (!(column >= 0)) {
    throw new AnnotationError(`eine DxL-Spalte ist nicht negativ: ${column}`);
  }
  return `ensite:${Math.trunc(column)}`;
}

/** `rhythmia:<hex>/<row>` — die maschinengenerierte Kennung der Tabellendatei und die
 *  rohe Zeile. Nicht die Blocknummer im Archiv: genau die zählen die beiden Leser
 *  verschieden. */
export function rhythmiaKey(tableHex, row) {
  if (!/^[0-9a-f]+$/.test(tableHex || '')) {
    throw new AnnotationError(
      `eine Rhythmia-Tabellenkennung ist maschinengeneriertes Hex, nicht ${JSON.stringify(tableHex)}`);
  }
  if (!(row >= 0)) {
    throw new AnnotationError(`eine Tabellenzeile ist nicht negativ: ${row}`);
  }
  return `rhythmia:${tableHex}/${Math.trunc(row)}`;
}

/** Die Studie, zu der eine Datei gehört: Hersteller, Schlüsselregel, Anzahl, Schlüssel.
 *  Trägt bewusst **keine Geometrie und keinen Namen** — sie muss einen Anatomiewechsel
 *  überstehen und darf keine Beschriftung in eine Datei bringen, die weiterreist. */
export function studyFingerprint(vendor, keys) {
  if (!KEYSPACES[vendor]) throw new AnnotationError(`keine Schlüsselregel für ${vendor}`);
  const ordered = [...keys].sort();
  return fnv1a64([vendor, KEYSPACES[vendor], String(ordered.length), ...ordered].join('⋮'));
}

/** Die Herstellerzahlen, gegen die eine Bearbeitung gemacht wurde, in ihrer Reihenfolge. */
export function pointFingerprint(values) {
  return fnv1a64(values.map(canon).join('⋮'));
}

function withoutDisplay(state) {
  if (state === null || state === undefined) return null;
  const out = {};
  for (const key of Object.keys(state).sort()) {
    if (key !== 'display') out[key] = state[key];
  }
  return JSON.stringify(out);
}

/** Die Annotationen einer Studie: der Verlauf und der Stand, zu dem er sich ausrechnet. */
export class AnnotationSet {
  constructor(vendor, studyFp) {
    if (!KEYSPACES[vendor]) throw new AnnotationError(`keine Schlüsselregel für ${vendor}`);
    this.vendor = vendor;
    this.studyFp = studyFp;
    this.log = [];
    // Nur im Speicher: ein Redo, das eine Sicherung überlebt, wäre ein Stand, den die
    // Datei nicht beschreibt.
    this._undone = [];
  }

  apply(op, key, fields = {}) {
    if (!OPERATIONS.includes(op)) {
      throw new AnnotationError(
        `unbekannte Operation ${JSON.stringify(op)}; dieser Stand kennt ${OPERATIONS.join(', ')}`);
    }
    const known = this.log.some((entry) => entry.key === key);
    const { fp = null, vendor = null, ...rest } = fields;
    if (known) {
      if (fp !== null || vendor !== null) {
        throw new AnnotationError(
          `${key} trägt seinen Schnappschuss schon aus dem ersten Eintrag; ein zweiter `
          + 'könnte dem ersten nur widersprechen');
      }
    } else if (fp === null || vendor === null) {
      throw new AnnotationError(
        `der erste Eintrag zu ${key} trägt die Herstellerwerte, gegen die er gemacht wurde `
        + '(fp und vendor), sonst lässt sich der Verlauf nicht in den Stand abspielen');
    }

    if (rest.channelName !== undefined && rest.channelName !== null
        && !CHANNEL_NAME.test(rest.channelName)) {
      // Ungeprüfter Herstellertext. Der Index ist die Identität, der Name nur eine
      // Bequemlichkeit — und nur in einer Form, die kein Personenname sein kann.
      rest.channelName = null;
    }

    const entry = { seq: this.log.length + 1, op, key, fp, vendor, ...rest };
    this.log.push(entry);
    this._undone.length = 0;
    return entry;
  }

  undo() {
    if (!this.log.length) return null;
    const entry = this.log.pop();
    this._undone.push(entry);
    return entry;
  }

  redo() {
    if (!this._undone.length) return null;
    const entry = this._undone.pop();
    entry.seq = this.log.length + 1;
    this.log.push(entry);
    return entry;
  }

  /** Von leer abspielen. Der letzte Schreiber je (Schlüssel, Eigenschaft) gewinnt. */
  materialise() {
    const points = {};
    for (const entry of [...this.log].sort((a, b) => a.seq - b.seq)) {
      if (!points[entry.key]) {
        points[entry.key] = {
          fp: entry.fp, vendor: entry.vendor, hidden: false, excluded: false,
        };
      }
      const state = points[entry.key];
      if (entry.op === 'set_lat') {
        state.lat = {
          space: entry.space ?? null, value: entry.value ?? null,
          basis: entry.basis ?? null, channel: entry.channel ?? null,
        };
      } else if (entry.op === 'clear_lat') delete state.lat;
      else if (entry.op === 'hide') state.hidden = true;
      else if (entry.op === 'show') state.hidden = false;
      else if (entry.op === 'exclude') state.excluded = true;
      else if (entry.op === 'include') state.excluded = false;
    }
    return points;
  }

  state(key) {
    const found = this.materialise()[key];
    return found === undefined ? null : found;
  }

  /** Der wirksame Zeitpunkt: die Bearbeitung, wenn es eine gibt, sonst der des Herstellers. */
  latOf(key, vendorValue = null) {
    const state = this.state(key);
    return state && state.lat ? state.lat.value : vendorValue;
  }

  /** Diese Datei gegen eine Studie: welche Bearbeitungen noch gelten und welche nicht.
   *
   * `fingerprints` bildet Schlüssel auf den Fingerabdruck der *heutigen* Herstellerwerte
   * ab. Fehlt es, wird die kleinere Frage beantwortet ("hat diese Studie diese Punkte
   * überhaupt") — und das steht dann auch im Ergebnis, statt dass ein leeres `stale`
   * als "nichts ist veraltet" gelesen wird.
   */
  verify(keys, fingerprints = null) {
    const counted = new Map();
    for (const key of keys) counted.set(key, (counted.get(key) || 0) + 1);
    const duplicate = [...counted.entries()].filter(([, n]) => n > 1)
      .map(([key]) => key).sort();

    const materialised = this.materialise();
    const known = new Set(keys);
    const unknown = Object.keys(materialised).filter((k) => !known.has(k)).sort();
    const matched = Object.keys(materialised).filter((k) => known.has(k)).sort();

    let stale = [];
    if (fingerprints) {
      stale = matched.filter((key) => {
        const now = fingerprints[key];
        return now !== undefined && now !== null && materialised[key].fp !== now;
      }).sort();
    }

    return {
      ok: matched.filter((k) => !stale.includes(k) && !duplicate.includes(k)),
      unknown,
      duplicate,
      stale,
      checkedAgainstValues: Boolean(fingerprints),
    };
  }

  toJson() {
    const points = this.materialise();
    const log = this.log.map((entry) => {
      const out = { seq: entry.seq, op: entry.op, key: entry.key };
      for (const [from, to] of [['space', 'space'], ['value', 'value'], ['basis', 'basis'],
                                ['channel', 'channel'], ['channelName', 'channel_name'],
                                ['fp', 'fp'], ['vendor', 'vendor']]) {
        if (entry[from] !== undefined && entry[from] !== null) out[to] = entry[from];
      }
      return out;
    });
    return {
      epcore_annotations: VERSION,
      study: {
        vendor: this.vendor, keyspace: KEYSPACES[this.vendor],
        points: Object.keys(points).length, fp: this.studyFp,
      },
      revision: this.log.length,
      log,
      points,
    };
  }

  /** Eine Datei lesen — und eine, die sich widerspricht, ablehnen.
   *
   * Nichts davon wird repariert: eine von Hand bearbeitete Datei ist keine, deren
   * Absicht sich erraten lässt.
   */
  static fromJson(data) {
    if (data.epcore_annotations !== VERSION) {
      throw new AnnotationError(
        `diese Annotationsdatei ist Version ${data.epcore_annotations}; dieses EPCore `
        + `liest bis ${VERSION}`);
    }
    const study = data.study || {};
    if (!KEYSPACES[study.vendor]) {
      throw new AnnotationError(`unbekannter Hersteller ${JSON.stringify(study.vendor)}`);
    }
    if (study.keyspace !== KEYSPACES[study.vendor]) {
      throw new AnnotationError(
        `diese Datei benennt Punkte nach einer Regel, die dieser Stand nicht kennt `
        + `(${JSON.stringify(study.keyspace)})`);
    }
    const entries = data.log || [];
    if (data.revision !== entries.length) {
      throw new AnnotationError(
        `Revision ${data.revision} gegen ${entries.length} Verlaufseinträge: die Datei `
        + 'widerspricht sich');
    }

    const out = new AnnotationSet(study.vendor, study.fp || '');
    for (const raw of [...entries].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
      if (!OPERATIONS.includes(raw.op)) {
        throw new AnnotationError(
          `Eintrag ${raw.seq} ist ein ${JSON.stringify(raw.op)}, den dieser Stand nicht kennt`);
      }
      out.log.push({
        seq: raw.seq, op: raw.op, key: raw.key,
        space: raw.space ?? null, value: raw.value ?? null, basis: raw.basis ?? null,
        channel: raw.channel ?? null, channelName: raw.channel_name ?? null,
        fp: raw.fp ?? null, vendor: raw.vendor ?? null,
      });
    }

    const stored = data.points || {};
    const replayed = out.materialise();
    const differing = [...new Set([...Object.keys(stored), ...Object.keys(replayed)])]
      .filter((key) => withoutDisplay(stored[key]) !== withoutDisplay(replayed[key]))
      .sort();
    if (differing.length) {
      throw new AnnotationError(
        'die Datei widerspricht sich: der Verlauf ergibt einen anderen Stand als die '
        + `gespeicherte Liste (${differing.length} Punkt(e): ${differing.slice(0, 3).join(', ')})`);
    }
    return out;
  }
}


/* --- was die Seite braucht, hier, weil es hier geprüft werden kann ---------
 *
 * Diese drei Entscheidungen lagen zuerst in `index.html`. Dort kann `node --test`
 * sie nicht anfassen: jede andere JS-Testdatei importiert ein Modul, nur der
 * i18n-Wächter liest die Seite als Text. Eine Regel, die nur ein Browsertest
 * prüfen kann, ist in einem opt-in-Lauf geprüft — und der lief hier nicht einmal,
 * weil Playwright nicht installiert ist. Also stehen sie hier und die Seite ruft
 * sie auf.
 */

/** Welcher Schlüsselraum gilt für eine Studie — und gilt überhaupt einer?
 *
 * Nur CARTO ist freigegeben: seine Aufzählung ist durch einen Konformanztest
 * gebunden. Die anderen werden benannt gesperrt, statt auf einer Reihenfolge zu
 * annotieren, die nichts festhält.
 */
export function vendorOf(source) {
  return source === 'carto' ? 'carto' : null;
}

/** Die Schlüssel einer CARTO-Studie, in Aufzählungsreihenfolge. */
export function keysOf(points) {
  return (points || []).map((point, index) => cartoKey(index, String(point.id)));
}

/** Warum für diese Studie nicht annotiert werden kann — oder null.
 *
 * Gibt `{ reason, count }` zurück: der i18n-Schlüssel und die Zahl, die in ihm
 * steht. Ein Grund ohne Zahl hat `count: 0`.
 */
export function lockReason(source, points) {
  if (!points || !points.length) {
    return points ? { reason: 'map.annot.nopoints', count: 0 } : null;
  }
  if (!vendorOf(source)) {
    if (source === 'rhythmia') return { reason: 'map.annot.rhythmia.later', count: 0 };
    if (source === 'ensite') return { reason: 'map.annot.ensite.later', count: 0 };
    return null;
  }
  try {
    keysOf(points);
  } catch (err) {
    return { reason: 'map.annot.carto.badnames', count: 0 };
  }
  // Hier wird **nicht** auf doppelte Schlüssel geprüft, und das ist gemessen:
  // der erste Teil eines CARTO-Schlüssels ist die Stelle in der Aufzählung, also
  // sind zwei davon konstruktionsbedingt verschieden — zwei Karten mit derselben
  // `Point ID` ergeben `carto:0:1` und `carto:2:1`. Ein Zweig dafür wäre toter
  // Code, der aussieht wie ein Schutz.
  //
  // `AnnotationSet.verify` prüft es trotzdem, und zu Recht: dort kommen die
  // Schlüssel aus einer *Datei*, nicht aus dieser Aufzählung, und was eine Datei
  // behauptet, ist keine Eigenschaft dieser Studie.
  return null;
}

/** Welche Zeilen die Liste zeigt: angefasste Punkte plus die Auswahl, gefenstert.
 *
 * Nie alle. Eine gemessene Rhythmia-Studie trägt 19 615 Punkte, und so viele
 * Zeilen im DOM machen die Seite unbedienbar.
 */
export const LIST_WINDOW = 200;

export function listRows(set, keys, points, { filter = 'changed', selection = new Set(),
                                              limit = LIST_WINDOW } = {}) {
  if (!set || !keys) return [];
  const state = set.materialise();
  const rows = [];
  for (let index = 0; index < keys.length && rows.length < limit; index++) {
    const key = keys[index];
    const point = (points || [])[index] || null;
    const touched = state[key];
    const selected = selection.has(key);
    if (filter === 'changed' && !touched && !selected) continue;
    rows.push({
      key, point, selected,
      hidden: Boolean(touched && touched.hidden),
      excluded: Boolean(touched && touched.excluded),
      lat: touched && touched.lat ? touched.lat : null,
      placed: Boolean(point && point.xyz),
      signal: Boolean(point && point.egmName),
    });
  }
  return rows;
}

/** Die Herstellerwerte eines Punktes als Fingerabdruck.
 *
 * Dieselben Größen in derselben Reihenfolge wie auf der Python-Seite
 * (`annotations._fingerprints`), sonst ist der Abgleich beim Laden wertlos.
 */
export function vendorFingerprint(point) {
  const xyz = (point && point.xyz) || [null, null, null];
  return pointFingerprint([
    xyz[0] ?? null, xyz[1] ?? null, xyz[2] ?? null,
    point ? (point.mapAnnotation ?? null) : null,
    point ? (point.referenceAnnotation ?? null) : null,
    point ? (point.bipolarMv ?? null) : null,
  ]);
}
