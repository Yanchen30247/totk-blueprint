// TotK TexToGo (.txtg) textures: a "6PK0" container of zstd frames, one per mip level (and array layer), holding
// Tegra block-linear block data.
//   0x00 u16 header size (0x50), u16 version (0x11), "6PK0"
//   0x08 u16 width, u16 height, u16 depth/layers, u8 mip count (surface entries), u8 (2)
//   0x13 u8 usage (0 Mtl, 1 Alb, 3 Emm, 6 Spm, 10 Nrm ...), 0x14.. component mapping
//   0x3C u8 format: 2 BC1, 5 BC7?, 6 BC4, 7 BC5? (worked out from block sizes; see formatOf)
//   0x50 surface table: count x {u16 layer, u8 mip, u8 1}; then count x {u32 compressed size, u32 6}; then the frames
'use strict';
const zlib = require('zlib');

function parseTxtg(b) {
  if (b.toString('ascii', 4, 8) !== '6PK0') throw new Error('not a txtg');
  const width = b.readUInt16LE(8), height = b.readUInt16LE(10), depth = b.readUInt16LE(12);
  const count = b[0x0e];
  const surfaces = [];
  let o = 0x50;
  for (let i = 0; i < count; i++, o += 4) surfaces.push({ layer: b.readUInt16LE(o), mip: b[o + 2] });
  for (let i = 0; i < count; i++, o += 8) surfaces[i].csize = b.readUInt32LE(o);
  for (const s of surfaces) { s.offset = o; o += s.csize; }
  return { width, height, depth, usage: b[0x13], formatCode: b[0x3c], formatCode2: b[0x3d], swizzle: [...b.subarray(0x14, 0x18)], surfaces };
}

/** Raw (still block-linear) bytes of one surface. */
function surfaceData(b, s) {
  const chunk = b.subarray(s.offset, s.offset + s.csize);
  return chunk.readUInt32LE(0) === 0xfd2fb528 ? zlib.zstdDecompressSync(chunk) : Buffer.from(chunk);
}

// ---------- Tegra X1 block-linear ----------
// GOB = 64 bytes x 8 rows; a block is 1 GOB wide and 2^n GOBs high; blocks fill the surface row-major.
function gobOffset(x, y) {
  return ((x % 64) >> 5) * 256 + ((y % 8) >> 1) * 64 + ((x % 32) >> 4) * 32 + (y % 2) * 16 + (x % 16);
}

/** Block height (in GOBs) the hardware picks for a surface with `rows` block rows. */
function blockHeightFor(rows) {
  let bh = 1;
  while (bh < 16 && bh * 8 < rows) bh *= 2;
  return bh;
}

/** Block-linear -> linear for one surface of rowBytes x rows (rows of compressed blocks). */
function deswizzle(src, rowBytes, rows, blockHeight) {
  const out = Buffer.alloc(rowBytes * rows);
  const gobsX = Math.ceil(rowBytes / 64);
  const blockBytes = 512 * blockHeight;
  for (let y = 0; y < rows; y++) {
    const blockRow = Math.floor(y / (8 * blockHeight));
    const gobInBlock = Math.floor((y % (8 * blockHeight)) / 8);
    for (let x = 0; x < rowBytes; x += 16) {
      const off = blockRow * gobsX * blockBytes + Math.floor(x / 64) * blockBytes + gobInBlock * 512 + gobOffset(x, y);
      if (off + 16 <= src.length) src.copy(out, y * rowBytes + x, off, off + Math.min(16, rowBytes - x));
    }
  }
  return out;
}

module.exports = { parseTxtg, surfaceData, deswizzle, blockHeightFor };
