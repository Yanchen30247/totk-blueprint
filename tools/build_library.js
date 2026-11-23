// Build the editor's part library from the local RomFS: gamedata/library/library.json (+ materials.json).
// Read-only on the game install. The output stays in gamedata/ (git-ignored) and is never distributed.
// Usage: node build_library.js [extra actor names...]
'use strict';
const fs = require('fs');
const path = require('path');
const { RomFS } = require('./lib/romfs');
const { parseSarc } = require('./lib/sarc');
const { parseMsbt } = require('./lib/msbt');
const { parseCai } = require('./lib/cai');
const { ActorReader } = require('./lib/actor');
const { parseByml } = require('./lib/byml');
const { Namer } = require('./lib/names');

const OUT = path.join(__dirname, '..', 'gamedata', 'library');
const r = new RomFS();
const reader = new ActorReader(r);

// ---------- names ----------
// Chinese (CNzh) is the main language; English (USen) is stored next to it for the editor's English interface.
function messages(lang) {
  const out = {};
  const s = parseSarc(r.read(r.list(new RegExp('^Mals/' + lang + '\\.'))[0]));
  for (const f of ['ActorMsg/Attachment.msbt', 'ActorMsg/PouchContent.msbt', 'ActorMsg/PictureBook.msbt', 'ActorMsg/AutoBuilderDraft.msbt']) {
    out[f.split('/')[1].replace('.msbt', '')] = parseMsbt(s.get(f));
  }
  return out;
}
const msgs = messages('CNzh');
const msgsEn = messages('USen');
// Display names come from lib/names.js (game text first, then fuse common names, then descriptive names).
const namers = {};
function displayName(actor, lang = 'CNzh') {
  if (!namers[lang]) namers[lang] = new Namer(r, reader, lang);
  const n = namers[lang].name(actor);
  return { name: n.name, source: n.source, auto: n.source === 'guess' || n.source === 'none' };
}
function caption(actor, m = msgs) {
  const a = m.Attachment[actor + '_Caption'] || m.PouchContent[actor.replace(/_A_0(\d)$/, '_Capsule_A_0$1') + '_Caption'];
  return a || null;
}

// ---------- math ----------
const D2R = Math.PI / 180;
// Rotation from game Euler degrees: R = Rz * Ry * Rx (X applied first), as sead's makeR.
function rotZYX(d) {
  const [x, y, z] = [d.X || 0, d.Y || 0, d.Z || 0].map((v) => v * D2R);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}
function mat34Mul(a, b) {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 4 + k] * b[k * 4 + j];
      o[i * 4 + j] = s + (j === 3 ? a[i * 4 + 3] : 0);
    }
  }
  return o;
}
function mat34Inv(m) {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 4 + j] = m[j * 4 + i];
  for (let i = 0; i < 3; i++) o[i * 4 + 3] = -(o[i * 4] * m[3] + o[i * 4 + 1] * m[7] + o[i * 4 + 2] * m[11]);
  return o;
}
const isIdentity = (m) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].every((v, i) => Math.abs(m[i] - v) < 1e-6);
const v3 = (v) => (v ? [+(v.X || 0), +(v.Y || 0), +(v.Z || 0)] : [0, 0, 0]);
const round = (x) => +(+x).toFixed(6);

// ---------- materials ----------
const phive = parseByml(parseSarc(r.read('Pack/Bootup.Nin_NX_NVN.pack.zs')).get('Phive/Config/PhiveConfig.byml')).root;
const presetToMat = Object.fromEntries(phive.MaterialPresetCollection.map((p) => [p.ComponentName, p.Material]));
const motionProps = Object.fromEntries(phive.MotionPropertiesCollection.map((m) => [m.ComponentName, m]));

// ---------- sub-body poses from the game's own schematics ----------
const subRel = {}; // actor -> {1: mat34|null, 2: mat34|null} relative to the main body
const bondBodies = {}; // actor -> Set of the bodies the game's schematics glue it by
for (const f of r.list(/CombinedActorInfo\/.*\.cai$/)) {
  const c = parseCai(r.read(f));
  for (const b of c.bonds) {
    for (const [i, body] of [[b.a, b.u0], [b.b, b.u1]]) {
      const a = c.parts[i] && c.parts[i].actor;
      if (!a) continue;
      if (!bondBodies[a]) bondBodies[a] = new Set();
      bondBodies[a].add(body);
    }
  }
  for (const p of c.parts) {
    if (subRel[p.actor]) continue;
    const inv = mat34Inv(p.pose);
    subRel[p.actor] = {
      1: isIdentity(p.pose2) ? null : mat34Mul(inv, p.pose2).map(round),
      2: isIdentity(p.pose3) ? null : mat34Mul(inv, p.pose3).map(round),
    };
  }
}

// ---------- shapes ----------
function primitive(type, e) {
  const preset = (e.MaterialPresets || [])[0] || '';
  const base = {
    type,
    preset,
    material: presetToMat[preset] || 'Undefined',
    offsetT: v3(e.OffsetTranslation).map(round),
    offsetR: v3(e.OffsetRotation).map(round),
  };
  switch (type) {
    case 'Box': return { ...base, center: v3(e.Center).map(round), half: v3(e.HalfExtents).map(round) };
    case 'Sphere': return { ...base, center: v3(e.Center).map(round), radius: round(e.Radius) };
    case 'Cylinder': case 'Capsule':
      return { ...base, a: v3(e.CenterA).map(round), b: v3(e.CenterB).map(round), radius: round(e.Radius) };
    case 'Polytope': return { ...base, verts: (e.Vertices || []).map((p) => v3(p).map(round)) };
    case 'Prism': return { ...base, radius: round(e.Radius), height: round(e.HeightHead || 1) };
    default: return null;
  }
}
function shapeOf(sp) {
  if (!sp) return { prims: [], volume: 0, center: [0, 0, 0] };
  const prims = [];
  for (const t of ['Box', 'Polytope', 'Cylinder', 'Sphere', 'Capsule', 'Prism']) {
    for (const e of sp[t] || []) { const p = primitive(t, e); if (p) prims.push(p); }
  }
  const ac = sp.AutoCalc || {};
  return { prims, volume: round(ac.Volume || 0), center: v3(ac.Center).map(round), min: v3(ac.Min).map(round), max: v3(ac.Max).map(round) };
}

// ---------- one actor ----------
function buildPart(name) {
  const pack = reader.open(name);
  const ap = pack.actorParam();
  if (!ap || !ap.Components) return null;
  const C = ap.Components;
  const phys = pack.get(C.PhysicsRef);
  const cs = phys && pack.get(phys.ControllerSetPath);
  if (!cs) return null;
  const shapePaths = Object.fromEntries((cs.ShapeNamePathAry || []).map((s) => [s.Name, s.FilePath]));
  const bodies = [];
  let slot = 0;
  for (const rb of cs.RigidBodyEntityNamePathAry || []) {
    const p = pack.get(rb.FilePath) || {};
    const dynamic = p.MotionType === 'Dynamic' && !/NavMeshCut|Cutting/.test(rb.Name);
    const mp = motionProps[p.MotionProperty || 'Default'] || motionProps.Default;
    bodies.push({
      name: rb.Name,
      slot: dynamic ? slot++ : -1,
      mass: p.Mass != null ? round(p.Mass) : null,
      motionType: p.MotionType || null,
      motionProperty: p.MotionProperty || 'Default',
      gravityScale: round(mp.GravityScale),
      linearDamping: round(mp.LinearDamping),
      angularDamping: round(mp.AngularDamping),
      maxLinearSpeed: round(mp.MaxLinearSpeed),
      maxAngularSpeed: round(mp.MaxAngularSpeed),
      comMode: p.ComAssignMode || 'Auto',
      comOffset: v3(p.ComOffset).map(round),
      comPos: p.ComPos ? v3(p.ComPos).map(round) : null,
      inertiaScale: v3(p.InertiaTensorScale || { X: 1, Y: 1, Z: 1 }).map(round),
      buoyancyDensity: p.DensityForBuoyancy != null ? round(p.DensityForBuoyancy) : null,
      layer: p.LayerEntity || null,
      shape: shapeOf(pack.get(shapePaths[p.ShapeName])),
    });
  }
  if (!bodies.some((b) => b.slot >= 0)) return null;
  // alias entity -> body name, for pivots
  const ctrlUnits = {};
  for (const c of cs.ControllerEntityNamePathAry || []) {
    const ce = pack.get(c.FilePath);
    const u = ce && (ce.RigidBodyControllerUnitAry || [])[0];
    if (u) ctrlUnits[c.Name] = u.Name;
  }
  const alias = {};
  for (const a of cs.AliasEntityList || []) alias[a.AliasEntity] = a.RigidBodyName || ctrlUnits[a.ControllerName] || null;
  const bodySlot = (aliasName) => {
    const bn = alias[aliasName || 'Main'];
    const b = bodies.find((x) => x.name === bn);
    return b && b.slot >= 0 ? b.slot : 0;
  };
  const apc = pack.get(C.ActorPositionCalculatorRef);
  const pivots = [];
  for (const d of (apc && apc.ActorPositionData) || []) {
    if (d.$type !== 'game__apc__BondPivot') continue;
    pivots.push({
      name: d.Name || '',
      body: bodySlot(d.TargetAliasEntity),
      pos: v3(d.PositionOffset).map(round),
      rotDeg: v3(d.RotationOffsetDeg).map(round),
      mask: d.AdjustMask || null,
      attr: d.AdjustPointAttribute || null,
      strong: !!d.StrongAdjustPoint,
      short: !!d.ShortAdjustRange,
    });
  }
  const spr = pack.get(C.SpecialPowerReceiverRef) || {};
  const zg = pack.get(C.ZonauGearControlRef);
  const joints = [];
  const cc = pack.get(cs.ConstraintControllerPath);
  for (const group of ['ManualJointParam', 'BoneJointParam']) {
    for (const [kind, arr] of Object.entries((cc && cc[group]) || {})) {
      for (const j of arr || []) {
        const params = j.SliderParam || j.HingeParam || j.SpringDamperParam || j.RangeParam || j.BallAndSocketParam || j.FixedParam || {};
        joints.push({ group, kind: kind.replace(/Array$/, ''), name: j.ConstraintName, bodyA: j.BodyParam && j.BodyParam.BodyAliasA, bodyB: j.BodyParam && j.BodyParam.BodyAliasB, params });
      }
    }
  }
  const nm = displayName(name);
  const en = displayName(name, 'USen');
  const rel = subRel[name] || null;
  return {
    actor: name,
    name: nm.name,
    autoName: nm.auto,
    /** 'game' = the actor's own text, 'common' = the fuse common name, 'guess' = made from the actor name */
    nameSource: nm.source,
    caption: caption(name),
    nameEn: en.name,
    nameSourceEn: en.source,
    captionEn: caption(name, msgsEn),
    category: categoryOf(name),
    autoBuilder: spr.AcceptAutoBuilder !== 'False',
    bodies,
    subRel: rel,
    subRelKnown: !!subRel[name],
    pivots,
    joints,
    energy: zg ? round(zg.EnergyConsumptionRate || 0) : null,
    receiver: spr,
  };
}

/**
 * Library tab of an actor: zonai devices, building materials, field objects, shrine objects, chests and boxes,
 * weapons (and shields, bows), items (materials, fruit, food), other.
 */
function categoryOf(name) {
  if (/^SpObj_/.test(name)) return 'zonai';
  if (/^AsbObj_/.test(name)) return 'material';
  if (/^Weapon_/.test(name)) return 'weapon';
  if (/^DgnObj_/.test(name)) return 'shrine';
  if (/^(TBox|Kibako|Barrel|BarrelBomb|TimerBarrelBomb|Pot)/.test(name)) return 'container';
  if (/^(Item_|Energy_|PutRupee)|Fruit|Fuit$|^LightBall/.test(name)) return 'item';
  if (/^(FldObj|Obj|TwnObj|SkyObj|MinusObj|Zonau|HiddenKorok|KorokStone|RockBall|StoneBall|WoodBall|IronBall|RockRoll|SpurGear|SwitchGear|SwitchWaterWheel|Cave_|LotusLeaf|BeeHome|IceWall|BrokenSnowBall)/.test(name)) return 'field';
  return 'other';
}

// ---------- actor list ----------
const allActors = r.list(/^Pack\/Actor\//).map((p) => p.slice(11, -8));
const wanted = new Set();
for (const a of allActors) {
  if (/^SpObj_/.test(a) && !/Capsule|_Static|MiniGame|Merged/.test(a)) wanted.add(a);
  if (/^AsbObj_/.test(a) && !/_BP$|_Anchor$|_Static$|ForAttachment/.test(a)) wanted.add(a);
}
for (const a of Object.keys(subRel)) wanted.add(a);
// Every actor the Ultrahand can glue (tools/scan_assemblable.js), without the fuse-only, blueprint-only and capsule
// variants, which never lie in the world as separate objects.
const ASSEMBLABLE = path.join(OUT, 'assemblable.json');
if (fs.existsSync(ASSEMBLABLE)) {
  for (const a of Object.keys(JSON.parse(fs.readFileSync(ASSEMBLABLE, 'utf8')))) {
    if (/_ForAttachment|_BP$|Capsule|_Far$/.test(a)) continue;
    wanted.add(a);
  }
}
for (const a of process.argv.slice(2)) wanted.add(a);

const parts = [];
const skipped = [];
for (const a of [...wanted].sort()) {
  if (!reader.exists(a)) { skipped.push(a + ' (no pack)'); continue; }
  try {
    const p = buildPart(a);
    if (p) {
      // bodies the game's own schematics bond this part by (e.g. big tire 0 and 1, small tire only 0)
      if (bondBodies[a]) p.bondBodies = [...bondBodies[a]].sort();
      parts.push(p);
    } else skipped.push(a + ' (no dynamic body)');
  } catch (e) { skipped.push(a + ' (' + e.message + ')'); }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'library.json'), JSON.stringify({
  format: 'totk-blueprint-library', version: 1,
  source: 'local RomFS, game 1.4.3', generated: new Date().toISOString(), parts,
}));
const mats = phive.MaterialCollection.map((m) => m.ComponentName);
const T = phive.MaterialParamTableSets.Default;
const table = (t) => t.map((row) => (Array.isArray(row) ? row : Object.keys(row).sort((a, b) => a - b).map((k) => row[k])).map(round));
fs.writeFileSync(path.join(OUT, 'materials.json'), JSON.stringify({
  materials: mats,
  staticFriction: table(T.StaticFrictionTable),
  dynamicFriction: table(T.DynamicFrictionTable),
  restitution: table(T.RestitutionTable),
  motionProperties: phive.MotionPropertiesCollection,
}));
// The official schematics, for the editor's import list.
const drafts = [];
for (const f of r.list(/CombinedActorInfo\/.*\.cai$/)) {
  const id = f.split('/').pop().replace('.cai', '');
  drafts.push({ id, name: msgs.AutoBuilderDraft[id + '_Name'] || id, nameEn: msgsEn.AutoBuilderDraft[id + '_Name'] || id, cai: r.read(f).toString('base64') });
}
fs.writeFileSync(path.join(OUT, 'drafts.json'), JSON.stringify(drafts));
console.log('parts', parts.length, 'drafts', drafts.length, 'skipped', skipped.length);
if (skipped.length) console.log(' ', skipped.join('\n  '));
