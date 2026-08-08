/* =====================================================================
 *  epconv.js — Browser-seitige EP-Mapping-Konverter (Rhythmia / CARTO / EnSite)
 *  Portiert aus rhythmia_to_3d.py / carto_to_3d.py / ensite_to_3d.py.
 *
 *  Jeder Parser liefert eine Liste von Mesh-Objekten:
 *    { name, positions:Float32Array(n*3), normals:Float32Array(n*3)|null,
 *      faces:Uint32Array(m*3), scalars:{ name: Float32Array(n) } }
 *
 *  Exporter erzeugen PLY/OBJ (String) bzw. STL (ArrayBuffer).
 *  Reines ES-Modul ohne DOM-Abhängigkeit (DOMParser ist Standard in Browsern;
 *  in Node via Fallback). fflate (ZIP) wird nur für CARTO benötigt und per
 *  Parameter injiziert, damit das Modul ohne Bundler testbar bleibt.
 * ===================================================================== */

import { hexToRgb, parseXyz, tagCategoryColor, assignTagsToMeshes, decodeTagComment } from './epmap.js?v=4ea77b9f51d2';
import { readVisitag, summarise as summariseAblation } from './epablation.js?v=4ea77b9f51d2';

const SENTINEL = 1e4;

/* ------------------------------- Helpers ------------------------------- */

function cleanScalar(arr) {
  // Sentinels (|v|>=1e4, z.B. -10000) und inf -> NaN (im Viewer grau).
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = (!Number.isFinite(v) || Math.abs(v) >= SENTINEL) ? NaN : v;
  }
  return out;
}

function fitToVertexCount(arr, n) {
  if (arr && arr.length === n) return arr;
  const out = new Float32Array(n).fill(NaN);
  if (arr) out.set(arr.subarray(0, Math.min(arr.length, n)));
  return out;
}

// latin1-Dekodierung ganzer Byte-Bereiche (1 Byte -> 1 Zeichen), nativ + schnell.
const _latin1 = new TextDecoder('latin1');
function decodeLatin1(u8) { return _latin1.decode(u8); }

// Byte-Suche (für die Rhythmia-Extraktion, ohne das ganze Archiv zu stringifizieren)
function indexOfBytes(buf, needle, from) {
  const n = needle.length, last = buf.length - n;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < n; j++) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// Float32/Int32 aus einem (ggf. unausgerichteten) Uint8Array, little-endian
function asFloat32(u8) { return new Float32Array(u8.slice().buffer); }
function asInt32(u8) { return new Int32Array(u8.slice().buffer); }

function textToRows(text, cols) {
  // Zeilen mit Zahlen -> Array von Float-Arrays (nur die ersten `cols` Spalten,
  // falls angegeben). Leere Zeilen / Kommentare (; #) werden übersprungen.
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const vals = [];
    for (const p of parts) { const f = parseFloat(p); if (!Number.isNaN(f) || p === 'NaN' || p === 'nan') vals.push(f); }
    if (vals.length) rows.push(vals);
  }
  return rows;
}

function getDOMParser() {
  if (typeof DOMParser !== 'undefined') return new DOMParser();
  return null; // Node ohne DOM: Tests nutzen die Text-Parser direkt
}

function* iterTag(el, tag) {
  const T = tag.toUpperCase();
  for (const c of el.children) {
    if (c.tagName && c.tagName.toUpperCase() === T) yield c;
    yield* iterTag(c, tag);
  }
}
function firstTag(el, tag) { for (const c of iterTag(el, tag)) return c; return null; }

// Tolerantes Parsen: erst echtes XML; schlägt das fehl (z. B. unvollständiges
// Archiv -> nicht geschlossene Tags), wird der HTML-Parser genutzt, der offene
// Tags automatisch schließt. So bleibt ein früh im Archiv liegendes Mesh nutzbar.
function parseXmlTolerant(xml) {
  const dp = getDOMParser();
  if (!dp) throw new Error('DOMParser nicht verfügbar (Browser erforderlich).');
  let doc = dp.parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    doc = dp.parseFromString(xml, 'text/html');
  }
  return doc;
}

/* ===================================================================== *
 *  Rhythmia
 * ===================================================================== */

const HTML_ENTITIES = {
  '&nbsp;': ' ', '&auml;': 'ä', '&ouml;': 'ö', '&uuml;': 'ü', '&Auml;': 'Ä',
  '&Ouml;': 'Ö', '&Uuml;': 'Ü', '&szlig;': 'ß', '&aacute;': 'á', '&eacute;': 'é',
  '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ', '&copy;': '©',
  '&reg;': '®', '&deg;': '°', '&micro;': 'µ', '&plusmn;': '±',
};

function sanitizeXml(xml) {
  for (const [e, r] of Object.entries(HTML_ENTITIES)) xml = xml.split(e).join(r);
  // restliche undefinierte &wort; entfernen (nicht &amp;&lt;&gt;&quot;&apos;&#..)
  return xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)(\w+);/g, '$1');
}

// Trennt Inline-Binärdaten heraus, OHNE das ganze (oft mehrere 100 MB große,
// überwiegend binäre) Archiv zu stringifizieren: es werden nur die XML-Text-
// Stücke zwischen den Binärblöcken nach latin1 dekodiert; die Binärblöcke
// bleiben Byte-Views (kein Kopieren) und werden beim Scannen übersprungen.
// Liefert sauberes XML (Payload -> Index als Textinhalt) + Liste der Payloads.
const _OPEN = new Uint8Array([0x3c,0x69,0x6e,0x6c,0x69,0x6e,0x65,0x64,0x62,0x69,0x6e,0x20]); // "<inlinedbin "
const _GT = 0x3e; // '>'
export function extractRhythmia(bytes) {
  const payloads = [];
  const out = [];
  let pointer = 0;
  while (true) {
    const ts = indexOfBytes(bytes, _OPEN, pointer);
    if (ts < 0) { out.push(decodeLatin1(bytes.subarray(pointer))); break; }
    let te = ts;
    while (te < bytes.length && bytes[te] !== _GT) te++;
    if (te >= bytes.length) { out.push(decodeLatin1(bytes.subarray(pointer))); break; }
    te++; // '>' einschließen
    const tag = decodeLatin1(bytes.subarray(ts, te));
    const m = tag.match(/\sBIN="?(\d+)/);  // BIN=123 oder BIN="123" (als eigenes Attribut)
    if (!m) {
      throw new Error('inlinedbin-Tag ohne erkennbare BIN-Länge bei Byte ' + ts +
        ': »' + tag.slice(0, 160) + '«');
    }
    const binLen = parseInt(m[1], 10);
    const binEnd = te + binLen;
    if (binEnd > bytes.length) {
      // Unvollständiges Archiv: Tail ignorieren, mit dem Vorhandenen weiter.
      try { console.warn(`[epconv] Block BIN=${binLen} bei Byte ${ts} reicht über das ` +
        `Dateiende — fehlende Teildatei. Rest wird ignoriert.`); } catch (e) {}
      out.push(decodeLatin1(bytes.subarray(pointer, ts)));  // XML-Text vor dem Block behalten
      break;
    }
    out.push(decodeLatin1(bytes.subarray(pointer, te)));  // XML inkl. Open-Tag (klein)
    out.push(String(payloads.length));                    // Payload -> Index
    payloads.push(bytes.subarray(te, binEnd));            // Byte-View, kein Kopieren
    pointer = binEnd;                                     // Binärblock überspringen
  }
  let xml = out.join('');   // enthält nur XML-Text (klein), keine Binärdaten
  xml = xml.replace(/BIN=([0-9]+)/g, 'BIN="$1"');
  xml = sanitizeXml(xml);
  return { xml, payloads };
}

function mat4FromText(text) {
  const nums = text.trim().split(/\s+/).map(Number);
  if (nums.length < 16) return null;
  // Python: reshape(4,4).T  -> Spalten-Major
  const M = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) M[c][r] = nums[r*4 + c];
  return M;
}
function applyMat4(M, x, y, z) {
  return [
    M[0][0]*x + M[0][1]*y + M[0][2]*z + M[0][3],
    M[1][0]*x + M[1][1]*y + M[1][2]*z + M[1][3],
    M[2][0]*x + M[2][1]*y + M[2][2]*z + M[2][3],
  ];
}
function inv3T(M) {
  // inverse-transpose der oberen 3x3 (für Normalen)
  const a=M[0][0],b=M[0][1],c=M[0][2],d=M[1][0],e=M[1][1],f=M[1][2],g=M[2][0],h=M[2][1],i=M[2][2];
  const det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g);
  if (!det || !Number.isFinite(det)) return [[a,b,c],[d,e,f],[g,h,i]];
  const inv = [
    [(e*i-f*h)/det, (c*h-b*i)/det, (b*f-c*e)/det],
    [(f*g-d*i)/det, (a*i-c*g)/det, (c*d-a*f)/det],
    [(d*h-e*g)/det, (b*g-a*h)/det, (a*e-b*d)/det],
  ];
  // transpose
  return [[inv[0][0],inv[1][0],inv[2][0]],[inv[0][1],inv[1][1],inv[2][1]],[inv[0][2],inv[1][2],inv[2][2]]];
}

// Direct-child lookups (case-insensitive, like iterTag — the tolerant HTML parser
// lower-cases tag names, so compare upper-cased).
function childByTag(el, name) {
  const T = name.toUpperCase();
  for (const c of el.children) if (c.tagName && c.tagName.toUpperCase() === T) return c;
  return null;
}
function childrenByTag(el, name) {
  const T = name.toUpperCase(), out = [];
  for (const c of el.children) if (c.tagName && c.tagName.toUpperCase() === T) out.push(c);
  return out;
}
function elText(el) { return el && el.textContent != null ? el.textContent.trim() : ''; }

// Rhythmia tags: manual <AnnotationPointSet>/<AnnotationPoint> groups + ablation
// <AutoAnnotationPoint>. Returns [{ id, label, category, color:[r,g,b], points:[{position,label}] }].
function extractRhythmiaTags(root) {
  const groups = [];
  for (const set of iterTag(root, 'AnnotationPointSet')) {
    const props = childByTag(set, 'Properties');
    const label = (props && (elText(childByTag(props, 'OverrideLabel')) || elText(childByTag(props, 'Label')))) || 'Annotation';
    const colorHex = props && elText(childByTag(props, 'Color'));
    const color = (colorHex && hexToRgb(colorHex)) || tagCategoryColor('annotation');
    const points = [];
    for (const ap of childrenByTag(set, 'AnnotationPoint')) {
      const xyzEl = childByTag(ap, 'xyz'); if (!xyzEl) continue;
      const pos = parseXyz(elText(xyzEl)); if (!pos) continue;
      const ppr = childByTag(ap, 'Properties');
      const plabel = (ppr && (elText(childByTag(ppr, 'OverrideLabel')) || elText(childByTag(ppr, 'Label')))) || '';
      const ts = ppr && (elText(childByTag(ppr, 'Timestamp'))
                     || elText(childByTag(ppr, 'StartTime')));
      points.push({ position: pos, label: plabel,
                    time: ts != null && ts !== '' ? Number(ts) : null });
    }
    if (points.length) groups.push({ id: (set.getAttribute && set.getAttribute('id')) || label, label, category: 'annotation', color, points });
  }
  const abl = [];
  for (const ap of iterTag(root, 'AutoAnnotationPoint')) {
    const xyzEl = childByTag(ap, 'xyz'); if (!xyzEl) continue;
    const pos = parseXyz(elText(xyzEl)); if (!pos) continue;
    const ppr = childByTag(ap, 'Properties');
    const seq = ppr && elText(childByTag(ppr, 'SequenceNumber'));
    const ats = ppr && (elText(childByTag(ppr, 'Timestamp'))
                    || elText(childByTag(ppr, 'StartTime')));
    abl.push({ position: pos, label: seq ? ('Abl ' + seq) : 'Abl',
               time: ats != null && ats !== '' ? Number(ats) : null,
               // Was an dieser Stelle gemessen wurde. Bisher wurde nur der Ort
               // gelesen und der Rest weggeworfen — dabei steht hier alles, was
               // eine Läsion beschreibt: Dauer, Kraft-Zeit-Integral, Impedanz,
               // Leistung und Temperatur des Generators.
               ablation: rhythmiaLesion(ppr, pos, seq) });
  }
  if (abl.length) groups.unshift({ id: 'ablation', label: 'Ablation', category: 'ablation', color: tagCategoryColor('ablation'), points: abl });
  return groups;
}

/* Die Messungen, aus denen die Karte gebaut ist.
 *
 * Nicht die Annotationspunkte — die hat der Untersucher gesetzt, und in der
 * vermessenen Studie sind es 191. Die Karte selbst steht auf 19 615 Messungen
 * allein in Map1: eine Elektrode des Korbs auf einem akzeptierten Schlag.
 *
 * `Map<n>/surfelec_<id>_all.dat`, Float64, 28 Spalten je Zeile, **zeilenweise**
 * gespeichert — anders als die Signalblöcke, und genau da biegt ein Leser
 * falsch ab. Welche Spalte was trägt, steht in
 * docs/findings/rhythmia-mapping-points.md; die tragenden Punkte sind dort
 * jeweils gegen etwas geprüft.
 */
const SURFELEC_NAME = /surfelec_[0-9a-f]+_all\.dat$/;
const SURFELEC_COLS = 28;
const SURFELEC = { time: 0, xyz: 1, spline: 4, onSpline: 5, electrode: 6,
                   latBipolar: 7, latUnipolar: 8, mvBipolar: 9, mvUnipolar: 10,
                   surface: 21, normal: 24, included: 27 };

async function extractRhythmiaMappingPoints(root, getPayload) {
  const groups = [];
  for (const el of iterTag(root, 'inlinedbin')) {
    const fname = el.getAttribute && el.getAttribute('fname');
    if (!fname || !SURFELEC_NAME.test(fname)) continue;
    if (el.getAttribute('type') !== 'Float64') continue;
    const cols = parseInt(el.getAttribute('cols'), 10);
    const rows = parseInt(el.getAttribute('rows'), 10);
    // Eine andere Breite ist eine andere Tabelle. Sie trotzdem so zu lesen
    // ergibt Zahlen, die wie Koordinaten aussehen und keine sind.
    if (cols !== SURFELEC_COLS || !rows) continue;
    const idx = parseInt((el.textContent || '').trim(), 10);
    if (!Number.isFinite(idx)) continue;
    const bytes = await getPayload(idx);
    if (!bytes || bytes.length < rows * cols * 8) continue;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = (row, col) => view.getFloat64((row * cols + col) * 8, true);
    const map = fname.indexOf('/') > 0 ? fname.slice(0, fname.indexOf('/')) : 'Map';
    const points = [];
    for (let r = 0; r < rows; r++) {
      // Der auf die Anatomie gezogene Ort, nicht der gemessene: der liegt in
      // der vermessenen Studie im Median 0,50 mm von der Fläche entfernt, und
      // Marker daneben sehen aus wie ein Registrierungsfehler.
      const position = [at(r, SURFELEC.surface), at(r, SURFELEC.surface + 1),
                        at(r, SURFELEC.surface + 2)];
      if (!position.every(Number.isFinite)) continue;
      let lat = at(r, SURFELEC.latBipolar);
      if (!Number.isFinite(lat)) lat = at(r, SURFELEC.latUnipolar);
      const electrode = at(r, SURFELEC.electrode);
      points.push({
        position,
        label: `${map} · E${Number.isFinite(electrode) ? electrode : '?'}`,
        time: at(r, SURFELEC.time),
        // Der gespeicherte Wert ist ein Abtastindex ins Schlagfenster, keine
        // Millisekunde — 1…271 bei 272 Werten. Die Umrechnung braucht die Rate
        // und passiert dort, wo die Zeitachse bekannt ist.
        latSamples: Number.isFinite(lat) ? lat : null,
        bipolarMv: at(r, SURFELEC.mvBipolar),
        unipolarMv: at(r, SURFELEC.mvUnipolar),
        electrode: Number.isFinite(electrode) ? electrode : null,
        included: at(r, SURFELEC.included) !== 0,
      });
    }
    if (points.length) {
      groups.push({ id: `mapping-${map}`, label: `${map} · Messpunkte`,
                    category: 'measurement', color: tagCategoryColor('measurement'),
                    points });
    }
  }
  return groups;
}

/** Eine Rhythmia-Läsion in derselben Form, die die VisiTag-Auswertung erwartet.
 *
 * Damit rechnen Abstände, Ketten und Lücken (epablation.js) für Rhythmia
 * genauso wie für CARTO — es wäre albern, dieselbe Frage zweimal verschieden zu
 * beantworten, nur weil die Datei anders heißt.
 *
 * `FTI` ist Rhythmias Kraft-Zeit-Integral und hat bei CARTO keine Entsprechung;
 * es reist unter eigenem Namen mit, statt in ein fremdes Feld gezwängt zu werden.
 */
function rhythmiaLesion(props, position, sequence) {
  const num = (name) => {
    const text = props && elText(childByTag(props, name));
    const value = text === '' || text == null ? NaN : Number(text);
    return Number.isFinite(value) ? value : NaN;
  };
  const stat = (value) => (Number.isFinite(value) ? { mean: value, min: value, max: value, n: 1 } : {});
  return {
    index: sequence ? Number(sequence) : null,
    xyz: position,
    durationS: num('Duration'),
    ftiGs: num('FTI'),
    powerW: stat(num('GeneratorMedianPower')),
    impedanceOhm: stat(num('GeneratorImpedanceBase')),
    temperatureC: stat(num('GeneratorTemperatureMax')),
    impedanceDrop: impedanceDrop(num('DirectSenseImpedanceBase'), num('DirectSenseImpedanceMin'),
                                 num('GeneratorImpedanceBase'), num('GeneratorImpedanceMin')),
  };
}

/** Wie weit die Impedanz während der Abgabe gefallen ist.
 *
 * Rhythmia legt zwei Paare ab, und sie messen nicht dasselbe:
 *
 * * **DirectSense** ist die lokale Impedanz an der Katheterspitze. Sie ist das
 *   Maß, an dem sich beurteilen lässt, ob an *dieser* Stelle Gewebe erhitzt
 *   wurde — im gemessenen Punkt 146,5 → 130,6 Ω, also 15,9 Ω oder 10,9 %.
 * * **Generator** ist die Impedanz des ganzen Stromkreises, Rückenelektrode
 *   eingerechnet. Sie fällt viel flacher — im selben Punkt 115,8 → 111,9 Ω,
 *   3,9 Ω oder 3,4 % — und ein Vergleich zwischen beiden Quellen ist deshalb
 *   sinnlos.
 *
 * Welche Quelle es war, steht deshalb dabei. Fehlt DirectSense, ist der
 * Generatorwert besser als nichts, aber er darf nicht so aussehen wie der
 * andere.
 */
function impedanceDrop(directBase, directMin, genBase, genMin) {
  const from = (base, min, source) => {
    if (!Number.isFinite(base) || !Number.isFinite(min) || base <= 0) return null;
    return { source, baseOhm: base, minOhm: min, ohm: base - min,
             percent: ((base - min) / base) * 100 };
  };
  return from(directBase, directMin, 'directsense')
      || from(genBase, genMin, 'generator')
      || null;
}

// Exported for testing: parse tags directly from an XML string.
export function parseRhythmiaTagsFromXml(xml) {
  return extractRhythmiaTags(parseXmlTolerant(xml).documentElement);
}

// XML -> Meshes. getPayload(idx) liefert die Binärbytes (sync ODER Promise);
// beim Streaming werden so nur die wirklich benötigten Blöcke gelesen.
/* Rhythmia: die durchgehenden Aufzeichnungen.
 *
 * Anders als CARTO und EnSite legt Rhythmia kein Signal *je Punkt* ab, sondern
 * fortlaufende Blöcke *je Katheter* — `sigblk_..._cardiac_953_<Katheter>_<B|U|W>`
 * mit einer eigenen Float64-Zeitachse daneben. Ein angeklickter Punkt trägt
 * einen Zeitstempel; gezeigt wird also, was zu diesem Zeitpunkt aufgezeichnet
 * war.
 *
 * Zwei Eigenschaften des Formats, die man messen muss statt sie zu raten:
 *
 * * Die Werte liegen **spaltenweise**: erst Kanal 0 über die ganze Aufnahme,
 *   dann Kanal 1. Zeilenweise gelesen ergäbe das aus 64 Kanälen einen einzigen
 *   verschränkten Strom — plausibel aussehendes Rauschen. Belegt über die
 *   Autokorrelation (Versatz 1 deutlich höher als Versatz `cols`).
 * * Die Werte sind Float32 in **Volt**. Belegt an drei Signalarten mit
 *   verschiedenen erwarteten Größen: Korb-Bipolar 0,40 mV, Decapolar 2,9 mV,
 *   12-Kanal-Oberflächen-EKG 1,8 mV Spitze-Tal.
 *
 * Die Abtastrate steht nicht im Namen zu raten, sondern folgt aus der
 * Zeitachse selbst.
 */
const SIG_NAME = /sigblk_[0-9a-f]*_?cardiac_\d+_(.+?)_([BUW])\.dat$/;

//: Wie viel um den Zeitpunkt herum gezeigt wird.
const SIG_WINDOW_S = 1.0;

function rhythmiaSignalIndex(root) {
  const blocks = [];
  for (const el of iterTag(root, 'inlinedbin')) {
    const fname = el.getAttribute && el.getAttribute('fname');
    if (!fname) continue;
    const idx = parseInt((el.textContent || '').trim(), 10);
    if (!Number.isFinite(idx)) continue;
    const bare = fname.replace(/^.*\//, '');
    const named = SIG_NAME.exec(bare);
    const cols = parseInt(el.getAttribute('cols'), 10);
    const rows = parseInt(el.getAttribute('rows'), 10);
    const type = el.getAttribute('type');
    if (named && type === 'Cardiac') {
      blocks.push({ kind: 'signal', catheter: named[1], flavour: named[2],
                    cols, rows, idx, prefix: bare.slice(0, bare.lastIndexOf('_' + named[2] + '.dat')) });
    } else if (/cardiac_\d+_ts\.dat$/.test(bare) && type === 'Float64') {
      blocks.push({ kind: 'time', rows, idx,
                    prefix: bare.slice(0, bare.lastIndexOf('_ts.dat')) });
    }
  }
  return blocks;
}

/** A reader that returns the recording around a point's timestamp. */
function rhythmiaEgmReader(root, getRange) {
  const blocks = rhythmiaSignalIndex(root);
  const signals = blocks.filter(b => b.kind === 'signal');
  const times = blocks.filter(b => b.kind === 'time');
  if (!signals.length || !times.length || !getRange) return null;

  // Bipolar zuerst: das ist, was ein Mapping-Punkt misst. Dann unipolar, dann
  // was übrig ist. Der Korb hat 64 Kanäle, ein Diagnostikkatheter zehn — der
  // mit den wenigsten ist der, dessen Kanäle einzeln etwas bedeuten.
  const rank = (b) => (b.flavour === 'B' ? 0 : b.flavour === 'U' ? 1 : 2) * 100 + b.cols;
  signals.sort((a, b) => rank(a) - rank(b));

  // Typisierte Sichten verlangen Ausrichtung: ein Float64Array braucht einen
  // durch 8 teilbaren Versatz. Der Streaming-Pfad liefert frische Puffer und
  // erfüllt das zufällig; eine Sicht in ein bereits geladenes Archiv nicht,
  // und dann wirft der Konstruktor statt etwas Falsches zu liefern. Kopieren,
  // wenn nötig — ein Fenster ist klein.
  const aligned = (raw, Type) => {
    const size = Type.BYTES_PER_ELEMENT;
    if (raw.byteOffset % size === 0) {
      return new Type(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / size));
    }
    return new Type(raw.slice().buffer, 0, Math.floor(raw.byteLength / size));
  };

  const timeCache = new Map();
  const readTimes = async (block) => {
    if (timeCache.has(block.idx)) return timeCache.get(block.idx);
    const raw = await getRange(block.idx, 0, block.rows * 8);
    const t = aligned(raw, Float64Array);
    timeCache.set(block.idx, t);
    return t;
  };

  // Eine Oberflächenableitung als Zeitbezug: ohne sie sagt ein intrakardiales
  // Signal nichts darüber, wo im Herzzyklus man sich befindet.
  //
  // Nur aus derselben Signalgruppe. Ein Archiv enthält mehrere, jede mit
  // eigener Zeitachse und eigener Länge — die Indizes der einen in einem Block
  // der anderen zu benutzen zeigte die falsche Sekunde neben der richtigen,
  // und nichts daran sähe verkehrt aus.
  // Gegen die gefundene Uhr verglichen, nicht gegen ein zurechtgeschnittenes
  // Präfix: Katheternamen enthalten selbst Unterstriche, und "eine Ebene
  // abschneiden" traf SurfaceECG12_1 nie.
  const surfaceFor = (sig, clock) => signals.find(
    b => /surfaceecg/i.test(b.catheter) && b !== sig
      && b.prefix.startsWith(clock.prefix) && b.rows === sig.rows);

  const windowOf = async (block, from, to) => {
    const raw = await getRange(block.idx, from * 4, (to - from) * 4);
    return aligned(raw, Float32Array);
  };

  return async (point) => {
    if (!point || point.time == null) return null;

    for (const sig of signals) {
      if (/surfaceecg/i.test(sig.catheter) && signals.length > 1) continue;
      const clock = times.find(t => t.prefix === sig.prefix
                                 || sig.prefix.startsWith(t.prefix));
      if (!clock) continue;
      const t = await readTimes(clock);
      if (!t.length || point.time < t[0] || point.time > t[t.length - 1]) continue;

      // Binäre Suche: die Zeitachse ist monoton.
      let lo = 0, hi = t.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < point.time) lo = mid + 1; else hi = mid; }
      const rate = t.length > 1 ? 1 / ((t[t.length - 1] - t[0]) / (t.length - 1)) : 0;
      const half = Math.max(1, Math.round(rate * SIG_WINDOW_S / 2));
      const from = Math.max(0, lo - half);
      const to = Math.min(sig.rows, lo + half);
      if (to <= from) continue;

      // Spaltenweise: Kanal c beginnt bei c * rows * 4.
      const channels = [], samples = [];
      const suffix = sig.flavour === 'B' ? ' bi' : sig.flavour === 'U' ? ' uni' : '';
      const many = Math.min(sig.cols, 3);
      for (let c = 0; c < many; c++) {
        const raw = await getRange(sig.idx, (c * sig.rows + from) * 4, (to - from) * 4);
        samples.push(aligned(raw, Float32Array));
        // Rhythmia benennt die einzelnen Kanäle im Export nicht; die Nummer
        // ist die Spalte, nicht eine Ableitung, und wird auch so beschriftet.
        channels.push(`${sig.catheter} ${c + 1}${suffix}`);
      }
      // Und, wenn vorhanden, eine Oberflächenableitung derselben Uhr darunter.
      const surface = surfaceFor(sig, clock);
      if (surface) {
        try {
          samples.push(await windowOf(surface, from, to));
          channels.push(`${surface.catheter} 1`);
        } catch (e) { /* fehlt sie, fehlt nur der Zeitbezug */ }
      }
      return {
        channels, samples,
        gainMv: 1000,                      // Float32 in Volt
        sampleRateHz: Math.round(rate * 1000) / 1000,
        rateAssumed: false,                // aus der Zeitachse gerechnet
        window: [t[from], t[Math.min(to, t.length) - 1]],
        atSeconds: point.time,
      };
    }
    return null;
  };
}

async function buildRhythmiaMeshes(xml, getPayload, getRange) {
  const doc = parseXmlTolerant(xml);
  const root = doc.documentElement;

  const payloadBytes = async (el) => {
    const bin = firstTag(el, 'inlinedbin');
    if (!bin) return null;
    const idx = parseInt((bin.textContent || '').trim(), 10);
    if (!Number.isFinite(idx)) return null;
    return await getPayload(idx);
  };

  const meshes = [];
  let anatIdx = 0;
  for (const anatomy of iterTag(root, 'Anatomy')) {
    anatIdx++;
    let name = `anatomy_${anatIdx-1}`;
    const props = firstTag(anatomy, 'Properties');
    const lbl = props && firstTag(props, 'Label');
    if (lbl && lbl.textContent) name = lbl.textContent;

    let M = null;
    const tEl = firstTag(anatomy, 'Transform');
    if (tEl && tEl.textContent) M = mat4FromText(tEl.textContent);

    let positions = null, normals = null, faces = null;
    for (const mesh of iterTag(anatomy, 'Mesh')) {
      const vEl = firstTag(mesh, 'vertices'), triEl = firstTag(mesh, 'triangles');
      if (!vEl || !triEl) continue;
      const vBytes = await payloadBytes(vEl), tBytes = await payloadBytes(triEl);
      if (!vBytes || !tBytes) continue;
      if (vBytes.length === 0 || vBytes.length % 24 !== 0) continue;
      if (tBytes.length === 0 || tBytes.length % 12 !== 0) continue;
      const vdata = asFloat32(vBytes);
      const nv = vdata.length / 6;
      positions = new Float32Array(nv * 3);
      normals = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        positions[i*3] = vdata[i*6]; positions[i*3+1] = vdata[i*6+1]; positions[i*3+2] = vdata[i*6+2];
        normals[i*3] = vdata[i*6+3]; normals[i*3+1] = vdata[i*6+4]; normals[i*3+2] = vdata[i*6+5];
      }
      faces = new Uint32Array(asInt32(tBytes));
    }
    if (!positions) continue;

    if (M) {
      const N = inv3T(M);
      for (let i = 0; i < positions.length; i += 3) {
        const [x,y,z] = applyMat4(M, positions[i], positions[i+1], positions[i+2]);
        positions[i]=x; positions[i+1]=y; positions[i+2]=z;
        const nx = N[0][0]*normals[i]+N[0][1]*normals[i+1]+N[0][2]*normals[i+2];
        const ny = N[1][0]*normals[i]+N[1][1]*normals[i+1]+N[1][2]*normals[i+2];
        const nz = N[2][0]*normals[i]+N[2][1]*normals[i+1]+N[2][2]*normals[i+2];
        const len = Math.hypot(nx,ny,nz) || 1;
        normals[i]=nx/len; normals[i+1]=ny/len; normals[i+2]=nz/len;
      }
    }
    const nv = positions.length / 3;

    const scalars = {};
    for (const eo of iterTag(anatomy, 'EngineOutput')) {
      const volt = firstTag(eo, 'Voltage');
      if (volt && !('voltage' in scalars)) {
        const vEl = firstTag(volt, 'values'); const b = vEl && await payloadBytes(vEl);
        if (b) {
          const raw = asFloat32(b); const mv = new Float32Array(raw.length);
          for (let i = 0; i < raw.length; i++) mv[i] = Math.exp(raw[i]) / 1000;
          scalars.voltage = cleanScalar(fitToVertexCount(mv, nv));
        }
      }
      const act = firstTag(eo, 'Activation');
      if (act && !('lat' in scalars)) {
        const vEl = firstTag(act, 'values'); const b = vEl && await payloadBytes(vEl);
        if (b) scalars.lat = cleanScalar(fitToVertexCount(asFloat32(b), nv));
      }
    }
    meshes.push({ name, positions, normals, faces, scalars, source: 'rhythmia' });
  }
  // Tag <xyz> is used in raw-vertex space (the per-anatomy <Transform> M is NOT applied).
  // Points are distributed per-anatomy by nearest mesh vertex — a single Rhythmia group
  // (e.g. the global Ablation set spanning LA+LV) is split across meshes per point, not
  // lumped onto whichever anatomy holds the group centroid. Validated only for identity
  // <Transform> — all three real test studies have identity M, so this aligns. Non-identity
  // transforms remain an unhandled limitation: if markers ever appear misaligned on a study,
  // that study has a non-identity M and the tag <xyz> must be transformed before association.
  const tagGroups = extractRhythmiaTags(root)
    .concat(await extractRhythmiaMappingPoints(root, getPayload));
  if (tagGroups.length && meshes.length) {
    const per = assignTagsToMeshes(meshes, tagGroups);
    for (let i = 0; i < meshes.length; i++) {
      if (!per[i].length) continue;
      meshes[i].tagGroups = per[i];
      // Die Läsionen dieser Anatomie, in der Form, die die Auswertung erwartet.
      // Ohne das stünde bei Rhythmia nur "so viele Punkte" und bei CARTO die
      // ganze Rechnung — dieselbe Frage, zwei Antworten.
      const lesions = per[i]
        .filter(g => g.category === 'ablation')
        .flatMap(g => g.points.map(p => p.ablation).filter(Boolean));
      if (lesions.length) meshes[i].ablation = lesions;
    }
  }
  // Ein Punkt zeigt hier keine eigene Aufnahme, sondern das Fenster der
  // laufenden um seinen Zeitstempel — Rhythmia legt Signale je Katheter ab,
  // nicht je Punkt.
  const readEgm = rhythmiaEgmReader(root, getRange);
  if (readEgm) {
    for (const mesh of meshes) {
      mesh.readEgm = readEgm;
      for (const g of (mesh.tagGroups || [])) {
        for (const pt of g.points) if (pt.time != null) pt.egm = pt;
      }
    }
  }
  return meshes;
}

// In-Memory (kleine Archive / ?src / Tests)
export async function parseRhythmia(bytes) {
  const { xml, payloads } = extractRhythmia(bytes);
  return buildRhythmiaMeshes(xml, idx => payloads[idx],
    (idx, at, len) => payloads[idx].subarray(at, at + len));
}

// Streaming aus File-Objekten — für sehr große Archive (mehrere GB, 10+ Teile):
// die Datei wird NIE komplett in den Speicher geladen. Per File.slice() wird
// nur XML-Text gescannt, Binärblöcke werden per BIN-Länge übersprungen, und am
// Ende werden ausschließlich die benötigten Mesh-/Skalar-Payloads gelesen.
export async function parseRhythmiaFiles(files, onProgress) {
  const parts = Array.from(files)
    .filter(f => /\.\d{3}$/.test(f.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!parts.length) throw new Error('Keine Rhythmia-Teildateien (.000/.001/…) gefunden.');

  const sizes = parts.map(f => f.size);
  const starts = []; let acc = 0;
  for (const s of sizes) { starts.push(acc); acc += s; }
  const total = acc;
  try { console.log('[epconv] Rhythmia-Teile:', parts.map((f, i) => `${f.name}=${sizes[i]}B`).join(', '),
    '| gesamt', total, 'B'); } catch (e) {}
  const fileAt = (g) => {
    let lo = 0, hi = parts.length - 1, idx = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= g) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    return [idx, g - starts[idx]];
  };
  async function readRange(gStart, len) {
    const out = new Uint8Array(len); let written = 0, g = gStart;
    while (written < len) {
      const [fi, lo] = fileAt(g);
      const take = Math.min(sizes[fi] - lo, len - written);
      if (take <= 0) throw new Error('Lesefehler an der Dateigrenze.');
      out.set(new Uint8Array(await parts[fi].slice(lo, lo + take).arrayBuffer()), written);
      written += take; g += take;
    }
    return out;
  }

  const dec = new TextDecoder('latin1');
  const xmlParts = [], payloadLoc = [];
  // Kleiner Chunk: zwischen zwei Binärblöcken liegt nur wenig XML; so wird pro
  // (übersprungenem) Block höchstens ~CHUNK an Binärdaten unnötig gelesen.
  const CHUNK = 1 << 18, OPEN = '<inlinedbin ';
  let g = 0, carry = '', carryStart = 0, truncated = false;
  while (g < total) {
    const take = Math.min(CHUNK, total - g);
    carry += dec.decode(await readRange(g, take));
    g += take;
    if (onProgress) onProgress({ phase: 'scan', done: g, total });
    while (true) {
      const ti = carry.indexOf(OPEN);
      if (ti < 0) {
        const keep = OPEN.length - 1;
        const flushTo = Math.max(0, carry.length - keep);
        if (flushTo > 0) { xmlParts.push(carry.slice(0, flushTo)); carryStart += flushTo; carry = carry.slice(flushTo); }
        break;
      }
      const gt = carry.indexOf('>', ti);
      if (gt < 0) { if (ti > 0) { xmlParts.push(carry.slice(0, ti)); carryStart += ti; carry = carry.slice(ti); } break; }
      const tag = carry.slice(ti, gt + 1);
      // BIN-Länge tolerant lesen: BIN=123  ODER  BIN="123" (als eigenes Attribut)
      const m = tag.match(/\sBIN="?(\d+)/);
      if (!m) {
        // <inlinedbin>-Tag ohne lesbare Länge: hart abbrechen statt blind in die
        // Binärdaten zu laufen (das würde später als Müll-Tag mit riesigem BIN enden).
        throw new Error('inlinedbin-Tag ohne erkennbare BIN-Länge bei Byte ' +
          (carryStart + ti) + ': »' + tag.slice(0, 160) + '«');
      }
      const N = parseInt(m[1], 10);
      const payloadStart = carryStart + gt + 1;
      const skipTo = payloadStart + N;
      if (skipTo > total) {
        // Block reicht über das (unvollständige) Archiv hinaus -> fehlende
        // Teildatei. Tail ignorieren und mit dem bereits Gelesenen weitermachen
        // (Mesh/Skalare liegen typischerweise früh im Archiv).
        try { console.warn(`[epconv] Block BIN=${N} bei Byte ${payloadStart} reicht ` +
          `${skipTo - total} B über das Archivende — fehlende Teildatei (.${String(parts.length).padStart(3,'0')}?). ` +
          `Rest wird ignoriert.`); } catch (e) {}
        xmlParts.push(carry.slice(0, ti));   // gültigen XML-Text vor dem Block behalten
        truncated = true; carry = '';
        break;
      }
      xmlParts.push(carry.slice(0, gt + 1));   // XML inkl. Open-Tag
      xmlParts.push(String(payloadLoc.length));
      payloadLoc.push({ start: payloadStart, len: N });
      const afterIdx = gt + 1 + N;
      if (afterIdx <= carry.length) { carry = carry.slice(afterIdx); carryStart = skipTo; }   // kleiner Block: Rest behalten
      else { carry = ''; carryStart = skipTo; g = skipTo; break; }                            // großer Block: überspringen
      if (!carry.length) break;
    }
    if (truncated) break;
  }
  if (carry.length) xmlParts.push(carry);
  if (onProgress) onProgress({ phase: 'build', done: total, total });
  let xml = xmlParts.join('').replace(/BIN=([0-9]+)/g, 'BIN="$1"');
  xml = sanitizeXml(xml);
  return buildRhythmiaMeshes(xml, idx => readRange(payloadLoc[idx].start, payloadLoc[idx].len),
    (idx, at, len) => readRange(payloadLoc[idx].start + at, len));
}

/* ===================================================================== *
 *  EnSite (NavX / Velocity / Precision)
 * ===================================================================== */

export function parseEnSite(text, dxlText = null) {
  const dp = getDOMParser();
  if (!dp) throw new Error('DOMParser nicht verfügbar (Browser erforderlich).');
  const doc = dp.parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML-Parsing fehlgeschlagen: ' + (err.textContent || '').slice(0, 200));
  const root = doc.documentElement;

  const meshes = [];
  let volIdx = 0;
  for (const vol of iterTag(root, 'Volume')) {
    const vEl = firstTag(vol, 'Vertices');
    if (!vEl || !vEl.textContent) { volIdx++; continue; }
    const vr = textToRows(vEl.textContent);
    if (!vr.length || vr[0].length < 3) { volIdx++; continue; }
    const positions = new Float32Array(vr.length * 3);
    for (let i = 0; i < vr.length; i++) { positions[i*3]=vr[i][0]; positions[i*3+1]=vr[i][1]; positions[i*3+2]=vr[i][2]; }

    let normals = null;
    const nEl = firstTag(vol, 'Normals');
    if (nEl && nEl.textContent) {
      const nr = textToRows(nEl.textContent);
      if (nr.length === vr.length && nr[0].length >= 3) {
        normals = new Float32Array(nr.length * 3);
        for (let i = 0; i < nr.length; i++) { normals[i*3]=nr[i][0]; normals[i*3+1]=nr[i][1]; normals[i*3+2]=nr[i][2]; }
      }
    }

    const pEl = firstTag(vol, 'Polygons');
    if (!pEl || !pEl.textContent) { volIdx++; continue; }
    const pr = textToRows(pEl.textContent);
    const allTris = new Uint32Array(pr.length * 3);
    for (let i = 0; i < pr.length; i++) { allTris[i*3]=pr[i][0]-1; allTris[i*3+1]=pr[i][1]-1; allTris[i*3+2]=pr[i][2]-1; } // 1-basiert

    let mapData = null;
    const mEl = firstTag(vol, 'Map_data');
    if (mEl && mEl.textContent) {
      const flat = [];
      for (const r of textToRows(mEl.textContent)) for (const v of r) flat.push(v);
      if (flat.length) mapData = Float32Array.from(flat);
    }
    const nv = positions.length / 3;
    const md = mapData ? cleanScalar(fitToVertexCount(mapData, nv)) : null;

    const sooEl = firstTag(vol, 'Surface_of_origin');
    if (sooEl && sooEl.textContent) {
      const soo = []; for (const r of textToRows(sooEl.textContent)) for (const v of r) soo.push(Math.trunc(v));
      const nSurf = Math.max(...soo) + 1;
      for (let s = 0; s < nSurf; s++) {
        const tri = [];
        for (let i = 0; i < soo.length; i++) if (soo[i] === s) tri.push(allTris[i*3], allTris[i*3+1], allTris[i*3+2]);
        if (!tri.length) continue;
        meshes.push({ name: `EnSite_vol${volIdx}_surf${s}`, positions, normals,
          faces: Uint32Array.from(tri), scalars: md ? { map_data: md } : {}, source: 'ensite' });
      }
    } else {
      meshes.push({ name: `EnSite_vol${volIdx}`, positions, normals, faces: allTris,
        scalars: md ? { map_data: md } : {}, source: 'ensite' });
    }
    volIdx++;
  }

  // Die Punkte liegen nicht im DIF, sondern im DxL-Export daneben. Ohne ihn
  // ist die Karte vollständig und hat eben keine Punkte — das ist kein Fehler,
  // sondern eine Datei, die der Benutzer nicht mitgegeben hat.
  if (dxlText) attachDxL(meshes, dxlText);
  return meshes;
}

// Punkte und Kurven an die Meshes hängen, in derselben Form wie bei CARTO,
// damit die Anzeige nur eine kennt.
function attachDxL(meshes, dxlText) {
  const dxl = parseDxL(dxlText);
  const placed = dxl.points.filter(p => p.xyz);
  const tagGroups = placed.length ? [{
    id: 'ensite-points', label: 'Mapping-Punkte', category: 'mapping',
    color: tagCategoryColor('annotation'),
    points: placed.map(p => ({ position: p.xyz, label: p.label || ('P' + p.id),
                               egm: p })),
  }] : [];
  for (const mesh of meshes) {
    mesh.points = dxl.points;
    mesh.readEgm = dxl.readEgm;
    mesh.tagGroups = (mesh.tagGroups || []).concat(tagGroups);
  }
}

/* ===================================================================== *
 *  CARTO 3
 * ===================================================================== */

export function parseCartoMesh(text, name = 'CARTO') {
  let section = 'none';
  const vLines = [], tLines = [], sLines = [];
  let labels = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';') continue;
    if (line.includes('[GeneralAttributes]')) { section = 'general'; continue; }
    if (line.includes('[VerticesSection]')) { section = 'vertices'; continue; }
    if (line.includes('[TrianglesSection]')) { section = 'triangles'; continue; }
    if (line.includes('[VerticesColorsSection]')) { section = 'scalars'; continue; }
    if (line.includes('[VerticesAttributesSection]')) { section = 'attributes'; continue; }
    if (line[0] === '[') { section = 'none'; continue; }
    if (section === 'general') {
      const m = line.match(/^ColorsNames\s*=\s*(.*)/);
      if (m) labels = m[1].trim().split(/\s+/);
    } else if (section === 'vertices') vLines.push(line.replace(/^[0-9]*\s*=\s*/, ''));
    else if (section === 'triangles') tLines.push(line.replace(/^[0-9]*\s*=\s*/, ''));
    else if (section === 'scalars') sLines.push(line.replace(/^[0-9]*\s*=\s*/, ''));
  }
  const vr = vLines.map(l => l.split(/\s+/).map(Number));
  const nv = vr.length;
  const positions = new Float32Array(nv * 3);
  let normals = null;
  if (vr[0] && vr[0].length >= 6) normals = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[i*3]=vr[i][0]; positions[i*3+1]=vr[i][1]; positions[i*3+2]=vr[i][2];
    if (normals) { normals[i*3]=vr[i][3]; normals[i*3+1]=vr[i][4]; normals[i*3+2]=vr[i][5]; }
  }
  const tr = tLines.map(l => l.split(/\s+/).map(Number));
  const faces = new Uint32Array(tr.length * 3);
  for (let i = 0; i < tr.length; i++) { faces[i*3]=tr[i][0]; faces[i*3+1]=tr[i][1]; faces[i*3+2]=tr[i][2]; }

  const cols = sLines.map(l => l.split(/\s+/).map(Number));
  const scalarByLabel = {};
  labels.forEach((lab, ci) => { const a = new Float32Array(nv); for (let i = 0; i < nv; i++) a[i] = (cols[i] && cols[i][ci] !== undefined) ? cols[i][ci] : NaN; scalarByLabel[lab] = a; });

  // Voltage (Bipolar bevorzugt) + LAT herausziehen, benannt für den Viewer
  const pick = (kws) => { for (const k of kws) for (const lab of Object.keys(scalarByLabel)) if (lab.toLowerCase().includes(k)) return [lab, scalarByLabel[lab]]; return [null, null]; };
  const scalars = {};
  const [vk, va] = pick(['bipolar', 'voltage', 'uni']);
  if (va) { const uni = vk.toLowerCase().includes('uni') && !vk.toLowerCase().includes('bipolar'); scalars[uni ? 'unipolar' : 'voltage'] = cleanScalar(fitToVertexCount(va, nv)); }
  const [lk, la] = pick(['lat', 'activation', 'act']);
  if (la) scalars.lat = cleanScalar(fitToVertexCount(la, nv));

  return { name, positions, normals, faces, scalars, source: 'carto' };
}

/* ===================================================================== *
 *  EnSite: Mapping-Punkte und ihre Kurven aus dem DxL-Export
 *
 *  EnSite trennt Geometrie von Messwerten: die Oberfläche steht im DIF-XML,
 *  die Punkte und ihre Kurven in einer eigenen CSV. Deren Kopf beschreibt sich
 *  selbst — eine Spalte je Punkt, benannte Zeilen für Position, LAT und
 *  Spannung, und weiter unten Blöcke mit den Abtastwerten.
 *
 *  Die Abtastrate steht in der Datei ("Sample rate:"). Sie wird von dort
 *  gelesen und nicht angenommen — anders als bei CARTO, wo sie fehlt.
 * ===================================================================== */

// Zeilen, die einen Punkt beschreiben: Name -> Feld. Was hier nicht steht,
// wird nicht gelesen; eine Zeile, die der Hersteller später umbenennt, fehlt
// dann sichtbar, statt still auf einem falschen Feld zu landen.
const DXL_FIELDS = {
  'pt number': 'number', 'rov trace': 'label', 'ref trace': 'reference',
  'rov LAT': 'latSeconds', 'ref LAT': 'referenceLatSeconds',
  'peak2peak': 'bipolarMv', 'peak neg': 'peakNegativeMv',
  'roving x': 'x', 'roving y': 'y', 'roving z': 'z',
  'surfPt x': 'sx', 'surfPt y': 'sy', 'surfPt z': 'sz',
  'cycle len': 'cycleLengthMs', 'utilized': 'utilized',
};

function dxlCells(line) {
  const parts = line.split(',');
  return { key: parts[0].replace(/:\s*$/, '').trim(), values: parts.slice(1) };
}

function dxlNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  // Eine leere Zelle ist kein Wert. `Number('')` ist 0, und eine 0 sieht aus
  // wie eine Messung: 0,0 mV Spitze-Tal heißt "flach", nicht "nicht erhoben".
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function parseDxL(text) {
  const lines = text.split(/\r?\n/);

  let sampleRateHz = null;
  const rows = new Map();          // Feldname -> Werte
  let waveStart = -1, waveLabels = null;
  let seenFields = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] === '*') continue;
    const { key, values } = dxlCells(line);

    if (key === 'Sample rate') { sampleRateHz = dxlNumber(values[0]); continue; }
    if (key in DXL_FIELDS && !rows.has(key)) {
      rows.set(key, values);
      seenFields = true;
      continue;
    }
    // Der zweite "rov trace:"-Kopf leitet die Kurven ein: erst die Felder,
    // dann derselbe Kopf noch einmal, dann Zeile für Zeile die Abtastwerte.
    if (key === 'rov trace' && seenFields && rows.has('rov trace') && waveStart < 0) {
      waveLabels = values.map(v => v.trim());
      waveStart = i + 1;
    }
  }

  if (!rows.size) throw new Error('Keine DxL-Datenzeilen gefunden.');
  if (!(sampleRateHz > 0)) {
    // Ohne Rate ist die Zeitachse unbekannt. Sie zu raten hieße, eine gemessene
    // vorzutäuschen — die Datei nennt sie, also ist ihr Fehlen ein Befund.
    // Auch die 0 wird abgelehnt: eine Sekunde mit 0 Hz ist unendlich lang.
    throw new Error('Der DxL-Export nennt keine brauchbare Abtastrate '
                  + `("Sample rate:" = ${sampleRateHz}).`);
  }

  const count = Math.max(...[...rows.values()].map(v => v.length));
  const points = [];
  for (let c = 0; c < count; c++) {
    const get = (key) => { const v = rows.get(key); return v ? v[c] : undefined; };
    const p = { id: String(c + 1), column: c };
    for (const [key, field] of Object.entries(DXL_FIELDS)) {
      const raw = get(key);
      if (raw == null) continue;
      p[field] = (field === 'label' || field === 'reference')
        ? String(raw).trim() : dxlNumber(raw);
    }
    // Der Punkt gehört an die Roving-Elektrode. Die auf die Oberfläche
    // projizierte Position ist die Karte, nicht die Messung.
    p.xyz = [p.x, p.y, p.z].every(v => v != null) ? [p.x, p.y, p.z] : null;
    p.surfaceXyz = [p.sx, p.sy, p.sz].every(v => v != null) ? [p.sx, p.sy, p.sz] : null;
    if (p.number != null) p.id = String(p.number) + '.' + (c + 1);
    points.push(p);
  }

  // Auf Abruf: die Kurve eines Punktes ist eine Spalte über zehntausend
  // Zeilen. Alle auf einmal zu lesen wäre bei achtzig Punkten das
  // Achtzigfache der Arbeit für das, was einer sehen will.
  const cache = new Map();
  const readEgm = (point) => {
    if (!point || waveStart < 0 || point.column == null) return null;
    if (cache.has(point.column)) return cache.get(point.column);
    const values = [];
    for (let i = waveStart; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.length) break;             // Leerzeile trennt die Blöcke
      const cell = line.split(',')[point.column + 1];
      if (cell === undefined) break;
      const n = Number(cell);
      if (!Number.isFinite(n)) break;               // nächster Kopf, nicht mehr Daten
      values.push(n);
    }
    if (!values.length) return null;
    // Die Werte stehen bereits in Millivolt; die Verstärkung ist deshalb 1 und
    // nicht etwa unbekannt.
    const egm = {
      channels: [waveLabels && waveLabels[point.column] || point.label || 'rov'],
      samples: [Float32Array.from(values)],
      gainMv: 1, sampleRateHz, rateAssumed: false,
    };
    cache.set(point.column, egm);
    return egm;
  };

  return { points, sampleRateHz, readEgm, labels: waveLabels };
}

/* ===================================================================== *
 *  CARTO: Mapping-Punkte und ihre Elektrogramme
 *
 *  Ein Export legt pro Punkt eine eigene Signaldatei an, jede rund 1,9 MB.
 *  Eine Studie mit zweitausend Punkten trägt darum Gigabytes an Signal, das
 *  niemand sehen will, bevor er einen Punkt anklickt — also wird die
 *  Punktliste sofort gelesen (ein paar Kilobyte XML je Punkt) und ein
 *  Elektrogramm erst auf Abruf.
 *
 *  Die Python-Seite (epcore/epview/carto_points.py) liest dasselbe Format;
 *  die Regeln unten sind dieselben, weil sie sonst auseinanderlaufen.
 * ===================================================================== */

// Jede Spalte einer Signaldatei ist so breit. Auf Whitespace zu trennen
// verschiebt bei einem leeren Feld jeden folgenden Kanal um eine Spalte —
// eine echte Kurve auf der falschen Ableitung, und die sieht normal aus.
const CARTO_FIELD = 30;

// CARTO 3 exportiert mit 1 kHz. Die Rate steht nicht in der Datei und lässt
// sich aus ihr nicht herleiten, also reist die Annahme sichtbar mit.
export const CARTO_ASSUMED_RATE_HZ = 1000;

// Was CARTO schreibt, wo es keinen Wert hat.
const CARTO_ABSENT = 10000;

function cartoNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) < CARTO_ABSENT ? n : null;
}

export function parseCartoEcg(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 5 || !lines[0].startsWith('ECG_Export')) {
    throw new Error('Keine CARTO-Signaldatei.');
  }
  let gain = null;
  for (const line of lines.slice(1, 3)) {
    const m = line.match(/gain\)\s*=\s*([0-9.eE+-]+)/);
    if (m) gain = parseFloat(m[1]);
  }
  if (gain == null) {
    throw new Error('Der Kopf nennt keine Verstärkung — die Zählwerte lassen '
                  + 'sich nicht in Millivolt umrechnen.');
  }

  const header = lines[3];
  if (header.length % CARTO_FIELD) {
    throw new Error(`Kanalkopf ist ${header.length} Zeichen lang, kein `
                  + `Vielfaches der Spaltenbreite ${CARTO_FIELD}.`);
  }
  const n = header.length / CARTO_FIELD;
  const channels = [];
  for (let i = 0; i < n; i++) {
    const raw = header.slice(i * CARTO_FIELD, (i + 1) * CARTO_FIELD).trim();
    const named = raw.match(/^(.*?)\((\d+)\)$/);
    channels.push(named ? named[1] : raw);
  }

  const body = lines.slice(4).filter(l => l.trim().length);
  const samples = channels.map(() => new Int32Array(body.length));
  for (let row = 0; row < body.length; row++) {
    const line = body[row];
    for (let col = 0; col < n; col++) {
      const cell = line.slice(col * CARTO_FIELD, (col + 1) * CARTO_FIELD).trim();
      samples[col][row] = cell ? parseInt(cell, 10) || 0 : 0;
    }
  }
  return { channels, samples, gainMv: gain,
           sampleRateHz: CARTO_ASSUMED_RATE_HZ, rateAssumed: true };
}

// Positionstabelle: zwei Kopfzeilen, dann "Nr Zeit X Y Z".
function parseCartoPositions(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/).slice(2)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const id = parseInt(f[0], 10);
    const [x, y, z] = [f[2], f[3], f[4]].map(Number);
    if (Number.isInteger(id) && [x, y, z].every(Number.isFinite)) out.set(id, [x, y, z]);
  }
  return out;
}

// Wo ein Punkt sitzt. Zwei Dateien tragen eine Position und meinen nicht
// dasselbe: der Lagesensor sitzt im Katheterkörper, die Elektroden sind die
// Elektroden. Der Punkt gehört an die Mapping-Elektrode — der Kopf der
// Signaldatei nennt M1 als unipolaren Mapping-Kanal — also ist Elektrode 1
// der Anker. (Die Schreibweise "Eleclectrode" ist die des Herstellers.)
function cartoPositionOf(files, stem) {
  for (const kind of ['Eleclectrode_Positions_OnAnnotation',
                      'Sensor_Positions_OnAnnotation']) {
    for (const name of Object.keys(files)) {
      const bare = name.replace(/^.*\//, '');
      if (!bare.startsWith(stem) || !bare.endsWith(kind + '.txt')) continue;
      const found = parseCartoPositions(decodeLatin1(files[name]));
      if (found.has(1)) return found.get(1);
      if (found.size) return found.get(Math.min(...found.keys()));
    }
  }
  // Kein Ort ist besser als der Ursprung: ein Punkt auf (0,0,0) läge mitten
  // in der Kammer und sähe aus wie eine Messung.
  return null;
}

export function parseCartoPoints(files) {
  const names = Object.keys(files)
    .filter(n => n.replace(/^.*\//, '').endsWith('_Point_Export.xml'));
  if (!names.length) return [];

  // Ohne XML-Parser gibt es keine Punkte zu lesen — aber eine leere Liste
  // zurückzugeben heißt "diese Studie hat keine", und das ist etwas anderes.
  // Der Unterschied ist genau der, den ein stiller Fehlschlag verwischt.
  const parser = getDOMParser();
  if (!parser) {
    throw new Error('Kein XML-Parser verfügbar — Mapping-Punkte können nicht '
                  + 'gelesen werden.');
  }

  const points = [];
  const unreadable = [];
  for (const name of names) {
    const bare = name.replace(/^.*\//, '');

    let root;
    try {
      root = parser.parseFromString(decodeLatin1(files[name]), 'text/xml')
                   .documentElement;
    } catch { root = null; }
    if (!root || root.nodeName === 'parsererror') { unreadable.push(bare); continue; }

    const attr = (tag, key) => {
      const el = firstTag(root, tag);
      return el ? el.getAttribute(key) : null;
    };
    const woiFrom = cartoNumber(attr('WOI', 'From'));
    const woiTo = cartoNumber(attr('WOI', 'To'));
    const ecgName = attr('ECG', 'FileName');

    points.push({
      id: root.getAttribute('ID') || bare,
      xyz: cartoPositionOf(files, bare.replace('_Point_Export.xml', '')),
      bipolarMv: cartoNumber(attr('Voltages', 'Bipolar')),
      unipolarMv: cartoNumber(attr('Voltages', 'Unipolar')),
      woiMs: (woiFrom != null && woiTo != null) ? [woiFrom, woiTo] : null,
      mapAnnotation: cartoNumber(attr('Annotations', 'Map_Annotation')),
      // Nur der nackte Name: ein Verzeichnispfad aus dem Export gehört nicht
      // in etwas, das mit einer Karte weiterreist.
      egmName: ecgName ? ecgName.replace(/^.*[\\/]/, '') : null,
    });
  }
  points.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
  if (unreadable.length) {
    console.warn(`[epview] ${unreadable.length} von ${names.length} `
               + `Punktdateien nicht lesbar: ${unreadable.slice(0, 5).join(', ')}`);
  }
  return points;
}

// Ein Elektrogramm auf Abruf. Der Aufrufer bekommt die Funktion, nicht die
// Daten — das ist der ganze Punkt: erst beim Klick wird gelesen.
export function cartoEgmReader(files) {
  const byName = new Map();
  for (const name of Object.keys(files)) byName.set(name.replace(/^.*\//, ''), name);
  const cache = new Map();
  return (point) => {
    if (!point || !point.egmName) return null;
    if (cache.has(point.egmName)) return cache.get(point.egmName);
    const entry = byName.get(point.egmName);
    if (!entry) return null;
    const egm = parseCartoEcg(decodeLatin1(files[entry]));
    cache.set(point.egmName, egm);
    return egm;
  };
}

/** Die Ablationsaufzeichnung eines CARTO-Exports als Marker-Gruppe.
 *
 * Die drei VisiTag-Dateien werden von `epablation.js` gelesen — derselbe Parser,
 * den die Python-Seite spiegelt. Was hier dazukommt, ist die Übersetzung in das,
 * was die Marker-Ebene versteht.
 *
 * Läsionen ohne Koordinaten bekommen keinen Marker. Im Korpus-Export ist
 * `AdjustedPositions.txt` leer, also sind alle 22 Stellen messbar und keine
 * zeichenbar — und das wird als Notiz zurückgegeben, weil ein leerer Bildschirm
 * sich als „keine Ablation" liest.
 */
export function cartoAblation(files) {
  const find = (name) => {
    const key = Object.keys(files).find(
      n => n.replace(/^.*\//, '').toLowerCase() === name.toLowerCase());
    return key ? decodeLatin1(files[key]) : '';
  };
  const sitesText = find('AblationSites.txt');
  if (!sitesText) return { group: null, sites: [], note: null };

  const sites = readVisitag({
    sites: sitesText,
    data: find('AblationData.txt'),
    positions: find('AdjustedPositions.txt'),
  });
  if (!sites.length) return { group: null, sites: [], note: null };

  const placed = sites.filter(s => s.xyz);
  const summary = summariseAblation(sites);
  const note = placed.length
    ? null
    : `${sites.length} Ablationsstelle(n) gelesen, keine davon verortet — `
      + `AdjustedPositions.txt enthält keine Zeilen. `
      + `${summary.totalDeliveryS != null
          ? Math.round(summary.totalDeliveryS) + ' s Abgabe' : ''}`;

  const group = placed.length ? {
    id: 'carto-ablation', label: 'Ablation', category: 'ablation',
    color: tagCategoryColor('ablation'),
    points: placed.map(s => ({
      position: s.xyz,
      label: `RF ${s.index}`,
      ablation: s,
    })),
  } : null;
  return { group, sites, note };
}

// fflate.unzipSync wird injiziert (Browser: per import; Node-Test: nur .mesh direkt)
export function parseCarto(bytes, unzipSync) {
  if (!unzipSync) throw new Error('ZIP-Entpacker (fflate) nicht verfügbar.');
  return parseCartoEntries(unzipSync(bytes));
}

/** Ein CARTO-Export als Name→Bytes, gleich ob aus dem ZIP oder aus einem Ordner.
 *
 * Ausgepackt liegt derselbe Export als loser Ordner vor — CARTO 3 schreibt ihn
 * so, und wer ihn einmal entpackt hat, packt ihn nicht wieder ein. Der Weg
 * hinein ist derselbe, sobald die Dateien benannt und gelesen sind.
 */
export function parseCartoEntries(files) {
  const meshes = [];
  for (const name of Object.keys(files)) {
    if (!name.toLowerCase().endsWith('.mesh')) continue;
    const text = decodeLatin1(files[name]);
    meshes.push(parseCartoMesh(text, name.replace(/^.*\//, '').replace(/\.mesh$/i, '')));
  }
  // Die Punktliste gehört zur Studie, nicht zu einem einzelnen Mesh, und ist
  // billig. Die Elektrogramme sind es nicht — `readEgm` liest eines erst,
  // wenn danach gefragt wird.
  const points = parseCartoPoints(files);
  const readEgm = cartoEgmReader(files);

  // Punkte ohne Ort bekommen keinen Marker: einer auf (0,0,0) läge mitten in
  // der Kammer und sähe aus wie eine Messung. Sie bleiben in `points`, damit
  // eine Liste sie zeigen kann.
  const placed = points.filter(p => p.xyz);
  const tagGroups = placed.length ? [{
    id: 'carto-points', label: 'Mapping-Punkte', category: 'mapping',
    color: tagCategoryColor('annotation'),
    points: placed.map(p => ({ position: p.xyz, label: `P${p.id}`, egm: p })),
  }] : [];

  const ablation = cartoAblation(files);
  if (ablation.group) tagGroups.push(ablation.group);

  for (const mesh of meshes) {
    mesh.points = points;
    mesh.readEgm = readEgm;
    mesh.ablation = ablation.sites;
    // Gemessen und nicht verortbar ist ein eigener Zustand. Ohne diese Notiz
    // sähe der Nutzer nichts und schlösse daraus, es gebe keine Ablation.
    if (ablation.note) mesh.ablationNote = ablation.note;
    // An die bestehende Marker-Ebene angehängt statt daneben gebaut: Sichtbar-
    // keit, Größe und Projektion gelten dann für beides gleich.
    mesh.tagGroups = (mesh.tagGroups || []).concat(tagGroups);
  }
  return meshes;
}

/* ===================================================================== *
 *  Mesh-Leser: PLY (ascii + binär) / OBJ / STL (ascii + binär)
 *  Liefern dieselbe Form wie die Studien-Parser, plus `colors`/`scalarNames`.
 * ===================================================================== */

// Wachsender Uint32-Puffer für Face-Indizes: spart das Zwischenspiel aus
// JS-Array + Kopie am Ende (P-10). `cap` ist eine Schätzung, keine Grenze.
function faceBuf(cap) {
  let a = new Uint32Array(Math.max(3, (cap * 3) | 0)), n = 0;
  return {
    push3(i, j, k) {
      if (n + 3 > a.length) { const b = new Uint32Array(Math.max(a.length * 2, n + 3)); b.set(a.subarray(0, n)); a = b; }
      a[n++] = i; a[n++] = j; a[n++] = k;
    },
    fan(idx) { for (let j = 2; j < idx.length; j++) this.push3(idx[0], idx[j - 1], idx[j]); },
    done() { return a.slice(0, n); },
  };
}

function assignVertex(name, v, val, positions, normals, colors, scalars) {
  switch (name) {
    case 'x': positions[v*3] = val; break;
    case 'y': positions[v*3+1] = val; break;
    case 'z': positions[v*3+2] = val; break;
    case 'nx': if (normals) normals[v*3] = val; break;
    case 'ny': if (normals) normals[v*3+1] = val; break;
    case 'nz': if (normals) normals[v*3+2] = val; break;
    case 'red': case 'r': if (colors) colors[v*3] = val; break;
    case 'green': case 'g': if (colors) colors[v*3+1] = val; break;
    case 'blue': case 'b': if (colors) colors[v*3+2] = val; break;
    case 'alpha': case 'a': break;
    default: if (scalars[name]) scalars[name][v] = val;
  }
}

export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  // latin1 dekodiert 1 Byte -> 1 Zeichen, daher ist der String-Index identisch
  // zum Byte-Offset (wichtig für den Binär-Body). Eine einzige native Dekodierung
  // statt zeichenweisem Aufbau -> O(n) statt O(n²), auch bei 200k-Vertex-Meshes.
  const full = new TextDecoder('latin1').decode(bytes);
  const he = full.match(/end_header\r?\n/);
  if (!he) throw new Error('PLY: kein end_header');
  const headerEnd = he.index + he[0].length;

  const header = full.slice(0, he.index);
  const lines = header.split(/\r?\n/);
  let format = 'ascii';
  const elements = [];
  let cur = null;
  let tagGroups = null;
  for (const ln of lines) {
    const p = ln.trim().split(/\s+/);
    if (p[0] === 'format') format = p[1];
    else if (p[0] === 'comment') { const g = decodeTagComment(ln.trim().replace(/^comment\s+/, '')); if (g) tagGroups = g; }
    else if (p[0] === 'element') { cur = { name: p[1], count: +p[2], props: [] }; elements.push(cur); }
    else if (p[0] === 'property' && cur) {
      if (p[1] === 'list') cur.props.push({ list: true, countType: p[2], itemType: p[3], name: p[4] });
      else cur.props.push({ list: false, type: p[1], name: p[2] });
    }
  }

  const vEl = elements.find(e => e.name === 'vertex');
  const fEl = elements.find(e => e.name === 'face');
  if (!vEl) throw new Error('PLY: kein vertex-Element');

  const positions = new Float32Array(vEl.count * 3);
  let normals = null, colors = null;
  const hasN = vEl.props.some(p => p.name === 'nx');
  const hasC = vEl.props.some(p => p.name === 'red' || p.name === 'r');
  if (hasN) normals = new Float32Array(vEl.count * 3);
  if (hasC) colors = new Uint8Array(vEl.count * 3);
  const scalarNames = vEl.props
    .filter(p => !p.list && !['x','y','z','nx','ny','nz','red','green','blue','r','g','b','alpha','a'].includes(p.name))
    .map(p => p.name);
  const scalars = {};
  scalarNames.forEach(n => scalars[n] = new Float32Array(vEl.count));

  const faces = faceBuf(fEl ? fEl.count : 0);

  if (format === 'ascii') {
    // P-9: `split(/\s+/)` auf dem Körper erzeugte bei 200k Vertices zwei
    // Millionen Einzelstrings vorab. Der Offset-Scanner liest an Ort und Stelle.
    const L = full.length;
    let sp = headerEnd;
    const tok = () => {
      while (sp < L && full.charCodeAt(sp) <= 32) sp++;
      const st = sp;
      while (sp < L && full.charCodeAt(sp) > 32) sp++;
      return st === sp ? '' : full.slice(st, sp);
    };
    for (let v = 0; v < vEl.count; v++) {
      for (const pr of vEl.props) assignVertex(pr.name, v, parseFloat(tok()), positions, normals, colors, scalars);
    }
    if (fEl) for (let f = 0; f < fEl.count; f++) {
      const cnt = parseInt(tok(), 10);
      if (!Number.isFinite(cnt)) break;
      const idx = new Array(cnt);
      for (let j = 0; j < cnt; j++) idx[j] = parseInt(tok(), 10);
      faces.fan(idx);
    }
  } else {
    const le = format.indexOf('little') >= 0;
    const dv = new DataView(buffer);
    let off = headerEnd;
    const readScalar = (type) => {
      let val;
      switch (type) {
        case 'char': case 'int8': val = dv.getInt8(off); off += 1; break;
        case 'uchar': case 'uint8': val = dv.getUint8(off); off += 1; break;
        case 'short': case 'int16': val = dv.getInt16(off, le); off += 2; break;
        case 'ushort': case 'uint16': val = dv.getUint16(off, le); off += 2; break;
        case 'int': case 'int32': val = dv.getInt32(off, le); off += 4; break;
        case 'uint': case 'uint32': val = dv.getUint32(off, le); off += 4; break;
        case 'float': case 'float32': val = dv.getFloat32(off, le); off += 4; break;
        case 'double': case 'float64': val = dv.getFloat64(off, le); off += 8; break;
        default: throw new Error('PLY: Typ ' + type);
      }
      return val;
    };
    for (let v = 0; v < vEl.count; v++) {
      for (const pr of vEl.props) assignVertex(pr.name, v, readScalar(pr.type), positions, normals, colors, scalars);
    }
    if (fEl) for (let f = 0; f < fEl.count; f++) {
      for (const pr of fEl.props) {
        if (pr.list) {
          const cnt = readScalar(pr.countType);
          const idx = new Array(cnt);
          for (let j = 0; j < cnt; j++) idx[j] = readScalar(pr.itemType);
          faces.fan(idx);
        } else readScalar(pr.type);
      }
    }
  }

  return { positions, normals, colors, scalars, scalarNames, faces: faces.done(), tagGroups };
}

/* OBJ (positions, normals, vertex colors, faces) — no scalars */
export function parseOBJ(text) {
  const pos = [], nor = [], col = [];
  const faces = faceBuf(0);
  let hasC = false, hasN = false;
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    if (ln[0] === 'v' && ln[1] === ' ') {
      const p = ln.split(/\s+/);
      pos.push(+p[1], +p[2], +p[3]);
      if (p.length >= 7) { hasC = true; col.push(+p[4], +p[5], +p[6]); } else col.push(1,1,1);
    } else if (ln[0] === 'v' && ln[1] === 'n') {
      const p = ln.split(/\s+/); nor.push(+p[1], +p[2], +p[3]); hasN = true;
    } else if (ln[0] === 'f' && ln[1] === ' ') {
      const p = ln.trim().split(/\s+/).slice(1).map(s => parseInt(s.split('/')[0], 10) - 1);
      faces.fan(p);
    }
  }
  const n = pos.length / 3;
  const colors = hasC ? new Uint8Array(n*3) : null;
  if (hasC) for (let i = 0; i < n*3; i++) colors[i] = Math.round(col[i]*255);
  // OBJ-Normalen sind eine eigene indizierte Liste (v//vn). Diese vereinfachte,
  // positions-indizierte Pipeline kann sie nur 1:1 übernehmen, wenn #vn == #v;
  // sonst computeVertexNormals() überlassen, statt eine falsch-lange/verrutschte
  // Normalen-Attribut zu binden.
  const normals = (hasN && nor.length === pos.length) ? new Float32Array(nor) : null;
  return {
    positions: new Float32Array(pos),
    normals,
    colors, scalars: {}, scalarNames: [], faces: faces.done(),
  };
}

/* STL (binary + ascii) — geometry only */
export function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // P-10: die Dreieckszahl steht an Byte 80 — direkt in ein Float32Array
  // schreiben statt über ein wachsendes JS-Array (25,5 ms -> 5,7 ms bei 500k).
  const readBinary = () => {
    const fits = Math.max(0, Math.floor((bytes.length - 84) / 50));
    const tri = Math.min(dv.getUint32(80, true), fits);
    const out = new Float32Array(tri * 9);
    let off = 84, w = 0;
    for (let t = 0; t < tri; t++) {
      off += 12; // Facetten-Normale überspringen
      for (let k = 0; k < 3; k++) {
        out[w++] = dv.getFloat32(off, true);
        out[w++] = dv.getFloat32(off + 4, true);
        out[w++] = dv.getFloat32(off + 8, true);
        off += 12;
      }
      off += 2; // Attribut-Byte-Count
    }
    return out;
  };

  // Binär-STL erkennen: Header(80) + count(4) + count*50 == Dateigröße.
  // Bei exakter Übereinstimmung sicher binär; sonst zuerst ASCII versuchen und
  // bei 0 Vertices auf Binär zurückfallen (toleriert Padding/Trailing-Bytes).
  let positions;
  const binary = bytes.length > 84 && (84 + dv.getUint32(80, true) * 50 === bytes.length);
  if (binary) {
    positions = readBinary();
  } else {
    const txt = new TextDecoder('latin1').decode(bytes);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
    const pos = [];
    while ((m = re.exec(txt))) pos.push(+m[1], +m[2], +m[3]);
    if (pos.length) positions = new Float32Array(pos);
    else positions = bytes.length > 84 ? readBinary() : new Float32Array(0);   // Fallback
  }
  const faces = new Uint32Array(positions.length / 3);
  for (let i = 0; i < faces.length; i++) faces[i] = i;
  return { positions, normals: null, colors: null, scalars: {}, scalarNames: [], faces };
}

/* ===================================================================== *
 *  Exporter:  PLY (binär/ascii) / OBJ / STL (binär)
 *  colors: Uint8Array(n*3) | null
 * ===================================================================== */

// Gemeinsamer Header für beide PLY-Varianten.
function plyHeader(format, nv, nf, hasN, hasC, scalarNames, comments) {
  const h = ['ply', 'format ' + format + ' 1.0'];
  for (const c of comments) h.push('comment ' + c);
  h.push(`element vertex ${nv}`, 'property float x', 'property float y', 'property float z');
  if (hasN) h.push('property float nx', 'property float ny', 'property float nz');
  if (hasC) h.push('property uchar red', 'property uchar green', 'property uchar blue');
  for (const s of scalarNames) h.push(`property float ${s}`);
  h.push(`element face ${nf}`, 'property list uchar int vertex_indices', 'end_header');
  return h.join('\n') + '\n';
}

function plyParts(mesh, colors) {
  const { positions, normals, faces, scalars } = mesh;
  const nv = positions.length / 3, nf = (faces.length / 3) | 0;
  const hasN = !!normals, hasC = !!(colors && colors.length === nv * 3);
  const scalarNames = Object.keys(scalars || {}).filter(k => scalars[k] && scalars[k].length === nv);
  return { positions, normals, faces, scalars, nv, nf, hasN, hasC, scalarNames };
}

// binary_little_endian — Default für Export und Teilen: 43x schneller als der
// ASCII-Pfad und rund halb so groß. `parsePLY` im Viewer liest es bereits.
export function exportPLYBinary(mesh, colors, comments = []) {
  const { positions, normals, faces, scalars, nv, nf, hasN, hasC, scalarNames } = plyParts(mesh, colors);
  const head = plyHeader('binary_little_endian', nv, nf, hasN, hasC, scalarNames, comments);
  const headBytes = new TextEncoder().encode(head);
  const vStride = 12 + (hasN ? 12 : 0) + (hasC ? 3 : 0) + scalarNames.length * 4;
  const fStride = 1 + 12;
  const buf = new ArrayBuffer(headBytes.length + nv * vStride + nf * fStride);
  const u8 = new Uint8Array(buf);
  u8.set(headBytes, 0);
  const dv = new DataView(buf);
  let off = headBytes.length;
  const cols = scalarNames.map(s => scalars[s]);
  for (let i = 0; i < nv; i++) {
    dv.setFloat32(off, positions[i*3], true);
    dv.setFloat32(off + 4, positions[i*3+1], true);
    dv.setFloat32(off + 8, positions[i*3+2], true);
    off += 12;
    if (hasN) {
      dv.setFloat32(off, normals[i*3], true);
      dv.setFloat32(off + 4, normals[i*3+1], true);
      dv.setFloat32(off + 8, normals[i*3+2], true);
      off += 12;
    }
    if (hasC) { u8[off] = colors[i*3]; u8[off+1] = colors[i*3+1]; u8[off+2] = colors[i*3+2]; off += 3; }
    for (let s = 0; s < cols.length; s++) { dv.setFloat32(off, cols[s][i], true); off += 4; }
  }
  for (let i = 0; i < nf; i++) {
    u8[off] = 3; off += 1;
    dv.setInt32(off, faces[i*3], true);
    dv.setInt32(off + 4, faces[i*3+1], true);
    dv.setInt32(off + 8, faces[i*3+2], true);
    off += 12;
  }
  return buf;
}

export function exportPLY(mesh, colors, comments = []) {
  const { positions, normals, faces, scalars, nv, nf, hasN, hasC, scalarNames } = plyParts(mesh, colors);
  const lines = [plyHeader('ascii', nv, nf, hasN, hasC, scalarNames, comments).replace(/\n$/, '')];
  for (let i = 0; i < nv; i++) {
    let row = `${positions[i*3].toFixed(6)} ${positions[i*3+1].toFixed(6)} ${positions[i*3+2].toFixed(6)}`;
    if (hasN) row += ` ${normals[i*3].toFixed(6)} ${normals[i*3+1].toFixed(6)} ${normals[i*3+2].toFixed(6)}`;
    if (hasC) row += ` ${colors[i*3]} ${colors[i*3+1]} ${colors[i*3+2]}`;
    for (const s of scalarNames) row += ' ' + fmtG(scalars[s][i]);
    lines.push(row);
  }
  for (let i = 0; i < nf; i++) lines.push(`3 ${faces[i*3]} ${faces[i*3+1]} ${faces[i*3+2]}`);
  return lines.join('\n') + '\n';
}

export function exportOBJ(mesh, colors) {
  const { positions, normals, faces } = mesh;
  const nv = positions.length / 3, nf = faces.length / 3;
  const hasN = !!normals, hasC = colors && colors.length === nv * 3;
  const lines = ['# EPView OBJ Export', `# ${nv} vertices, ${nf} faces`, ''];
  for (let i = 0; i < nv; i++) {
    let row = `v ${positions[i*3].toFixed(6)} ${positions[i*3+1].toFixed(6)} ${positions[i*3+2].toFixed(6)}`;
    if (hasC) row += ` ${(colors[i*3]/255).toFixed(4)} ${(colors[i*3+1]/255).toFixed(4)} ${(colors[i*3+2]/255).toFixed(4)}`;
    lines.push(row);
  }
  if (hasN) { lines.push(''); for (let i = 0; i < nv; i++) lines.push(`vn ${normals[i*3].toFixed(6)} ${normals[i*3+1].toFixed(6)} ${normals[i*3+2].toFixed(6)}`); }
  lines.push('');
  for (let i = 0; i < nf; i++) {
    const a = faces[i*3]+1, b = faces[i*3+1]+1, c = faces[i*3+2]+1;
    lines.push(hasN ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
  }
  return lines.join('\n') + '\n';
}

export function exportSTL(mesh) {
  const { positions, normals, faces } = mesh;
  const nf = faces.length / 3;
  const buf = new ArrayBuffer(84 + nf * 50);
  const dv = new DataView(buf);
  const head = 'EPView 3D Export';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nf, true);
  let off = 84;
  for (let i = 0; i < nf; i++) {
    let a = faces[i*3], b = faces[i*3+1], c = faces[i*3+2];
    let ax=positions[a*3],ay=positions[a*3+1],az=positions[a*3+2];
    let bx=positions[b*3],by=positions[b*3+1],bz=positions[b*3+2];
    let cx=positions[c*3],cy=positions[c*3+1],cz=positions[c*3+2];
    let nx=(by-ay)*(cz-az)-(bz-az)*(cy-ay);
    let ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az);
    let nz=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    let len = Math.hypot(nx,ny,nz) || 1; nx/=len; ny/=len; nz/=len;
    if (normals) { // Orientierung + Winding nach außen erzwingen
      const vnx=normals[a*3]+normals[b*3]+normals[c*3], vny=normals[a*3+1]+normals[b*3+1]+normals[c*3+1], vnz=normals[a*3+2]+normals[b*3+2]+normals[c*3+2];
      if (nx*vnx+ny*vny+nz*vnz < 0) { nx=-nx;ny=-ny;nz=-nz; const tx=bx,ty=by,tz=bz; bx=cx;by=cy;bz=cz; cx=tx;cy=ty;cz=tz; }
    }
    dv.setFloat32(off, nx, true); dv.setFloat32(off+4, ny, true); dv.setFloat32(off+8, nz, true);
    dv.setFloat32(off+12, ax, true); dv.setFloat32(off+16, ay, true); dv.setFloat32(off+20, az, true);
    dv.setFloat32(off+24, bx, true); dv.setFloat32(off+28, by, true); dv.setFloat32(off+32, bz, true);
    dv.setFloat32(off+36, cx, true); dv.setFloat32(off+40, cy, true); dv.setFloat32(off+44, cz, true);
    dv.setUint16(off+48, 0, true);
    off += 50;
  }
  return buf;
}

function fmtG(v) {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  // ~ Python %.6g
  let s = v.toPrecision(6);
  if (s.indexOf('.') >= 0 && s.indexOf('e') < 0) s = s.replace(/\.?0+$/, '');
  return s;
}

/* ===================================================================== *
 *  Studien in einem geöffneten Ordner finden
 *
 *  Ein Ordner ist selten genau eine Studie. Wer den Ordner öffnet, in dem
 *  seine Exporte liegen, hat Hersteller-Ordner mit Studien darin — und alles
 *  in einen Topf zu werfen ergibt eine Rhythmia-Studie aus den Teilen dreier
 *  Untersuchungen. Deshalb wird gruppiert, bevor gelesen wird.
 *
 *  Grundlage ist `webkitRelativePath`, den der Browser beim Ordner-Öffnen
 *  setzt. Fehlt er (einzeln gewählte Dateien), gibt es genau eine Gruppe —
 *  dann hat der Nutzer die Auswahl selbst getroffen.
 * ===================================================================== */

/** Wo eine Datei liegt, relativ zum geöffneten Ordner. */
function pathOf(file) {
  return file.webkitRelativePath || file.name;
}

function dirOf(file) {
  const path = pathOf(file);
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** Woran ein Verzeichnis als Studie eines Systems zu erkennen ist.
 *
 *  Reihenfolge zählt: ein CARTO-Export trägt `*_Points_Export.xml`, und ein
 *  Muster, das jede XML-Datei als EnSite liest, macht daraus eine zweite,
 *  leere Studie neben der richtigen.
 */
const STUDY_MARKERS = [
  { kind: 'rhythmia', readable: true, test: (n) => /\.\d{3}$/.test(n) },
  { kind: 'carto', readable: true, test: (n) => n.endsWith('.mesh') },
  { kind: 'carto', readable: true, test: (n) => n.endsWith('.zip') },
  // EnSite/Velocity packt die Studie in ein geteiltes tar-Archiv. Der Leser
  // dafür steht in epcore.epview (Python) — im Browser ist die Studie zu
  // erkennen und nicht zu öffnen, und das ist etwas anderes als "nichts da".
  { kind: 'ensite-velocity', readable: false, test: (n) => /\.tar\.gz[a-z]{2}$/.test(n) },
  { kind: 'ensite', readable: true, test: (n) => n === 'geometry.bin' },
  { kind: 'ensite', readable: true,
    test: (n) => n.endsWith('.xml') && !n.endsWith('_points_export.xml') },
];

function markerFor(name) {
  const lower = name.toLowerCase();
  return STUDY_MARKERS.find(marker => marker.test(lower)) || null;
}

/**
 * Die Studien in einer Dateiliste, jede mit ihren eigenen Dateien.
 *
 * Eine Studie ist ein Verzeichnis, in dem eine Kennzeichnungsdatei *direkt*
 * liegt; alles darunter gehört dazu (CARTO legt seine VisiTag-Dateien in einen
 * Unterordner, Rhythmia seine Bildschirmfotos daneben). Verzeichnisse unter
 * einer erkannten Studie werden nicht noch einmal gezählt.
 */
export function groupStudies(files) {
  const all = Array.from(files);
  const kindOfDir = new Map();

  for (const file of all) {
    const marker = markerFor(file.name);
    if (!marker) continue;
    const dir = dirOf(file);
    const known = kindOfDir.get(dir);
    // Der erste Treffer entscheidet, und die Liste steht in der Reihenfolge,
    // in der die Kennzeichen eindeutig sind.
    if (!known || STUDY_MARKERS.indexOf(marker) < STUDY_MARKERS.indexOf(known)) {
      kindOfDir.set(dir, marker);
    }
  }

  const roots = [...kindOfDir.keys()].sort();
  const outer = roots.filter(dir => !roots.some(
    other => other !== dir && other.length < dir.length && dir.startsWith(other + '/')));

  return outer.map(root => {
    const marker = kindOfDir.get(root);
    const inside = all.filter(file => {
      const dir = dirOf(file);
      return dir === root || (root === '' ? true : dir.startsWith(root + '/'));
    });
    return {
      root,
      // Der Ordnername ist der Name, unter dem der Nutzer die Studie kennt.
      label: root ? root.slice(root.lastIndexOf('/') + 1) : (inside[0]?.name ?? 'Export'),
      kind: marker.kind,
      readable: marker.readable,
      files: inside,
    };
  });
}

/* --------------------- Dispatcher nach Dateiendung --------------------- */
// files: File[]  (Browser).  unzipSync: fflate-Funktion (für .zip).
export async function loadRawFiles(files, unzipSync, onProgress) {
  const names = files.map(f => f.name.toLowerCase());
  const isRhythmia = names.some(n => /\.\d{3}$/.test(n));
  const zip = files.find(f => f.name.toLowerCase().endsWith('.zip'));
  const xml = files.find(f => f.name.toLowerCase().endsWith('.xml'));

  if (isRhythmia) {
    // Streaming: lädt das (ggf. mehrere GB große) Archiv nie komplett in den
    // Speicher, sondern liest nur XML-Text + die benötigten Mesh-/Skalar-Blöcke.
    return parseRhythmiaFiles(files, onProgress);
  }
  if (zip) return parseCarto(new Uint8Array(await zip.arrayBuffer()), unzipSync);
  // Ein ausgepackter CARTO-Ordner: dieselben Dateien, nur ohne ZIP darum. Ohne
  // diesen Zweig meldete der ausgepackte Export "Unbekanntes Rohformat" — und
  // ausgepackt liegt er auf jedem Stick, den ein Labor weitergibt.
  if (names.some(n => n.endsWith('.mesh'))) {
    // Nur, was ein CARTO-Export ausmacht: ein Studienordner trägt auch
    // Fluoroskopie und Videos, und die gehören nicht in den Speicher, bloß weil
    // sie danebenliegen.
    const entries = {};
    for (const f of files) {
      if (!/\.(mesh|txt|xml|car)$/i.test(f.name)) continue;
      entries[f.name] = new Uint8Array(await f.arrayBuffer());
    }
    return parseCartoEntries(entries);
  }
  if (xml) {
    // EnSite trennt Geometrie und Messwerte auf zwei Dateien. Liegt die CSV
    // dabei, kommen die Punkte mit; liegt sie nicht dabei, bleibt es bei der
    // Oberfläche.
    const csv = files.find(f => f.name.toLowerCase().endsWith('.csv'));
    return parseEnSite(await xml.text(), csv ? await csv.text() : null);
  }
  throw new Error('Unbekanntes Rohformat. Erwartet: Rhythmia (.000/.001…), CARTO (.zip) oder EnSite (.xml, optional mit DxL-.csv).');
}
