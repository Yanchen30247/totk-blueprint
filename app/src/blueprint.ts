// The editor's blueprint model, its checks, and conversion to and from the game's CombinedActorInfo.
import type { Blueprint, BPBond, BPPart, Library, Mat34, PartDef, Prim, Retract, Vec3 } from './types.ts';
import { IDENTITY, apply, eulerZYX, inv, mul, pose, rotZYX, round, translate, translation } from './math.ts';
import { MAX_BONDS, MAX_PARTS, type Cai, type CaiPart } from './cai.ts';
import { partName, tr } from './i18n.ts';

export function emptyBlueprint(name = tr('未命名蓝图', 'Untitled')): Blueprint {
  return { format: 'totk-blueprint', version: 1, name, parts: [], bonds: [] };
}

export class PartIndex {
  readonly byActor = new Map<string, PartDef>();
  readonly lib: Library;
  constructor(lib: Library) {
    this.lib = lib;
    for (const p of lib.parts) this.byActor.set(p.actor, p);
  }
  get(actor: string) { return this.byActor.get(actor); }
}

export function partPose(p: BPPart): Mat34 {
  return pose(p.pos, p.rotDeg);
}

/** Pose of a body (slot 0, 1, 2) of a part. Sub bodies use the offset measured from the game's schematics. */
export function bodyPose(p: BPPart, def: PartDef | undefined, slot: number): Mat34 {
  const main = partPose(p);
  if (slot === 0 || !def || !def.subRel) return main;
  const rel = def.subRel[slot as 1 | 2];
  return rel ? mul(main, rel) : main;
}

export function bodyRel(def: PartDef | undefined, slot: number): Mat34 {
  if (slot === 0 || !def || !def.subRel) return IDENTITY;
  return def.subRel[slot as 1 | 2] || IDENTITY;
}

export function slotCount(def: PartDef | undefined): number {
  if (!def) return 1;
  return Math.max(1, ...def.bodies.map((b) => b.slot + 1));
}

/** Points that bound a primitive in its body's frame (corners, axis ends ± radius, hull vertices). */
export function primPoints(pr: Prim): Vec3[] {
  const local: Vec3[] = [];
  const r = pr.radius || 0;
  const around = (c: Vec3) => {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) local.push([c[0] + sx * r, c[1] + sy * r, c[2] + sz * r]);
  };
  switch (pr.type) {
    case 'Box': {
      const c = pr.center || [0, 0, 0], h = pr.half || [0, 0, 0];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) local.push([c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
      break;
    }
    case 'Sphere': around(pr.center || [0, 0, 0]); break;
    case 'Cylinder': case 'Capsule': around(pr.a || [0, 0, 0]); around(pr.b || [0, 0, 0]); break;
    case 'Polytope': local.push(...(pr.verts || [])); break;
    case 'Prism': around([0, 0, 0]); around([0, pr.height || 1, 0]); break;
  }
  const off = pose(pr.offsetT, pr.offsetR);
  return local.map((v) => apply(off, v));
}

/**
 * Shapes that are part of the solid body. AirWall shapes are invisible walls, and "Undefined" shapes are helpers such as
 * the big wheel's 1 m steering sphere; both are left out of bounds and shown only as wireframe.
 */
export const isSolid = (pr: Prim) => pr.material !== 'AirWall' && pr.material !== 'Undefined';
const VISIBLE = isSolid;

/** World AABB [minX, minY, minZ, maxX, maxY, maxZ] over the dynamic bodies of every part. */
export function blueprintAabb(bp: Blueprint, idx: PartIndex): number[] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of bp.parts) {
    const def = idx.get(p.actor);
    if (!def) {
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.pos[k]); hi[k] = Math.max(hi[k], p.pos[k]); }
      continue;
    }
    for (const b of def.bodies) {
      if (b.slot < 0) continue;
      const m = bodyPose(p, def, b.slot);
      for (const pr of b.shape.prims) {
        if (!VISIBLE(pr)) continue;
        for (const v of primPoints(pr)) {
          const w = apply(m, v);
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
        }
      }
    }
  }
  if (!isFinite(lo[0])) return [0, 0, 0, 0, 0, 0];
  return [...lo, ...hi];
}

export interface Stats {
  parts: number;
  bonds: number;
  mass: number;
  com: Vec3;
  energy: number;
  aabb: number[];
  unknownActors: string[];
}

/**
 * Centre of mass of a body in its own frame. "Absolute" bodies give it in ComPos (the fan's ComPos (0,0,0.5) matches its
 * shape centre (0,0.01,0.51)); other bodies use the shape centre. Approximate: how the game applies ComOffset is unknown.
 */
function bodyCom(b: PartDef['bodies'][number]): Vec3 {
  if (b.comMode === 'Absolute' && b.comPos) return b.comPos;
  return b.shape.center || [0, 0, 0];
}

export function stats(bp: Blueprint, idx: PartIndex): Stats {
  let mass = 0, energy = 0;
  const c: Vec3 = [0, 0, 0];
  const unknown = new Set<string>();
  for (const p of bp.parts) {
    const def = idx.get(p.actor);
    if (!def) { unknown.add(p.actor); continue; }
    energy += def.energy || 0;
    for (const b of def.bodies) {
      if (b.slot < 0 || !b.mass) continue;
      const w = apply(bodyPose(p, def, b.slot), bodyCom(b));
      mass += b.mass;
      for (let k = 0; k < 3; k++) c[k] += w[k] * b.mass;
    }
  }
  if (mass > 0) for (let k = 0; k < 3; k++) c[k] /= mass;
  return { parts: bp.parts.length, bonds: bp.bonds.length, mass, com: c, energy, aabb: blueprintAabb(bp, idx), unknownActors: [...unknown] };
}

export interface Issue {
  level: 'error' | 'warn' | 'info';
  text: string;
  parts?: string[];
  /** A fix the editor can apply from the issue list. */
  fix?: 'bondBodies';
}

/** Rough gap between two parts: distance between the world AABBs of their dynamic bodies (0 when they overlap). */
export function partAabb(p: BPPart, idx: PartIndex): number[] {
  return blueprintAabb({ ...emptyBlueprint(), parts: [p] }, idx);
}

export function partGap(a: BPPart, b: BPPart, idx: PartIndex): number {
  const A = partAabb(a, idx), B = partAabb(b, idx);
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const g = Math.max(0, A[k] - B[k + 3], B[k] - A[k + 3]);
    d2 += g * g;
  }
  return Math.sqrt(d2);
}

export function validate(bp: Blueprint, idx: PartIndex): Issue[] {
  const out: Issue[] = [];
  const ids = new Set(bp.parts.map((p) => p.id));
  if (bp.parts.length === 0) out.push({ level: 'info', text: tr('蓝图是空的：从左侧零件库添加零件。', 'The blueprint is empty. Add parts from the library on the left.') });
  if (bp.parts.length > MAX_PARTS) out.push({ level: 'error', text: tr(`零件 ${bp.parts.length} 个，游戏最多 ${MAX_PARTS} 个。`, `${bp.parts.length} parts; the game allows at most ${MAX_PARTS}.`) });
  if (bp.bonds.length > MAX_BONDS) out.push({ level: 'error', text: tr(`粘合 ${bp.bonds.length} 条，格式最多 ${MAX_BONDS} 条。`, `${bp.bonds.length} bonds; the format holds at most ${MAX_BONDS}.`) });
  for (const p of bp.parts) {
    const def = idx.get(p.actor);
    if (!def) out.push({ level: 'warn', text: tr(`零件库里没有 ${p.actor}（没有碰撞体数据，按点显示）。`, `${p.actor} is not in the part library (no collision data, shown as a point).`), parts: [p.id] });
    else if (def.receiver && (def.receiver as Record<string, unknown>).AcceptUltraHand === 'False') out.push({ level: 'warn', text: tr(`${partName(def)} 不接受究极手。`, `${partName(def)} does not accept Ultrahand.`), parts: [p.id] });
  }
  const seen = new Set<string>();
  for (const b of bp.bonds) {
    if (!ids.has(b.a) || !ids.has(b.b)) { out.push({ level: 'error', text: tr('有粘合指向已删除的零件。', 'A bond points to a deleted part.') }); continue; }
    if (b.a === b.b) out.push({ level: 'error', text: tr('零件不能和自己粘合。', 'A part cannot be bonded to itself.'), parts: [b.a] });
    const key = [b.a, b.b].sort().join('|');
    if (seen.has(key)) out.push({ level: 'warn', text: tr('同一对零件有多条粘合。', 'The same two parts are bonded more than once.'), parts: [b.a, b.b] });
    seen.add(key);
    for (const [pid, slot] of [[b.a, b.aBody], [b.b, b.bBody]] as const) {
      const p = bp.parts.find((x) => x.id === pid)!;
      if (slot >= slotCount(idx.get(p.actor))) out.push({ level: 'error', text: tr(`粘合用了不存在的子刚体 ${slot}。`, `A bond uses body ${slot}, which the part does not have.`), parts: [pid] });
    }
    const pa = bp.parts.find((x) => x.id === b.a)!, pb = bp.parts.find((x) => x.id === b.b)!;
    const gap = partGap(pa, pb, idx);
    if (gap > 0.3) out.push({ level: 'warn', text: tr(`粘合的两个零件相距约 ${gap.toFixed(2)} m，游戏里可能粘不上。`, `Two bonded parts are about ${gap.toFixed(2)} m apart; the bond may not hold in the game.`), parts: [b.a, b.b] });
  }
  if (bp.parts.length > 1) {
    const adj = new Map<string, string[]>(bp.parts.map((p) => [p.id, []]));
    for (const b of bp.bonds) if (adj.has(b.a) && adj.has(b.b)) { adj.get(b.a)!.push(b.b); adj.get(b.b)!.push(b.a); }
    const start = bp.parts[0].id;
    const reach = new Set([start]);
    const stack = [start];
    while (stack.length) for (const n of adj.get(stack.pop()!)!) if (!reach.has(n)) { reach.add(n); stack.push(n); }
    const loose = bp.parts.filter((p) => !reach.has(p.id)).map((p) => p.id);
    if (loose.length) out.push({ level: 'warn', text: tr(`${loose.length} 个零件没有通过粘合连到第一个零件（游戏的蓝图都是一个整体）。`, `${loose.length} part(s) are not bonded to the rest (a schematic in the game is one connected piece).`), parts: loose });
    if (!loose.length && bp.bonds.length > bp.parts.length - 1) out.push({ level: 'warn', text: tr('粘合形成了环。游戏自带的蓝图都是树状（粘合数 = 零件数 − 1），环能否被游戏接受未验证。', "The bonds form a loop. The game's own schematics are all trees (bonds = parts − 1); whether the game accepts a loop is untested.") });
  }
  return out;
}

// ---------- conversion ----------

export function caiToBlueprint(cai: Cai, name: string): Blueprint {
  const bp = emptyBlueprint(name);
  bp.parts = cai.parts.map((p, i) => ({
    id: 'p' + i,
    actor: p.actor,
    pos: translation(p.pose).map((v) => round(v, 5)) as Vec3,
    rotDeg: eulerZYX(p.pose).map((v) => round(v, 4)) as Vec3,
  }));
  bp.bonds = cai.bonds.map((b) => ({ a: 'p' + b.a, aBody: b.aBody, b: 'p' + b.b, bBody: b.bBody }));
  return bp;
}

/** Game form of a blueprint: parts moved so the AABB centre is the origin, sub-body poses filled in. */
export function blueprintToCai(bp: Blueprint, idx: PartIndex): Cai {
  const box = blueprintAabb(bp, idx);
  const centre: Vec3 = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
  const shift: Vec3 = [-centre[0], -centre[1], -centre[2]];
  const half = [0, 1, 2].map((k) => (box[k + 3] - box[k]) / 2);
  const order = new Map(bp.parts.map((p, i) => [p.id, i]));
  const parts: CaiPart[] = bp.parts.map((p) => {
    const def = idx.get(p.actor);
    const main = translate(partPose(p), shift);
    const sub = (slot: 1 | 2) => {
      if (slotCount(def) <= slot) return IDENTITY;
      const rel = def && def.subRel && def.subRel[slot];
      // Without a measured offset the sub body starts on the main body's frame.
      return rel ? mul(main, rel) : main;
    };
    return { actor: p.actor, pose: main, pose2: sub(1), pose3: sub(2), unk90: 1 };
  });
  const bonds = bp.bonds
    .filter((b) => order.has(b.a) && order.has(b.b))
    .map((b) => ({ a: order.get(b.a)!, b: order.get(b.b)!, aBody: b.aBody, bBody: b.bBody }));
  const aabb = [-half[0], -half[1], -half[2], half[0], half[1], half[2]];
  return { version: 2, parts, bonds, aabb, aabb2: null };
}

// ---------- editing helpers ----------

export function nextId(bp: Blueprint): string {
  let n = bp.parts.length;
  const ids = new Set(bp.parts.map((p) => p.id));
  while (ids.has('p' + n)) n++;
  return 'p' + n;
}

export function removePart(bp: Blueprint, id: string): Blueprint {
  return { ...bp, parts: bp.parts.filter((p) => p.id !== id), bonds: bp.bonds.filter((b) => b.a !== id && b.b !== id) };
}

export function hasBond(bp: Blueprint, a: string, b: string): boolean {
  return bp.bonds.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}

/** The blueprint without any bond between parts a and b. */
export function removeBond(bp: Blueprint, a: string, b: string): Blueprint {
  return { ...bp, bonds: bp.bonds.filter((x) => !((x.a === a && x.b === b) || (x.a === b && x.b === a))) };
}

/** The blueprint without any bond of part id. */
export function removeBondsOf(bp: Blueprint, id: string): Blueprint {
  return { ...bp, bonds: bp.bonds.filter((x) => x.a !== id && x.b !== id) };
}

export function addBond(bp: Blueprint, bond: BPBond): Blueprint {
  if (bond.a === bond.b || hasBond(bp, bond.a, bond.b)) return bp;
  return { ...bp, bonds: [...bp.bonds, bond] };
}

/** World frame of a pivot (its +X is the outward direction of the bonding face). */
export function pivotWorld(p: BPPart, def: PartDef, pivotIndex: number): Mat34 {
  const pv = def.pivots[pivotIndex];
  return mul(bodyPose(p, def, pv.body), pose(pv.pos, pv.rotDeg));
}

/**
 * New pose of the moving part so that its pivot sits on the target pivot, facing it (outward directions opposite),
 * turned by rollDeg about the shared normal and pushed out along the target normal by gap metres.
 */
export function snapPose(moving: BPPart, movingDef: PartDef, movingPivot: number, target: BPPart, targetDef: PartDef, targetPivot: number, rollDeg: number, gap = 0): { pos: Vec3; rotDeg: Vec3 } {
  return snapToAnchor(pivotAnchor(movingDef, movingPivot), mul(partPose(target), pivotAnchor(targetDef, targetPivot)), rollDeg, gap);
}

// ---------- measurements ----------

const R2D = 180 / Math.PI;

/** Rotation angle (degrees) of a rigid transform's rotation part. */
export function rotationAngle(m: Mat34): number {
  const c = (m[0] + m[5] + m[10] - 1) / 2;
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

export interface BondMeasure {
  index: number;
  bond: BPBond;
  /** shape centres of the two bonded bodies (world) */
  centreA: Vec3;
  centreB: Vec3;
  centreDistance: number;
  /** angle between the two parts' orientations, degrees */
  angle: number;
  /** rotation of B in A's frame, game Euler degrees */
  relative: Vec3;
}

export function measureBond(bp: Blueprint, idx: PartIndex, index: number): BondMeasure | null {
  const bond = bp.bonds[index];
  const pa = bp.parts.find((p) => p.id === bond.a), pb = bp.parts.find((p) => p.id === bond.b);
  if (!pa || !pb) return null;
  const da = idx.get(pa.actor), db = idx.get(pb.actor);
  const ma = bodyPose(pa, da, bond.aBody), mb = bodyPose(pb, db, bond.bBody);
  const ca = da ? da.bodies.find((b) => b.slot === bond.aBody) : undefined;
  const cb = db ? db.bodies.find((b) => b.slot === bond.bBody) : undefined;
  const centreA = apply(ma, ca ? ca.shape.center : [0, 0, 0]);
  const centreB = apply(mb, cb ? cb.shape.center : [0, 0, 0]);
  const rel = mul(inv(partPose(pa)), partPose(pb));
  return {
    index, bond, centreA, centreB,
    centreDistance: Math.hypot(centreA[0] - centreB[0], centreA[1] - centreB[1], centreA[2] - centreB[2]),
    angle: rotationAngle(rel),
    relative: eulerZYX(rel),
  };
}

/** Angle between a part's own up axis (+Y) and the world's up, degrees. */
export function partTilt(p: BPPart): number {
  const m = partPose(p);
  return Math.acos(Math.max(-1, Math.min(1, m[5]))) * R2D;
}

/** Size of a part's solid collision shapes along its own X, Y, Z axes (metres). */
export function partSize(p: BPPart, idx: PartIndex): Vec3 {
  const b = partLocalBounds(p, idx);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** Bounds of a part's solid collision shapes in its own frame. */
export function partLocalBounds(p: BPPart, idx: PartIndex): { min: Vec3; max: Vec3 } {
  const def = idx.get(p.actor);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of def ? def.bodies : []) {
    if (b.slot < 0) continue;
    const rel = bodyRel(def, b.slot);
    for (const pr of b.shape.prims) {
      if (!isSolid(pr)) continue;
      for (const v of primPoints(pr)) {
        const w = apply(rel, v);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
      }
    }
  }
  if (!isFinite(lo[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: lo as Vec3, max: hi as Vec3 };
}

/** Centre of mass of one part (its dynamic bodies, mass weighted), world. Falls back to its position. */
/**
 * Offsets of a part's retractable axles (the big tire pulls in the axle on a side with nothing glued to it): the
 * side whose outward direction has a part glued to the axle body (body 0) beyond `reach` keeps its axle out; the
 * other sides move by their retraction. With nothing glued to the axle body, all stay out.
 */
export function axleOffsets(bp: Blueprint, idx: PartIndex, part: BPPart, retract: Retract[], reach = 0.3): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  if (!retract.length) return out;
  const local: Vec3[] = [];
  const toPart = inv(partPose(part));
  for (const b of bp.bonds) {
    const otherId = b.a === part.id ? b.b : b.b === part.id ? b.a : null;
    if (!otherId || otherId === part.id) continue;
    // only what is glued to the axle body (body 0) holds an axle out; rims and hubs are body 1
    if ((b.a === part.id ? b.aBody : b.bBody) !== 0) continue;
    const other = bp.parts.find((x) => x.id === otherId);
    if (!other) continue;
    const slot = b.a === part.id ? b.bBody : b.aBody;
    const def = idx.get(other.actor);
    const body = def && def.bodies.find((x) => x.slot === slot);
    local.push(apply(toPart, apply(bodyPose(other, def, slot), body ? body.shape.center : [0, 0, 0])));
  }
  const glued = retract.map((r) => {
    const len = Math.hypot(...r.delta) || 1;
    const outward = r.delta.map((v) => -v / len); // an axle sticks out against the way it retracts
    return local.some((q) => q[0] * outward[0] + q[1] * outward[1] + q[2] * outward[2] > reach);
  });
  if (!glued.some(Boolean)) return out;
  retract.forEach((r, i) => { if (!glued[i]) out.set(r.bone, r.delta); });
  return out;
}

export function partCom(p: BPPart, idx: PartIndex): Vec3 {
  const def = idx.get(p.actor);
  let mass = 0;
  const c: Vec3 = [0, 0, 0];
  for (const b of def ? def.bodies : []) {
    if (b.slot < 0 || !b.mass) continue;
    const w = apply(bodyPose(p, def, b.slot), bodyCom(b));
    mass += b.mass;
    for (let k = 0; k < 3; k++) c[k] += w[k] * b.mass;
  }
  return mass > 0 ? [c[0] / mass, c[1] / mass, c[2] / mass] : [...p.pos] as Vec3;
}

export interface Alignment {
  other: string;
  axis: 0 | 1 | 2;
  kind: 'com' | 'flush-min' | 'flush-max' | 'touch';
  /** points to connect: on the selected part and on the other part */
  from: Vec3;
  to: Vec3;
  /** coordinate shared on that axis */
  value: number;
}

/**
 * How a part lines up with the others along the world axes: equal centre-of-mass coordinates, flush bounding-box
 * faces (both minima or both maxima equal), or faces touching (one's maximum at the other's minimum). Tolerance in metres.
 */
export function alignments(bp: Blueprint, idx: PartIndex, id: string, tol = 0.002): Alignment[] {
  const sel = bp.parts.find((p) => p.id === id);
  if (!sel) return [];
  const sc = partCom(sel, idx), sb = partAabb(sel, idx);
  const out: Alignment[] = [];
  const faceCentre = (box: number[], axis: number, side: 0 | 3): Vec3 => {
    const c = [0, 1, 2].map((k) => (box[k] + box[k + 3]) / 2) as Vec3;
    c[axis] = box[axis + side];
    return c;
  };
  for (const p of bp.parts) {
    if (p.id === id) continue;
    const pc = partCom(p, idx), pb = partAabb(p, idx);
    for (const axis of [0, 1, 2] as const) {
      if (Math.abs(sc[axis] - pc[axis]) < tol) out.push({ other: p.id, axis, kind: 'com', from: sc, to: pc, value: sc[axis] });
      if (Math.abs(sb[axis] - pb[axis]) < tol) out.push({ other: p.id, axis, kind: 'flush-min', from: faceCentre(sb, axis, 0), to: faceCentre(pb, axis, 0), value: sb[axis] });
      if (Math.abs(sb[axis + 3] - pb[axis + 3]) < tol) out.push({ other: p.id, axis, kind: 'flush-max', from: faceCentre(sb, axis, 3), to: faceCentre(pb, axis, 3), value: sb[axis + 3] });
      if (Math.abs(sb[axis + 3] - pb[axis]) < tol) out.push({ other: p.id, axis, kind: 'touch', from: faceCentre(sb, axis, 3), to: faceCentre(pb, axis, 0), value: sb[axis + 3] });
      if (Math.abs(sb[axis] - pb[axis + 3]) < tol) out.push({ other: p.id, axis, kind: 'touch', from: faceCentre(sb, axis, 0), to: faceCentre(pb, axis, 3), value: sb[axis] });
    }
  }
  return out;
}

// ---------- anchors: a frame on a part, +X pointing out of its surface ----------

/** A pivot's frame in the part's own frame. */
export function pivotAnchor(def: PartDef, pivotIndex: number): Mat34 {
  const pv = def.pivots[pivotIndex];
  return mul(bodyRel(def, pv.body), pose(pv.pos, pv.rotDeg));
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * A frame on a surface, in the part's own frame: origin at the point, +X along the outward normal, +Y the part's up
 * (+Y) laid into the surface, or the part's forward (+Z) when the surface faces up or down.
 */
export function surfaceAnchor(point: Vec3, normal: Vec3): Mat34 {
  const x = norm(normal);
  let ref: Vec3 = [0, 1, 0];
  if (Math.abs(dot(x, ref)) > 0.95) ref = [0, 0, 1];
  const y = norm([ref[0] - x[0] * dot(ref, x), ref[1] - x[1] * dot(ref, x), ref[2] - x[2] * dot(ref, x)]);
  const z = cross(x, y);
  return [x[0], y[0], z[0], point[0], x[1], y[1], z[1], point[1], x[2], y[2], z[2], point[2]];
}

/**
 * A point on a face moved onto a grid of `step` metres laid out from the face centre along the anchor's Y and Z axes
 * (step 0 keeps the point as it is).
 */
export function quantizeOnFace(point: Vec3, centre: Vec3, normal: Vec3, step: number): Vec3 {
  if (!step) return point;
  const f = surfaceAnchor(centre, normal);
  const d: Vec3 = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
  const y: Vec3 = [f[1], f[5], f[9]], z: Vec3 = [f[2], f[6], f[10]];
  const qy = Math.round(dot(d, y) / step) * step, qz = Math.round(dot(d, z) / step) * step;
  return [centre[0] + y[0] * qy + z[0] * qz, centre[1] + y[1] * qy + z[1] * qz, centre[2] + y[2] * qy + z[2] * qz];
}

/**
 * Pose for a part so that its anchor (in its own frame) sits on a target anchor (in world), facing it (outward
 * directions opposite), turned by rollDeg about the shared normal and pushed out along the target normal by gap metres.
 */
export function snapToAnchor(movingAnchor: Mat34, targetWorld: Mat34, rollDeg: number, gap = 0): { pos: Vec3; rotDeg: Vec3 } {
  const face = mul(mul(targetWorld, pose([gap, 0, 0], [0, 0, 0])), mul(rotZYX([0, 180, 0]), rotZYX([rollDeg, 0, 0])));
  const m = mul(face, inv(movingAnchor));
  return { pos: translation(m).map((v) => round(v, 5)) as Vec3, rotDeg: eulerZYX(m).map((v) => round(v, 4)) as Vec3 };
}

// ---------- group operations (multi-selection) ----------

/** Centre of the world bounds of a set of parts. */
export function groupCentre(bp: Blueprint, idx: PartIndex, ids: string[]): Vec3 {
  const box = blueprintAabb({ ...bp, parts: bp.parts.filter((p) => ids.includes(p.id)) }, idx);
  return [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
}

/** Apply one rigid world transform to several parts (new pose = delta * pose). */
export function transformParts(bp: Blueprint, ids: string[], delta: Mat34): Blueprint {
  const set = new Set(ids);
  return {
    ...bp,
    parts: bp.parts.map((p) => {
      if (!set.has(p.id)) return p;
      const m = mul(delta, partPose(p));
      return { ...p, pos: translation(m).map((v) => round(v, 5)) as Vec3, rotDeg: eulerZYX(m).map((v) => round(v, 4)) as Vec3 };
    }),
  };
}

/** Rotation about a world axis (0 X, 1 Y, 2 Z) through a centre point. */
export function rotationAbout(centre: Vec3, axis: 0 | 1 | 2, deg: number): Mat34 {
  const e: Vec3 = [0, 0, 0];
  e[axis] = deg;
  const r = rotZYX(e);
  const t = apply(r, centre);
  r[3] = centre[0] - t[0];
  r[7] = centre[1] - t[1];
  r[11] = centre[2] - t[2];
  return r;
}

/** Copies of several parts moved by offset, with the bonds among them copied too. */
export function duplicateParts(bp: Blueprint, ids: string[], offset: Vec3): { bp: Blueprint; ids: string[] } {
  const map = new Map<string, string>();
  let next = bp;
  const copies: BPPart[] = [];
  for (const p of bp.parts) {
    if (!ids.includes(p.id)) continue;
    const id = nextId({ ...next, parts: [...next.parts, ...copies] });
    map.set(p.id, id);
    copies.push({ ...p, id, pos: [round(p.pos[0] + offset[0], 5), round(p.pos[1] + offset[1], 5), round(p.pos[2] + offset[2], 5)] });
  }
  const bonds = bp.bonds.filter((b) => map.has(b.a) && map.has(b.b)).map((b) => ({ ...b, a: map.get(b.a)!, b: map.get(b.b)! }));
  next = { ...bp, parts: [...bp.parts, ...copies], bonds: [...bp.bonds, ...bonds] };
  return { bp: next, ids: copies.map((c) => c.id) };
}

export type AlignMode = 'min' | 'centre' | 'max' | 'com';

/** Move parts along one world axis so their bounds' min / centre / max, or centre of mass, matches the reference part's. */
export function alignParts(bp: Blueprint, idx: PartIndex, ids: string[], reference: string, axis: 0 | 1 | 2, mode: AlignMode): Blueprint {
  const ref = bp.parts.find((p) => p.id === reference);
  if (!ref) return bp;
  const key = (p: BPPart) => {
    if (mode === 'com') return partCom(p, idx)[axis];
    const b = partAabb(p, idx);
    return mode === 'min' ? b[axis] : mode === 'max' ? b[axis + 3] : (b[axis] + b[axis + 3]) / 2;
  };
  const target = key(ref);
  return {
    ...bp,
    parts: bp.parts.map((p) => {
      if (p.id === reference || !ids.includes(p.id)) return p;
      const pos = [...p.pos] as Vec3;
      pos[axis] = round(pos[axis] + target - key(p), 5);
      return { ...p, pos };
    }),
  };
}

/**
 * Spread parts along one world axis between the two outermost ones: equal steps between their bounds' centres, or
 * equal gaps between their bounds. Needs at least three parts.
 */
export function distributeParts(bp: Blueprint, idx: PartIndex, ids: string[], axis: 0 | 1 | 2, mode: 'centre' | 'gap'): Blueprint {
  const parts = bp.parts.filter((p) => ids.includes(p.id)).map((p) => ({ p, b: partAabb(p, idx) }));
  if (parts.length < 3) return bp;
  parts.sort((x, y) => (x.b[axis] + x.b[axis + 3]) - (y.b[axis] + y.b[axis + 3]));
  const shift = new Map<string, number>();
  const first = parts[0], last = parts[parts.length - 1];
  if (mode === 'centre') {
    const c0 = (first.b[axis] + first.b[axis + 3]) / 2, c1 = (last.b[axis] + last.b[axis + 3]) / 2;
    parts.forEach((x, i) => shift.set(x.p.id, c0 + ((c1 - c0) * i) / (parts.length - 1) - (x.b[axis] + x.b[axis + 3]) / 2));
  } else {
    const total = last.b[axis + 3] - first.b[axis];
    const sizes = parts.reduce((s, x) => s + (x.b[axis + 3] - x.b[axis]), 0);
    const gap = (total - sizes) / (parts.length - 1);
    let at = first.b[axis];
    for (const x of parts) {
      shift.set(x.p.id, at - x.b[axis]);
      at += x.b[axis + 3] - x.b[axis] + gap;
    }
  }
  return {
    ...bp,
    parts: bp.parts.map((p) => {
      const d = shift.get(p.id);
      if (!d) return p;
      const pos = [...p.pos] as Vec3;
      pos[axis] = round(pos[axis] + d, 5);
      return { ...p, pos };
    }),
  };
}

/**
 * Bond a set of parts into one piece: existing bonds count as connections, and the missing ones are added between
 * the closest pairs (smallest gap between bounds) until all parts are joined (a minimum spanning tree).
 */
export function bondNearest(bp: Blueprint, idx: PartIndex, ids: string[], bodies?: (a: string, b: string) => BPBond | null): { bp: Blueprint; added: number } {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const b of bp.bonds) if (parent.has(b.a) && parent.has(b.b)) parent.set(find(b.a), find(b.b));
  const parts = bp.parts.filter((p) => parent.has(p.id));
  const pairs: { a: string; b: string; d: number }[] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) pairs.push({ a: parts[i].id, b: parts[j].id, d: partGap(parts[i], parts[j], idx) });
  pairs.sort((x, y) => x.d - y.d);
  let next = bp, added = 0;
  for (const pr of pairs) {
    const ra = find(pr.a), rb = find(pr.b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    next = addBond(next, (bodies && bodies(pr.a, pr.b)) || { a: pr.a, aBody: 0, b: pr.b, bBody: 0 });
    added++;
  }
  return { bp: next, added };
}

/** The blueprint without the bonds between parts of a set. */
export function removeBondsWithin(bp: Blueprint, ids: string[]): Blueprint {
  const set = new Set(ids);
  return { ...bp, bonds: bp.bonds.filter((b) => !(set.has(b.a) && set.has(b.b))) };
}
