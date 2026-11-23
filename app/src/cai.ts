// The game's Autobuild blueprint format "CombinedActorInfo" (magic "CmbAct").
// Two sizes exist: 7840 bytes for the schematics in RomFS (Game/BluePrint/CombinedActorInfo/*.cai) and 6688 bytes for
// the entries of the Autobuild history in progress.sav. The 6688-byte form is the first 6688 bytes of the larger one.
//
//   0x0000 "CmbAct\0\0", u8 version (2), u8 part count, u8 bond count, u8 pad
//   0x000C 21 part records of 0x118 bytes:
//          +0x00 f32[12] main body pose, 3x4 row-major [R|t], metres, origin at the centre of the build's AABB
//          +0x30 f32[12] pose of sub body 1, +0x60 f32[12] pose of sub body 2 (identity when the part has none)
//          +0x90 f32 unknown (1.0 almost everywhere), +0x94 u32 0, +0x98 char[128] actor name
//   0x1704 21 bond records of 12 bytes: u32 body of A, u32 body of B, u8 part A, u8 part B, u16 pad
//   0x1800 f32[6] AABB (min, max), u8 flag (1)
//   0x181C..0x1A20 unknown, zero in every sample
//   RomFS form only: 0x1A20..0x1E84 unknown (zero), 0x1E84 f32[6] second AABB, u8 flag (1); ends at 0x1EA0
import type { Mat34 } from './types.ts';
import { IDENTITY } from './math.ts';
import { tr } from './i18n.ts';

export const MAX_PARTS = 21;
export const MAX_BONDS = 21;
export const SIZE_ROMFS = 7840;
export const SIZE_SAVE = 6688;
const REC = 0x118;
const PARTS_AT = 0x0c;
const BONDS_AT = PARTS_AT + MAX_PARTS * REC; // 0x1704
const AABB_AT = BONDS_AT + MAX_BONDS * 12; // 0x1800
const AABB2_AT = 0x1e84;

export interface CaiPart {
  actor: string;
  pose: Mat34;
  pose2: Mat34;
  pose3: Mat34;
  unk90: number;
}
export interface CaiBond {
  a: number;
  b: number;
  aBody: number;
  bBody: number;
}
export interface Cai {
  version: number;
  parts: CaiPart[];
  bonds: CaiBond[];
  aabb: number[];
  aabb2: number[] | null;
}

function readMat(dv: DataView, o: number): Mat34 {
  const m = new Array(12);
  for (let i = 0; i < 12; i++) m[i] = dv.getFloat32(o + i * 4, true);
  return m;
}
function writeMat(dv: DataView, o: number, m: Mat34) {
  for (let i = 0; i < 12; i++) dv.setFloat32(o + i * 4, m[i], true);
}

export function parseCai(bytes: Uint8Array): Cai {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'CmbAct') throw new Error(tr('不是 CmbAct 格式的蓝图', 'not a CmbAct blueprint'));
  if (bytes.length < SIZE_SAVE) throw new Error(tr(`蓝图文件太短（${bytes.length} 字节）`, `blueprint file too short (${bytes.length} bytes)`));
  const n = bytes[9];
  const nb = bytes[10];
  if (n > MAX_PARTS || nb > MAX_BONDS) throw new Error(tr('零件或粘合数量超过上限', 'too many parts or bonds'));
  const parts: CaiPart[] = [];
  for (let i = 0; i < n; i++) {
    const o = PARTS_AT + i * REC;
    let e = o + 0x98;
    while (e < o + REC && bytes[e] !== 0) e++;
    parts.push({
      actor: new TextDecoder('ascii').decode(bytes.subarray(o + 0x98, e)),
      pose: readMat(dv, o),
      pose2: readMat(dv, o + 0x30),
      pose3: readMat(dv, o + 0x60),
      unk90: dv.getFloat32(o + 0x90, true),
    });
  }
  const bonds: CaiBond[] = [];
  for (let i = 0; i < nb; i++) {
    const o = BONDS_AT + i * 12;
    bonds.push({ aBody: dv.getUint32(o, true), bBody: dv.getUint32(o + 4, true), a: bytes[o + 8], b: bytes[o + 9] });
  }
  const aabb = [0, 1, 2, 3, 4, 5].map((k) => dv.getFloat32(AABB_AT + k * 4, true));
  const aabb2 = bytes.length >= SIZE_ROMFS ? [0, 1, 2, 3, 4, 5].map((k) => dv.getFloat32(AABB2_AT + k * 4, true)) : null;
  return { version: bytes[8], parts, bonds, aabb, aabb2 };
}

export function writeCai(cai: Cai, form: 'romfs' | 'save'): Uint8Array {
  if (cai.parts.length > MAX_PARTS) throw new Error(tr(`零件最多 ${MAX_PARTS} 个`, `at most ${MAX_PARTS} parts`));
  if (cai.bonds.length > MAX_BONDS) throw new Error(tr(`粘合最多 ${MAX_BONDS} 条`, `at most ${MAX_BONDS} bonds`));
  const bytes = new Uint8Array(form === 'romfs' ? SIZE_ROMFS : SIZE_SAVE);
  const dv = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('CmbAct'), 0);
  bytes[8] = 2;
  bytes[9] = cai.parts.length;
  bytes[10] = cai.bonds.length;
  // Unused part slots hold identity poses in the game's files.
  for (let i = 0; i < MAX_PARTS; i++) {
    const o = PARTS_AT + i * REC;
    const p = cai.parts[i];
    writeMat(dv, o, p ? p.pose : IDENTITY);
    writeMat(dv, o + 0x30, p ? p.pose2 : IDENTITY);
    writeMat(dv, o + 0x60, p ? p.pose3 : IDENTITY);
    dv.setFloat32(o + 0x90, p ? p.unk90 : 1, true);
    if (p) {
      const name = new TextEncoder().encode(p.actor);
      if (name.length >= 128) throw new Error(tr('actor 名太长：', 'actor name too long: ') + p.actor);
      bytes.set(name, o + 0x98);
    }
  }
  cai.bonds.forEach((b, i) => {
    const o = BONDS_AT + i * 12;
    dv.setUint32(o, b.aBody, true);
    dv.setUint32(o + 4, b.bBody, true);
    bytes[o + 8] = b.a;
    bytes[o + 9] = b.b;
  });
  for (let k = 0; k < 6; k++) dv.setFloat32(AABB_AT + k * 4, cai.aabb[k], true);
  bytes[AABB_AT + 24] = 1;
  if (form === 'romfs') {
    const a2 = cai.aabb2 || cai.aabb;
    for (let k = 0; k < 6; k++) dv.setFloat32(AABB2_AT + k * 4, a2[k], true);
    bytes[AABB2_AT + 24] = 1;
  }
  return bytes;
}
