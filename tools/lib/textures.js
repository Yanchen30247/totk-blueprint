// Decode a TexToGo texture from the RomFS to a PNG in gamedata/library/textures (once per texture name).
'use strict';
const fs = require('fs');
const path = require('path');
const { parseTxtg, surfaceData, deswizzle, blockHeightFor } = require('./txtg');
const { decodeBlocks, writePng } = require('./bcn');

// txtg format code (byte 0x3C) -> block format; found by decoding known textures (see docs/formats.md)
const FORMATS = { 2: 'bc1', 5: 'bc3', 6: 'bc4', 7: 'bc5' };
const BLOCK_BYTES = { bc1: 8, bc4: 8, bc3: 16, bc5: 16 };
const MAX_SIZE = 512; // default upper bound; larger textures use a smaller mip

/** RGBA pixels of a texture's largest mip not wider or higher than maxSize; null when it cannot be decoded. */
function decodeTexture(romfs, name, maxSize = MAX_SIZE) {
  const p = `TexToGo/${name}.txtg`;
  if (!romfs.has(p)) return null;
  const b = romfs.raw(p);
  const t = parseTxtg(b);
  const format = FORMATS[t.formatCode];
  if (!format || t.depth !== 1) return null;
  let mip = 0;
  while (mip + 1 < t.surfaces.length && ((t.width >> mip) > maxSize || (t.height >> mip) > maxSize)) mip++;
  const surf = t.surfaces.find((s) => s.mip === mip && s.layer === 0);
  const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
  const rows = Math.ceil(h / 4), rowBytes = Math.ceil(w / 4) * BLOCK_BYTES[format];
  const linear = deswizzle(surfaceData(b, surf), rowBytes, rows, blockHeightFor(rows));
  return { rgba: decodeBlocks(linear, w, h, format), width: w, height: h, format };
}

function hasAlpha(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) return true;
  return false;
}

/**
 * PNG for a texture name; returns { file, width, height, alpha } or null when it cannot be decoded.
 * `alpha` is true when some texel is less than fully opaque.
 */
function buildTexture(romfs, name, outDir, cache, maxSize = MAX_SIZE) {
  if (cache.has(name)) return cache.get(name);
  let result = null;
  try {
    const t = decodeTexture(romfs, name, maxSize);
    if (t) {
      const file = path.join(outDir, name + '.png');
      if (!fs.existsSync(file)) fs.writeFileSync(file, writePng(t.rgba, t.width, t.height));
      result = { file: 'textures/' + name + '.png', width: t.width, height: t.height, alpha: hasAlpha(t.rgba), format: t.format };
    }
  } catch (e) {
    result = null;
  }
  cache.set(name, result);
  return result;
}

/**
 * An albedo with a separate opacity mask (`_Msk`, one channel: white solid, black cut out), as one RGBA PNG named
 * `<albedo>__Msk.png`. Grates, nets and Zonai lattices use this. Falls back to the plain albedo when the mask fails.
 */
function buildMaskedTexture(romfs, alb, msk, outDir, cache, maxSize = MAX_SIZE) {
  const key = alb + '__Msk';
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const a = decodeTexture(romfs, alb, maxSize);
    const m = decodeTexture(romfs, msk, maxSize);
    if (a && m) {
      const out = Buffer.from(a.rgba);
      // the mask can have its own size: sample it at the albedo texel's relative position
      for (let y = 0; y < a.height; y++) {
        const my = Math.min(m.height - 1, Math.floor((y + 0.5) * m.height / a.height));
        for (let x = 0; x < a.width; x++) {
          const mx = Math.min(m.width - 1, Math.floor((x + 0.5) * m.width / a.width));
          out[(y * a.width + x) * 4 + 3] = Math.min(out[(y * a.width + x) * 4 + 3], m.rgba[(my * m.width + mx) * 4]);
        }
      }
      const file = path.join(outDir, key + '.png');
      if (!fs.existsSync(file)) fs.writeFileSync(file, writePng(out, a.width, a.height));
      result = { file: 'textures/' + key + '.png', width: a.width, height: a.height, alpha: hasAlpha(out), format: a.format };
    }
  } catch (e) {
    result = null;
  }
  if (!result) result = buildTexture(romfs, alb, outDir, cache, maxSize);
  cache.set(key, result);
  return result;
}

module.exports = { buildTexture, buildMaskedTexture, decodeTexture, FORMATS };
