// Find every actor the Ultrahand can pick up and glue: a dynamic main rigid body on the Object, GroundObject or
// SmallObject layer (RSDB/GameActorInfo MainRigidBodyLayer), a model, and no "AcceptUltraHand: False" in its
// SpecialPowerReceiverParam. Writes gamedata/library/assemblable.json (actor -> category, layer, flags).
// Read-only on the game install.
'use strict';
const fs = require('fs');
const path = require('path');
const { RomFS } = require('./lib/romfs');
const { parseByml } = require('./lib/byml');
const { ActorReader } = require('./lib/actor');

const OUT = path.join(__dirname, '..', 'gamedata', 'library', 'assemblable.json');
const r = new RomFS();
const reader = new ActorReader(r);
const ga = parseByml(r.read('RSDB/GameActorInfo.Product.143.rstbl.byml.zs')).root;
const ai = Object.fromEntries(parseByml(r.read('RSDB/ActorInfo.Product.143.rstbl.byml.zs')).root.map((e) => [e.__RowId, e]));

const LAYERS = new Set(['Object', 'GroundObject', 'SmallObject']);
// actors that only exist for cutscenes, far-away LOD, or are creatures and people
const SKIP = /(_Far$|^Dm_|^Enemy_|^Npc_|^Animal_|^Horse_|^Player|^Event|^Test|^Debug|^Demo|^Mini|_Event$|_Dummy|^Pfx|^Bgm|^Sound)/;

const out = {};
const reasons = {};
let checked = 0;
const t0 = Date.now();
for (const e of ga) {
  const name = e.__RowId;
  if (!LAYERS.has(e.MainRigidBodyLayer) || SKIP.test(name) || !reader.exists(name)) continue;
  checked++;
  let why = null;
  try {
    const pack = reader.open(name);
    const ap = pack.actorParam();
    const C = (ap && ap.Components) || {};
    const spr = pack.get(C.SpecialPowerReceiverRef) || {};
    const phys = pack.get(C.PhysicsRef);
    const cs = phys && pack.get(phys.ControllerSetPath);
    const mi = pack.get(C.ModelInfoRef);
    if (spr.AcceptUltraHand === 'False') why = 'AcceptUltraHand False';
    else if (!cs) why = 'no physics';
    else if (!mi || !mi.ModelProjectName) why = 'no model';
    else {
      const bodies = (cs.RigidBodyEntityNamePathAry || []).map((rb) => pack.get(rb.FilePath) || {});
      if (!bodies.some((b) => b.MotionType === 'Dynamic')) why = 'not dynamic';
      else {
        out[name] = {
          category: (ai[name] && ai[name].Category) || null,
          layer: e.MainRigidBodyLayer,
          autoBuilder: spr.AcceptAutoBuilder !== 'False',
          model: `${mi.ModelProjectName}.${mi.FmdbName}`,
        };
      }
    }
  } catch (err) {
    why = 'error ' + err.message;
  }
  if (why) reasons[why.split(' ')[0] + (why.startsWith('Accept') ? '' : '')] = (reasons[why.split(' ')[0]] || 0) + 1;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const prefixes = {};
for (const n of Object.keys(out)) { const p = n.split('_')[0]; prefixes[p] = (prefixes[p] || 0) + 1; }
console.log(`checked ${checked} actors in ${((Date.now() - t0) / 1000).toFixed(1)} s; assemblable ${Object.keys(out).length}`);
console.log('by prefix:', JSON.stringify(prefixes));
console.log('left out:', JSON.stringify(reasons));
