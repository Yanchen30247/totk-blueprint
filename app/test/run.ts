// Checks for the format and math code, run with `npm test` (Node 24, type stripping).
// Uses the local library (gamedata/library, built by tools/build_library.js); nothing here touches the game install.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { parseCai, writeCai, SIZE_ROMFS, SIZE_SAVE } from '../src/cai.ts';
import { rotZYX, eulerZYX, maxDiff, mul, inv, apply, applyDir, pose } from '../src/math.ts';
import { PartIndex, caiToBlueprint, blueprintToCai, validate, stats, snapPose, pivotWorld, blueprintAabb, surfaceAnchor, snapToAnchor, quantizeOnFace, measureBond, partTilt, partSize, partCom, partLocalBounds, alignments, groupCentre, transformParts, rotationAbout, duplicateParts, alignParts, distributeParts, bondNearest, removeBondsWithin, partAabb, axleOffsets } from '../src/blueprint.ts';
import type { Draft, Library, Vec3 } from '../src/types.ts';
import { nearestBodies, fixBondBodies, axleBondSides, misplacedBondBodies } from '../src/contact.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(here, '..', '..', 'gamedata', 'library');
let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) { failures++; console.log('FAIL ' + msg); }
};

// 1. Euler convention against three.js ('ZYX' in three.js is the matrix Rz * Ry * Rx).
{
  let worst = 0, worstRound = 0;
  for (let i = 0; i < 500; i++) {
    const e: Vec3 = [Math.random() * 360 - 180, Math.random() * 170 - 85, Math.random() * 360 - 180];
    const m = rotZYX(e);
    const t = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(e.map((x) => THREE.MathUtils.degToRad(x)) as Vec3), 'ZYX')).elements;
    const tm = [t[0], t[4], t[8], 0, t[1], t[5], t[9], 0, t[2], t[6], t[10], 0];
    worst = Math.max(worst, maxDiff(m, tm));
    worstRound = Math.max(worstRound, maxDiff(rotZYX(eulerZYX(m)), m));
  }
  check(worst < 1e-9, `rotZYX matches three.js ZYX (max diff ${worst})`);
  check(worstRound < 1e-9, `eulerZYX round trip (max diff ${worstRound})`);
  const g = eulerZYX(rotZYX([30, 90, 10]));
  check(maxDiff(rotZYX(g), rotZYX([30, 90, 10])) < 1e-9, 'eulerZYX at gimbal lock');
}

if (!existsSync(path.join(LIB, 'library.json'))) {
  console.log('gamedata/library/library.json is missing: run `node tools/build_library.js` first.');
  process.exit(failures ? 1 : 0);
}
const lib: Library = JSON.parse(readFileSync(path.join(LIB, 'library.json'), 'utf8'));
const drafts: Draft[] = JSON.parse(readFileSync(path.join(LIB, 'drafts.json'), 'utf8'));
const idx = new PartIndex(lib);

// 2. The 46 schematics: byte round trip, blueprint round trip, checks.
{
  let fieldOk = 0, poseWorst = 0, aabbWorst = 0;
  const bondKey = (b: { a: number; b: number; aBody: number; bBody: number }) => `${b.a}/${b.aBody}-${b.b}/${b.bBody}`;
  for (const d of drafts) {
    const raw = new Uint8Array(Buffer.from(d.cai, 'base64'));
    const cai = parseCai(raw);
    // Field round trip. Byte equality is not expected: the game's files carry 0xCD fill (uninitialised memory) in padding
    // and stale bytes after the NUL of actor names.
    const again = parseCai(writeCai(cai, 'romfs'));
    const same = JSON.stringify(again) === JSON.stringify(cai);
    if (same) fieldOk++;
    else console.log(`  ${d.id}: fields differ after rewrite`);
    // The regions whose meaning is unknown must hold nothing but zero or 0xCD, or a rewrite would drop data.
    const unknownBytes = [...raw.subarray(0x181c, 0x1e84)].filter((x, i) => x !== 0 && x !== 0xcd && !(i === 0 && x === 1)).length;
    check(unknownBytes === 0, `${d.id}: unknown regions are empty (${unknownBytes} bytes set)`);
    const bp = caiToBlueprint(cai, d.name);
    const back = blueprintToCai(bp, idx);
    // The centre may move (our AABB is computed from collision shapes); compare poses relative to part 0.
    const r0 = inv(cai.parts[0].pose), b0 = inv(back.parts[0].pose);
    cai.parts.forEach((p, i) => { poseWorst = Math.max(poseWorst, maxDiff(mul(r0, p.pose), mul(b0, back.parts[i].pose))); });
    check(back.bonds.map(bondKey).join() === cai.bonds.map(bondKey).join(), `${d.id}: bonds survive the round trip`);
    const box = blueprintAabb(bp, idx);
    const half = [0, 1, 2].map((k) => (box[k + 3] - box[k]) / 2);
    aabbWorst = Math.max(aabbWorst, ...half.map((h, k) => Math.abs(h - cai.aabb[k + 3])));
    const errs = validate(bp, idx).filter((x) => x.level === 'error');
    check(errs.length === 0, `${d.id}: no validation errors (${errs.map((e) => e.text).join('; ')})`);
  }
  console.log(`schematics: ${fieldOk}/${drafts.length} identical after rewrite; worst relative pose error ${poseWorst.toExponential(2)}; worst AABB half-extent difference to the game's ${aabbWorst.toFixed(3)} m`);
  check(fieldOk === drafts.length, 'all schematics survive a rewrite field for field');
  check(poseWorst < 2e-4, 'blueprint round trip keeps relative poses');
}

// 3. The Autobuild history form (6688 bytes) from a save copy, when one is given.
{
  const blob = process.env.TOTK_LOG_BLOB;
  if (blob && existsSync(blob)) {
    const raw = new Uint8Array(readFileSync(blob));
    check(raw.length === SIZE_SAVE, `history entry is ${SIZE_SAVE} bytes`);
    const cai = parseCai(raw);
    const out = writeCai(cai, 'save');
    let diffs = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] !== out[i]) diffs++;
    check(diffs === 0, `history entry rewrites byte-identical (${diffs} bytes differ)`);
    const st = stats(caiToBlueprint(cai, 'log'), idx);
    console.log(`history entry: ${cai.parts.map((p) => p.actor).join(', ')}; mass ${st.mass}; bonds ${cai.bonds.length}`);
  }
}

// 4. Snapping puts the two pivots on each other with opposite outward directions.
{
  const plank = idx.get('AsbObj_WoodRectangle_A_M_01')!, fan = idx.get('SpObj_WindGenerator_A_01')!;
  const target = { id: 't', actor: plank.actor, pos: [1, 2, 3] as Vec3, rotDeg: [10, 20, 30] as Vec3 };
  const moving = { id: 'm', actor: fan.actor, pos: [0, 0, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 };
  let worst = 0;
  for (let tp = 0; tp < plank.pivots.length; tp += 7) {
    for (let mp = 0; mp < fan.pivots.length; mp++) {
      const s = snapPose(moving, fan, mp, target, plank, tp, 90);
      const moved = { ...moving, ...s };
      const a = pivotWorld(moved, fan, mp), b = pivotWorld(target, plank, tp);
      const pa = apply(a, [0, 0, 0]), pb = apply(b, [0, 0, 0]);
      const na = applyDir(a, [1, 0, 0]), nb = applyDir(b, [1, 0, 0]);
      worst = Math.max(worst, ...[0, 1, 2].map((k) => Math.abs(pa[k] - pb[k])), ...[0, 1, 2].map((k) => Math.abs(na[k] + nb[k])));
    }
  }
  check(worst < 1e-3, `snap aligns pivots (worst ${worst.toExponential(2)})`);
  void pose;
}

// 5. Surface snapping: a point on one face onto a point on another, normals opposite, roll about the normal.
{
  const worst: number[] = [];
  const target = { id: 't', actor: 'x', pos: [1, 2, 3] as Vec3, rotDeg: [10, 20, 30] as Vec3 };
  const moving = { id: 'm', actor: 'x', pos: [0, 0, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 };
  const cases: [Vec3, Vec3][] = [[[0, 0.1, 0], [0, 1, 0]], [[2, 0, 1], [1, 0, 0]], [[0, -0.5, 0], [0, -1, 0]], [[0.3, 0.2, 0.9], [0.2, 0.3, 0.9]]];
  for (const [tp, tn] of cases) for (const [mp, mn] of cases) for (const roll of [0, 90, 135]) {
    const tFrame = surfaceAnchor(tp, tn), mFrame = surfaceAnchor(mp, mn);
    const s = snapToAnchor(mFrame, mul(pose(target.pos, target.rotDeg), tFrame), roll);
    const a = mul(pose(s.pos, s.rotDeg), mFrame), b = mul(pose(target.pos, target.rotDeg), tFrame);
    const pa = apply(a, [0, 0, 0]), pb = apply(b, [0, 0, 0]);
    const na = applyDir(a, [1, 0, 0]), nb = applyDir(b, [1, 0, 0]);
    worst.push(...[0, 1, 2].map((k) => Math.abs(pa[k] - pb[k])), ...[0, 1, 2].map((k) => Math.abs(na[k] + nb[k])));
    // the roll turns the moving part's in-plane Y axis by `roll` degrees relative to the target's
    const ya = applyDir(a, [0, 1, 0]), yb = applyDir(b, [0, 1, 0]);
    const cos = ya[0] * yb[0] + ya[1] * yb[1] + ya[2] * yb[2];
    worst.push(Math.abs(cos - Math.cos((roll * Math.PI) / 180)));
  }
  check(Math.max(...worst) < 1e-3, `surface snap aligns points, normals and roll (worst ${Math.max(...worst).toExponential(2)})`);
  const q = quantizeOnFace([0.33, 0.1, -0.71], [0, 0.1, 0], [0, 1, 0], 0.25);
  check(Math.abs(q[0] - 0.25) < 1e-9 && Math.abs(q[1] - 0.1) < 1e-9 && Math.abs(q[2] + 0.75) < 1e-9, `grid point on a face (${q.join(', ')})`);
}

// 6. Measurements: bond angle and relative rotation, tilt, part size.
{
  const plank = 'AsbObj_WoodRectangle_A_M_01', fan = 'SpObj_WindGenerator_A_01';
  const bp = {
    format: 'totk-blueprint' as const, version: 1 as const, name: 'm',
    parts: [{ id: 'a', actor: plank, pos: [0, 0, 0] as Vec3, rotDeg: [0, 30, 0] as Vec3 }, { id: 'b', actor: fan, pos: [0, 1, 0] as Vec3, rotDeg: [35, 30, 0] as Vec3 }],
    bonds: [{ a: 'a', aBody: 0, b: 'b', bBody: 0 }],
  };
  const m = measureBond(bp, idx, 0)!;
  check(Math.abs(m.angle - 35) < 1e-6, `bond angle (${m.angle})`);
  check(Math.abs(m.relative[0] - 35) < 1e-6 && Math.abs(m.relative[1]) < 1e-6 && Math.abs(m.relative[2]) < 1e-6, `relative rotation (${m.relative.join(', ')})`);
  check(Math.abs(partTilt(bp.parts[1]) - 35) < 1e-6, `tilt (${partTilt(bp.parts[1])})`);
  const size = partSize(bp.parts[0], idx);
  const half = idx.get(plank)!.bodies[0].shape.prims[0].half!;
  check([0, 1, 2].every((k) => Math.abs(size[k] - 2 * half[k]) < 1e-9), `plank size (${size.join(' x ')})`);
}

// 7. Alignment guides: centre of mass of a part, flush and touching bounds, equal centres of mass.
{
  const plank = 'AsbObj_WoodRectangle_A_M_01';
  const half = idx.get(plank)!.bodies[0].shape.prims[0].half!;
  const bp = {
    format: 'totk-blueprint' as const, version: 1 as const, name: 'g',
    parts: [
      { id: 'a', actor: plank, pos: [0, 0, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 },
      // same height (flush top and bottom, same centre-of-mass Y), touching a's +X side
      { id: 'b', actor: plank, pos: [2 * half[0], 0, 0.7] as Vec3, rotDeg: [0, 0, 0] as Vec3 },
      // stacked on top: same X and Z centre, bottom touching a's top
      { id: 'c', actor: plank, pos: [0, 2 * half[1], 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 },
    ],
    bonds: [],
  };
  const com = partCom(bp.parts[1], idx);
  check(Math.abs(com[0] - 2 * half[0]) < 1e-9 && Math.abs(com[2] - 0.7) < 1e-9, `part centre of mass (${com.join(', ')})`);
  const lb = partLocalBounds(bp.parts[0], idx);
  check(Math.abs(lb.max[1] - half[1]) < 1e-9 && Math.abs(lb.min[1] + half[1]) < 1e-9, 'local bounds');
  const al = alignments(bp, idx, 'a');
  const has = (other: string, axis: number, kind: string) => al.some((x) => x.other === other && x.axis === axis && x.kind === kind);
  check(has('b', 1, 'com') && has('b', 1, 'flush-min') && has('b', 1, 'flush-max') && has('b', 0, 'touch'), 'side-by-side plank: Y flush and X touching');
  check(has('c', 0, 'com') && has('c', 2, 'com') && has('c', 1, 'touch') && !has('c', 1, 'com'), 'stacked plank: X/Z centred and Y touching');
}

// 8. Group operations of the multi-selection.
{
  const plank = 'AsbObj_WoodRectangle_A_M_01', fan = 'SpObj_WindGenerator_A_01';
  const bp = {
    format: 'totk-blueprint' as const, version: 1 as const, name: 'multi',
    parts: [
      { id: 'a', actor: plank, pos: [0, 0, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 },
      { id: 'b', actor: fan, pos: [3, 1, 0] as Vec3, rotDeg: [0, 90, 0] as Vec3 },
      { id: 'c', actor: fan, pos: [7, 2, 1] as Vec3, rotDeg: [0, 0, 0] as Vec3 },
      { id: 'd', actor: plank, pos: [12, 0, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 },
    ],
    bonds: [{ a: 'a', aBody: 0, b: 'b', bBody: 0 }, { a: 'b', aBody: 0, b: 'c', bBody: 0 }],
  };
  // a rigid group move keeps the relative poses of the moved parts
  const delta = rotationAbout(groupCentre(bp, idx, ['a', 'b']), 1, 37);
  const moved = transformParts(bp, ['a', 'b'], delta);
  const rel = (q: typeof bp, x: string, y: string) => mul(inv(pose(q.parts.find((p) => p.id === x)!.pos, q.parts.find((p) => p.id === x)!.rotDeg)), pose(q.parts.find((p) => p.id === y)!.pos, q.parts.find((p) => p.id === y)!.rotDeg));
  check(maxDiff(rel(bp, 'a', 'b'), rel(moved, 'a', 'b')) < 1e-3, 'group rotation keeps relative poses');
  const gc0 = groupCentre(bp, idx, ['a', 'b']), gc1 = groupCentre(moved, idx, ['a', 'b']);
  check(Math.abs(gc0[1] - gc1[1]) < 1e-6, 'rotation about Y keeps the centre height');
  // duplicate copies the bonds among the copied parts only
  const dup = duplicateParts(bp, ['b', 'c'], [0, 0, 5]);
  check(dup.ids.length === 2 && dup.bp.bonds.length === 3, `duplicate copies internal bonds (${dup.bp.bonds.length})`);
  const nb = dup.bp.bonds[2];
  check(dup.ids.includes(nb.a) && dup.ids.includes(nb.b), 'copied bond joins the copies');
  // align: centres of mass on Y equal to the reference's
  const al = alignParts(bp, idx, ['a', 'b', 'c'], 'b', 1, 'com');
  const yb = partCom(al.parts[1], idx)[1];
  check(Math.abs(partCom(al.parts[2], idx)[1] - yb) < 1e-4 && Math.abs(partCom(al.parts[0], idx)[1] - yb) < 1e-4, 'align centres of mass on Y');
  // distribute: equal gaps between bounds along X
  const ds = distributeParts(bp, idx, ['a', 'b', 'c', 'd'], 0, 'gap');
  const boxes = ds.parts.map((p) => partAabb(p, idx)).sort((x, y) => x[0] - y[0]);
  const gaps = [1, 2, 3].map((i) => boxes[i][0] - boxes[i - 1][3]);
  check(Math.max(...gaps) - Math.min(...gaps) < 1e-4, `equal gaps (${gaps.map((g) => g.toFixed(4)).join(', ')})`);
  // bond nearest: one bond added to join d
  const bn = bondNearest(bp, idx, ['a', 'b', 'c', 'd']);
  check(bn.added === 1 && bn.bp.bonds.length === 3, `bond nearest adds the missing bond (${bn.added})`);
  check(removeBondsWithin(bp, ['a', 'b']).bonds.length === 1, 'remove bonds within a set');
}

// ---------- big tire axles: the side with nothing glued is pulled in ----------
{
  const retract = [{ side: 'L' as const, bone: 'S_Axis_L', delta: [0, 0, 0.72] as Vec3 }, { side: 'R' as const, bone: 'S_Axis_R', delta: [0, 0, -0.72] as Vec3 }];
  const wheel = { id: 'w', actor: 'SpObj_SwitchWheel_B_01', pos: [0, 1, 0] as Vec3, rotDeg: [0, 90, 0] as Vec3 };
  // rotated 90° about Y: the tire's local -Z (left side) points along world -X
  const plank = (x: number) => ({ id: 'p', actor: 'AsbObj_WoodRectangle_A_M_01', pos: [x, 1, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 });
  const bp = (x: number, bonded = true) => ({ format: 'totk-blueprint' as const, version: 1 as const, name: 't', parts: [wheel, plank(x)], bonds: bonded ? [{ a: 'p', aBody: 0, b: 'w', bBody: 0 }] : [] });
  const left = axleOffsets(bp(-2), idx, wheel, retract);
  check(left.has('S_Axis_R') && !left.has('S_Axis_L'), 'glued on the left: right axle pulled in');
  const right = axleOffsets(bp(2), idx, wheel, retract);
  check(right.has('S_Axis_L') && !right.has('S_Axis_R'), 'glued on the right: left axle pulled in');
  check(axleOffsets(bp(2, false), idx, wheel, retract).size === 0, 'nothing glued: both axles out');
}

// ---------- bond bodies follow contact: a big tire's rim is body 1, its axle body 0 ----------
{
  const tire = { id: 't', actor: 'SpObj_SwitchWheel_B_01', pos: [0, 2, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 };
  // a plank under the tread (rim) and one at the left axle end (local -Z, LongPivot_L at z = -1.127)
  const under = { id: 'u', actor: 'AsbObj_WoodRectangle_A_M_01', pos: [0, 2 - 1.34 - 0.1, 0] as Vec3, rotDeg: [0, 0, 0] as Vec3 };
  const end = { id: 'e', actor: 'AsbObj_WoodRectangle_A_M_01', pos: [0, 2, -1.13 - 0.1] as Vec3, rotDeg: [90, 0, 0] as Vec3 };
  check(nearestBodies(tire, under, idx).aBody === 1, 'plank under the tread bonds to the wheel body (1)');
  check(nearestBodies(tire, end, idx).aBody === 0, 'plank at the axle end bonds to the axle body (0)');
  const bp = { format: 'totk-blueprint' as const, version: 1 as const, name: 't', parts: [tire, under, end], bonds: [{ a: 't', aBody: 0, b: 'u', bBody: 0 }, { a: 't', aBody: 0, b: 'e', bBody: 0 }] };
  const f = fixBondBodies(bp, idx);
  check(f.changed === 1 && f.bp.bonds[0].aBody === 1 && f.bp.bonds[1].aBody === 0, `fix moves the tread bond to body 1 (${f.changed})`);
  const s = axleBondSides(f.bp, idx, tire);
  check(s.L && !s.R, 'after the fix only the left axle has something glued');
}

// ---------- the game's own schematics: every bond of a multi-body part is on the body the contact rule picks ----------
{
  let multi = 0, agree = 0, flagged = 0;
  for (const d of drafts) {
    const bp = caiToBlueprint(parseCai(Buffer.from(d.cai, 'base64')), d.name);
    for (const b of bp.bonds) {
      const pa = bp.parts.find((p) => p.id === b.a)!, pb = bp.parts.find((p) => p.id === b.b)!;
      const n = (id: string) => (idx.get(id)?.bodies.filter((x) => x.slot >= 0).length || 1);
      if (n(pa.actor) < 2 && n(pb.actor) < 2) continue;
      multi++;
      const near = nearestBodies(pa, pb, idx);
      if (near.aBody === b.aBody && near.bBody === b.bBody) agree++;
    }
    flagged += misplacedBondBodies(bp, idx).length;
  }
  check(agree === multi, `schematic bonds on the contact bodies: ${agree} / ${multi}`);
  check(flagged === 0, `no schematic bond flagged as misplaced (${flagged})`);
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
