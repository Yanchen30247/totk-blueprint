// Skeletal animations (FSKA) from a Switch BFRES animation file (Model/<project>.anim.bfres.zs), enough to read where
// an animation starts and ends for each animated bone channel. Layout (BFRES 0.10, read from SpObj_SwitchWheel_B):
//   FSKA  +0x08 name, +0x28 bone anim array, +0x40 frame count, +0x44 curve count, +0x4C bone anim count (u16)
//   bone anim (0x38 bytes)  +0x00 name, +0x08 curves, +0x10 base data, +0x28 flags (bit 3 scale, 4 rotate, 5 translate
//                           present in the base data), +0x2E curve count
//   curve (0x30 bytes)      +0x00 frames, +0x08 keys, +0x10 flags (bits 0-1 frame type, 2-3 key type, 4-6 curve type),
//                           +0x12 key count, +0x14 target (0x04..0x0C scale, 0x10..0x18 translate, 0x20.. rotate),
//                           +0x18 start frame, +0x1C end frame, +0x20 scale, +0x24 offset
'use strict';

const str = (b, o) => (o ? b.toString('utf8', o + 2, o + 2 + b.readUInt16LE(o)) : '');

function readCurve(b, c) {
  const frames = b.readUInt32LE(c), keys = b.readUInt32LE(c + 8);
  const flags = b.readUInt16LE(c + 0x10), count = b.readUInt16LE(c + 0x12), target = b.readUInt32LE(c + 0x14);
  const scale = b.readFloatLE(c + 0x20), offset = b.readFloatLE(c + 0x24);
  const keyType = (flags >> 2) & 3, curveType = (flags >> 4) & 7;
  const per = curveType === 0 ? 4 : curveType === 1 ? 2 : 1; // cubic: 4 coefficients per key, linear: 2, baked: 1
  const key = (j) => (keyType === 0 ? b.readFloatLE(keys + j * 4) : keyType === 1 ? b.readInt16LE(keys + j * 2) : b.readInt8(keys + j));
  const frameType = flags & 3;
  const frame = (j) => (frameType === 0 ? b.readFloatLE(frames + j * 4) : frameType === 1 ? b.readInt16LE(frames + j * 2) / 32 : b[frames + j]);
  // value at the first key, and at the end of the last segment (the coefficients of a segment sum to its end value)
  let last = 0;
  for (let k = 0; k < per; k++) last += key((count - 1) * per + k);
  if (per === 1) last = key(count - 1);
  return { target, keys: count, firstFrame: frame(0), lastFrame: frame(count - 1), start: key(0) * scale + offset, end: last * scale + offset };
}

/** [{ name, frames, bones: [{ name, base: { s, r, t }, curves: [{ target, start, end }] }] }] */
function parseSkeletalAnims(b) {
  if (b.toString('ascii', 0, 4) !== 'FRES') throw new Error('not FRES');
  const out = [];
  for (let a = b.indexOf('FSKA'); a >= 0; a = b.indexOf('FSKA', a + 4)) {
    if (a % 8) continue;
    const arr = b.readUInt32LE(a + 0x28), nBone = b.readUInt16LE(a + 0x4c);
    const anim = { name: str(b, b.readUInt32LE(a + 8)), frames: b.readInt32LE(a + 0x40), bones: [] };
    for (let i = 0; i < nBone; i++) {
      const o = arr + i * 0x38;
      const flags = b.readUInt32LE(o + 0x28), nc = b[o + 0x2e];
      let p = b.readUInt32LE(o + 0x10);
      const base = {};
      if (flags & 8) { base.s = [0, 4, 8].map((k) => b.readFloatLE(p + k)); p += 12; }
      if (flags & 16) { base.r = [0, 4, 8, 12].map((k) => b.readFloatLE(p + k)); p += 16; }
      if (flags & 32) { base.t = [0, 4, 8].map((k) => b.readFloatLE(p + k)); p += 12; }
      const curves = [];
      const co = b.readUInt32LE(o + 8);
      for (let k = 0; k < nc; k++) curves.push(readCurve(b, co + k * 0x30));
      anim.bones.push({ name: str(b, b.readUInt32LE(o)), base, curves });
    }
    out.push(anim);
  }
  return out;
}

/**
 * Axles that the game pulls into the part on the side that is not glued: animations named *_LeftIn / *_RightIn that
 * move one bone. Returns [{ side: 'L' | 'R', bone, delta: [x, y, z] }] with delta in the bone's parent frame.
 */
function retractions(anims) {
  const out = [];
  for (const a of anims) {
    const m = a.name.match(/_(Left|Right)In$/);
    if (!m) continue;
    const moving = a.bones.filter((bn) => bn.curves.some((c) => c.target >= 0x10 && c.target <= 0x18));
    if (moving.length !== 1) continue;
    const delta = [0, 0, 0];
    for (const c of moving[0].curves) if (c.target >= 0x10 && c.target <= 0x18) delta[(c.target - 0x10) / 4] = c.end - c.start;
    out.push({ side: m[1][0], bone: moving[0].name, delta });
  }
  return out;
}

module.exports = { parseSkeletalAnims, retractions };
