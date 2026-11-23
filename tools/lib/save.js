// TotK progress.sav / direct_file_save_related.sav reader and writer (format 0x0049e946, game 1.4.x).
//
// Layout: 0x20-byte header {u32 magic 0x01020304, u32 version, u32 data offset}, then (u32 hash, u32 value) pairs in 33
// groups, each opened by a pair with hash 0, in the order of GROUPS below. Bool, Int, Float, Enum and UInt keep their value
// in the pair; every other group stores an offset into the data area after the table. The data area is packed in table
// order and zero padded to the file's fixed size, which the game sizes for every array at its maximum.
'use strict';
const { RomFS } = require('./romfs');
const { parseByml } = require('./byml');

const GROUPS = ['Bool', 'BoolArray', 'Int', 'IntArray', 'Float', 'FloatArray', 'Enum', 'EnumArray', 'Vector2', 'Vector2Array',
  'Vector3', 'Vector3Array', 'String16', 'String16Array', 'String32', 'String32Array', 'String64', 'String64Array', 'Binary',
  'BinaryArray', 'UInt', 'UIntArray', 'Int64', 'Int64Array', 'UInt64', 'UInt64Array', 'WString16', 'WString16Array',
  'WString32', 'WString32Array', 'WString64', 'WString64Array', 'Bool64bitKey'];
const INLINE = new Set(['Bool', 'Int', 'Float', 'Enum', 'UInt']);
const FIXED = { Vector2: 8, Vector3: 12, String16: 16, String32: 32, String64: 64, Int64: 8, UInt64: 8, WString16: 32, WString32: 64, WString64: 128 };
const ELEM = { IntArray: 4, UIntArray: 4, FloatArray: 4, EnumArray: 4, Vector2Array: 8, Vector3Array: 12, String16Array: 16, String32Array: 32,
  String64Array: 64, Int64Array: 8, UInt64Array: 8, WString16Array: 32, WString32Array: 64, WString64Array: 128 };

let gdl = null;
/** hash -> GameDataList entry (from the local RomFS). */
function gameDataList() {
  if (gdl) return gdl;
  const r = new RomFS();
  const root = parseByml(r.read(r.list(/^GameData\/GameDataList\..*\.byml\.zs$/)[0])).root;
  gdl = new Map();
  for (const [type, arr] of Object.entries(root.Data)) {
    if (type === 'Bool64bitKey') continue;
    for (const e of arr) gdl.set(e.Hash >>> 0, { type, entry: e });
  }
  return gdl;
}

class SaveFile {
  constructor(buf) {
    if (buf.readUInt32LE(0) !== 0x01020304) throw new Error('not a TotK save file');
    this.buf = buf;
    this.dataOff = buf.readUInt32LE(8);
    this.pairs = []; // {pos, hash, group}
    this.byHash = new Map();
    let g = -1;
    for (let o = 0x20; o < this.dataOff; o += 8) {
      const h = buf.readUInt32LE(o);
      if (h === 0) { g++; continue; }
      const p = { pos: o, hash: h, group: GROUPS[g] };
      this.pairs.push(p);
      if (!this.byHash.has(h)) this.byHash.set(h, p);
    }
    if (g !== GROUPS.length - 1) throw new Error(`unexpected group count ${g + 1}`);
  }
  has(hash) { return this.byHash.has(hash >>> 0); }
  pair(hash) {
    const p = this.byHash.get(hash >>> 0);
    if (!p) throw new Error('key not in save: ' + hash);
    return p;
  }
  value(hash) { return this.buf.readUInt32LE(this.pair(hash).pos + 4); }
  setInline(hash, v) {
    const p = this.pair(hash);
    if (!INLINE.has(p.group)) throw new Error('not an inline value');
    p.group === 'Int' ? this.buf.writeInt32LE(v, p.pos + 4) : this.buf.writeUInt32LE(v >>> 0, p.pos + 4);
  }

  /** Length of the data a pair points at, from its type's layout. */
  dataLength(p) {
    const off = this.buf.readUInt32LE(p.pos + 4);
    const t = p.group;
    if (FIXED[t]) return FIXED[t];
    const n = this.buf.readUInt32LE(off);
    if (ELEM[t]) return 4 + n * ELEM[t];
    if (t === 'BoolArray') return 4 + Math.ceil(n / 32) * 4;
    if (t === 'Binary') return 4 + n;
    if (t === 'BinaryArray') {
      let q = off + 4;
      for (let i = 0; i < n; i++) q += 4 + this.buf.readUInt32LE(q);
      return q - off;
    }
    return null; // Bool64bitKey: runs to the end of the data
  }

  /** Every offset-holding pair, in data order, with its span. Throws when the spans do not tile the data area. */
  layout() {
    // A Bool64bitKey block with offset 0 is absent (direct_file_save_related.sav).
    const items = this.pairs.filter((p) => !INLINE.has(p.group)).map((p) => ({ p, off: this.buf.readUInt32LE(p.pos + 4) }))
      .filter((it) => !(it.p.group === 'Bool64bitKey' && it.off === 0));
    items.sort((a, b) => a.off - b.off);
    let at = this.dataOff;
    for (const it of items) {
      if (it.off !== at) throw new Error(`data of ${it.p.hash} (${it.p.group}) starts at 0x${it.off.toString(16)}, expected 0x${at.toString(16)}`);
      const len = this.dataLength(it.p);
      it.len = len == null ? this.usedEnd() - it.off : len;
      at = it.off + it.len;
    }
    return items;
  }
  usedEnd() {
    let end = this.dataOff;
    for (let o = this.buf.length - 1; o >= this.dataOff; o--) if (this.buf[o] !== 0) { end = o + 1; break; }
    return end;
  }

  // ----- typed access -----
  readArray(hash) {
    const p = this.pair(hash);
    const off = this.buf.readUInt32LE(p.pos + 4);
    const n = this.buf.readUInt32LE(off);
    const out = [];
    for (let i = 0; i < n; i++) {
      const q = off + 4 + i * (ELEM[p.group] || 0);
      switch (p.group) {
        case 'IntArray': out.push(this.buf.readInt32LE(q)); break;
        case 'UIntArray': case 'EnumArray': out.push(this.buf.readUInt32LE(q)); break;
        case 'FloatArray': out.push(this.buf.readFloatLE(q)); break;
        case 'Vector3Array': out.push([0, 1, 2].map((k) => this.buf.readFloatLE(q + k * 4))); break;
        case 'BoolArray': out.push(!!(this.buf.readUInt32LE(off + 4 + (i >> 5) * 4) & (1 << (i & 31)))); break;
        default: throw new Error('readArray: unsupported ' + p.group);
      }
    }
    return out;
  }
  /** Overwrite one element of a fixed-size array in place. */
  writeArrayElement(hash, i, v) {
    const p = this.pair(hash);
    const off = this.buf.readUInt32LE(p.pos + 4);
    const n = this.buf.readUInt32LE(off);
    if (i < 0 || i >= n) throw new Error('index out of range');
    const q = off + 4 + i * (ELEM[p.group] || 0);
    switch (p.group) {
      case 'IntArray': this.buf.writeInt32LE(v, q); break;
      case 'Vector3Array': v.forEach((x, k) => this.buf.writeFloatLE(x, q + k * 4)); break;
      case 'BoolArray': {
        const w = off + 4 + (i >> 5) * 4;
        const bits = this.buf.readUInt32LE(w);
        this.buf.writeUInt32LE((v ? bits | (1 << (i & 31)) : bits & ~(1 << (i & 31))) >>> 0, w);
        break;
      }
      default: throw new Error('writeArrayElement: unsupported ' + p.group);
    }
  }
  readBinaryArray(hash) {
    const off = this.value(hash);
    const n = this.buf.readUInt32LE(off);
    const out = [];
    let q = off + 4;
    for (let i = 0; i < n; i++) {
      const sz = this.buf.readUInt32LE(q);
      out.push(Buffer.from(this.buf.subarray(q + 4, q + 4 + sz)));
      q += 4 + sz;
    }
    return out;
  }
  /**
   * A copy of this save with a BinaryArray's elements replaced. The data behind it moves by the size difference and every
   * offset past it is shifted, as the game does when its own arrays grow.
   */
  withBinaryArray(hash, elements) {
    const p = this.pair(hash);
    if (p.group !== 'BinaryArray') throw new Error('not a BinaryArray');
    const start = this.value(hash);
    const end = start + this.dataLength(p);
    const parts = [];
    const head = Buffer.alloc(4);
    head.writeUInt32LE(elements.length);
    parts.push(head);
    for (const e of elements) {
      const s = Buffer.alloc(4);
      s.writeUInt32LE(e.length);
      parts.push(s, e);
    }
    const fresh = Buffer.concat(parts);
    const delta = fresh.length - (end - start);
    const used = this.usedEnd();
    if (used + delta > this.buf.length) throw new Error('the save file has no room for this data');
    const out = Buffer.alloc(this.buf.length);
    this.buf.copy(out, 0, 0, start);
    fresh.copy(out, start);
    this.buf.copy(out, start + fresh.length, end, used);
    for (const q of this.pairs) {
      if (INLINE.has(q.group)) continue;
      const v = out.readUInt32LE(q.pos + 4);
      if (v >= end && !(q.group === 'Bool64bitKey' && v === 0)) out.writeUInt32LE(v + delta, q.pos + 4);
    }
    return new SaveFile(out);
  }
}

module.exports = { SaveFile, gameDataList, GROUPS };
