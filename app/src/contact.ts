// Contact between the bodies of two parts, from their collision shapes: how far apart they are, how deep they overlap,
// and which bodies of a bonded pair actually touch. A bond in the game's blueprint names one body of each part, and for
// multi-body parts the body matters: on the big tire body 0 is the axle and body 1 the wheel, and the game's own
// schematics glue rims and hubs to body 1 and axle ends to body 0.
import type { Blueprint, BPBond, BPPart, Prim, Vec3 } from './types.ts';
import { bodyPose, isSolid, type Issue, type PartIndex } from './blueprint.ts';
import { apply, inv, mul, pose } from './math.ts';
import { tr } from './i18n.ts';

type Mat34 = number[];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Two unit vectors perpendicular to u. */
function perpendiculars(u: Vec3): [Vec3, Vec3] {
  const t: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const p: Vec3 = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
  const pl = len(p) || 1;
  const p1: Vec3 = [p[0] / pl, p[1] / pl, p[2] / pl];
  const q: Vec3 = [u[1] * p1[2] - u[2] * p1[1], u[2] * p1[0] - u[0] * p1[2], u[0] * p1[1] - u[1] * p1[0]];
  return [p1, q];
}

/** Box-like extent of a primitive in its own frame (Polytope and Prism are treated as boxes). */
function primBox(pr: Prim): { c: Vec3; h: Vec3 } | null {
  if (pr.type === 'Box') return { c: pr.center || [0, 0, 0], h: pr.half || [0, 0, 0] };
  if (pr.type === 'Polytope' && pr.verts && pr.verts.length) {
    const mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const v of pr.verts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); }
    return { c: [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2) as Vec3, h: [0, 1, 2].map((k) => (mx[k] - mn[k]) / 2) as Vec3 };
  }
  if (pr.type === 'Prism') {
    const r = pr.radius || 0.5, hh = (pr.height || 1) / 2;
    return { c: [0, hh, 0], h: [r, hh, r] };
  }
  return null;
}

/** Signed distance from a point (in the primitive's own frame) to the primitive: negative inside. */
function primSdf(pr: Prim, p: Vec3): number {
  const r = pr.radius || 0;
  switch (pr.type) {
    case 'Sphere': return len(sub(p, pr.center || [0, 0, 0])) - r;
    case 'Capsule': case 'Cylinder': {
      const a = pr.a || [0, 0, 0], b = pr.b || [0, 0, 0];
      const ab = sub(b, a), L = len(ab) || 1e-9;
      const u: Vec3 = [ab[0] / L, ab[1] / L, ab[2] / L];
      const s = dot(sub(p, a), u);
      if (pr.type === 'Capsule') {
        const t = Math.max(0, Math.min(L, s));
        return len(sub(p, [a[0] + u[0] * t, a[1] + u[1] * t, a[2] + u[2] * t])) - r;
      }
      const radial = len(sub(p, [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s])) - r;
      const axial = Math.max(-s, s - L);
      return Math.min(Math.max(radial, axial), 0) + Math.hypot(Math.max(radial, 0), Math.max(axial, 0));
    }
    default: {
      const bx = primBox(pr);
      if (!bx) return Infinity;
      const q = [0, 1, 2].map((k) => Math.abs(p[k] - bx.c[k]) - bx.h[k]);
      return Math.hypot(...q.map((x) => Math.max(x, 0))) + Math.min(Math.max(q[0], q[1], q[2]), 0);
    }
  }
}

/** Points on (and in) a primitive's surface, in its own frame, for testing against other shapes. */
function primSamples(pr: Prim): Vec3[] {
  const r = pr.radius || 0;
  switch (pr.type) {
    case 'Sphere': {
      const c = pr.center || [0, 0, 0];
      return [c, ...[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r] as Vec3)];
    }
    case 'Capsule': case 'Cylinder': {
      const a = pr.a || [0, 0, 0], b = pr.b || [0, 0, 0];
      const ab = sub(b, a), L = len(ab) || 1e-9;
      const u: Vec3 = [ab[0] / L, ab[1] / L, ab[2] / L];
      const [p1, p2] = perpendiculars(u);
      const out: Vec3[] = [];
      const ring = (c: Vec3, rr: number) => {
        out.push(c);
        for (let k = 0; k < 12; k++) {
          const t = (k / 12) * Math.PI * 2, cs = Math.cos(t) * rr, sn = Math.sin(t) * rr;
          out.push([c[0] + p1[0] * cs + p2[0] * sn, c[1] + p1[1] * cs + p2[1] * sn, c[2] + p1[2] * cs + p2[2] * sn]);
        }
      };
      for (const f of [0, 0.25, 0.5, 0.75, 1]) ring([a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f], r);
      for (const f of [0, 1]) ring([a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f], r / 2);
      if (pr.type === 'Capsule') out.push([a[0] - u[0] * r, a[1] - u[1] * r, a[2] - u[2] * r], [b[0] + u[0] * r, b[1] + u[1] * r, b[2] + u[2] * r]);
      return out;
    }
    case 'Polytope': {
      const v = pr.verts || [];
      if (!v.length) return [];
      const c: Vec3 = [0, 1, 2].map((k) => v.reduce((s, x) => s + x[k], 0) / v.length) as Vec3;
      return [c, ...v, ...v.map((x) => [(x[0] + c[0]) / 2, (x[1] + c[1]) / 2, (x[2] + c[2]) / 2] as Vec3)];
    }
    default: {
      const bx = primBox(pr);
      if (!bx) return [];
      const out: Vec3[] = [bx.c];
      for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
        if (!sx && !sy && !sz) continue;
        out.push([bx.c[0] + sx * bx.h[0], bx.c[1] + sy * bx.h[1], bx.c[2] + sz * bx.h[2]]);
      }
      return out;
    }
  }
}

interface WorldPrim { prim: Prim; toLocal: Mat34; samples: Vec3[] }

function bodyPrims(p: BPPart, idx: PartIndex, slot: number): WorldPrim[] {
  const def = idx.get(p.actor);
  const body = def && def.bodies.find((b) => b.slot === slot);
  if (!body) return [];
  const bp = bodyPose(p, def, slot);
  return body.shape.prims.filter(isSolid).map((pr) => {
    const m = mul(bp, pose(pr.offsetT, pr.offsetR));
    return { prim: pr, toLocal: inv(m), samples: primSamples(pr).map((v) => apply(m, v)) };
  });
}

/**
 * Closest approach of two bodies: { distance } >= 0 when apart, and { depth } > 0 when they overlap (how far the
 * deepest sampled point of one lies inside the other). Approximate: sampled surface points against exact distances.
 */
export function bodyContact(pa: BPPart, slotA: number, pb: BPPart, slotB: number, idx: PartIndex): { distance: number; depth: number } {
  const A = bodyPrims(pa, idx, slotA), B = bodyPrims(pb, idx, slotB);
  let best = Infinity;
  const test = (from: WorldPrim[], to: WorldPrim[]) => {
    for (const f of from) for (const q of f.samples) for (const t of to) best = Math.min(best, primSdf(t.prim, apply(t.toLocal, q)));
  };
  test(A, B);
  test(B, A);
  if (!isFinite(best)) return { distance: Infinity, depth: 0 };
  return { distance: Math.max(0, best), depth: Math.max(0, -best) };
}

function solidSlots(p: BPPart, idx: PartIndex): number[] {
  const def = idx.get(p.actor);
  if (!def) return [0];
  let s = def.bodies.filter((b) => b.slot >= 0 && b.shape.prims.some(isSolid)).map((b) => b.slot);
  // where the game's schematics show which bodies a part is glued by (the small tire and stakes only by body 0,
  // the big tire by 0 and 1), stay within those
  if (def.bondBodies && def.bondBodies.length) s = s.filter((x) => def.bondBodies!.includes(x));
  return s.length ? s : [0];
}

/**
 * The bodies of two parts that touch. Closer pairs win; among pairs that touch, the one whose surfaces meet (least
 * overlap) wins over one that passes through the other part: in one of the game's schematics (a launching sprinkler) a battery sits against a big
 * tire's hub with the axle running through it, and the game glues it to the wheel body (1), not the axle (0).
 * Ties go to the lower body index.
 */
export function nearestBodies(pa: BPPart, pb: BPPart, idx: PartIndex, touch = 0.02): { aBody: number; bBody: number; distance: number } {
  let best = { aBody: 0, bBody: 0, distance: Infinity, depth: Infinity };
  for (const sa of solidSlots(pa, idx)) for (const sb of solidSlots(pb, idx)) {
    const c = bodyContact(pa, sa, pb, sb, idx);
    const bothTouch = c.distance <= touch && best.distance <= touch;
    const better = bothTouch ? c.depth < best.depth - 1e-3 : c.distance < best.distance - 1e-3;
    if (better) best = { aBody: sa, bBody: sb, distance: c.distance, depth: c.depth };
  }
  return { aBody: best.aBody, bBody: best.bBody, distance: best.distance };
}

/** A bond between a and b on the bodies that touch. */
export function contactBond(bp: Blueprint, idx: PartIndex, a: string, b: string): BPBond | null {
  const pa = bp.parts.find((p) => p.id === a), pb = bp.parts.find((p) => p.id === b);
  if (!pa || !pb) return null;
  const n = nearestBodies(pa, pb, idx);
  return { a, aBody: n.aBody, b, bBody: n.bBody };
}

/**
 * Bonds of multi-body parts whose recorded bodies are not the ones in contact: [{ index, bond, fixed }].
 * Only reported when the touching pair is clearly closer (by `margin`) than the recorded one.
 */
export function misplacedBondBodies(bp: Blueprint, idx: PartIndex, margin = 0.15): { index: number; bond: BPBond; fixed: BPBond }[] {
  const out: { index: number; bond: BPBond; fixed: BPBond }[] = [];
  bp.bonds.forEach((b, index) => {
    const pa = bp.parts.find((p) => p.id === b.a), pb = bp.parts.find((p) => p.id === b.b);
    if (!pa || !pb) return;
    if (solidSlots(pa, idx).length < 2 && solidSlots(pb, idx).length < 2) return;
    const n = nearestBodies(pa, pb, idx);
    if (n.aBody === b.aBody && n.bBody === b.bBody) return;
    const recorded = bodyContact(pa, b.aBody, pb, b.bBody, idx);
    if (recorded.distance - n.distance < margin) return;
    out.push({ index, bond: b, fixed: { ...b, aBody: n.aBody, bBody: n.bBody } });
  });
  return out;
}

/** The blueprint with every misplaced bond body moved to the body in contact; `changed` counts the bonds fixed. */
export function fixBondBodies(bp: Blueprint, idx: PartIndex): { bp: Blueprint; changed: number } {
  const wrong = misplacedBondBodies(bp, idx);
  if (!wrong.length) return { bp, changed: 0 };
  const byIndex = new Map(wrong.map((w) => [w.index, w.fixed]));
  return { bp: { ...bp, bonds: bp.bonds.map((b, i) => byIndex.get(i) || b) }, changed: wrong.length };
}

/** Bonded pairs whose bonded bodies overlap deeper than `limit` metres: [{ index, bond, depth }]. */
export function overlappingBonds(bp: Blueprint, idx: PartIndex, limit = 0.1): { index: number; bond: BPBond; depth: number }[] {
  const out: { index: number; bond: BPBond; depth: number }[] = [];
  bp.bonds.forEach((b, index) => {
    const pa = bp.parts.find((p) => p.id === b.a), pb = bp.parts.find((p) => p.id === b.b);
    if (!pa || !pb) return;
    const c = bodyContact(pa, b.aBody, pb, b.bBody, idx);
    if (c.depth > limit) out.push({ index, bond: b, depth: c.depth });
  });
  return out;
}

/** True for parts whose axle shows on one side only in the game (the big tire: pivots LongPivot_L / LongPivot_R on body 0). */
export function hasSideAxles(p: BPPart, idx: PartIndex): boolean {
  const def = idx.get(p.actor);
  return !!def && def.pivots.some((v) => v.name === 'LongPivot_L' && v.body === 0) && def.pivots.some((v) => v.name === 'LongPivot_R' && v.body === 0);
}

/**
 * Which axle sides of a big tire have something glued to its axle body (body 0): parts on the side of LongPivot_L
 * (local -Z) or LongPivot_R (+Z) beyond `reach` metres from the wheel's mid plane.
 */
export function axleBondSides(bp: Blueprint, idx: PartIndex, part: BPPart, reach = 0.3): { L: boolean; R: boolean } {
  const toPart = inv(bodyPose(part, idx.get(part.actor), 0));
  const sides = { L: false, R: false };
  for (const b of bp.bonds) {
    const mine = b.a === part.id ? b.aBody : b.b === part.id ? b.bBody : -1;
    if (mine !== 0 || b.a === b.b) continue;
    const otherId = b.a === part.id ? b.b : b.a;
    const other = bp.parts.find((x) => x.id === otherId);
    if (!other) continue;
    const slot = b.a === part.id ? b.bBody : b.aBody;
    const def = idx.get(other.actor);
    const body = def && def.bodies.find((x) => x.slot === slot);
    const q = apply(toPart, apply(bodyPose(other, def, slot), body ? body.shape.center : [0, 0, 0]));
    if (q[2] < -reach) sides.L = true;
    if (q[2] > reach) sides.R = true;
  }
  return sides;
}

/**
 * Problems the game shows when a blueprint is built: bonds recorded on a body that is not in contact (the game glues
 * that body, e.g. a big tire's axle instead of its rim; seen in game, where the axle then came out on the wrong side),
 * bonded parts that overlap deeply (only a note), and big tires with something glued to both axle ends (the game's
 * schematics use one side only).
 */
export function contactIssues(bp: Blueprint, idx: PartIndex, label: (id: string) => string): Issue[] {
  const out: Issue[] = [];
  const wrong = misplacedBondBodies(bp, idx);
  if (wrong.length) {
    const body = tr('刚体', 'body ');
    const list = wrong.slice(0, 4).map((w) => `${label(w.bond.a)}[${body}${w.bond.aBody}→${w.fixed.aBody}] ⟷ ${label(w.bond.b)}[${body}${w.bond.bBody}→${w.fixed.bBody}]`).join(tr('、', ', '));
    out.push({
      level: 'warn',
      text: tr(`${wrong.length} 条粘合记录的子刚体不是实际接触的那个：${list}${wrong.length > 4 ? ' 等' : ''}。游戏按记录的子刚体粘合（大轮胎的刚体0是车轴，刚体1是轮胎）。`,
        `${wrong.length} bond(s) record a body other than the one in contact: ${list}${wrong.length > 4 ? ' …' : ''}. The game bonds the recorded body (on a big wheel, body 0 is the axle and body 1 the tire).`),
      parts: [wrong[0].bond.a, wrong[0].bond.b],
      fix: 'bondBodies',
    });
  }
  for (const o of overlappingBonds(bp, idx, 0.2)) {
    out.push({ level: 'info', text: tr(`${label(o.bond.a)} 和 ${label(o.bond.b)} 的碰撞体互相穿插约 ${o.depth.toFixed(2)} m（粘合成功时通常没关系；粘合没成立时游戏会把它们推开）。`,
      `${label(o.bond.a)} and ${label(o.bond.b)} overlap by about ${o.depth.toFixed(2)} m (usually fine once bonded; if the bond fails the game pushes them apart).`), parts: [o.bond.a, o.bond.b] });
  }
  for (const p of bp.parts) {
    if (!hasSideAxles(p, idx)) continue;
    const s = axleBondSides(bp, idx, p);
    if (s.L && s.R) out.push({ level: 'warn', text: tr(`${label(p.id)} 两侧车轴都粘了零件。游戏的设计图里大轮胎只用一侧车轴，游戏里另一侧可能会收进轮毂。`, `${label(p.id)} has parts bonded to both ends of its axle. The game's schematics use one side only; in the game the other side may retract into the hub.`), parts: [p.id] });
  }
  return out;
}
