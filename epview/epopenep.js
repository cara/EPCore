/* Writing a map in the OpenEP format, in the browser.
 *
 * The same `userdata` structure epcore/epview/openep_export.py writes, so a
 * file saved from the viewer and one written by `epcore epview openep` open
 * the same way. tests/python/epview check that by reading both back with
 * scipy rather than by trusting that two ports agree.
 *
 * Nothing here derives from OpenEP's code, which is Apache-2.0 for the MATLAB
 * core and GPL-3.0 for the Python one while this tree is MIT. What is used is
 * the *layout* of the file — field names and array shapes, which a format is
 * and which no licence covers.
 *
 * ## Two conventions that are easy to get wrong
 *
 *  * MATLAB indexes from 1. `Triangulation` holds vertex indices and they are
 *    written 1-based; written 0-based the mesh loads without complaint and is
 *    wrong at every face, with the first vertex silently unused.
 *  * A missing measurement is NaN, not a sentinel. A map with no activation
 *    data must not arrive as one whose activation is zero everywhere — that is
 *    a different and much worse claim.
 *
 * ## What travels
 *
 * The surface and its per-vertex scalars. A converted export holds no mapping
 * points, electrograms or ablation records, so those fields are written empty
 * rather than invented, and `notes` says so inside the file. An empty field is
 * a gap somebody can see; a fabricated one is not.
 */

import { anatomicalStructures } from './epmetrics.js?v=c4ae27508f81';
import { statesLatUnit, rhythmiaLatComment, RHYTHMIA_LAT_COMMENT } from './epconv.js?v=c4ae27508f81';

export const WRITER = 'EPCore';

//: Was die Datei über eine Aktivierung sagt, die ihre Einheit nennt —
//: wortgleich mit `openep_export.RHYTHMIA_LAT_NOTE`. OpenEP hat ein
//: Aktivierungsfeld und keinen Platz für eine Einheit, also steht der Satz in
//: `notes` statt im Kopf des Lesers.
//: `floor(… + 0.5)` und nicht `round`: der Satz muss die Regel nennen, die der
//: Code fährt, und die beiden unterscheiden sich. Python rundet die exakte
//: Hälfte zur geraden Zahl, JavaScript nach oben — deshalb schreibt
//: `rhythmiaBeatStart` sie aus, und ein Vermerk mit „round" schickte einen
//: Leser, der die Datei nachrechnet, zur falschen Arithmetik.
export const RHYTHMIA_LAT_NOTE =
  'LAT is in ms relative to the beat marker: (activation + c) × 1000/953.674 '
  + 'with c = floor(BeatOffset/Δt + 0.5) of the map.';

//: Und was sie sagt, wenn die Fläche nichts dazu sagt — wortgleich mit
//: `openep_export.LAT_UNSTATED_NOTE`. Der Wert reist mit: hier im Viewer ist
//: eine Karte ohne Vermerk genauso wahrscheinlich eine umgewandelte
//: CARTO-Karte, deren `lat` echte Millisekunden sind, wie eine vor der
//: Korrektur umgewandelte Rhythmia-Karte. Wegwerfen leerte die eine so
//: lautlos, wie Mitschreiben die andere falsch beschriftet.
export const LAT_UNSTATED_NOTE =
  "The surface states no unit for 'lat', so what these numbers are could not "
  + 'be established here: a map converted from CARTO holds milliseconds, and a '
  + 'Rhythmia surface converted before the LAT fix holds raw sample indices, '
  + 'which are not milliseconds and are out by an offset and a factor of '
  + '1.049. Check the source before reading the activation as a time; a '
  + "Rhythmia study re-converted with 'epcore epview rhythmia <study>.000' "
  + 'states its unit and needs no checking.';

//: Was der Vermerk ergänzt, wenn die Zeile der Fläche den
//: Halbabtastungs-Vorbehalt trägt — wortgleich mit
//: `openep_export.RHYTHMIA_C_AMBIGUOUS_NOTE`.
export const RHYTHMIA_C_AMBIGUOUS_NOTE =
  'The beat marker sits on half a sample, so c follows the vendor export\'s '
  + 'rounding: this LAT may be one sample (1.049 ms) out.';

//: Und was er über eine Fläche sagt, die eine eigene Einheit nennt statt
//: Rhythmias — wortgleich mit `openep_export.LAT_STATED_NOTE`.
export const LAT_STATED_NOTE = "The surface states what its 'lat' is: {}";

//: And what it says about EPCore's derived activation, which is not written —
//: verbatim `openep_export.DERIVED_LAT_NOTE`. In `act_bip` every reader that
//: does not know `userdata.epcore` would take it for the recording system's,
//: and this export does not write the marker ADR-0009 §6 asks for beside it.
export const DERIVED_LAT_NOTE =
  "The surface also carried EPCore's derived activation ('lat_epcore', "
  + 'interpolated from reannotated points). It was not written into the '
  + "activation field: OpenEP reads that field as the recording system's, and "
  + "a derived activation needs EPCore's annotation marker beside it (how many "
  + 'points were edited or discarded, in which study), which this surface '
  + 'does not carry.';

/** Die Aktivierung für den OpenEP-Export und der Satz, der dazugehört.
 *
 * Dieselbe Entscheidung wie `openep_export._lat_if_stated` für eine PLY: `lat`
 * wird nie stillschweigend als Millisekunden ausgegeben, aber auch nie
 * stillschweigend weggeworfen. Steht die Entscheidung hier und nicht in
 * `index.html`, kann ein Test sie stellen — die Aufrufstelle im Viewer war
 * genau deshalb ungeprüft und gab `sc.lat` ungefragt weiter.
 */
export function openEPActivation(mesh) {
  // A derived activation (`lat_epcore`, from "Fläche neu rechnen") stays out,
  // but not without a word: the decision is taken on the rest of the surface,
  // and the sentence is added to it — as `openep_export.main` does for any input.
  if (mesh && mesh.scalars && mesh.scalars.lat_epcore) {
    const { lat_epcore: _derived, ...vendor } = mesh.scalars;
    const found = openEPActivation({ ...mesh, scalars: vendor });
    return { ...found,
             latNote: [found.latNote, DERIVED_LAT_NOTE].filter(Boolean).join(' ') };
  }
  const lat = mesh && mesh.scalars ? mesh.scalars.lat : null;
  if (!lat) return { activation: null, latNote: '' };
  if (!statesLatUnit(mesh)) return { activation: lat, latNote: LAT_UNSTATED_NOTE };
  // Was die Datei sagt, nicht was wir an ihrer Stelle sagen würden: eine Fläche
  // mit eigener Einheitsangabe bekommt ihren eigenen Satz wiederholt, eine
  // Rhythmia-Fläche den von Rhythmia — samt Halbabtastungs-Vorbehalt, wenn ihre
  // Zeile ihn trägt. Wortgleich mit `openep_export._lat_if_stated`.
  const stated = mesh.latReference || rhythmiaLatComment(mesh.beatWindow);
  if (!stated.startsWith(RHYTHMIA_LAT_COMMENT)) {
    return { activation: lat, latNote: LAT_STATED_NOTE.replace('{}', stated) };
  }
  const note = stated === RHYTHMIA_LAT_COMMENT
    ? RHYTHMIA_LAT_NOTE
    : `${RHYTHMIA_LAT_NOTE} ${RHYTHMIA_C_AMBIGUOUS_NOTE}`;
  return { activation: lat, latNote: note };
}

//: What the file says when its bipolar field holds a measurement whose kind the
//: export did not state — verbatim `openep_export.UNNAMED_SCALAR_NOTE`.
export const UNNAMED_SCALAR_NOTE =
  'The per-vertex scalar comes from an EnSite DIF export, which states one '
  + 'value per vertex without naming the quantity — bipolar voltage in some '
  + 'exports and local activation time in others. It has been placed in the '
  + 'bipolar voltage field because OpenEP has no field for an unnamed '
  + 'measurement. Check the unit against the original study before reading it '
  + 'as millivolts.';

/** The bipolar column for the OpenEP export, and the `notes` that go with it.
 *
 * The rule of `openep_export.main`: EnSite states one value per vertex as
 * `map_data` and does not name the quantity. OpenEP has no field for that, so
 * it goes into the bipolar one, and the file admits it is a guess. Dropping it
 * wrote a surface with nothing on it while `notes` claimed its scalars were
 * there. Keyed on the scalars, not on the source, so a PLY converted from a DIF
 * comes out as the DIF does — as in Python.
 *
 * `notes` goes to `buildOpenEP` as `extraNotes`, after the default sentence:
 * `openep_export.main` passes the caveat as `extra_notes`, so the file still
 * says which of its fields are empty on purpose.
 */
export function openEPBipolar(mesh) {
  const scalars = (mesh && mesh.scalars) || {};
  if (scalars.map_data != null && scalars.voltage == null) {
    return { bipolar: scalars.map_data, notes: UNNAMED_SCALAR_NOTE };
  }
  return { bipolar: scalars.voltage || null, notes: '' };
}

/** The map's name inside the file — the rule of `epcore epview openep`.
 *
 * Never the name the map was opened under. A file or study folder is often
 * named after the patient and carries the procedure date, and the name inside
 * the .mat survives renaming the download, which is the file that gets handed
 * on. Like the command line: the technical map name a CARTO or EnSite export
 * gives ("1-LA", "EnSite_vol0"); "Rhythmia" for a Rhythmia archive, whose
 * anatomy labels are typed by hand; "map" for anything else, a loaded mesh
 * file among them.
 *
 * An EnSite name is taken only in the form both DIF readers write it
 * (`ensite_to_3d.parse_ensite_xml`, `epconv.parseEnSite`). A Velocity study
 * also comes in as EnSite, under the name of the folder it was opened from,
 * and the command line writes "map" for it, since it takes such a study only
 * as the PLY converted from it.
 */
const ENSITE_MAP_NAME = /^EnSite_vol\d+(_surf\d+)?$/;

export function openEPName(source, mapName) {
  if (source === 'rhythmia') return 'Rhythmia';
  if (source === 'carto' && mapName) return String(mapName);
  if (source === 'ensite' && ENSITE_MAP_NAME.test(String(mapName || ''))) return String(mapName);
  return 'map';
}

/** A raw export's mapping points with their traces and names, for `buildOpenEP`.
 *
 * The same rule as `openep_export._from_carto`, so that a file from the viewer and
 * one from `epcore epview openep` say the same:
 *
 *  * `egm` is OpenEP's *bipolar* field. It takes the channel the header names as
 *    the bipolar mapping channel, not whichever happens to come first. If the
 *    header names none, the first is written and `names` says which it is.
 *  * In millivolts, not counts: the header names the gain, and a trace in raw
 *    counts is, at 0.003 mV per count, a signal 333 times too large that does not
 *    look wrong.
 *  * Every point, including one with no position. Python writes it with NaN
 *    coordinates, and one row fewer would shift every later one against the file
 *    from the other path.
 *
 * Here and not in `index.html`, so that a conformance test can hold the rule.
 */
export async function openEPPoints(points, readEgm) {
  const curves = [], names = [];
  for (const point of points) {
    const id = String(point.id ?? point.label ?? '');
    let egm = null;
    try { egm = await readEgm(point); } catch (e) { egm = null; }
    if (!egm || !egm.channels || !egm.channels.length) {
      curves.push(null);
      names.push(id);
      continue;
    }
    const named = egm.bipolarChannel && egm.channels.includes(egm.bipolarChannel)
      ? egm.bipolarChannel : null;
    const channel = named || egm.channels[0];
    const counts = egm.samples[egm.channels.indexOf(channel)];
    const gain = Number.isFinite(egm.gainMv) ? egm.gainMv : 1;
    curves.push(Float64Array.from(counts, (v) => v * gain));
    names.push(`${id} ${channel}`);
  }
  return { points: [...points], curves, names };
}

// MAT-file data types (Level 5).
const miINT8 = 1, miUINT8 = 2, miINT32 = 5, miUINT32 = 6;
const miDOUBLE = 9, miMATRIX = 14, miUTF8 = 16;
// Array classes.
const mxCHAR = 4, mxDOUBLE = 6, mxSTRUCT = 2, mxUINT8 = 9;

const pad8 = (n) => (8 - (n % 8)) % 8;

class Writer {
  constructor() { this.chunks = []; this.length = 0; }
  bytes(u8) { this.chunks.push(u8); this.length += u8.length; }
  zeros(n) { if (n > 0) this.bytes(new Uint8Array(n)); }
  u32(...values) {
    const a = new Uint32Array(values);
    this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  i32(...values) {
    const a = new Int32Array(values);
    this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  concat() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

function element(type, payload) {
  // A data element: 8-byte tag, payload, padding to the next 8-byte boundary.
  const w = new Writer();
  w.u32(type, payload.length);
  w.bytes(payload);
  w.zeros(pad8(payload.length));
  return w.concat();
}

function raw(values, Type, type) {
  const a = Type.from(values);
  return element(type, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

/** Header of a miMATRIX: flags, dimensions, name. */
function arrayHead(klass, dims, name, { logical = false } = {}) {
  const w = new Writer();
  const flags = new Uint32Array([klass | (logical ? 0x0200 : 0), 0]);
  w.bytes(element(miUINT32, new Uint8Array(flags.buffer)));
  w.bytes(raw(dims, Int32Array, miINT32));
  const nameBytes = new Uint8Array([...name].map(c => c.charCodeAt(0)));
  w.bytes(element(miINT8, nameBytes));
  return w.concat();
}

/** A real double matrix, column-major as MATLAB stores it. */
function doubleMatrix(name, rows, cols, at) {
  const w = new Writer();
  w.bytes(arrayHead(mxDOUBLE, [rows, cols], name));
  const data = new Float64Array(rows * cols);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) data[c * rows + r] = at(r, c);
  }
  w.bytes(element(miDOUBLE, new Uint8Array(data.buffer)));
  return element(miMATRIX, w.concat());
}

/** A logical column, false unless `values` says otherwise. */
function logicalColumn(name, rows, values = null) {
  const w = new Writer();
  w.bytes(arrayHead(mxUINT8, [rows, 1], name, { logical: true }));
  const out = new Uint8Array(rows);
  if (values) for (let i = 0; i < rows; i++) out[i] = values[i] ? 1 : 0;
  w.bytes(element(miUINT8, out));
  return element(miMATRIX, w.concat());
}

function charArray(name, text) {
  const w = new Writer();
  // Die Maße zählen Codepunkte, die Daten sind UTF-8 — so zählt **scipy**, und
  // scipy ist, was eine OpenEP-Datei liest: `openep_import` lädt sie mit
  // `loadmat`, ebenso die Python-Portierung von OpenEP.
  //
  // Nicht, wie hier früher stand, „so schreibt MATLAB selbst": MATLAB zählt ein
  // `char`-Array in UTF-16-Codeeinheiten, ein Emoji also zwei, und genau so
  // liest `epcore.core.matv5` (ADR-0008). Gemessen 2026-09-16 am Kartennamen
  // „Mappe 🫀 Größe" (13 Codepunkte, 14 UTF-16-Einheiten): eine `.mat` damit —
  // von diesem Schreiber *und* von `scipy.io.savemat` — verweigert matv5 mit
  // „14 characters where the dimensions call for 13", den Zahlen dieses
  // Namens, während scipy beide liest. Für Text außerhalb der
  // BMP widersprechen die beiden Zählungen einander, eine Datei kann nur einer
  // folgen, und eine OpenEP-Datei folgt der ihres Lesers. Die Grenze ist in
  // beide Richtungen angepinnt (test_openep_conformance.py) und im ADR
  // vermerkt.
  //
  // *Codepunkte*, nicht UTF-16-Code-Einheiten: `text.length` zählt ein Emoji im
  // Kartennamen als zwei (Ersatzpaar), die Nutzlast trägt es als eines. Das
  // Maß war dann um eins zu groß, und scipy verweigerte die ganze Datei mit
  // `TypeError: buffer is too small for requested array` — nicht bloß ein falsch
  // beschriftetes Feld, sondern eine unlesbare Datei. Genau diese Korrektur
  // hat sie eingeschleppt: davor stand hier UTF-16 unter miUINT16, wo Maß und
  // Nutzlast beide Code-Einheiten zählten und der Fehler sich aufhob.
  //
  // Vorher standen hier nämlich UTF-16-Code-Einheiten unter miUINT16, und
  // jedes Zeichen über U+007F kam als U+FFFD zurück: aus `×` wurde `?`, aus
  // `Δt` `?t`, und aus einer Karte „Mappe Größe" eine mit kaputtem Namen.
  // Reines ASCII überlebte, weshalb es keinem Test auffiel — die
  // Konformanzprüfung verglich Sätze, in denen keine Umlaute vorkamen.
  const characters = [...text].length;
  const utf8 = new TextEncoder().encode(text);
  w.bytes(arrayHead(mxCHAR, [characters ? 1 : 0, characters], name));
  w.bytes(element(miUTF8, utf8));
  return element(miMATRIX, w.concat());
}

/** A cell array of strings — how MATLAB holds a list of names. */
function cellOfStrings(name, values) {
  const w = new Writer();
  w.bytes(arrayHead(1, [values.length ? 1 : 0, values.length], name));  // mxCELL
  for (const value of values) w.bytes(charArray('', String(value)));
  return element(miMATRIX, w.concat());
}

/** An empty double matrix — a field that exists and holds nothing. */
function emptyMatrix(name, rows = 0, cols = 0) {
  const w = new Writer();
  w.bytes(arrayHead(mxDOUBLE, [rows, cols], name));
  w.bytes(element(miDOUBLE, new Uint8Array(0)));
  return element(miMATRIX, w.concat());
}

/** A 1x1 struct. `fields` is [name, encodedMatrixElement] in order. */
function structArray(name, fields) {
  const w = new Writer();
  w.bytes(arrayHead(mxSTRUCT, [1, 1], name));
  const WIDTH = 32;
  w.bytes(element(miINT32, new Uint8Array(new Int32Array([WIDTH]).buffer)));
  const names = new Uint8Array(WIDTH * fields.length);
  fields.forEach(([field], i) => {
    for (let c = 0; c < field.length && c < WIDTH - 1; c++) {
      names[i * WIDTH + c] = field.charCodeAt(c);
    }
  });
  w.bytes(element(miINT8, names));
  for (const [, encoded] of fields) w.bytes(encoded);
  return element(miMATRIX, w.concat());
}

const column = (values, n) => (r) => {
  if (!values) return NaN;
  const v = values[r];
  return Number.isFinite(v) ? v : NaN;
};

/** The bytes of a .mat file holding one map.
 *
 * `notes` replaces the sentence that says what is and is not in the file;
 * `extraNotes` and `latNote` follow it, in that order — as `extra_notes` and
 * `lat_note` do in `openep_export.build_userdata`.
 */
export function buildOpenEP(positions, faces, {
  activation = null, bipolar = null, unipolar = null,
  impedance = null, force = null, name = '', notes = '', latNote = '',
  extraNotes = '',
  points = null, curves = null, pointNames = null,
} = {}) {
  const n = positions.length / 3;
  const m = faces.length / 3;
  if (!n || !m) throw new Error('Leere Oberfläche: nichts zu schreiben.');

  const placed = (points || []).filter(Boolean);
  let told = notes || (placed.length
    ? `Written by EPCore from a vendor export. It holds the surface, its `
      + `per-vertex scalars and ${placed.length} mapping point(s) with their `
      + `electrograms. There are no ablation records in it, and that field is `
      + `empty rather than filled with something invented.`
    : 'Written by EPCore from a converted vendor export. It holds the surface '
      + 'and its per-vertex scalars; there are no mapping points, electrograms '
      + 'or ablation records in it, and those fields are empty rather than '
      + 'filled with something invented.');

  // What the activation column is rides *along with* the rest of the sentence,
  // not in its place: "this map has no points" and "its lat came without a
  // unit" are two things a reader needs both of. The same holds for what the
  // caller says about the rest of the file (points of other maps left out).
  if (extraNotes) told = `${told} ${extraNotes}`;
  if (latNote) told = `${told} ${latNote}`;

  const rim = anatomicalStructures(positions, faces).rimVertices;

  const triRep = structArray('triRep', [
    ['X', doubleMatrix('X', n, 3, (r, c) => positions[r * 3 + c])],
    // MATLAB counts from 1.
    ['Triangulation', doubleMatrix('Triangulation', m, 3,
                                   (r, c) => faces[r * 3 + c] + 1)],
  ]);

  const act = column(activation, n), bip = column(bipolar, n);
  const uni = column(unipolar, n), imp = column(impedance, n), frc = column(force, n);

  const surface = structArray('surface', [
    ['triRep', triRep],
    // The vertices on a free boundary — a valve ring, a vein ostium, the
    // transseptal cut. Recovered from the geometry, because a converted export
    // does not mark them and statistics that include them measure the cut edge
    // of the reconstruction rather than tissue.
    ['isVertexAtRim', logicalColumn('isVertexAtRim', n, rim)],
    ['act_bip', doubleMatrix('act_bip', n, 2, (r, c) => (c === 0 ? act(r) : bip(r)))],
    ['uni_imp_frc', doubleMatrix('uni_imp_frc', n, 3,
                                 (r, c) => (c === 0 ? uni(r) : c === 1 ? imp(r) : frc(r)))],
  ]);

  // Empty when there are none — which is the case for a converted surface and
  // not for a raw export the viewer read the points out of.
  const rows = placed.length;
  const width = Math.max(0, ...(curves || []).map(c => (c ? c.length : 0)));
  const at = (list, r, c) => {
    const p = placed[r];
    const xyz = list === 'surf' ? (p.surfaceXyz || p.surface_xyz) : p.xyz;
    return xyz && xyz[c] != null ? xyz[c] : NaN;
  };
  const electric = structArray('electric', [
    ['isPointLocationOnly', rows ? logicalColumn('isPointLocationOnly', rows)
                                 : emptyMatrix('isPointLocationOnly')],
    ['tags', emptyMatrix('tags')],
    ['names', rows ? cellOfStrings('names',
        (pointNames && pointNames.length === rows) ? pointNames
          : placed.map(p => String(p.id ?? p.label ?? '')))
      : emptyMatrix('names')],
    ['egmX', rows ? doubleMatrix('egmX', rows, 3, (r, c) => at('rov', r, c))
                  : emptyMatrix('egmX', 0, 3)],
    ['egmSurfX', rows ? doubleMatrix('egmSurfX', rows, 3, (r, c) => at('surf', r, c))
                      : emptyMatrix('egmSurfX', 0, 3)],
    // One point per row, padded with NaN to the longest. Not with zeros: a
    // short sweep followed by zeros reads as a signal that went flat, which is
    // a measurement nobody made.
    ['egm', (rows && width)
      ? doubleMatrix('egm', rows, width, (r, c) => {
          const curve = (curves || [])[r];
          return curve && c < curve.length ? curve[c] : NaN;
        })
      : emptyMatrix('egm')],
    ['egmUni', emptyMatrix('egmUni')],
    ['ecgNames', emptyMatrix('ecgNames')], ['ecg', emptyMatrix('ecg')],
  ]);

  const userdata = structArray('userdata', [
    ['surface', surface],
    ['electric', electric],
    ['rfindex', structArray('rfindex', [])],
    ['notes', charArray('notes', told)],
    ['name', charArray('name', name)],
    ['createdBy', charArray('createdBy', WRITER)],
  ]);

  const w = new Writer();
  const text = `MATLAB 5.0 MAT-file, written by ${WRITER}`;
  const header = new Uint8Array(116).fill(0x20);
  for (let i = 0; i < text.length && i < 116; i++) header[i] = text.charCodeAt(i);
  w.bytes(header);
  w.zeros(8);                                   // subsystem offset: unused
  w.bytes(new Uint8Array([0x00, 0x01, 0x49, 0x4d]));   // version 0x0100, "IM"
  w.bytes(userdata);
  return w.concat();
}

//: What the file says when points of the same export's other maps were left
//: out (`{}` is their count) — verbatim `openep_export.OTHER_MAPS_NOTE`. The
//: count only: the other maps' names are typed by the operator, and the file
//: is made to be handed on.
export const OTHER_MAPS_NOTE =
  '{} mapping point(s) recorded on other maps of the same export were left '
  + 'out; they belong beside a different surface.';

/** The points that belong beside the surface of map `mapName`, and the
 * sentence about the others — the rule of `openep_export.own_points`.
 *
 * A CARTO export holds several maps and numbers points per map. The reader
 * attaches the whole study's point list to every mesh (that is how the viewer
 * shows them), but only the map's own belong in a .mat: a foreign "1 M1-M2"
 * next to this map's "1 M1-M2" cannot be told apart in the file, and every
 * analysis over egmX/egm mixes two chambers. A point whose file name names no
 * map (`mapName` null) is kept: nothing says it belongs elsewhere.
 *
 * Returns `{ points, leftOut, note }`; `note` goes to `buildOpenEP` as
 * `extraNotes`, so that the file says what is missing.
 */
export function openEPOwnPoints(points, mapName) {
  const own = [];
  let leftOut = 0;
  for (const point of points || []) {
    const theirs = point ? point.mapName : null;
    if (theirs != null && theirs !== mapName) leftOut += 1;
    else own.push(point);
  }
  return { points: own, leftOut,
           note: leftOut ? OTHER_MAPS_NOTE.replace('{}', String(leftOut)) : '' };
}
