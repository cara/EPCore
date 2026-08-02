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

import { anatomicalStructures } from './epmetrics.js?v=cb2a4ca3d529';

export const WRITER = 'EPCore';

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
  w.bytes(arrayHead(mxCHAR, [text.length ? 1 : 0, text.length], name));
  const utf16 = new Uint16Array([...text].map(c => c.charCodeAt(0)));
  w.bytes(element(miUTF8 === 16 ? 4 : 4, new Uint8Array(utf16.buffer)));  // miUINT16
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

/** The bytes of a .mat file holding one map. */
export function buildOpenEP(positions, faces, {
  activation = null, bipolar = null, unipolar = null,
  impedance = null, force = null, name = '', notes = '',
  points = null, curves = null, pointNames = null,
} = {}) {
  const n = positions.length / 3;
  const m = faces.length / 3;
  if (!n || !m) throw new Error('Leere Oberfläche: nichts zu schreiben.');

  const placed = (points || []).filter(Boolean);
  const told = notes || (placed.length
    ? `Written by EPCore from a vendor export. It holds the surface, its `
      + `per-vertex scalars and ${placed.length} mapping point(s) with their `
      + `electrograms. There are no ablation records in it, and that field is `
      + `empty rather than filled with something invented.`
    : 'Written by EPCore from a converted vendor export. It holds the surface '
      + 'and its per-vertex scalars; there are no mapping points, electrograms '
      + 'or ablation records in it, and those fields are empty rather than '
      + 'filled with something invented.');

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
