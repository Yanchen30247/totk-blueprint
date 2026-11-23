// Reader for the game's Autobuild blueprint format "CombinedActorInfo" (.cai, magic "CmbAct").
// Layout as far as verified against the 46 schematics in RomFS (Game/BluePrint/CombinedActorInfo):
//   0x000  char[8]  "CmbAct\0\0"
//   0x008  u8       version (2)
//   0x009  u8       part count (<= 21)
//   0x00A  u8       bond count
//   0x00B  u8       padding
//   0x00C  21 x 0x118 part records:
//          +0x00 f32[12] main body pose, 3x4 row-major (rotation | translation), metres, relative to the build
//          +0x30 f32[12] second body pose (multi-body parts such as wheels; identity when unused)
//          +0x60 f32[12] third body pose (identity when unused)
//          +0x90 f32     unknown (1.0; 1.25 seen on Weapon_Sword_043)
//          +0x94 u32     unknown (0)
//          +0x98 char[128] actor name
//   0x1704 21 x 12 bond records: u32 a0, u32 a1 (unknown, mostly 0), u8 partA, u8 partB, u16 padding
//   0x1800 f32[6]   AABB min/max of the build, then u8 flag + padding
//   0x181C..0x1E84  unknown (zero in every RomFS schematic apart from padding bytes)
//   0x1E84 f32[6]   second AABB, then u8 flag + padding; file size 0x1EA0 (7840)
'use strict';

const MAX_PARTS = 21;
const REC = 0x118;

function mat34(b, o) {
  const m = [];
  for (let i = 0; i < 12; i++) m.push(b.readFloatLE(o + i * 4));
  return m;
}

function parseCai(b) {
  if (b.toString('ascii', 0, 6) !== 'CmbAct') throw new Error('not a CmbAct file');
  const out = { version: b[8], parts: [], bonds: [], size: b.length };
  const n = b[9];
  const nb = b[10];
  for (let i = 0; i < n; i++) {
    const o = 0x0C + i * REC;
    let e = o + 0x98;
    while (b[e] !== 0 && e < o + REC) e++;
    out.parts.push({
      actor: b.toString('ascii', o + 0x98, e),
      pose: mat34(b, o),
      pose2: mat34(b, o + 0x30),
      pose3: mat34(b, o + 0x60),
      unk90: b.readFloatLE(o + 0x90),
      unk94: b.readUInt32LE(o + 0x94),
    });
  }
  const bo = 0x0C + MAX_PARTS * REC;
  for (let i = 0; i < nb; i++) {
    const o = bo + i * 12;
    out.bonds.push({ a: b[o + 8], b: b[o + 9], u0: b.readUInt32LE(o), u1: b.readUInt32LE(o + 4) });
  }
  const ab = bo + MAX_PARTS * 12;
  out.aabb = [0, 1, 2, 3, 4, 5].map((k) => b.readFloatLE(ab + k * 4));
  out.aabb2 = [0, 1, 2, 3, 4, 5].map((k) => b.readFloatLE(0x1E84 + k * 4));
  return out;
}

module.exports = { parseCai, MAX_PARTS };
