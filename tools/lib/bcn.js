// Block-compressed texture decoders (BC1, BC3, BC4, BC5, BC7) to RGBA8, and a PNG writer.
// Written from the public format descriptions (Microsoft BC1-BC7 documentation); no third-party code.
'use strict';
const zlib = require('zlib');

const out565 = (c) => [((c >> 11) & 31) * 255 / 31 + 0.5 | 0, ((c >> 5) & 63) * 255 / 63 + 0.5 | 0, (c & 31) * 255 / 31 + 0.5 | 0];

/** One BC1 colour block (8 bytes) -> 16 RGBA texels. alphaCut: 3-colour mode gives transparent black for index 3. */
function bc1Block(b, o, px, alphaCut = true, forceFour = false) {
  const c0 = b.readUInt16LE(o), c1 = b.readUInt16LE(o + 2);
  const a = out565(c0), c = out565(c1);
  const pal = [a.concat(255), c.concat(255)];
  if (c0 > c1 || forceFour) {
    pal.push([0, 1, 2].map((k) => (2 * a[k] + c[k] + 1) / 3 | 0).concat(255), [0, 1, 2].map((k) => (a[k] + 2 * c[k] + 1) / 3 | 0).concat(255));
  } else {
    pal.push([0, 1, 2].map((k) => (a[k] + c[k]) >> 1).concat(255), alphaCut ? [0, 0, 0, 0] : [0, 0, 0, 255]);
  }
  const bits = b.readUInt32LE(o + 4);
  for (let i = 0; i < 16; i++) { const p = pal[(bits >>> (2 * i)) & 3]; px[i * 4] = p[0]; px[i * 4 + 1] = p[1]; px[i * 4 + 2] = p[2]; px[i * 4 + 3] = p[3]; }
}

/** One BC4 channel block (8 bytes) -> 16 values. */
function bc4Block(b, o, vals, signed = false) {
  let e0 = b[o], e1 = b[o + 1];
  if (signed) { e0 = (e0 << 24 >> 24) + 128; e1 = (e1 << 24 >> 24) + 128; }
  const pal = [e0, e1];
  if (e0 > e1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * e0 + i * e1 + 3) / 7 | 0);
  else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * e0 + i * e1 + 2) / 5 | 0); pal.push(0, 255); }
  // 48 bits of 3-bit indices
  let lo = b.readUInt32LE(o + 2), hi = b.readUInt16LE(o + 6);
  for (let i = 0; i < 16; i++) {
    const bit = 3 * i;
    let idx;
    if (bit + 3 <= 32) idx = (lo >>> bit) & 7;
    else if (bit >= 32) idx = (hi >>> (bit - 32)) & 7;
    else idx = ((lo >>> bit) | (hi << (32 - bit))) & 7;
    vals[i] = pal[idx];
  }
}

// ---------- BC7 ----------
const P2 = [0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80, 0xC800, 0xFFEC, 0xFE80, 0xE800, 0xFFE8, 0xFF00, 0xFFF0, 0xF000, 0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE, 0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C, 0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660, 0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22];
const P3 = [
  [0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2], [0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1], [0, 0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1], [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2], [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2], [0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2], [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2], [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2], [0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2],
  [0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2], [0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2], [0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 2, 2], [0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0],
  [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2], [0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0], [0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2], [0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1],
  [0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 2, 2, 2], [0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1], [0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2], [0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0],
  [0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0], [0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2], [0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 1, 1, 0], [0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1],
  [0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0, 2, 2], [0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2], [0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1], [0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1],
  [0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2], [0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1], [0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2], [0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0],
  [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0], [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0], [0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0], [0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1],
  [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1], [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1], [0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2],
  [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1], [0, 2, 2, 0, 1, 2, 2, 1, 0, 2, 2, 0, 1, 2, 2, 1], [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1], [0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2], [0, 2, 2, 2, 0, 1, 1, 1, 0, 2, 2, 2, 0, 1, 1, 1], [0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2], [0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2],
  [0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2], [0, 0, 0, 2, 1, 1, 1, 2, 1, 1, 1, 2, 0, 0, 0, 2], [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2],
  [0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2], [0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2], [0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2],
  [0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1], [0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2], [0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], [0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0],
];
const A2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const A3a = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const A3b = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const W2 = [0, 21, 43, 64], W3 = [0, 9, 18, 27, 37, 46, 55, 64], W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const MODES = [
  { ns: 3, pb: 4, rb: 0, isb: 0, cb: 4, ab: 0, epb: 1, spb: 0, ib: 3, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 6, ab: 0, epb: 0, spb: 1, ib: 3, ib2: 0 },
  { ns: 3, pb: 6, rb: 0, isb: 0, cb: 5, ab: 0, epb: 0, spb: 0, ib: 2, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 7, ab: 0, epb: 1, spb: 0, ib: 2, ib2: 0 },
  { ns: 1, pb: 0, rb: 2, isb: 1, cb: 5, ab: 6, epb: 0, spb: 0, ib: 2, ib2: 3 },
  { ns: 1, pb: 0, rb: 2, isb: 0, cb: 7, ab: 8, epb: 0, spb: 0, ib: 2, ib2: 2 },
  { ns: 1, pb: 0, rb: 0, isb: 0, cb: 7, ab: 7, epb: 1, spb: 0, ib: 4, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 5, ab: 5, epb: 1, spb: 0, ib: 2, ib2: 0 },
];
const wtab = (bits) => (bits === 2 ? W2 : bits === 3 ? W3 : W4);

function bc7Block(b, o, px) {
  let pos = 0;
  const bit = (n) => { let v = 0; for (let i = 0; i < n; i++, pos++) v |= ((b[o + (pos >> 3)] >> (pos & 7)) & 1) << i; return v; };
  let mode = 0;
  while (mode < 8 && !bit(1)) mode++;
  if (mode === 8) { for (let i = 0; i < 64; i++) px[i] = 0; return; }
  const m = MODES[mode];
  const part = bit(m.pb), rot = bit(m.rb), isel = bit(m.isb);
  const ns = m.ns;
  const ep = [];
  for (let s = 0; s < ns * 2; s++) ep.push([0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) for (let s = 0; s < ns * 2; s++) ep[s][c] = bit(m.cb);
  if (m.ab) for (let s = 0; s < ns * 2; s++) ep[s][3] = bit(m.ab);
  let cbits = m.cb, abits = m.ab;
  if (m.epb) { for (let s = 0; s < ns * 2; s++) { const p = bit(1); for (let c = 0; c < 4; c++) ep[s][c] = (ep[s][c] << 1) | p; } cbits++; if (abits) abits++; }
  if (m.spb) { for (let s = 0; s < ns; s++) { const p = bit(1); for (const e of [ep[2 * s], ep[2 * s + 1]]) for (let c = 0; c < 4; c++) e[c] = (e[c] << 1) | p; } cbits++; if (abits) abits++; }
  for (const e of ep) {
    for (let c = 0; c < 3; c++) e[c] = (e[c] << (8 - cbits)) | (e[c] >> (2 * cbits - 8));
    if (abits) e[3] = (e[3] << (8 - abits)) | (e[3] >> (2 * abits - 8)); else e[3] = 255;
  }
  const subset = (i) => (ns === 1 ? 0 : ns === 2 ? (P2[part] >> i) & 1 : P3[part][i]);
  const anchor = (s) => (s === 0 ? 0 : ns === 2 ? A2[part] : s === 1 ? A3a[part] : A3b[part]);
  const idx1 = new Array(16), idx2 = new Array(16);
  for (let i = 0; i < 16; i++) { const s = subset(i); idx1[i] = bit(i === anchor(s) ? m.ib - 1 : m.ib); }
  if (m.ib2) for (let i = 0; i < 16; i++) idx2[i] = bit(i === 0 ? m.ib2 - 1 : m.ib2);
  for (let i = 0; i < 16; i++) {
    const s = subset(i);
    const e0 = ep[2 * s], e1 = ep[2 * s + 1];
    let ci, ai, cw, aw;
    if (m.ib2) { if (isel) { ci = idx2[i]; ai = idx1[i]; cw = wtab(m.ib2); aw = wtab(m.ib); } else { ci = idx1[i]; ai = idx2[i]; cw = wtab(m.ib); aw = wtab(m.ib2); } }
    else { ci = ai = idx1[i]; cw = aw = wtab(m.ib); }
    const out = [0, 1, 2].map((c) => ((64 - cw[ci]) * e0[c] + cw[ci] * e1[c] + 32) >> 6);
    out.push(((64 - aw[ai]) * e0[3] + aw[ai] * e1[3] + 32) >> 6);
    if (rot === 1) [out[0], out[3]] = [out[3], out[0]];
    else if (rot === 2) [out[1], out[3]] = [out[3], out[1]];
    else if (rot === 3) [out[2], out[3]] = [out[3], out[2]];
    px.set(out, i * 4);
  }
}

/**
 * Decode linear block data (blocks row-major) to RGBA8. format: 'bc1' | 'bc3' | 'bc4' | 'bc5' | 'bc7'.
 * bc4 expands to grey, bc5 to (R, G, normal Z, 255).
 */
function decodeBlocks(data, width, height, format) {
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const bytes = format === 'bc1' || format === 'bc4' ? 8 : 16;
  const out = Buffer.alloc(width * height * 4);
  const px = new Uint8Array(64), v1 = new Array(16), v2 = new Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * bytes;
      if (o + bytes > data.length) continue;
      switch (format) {
        case 'bc1': bc1Block(data, o, px); break;
        case 'bc3': bc1Block(data, o + 8, px, false, true); bc4Block(data, o, v1); for (let i = 0; i < 16; i++) px[i * 4 + 3] = v1[i]; break;
        case 'bc4': bc4Block(data, o, v1); for (let i = 0; i < 16; i++) px.set([v1[i], v1[i], v1[i], 255], i * 4); break;
        case 'bc5': bc4Block(data, o, v1); bc4Block(data, o + 8, v2); for (let i = 0; i < 16; i++) {
          const x = v1[i] / 127.5 - 1, y = v2[i] / 127.5 - 1, z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
          px.set([v1[i], v2[i], (z * 127.5 + 127.5) | 0, 255], i * 4);
        } break;
        case 'bc7': bc7Block(data, o, px); break;
        default: throw new Error('format ' + format);
      }
      for (let y = 0; y < 4; y++) {
        const yy = by * 4 + y;
        if (yy >= height) break;
        for (let x = 0; x < 4; x++) {
          const xx = bx * 4 + x;
          if (xx >= width) break;
          const d = (yy * width + xx) * 4, s = (y * 4 + x) * 4;
          out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
        }
      }
    }
  }
  return out;
}

// ---------- PNG ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const x of buf) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodeBlocks, writePng };
