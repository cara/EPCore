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

import { hexToRgb, parseXyz, tagCategoryColor, assignTagsToMeshes, decodeTagComment,
         encodeTagComment } from './epmap.js?v=4b3d0b3d9885';
import { readVisitag, summarise as summariseAblation } from './epablation.js?v=4b3d0b3d9885';

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

/* Jeder Nachfahre in Dokumentreihenfolge — für eine Regel, die nach der Art
 * eines Elements entscheidet, statt nach einem festen Tagnamen zu suchen. */
function* iterAll(el) {
  for (const c of el.children) { yield c; yield* iterAll(c); }
}

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

/* Warum ein Leser keine Millisekunden hat, oder gar keine Tabelle.
 *
 * Eine Schreibweise, von beiden Sprachen benutzt — wortgleich mit
 * `rhythmia_layout.REASONS`. Ein Vokabular, das auseinanderläuft, ist ein
 * Unterschied, den niemand sieht: ein vertippter Grund erreicht den Betrachter,
 * wo `map.reason.<tippfehler>` keinen Katalogeintrag findet und als
 * `⟦map.reason.<tippfehler>⟧` erscheint — in allen drei Sprachen gleich. Ein
 * Konformanztest hält beide Listen aneinander. */
export const RHYTHMIA_REASONS = [
  'no-engine-output',
  'engine-output-unreadable',
  'engine-output-multiple',
  'mesh-blob-unreadable',
  'no-beat-window',
  'window-mismatch',
  'lat-index-outside-window',
  'vertex-count-mismatch',
  'map-source-duplicate',
  'vertex-outside-window',
  'layout-mismatch',
];

/* Hinweise behalten den Wert und sagen etwas dazu. Wortgleich mit
 * `rhythmia_layout.NOTES`. */
export const RHYTHMIA_NOTES = ['c-grid-ambiguous', 'voltage-below-grid-floor'];

/** Einer der Gründe, sonst ein Fehler hier statt einer Klammer auf dem Schirm.
 *
 * Die Regel und ihr Grund stehen einmal, in `rhythmia_layout.reason`; Python
 * nennt denselben Absatz.
 */
export function rhythmiaReason(name) {
  if (!RHYTHMIA_REASONS.includes(name)) {
    throw new Error(`${name} ist keiner der Gründe, die ein Leser nennen darf; `
      + `bekannt: ${RHYTHMIA_REASONS.join(', ')}`);
  }
  return name;
}

/** Einer der Hinweise, zu denselben Bedingungen. */
export function rhythmiaNote(name) {
  if (!RHYTHMIA_NOTES.includes(name)) {
    throw new Error(`${name} ist keiner der Hinweise; `
      + `bekannt: ${RHYTHMIA_NOTES.join(', ')}`);
  }
  return name;
}

/* Entities, die ein Rhythmia-Archiv schreibt, obwohl XML sie nicht kennt.
 *
 * Dieselbe Tabelle steht in `rhythmia_layout.HTML_ENTITIES`. Sie muss dieselbe
 * bleiben: Archivleser, Konverter und Browser sollen aus einer Beschriftung
 * denselben Namen machen und nicht drei (Befund §7); ein Konformanztest hält
 * beide Seiten aneinander. */
export const RHYTHMIA_HTML_ENTITIES = {
  '&nbsp;': ' ', '&auml;': 'ä', '&ouml;': 'ö', '&uuml;': 'ü', '&Auml;': 'Ä',
  '&Ouml;': 'Ö', '&Uuml;': 'Ü', '&szlig;': 'ß', '&aacute;': 'á', '&eacute;': 'é',
  '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ', '&copy;': '©',
  '&reg;': '®', '&deg;': '°', '&micro;': 'µ', '&plusmn;': '±',
};

/** Die Entities des Archivs als Zeichen, genau wie der Konverter es tut. */
export function resolveRhythmiaEntities(text) {
  for (const [e, r] of Object.entries(RHYTHMIA_HTML_ENTITIES)) text = text.split(e).join(r);
  // restliche undefinierte &wort; entfernen (nicht &amp;&lt;&gt;&quot;&apos;&#..)
  return text.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)(\w+);/g, '$1');
}

/* Der XML-Text so, wie er geschrieben wurde: UTF-8.
 *
 * Gescannt wird das Archiv als latin1 — anders lassen sich Bytes und Markup
 * nicht in einem Durchgang durchlaufen. Das XML darin ist aber UTF-8, und eine
 * Beschriftung mit Umlaut kommt so als zwei Zeichen an. Zurückgedreht wird
 * erst hier, wenn die Blockgrenzen längst feststehen: die Byte-Arithmetik
 * bleibt unangetastet, und alle drei Leser bekommen denselben Namen.
 * `rhythmia_points._as_text` macht dasselbe auf der Python-Seite. */
function utf8FromLatin1(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8').decode(bytes);
}

function sanitizeXml(xml) {
  return resolveRhythmiaEntities(utf8FromLatin1(xml));
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
function elText(el) { return el && el.textContent != null ? el.textContent.trim() : ''; }

/** Ein Attribut, in welcher Schreibung es auch dasteht — `rhythmia_layout.attribute`.
 *
 * Gemessen statt angenommen: `DOMParser` mit `'application/xml'` — der Modus,
 * den `parseXmlTolerant` zuerst nimmt und den ein vollständiges Archiv nie
 * verlässt — behält die Schreibung der Attributnamen, in Chromium **und** in
 * WebKit: für `FNAME="a.dat"` gibt `getAttribute('fname')` dort `null` zurück
 * und `getAttribute('FNAME')` den Wert. Nur der HTML-Rückfall, den ein
 * abgeschnittenes Archiv auslöst, schreibt sie klein.
 *
 * Der Archivleser faltet die Schreibung (`layout.attribute_in_tag`). Ohne
 * dieselbe Faltung hier stand die Regel nur zur Hälfte: ein Block mit `FNAME=`
 * war dort eine Aufzeichnung und hier keine — kein *anderes* Fenster, sondern
 * ein Leser, der stillschweigend weniger Blöcke führt als der andere, und ein
 * Punkt, dem „keine Aufzeichnung deckt diesen Zeitpunkt" geantwortet wird.
 */
export function rhythmiaAttribute(el, name) {
  if (!el) return null;
  const direct = el.getAttribute && el.getAttribute(name);
  if (direct != null) return direct;
  const wanted = String(name).trim().toLowerCase();
  for (const attribute of (el.attributes || [])) {
    if (String(attribute.name).trim().toLowerCase() === wanted) return attribute.value;
  }
  return null;
}

// Rhythmia tags: manual <AnnotationPointSet>/<AnnotationPoint> groups + ablation
// <AutoAnnotationPoint>. Returns [{ id, label, category, color:[r,g,b], points:[{position,label}] }].
/** Ein Annotationspunkt, wie er in der Datei steht — oder nichts. */
function rhythmiaAnnotationPoint(ap) {
  const xyzEl = childByTag(ap, 'xyz'); if (!xyzEl) return null;
  const pos = parseXyz(elText(xyzEl)); if (!pos) return null;
  const ppr = childByTag(ap, 'Properties');
  const plabel = (ppr && (elText(childByTag(ppr, 'OverrideLabel')) || elText(childByTag(ppr, 'Label')))) || '';
  const ts = ppr && (elText(childByTag(ppr, 'Timestamp'))
                 || elText(childByTag(ppr, 'StartTime')));
  return { position: pos, label: plabel,
           // Welche Art von Punkt das ist, entscheidet, welcher Katheter neben
           // ihm steht — ein Ablationspunkt nennt seinen, ein gesetzter nicht.
           kind: 'annotation',
           time: ts != null && ts !== '' ? Number(ts) : null };
}

/* Die beiden Tags, unter denen ein Annotationspunkt steht: der vom Untersucher
 * gesetzte und der, den das System für eine Ablation schreibt. Wortgleich mit
 * `rhythmia_layout.ANNOTATION_POINT_TAGS`. */
const RHYTHMIA_ANNOTATION_POINT_TAGS = ['AnnotationPoint', 'AutoAnnotationPoint'];

/** Welche Art von Annotationspunkt dieses Element ist, oder null.
 *
 * Die Schreibung entscheidet nichts. Die Regel und ihr Grund stehen einmal, in
 * `rhythmia_layout.annotation_point_kind`; Python nennt denselben Absatz.
 *
 * Die Regel stand dort und wurde von *keiner* Seite aufgerufen: jede hielt ihre
 * eigene Schreibung des Tags, und die beiden waren sich uneins. Diese Seite
 * faltet — der tolerante HTML-Parser schreibt jedes Tag klein —, der Archivleser
 * verglich auf Schreibung. Ein `<ANNOTATIONPOINT>` zeichnete der Browser also,
 * und in der Liste des Archivlesers fehlte er; das ist die Liste, die in den
 * OpenEP-Export geht.
 */
function rhythmiaAnnotationPointKind(tag) {
  if (tag == null) return null;
  const folded = String(tag).trim().toLowerCase();
  const hit = RHYTHMIA_ANNOTATION_POINT_TAGS.find((name) => name.toLowerCase() === folded);
  if (!hit) return null;
  return hit === 'AutoAnnotationPoint' ? 'ablation' : 'annotation';
}

function extractRhythmiaTags(root) {
  const groups = [];
  const inSet = new Set();
  for (const set of iterTag(root, 'AnnotationPointSet')) {
    const props = childByTag(set, 'Properties');
    const label = (props && (elText(childByTag(props, 'OverrideLabel')) || elText(childByTag(props, 'Label')))) || 'Annotation';
    const colorHex = props && elText(childByTag(props, 'Color'));
    const color = (colorHex && hexToRgb(colorHex)) || tagCategoryColor('annotation');
    const points = [];
    // Welche Kinder Punkte sind, entscheidet die Regel — nicht ein Tagname.
    for (const ap of set.children) {
      if (rhythmiaAnnotationPointKind(ap.tagName) !== 'annotation') continue;
      inSet.add(ap);
      const p = rhythmiaAnnotationPoint(ap);
      if (p) points.push(p);
    }
    if (points.length) groups.push({ id: (set.getAttribute && set.getAttribute('id')) || label, label, category: 'annotation', color, points });
  }
  // Jeder Annotationspunkt des Dokuments, gleich was ihn umschließt: ein
  // `AnnotationPointSet` gibt einer Gruppe Namen und Farbe, es macht die Punkte
  // darin nicht erst zu Punkten. Die Regel und ihr Grund stehen einmal, in
  // `rhythmia_layout.annotation_point_kind`; Python nennt denselben Absatz.
  //
  // Ein Durchgang über alle Nachfahren, jeder nach seiner Art gefragt. Vorher
  // zwei Suchen nach je einem festen Tagnamen: `AutoAnnotationPoint` von
  // überall, `AnnotationPoint` nur aus einem Set — die beiden Hälften desselben
  // Lesers waren sich uneins, und der Punkt daneben stand trotzdem im
  // OpenEP-Export.
  const loose = [], abl = [];
  for (const ap of iterAll(root)) {
    const kind = rhythmiaAnnotationPointKind(ap.tagName);
    if (!kind) continue;
    if (kind === 'annotation') {
      if (inSet.has(ap)) continue;
      const p = rhythmiaAnnotationPoint(ap);
      if (p) loose.push(p);
      continue;
    }
    const xyzEl = childByTag(ap, 'xyz'); if (!xyzEl) continue;
    const pos = parseXyz(elText(xyzEl)); if (!pos) continue;
    const ppr = childByTag(ap, 'Properties');
    const seq = ppr && elText(childByTag(ppr, 'SequenceNumber'));
    const ats = ppr && (elText(childByTag(ppr, 'Timestamp'))
                    || elText(childByTag(ppr, 'StartTime')));
    abl.push({ position: pos, label: seq ? ('Abl ' + seq) : 'Abl',
               kind: 'ablation',
               time: ats != null && ats !== '' ? Number(ats) : null,
               // Was an dieser Stelle gemessen wurde. Bisher wurde nur der Ort
               // gelesen und der Rest weggeworfen — dabei steht hier alles, was
               // eine Läsion beschreibt: Dauer, Kraft-Zeit-Integral, Impedanz,
               // Leistung und Temperatur des Generators.
               ablation: rhythmiaLesion(ppr, pos, seq) });
  }
  if (loose.length) {
    groups.push({ id: 'annotation', label: 'Annotation', category: 'annotation',
                  color: tagCategoryColor('annotation'), points: loose });
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
 * falsch ab. Welche Spalte was trägt und worauf ihre Zeiten sich beziehen,
 * wurde an vier Studien und gegen den MATLAB-Export des Herstellers gemessen:
 * docs/findings/rhythmia-messpunkte-und-lat.md.
 *
 * Dieselben Zahlen stehen in `src/epcore/epview/rhythmia_layout.py`, und sie
 * müssen dieselben bleiben: sonst zeigt der Betrachter etwas anderes als die
 * umgewandelte Datei, und niemand sieht es der Karte an. Ein Konformanztest
 * fährt beide Seiten über dieselbe Fixture.
 */
const SURFELEC_NAME = /^surfelec_[0-9a-f]+_all\.dat$/;
const SURFELEC_COLS = 28;

/** Ob dieser Block heißt, wie eine Punkttabelle heißt.
 *
 * Das Verzeichnis ist frei, der Dateiname nicht: `Map1/surfelec_a1_all.dat` und
 * `surfelec_abc123_all.dat` sind beides Punkttabellen, alles andere nicht.
 * Geprüft wird der blanke Dateiname, an beiden Enden verankert. Die Regel und
 * ihr Grund stehen einmal, in `rhythmia_layout.points_fname_ok`; Python nennt
 * denselben Absatz. Diese Seite prüfte ein unverankertes Muster gegen den
 * ganzen Pfad, sodass alles vor `surfelec_` trotzdem passte — und zeichnete
 * eine Tabelle, die der Archivleser nie sah.
 */
function rhythmiaPointsFnameOk(fname) {
  if (fname == null) return false;
  return SURFELEC_NAME.test(String(fname).replace(/^.*\//, ''));
}

/* Die 28 Spalten. Die Spalten 9 und 10 sehen aus wie Millivolt und sind es
 * nicht — sie folgen der echten Spannung um den Faktor 0,21–0,95 und speisen
 * keine Karte; 13–15 sind immer 0, 16 ist die UniDeriv-Spannung, 17–20 haben
 * keine belegte Bedeutung. Sie stehen hier benannt, damit der nächste Leser sie
 * nicht als etwas wiederentdeckt, das sie nicht sind (Befund §2). */
const SURFELEC = { time: 0, xyz: 1, spline: 4, onSpline: 5, electrode: 6,
                   latUnipolar: 7, latBipolar: 8, lnUvUnipolar: 11, lnUvBipolar: 12,
                   lnUvUniDeriv: 16, surface: 21, normal: 24, included: 27 };

//: Der Schritt des Exporters, nicht der der Uhr: die Uhren ticken mit
//: 953,671875 Hz, 2,2 ppm daneben — innerhalb eines Fensters unsichtbar und
//: genug, um die LAT-Doubles des Herstellerexports um bis zu 4,2e-4 ms zu
//: verfehlen. LAT folgt dem Exporter, Aufzeichnungsfenster folgen der Uhr.
export const RHYTHMIA_RATE_HZ = 953.674;
export const RHYTHMIA_DT_MS = 1000 / RHYTHMIA_RATE_HZ;
export const RHYTHMIA_CLOCK_RATE_HZ = 953.671875;
export const RHYTHMIA_CLOCK_DT_MS = 1000 / RHYTHMIA_CLOCK_RATE_HZ;

//: `Project/Properties/Version` der Archive, an denen die Belegung gemessen
//: wurde. Herkunft, kein Schalter: dieselben Spalten halten über zwei Stände
//: rund 2,5 Jahre auseinander, und einen unbekannten Stand zu verweigern
//: sperrte jede neue Studie ohne gemessenen Grund. Ein unbekannter wird
//: gekennzeichnet und gegen die Karten geprüft, die aus ihm gebaut wurden.
export const RHYTHMIA_VALIDATED_VERSIONS = ['22.07.24.00', '25.02.28.00'];

//: Was eine von EPCore geschriebene Fläche über ihre eigene LAT sagt —
//: wortgleich mit `rhythmia_layout.LAT_COMMENT`. Eine vor dieser Korrektur
//: umgewandelte PLY trägt rohe Abtastindizes unter demselben Namen, und nur
//: diese Zeile unterscheidet die beiden.
export const RHYTHMIA_LAT_COMMENT =
  'epcore-lat: ms from beat marker, (activation + c) x 1000/953.674';

//: Dieselbe Zeile für eine Karte, deren Schlagbeginn auf einer halben Abtastung
//: liegt — wortgleich mit `rhythmia_layout.LAT_COMMENT_C_AMBIGUOUS`. Der
//: Betrachter sagt es am Rand; ohne diesen Zusatz behauptete jede exportierte
//: Kopie ein glattes „ms from beat marker" für eine Spalte, die um 1,049 ms
//: danebenliegen kann.
export const RHYTHMIA_LAT_COMMENT_C_AMBIGUOUS =
  RHYTHMIA_LAT_COMMENT + '; c on a half sample, may be one sample (1.049 ms) out';

/** Welche der beiden Zeilen eine aus diesem Fenster umgewandelte Fläche trägt.
 *
 * Die Entscheidung steht einmal, hier und in `rhythmia_layout.lat_comment`,
 * damit Kopf und OpenEP-Vermerk nicht auseinanderlaufen.
 */
export function rhythmiaLatComment(window) {
  return (window && window.cGridAmbiguous)
    ? RHYTHMIA_LAT_COMMENT_C_AMBIGUOUS : RHYTHMIA_LAT_COMMENT;
}

//: Das Spannungsraster und seine unterste Stufe. Ein gezählter Wert eine halbe
//: Stufe unter ln 10 ist keine Messung: exp(0)/1000 ist 0,001 mV und sähe aus
//: wie eine. Genau ln 10 bleibt 0,01 mV (Befund §8.2).
const LN_UV_STEP = 0.119184;
const LN_UV_GATE = Math.LN10 - LN_UV_STEP / 2;

//: Die Spaltenprüfung (Befund §8.4): wie viele ganzzahlige Vertices geprüft
//: werden, gegen wie viele Elektroden je Vertex, und wie deutlich die *falsche*
//: Spalte gewinnen muss, damit die Belegung als widerlegt gilt.
//:
//: Aus der Messung entschieden, nicht aus der runden Zahl: der Korpuslauf legt
//: die Prüfung allen 19 Karten der vier Studien vor, alle 76 Abstände haben das
//: richtige Vorzeichen, und der kleinste ist ein bipolarer ln-µV-Abstand von
//: +0,279. Die alte Schwelle 0,3 lag darüber — eine richtig gelesene Karte
//: hätte ihre LAT dafür verloren. Die ln-µV-Schwelle ist deshalb eine
//: Rasterstufe: der kleinste Unterschied, den diese Werte überhaupt ausdrücken
//: können. Wortgleich mit `rhythmia_layout`, samt Begründung dort.
const LAYOUT_SAMPLE = 500;
const LAYOUT_NEAREST = 8;
const LAYOUT_MARGIN_LAT = 0.2;
const LAYOUT_MARGIN_LN_UV = LN_UV_STEP;

/** Eine endliche Zahl aus XML-Text, oder null. Nie geraten. */
function rhythmiaNumber(text) {
  if (text == null) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;              // '' ist kein Wert; `Number('')` wäre 0
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** `c`: auf welcher Abtastung des Schlagfensters der Marker sitzt.
 *
 * `floor(x + 0.5)`, nicht `Math.round`: Python rundet die exakte Hälfte zur
 * geraden Zahl und JavaScript nach oben, und eine Regel, die sich bei .5
 * zwischen den beiden Lesern unterscheidet, unterscheidet sich eines Tages auf
 * einer echten Karte. Keine echte Karte liegt genau auf einer Hälfte — die
 * zentrierten verfehlen sie um 3e-4 —, die Richtung ist also Konvention, und
 * die Konvention ist nach oben, auf beiden Vorzeichen.
 */
export function rhythmiaBeatStart(offsetMs) {
  return Math.floor(offsetMs / RHYTHMIA_DT_MS + 0.5);
}

/** Dasselbe auf dem Raster, das die Uhr der Aufzeichnung ergäbe. */
export function rhythmiaClockStart(offsetMs) {
  return Math.floor(offsetMs / RHYTHMIA_CLOCK_DT_MS + 0.5);
}

/** Das Schlagfenster einer Kartenauswertung, oder warum es keines gibt.
 *
 * `W` kommt aus der Spaltenzahl der Konfidenzkurve, wenn sie da ist, sonst aus
 * BeatDuration; beide waren sich auf 19 von 19 echten Karten einig. Sind beide
 * da und um mehr als eine Abtastung uneins, stimmt etwas an der Rate nicht und
 * keine Millisekunde aus diesem Fenster ist belastbar.
 *
 * Gelesen wird über direkte Kinder, nie über `firstTag`: das ist eine
 * Nachfahrensuche und fände die Properties einer eingebetteten Auswertung.
 */
export function rhythmiaBeatWindow(eo) {
  const props = childByTag(eo, 'Properties');
  const offset = rhythmiaNumber(props && elText(childByTag(props, 'BeatOffset')));
  const duration = rhythmiaNumber(props && elText(childByTag(props, 'BeatDuration')));
  const node = childByTag(eo, 'SurfaceElectrodesNode');
  const confwf = node && childByTag(node, 'SurfElectrodesConfidenceWF');
  const bin = confwf && childByTag(confwf, 'inlinedbin');
  const raw = bin && rhythmiaAttribute(bin, 'cols');
  const parsed = raw == null ? NaN : parseInt(raw, 10);
  const columns = Number.isFinite(parsed) ? parsed : null;

  if (offset === null || (duration === null && columns === null)) {
    return { window: null, reason: rhythmiaReason('no-beat-window') };
  }
  if (duration !== null && columns !== null
      && Math.abs(duration / RHYTHMIA_DT_MS - columns) > 1) {
    return { window: null, reason: rhythmiaReason('window-mismatch') };
  }
  const samples = columns !== null ? columns : Math.floor(duration / RHYTHMIA_DT_MS + 0.5);
  // Ein Fenster ohne Abtastungen ist keines; jeder Index läge außerhalb.
  // Gemeldet als Missverhältnis, nicht als Abwesenheit: die Zahlen sind da und
  // passen nicht zueinander.
  if (!(samples > 0)) return { window: null, reason: rhythmiaReason('window-mismatch') };

  const startSample = rhythmiaBeatStart(offset);
  const clockStartSample = rhythmiaClockStart(offset);
  return {
    window: {
      offsetMs: offset, durationMs: duration, samples,
      startSample, clockStartSample,
      // Der ungerundete Quotient als Herkunft: er sagt, wie nah an einer Hälfte
      // eine Karte liegt, und macht eine im unentschiedenen Band wiederfindbar.
      offsetSamples: offset / RHYTHMIA_DT_MS,
      cGridAmbiguous: startSample !== clockStartSample,
    },
    reason: null,
  };
}

/** Ob dieser Softwarestand einer ist, an dem die Belegung gemessen wurde. */
export function rhythmiaVersionChecked(version) {
  return Boolean(version) && RHYTHMIA_VALIDATED_VERSIONS.includes(String(version).trim());
}

/** Der Softwarestand des Archivs. Nur die Version, nie das Label daneben —
 *  das ist ein Studienname. */
function rhythmiaSoftwareVersion(root) {
  const project = (root.tagName && root.tagName.toUpperCase() === 'PROJECT')
    ? root : firstTag(root, 'Project');
  const props = project && childByTag(project, 'Properties');
  return (props && elText(childByTag(props, 'Version'))) || '';
}

/** Die beiden Arten von Kartenblock einer Auswertung, als ihre Tags.
 *
 * Direkte Kinder des `EngineOutput`: eine rekursive Suche fände auch die
 * Blöcke einer eingebetteten Auswertung. Welche Tags dafür zählen, entscheidet
 * `rhythmiaMapBlockKind` — nie ein literaler Vergleich mit dieser Liste.
 */
const RHYTHMIA_MAP_BLOCK_KINDS = ['Activation', 'Voltage'];

/** Welche Art von Kartenblock dieses Element ist, unter ihrem kanonischen Namen.
 *
 * Die Schreibung entscheidet nichts: `Activation`, `ACTIVATION` und
 * `activation` sind eine Art, und zurück kommt immer die kanonische Schreibung,
 * damit beide Seiten alles Weitere gleich verschlüsseln. Die Regel und ihr
 * Grund stehen einmal, in `rhythmia_layout.map_block_kind`; Python nennt
 * denselben Absatz. Diese Seite faltet ohnehin — der tolerante HTML-Parser für
 * abgeschnittene Archive schreibt jedes Tag klein —, Python verglich literal,
 * und die beiden waren sich damit uneins, welche Blöcke eine Auswertung hat.
 */
function rhythmiaMapBlockKind(tag) {
  if (tag == null) return null;
  const folded = String(tag).trim().toLowerCase();
  return RHYTHMIA_MAP_BLOCK_KINDS.find((kind) => kind.toLowerCase() === folded) || null;
}

/** Wie eine Anatomie ohne eigene Beschriftung heißt.
 *
 * Jede `Anatomy` des Dokuments wird gelaufen, in Dokumentreihenfolge, gleich
 * was sie umschließt — und `index` ist diese Stelle, von null an über das ganze
 * Archiv gezählt. Die Regel und ihr Grund stehen einmal, in
 * `rhythmia_layout.anatomy_fallback_name`; Python nennt denselben Absatz.
 * Diese Seite lief schon über `iterTag(root, 'Anatomy')`, der Konverter lief
 * Patient -> Studie -> Anatomie und sah eine daneben stehende nie.
 */
function rhythmiaAnatomyFallbackName(index) {
  return `anatomy_${index}`;
}

/** Wie eine Anatomie heißt: ihre Beschriftung ohne Leerraum, sonst ihre Stelle.
 *
 * Eine Regel, und die Beschriftung wird beschnitten. Sie stand dreimal da und
 * die drei waren sich über den Leerraum uneins — der Archivleser beschnitt,
 * diese Seite und der Konverter nicht. Der Name wird nicht nur gezeigt: der
 * Archivleser legt seine Karten darunter ab, und eine Beschriftung mit einem
 * Leerzeichen am Ende ist dann dieselbe Kammer unter zwei Namen, ohne dass ein
 * Wertevergleich etwas davon merkte. Die Regel und ihr Grund stehen einmal, in
 * `rhythmia_layout.anatomy_name`; Python nennt denselben Absatz.
 */
function rhythmiaAnatomyName(label, index) {
  const text = label == null ? '' : String(label).trim();
  return text || rhythmiaAnatomyFallbackName(index);
}

/** Der Name, unter dem die Quelle eines Kartenblocks verglichen wird.
 *
 * `SrcEgmType` ohne Leerraum und klein geschrieben, ohne Angabe `bipolar`.
 * Klein geschrieben, weil dieser Name nur verglichen und nie gezeigt wird: ein
 * Leser, der die Schreibung behielte, läse `Bipolar` und `bipolar` als zwei
 * Quellen, wo ein anderer eine liest. Die Regel steht einmal, in
 * `rhythmia_layout.map_source_label`.
 */
function rhythmiaMapSourceLabel(named) {
  const text = named == null ? '' : String(named).trim();
  return text ? text.toLowerCase() : 'bipolar';
}

/** Ob eine Art von Block dieselbe Quelle zweimal nennt.
 *
 * `labels` sind die Quellen der Blöcke einer Art, in Dokumentreihenfolge. Die
 * Regel und ihr Grund stehen einmal, in `rhythmia_layout.vertex_lat_ms`, Absatz
 * „One source, one block"; die Python-Seite heißt `map_source_refusal`.
 */
function rhythmiaMapSourceRefusal(labels) {
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label)) return rhythmiaReason('map-source-duplicate');
    seen.add(label);
  }
  return null;
}

/** Ob dieser Block überhaupt eine Karte dieser Anatomie ist.
 *
 * Genau ein Wert je Vertex, sonst verweigert — eingepasst wird nichts. Die
 * Regel und ihr Grund stehen einmal, in `rhythmia_layout.vertex_lat_ms`,
 * Absatz „One value per vertex"; die Python-Seite heißt `vertex_map_refusal`.
 */
function rhythmiaVertexMapRefusal(values, vertexCount) {
  return values.length === vertexCount ? null : rhythmiaReason('vertex-count-mismatch');
}

/** Die Aktivierungswerte einer Karte in ms, oder warum sie zurückgehalten werden.
 *
 * Der gespeicherte Wert ist ein Index in das Schlagfenster, das Fenster muss
 * also bekannt sein; ohne es gibt es weder Nullpunkt noch Schrittweite. Alle 38
 * gemessenen Aktivierungskarten liegen in [0, W+1) — die dichteste 303,994 bei
 * W 303 —, ein Wert außerhalb ist deshalb nicht diese Größe, und die Karte
 * behält ihre Form, statt in einer Einheit beschriftet zu werden, in der sie
 * nicht steht (Befund §8.1).
 *
 * Welche Karten geprüft werden und wessen LAT ein Fehlschlag zurückhält, steht
 * einmal: `rhythmia_layout.vertex_lat_ms`, Absatz „Which maps are gated".
 *
 * Wie lang ein Block sein muss, ebenso: derselbe Docstring, Absatz „One value
 * per vertex" — die Länge wird vor dem Fenster geprüft.
 */
function rhythmiaVertexLatMs(raw, window, vertexCount) {
  const refusal = rhythmiaVertexMapRefusal(raw, vertexCount);
  if (refusal) return { values: null, reason: refusal };
  if (!window) return { values: null, reason: rhythmiaReason('no-beat-window') };
  const limit = window.samples + 1;
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (!Number.isFinite(value)) continue;
    if (!(value >= 0 && value < limit)) {
      return { values: null, reason: rhythmiaReason('vertex-outside-window') };
    }
  }
  // Float32, weil eine Fläche das trägt; gerechnet wird in Float64, damit genau
  // einmal gerundet wird, am Ende.
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = (raw[i] + window.startSample) * RHYTHMIA_DT_MS;
  return { values: out, reason: null };
}

//: Woraus ein Mesh-Block besteht: sechs Float32 je Vertex — Ort und Normale —
//: und drei Int32 je Dreieck. Wortgleich mit `rhythmia_layout`.
const RHYTHMIA_MESH_VERTEX_STRIDE = 24;
const RHYTHMIA_MESH_TRIANGLE_STRIDE = 12;

/** Ob dieses `Mesh` überhaupt lesbar ist — gefragt, bevor etwas behalten wird.
 *
 * Ein Mesh wird ganz genommen oder gar nicht: beide Blöcke werden gemessen,
 * bevor einer von ihnen zugewiesen wird, und ein Mesh, das daran scheitert,
 * wird übersprungen, ohne anzutasten, was ein früheres `Mesh` derselben
 * Anatomie schon ergeben hat. Die Regel und ihr Grund stehen einmal, in
 * `rhythmia_layout.mesh_blob_refusal` („A mesh is taken whole or not at all");
 * Python nennt denselben Absatz. Diese Seite hatte die Form schon — Python wies
 * Vertices und Normalen zu und las die Dreiecke erst danach, sodass ein zweites,
 * kaputtes Mesh neben einem heilen dort die ganze Anatomie verschwinden ließ.
 */
function rhythmiaMeshBlobRefusal(vertexBytes, triangleBytes) {
  if (!vertexBytes || vertexBytes % RHYTHMIA_MESH_VERTEX_STRIDE) {
    return rhythmiaReason('mesh-blob-unreadable');
  }
  if (!triangleBytes || triangleBytes % RHYTHMIA_MESH_TRIANGLE_STRIDE) {
    return rhythmiaReason('mesh-blob-unreadable');
  }
  return null;
}

/** Eine Punkttabelle als Zeilen-/Spaltenzugriff, ohne sie umzukopieren. */
function surfelecView(bytes, rows) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { rows, at: (row, col) => view.getFloat64((row * SURFELEC_COLS + col) * 8, true) };
}

/** Ob die Tabelle selbst sagt, dass sie diese Tabelle nicht ist.
 *
 * Dreierlei hält in jeder Zeile aller 19 gemessenen Karten, und jedes davon
 * scheitert hörbar, wenn eine spätere Fassung eine Spalte verschiebt: die
 * Breite, die Zählmarke als Marke, und die eigene Nummerierung des Korbs.
 */
function surfelecRefusal(table) {
  for (let row = 0; row < table.rows; row++) {
    const flag = table.at(row, SURFELEC.included);
    if (flag !== 0 && flag !== 1) return rhythmiaReason('layout-mismatch');
    const spline = table.at(row, SURFELEC.spline);
    const onSpline = table.at(row, SURFELEC.onSpline);
    const electrode = table.at(row, SURFELEC.electrode);
    if (Number.isFinite(spline) && Number.isFinite(onSpline) && Number.isFinite(electrode)
        && electrode !== 8 * spline + onSpline) return rhythmiaReason('layout-mismatch');
  }
  return null;
}

/** Die `count` nächsten Punkte je Ziel, Gleichstand nach Index.
 *
 * Roh gerechnet: die Stichprobe ist auf 500 begrenzt und eine Elektrodentabelle
 * läuft auf 20 000 Zeilen — das sind zehn Millionen Abstände und kein Grund,
 * dem Browser einen räumlichen Index beizubringen.
 */
function nearestRows(points, targets, count) {
  const k = Math.min(count, points.length);
  const order = (a, b) => (a.d - b.d) || (a.i - b.i);
  return targets.map((target) => {
    const best = [];
    for (let i = 0; i < points.length; i++) {
      const dx = points[i][0] - target[0];
      const dy = points[i][1] - target[1];
      const dz = points[i][2] - target[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (best.length < k) { best.push({ i, d }); best.sort(order); continue; }
      if (d < best[k - 1].d) { best[k - 1] = { i, d }; best.sort(order); }
    }
    return best.map(b => b.i);
  });
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length >> 1;
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/** Ob die Spalten der Tabelle die Karten speisen, die diese Anatomie trägt.
 *
 * Der Softwarestand ist Herkunft, kein Schalter; ein unbekannter wird deshalb
 * nicht verweigert, sondern an den Daten geprüft: ein Vertex mit ganzzahliger
 * Aktivierung trägt den Wert einer Elektrode in seiner Nähe, und die Spannung
 * eines Vertex ist die der nächsten. Beides wird für die richtige Spalte und
 * für die gefragt, mit der sie vertauscht wäre (Befund §8.4).
 *
 * Ein Falsifikat, kein Gütesiegel — und daraus folgt, was es im Zweifel tut:
 * nur ein Vergleich, den die *falsche* Spalte mit der Schwelle gewinnt,
 * widerlegt die Belegung (`ok` false, `refuted` nennt welche). Ein bloß kleiner
 * Abstand lässt die Frage offen (`decided` false) und verweigert nichts — die
 * richtige Spalte hat ihn ja gewonnen. Ist zu wenig zu prüfen, gilt dasselbe:
 * eine glatte Karte ist kein Beleg für eine Vertauschung. Wortgleich mit
 * `rhythmia_layout.layout_agrees`.
 */
export function rhythmiaLayoutAgrees(vertices, raw, table) {
  const counted = [];
  for (let row = 0; row < table.rows; row++) {
    if (table.at(row, SURFELEC.included) === 1) counted.push(row);
  }
  const vertexCount = vertices.length / 3;
  const undecided = { ok: true, decided: false, sampled: 0, margins: {}, shares: {},
                      medians: {}, refuted: [] };
  if (!vertexCount || !counted.length) return undecided;

  const electrodes = counted.map(row => [table.at(row, SURFELEC.surface),
                                         table.at(row, SURFELEC.surface + 1),
                                         table.at(row, SURFELEC.surface + 2)]);
  const sampleOf = (values) => {
    const out = [];
    for (let v = 0; v < vertexCount && out.length < LAYOUT_SAMPLE; v++) {
      const value = values[v];
      if (Number.isFinite(value) && value === Math.floor(value)) out.push(v);
    }
    return out;
  };
  const bipolarSample = sampleOf(raw.bipolar);
  const unipolarSample = sampleOf(raw.unipolar);
  // Weniger Vertices als Nachbarn, gegen die jeder verglichen wird: ein Anteil
  // darüber ist keine Zahl, nach der jemand handeln sollte.
  if (bipolarSample.length < LAYOUT_NEAREST || unipolarSample.length < LAYOUT_NEAREST) {
    return { ...undecided, sampled: bipolarSample.length };
  }

  const placesOf = (sample) => sample.map(
    v => [vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]]);
  const shares = (values, sample, same, other) => {
    const near = nearestRows(electrodes, placesOf(sample), LAYOUT_NEAREST);
    let hitSame = 0, hitOther = 0;
    sample.forEach((v, i) => {
      const value = values[v];
      let sameHit = false, otherHit = false;
      for (const e of near[i]) {
        if (table.at(counted[e], same) === value) sameHit = true;
        if (table.at(counted[e], other) === value) otherHit = true;
      }
      if (sameHit) hitSame++;
      if (otherHit) hitOther++;
    });
    return [hitSame / sample.length, hitOther / sample.length];
  };

  const [share8, share7] = shares(raw.bipolar, bipolarSample,
                                  SURFELEC.latBipolar, SURFELEC.latUnipolar);
  const [uni7, uni8] = shares(raw.unipolar, unipolarSample,
                              SURFELEC.latUnipolar, SURFELEC.latBipolar);

  const one = nearestRows(electrodes, placesOf(bipolarSample), 1);
  const medianOf = (values, col) => median(bipolarSample.map(
    (v, i) => Math.abs(values[v] - table.at(counted[one[i][0]], col))));
  const median12 = medianOf(raw.lnUvBipolar, SURFELEC.lnUvBipolar);
  const median11 = medianOf(raw.lnUvBipolar, SURFELEC.lnUvUnipolar);
  const uniMedian11 = medianOf(raw.lnUvUnipolar, SURFELEC.lnUvUnipolar);
  const uniMedian12 = medianOf(raw.lnUvUnipolar, SURFELEC.lnUvBipolar);

  const round6 = (x) => Math.round(x * 1e6) / 1e6;
  const margins = {
    bipolar_lat: round6(share8 - share7),
    unipolar_lat: round6(uni7 - uni8),
    bipolar_ln_uv: round6(median11 - median12),
    unipolar_ln_uv: round6(uniMedian12 - uniMedian11),
  };
  // Eine Schwelle je Vergleich, und dieselbe in beide Richtungen: gewinnt die
  // falsche Spalte mit ihr, ist die Belegung widerlegt; gewinnt die richtige
  // mit ihr, ist sie bestätigt; dazwischen hat die Karte die Frage nicht
  // beantwortet. In diesem Band zu verweigern hat einer richtigen Karte die
  // LAT genommen (Befund §8.4).
  const bars = { bipolar_lat: LAYOUT_MARGIN_LAT, unipolar_lat: LAYOUT_MARGIN_LAT,
                 bipolar_ln_uv: LAYOUT_MARGIN_LN_UV, unipolar_ln_uv: LAYOUT_MARGIN_LN_UV };
  const refuted = Object.keys(bars).filter(name => margins[name] <= -bars[name]);
  const settled = Object.keys(bars).every(name => margins[name] >= bars[name]);
  return {
    ok: !refuted.length, decided: refuted.length > 0 || settled, refuted,
    sampled: bipolarSample.length, margins,
    shares: { bipolar_col8: share8, bipolar_col7: share7,
              unipolar_col7: uni7, unipolar_col8: uni8 },
    medians: { bipolar_col12: round6(median12), bipolar_col11: round6(median11),
               unipolar_col11: round6(uniMedian11), unipolar_col12: round6(uniMedian12) },
  };
}

/** Eine Punkttabelle lesen: die Messungen einer Karte, mit ihrer Zeitbasis.
 *
 * `beat` ist, was die Auswertung über ihren Schlag sagt — das Fenster, oder der
 * Grund, warum es keines gibt. Ohne Fenster bleiben Ort, Elektrode und Spannung
 * (die sind ohne Schlagmarker nicht weniger wahr), und die Millisekunden fehlen
 * samt Begründung. `check` ist die Spaltenprüfung eines ungeprüften Standes;
 * sie braucht die Tabelle und läuft deshalb hier, wo sie gelesen ist.
 */
async function readRhythmiaPointTable(bin, beat, mapName, anatomyIndex, getPayload,
                                      software, check) {
  const fname = rhythmiaAttribute(bin, 'fname') || '';
  const rows = parseInt(rhythmiaAttribute(bin, 'rows'), 10);
  const cols = parseInt(rhythmiaAttribute(bin, 'cols'), 10);
  // Eine andere Breite ist eine andere Tabelle. Sie trotzdem so zu lesen ergibt
  // Zahlen, die wie Koordinaten aussehen und keine sind.
  if (rhythmiaAttribute(bin, 'type') !== 'Float64' || cols !== SURFELEC_COLS || !rows) {
    return { group: null, refused: 'layout-mismatch' };
  }
  const idx = parseInt((bin.textContent || '').trim(), 10);
  if (!Number.isFinite(idx)) return { group: null, refused: 'layout-mismatch' };
  const bytes = await getPayload(idx);
  if (!bytes || bytes.length < rows * cols * 8) return { group: null, refused: 'layout-mismatch' };

  const table = surfelecView(bytes, rows);
  const refused = surfelecRefusal(table) || (check ? check(table) : null);
  if (refused) {
    try { console.warn(`[epconv] Rhythmia-Punkttabelle ${fname} verweigert: ${refused}`); } catch (e) {}
    return { group: null, refused };
  }

  const window = beat.window;
  let latWithheld = beat.reason || null;
  if (!window) {
    latWithheld = latWithheld || 'no-beat-window';
  } else if (!latWithheld) {
    // Eine schlechte Annotation hält die LAT der ganzen Tabelle zurück, nicht
    // die einer Zeile: eine Tabelle, deren Indizes nicht in dieses Fenster
    // passen, wurde gegen das falsche Fenster gelesen, und der Rest ihrer
    // Zeilen ist um nichts sicherer.
    for (let row = 0; row < rows && !latWithheld; row++) {
      if (table.at(row, SURFELEC.included) !== 1) continue;
      for (const col of [SURFELEC.latBipolar, SURFELEC.latUnipolar]) {
        const index = table.at(row, col);
        if (!Number.isFinite(index) || index !== Math.floor(index)
            || index < 1 || index > window.samples) {
          latWithheld = 'lat-index-outside-window';
          break;
        }
      }
    }
  }

  let belowFloor = 0;
  const voltage = (lnUv) => {
    if (!Number.isFinite(lnUv)) return NaN;
    // Eine ausgeschlossene Zeile trägt dort 0, und exp(0)/1000 = 0,001 mV liest
    // sich als Messung. Alles unter der Rasteruntergrenze ebenso.
    if (lnUv < LN_UV_GATE) { belowFloor++; return NaN; }
    return Math.exp(lnUv) / 1000;
  };

  const start = window ? window.startSample : 0;
  const points = [];
  let excluded = 0;
  for (let row = 0; row < rows; row++) {
    // Was das System nicht gezählt hat, ist keine Messung: es wird als Zahl
    // ausgewiesen und nicht gezeichnet.
    if (table.at(row, SURFELEC.included) !== 1) { excluded++; continue; }
    const bipolarMv = voltage(table.at(row, SURFELEC.lnUvBipolar));
    const unipolarMv = voltage(table.at(row, SURFELEC.lnUvUnipolar));
    // Der auf die Anatomie gezogene Ort, nicht der gemessene: der liegt in der
    // vermessenen Studie im Median 0,50 mm von der Fläche entfernt, und Marker
    // daneben sehen aus wie ein Registrierungsfehler.
    const position = [table.at(row, SURFELEC.surface), table.at(row, SURFELEC.surface + 1),
                      table.at(row, SURFELEC.surface + 2)];
    if (!position.every(Number.isFinite)) continue;
    const electrode = table.at(row, SURFELEC.electrode);
    const latBipolarIndex = table.at(row, SURFELEC.latBipolar);
    const latUnipolarIndex = table.at(row, SURFELEC.latUnipolar);
    points.push({
      position,
      label: `${mapName} · E${Number.isFinite(electrode) ? electrode : '?'}`,
      time: table.at(row, SURFELEC.time),
      electrode: Number.isFinite(electrode) ? electrode : null,
      // Was dieser Punkt ist, und das Schlagfenster seiner eigenen Karte: ohne
      // beides kann das Fenster daneben nicht prüfen, ob die Aufzeichnung zu
      // ihm gehört. Beides bleibt im Speicher — `epmap.scrubTagGroups` gibt nur
      // Ort und Beschriftung in eine PLY weiter.
      kind: 'measurement',
      beat: window,
      // Der gespeicherte Index und die Millisekunde: der Index ist, was in der
      // Datei steht, die Millisekunde, was er bedeutet — beides zu behalten
      // macht das zweite nachrechenbar.
      latBipolarIndex, latUnipolarIndex,
      latBipolarMs: latWithheld ? NaN : (latBipolarIndex - 1 + start) * RHYTHMIA_DT_MS,
      latUnipolarMs: latWithheld ? NaN : (latUnipolarIndex - 1 + start) * RHYTHMIA_DT_MS,
      bipolarMv, unipolarMv,
      latWithheld, software,
    });
  }
  if (!points.length) return { group: null, refused: null };

  const notes = [];
  if (window && window.cGridAmbiguous) notes.push('c-grid-ambiguous');
  if (belowFloor) notes.push({ 'voltage-below-grid-floor': belowFloor });
  return {
    group: {
      id: `mapping-${anatomyIndex}`, label: `${mapName} · Messpunkte`,
      category: 'measurement', color: tagCategoryColor('measurement'),
      points, excluded, rows, fname,
      dataset: fname.includes('/') ? fname.slice(0, fname.lastIndexOf('/')) : '',
      beat: window, latWithheld, notes, software,
    },
    refused: null,
  };
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

//: Die Uhr daneben. Stand als Literal mitten im Blockindex, wo der
//: Konformanztest sie nicht vergleichen konnte — wortgleich mit
//: `rhythmia_points.CLOCK_NAME`.
const RHYTHMIA_CLOCK_NAME = /cardiac_\d+_ts\.dat$/;

//: Wie viel um den Zeitpunkt herum gezeigt wird.
const SIG_WINDOW_S = 1.0;

//: Wortgleich mit `rhythmia_layout.SIGNAL_FLAVOUR_ORDER`.
const RHYTHMIA_SIGNAL_FLAVOUR_ORDER = { B: 0, U: 1, W: 2 };
const RHYTHMIA_SIGNAL_FLAVOUR_LAST = 3;
const RHYTHMIA_SURFACE_ECG_NAME = /surfaceecg/i;

/* Wie ein Aufzeichnungsblock abgelegt ist, was B/U/W bedeuten, und welcher
 * Katheter neben einem Punkt steht. Jede Regel hier ist der Spiegel einer
 * Regel in `rhythmia_layout`; die Belege stehen dort, einmal, und der
 * Konformanztest fährt beide Seiten über dieselbe Fixture.
 *
 * **Ein mehrkanaliger Cardiac-Block liegt zeilenweise**: eine Abtastung aller
 * Kanäle, dann die nächste des ersten — Kanal k der Zeilen [s, s+n) steht als
 * float32 LE bei at + (s*C + k)*4. Diese Seite las spaltenweise, und damit war
 * jedes neben einem Punkt gezeigte Fenster ein echtes Signal aus den falschen
 * Stellen der Aufzeichnung, ohne dass etwas daran verkehrt aussah.
 */
const RHYTHMIA_SIGNAL_ROW_MAJOR = [
  'RTMD<n>|64', 'SurfaceECG<n>_<n>|12', 'Inquiry_Deca<n>_<n>|10',
  'Inquiry_Ten_Ten_Duo_Deca<n>|20', 'INAV<n>|4', 'Freezer<n>|4',
  'Woven_Quadpolar_Catheter<n>|4', 'Woven_Quadpolar_Catheter<n>_<n>|4',
];
const RHYTHMIA_LAYOUT_ROW_MAJOR = 'row-major';

//: U ist unipolar; B und W sind gefilterte Fassungen *einer* Elektrode, keine
//: Differenz zweier (ARX-Residuum 0,0013–0,0055 gegen die eigene U-Ableitung,
//: gegen 0,16–0,56 für eine Differenz). Bipolar heißt nur das Paar, das ein
//: Leser selbst bildet — `RHYTHMIA_PAIR_FLAVOUR`.
const RHYTHMIA_BLOCK_FLAVOURS = ['U', 'B', 'W'];
const RHYTHMIA_PAIR_FLAVOUR = 'B-pair';
const RHYTHMIA_CHANNEL_FLAVOURS = RHYTHMIA_BLOCK_FLAVOURS.concat([RHYTHMIA_PAIR_FLAVOUR]);
const RHYTHMIA_UNIPOLAR_FLAVOUR = 'U';
const RHYTHMIA_FILTERED_FLAVOUR = 'B';

const RHYTHMIA_ECG_FAMILY = 'SurfaceECG<n>_<n>';
const RHYTHMIA_ECG_FLAVOUR = 'U';
const RHYTHMIA_ECG_CHANNELS = 12;
const RHYTHMIA_ECG_LIMB_INDEX = { I: 0, II: 1, III: 2, aVR: 3, aVL: 4, aVF: 5 };
const RHYTHMIA_ECG_IDENTITY_MAX = 0.15;
const RHYTHMIA_ECG_ORDER_IDENTITIES = [['aVL', 'I - II/2'], ['aVF', 'II - I/2'],
                                       ['aVR', '-(I + II)/2']];
const RHYTHMIA_ECG_ORDER_MAX = 0.15;

const RHYTHMIA_ABLATION_PORT = 'AblPort';
const RHYTHMIA_MAPPING_PORT = 'RTMD';
const RHYTHMIA_MAPPING_FAMILIES = ['RTMD<n>|64'];
const RHYTHMIA_SPLINE_POSITIONS = 8;

const RHYTHMIA_WINDOW_REASONS = [
  'no-time', 'no-recording', 'channel-order-unverified',
  'no-ablation-catheter-recording', 'no-mapping-catheter-recording',
  'mapping-electrode-unconfirmed',
];
const RHYTHMIA_WINDOW_NOTES = ['layout-assumed-from-ecg', 'subject-by-ranking'];
const RHYTHMIA_WINDOW_SUBJECTS = ['ablation-port', 'ranking', 'mapping-electrode'];
const RHYTHMIA_WINDOW_BASES = [
  'unknown-layout', 'version-unchecked-no-ecg', 'version-unchecked-ecg-mismatch',
  'no-wiring', 'not-in-group', 'several-in-group', 'electrode-outside-catheter',
  'no-beat-window', 'beat-outside-recording', 'no-table-amplitude',
  'no-filtered-block', 'amplitude-mismatch',
];

/** Die Familie eines Katheternamens: seine Ziffernfolgen ersetzt.
 *  Wortgleich mit `rhythmia_layout.signal_family` — sonst nichts. */
export function rhythmiaSignalFamily(catheter) {
  return String(catheter == null ? '' : catheter).replace(/\d+/g, '<n>');
}

/** Ob die Verschränkung dieses Blocks eine der gemessenen ist.
 *
 * Ein einkanaliger Block hat keine Verschränkung, die man falsch lesen könnte,
 * und gilt deshalb immer als geprüft. Alles andere muss in der Menge stehen —
 * ein Paar außerhalb wird *nicht* unter der anderen Ablage gelesen, „um zu
 * sehen, was herauskommt": ein verschränktes Fenster zeichnet wie jedes andere.
 */
export function rhythmiaLayoutVerified(family, cols) {
  const channels = Number(cols);
  if (!Number.isFinite(channels)) return false;
  return channels === 1
      || RHYTHMIA_SIGNAL_ROW_MAJOR.indexOf(`${family}|${channels}`) >= 0;
}

/** Ob ein Cardiac-Block genau die Abtastungen trägt, die er angibt.
 *  Wortgleich mit `rhythmia_layout.signal_length_ok`. */
export function rhythmiaSignalLengthOk(length, rows, cols) {
  const declared = Number(length), r = Number(rows), c = Number(cols);
  if (!Number.isFinite(declared) || !Number.isFinite(r) || !Number.isFinite(c)) return false;
  return declared === r * c * 4;
}

/** Der Zeitpunkt eines Punktes als endliche Zahl — oder nichts.
 *
 * Gefragt **vor** jedem Blick auf eine Uhr. Gemessen an der ausgelieferten
 * Fassung: ein Zeitstempel, den ein Anonymisierer ersetzt hat (`1900-01-01`,
 * oder ein wörtliches `nan`), kam als `NaN` durch die Prüfung auf `!= null`,
 * verglich sich gegen beide Enden jeder Uhr zu `false`, ließ die binäre Suche
 * bei 0 stehen und ergab ein **477 Werte langes Fenster ab Zeile 0** mit
 * `atSeconds` NaN — ein falscher Kurvenzug unter *jedem* Annotations- und
 * Ablationsmarker einer anonymisierten Studie, in 1.4.0 wie in 1.5.0.
 *
 * Ein *zurückgehaltener* Zeitpunkt (eine endliche Zahl, die der Anonymisierer
 * schreibt, weil das Original außerhalb der Aufzeichnung lag) ist ein
 * Zeitpunkt: keine Uhr deckt ihn, also lautet die Antwort weiter unten „keine
 * Aufzeichnung". Diese Regel kennt die Konstante nicht und darf sie nicht
 * kennen. Wortgleich mit `rhythmia_layout.time_of`.
 */
export function rhythmiaTimeOf(value) {
  return rhythmiaNumber(value);
}

/** Die Elektrode, gegen die ein bipolares Paar gebildet wird: die nächste auf
 *  dem Spline, an dessen letzter Position die vorige.
 *  Wortgleich mit `rhythmia_layout.spline_neighbour`. */
export function rhythmiaSplineNeighbour(electrode) {
  const index = Number(electrode) | 0;
  return index % RHYTHMIA_SPLINE_POSITIONS < RHYTHMIA_SPLINE_POSITIONS - 1
    ? index + 1 : index - 1;
}

/** Wie weit eine gemessene Spitze-Tal-Amplitude von der abweicht, die die
 *  Tabelle angibt — in ln µV, der Einheit, in der die Tabelle sie hält. */
export function rhythmiaAmplitudeDistance(ptpVolts, tableMv) {
  const measured = Number(ptpVolts), stated = Number(tableMv);
  if (!Number.isFinite(measured) || !Number.isFinite(stated)) return null;
  if (measured <= 0 || stated <= 0) return null;
  return Math.abs(Math.log(measured * 1e6) - Math.log(stated * 1e3));
}

/** Ob die Aufzeichnung die Amplitude wiedergibt, die der Punkt selbst angibt.
 *  Eine halbe Rasterstufe, weil der Wert auf dieses Raster quantisiert ist. */
export function rhythmiaAmplitudeHit(ptpVolts, tableMv) {
  const distance = rhythmiaAmplitudeDistance(ptpVolts, tableMv);
  return distance !== null && distance < LN_UV_STEP / 2;
}

/** Die Kanäle aus *einer* Zeilenspanne: k Float32Array in gespeicherten Volt.
 *
 * `raw` ist, was `getRange` über die Zeilen geliefert hat — Abtastung für
 * Abtastung —, `channels` eine Liste von Spaltenindizes oder null für alle.
 * Eine Liste und keine Anzahl, weil ein Messpunkt eine Elektrode und ihren
 * Spline-Nachbarn braucht, was eine Anzahl nicht sagen könnte.
 * Wortgleich mit `rhythmia_layout.channels_of_row_span`.
 */
export function rhythmiaChannels(raw, cols, channels) {
  const width = Number(cols) | 0;
  const values = raw instanceof Float32Array ? raw : new Float32Array(raw);
  if (width <= 0 || values.length % width) {
    throw new Error(`Zeilenspanne von ${values.length} Abtastungen sind keine `
                  + `ganzen Zeilen zu ${width} Kanälen`);
  }
  const rows = values.length / width;
  const wanted = channels == null
    ? Array.from({ length: width }, (_unused, index) => index)
    : Array.from(channels, Number);
  for (const channel of wanted) {
    if (!(channel >= 0 && channel < width)) {
      throw new Error(`Kanal ${channel} außerhalb eines Blocks mit ${width}`);
    }
  }
  return wanted.map((channel) => {
    const out = new Float32Array(rows);
    for (let row = 0; row < rows; row++) out[row] = values[row * width + channel];
    return out;
  });
}

function rhythmiaLimbLeads(channels) {
  if (!channels || channels.length < RHYTHMIA_ECG_CHANNELS) {
    throw new Error(`${channels ? channels.length : 0} Kanäle: die `
                  + `Extremitätenableitungen brauchen die ${RHYTHMIA_ECG_CHANNELS} `
                  + `eines ${RHYTHMIA_ECG_FAMILY}-Blocks, kanalweise`);
  }
  const out = {};
  for (const name of Object.keys(RHYTHMIA_ECG_LIMB_INDEX)) {
    out[name] = channels[RHYTHMIA_ECG_LIMB_INDEX[name]];
  }
  return out;
}

/** `rms(Rest) / max(rms(Bezug))`, oder NaN, wenn das nichts aussagt.
 *
 * NaN statt 0 bei einer flachen Ableitung: ein Nenner von null heißt, die
 * Aufzeichnung sagt nichts über ihre eigene Ablage, und ein Gatter, das das
 * als perfekte Übereinstimmung läse, ließe jeden Nullblock durch. In float64
 * summiert, damit beide Sprachen dieselbe Zahl bekommen.
 */
function rhythmiaRelRms(residual, references) {
  const rms = (values) => {
    if (!values || !values.length) return NaN;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) return NaN;
      sum += value * value;
    }
    return Math.sqrt(sum / values.length);
  };
  let denominator = NaN;
  for (const reference of references) {
    const size = rms(reference);
    if (!Number.isFinite(size)) return NaN;
    if (!(denominator >= size)) denominator = size;
  }
  if (!Number.isFinite(denominator) || denominator <= 0) return NaN;
  return rms(residual) / denominator;
}

function rhythmiaCombine(parts) {
  const length = parts[0][1].length;
  const out = new Float64Array(length);
  for (const [factor, values] of parts) {
    for (let i = 0; i < length; i++) out[i] += factor * values[i];
  }
  return out;
}

/** `(Einthoven, Goldberger)` als relatives rms über ein kanalweises Fenster.
 *
 * `I + III - II` und `aVR + aVL + aVF` sind in einer Körperoberflächen-
 * ableitung null, weil die Ableitungen so gebildet werden — gleich, was das
 * Herz tut. Das macht sie an einem Archiv brauchbar, das niemand vermessen hat.
 * Wortgleich mit `rhythmia_layout.ecg_identity`.
 */
export function rhythmiaEcgIdentity(channels) {
  const lead = rhythmiaLimbLeads(channels);
  return [
    rhythmiaRelRms(rhythmiaCombine([[1, lead.I], [1, lead.III], [-1, lead.II]]),
                   [lead.I, lead.II, lead.III]),
    rhythmiaRelRms(rhythmiaCombine([[1, lead.aVR], [1, lead.aVL], [1, lead.aVF]]),
                   [lead.aVR, lead.aVL, lead.aVF]),
  ];
}

/** Ob beide Summen bei `RHYTHMIA_ECG_IDENTITY_MAX` halten. NaN fällt durch. */
export function rhythmiaEcgIdentityHolds(channels) {
  return rhythmiaEcgIdentity(channels)
    .every((value) => Number.isFinite(value) && value <= RHYTHMIA_ECG_IDENTITY_MAX);
}

/** Die drei reihenfolgeempfindlichen Identitäten — Fixture und Korpus, nie das
 *  Laufzeitgatter (`rhythmia_layout.ecg_lead_order`). */
export function rhythmiaEcgLeadOrder(channels) {
  const lead = rhythmiaLimbLeads(channels);
  return [
    rhythmiaRelRms(rhythmiaCombine([[1, lead.aVL], [-1, lead.I], [0.5, lead.II]]),
                   [lead.I, lead.II, lead.aVL]),
    rhythmiaRelRms(rhythmiaCombine([[1, lead.aVF], [-1, lead.II], [0.5, lead.I]]),
                   [lead.I, lead.II, lead.aVF]),
    rhythmiaRelRms(rhythmiaCombine([[1, lead.aVR], [0.5, lead.I], [0.5, lead.II]]),
                   [lead.I, lead.II, lead.aVR]),
  ];
}

export function rhythmiaEcgLeadOrderHolds(channels) {
  return rhythmiaEcgLeadOrder(channels)
    .every((value) => Number.isFinite(value) && value <= RHYTHMIA_ECG_ORDER_MAX);
}

/** Ob die Kanäle dieses Blocks überhaupt herausgegeben werden dürfen.
 *
 * Drei Antworten, in dieser Reihenfolge: das Paar steht nicht in der gemessenen
 * Menge — verweigert; der Softwarestand ist einer, an dem gemessen wurde —
 * gezeigt; der Stand ist ungeprüft — dann muss die Aufzeichnung etwas über
 * *sich* sagen, nämlich beide Summenidentitäten ihres eigenen
 * Oberflächenblocks. Sie besteht mit einem Vermerk, fällt mit einer Begründung
 * durch, und ohne Oberflächenblock ist sie nicht zu prüfen.
 *
 * Was das EKG belegt: dass der 12-Kanal-Block *dieser* Aufzeichnung zeilenweise
 * liegt. Nicht, welche Spalte welche ist, und nicht die Ablage des
 * Gegenstandsblocks — daher der Vermerk „angenommen, nicht geprüft".
 * Wortgleich mit `rhythmia_layout.layout_decision`.
 */
export function rhythmiaLayoutDecision(family, cols, versionChecked, ecgChannels) {
  if (!rhythmiaLayoutVerified(family, cols)) {
    return { ok: false, basis: 'unknown-layout', note: null };
  }
  if (versionChecked) return { ok: true, basis: null, note: null };
  if (!ecgChannels) return { ok: false, basis: 'version-unchecked-no-ecg', note: null };
  if (!rhythmiaEcgIdentityHolds(ecgChannels)) {
    return { ok: false, basis: 'version-unchecked-ecg-mismatch', note: null };
  }
  return { ok: true, basis: null, note: 'layout-assumed-from-ecg' };
}

/** Wie ein Kanal heißt: Katheter, Spalte, Fassung — `INAV1 1 B`.
 *  Die Zahl ist die Spalte, keine Ableitung; der Buchstabe die Fassung, wie die
 *  Datei sie schreibt. Die alten Endungen ` bi` und ` uni` behaupteten eine
 *  Ableitung, die nicht in der Datei steht. */
export function rhythmiaFlavourChannelName(catheter, channel, flavour) {
  if (flavour === RHYTHMIA_PAIR_FLAVOUR) {
    throw new Error(`${RHYTHMIA_PAIR_FLAVOUR} entsteht aus zwei Kanälen`);
  }
  return `${catheter} ${(Number(channel) | 0) + 1} ${flavour}`;
}

/** Die eigene Elektrode eines Messpunktes: `RTMD1 E12 U` — die Nummer, wie die
 *  Tabelle sie hält, damit Kanal und Marker dasselbe sagen. */
export function rhythmiaElectrodeChannelName(catheter, electrode) {
  return `${catheter} E${Number(electrode) | 0} U`;
}

/** Das gebildete Paar: `RTMD1 E12-E13 B` — der einzige bipolare Kurvenzug. */
export function rhythmiaPairChannelName(catheter, electrode, neighbour) {
  return `${catheter} E${Number(electrode) | 0}-E${Number(neighbour) | 0} B`;
}

/** Der Katheter, aus dessen Namen die Kanäle dieses Fensters gebaut wurden.
 *
 * Alle drei Namensbauer oben setzen `<Katheter> <…> <Fassung>` zusammen, und
 * ein Katheter ist ein Blockname ohne Leerzeichen — die letzten beiden Felder
 * abzuschneiden gibt ihn zurück. Gelesen wird er aus dem Fenster und nicht als
 * neues Feld mitgeführt: das Fenster wird Feld für Feld zwischen Python und
 * Browser verglichen, und ein Feld, das nur eine Seite kennt, wäre genau die
 * Abweichung, die dieser Zweig beseitigt.
 */
export function rhythmiaWindowCatheter(egm) {
  const name = egm && egm.channels && egm.channels[0];
  if (!name) return '';
  const parts = String(name).split(' ');
  return parts.length > 2 ? parts.slice(0, parts.length - 2).join(' ') : parts[0];
}

/** `no-beat-window` → `noBeatWindow`: wie ein Wert zum Schlüssel wird. */
function rhythmiaCamel(name) {
  return String(name || '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

/** Warum dieser Punkt kein Fenster zeigt — als Katalogschlüssel mit Werten.
 *
 * Das Panel sagte zu jedem zurückgehaltenen Fenster denselben Satz: „Dieser
 * Punkt trägt kein Elektrogramm." Er stimmte für keinen der Fälle. Ein Punkt,
 * dessen Katheter gar nicht mitlief, ein Punkt unter einer ungeprüften
 * Softwarefassung und ein Messpunkt, dessen Aufzeichnung seine eigenen
 * Amplituden nicht wiedergibt, sind drei verschiedene Auskünfte — und keine
 * davon ist „trägt kein Elektrogramm", denn die Aufzeichnung ist da.
 *
 * **Je Grundlage ein Satz, und nie ein falscher.** Ein Messpunkt ohne
 * Schlagfenster bekam sonst zu hören, die Aufzeichnung gebe seine Amplituden
 * nicht wieder — verglichen wurde nie eine. Das schickt den Leser zur
 * Aufzeichnung statt zur Tabelle, und ein falscher Grund ist schlimmer als ein
 * vager. Fehlt für eine künftige Grundlage ein Satz, fällt das Panel auf den
 * grundlagenneutralen zurück, der die Grundlage beim Namen nennt.
 *
 * Gibt `null` zurück, wo es ein Fenster gibt — die Regel entscheidet nicht, ob
 * gezeichnet wird, sie benennt nur, was der Leser schon entschieden hat.
 */
export function rhythmiaWindowMessage(answer, point, options) {
  if (!answer || answer.egm || !answer.reason) return null;
  const reason = answer.reason;
  const detail = (answer.detail && answer.detail[0]) || {};
  const basis = detail.basis || null;
  const version = (options && options.version) || '';
  const electrode = Number(point && point.electrode);
  const at = Number.isInteger(electrode) ? electrode : '';

  if (reason === 'channel-order-unverified') {
    // Zwei Gründe, eine Antwort: der Block ist nicht gemessen, oder die
    // Softwarefassung ist es nicht und das EKG bestätigt sie nicht.
    if (basis === 'version-unchecked-no-ecg' || basis === 'version-unchecked-ecg-mismatch') {
      return { key: 'map.egm.withheld.channelOrderVersion', basis, params: { version } };
    }
    return { key: 'map.egm.withheld.channelOrder', basis,
             params: { catheter: detail.family || '', channels: detail.channels ?? '' } };
  }
  if (reason === 'mapping-electrode-unconfirmed') {
    const params = { electrode: at, basis: basis || '' };
    if (basis === 'amplitude-mismatch') {
      params.du = detail.du ?? '';
      params.db = detail.db ?? '';
    }
    return { key: `map.egm.withheld.mappingUnconfirmed.${rhythmiaCamel(basis)}`,
             fallbackKey: 'map.egm.withheld.mappingUnconfirmed', basis, params };
  }
  const plain = {
    'no-time': 'map.egm.withheld.noTime',
    'no-recording': 'map.egm.withheld.noRecording',
    'no-ablation-catheter-recording': 'map.egm.withheld.noAblationCatheter',
    'no-mapping-catheter-recording': 'map.egm.withheld.noMappingCatheter',
  }[reason];
  return plain ? { key: plain, basis, params: {} } : null;
}

/** Was ein gezeigtes Fenster über sich sagt — Schlüssel mit Werten, in Reihe.
 *
 * Der Rangfolge-Hinweis und die EKG-Annahme standen schon als Werte im Fenster
 * und wurden nirgends ausgesprochen. Dazu zwei, die aus dem Fenster selbst
 * folgen: dass B und W gefilterte Fassungen je Elektrode sind und keine
 * bipolaren Ableitungen (der Name `… B` sagt das nicht von allein), und welche
 * Korbelektrode ein Messpunkt zeigt, samt dem Nachbarn, gegen den sein Paar
 * gebildet ist.
 */
export function rhythmiaWindowNotes(egm, point, options) {
  if (!egm) return [];
  const version = (options && options.version) || '';
  const catheter = rhythmiaWindowCatheter(egm);
  const out = [];
  for (const note of (egm.notes || [])) {
    if (note === 'layout-assumed-from-ecg') {
      out.push({ key: 'map.egm.note.ecgAssumed', note, params: { version, catheter } });
    } else if (note === 'subject-by-ranking') {
      out.push({ key: 'map.egm.note.byRanking', note, params: { catheter } });
    }
  }
  if (egm.subject === 'mapping-electrode') {
    const electrode = Number(point && point.electrode) | 0;
    out.push({ key: 'map.egm.note.mappingElectrode', note: null,
               params: { catheter, electrode,
                         neighbour: rhythmiaSplineNeighbour(electrode) } });
  }
  // Nur für gespeicherte Fassungen. Das gebildete Paar ist die eine Ausnahme:
  // es *ist* bipolar, und der Satz daneben würde ihm widersprechen.
  if ((egm.flavours || []).some(f => f === RHYTHMIA_FILTERED_FLAVOUR || f === 'W')) {
    out.push({ key: 'map.egm.note.flavours', note: null, params: {} });
  }
  return out;
}

/** Welcher Katheter auf welchem Port aufzeichnet: `{Port: {Block: Elektroden}}`.
 *
 * Aus der Verkabelung der Studie selbst. Jeder aufgezeichnete Katheter nennt
 * ein *aktuelles* Modell; dessen `CatheterConfig/SignalBlock` ist der Block, in
 * den er schreibt, und jede Elektrode seines `CatheterSetup` trägt den Port als
 * `PIUSigBlk`. So gemessen in 9 von 9 Familien in vier Archiven.
 *
 * `null`, wenn das Archiv keine lesbare Verkabelung nennt — und das ist eine
 * andere Antwort als `{}`: ohne Verkabelung hat ein Messpunkt überhaupt keinen
 * Gegenstand, während eine Tabelle ohne Katheter am Ablationsport sagt, dass
 * der Ablationskatheter nicht aufgezeichnet wurde.
 *
 * **Welches Modell das aktuelle ist, stand falsch da, bis ein echter Export
 * gelesen wurde.** `CurrModel` ist eine GUID, und das Modell trägt sie als
 * eigenes `id`-Attribut (`<RhythmiaCatheterModel id="…">` in
 * `<CatheterModels>`). Ein `Properties/Name` gibt es unter einem Katheter
 * nirgends: in 4 von 4 Korpus-Archiven kam so `{}` heraus, und damit bekam kein
 * Ablationspunkt und kein Messpunkt ein Fenster. Beide Schreibweisen werden
 * akzeptiert — die GUID (echte Archive) und der Name (die synthetische
 * Fixture); geraten wird keine.
 *
 * Das Modell wird unter *allen* Nachfahren gesucht und nicht in fester Tiefe:
 * die Schachtelung zwischen Katheter und Modellliste wechselt.
 */
export function rhythmiaCatheterPorts(root) {
  const catheters = firstTag(root, 'Catheters');
  if (!catheters) return null;
  const ports = Object.create(null);
  for (const catheter of catheters.children) {
    const properties = childByTag(catheter, 'Properties');
    const current = properties ? elText(childByTag(properties, 'CurrModel')) : '';
    if (!current) continue;
    for (const model of [catheter].concat([...iterAll(catheter)])) {
      // Die GUID am Modell selbst (jedes gemessene Archiv) oder ein benanntes
      // Modell (die Fixture). Nennt es keines von beidem, ist es nicht das
      // aktuelle Modell dieses Katheters.
      const own = childByTag(model, 'Properties');
      const name = own ? elText(childByTag(own, 'Name')) : '';
      const identifier = rhythmiaAttribute(model, 'id') || '';
      if (identifier.trim() !== current && name !== current) continue;
      const config = childByTag(model, 'CatheterConfig');
      const block = config ? elText(childByTag(config, 'SignalBlock')) : '';
      const setup = childByTag(model, 'CatheterSetup');
      const electrodes = setup ? childByTag(setup, 'Electrodes') : null;
      if (!block || !electrodes) continue;
      const wired = new Set();
      let count = 0;
      for (const electrode of electrodes.children) {
        wired.add(rhythmiaAttribute(electrode, 'PIUSigBlk'));
        count++;
      }
      // Ein Modell, dessen Elektroden auf zwei Ports sitzen, nennt keinen Port.
      if (!count || wired.size !== 1) continue;
      const port = [...wired][0];
      if (!port) continue;
      if (!ports[port]) ports[port] = Object.create(null);
      ports[port][block] = count;
      break;
    }
  }
  return ports;
}

/* Jede Zahl, jedes Muster und jede Liste, die diese Seite mit
 * `rhythmia_layout` teilt — an einer Stelle gebündelt, damit ein
 * Konformanztest sie vergleichen kann.
 *
 * Bisher verglich er nur die Entity-Tabelle. Alles andere stand zweimal da und
 * durfte auseinanderlaufen: die Rate, das Spannungsraster, die Schwellen der
 * Spaltenprüfung, die geprüften Softwarestände, die Kopfzeile einer PLY. Ein
 * Unterschied darin ändert keine Zeile Code und macht aus derselben Datei zwei
 * verschiedene Karten.
 *
 * Die Muster reisen als Quelltext mit, verglichen wird aber ihr *Urteil* über
 * dieselben Namen: die beiden Sprachen schreiben dasselbe Muster nicht
 * zeichengleich (Python fängt Gruppen ein, die diese Seite nicht braucht), und
 * verglichen werden soll die Regel, nicht die Schreibweise.
 */
export const RHYTHMIA_CONSTANTS = {
  rateHz: RHYTHMIA_RATE_HZ,
  clockRateHz: RHYTHMIA_CLOCK_RATE_HZ,
  validatedVersions: RHYTHMIA_VALIDATED_VERSIONS,
  latComment: RHYTHMIA_LAT_COMMENT,
  latCommentCAmbiguous: RHYTHMIA_LAT_COMMENT_C_AMBIGUOUS,
  pointsColumns: SURFELEC_COLS,
  surfelecColumns: SURFELEC,
  lnUvStep: LN_UV_STEP,
  lnUvGate: LN_UV_GATE,
  layoutSample: LAYOUT_SAMPLE,
  layoutNearest: LAYOUT_NEAREST,
  layoutMarginLat: LAYOUT_MARGIN_LAT,
  layoutMarginLnUv: LAYOUT_MARGIN_LN_UV,
  meshVertexStride: RHYTHMIA_MESH_VERTEX_STRIDE,
  meshTriangleStride: RHYTHMIA_MESH_TRIANGLE_STRIDE,
  mapBlockKinds: RHYTHMIA_MAP_BLOCK_KINDS,
  annotationPointTags: RHYTHMIA_ANNOTATION_POINT_TAGS,
  signalFlavourOrder: RHYTHMIA_SIGNAL_FLAVOUR_ORDER,
  signalFlavourLast: RHYTHMIA_SIGNAL_FLAVOUR_LAST,
  defaultMapSource: 'bipolar',
  windowSeconds: SIG_WINDOW_S,
  reasons: RHYTHMIA_REASONS,
  notes: RHYTHMIA_NOTES,
  // Eine *Menge*, keine Reihenfolge: beide Seiten geben sie sortiert heraus,
  // damit der Vergleich über den Inhalt geht und nicht über die Schreibfolge.
  signalRowMajor: [...RHYTHMIA_SIGNAL_ROW_MAJOR].sort(),
  layoutRowMajor: RHYTHMIA_LAYOUT_ROW_MAJOR,
  blockFlavours: RHYTHMIA_BLOCK_FLAVOURS,
  pairFlavour: RHYTHMIA_PAIR_FLAVOUR,
  channelFlavours: RHYTHMIA_CHANNEL_FLAVOURS,
  unipolarFlavour: RHYTHMIA_UNIPOLAR_FLAVOUR,
  filteredFlavour: RHYTHMIA_FILTERED_FLAVOUR,
  ecgFamily: RHYTHMIA_ECG_FAMILY,
  ecgFlavour: RHYTHMIA_ECG_FLAVOUR,
  ecgChannels: RHYTHMIA_ECG_CHANNELS,
  ecgLimbIndex: RHYTHMIA_ECG_LIMB_INDEX,
  ecgIdentityMax: RHYTHMIA_ECG_IDENTITY_MAX,
  ecgOrderIdentities: RHYTHMIA_ECG_ORDER_IDENTITIES,
  ecgOrderMax: RHYTHMIA_ECG_ORDER_MAX,
  ablationPort: RHYTHMIA_ABLATION_PORT,
  mappingPort: RHYTHMIA_MAPPING_PORT,
  mappingFamilies: RHYTHMIA_MAPPING_FAMILIES,
  splinePositions: RHYTHMIA_SPLINE_POSITIONS,
  windowReasons: RHYTHMIA_WINDOW_REASONS,
  windowNotes: RHYTHMIA_WINDOW_NOTES,
  windowSubjects: RHYTHMIA_WINDOW_SUBJECTS,
  windowBases: RHYTHMIA_WINDOW_BASES,
};

/** Was die Namensmuster über eine Liste von Namen sagen — als Urteil, nicht als
 *  Quelltext, damit verglichen wird, was die Regel tut. */
export function rhythmiaNameVerdicts(names) {
  return names.map((name) => {
    const bare = String(name).replace(/^.*\//, '');
    const signal = SIG_NAME.exec(bare);
    return {
      name,
      pointsFnameOk: rhythmiaPointsFnameOk(name),
      clock: RHYTHMIA_CLOCK_NAME.test(bare),
      signal: signal ? [signal[1], signal[2]] : null,
      surfaceEcg: rhythmiaIsSurfaceEcg(name),
    };
  });
}

/** Aus welchem Block das Fenster eines Punktes kommt, das Brauchbarste zuerst.
 *
 * Erst die Art, dann die Kanalzahl — als *Paar*, nie in eine Zahl gefaltet.
 * Genau das stand hier: `Art * 100 + Kanäle`, und ab hundert Kanälen überstimmt
 * die Kanalzahl die Art, die sie eigentlich nur bei Gleichstand trennen
 * sollte. Die Regel und ihr Grund stehen einmal, in
 * `rhythmia_layout.signal_rank`; Python nennt denselben Absatz.
 */
function rhythmiaSignalRank(flavour, cols) {
  const order = RHYTHMIA_SIGNAL_FLAVOUR_ORDER[flavour];
  return [order === undefined ? RHYTHMIA_SIGNAL_FLAVOUR_LAST : order, cols | 0];
}

/** Ob dieser Block eine Körperoberflächenableitung ist statt der eines Katheters.
 *
 * Eine Oberflächenableitung ist Bezug, nie Gegenstand — auch dann nicht, wenn
 * sie das Einzige im Archiv ist. „Was hat der Katheter hier gemessen" und „was
 * zeigte die Körperoberfläche in diesem Moment" sind nicht dieselbe Messung,
 * und das Fenster ist als das des Punktes beschriftet. Die Regel und ihr Grund
 * stehen einmal, in `rhythmia_layout.is_surface_ecg`; Python nennt denselben
 * Absatz und hat sie immer so gehalten.
 */
function rhythmiaIsSurfaceEcg(catheter) {
  return Boolean(catheter) && RHYTHMIA_SURFACE_ECG_NAME.test(String(catheter));
}

/** Die Rate, die eine Zeitachse angibt, oder null, wenn sie keine angibt.
 *
 * Eine Uhr, die keine Rate nennen kann, ergibt kein Fenster. Die Regel und ihre
 * Belege stehen einmal, in `rhythmia_layout.recording_rate_hz`; Python nennt
 * denselben Absatz und hat sie immer so gehalten.
 *
 * Diese Seite rechnete denselben Quotienten aus und machte damit weiter. An
 * einem 500-Zeilen-Block gemessen: ein einzelner Zeitstempel ergab Rate 0, eine
 * halbe Fensterbreite von 1 und ein Fenster über zwei Abtastungen, mit „0 Hz"
 * beschriftet; eine durchweg gleiche Zeitachse ergab `Infinity`, eine halbe
 * Fensterbreite von `Infinity` und damit die *ganze* Aufzeichnung, mit
 * „Infinity Hz" beschriftet. Eine Sekunde um einen Punkt herum und die ganze
 * Studie unter derselben Beschriftung sind nicht dasselbe Bild.
 */
export function rhythmiaRecordingRateHz(first, last, count) {
  const a = Number(first), b = Number(last), n = Number(count);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(n)) return null;
  // Ein Zeitstempel nennt einen Augenblick, keine Rate.
  if (n < 2) return null;
  const span = b - a;
  if (!Number.isFinite(span) || span <= 0) return null;
  const rate = (n - 1) / span;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Welcher Block als Bezug mitreist — als Index in die Blöcke, wie sie in der
 *  Datei stehen — oder null.
 *
 * Die Dokumentreihenfolge entscheidet, nicht die Reihenfolge, in die ein Leser
 * schon sortiert hat. Die Regel und ihre Belege stehen einmal, in
 * `rhythmia_layout.surface_reference`; Python nennt denselben Absatz.
 *
 * Diese Seite suchte in der bereits nach `rhythmiaSignalRank` sortierten Liste.
 * Bei einer einzigen Oberflächenableitung je Gruppe fällt das nicht auf; bei
 * zwei entscheidet es, und dann hängt der Browser eine andere an als der
 * Archivleser — beide echt, beide im richtigen Augenblick aufgezeichnet.
 */
function rhythmiaSurfaceReference(blocks, clockPrefix, rows) {
  for (let index = 0; index < blocks.length; index++) {
    const [catheter, prefix, blockRows] = blocks[index];
    if (!rhythmiaIsSurfaceEcg(catheter)) continue;
    if (!String(prefix).startsWith(String(clockPrefix))) continue;
    if (blockRows !== rows) continue;
    return index;
  }
  return null;
}

function rhythmiaSignalIndex(root) {
  const blocks = [];
  for (const el of iterTag(root, 'inlinedbin')) {
    const fname = rhythmiaAttribute(el, 'fname');
    if (!fname) continue;
    const idx = parseInt((el.textContent || '').trim(), 10);
    if (!Number.isFinite(idx)) continue;
    const bare = fname.replace(/^.*\//, '');
    const named = SIG_NAME.exec(bare);
    const cols = parseInt(rhythmiaAttribute(el, 'cols'), 10);
    const rows = parseInt(rhythmiaAttribute(el, 'rows'), 10);
    const type = rhythmiaAttribute(el, 'type');
    if (named && type === 'Cardiac') {
      // Ein Block, der weniger Bytes angibt, als seine eigene Ablage braucht,
      // ist keine Aufzeichnung: zeilenweise gelesen läuft er in das Markup
      // dahinter und gibt es als Abtastungen aus. Die Länge steht als `BIN` im
      // Tag — beide Bauer schreiben sie gequotet ins XML —, also braucht diese
      // Prüfung keinen von ihnen zu ändern (`rhythmia_layout.signal_length_ok`).
      const declared = parseInt(rhythmiaAttribute(el, 'BIN'), 10);
      if (!rhythmiaSignalLengthOk(declared, rows, cols)) {
        try { console.warn(`[epconv] Cardiac-Block ${rhythmiaSignalFamily(named[1])} `
          + `(${named[2]}, ${rows} Zeilen x ${cols} Kanäle) gibt ${declared} Bytes an `
          + `statt ${rows * cols * 4} — nicht als Aufzeichnung geführt.`); } catch (e) {}
        continue;
      }
      blocks.push({ kind: 'signal', catheter: named[1], flavour: named[2],
                    cols, rows, idx, prefix: bare.slice(0, bare.lastIndexOf('_' + named[2] + '.dat')) });
    } else if (RHYTHMIA_CLOCK_NAME.test(bare) && type === 'Float64') {
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

  // Die Blöcke, wie sie in der Datei stehen. Die Sortierung darunter wählt den
  // *Gegenstand* eines Fensters; welche Oberflächenableitung als Bezug mitreist,
  // entscheidet die Dokumentreihenfolge — siehe rhythmiaSurfaceReference.
  const inFile = signals.slice();

  // Bipolar zuerst: das ist, was ein Mapping-Punkt misst. Dann unipolar, dann
  // was übrig ist. Der Korb hat 64 Kanäle, ein Diagnostikkatheter zehn — der
  // mit den wenigsten ist der, dessen Kanäle einzeln etwas bedeuten.
  signals.sort((a, b) => {
    const ra = rhythmiaSignalRank(a.flavour, a.cols);
    const rb = rhythmiaSignalRank(b.flavour, b.cols);
    return (ra[0] - rb[0]) || (ra[1] - rb[1]);
  });

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
  //
  // Gesucht wird in `inFile`, nicht in der sortierten Liste: welcher Bezug es
  // ist, entscheidet die Dokumentreihenfolge (rhythmiaSurfaceReference).
  //
  // Und nur die **U**-Fassung: das W desselben Blocks ist eine gefilterte
  // Fassung derselben zwölf Ableitungen, reiste unter demselben Namen mit und
  // zeigte einen anderen Kurvenzug — in einer gemessenen Gruppe steht es sogar
  // vor dem U in der Datei (rhythmia_layout.ECG_FLAVOUR).
  const surfaceFor = (sig, clock) => {
    const candidates = inFile.filter(
      b => rhythmiaSignalFamily(b.catheter) === RHYTHMIA_ECG_FAMILY
        && b.flavour === RHYTHMIA_ECG_FLAVOUR && b.cols === RHYTHMIA_ECG_CHANNELS);
    const index = rhythmiaSurfaceReference(
      candidates.map(b => [b.catheter, b.prefix, b.rows]), clock.prefix, sig.rows);
    return index === null ? null : candidates[index];
  };

  const version = rhythmiaSoftwareVersion(root);
  const checked = rhythmiaVersionChecked(version);
  const ports = rhythmiaCatheterPorts(root);

  /* Die Uhren, die einen Zeitpunkt abdecken, in Dateireihenfolge.
   *
   * Zwei Fragen, in dieser Reihenfolge und auf beiden Seiten gleich: nennt
   * dieser Block überhaupt eine Rate, und deckt seine Aufzeichnung den
   * Zeitpunkt. Ein Zeitpunkt außerhalb jeder Uhr ist nicht der dieser
   * Aufzeichnung, und das nächstgelegene Fenster wäre ein echtes Signal aus der
   * falschen Sekunde. */
  const coveringClocks = async (when) => {
    const out = [];
    for (const block of times) {
      const t = await readTimes(block);
      if (t.length < 2) continue;
      if (rhythmiaRecordingRateHz(t[0], t[t.length - 1], t.length) === null) continue;
      if (when < t[0] || when > t[t.length - 1]) continue;
      out.push({ clock: block, t });
    }
    return out;
  };

  const groupSignals = (clock) => inFile.filter(s => s.prefix.startsWith(clock.prefix));

  // Die Zeitachse ist monoton: der erste Index, dessen Wert nicht kleiner ist —
  // dieselbe Seite, die Python mit searchsorted(..., side='left') nimmt.
  const searchLeft = (t, when) => {
    let lo = 0, hi = t.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < when) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const spanOf = async (block, from, to, channels) => {
    const raw = await getRange(block.idx, from * block.cols * 4,
                               (to - from) * block.cols * 4);
    return rhythmiaChannels(aligned(raw, Float32Array), block.cols, channels);
  };

  const nameOf = (block) => `${block.prefix}_${block.flavour}.dat`;

  const candidatesFor = (group, ablation) => {
    const usable = group.filter(s => !rhythmiaIsSurfaceEcg(s.catheter));
    const byRank = usable.slice().sort((a, b) => {
      const ra = rhythmiaSignalRank(a.flavour, a.cols);
      const rb = rhythmiaSignalRank(b.flavour, b.cols);
      return (ra[0] - rb[0]) || (ra[1] - rb[1]);
    });
    if (ablation && ports) {
      // Die Datei sagt, mit welchem Katheter abladiert wurde. Kein Rückfall auf
      // die Rangfolge: die nahm in 490 von 492 gemessenen Fenstern einen frei
      // im Blut liegenden Diagnostikkatheter — echt, im richtigen Augenblick,
      // und unter dem Marker einer Läsion.
      const wired = ports[RHYTHMIA_ABLATION_PORT] || {};
      const onPort = byRank.filter(s => wired[s.catheter] === s.cols);
      const several = new Set(onPort.map(s => s.catheter)).size > 1;
      return { blocks: onPort, subject: 'ablation-port', ranked: several };
    }
    return { blocks: byRank, subject: 'ranking', ranked: true };
  };

  const decisionFor = async (sig, clock, from, to) => {
    const family = rhythmiaSignalFamily(sig.catheter);
    if (checked || !rhythmiaLayoutVerified(family, sig.cols)) {
      return rhythmiaLayoutDecision(family, sig.cols, checked, null);
    }
    const surface = surfaceFor(sig, clock);
    let ecg = null;
    if (surface) {
      try { ecg = await spanOf(surface, from, to, null); } catch (e) { ecg = null; }
    }
    return rhythmiaLayoutDecision(family, sig.cols, checked, ecg);
  };

  const withReference = async (egm, surface, clock, from, to) => {
    if (!surface) return egm;
    try {
      const [lead] = await spanOf(surface, from, to, [0]);
      egm.samples.push(lead);
      egm.channels.push(rhythmiaFlavourChannelName(surface.catheter, 0, surface.flavour));
      egm.flavours.push(surface.flavour);
      egm.surfaceSource = nameOf(surface);
    } catch (e) { /* fehlt sie, fehlt nur der Zeitbezug */ }
    return egm;
  };

  /* Ein Annotations- oder Ablationspunkt. */
  const windowStatus = async (point) => {
    const when = rhythmiaTimeOf(point && point.time);
    if (when === null) return { egm: null, reason: 'no-time', detail: [] };
    const groups = await coveringClocks(when);
    if (!groups.length) return { egm: null, reason: 'no-recording', detail: [] };

    const ablation = point.kind === 'ablation';
    const refused = [];
    for (const { clock, t } of groups) {
      const rate = rhythmiaRecordingRateHz(t[0], t[t.length - 1], t.length);
      const index = searchLeft(t, when);
      const half = Math.max(1, Math.round(rate * SIG_WINDOW_S / 2));
      const chosen = candidatesFor(groupSignals(clock), ablation);
      for (const sig of chosen.blocks) {
        const from = Math.max(0, index - half);
        const to = Math.min(sig.rows, index + half);
        if (to <= from) continue;
        const decision = await decisionFor(sig, clock, from, to);
        if (!decision.ok) {
          const entry = { family: rhythmiaSignalFamily(sig.catheter),
                          channels: sig.cols, basis: decision.basis };
          if (!refused.some(seen => seen.family === entry.family
                                 && seen.channels === entry.channels
                                 && seen.basis === entry.basis)) refused.push(entry);
          continue;
        }
        const many = Math.min(sig.cols, 3);
        const wanted = [];
        for (let c = 0; c < many; c++) wanted.push(c);
        const samples = await spanOf(sig, from, to, wanted);
        const notes = [];
        if (decision.note) notes.push(decision.note);
        if (chosen.ranked) notes.push('subject-by-ranking');
        const egm = {
          channels: wanted.map(c => rhythmiaFlavourChannelName(sig.catheter, c, sig.flavour)),
          samples,
          flavours: wanted.map(() => sig.flavour),
          gainMv: 1000,                      // Float32 in Volt
          sampleRateHz: Math.round(rate * 1000) / 1000,
          rateAssumed: false,                // aus der Zeitachse gerechnet
          window: [t[from], t[Math.min(to, t.length) - 1]],
          atSeconds: when,
          notes, subject: chosen.subject, layout: RHYTHMIA_LAYOUT_ROW_MAJOR,
          source: nameOf(sig), surfaceSource: '', beatRows: null,
        };
        return { egm: await withReference(egm, surfaceFor(sig, clock), clock, from, to),
                 reason: null, detail: [] };
      }
    }
    if (refused.length) {
      return { egm: null, reason: 'channel-order-unverified', detail: refused };
    }
    if (ablation && ports) {
      return { egm: null, reason: 'no-ablation-catheter-recording', detail: [] };
    }
    return { egm: null, reason: 'no-recording', detail: [] };
  };

  const withheld = (reason, basis, extra) =>
    ({ egm: null, reason, detail: [Object.assign({ basis }, extra || {})] });

  /* Ein Messpunkt: **seine eigene** Korbelektrode.
   *
   * Ein Messpunkt ist eine Elektrode des Mappingkatheters auf einem
   * akzeptierten Schlag. Die Tabelle nennt die Elektrode (Spalte 6), den Schlag
   * (Spalte 0) und die Amplituden, die das System dort gemessen hat (11 und
   * 12) — das Fenster muss also *diese* Elektrode zeigen, und die Datei erlaubt
   * zu prüfen, dass es das tut. Nie ein Rückfall auf die Rangfolge: ein fremder
   * Eingang unter dem Namen einer Elektrode ist genau das stille falsche
   * Fenster, dessentwegen es diese Regel gibt. */
  const mappingStatus = async (point) => {
    const when = rhythmiaTimeOf(point && point.time);
    if (when === null) return { egm: null, reason: 'no-time', detail: [] };
    const groups = await coveringClocks(when);
    if (!groups.length) return { egm: null, reason: 'no-recording', detail: [] };
    if (!ports) return withheld('no-mapping-catheter-recording', 'no-wiring');

    const wired = ports[RHYTHMIA_MAPPING_PORT] || {};
    let chosen = null;
    for (const group of groups) {
      const here = groupSignals(group.clock).filter(
        s => s.flavour === RHYTHMIA_UNIPOLAR_FLAVOUR && wired[s.catheter] === s.cols);
      if (!here.length) continue;
      // Zwei Körbe am Mappingport: nichts sagt, mit welchem diese Karte
      // aufgenommen wurde, also wird keiner gezeigt.
      if (here.length > 1) {
        return withheld('no-mapping-catheter-recording', 'several-in-group');
      }
      chosen = { clock: group.clock, t: group.t, subject: here[0] };
      break;
    }
    if (!chosen) return withheld('no-mapping-catheter-recording', 'not-in-group');

    const { clock, t, subject } = chosen;
    const family = rhythmiaSignalFamily(subject.catheter);
    if (!rhythmiaLayoutVerified(family, subject.cols)) {
      return { egm: null, reason: 'channel-order-unverified',
               detail: [{ family, channels: subject.cols, basis: 'unknown-layout' }] };
    }
    const electrode = Number(point.electrode);
    if (RHYTHMIA_MAPPING_FAMILIES.indexOf(`${family}|${subject.cols}`) < 0
        || !Number.isInteger(electrode) || electrode < 0 || electrode >= subject.cols) {
      return withheld('no-mapping-catheter-recording', 'electrode-outside-catheter');
    }
    if (!point.beat) return withheld('mapping-electrode-unconfirmed', 'no-beat-window');

    const rate = rhythmiaRecordingRateHz(t[0], t[t.length - 1], t.length);
    const index = searchLeft(t, when);
    const first = index + point.beat.startSample;
    const last = first + point.beat.samples;
    if (first < 0 || last > subject.rows) {
      return withheld('mapping-electrode-unconfirmed', 'beat-outside-recording');
    }
    // Eine ausgeschlossene Zeile trägt dort 0, eine unter der Rasteruntergrenze
    // gar keinen Wert: dann ist nichts zu prüfen, was etwas anderes ist, als zu
    // prüfen und nicht übereinzustimmen.
    if (!(Number.isFinite(point.unipolarMv) && point.unipolarMv > 0
          && Number.isFinite(point.bipolarMv) && point.bipolarMv > 0)) {
      return withheld('mapping-electrode-unconfirmed', 'no-table-amplitude');
    }
    const filtered = groupSignals(clock).find(
      s => s.flavour === RHYTHMIA_FILTERED_FLAVOUR && s.catheter === subject.catheter
        && s.cols === subject.cols && s.rows === subject.rows);
    if (!filtered) return withheld('mapping-electrode-unconfirmed', 'no-filtered-block');

    const neighbour = rhythmiaSplineNeighbour(electrode);
    const half = Math.max(1, Math.round(rate * SIG_WINDOW_S / 2));
    const from = Math.max(0, index - half);
    const to = Math.min(subject.rows, index + half);
    if (to <= from) return { egm: null, reason: 'no-recording', detail: [] };

    // Je ein Lesevorgang über Fenster und Schlag zusammen.
    const low = Math.min(from, first), high = Math.max(to, last);
    const [own] = await spanOf(subject, low, high, [electrode]);
    const [ownFiltered, neighbourFiltered] = await spanOf(filtered, low, high,
                                                          [electrode, neighbour]);
    const pair = new Float32Array(own.length);
    for (let i = 0; i < pair.length; i++) pair[i] = ownFiltered[i] - neighbourFiltered[i];

    const beatFrom = first - low, beatTo = last - low;
    let ownLo = Infinity, ownHi = -Infinity, pairLo = Infinity, pairHi = -Infinity;
    for (let i = beatFrom; i < beatTo; i++) {
      const value = own[i];
      if (value < ownLo) ownLo = value;
      if (value > ownHi) ownHi = value;
      // Die Differenz in float64 der float32-Werte, wie auf der Python-Seite.
      const difference = ownFiltered[i] - neighbourFiltered[i];
      if (difference < pairLo) pairLo = difference;
      if (difference > pairHi) pairHi = difference;
    }
    const ownPtp = ownHi - ownLo, pairPtp = pairHi - pairLo;
    if (!(rhythmiaAmplitudeHit(ownPtp, point.unipolarMv)
          && rhythmiaAmplitudeHit(pairPtp, point.bipolarMv))) {
      const steps = (value) => (value === null ? null : Math.round(value * 1000) / 1000);
      return withheld('mapping-electrode-unconfirmed', 'amplitude-mismatch', {
        du: steps(rhythmiaAmplitudeDistance(ownPtp, point.unipolarMv)),
        db: steps(rhythmiaAmplitudeDistance(pairPtp, point.bipolarMv)),
      });
    }

    const egm = {
      channels: [rhythmiaElectrodeChannelName(subject.catheter, electrode),
                 rhythmiaPairChannelName(subject.catheter, electrode, neighbour)],
      samples: [own.subarray(from - low, to - low), pair.subarray(from - low, to - low)],
      flavours: [RHYTHMIA_UNIPOLAR_FLAVOUR, RHYTHMIA_PAIR_FLAVOUR],
      gainMv: 1000,
      sampleRateHz: Math.round(rate * 1000) / 1000,
      rateAssumed: false,
      window: [t[from], t[Math.min(to, t.length) - 1]],
      atSeconds: when,
      notes: [], subject: 'mapping-electrode', layout: RHYTHMIA_LAYOUT_ROW_MAJOR,
      source: nameOf(subject), surfaceSource: '', beatRows: [first, last],
    };
    return { egm: await withReference(egm, surfaceFor(subject, clock), clock, from, to),
             reason: null, detail: [] };
  };

  /* `egm | null` bleibt der Vertrag — das Panel, der OpenEP-Export im Browser
   * und die CARTO-/EnSite-Pfade rufen es so auf. Der Grund steht daneben, für
   * wen ihn zeigen will. Ein Punkt ohne `kind` (aus einer wieder eingelesenen
   * PLY) wird wie ein Annotationspunkt behandelt. */
  const withReason = async (point) => {
    if (!point) return { egm: null, reason: 'no-time', detail: [] };
    return point.kind === 'measurement' ? mappingStatus(point) : windowStatus(point);
  };
  const readEgm = async (point) => (await withReason(point)).egm;
  readEgm.withReason = withReason;
  return readEgm;
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

  const version = rhythmiaSoftwareVersion(root);
  const software = { version, checked: rhythmiaVersionChecked(version) };

  const meshes = [];
  // Je Mesh die Messpunkte seiner eigenen Karte, und die Tabellen, die schon
  // gelesen wurden: was am Ende übrig bleibt, gehört zu keiner gezeichneten
  // Karte und wird gezählt statt verschwiegen.
  const ownGroups = [];
  const handled = new Set();
  let unassignedTables = 0;
  let anatIdx = 0;
  for (const anatomy of iterTag(root, 'Anatomy')) {
    anatIdx++;
    // Über direkte Kinder: eine Nachfahrensuche fände das Label einer
    // eingebetteten Auswertung. Dieser Name ist auch der Name, unter dem die
    // Messpunkte dieser Karte auftauchen — das Verzeichnis `Map<n>/` gibt es
    // im Stand 25.02 nicht mehr (Befund §7).
    const props = childByTag(anatomy, 'Properties');
    const lbl = props && childByTag(props, 'Label');
    const name = rhythmiaAnatomyName(lbl && lbl.textContent, anatIdx - 1);

    let M = null;
    const tEl = firstTag(anatomy, 'Transform');
    if (tEl && tEl.textContent) M = mat4FromText(tEl.textContent);

    let positions = null, normals = null, faces = null;
    for (const mesh of iterTag(anatomy, 'Mesh')) {
      const vEl = firstTag(mesh, 'vertices'), triEl = firstTag(mesh, 'triangles');
      if (!vEl || !triEl) continue;
      const vBytes = await payloadBytes(vEl), tBytes = await payloadBytes(triEl);
      if (!vBytes || !tBytes) continue;
      // Beide Blöcke gemessen, bevor einer zugewiesen wird — und eine
      // übersprungene Fläche sagt es, statt still zu verschwinden.
      const meshRefusal = rhythmiaMeshBlobRefusal(vBytes.length, tBytes.length);
      if (meshRefusal) {
        try { console.warn(`[epconv] Anatomie „${name}": ein Mesh ist nicht lesbar `
          + `(${meshRefusal}) — übersprungen.`); } catch (e) {}
        continue;
      }
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

    /* Die Punkttabellen dieser Anatomie, bevor über das Mesh entschieden ist.
     *
     * Eine Anatomie ohne Fläche hat trotzdem Messungen, und die zählen dann als
     * nicht zuzuordnen — es gibt nichts, worauf sie gezeichnet werden könnten.
     * Python führt dieselbe Tabelle über ihre Datenschnittstelle weiter; der
     * Unterschied ist erklärt und in einem Konformanztest festgehalten. */
    const engineOuts = [...iterTag(anatomy, 'EngineOutput')];
    const tables = [];
    for (const eo of engineOuts) {
      const node = childByTag(eo, 'SurfaceElectrodesNode');
      const surf = node && childByTag(node, 'SurfElectrodes');
      const bin = surf && childByTag(surf, 'inlinedbin');
      if (!bin) continue;
      const tableName = rhythmiaAttribute(bin, 'fname') || '';
      if (!rhythmiaPointsFnameOk(tableName)) {
        // Übergangen, und es wird gesagt: früher passte hier alles, was
        // irgendwo auf `surfelec_<hex>_all.dat` endete.
        try { console.warn(`[epconv] Anatomie „${name}": ${tableName || '(ohne Namen)'} `
          + `heißt nicht wie eine Punkttabelle — nicht als eine gelesen.`); } catch (e) {}
        continue;
      }
      // Eine andere Breite oder ein anderer Typ ist eine andere Tabelle: sie
      // wird gar nicht erst angefasst, nicht verweigert — so hält es auch der
      // Archivleser, der sie nicht als Punkttabelle vormerkt.
      if (rhythmiaAttribute(bin, 'type') !== 'Float64') continue;
      if (parseInt(rhythmiaAttribute(bin, 'cols'), 10) !== SURFELEC_COLS) continue;
      handled.add(bin);
      tables.push(bin);
    }
    if (!positions) { unassignedTables += tables.length; continue; }

    // Für die Spaltenprüfung: die Vertices, wie sie in der Datei stehen. Die
    // Tabelle nennt ihre Orte im selben Raum, und Python prüft ebenso gegen die
    // ungedrehten.
    const untransformed = M ? positions.slice() : positions;
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

    /* Die elektrischen Karten und die Messungen, aus denen sie gebaut sind.
     *
     * Die gespeicherten Aktivierungswerte sind Indizes in das Schlagfenster der
     * Kartenauswertung, keine Millisekunden: erst BeatOffset/BeatDuration
     * daneben geben ihnen Nullpunkt und Schrittweite (Befund §4). */
    const scalars = {};
    const latNotes = [];
    /* Jeder gelesene Kartenblock der Auswertung, wie er in der Datei steht:
     * Art, Quelle, Länge. Beide Leser müssen über dieselbe Menge entscheiden,
     * nicht nur über die Blöcke, die beide zufällig ansehen — der
     * Konformanztest vergleicht sie. */
    const mapBlocks = [];
    let beat = { window: null, reason: 'no-beat-window' };
    let latWithheld = null;
    let activation = null;
    // Jede Aktivierungskarte der Auswertung, in Lesereihenfolge. Die Liste
    // steht hier oben, weil das Fenstergatter sie unten braucht und `raw` im
    // Zweig darüber endet.
    let activationMaps = [];
    let check = null;
    // Ob die Spaltenprüfung eines ungeprüften Standes angeschlagen hat — und
    // nicht bloß, ob irgendeine Tabelle verweigert wurde. Nur das erste sagt
    // etwas über die Vertexkarten aus.
    let columnsDisagree = false;
    const several = engineOuts.length > 1;

    if (several) {
      // Welche der Auswertungen datiert diese Anatomie? Nichts im Archiv sagt
      // es, und zwei können 111 ms auseinanderliegen. 20 von 20 echten
      // Anatomien tragen genau eine (Befund §8.3).
      latWithheld = 'engine-output-multiple';
      beat = { window: null, reason: 'engine-output-multiple' };
      try { console.warn(`[epconv] Anatomie „${name}" trägt ${engineOuts.length} `
        + `Kartenauswertungen — EPCore wählt keine aus: keine Vertexwerte, `
        + `Tabellen verweigert.`); } catch (e) {}
    } else if (engineOuts.length === 1) {
      const eo = engineOuts[0];
      beat = rhythmiaBeatWindow(eo);
      const raw = {};
      // Die Länge des ersten Blocks, der nicht einen Wert je Vertex trägt.
      let mapLengthMismatch = null;
      // Ob eine Art von Block dieselbe Quelle zweimal nennt.
      let duplicateSource = null;
      /* Jeder Aktivierungs- und Spannungsblock der Auswertung, in
       * Dokumentreihenfolge, und jeder wird nach denselben Regeln gefragt —
       * nicht eine feste Liste der Quellen, die dieser Leser zeichnen kann.
       * Die Regel steht einmal, in `rhythmia_layout.vertex_lat_ms`, Absatz
       * „Which blocks a reader walks"; Python nennt denselben Absatz.
       *
       * Vorher holte diese Seite Art × bipolar/unipolar beim Namen. Den dritten
       * Block einer echten Auswertung (Voltage UniDeriv) sah sie damit nie und
       * fragte ihn also weder nach seiner Länge noch nach seinem Fenster, wo
       * Python beides tat: derselbe Block, hier eine Karte und dort eine
       * Verweigerung, beide Male schweigend. */
      const byKind = { Activation: [], Voltage: [] };
      for (const el of eo.children) {
        // Welche Tags als Kartenblock zählen, steht einmal — siehe
        // `rhythmia_layout.map_block_kind`, Absatz über die Schreibung.
        const kind = rhythmiaMapBlockKind(el.tagName);
        if (!kind) continue;
        const values = childByTag(el, 'values');
        const bytes = values && await payloadBytes(values);
        if (!bytes) continue;
        const map = asFloat32(bytes);
        const props = childByTag(el, 'Properties');
        const source = rhythmiaMapSourceLabel(
          props ? elText(childByTag(props, 'SrcEgmType')) : '');
        mapBlocks.push({ kind, source, length: map.length });
        // Die Länge entscheidet vor allem anderen, ob dies eine Karte dieser
        // Anatomie ist: `rhythmia_layout.vertex_lat_ms`, Absatz „One value per
        // vertex". Vorher stand hier `fitToVertexCount`, das den Block schon
        // auf die Vertexzahl brachte, bevor irgendein Gatter ihn sah — Python
        // gatterte den Block, wie er in der Datei steht, und dieselbe Anatomie
        // mit 33 Vertices und 32 Werten kam hier mit 33 und dort mit 32 Werten
        // heraus, beide Male schweigend.
        if (rhythmiaVertexMapRefusal(map, nv)) {
          mapLengthMismatch = map.length;
          continue;
        }
        byKind[kind].push({ source, map });
      }
      // Dieselbe Frage wie Python, an dieselbe Liste: nennt eine Art von Block
      // zweimal dieselbe Quelle, ist keine von beiden die Karte dieser Anatomie
      // (derselbe Docstring, Absatz „One source, one block"). Vorher gewann
      // hier der erste Block und in Python der letzte, beide schweigend.
      for (const kind of RHYTHMIA_MAP_BLOCK_KINDS) {
        duplicateSource = duplicateSource
          || rhythmiaMapSourceRefusal(byKind[kind].map((b) => b.source));
      }
      const pickMap = (kind, source) => {
        const hit = byKind[kind].find((b) => b.source === source);
        return hit ? hit.map : null;
      };
      raw.bipolar = pickMap('Activation', 'bipolar');
      raw.unipolar = pickMap('Activation', 'unipolar');
      raw.lnUvBipolar = pickMap('Voltage', 'bipolar');
      raw.lnUvUnipolar = pickMap('Voltage', 'unipolar');
      if (mapLengthMismatch !== null) latWithheld = 'vertex-count-mismatch';
      else if (duplicateSource) latWithheld = duplicateSource;
      // Spannung in mV: exp(ln µV) / 1000, dieselbe Größe wie in der
      // Punkttabelle und aus demselben Logarithmus. Eine unipolare Karte als
      // `voltage` zu führen sättigte die klinische Skala und zeigte überall
      // gesundes Gewebe — sie reist unter eigenem Namen mit.
      for (const [as, key] of [['voltage', 'lnUvBipolar'], ['unipolar', 'lnUvUnipolar']]) {
        // Ein Block der falschen Länge nimmt der Anatomie auch die Spannung:
        // passt eine Karte der Auswertung nicht auf dieses Mesh, ist keine von
        // ihnen darauf zu legen (derselbe Absatz).
        if (mapLengthMismatch !== null || duplicateSource || !raw[key]) continue;
        const mv = new Float32Array(nv);
        for (let i = 0; i < nv; i++) mv[i] = Math.exp(raw[key][i]) / 1000;
        scalars[as] = cleanScalar(mv);
      }
      activation = raw.bipolar || null;
      // Jede Aktivierungskarte der Auswertung, nicht nur die beiden, die einen
      // Namen im Viewer haben: das Fenstergatter unten gilt für jede von ihnen.
      activationMaps = byKind.Activation.map((b) => b.map);
      if (!software.checked && raw.bipolar && raw.unipolar && raw.lnUvBipolar && raw.lnUvUnipolar) {
        check = (table) => {
          const verdict = rhythmiaLayoutAgrees(untransformed, raw, table);
          if (!verdict.decided || verdict.ok) return null;
          columnsDisagree = true;
          try { console.warn(`[epconv] Rhythmia ${version || 'ohne Versionsangabe'} ist `
            + `ungeprüft und die Spaltenbelegung passt nicht zur Karte `
            + `(Abstände ${JSON.stringify(verdict.margins)}) — Messpunkte und LAT `
            + `nicht übernommen.`); } catch (e) {}
          return 'layout-mismatch';
        };
      }
    }

    const groups = [];
    for (const bin of tables) {
      // Mehrere Auswertungen: die Tabelle wird gar nicht gelesen, statt mit
      // einer geratenen Zeitbasis gezeigt zu werden.
      if (several) continue;
      const { group, refused } = await readRhythmiaPointTable(
        bin, beat, name, anatIdx - 1, getPayload, software, check);
      // Eine *widerlegte* Belegung nimmt auch der Fläche ihre Millisekunden:
      // die Karte steht dann auf denselben Spalten wie die Tabelle. Die
      // Spannung bleibt — sie steht nicht auf den Annotationsspalten.
      //
      // Eine strukturell verweigerte Tabelle (falsche Breite, Einschlussflagge
      // keine Flagge, Elektrodennummerierung gebrochen) sagt dagegen nichts
      // über die Vertexkarten: die liegen in eigenen Blöcken und hängen nur am
      // Schlagfenster. Sie deshalb zurückzuhalten hieße, eine Karte wegen einer
      // fremden Tabelle zu verschweigen — Python tut es nicht, und das
      // Manifest der Fixture (Anatomie „RA_layout") sagt es ebenso.
      if (refused === 'layout-mismatch' && columnsDisagree) latWithheld = 'layout-mismatch';
      if (group) groups.push(group);
    }

    // Ohne Fenster keine Millisekunden. Die Karte behält ihre Form, statt in
    // einer Einheit beschriftet zu werden, in der sie nicht steht.
    //
    // Geprüft wird *jede* Aktivierungskarte der Auswertung, bipolar wie
    // unipolar, und eine davon außerhalb des Fensters hält die LAT der ganzen
    // Anatomie zurück — auch die der bipolaren Karte, die allein `lat` wird.
    // Die Regel und ihre Begründung stehen einmal, in
    // `rhythmia_layout.vertex_lat_ms` („Which maps are gated"): beide sind
    // Annotationen desselben Schlags gegen dasselbe Fenster. Vorher prüfte
    // diese Seite nur `raw.bipolar`, und ein Ausreißer allein in der unipolaren
    // Karte ergab hier Millisekunden und in Python „vertex-outside-window".
    if (!latWithheld) {
      let converted = null;
      for (const map of activationMaps) {
        const { values, reason } = rhythmiaVertexLatMs(map, beat.window, nv);
        if (!values) {
          latWithheld = beat.reason || reason;
          converted = null;
          break;
        }
        if (map === activation) converted = values;
      }
      if (converted) {
        scalars.lat = cleanScalar(converted);
        if (beat.window.cGridAmbiguous) latNotes.push('c-grid-ambiguous');
      }
    }

    meshes.push({ name, positions, normals, faces, scalars, source: 'rhythmia',
                  // Das Fenster reist mit, solange die Karte in ms steht: die
                  // PLY sagt damit, worauf ihre `lat`-Spalte sich bezieht.
                  beatWindow: latWithheld ? null : beat.window,
                  latWithheld, latNotes, mapBlocks, software });
    ownGroups.push(groups);
  }
  // Tag <xyz> is used in raw-vertex space (the per-anatomy <Transform> M is NOT applied).
  // Points are distributed per-anatomy by nearest mesh vertex — a single Rhythmia group
  // (e.g. the global Ablation set spanning LA+LV) is split across meshes per point, not
  // lumped onto whichever anatomy holds the group centroid. Validated only for identity
  // <Transform> — all three real test studies have identity M, so this aligns. Non-identity
  // transforms remain an unhandled limitation: if markers ever appear misaligned on a study,
  // that study has a non-identity M and the tag <xyz> must be transformed before association.
  const tagGroups = extractRhythmiaTags(root);
  const per = (tagGroups.length && meshes.length)
    ? assignTagsToMeshes(meshes, tagGroups) : meshes.map(() => []);
  for (let i = 0; i < meshes.length; i++) {
    /* Die Messpunkte gehören der Karte, in deren Auswertung ihre Tabelle steht,
     * nicht dem nächstgelegenen Mesh: Karten derselben Kammer überlappen im
     * Raum, und die Antwort „nächster Vertex" legt die Punkte einer Sinuskarte
     * auf eine Reentry-Karte, 111 ms neben ihrem eigenen Nullpunkt. */
    const groups = [...per[i], ...(ownGroups[i] || [])];
    if (groups.length) meshes[i].tagGroups = groups;
    // Die Läsionen dieser Anatomie, in der Form, die die Auswertung erwartet.
    // Ohne das stünde bei Rhythmia nur "so viele Punkte" und bei CARTO die
    // ganze Rechnung — dieselbe Frage, zwei Antworten.
    const lesions = per[i]
      .filter(g => g.category === 'ablation')
      .flatMap(g => g.points.map(p => p.ablation).filter(Boolean));
    if (lesions.length) meshes[i].ablation = lesions;
  }
  for (const el of iterTag(root, 'inlinedbin')) {
    if (handled.has(el)) continue;
    if (!rhythmiaPointsFnameOk(rhythmiaAttribute(el, 'fname') || '')) continue;
    if (rhythmiaAttribute(el, 'type') !== 'Float64') continue;
    if (parseInt(rhythmiaAttribute(el, 'cols'), 10) !== SURFELEC_COLS) continue;
    unassignedTables++;
  }
  meshes.unassignedPointTables = unassignedTables;
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

/** Zahlen zu Dreiergruppen, gleich ob sie in Zeilen oder am Stück stehen.
 *
 * Ein echter Export schreibt ein Tripel je Zeile. Steht alles in einer Zeile,
 * hat das genau eine Lesart — 3k Zahlen sind k Tripel — und die Zeilenlogik
 * machte daraus stillschweigend *ein* Tripel und warf den Rest weg. Das ist
 * kein Format, über das man raten müsste, sondern eines, das man lesen kann.
 */
function tripleRows(rows) {
  if (rows.length === 1 && rows[0].length > 3 && rows[0].length % 3 === 0) {
    const flat = rows[0], out = [];
    for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i+1], flat[i+2]]);
    return out;
  }
  return rows;
}

/** Dreiecksindizes aus den `<Polygons>`-Zeilen, geprüft gegen die Vertexzahl.
 *
 * EnSite zählt ab 1: in einem echten Export (fixtures/maps/EnSiteExport.xml)
 * laufen die Indizes 1…801 bei 801 Vertices. Blind eins abzuziehen ist
 * trotzdem gefährlich, denn eine Datei, die nicht so aussieht, wird dabei
 * lautlos zu Unsinn: aus Index 0 wird −1, als Uint32 4294967295, und WebGL
 * bricht den Zeichenaufruf ab, ohne dass jemand davon erfährt. Genau so lag
 * eine Karte mit einem einzigen Vertex in der Szene, und der Leser meldete
 * Erfolg.
 *
 * Also nachrechnen. Passt die Zählung ab 1, wird sie genommen. Passt nur die
 * ab 0, wird sie genommen und gesagt. Passt keine, verweigert der Lauf mit den
 * Zahlen, um die es geht — eine kaputte Karte ist schlechter als keine.
 */
function triangleIndices(rows, vertexCount, volIdx = 0) {
  const usable = rows.filter(r => r.length >= 3);
  if (!usable.length) {
    throw new Error(`EnSite: Volume ${volIdx} hat keine brauchbaren Polygonzeilen `
                  + `(erwartet drei Indizes je Zeile).`);
  }
  let lowest = Infinity, highest = -Infinity;
  for (const row of usable) {
    for (let c = 0; c < 3; c++) {
      const value = Math.trunc(row[c]);
      if (value < lowest) lowest = value;
      if (value > highest) highest = value;
    }
  }
  let base;
  if (lowest >= 1 && highest <= vertexCount) base = 1;
  else if (lowest >= 0 && highest <= vertexCount - 1) base = 0;
  else {
    throw new Error(`EnSite: Volume ${volIdx} nennt Dreiecksecken ${lowest}…${highest}, `
                  + `hat aber ${vertexCount} Vertices. Weder ab 1 noch ab 0 gezählt `
                  + `ergibt das eine Fläche — die Datei ist nicht die, für die sie `
                  + `sich ausgibt.`);
  }
  if (base === 0) {
    console.warn('[epconv] EnSite: Volume %d zählt Dreiecksecken ab 0, nicht ab 1 '
                 + 'wie sonst. Gelesen wie geschrieben.', volIdx);
  }
  const tris = new Uint32Array(usable.length * 3);
  for (let i = 0; i < usable.length; i++) {
    tris[i*3]     = Math.trunc(usable[i][0]) - base;
    tris[i*3 + 1] = Math.trunc(usable[i][1]) - base;
    tris[i*3 + 2] = Math.trunc(usable[i][2]) - base;
  }
  return tris;
}

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
    const vr = tripleRows(textToRows(vEl.textContent));
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
    const pr = tripleRows(textToRows(pEl.textContent));
    const allTris = triangleIndices(pr, positions.length / 3, volIdx);

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
      // Reference annotation, same as carto_points.py reads it: reannotation
      // needs the reference on both paths, and a conformance test caught the
      // browser dropping it.
      referenceAnnotation: cartoNumber(attr('Annotations', 'Reference_Annotation')),
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
  let tagGroups = null, latReference = null;
  for (const ln of lines) {
    const p = ln.trim().split(/\s+/);
    if (p[0] === 'format') format = p[1];
    else if (p[0] === 'comment') {
      const body = ln.trim().replace(/^comment\s+/, '');
      const g = decodeTagComment(body);
      if (g) tagGroups = g;
      // Worauf sich `lat` bezieht, steht im Kopf. Eine vor der LAT-Korrektur
      // geschriebene Datei trägt dieselbe Spalte mit rohen Abtastindizes und
      // sagt nichts dazu — nur diese Zeile unterscheidet die beiden. Sie reist
      // deshalb weiter, wenn der Betrachter die Karte erneut ausgibt.
      else if (body.startsWith('epcore-lat:')) latReference = body;
    }
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

  return { positions, normals, colors, scalars, scalarNames, faces: faces.done(),
           tagGroups, latReference };
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

/** Die Kopfzeilen, die ein Export dieser Karte tragen muss.
 *
 * Zweierlei sagt eine PLY über sich hinaus über ihre Zahlen: welche Marker
 * mitreisen, und worauf ihre `lat`-Spalte sich bezieht. Das zweite lässt sich
 * später nicht zurückholen — eine vor der LAT-Korrektur umgewandelte Fläche
 * trägt rohe Abtastindizes unter demselben Namen, und nur diese Zeile
 * unterscheidet die beiden (ADR-0007/D10).
 *
 * Eine Karte, die selbst aus einer PLY kam, gibt deren Zeile unverändert
 * weiter, statt unsere zu behaupten: sie weiß, woher ihre Werte stammen, und
 * wir wissen es nicht besser.
 */
/** Ob diese Karte sagt, was ihre `lat`-Spalte ist.
 *
 * Entweder die Datei sagt es selbst (`latReference` aus dem PLY-Kopf) oder die
 * Karte ist gerade hier umgewandelt worden und bringt ihr Schlagfenster mit —
 * dann rechnet der Leser die Millisekunden selbst aus und weiß es deshalb.
 * Sagt keines von beidem etwas, sind die Zahlen ungeklärt: eine vor der
 * Korrektur umgewandelte Rhythmia-PLY trägt rohe Abtastindizes unter demselben
 * Namen, und eine CARTO-PLY echte Millisekunden.
 *
 * Die Frage steht hier einmal, weil sie an zwei Stellen gestellt wird — im
 * PLY-Kopf beim Export und in `act_bip` beim OpenEP-Export. Zwei Kopien der
 * Regel laufen genau so auseinander, wie Python und Browser es hier taten.
 */
export function statesLatUnit(mesh) {
  if (!mesh || !mesh.scalars || !mesh.scalars.lat) return false;
  return Boolean(mesh.latReference || mesh.beatWindow);
}

export function plyComments(mesh, tagGroups) {
  const out = [];
  if (tagGroups && tagGroups.length) out.push(encodeTagComment(tagGroups));
  if (mesh && mesh.latReference) out.push(mesh.latReference);
  else if (statesLatUnit(mesh)) out.push(rhythmiaLatComment(mesh.beatWindow));
  return out;
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
