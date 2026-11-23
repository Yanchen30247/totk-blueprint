// Minimal MSBT reader: label -> text (UTF-16LE). Control tags (0x0E ...) are dropped.
'use strict';

function parseMsbt(b) {
  if (b.toString('ascii', 0, 8) !== 'MsgStdBn') throw new Error('not MSBT');
  const le = b[8] === 0xFF && b[9] === 0xFE;
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const nsec = u16(0x0E);
  let o = 0x20;
  let labels = [];
  let texts = [];
  for (let s = 0; s < nsec; s++) {
    const magic = b.toString('ascii', o, o + 4);
    const size = u32(o + 4);
    const d = o + 0x10;
    if (magic === 'LBL1') {
      const groups = u32(d);
      for (let g = 0; g < groups; g++) {
        const n = u32(d + 4 + g * 8);
        let p = d + u32(d + 8 + g * 8);
        for (let i = 0; i < n; i++) {
          const len = b[p];
          const name = b.toString('ascii', p + 1, p + 1 + len);
          const idx = u32(p + 1 + len);
          labels.push([name, idx]);
          p += 1 + len + 4;
        }
      }
    } else if (magic === 'TXT2') {
      const n = u32(d);
      for (let i = 0; i < n; i++) {
        const start = d + u32(d + 4 + i * 4);
        const end = i + 1 < n ? d + u32(d + 8 + i * 4) : d + size;
        let s2 = '';
        for (let p = start; p + 1 < end; p += 2) {
          const c = u16(p);
          if (c === 0) break;
          if (c === 0x0E) { // tag: group, type, param size, params
            const psize = u16(p + 6);
            p += 6 + psize;
            continue;
          }
          if (c === 0x0F) { p += 4; continue; }
          s2 += String.fromCharCode(c);
        }
        texts.push(s2);
      }
    }
    o = d + ((size + 15) & ~15);
  }
  const out = {};
  for (const [name, idx] of labels) out[name] = texts[idx];
  return out;
}

module.exports = { parseMsbt };
