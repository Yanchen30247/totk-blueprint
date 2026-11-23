// BYML reader (versions 2-7, little and big endian) covering the node types TotK uses.
'use strict';

function parseByml(buf) {
  const magic = buf.toString('ascii', 0, 2);
  const le = magic === 'YB';
  if (!le && magic !== 'BY') throw new Error('not BYML');
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u24 = (o) => (le ? buf.readUIntLE(o, 3) : buf.readUIntBE(o, 3));
  const i32 = (o) => (le ? buf.readInt32LE(o) : buf.readInt32BE(o));
  const f32 = (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const i64 = (o) => (le ? buf.readBigInt64LE(o) : buf.readBigInt64BE(o));
  const u64 = (o) => (le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const version = u16(2);
  const keyTableOff = u32(4);
  const strTableOff = u32(8);
  const rootOff = u32(12);

  const readStrTable = (off) => {
    if (!off) return [];
    if (buf[off] !== 0xC2) throw new Error('bad string table');
    const n = u24(off + 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = off + u32(off + 4 + i * 4);
      let e = s;
      while (buf[e] !== 0) e++;
      out[i] = buf.toString('utf8', s, e);
    }
    return out;
  };
  const keys = readStrTable(keyTableOff);
  const strs = readStrTable(strTableOff);

  const big = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

  const value = (type, raw) => {
    switch (type) {
      case 0xA0: return strs[raw];
      case 0xA1: { const n = u32(raw); return { $binary: buf.subarray(raw + 4, raw + 4 + n).toString('hex') }; }
      case 0xA2: { const n = u32(raw); return { $file: buf.subarray(raw + 8, raw + 8 + n).toString('hex') }; }
      case 0xC0: case 0xC1: case 0x20: case 0x21: return node(raw);
      case 0xD0: return raw !== 0;
      case 0xD1: return raw | 0;
      case 0xD2: { const b = Buffer.alloc(4); le ? b.writeUInt32LE(raw) : b.writeUInt32BE(raw); return le ? b.readFloatLE(0) : b.readFloatBE(0); }
      case 0xD3: return raw >>> 0;
      case 0xD4: return big(i64(raw));
      case 0xD5: return big(u64(raw));
      case 0xD6: return f64(raw);
      case 0xFF: return null;
      default: return { $unknownType: type, raw };
    }
  };

  const node = (off) => {
    const t = buf[off];
    const n = u24(off + 1);
    if (t === 0xC0) {
      const arr = new Array(n);
      const vals = off + 4 + ((n + 3) & ~3);
      for (let i = 0; i < n; i++) arr[i] = value(buf[off + 4 + i], u32(vals + i * 4));
      return arr;
    }
    if (t === 0xC1) {
      const obj = {};
      for (let i = 0; i < n; i++) {
        const e = off + 4 + i * 8;
        obj[keys[u24(e)]] = value(buf[e + 3], u32(e + 4));
      }
      return obj;
    }
    if (t === 0x20 || t === 0x21) {
      // Hash-keyed dictionaries (BYML v7): entries {hash, value}, then one type byte per entry.
      const es = t === 0x20 ? 8 : 12;
      const types = off + 4 + n * es;
      const obj = {};
      for (let i = 0; i < n; i++) {
        const e = off + 4 + i * es;
        const h = t === 0x20 ? u32(e).toString(16).padStart(8, '0') : u64(e).toString(16).padStart(16, '0');
        obj['#' + h] = value(buf[types + i], u32(e + (t === 0x20 ? 4 : 8)));
      }
      return obj;
    }
    return value(t, u32(off));
  };

  return { version, root: rootOff ? node(rootOff) : null };
}

module.exports = { parseByml };
