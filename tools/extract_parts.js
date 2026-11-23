// Research prototype: summarise the physics data of dumped actors into gamedata/parts.json.
// Reads the JSON written by dump_actor.js / dump_pack.js (resident, system). Writes nothing outside gamedata/.
// Usage: node extract_parts.js [actor-name-regex]
'use strict';
const fs = require('fs');
const path = require('path');

const G = path.join(__dirname, '..', 'gamedata');
const PHIVE = JSON.parse(fs.readFileSync(path.join(G, 'system/Phive/Config/PhiveConfig.json'), 'utf8'));
const presetMat = Object.fromEntries(PHIVE.MaterialPresetCollection.map((p) => [p.ComponentName, p.Material]));
const motionProps = Object.fromEntries(PHIVE.MotionPropertiesCollection.map((m) => [m.ComponentName, m]));

function loadRef(actorDir, ref) {
  if (!ref) return null;
  let rel = ref.replace(/^\?/, '').replace(/^Work\//, '').replace(/\.b?gyml$/, '.json');
  for (const base of [actorDir, path.join(G, 'resident'), path.join(G, 'system')]) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.$parent) {
        const parent = loadRef(actorDir, j.$parent) || {};
        return Object.assign({}, parent, j);
      }
      return j;
    }
  }
  return null;
}

const r6 = (x) => (typeof x === 'number' ? +x.toPrecision(5) : x);
const v3 = (v) => (v ? [r6(v.X), r6(v.Y), r6(v.Z)] : null);

function shapeSummary(sp) {
  if (!sp) return null;
  const prims = {};
  const mats = new Set();
  for (const k of ['Box', 'Polytope', 'Cylinder', 'Sphere', 'Capsule', 'Prism', 'PhshMesh']) {
    if (!sp[k]) continue;
    prims[k] = sp[k].length;
    for (const e of sp[k]) for (const m of e.MaterialPresets || []) mats.add(m);
  }
  const ac = sp.AutoCalc || {};
  return {
    primitives: prims,
    volume: r6(ac.Volume),
    aabbMin: v3(ac.Min),
    aabbMax: v3(ac.Max),
    materialPresets: [...mats],
    materials: [...new Set([...mats].map((m) => presetMat[m] || '?'))],
  };
}

function constraintSummary(cc) {
  if (!cc) return [];
  const out = [];
  for (const group of ['ManualJointParam', 'BoneJointParam']) {
    const g = cc[group];
    if (!g) continue;
    for (const [kind, arr] of Object.entries(g)) {
      for (const c of arr || []) {
        const e = { group, kind: kind.replace(/Array$/, ''), name: c.ConstraintName };
        if (c.BreakableParam) e.breakable = c.BreakableParam.IsBreakable ? c.BreakableParam.BreakThreshold : false;
        const p = c.SliderParam || c.HingeParam || c.SpringDamperParam || c.BallAndSocketParam || c.FixedParam || {};
        for (const k of Object.keys(p)) {
          if (/Motor|Spring|Limit|Friction|Stiff|Damp/.test(k) && typeof p[k] !== 'object') e[k] = r6(p[k]);
        }
        out.push(e);
      }
    }
  }
  return out;
}

function partFor(name) {
  const dir = path.join(G, 'actors', name);
  const ap = loadRef(dir, `Actor/${name}.engine__actor__ActorParam.json`);
  if (!ap || !ap.Components) return null;
  const C = ap.Components;
  const phys = loadRef(dir, C.PhysicsRef);
  const cs = phys && loadRef(dir, phys.ControllerSetPath);
  const part = { actor: name, category: ap.Category, bodies: [], constraints: [] };
  if (cs) {
    const shapes = Object.fromEntries((cs.ShapeNamePathAry || []).map((s) => [s.Name, s.FilePath]));
    for (const rb of cs.RigidBodyEntityNamePathAry || []) {
      const p = loadRef(dir, rb.FilePath) || {};
      const mp = motionProps[p.MotionProperty || 'Default'] || {};
      part.bodies.push({
        name: rb.Name,
        mass: r6(p.Mass),
        motionType: p.MotionType,
        motionProperty: p.MotionProperty || 'Default',
        gravityScale: r6(mp.GravityScale),
        linearDamping: r6(mp.LinearDamping),
        angularDamping: r6(mp.AngularDamping),
        maxLinearSpeed: r6(mp.MaxLinearSpeed),
        comMode: p.ComAssignMode,
        comOffset: v3(p.ComOffset),
        inertiaScale: v3(p.InertiaTensorScale),
        buoyancyDensity: r6(p.DensityForBuoyancy),
        layer: p.LayerEntity,
        shape: shapeSummary(loadRef(dir, shapes[p.ShapeName])),
      });
    }
    part.constraints = constraintSummary(loadRef(dir, cs.ConstraintControllerPath));
  }
  const zg = loadRef(dir, C.ZonauGearControlRef);
  if (zg) part.zonau = { energyConsumptionRate: r6(zg.EnergyConsumptionRate) };
  const gpt = loadRef(dir, C.GameParameterTableRef);
  if (gpt && gpt.Components) {
    for (const [k, ref] of Object.entries(gpt.Components)) {
      if (/SpecialPartsParam|FanParam|RocketParam|Balloon|Spring|Wheel|Energy/.test(k)) {
        const j = loadRef(dir, ref);
        if (j) part[k] = j;
      }
    }
  }
  return part;
}

const re = new RegExp(process.argv[2] || '^(SpObj_(?!.*Capsule)|AsbObj_)');
const names = fs.readdirSync(path.join(G, 'actors')).filter((n) => re.test(n));
const parts = names.map(partFor).filter(Boolean);
fs.writeFileSync(path.join(G, 'parts.json'), JSON.stringify(parts, null, 1));
for (const p of parts) {
  const b = p.bodies.map((x) => `${x.name}:${x.mass}kg ${x.motionProperty !== 'Default' ? x.motionProperty + '(g' + x.gravityScale + ')' : ''} [${x.shape ? Object.entries(x.shape.primitives).map(([k, v]) => k + v).join('+') : '-'}] ${x.shape ? x.shape.materials.join('/') : ''} V=${x.shape ? x.shape.volume : '-'}`).join('; ');
  console.log(`${p.actor} | ${b}${p.zonau ? ' | energy ' + p.zonau.energyConsumptionRate : ''}${p.constraints.length ? ' | joints ' + p.constraints.map((c) => c.kind + ':' + c.name).join(',') : ''}`);
}
console.log('parts', parts.length);
