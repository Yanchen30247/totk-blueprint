// Minimal SARC reader (little endian, as used by TotK).
'use strict';

function parseSarc(buf) {
  if (buf.toString('ascii', 0, 4) !== 'SARC') throw new Error('not SARC');
  const bom = buf.readUInt16LE(6);
  const le = bom === 0xFEFF;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const hdrLen = u16(4);
  const dataStart = u32(0x0C);
  let o = hdrLen; // SFAT
  if (buf.toString('ascii', o, o + 4) !== 'SFAT') throw new Error('no SFAT');
  const sfatHdr = u16(o + 4);
  const count = u16(o + 6);
  const nodes = [];
  let n = o + sfatHdr;
  for (let i = 0; i < count; i++, n += 16) {
    nodes.push({ hash: u32(n), attr: u32(n + 4), start: u32(n + 8), end: u32(n + 12) });
  }
  const sfnt = n;
  if (buf.toString('ascii', sfnt, sfnt + 4) !== 'SFNT') throw new Error('no SFNT');
  const namesStart = sfnt + u16(sfnt + 4);
  const out = new Map();
  for (const nd of nodes) {
    let name = null;
    if (nd.attr & 0x01000000) {
      const off = namesStart + (nd.attr & 0xFFFF) * 4;
      let e = off;
      while (buf[e] !== 0) e++;
      name = buf.toString('utf8', off, e);
    } else {
      name = '0x' + nd.hash.toString(16);
    }
    out.set(name, buf.subarray(dataStart + nd.start, dataStart + nd.end));
  }
  return out;
}

module.exports = { parseSarc };
