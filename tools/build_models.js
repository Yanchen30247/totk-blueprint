// Build the editor's part models from the local game: gamedata/library/models/*.glb and models.json.
// Steps: read each library part's ModelInfo, copy its Model/<project>.<fmdb>.bfres.mc out of the RomFS, decompress it
// with the MeshCodec tool built in WSL (dt-12345/MeshCodec, GPL-2.0, kept outside this project and run as a separate
// program), read the BFRES, put LOD 0 of every shape into the actor's frame using the skeleton's rest pose, and write GLB.
// Everything stays in gamedata/ (git-ignored, never distributed).
//
// Usage: node build_models.js [actor-regex]
// Env: MESHCODEC (WSL path of mc_test, default ~/meshcodec/build/tests/mc_test), WSL_DISTRO (default Ubuntu-24.04)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { RomFS } = require('./lib/romfs');
const { ActorReader } = require('./lib/actor');
const { parseBfres } = require('./lib/bfres');
const { writeGlb } = require('./lib/glb');
const { parseSkeletalAnims, retractions } = require('./lib/bfres_anim');
const { buildTexture, buildMaskedTexture } = require('./lib/textures');

const G = path.join(__dirname, '..', 'gamedata');
const MC_DIR = path.join(G, 'models', 'mc');
const BFRES_DIR = path.join(G, 'models', 'bfres');
const OUT_DIR = path.join(G, 'library', 'models');
const MESHCODEC = process.env.MESHCODEC || '~/meshcodec/build/tests/mc_test';
const DISTRO = process.env.WSL_DISTRO || 'Ubuntu-24.04';

const toWsl = (p) => '/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');

// ---------- math (row-major 4x4 as 12-element 3x4) ----------
function eulerZYX([x, y, z]) {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}
function quat([x, y, z, w]) {
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
function trs(t, r, s) {
  return [r[0] * s[0], r[1] * s[1], r[2] * s[2], t[0], r[3] * s[0], r[4] * s[1], r[5] * s[2], t[1], r[6] * s[0], r[7] * s[1], r[8] * s[2], t[2]];
}
function mul(a, b) {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[i * 4 + k] * b[k * 4 + j];
    o[i * 4 + j] = s + (j === 3 ? a[i * 4 + 3] : 0);
  }
  return o;
}
const xf = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const xn = (m, n) => {
  const v = [m[0] * n[0] + m[1] * n[1] + m[2] * n[2], m[4] * n[0] + m[5] * n[1] + m[6] * n[2], m[8] * n[0] + m[9] * n[1] + m[10] * n[2]];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function boneWorlds(model) {
  const world = [];
  for (let i = 0; i < model.bones.length; i++) {
    const b = model.bones[i];
    const rot = model.rotationMode === 'quat' ? quat(b.rotation) : eulerZYX(b.rotation);
    const local = trs(b.translation, rot, b.scale);
    world[i] = b.parent >= 0 && world[b.parent] ? mul(world[b.parent], local) : local;
  }
  return world;
}

// A display colour per game material, from its name (textures are not decoded).
function materialColour(name) {
  const n = name.toLowerCase();
  if (/light|lightpower|emission|glow/.test(n)) return [0.35, 0.95, 0.9, 1];
  if (/green/.test(n)) return [0.42, 0.55, 0.45, 1];
  if (/wood|board|log/.test(n)) return [0.62, 0.43, 0.25, 1];
  if (/metal|iron/.test(n)) return [0.55, 0.58, 0.62, 1];
  if (/glass|crystal/.test(n)) return [0.55, 0.8, 0.9, 1];
  if (/cloth|rope|fabric/.test(n)) return [0.82, 0.75, 0.6, 1];
  if (/zonau|rock|stone/.test(n)) return [0.6, 0.63, 0.6, 1];
  return [0.7, 0.7, 0.7, 1];
}

function inv(m) {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 4 + j] = m[j * 4 + i];
  for (let i = 0; i < 3; i++) o[i * 4 + 3] = -(o[i * 4] * m[3] + o[i * 4 + 1] * m[7] + o[i * 4 + 2] * m[11]);
  return o;
}
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/**
 * Rest pose of each sub body relative to the main body. A body follows the bone its controller unit names in
 * TrackingBoneName (RigidBodyControllerEntityParam); without one it sits on the actor's root.
 */
function restRel(pack, part, model) {
  const ap = pack.actorParam();
  const phys = pack.get(ap.Components.PhysicsRef);
  const cs = phys && pack.get(phys.ControllerSetPath);
  if (!cs) return null;
  const bone = {};
  for (const c of cs.ControllerEntityNamePathAry || []) {
    const ce = pack.get(c.FilePath);
    for (const u of (ce && ce.RigidBodyControllerUnitAry) || []) if (u.TrackingBoneName && !(u.Name in bone)) bone[u.Name] = u.TrackingBoneName;
  }
  const world = boneWorlds(model);
  const frame = (bodyName) => {
    const bn = bone[bodyName];
    const i = bn ? model.bones.findIndex((b) => b.name === bn) : -1;
    return i >= 0 ? world[i] : IDENT;
  };
  const main = part.bodies.find((b) => b.slot === 0);
  if (!main) return null;
  const invMain = inv(frame(main.name));
  const out = {};
  let any = false;
  for (const b of part.bodies) {
    if (b.slot < 1) continue;
    out[b.slot] = mul(invMain, frame(b.name)).map((x) => +x.toFixed(6));
    any = true;
  }
  return any ? out : null;
}

/**
 * The textures of a material: its albedo (name ending in _Alb, else the first texture) and emission (_Emm), decoded to
 * PNG under gamedata/library/textures. Missing or undecodable textures leave the colour from materialColour.
 */
function materialTextures(mat, ctx, maxSize) {
  const names = mat.textures || [];
  const alb = names.find((n) => /_Alb|_Alb$/.test(n)) || names.find((n) => !/_(Nrm|Mtl|Rgh|Spm|Emm|Msk|Ao)/.test(n));
  const emm = names.find((n) => /_Emm|_Emm$/.test(n));
  // an opacity mask (grates, nets, Zonai lattices) becomes the albedo's alpha
  const msk = names.find((n) => /_Msk$/.test(n));
  return {
    alb: !alb ? null : msk ? buildMaskedTexture(ctx.romfs, alb, msk, ctx.texDir, ctx.cache, maxSize) : buildTexture(ctx.romfs, alb, ctx.texDir, ctx.cache, maxSize),
    emm: emm ? buildTexture(ctx.romfs, emm, ctx.texDir, ctx.cache, maxSize) : null,
  };
}

/**
 * Triangles of every shape in the actor frame, one primitive per shape. Triangles whose vertices all ride on one of the
 * `split` bones (axles the game retracts) become a primitive of their own tagged with that bone, so the editor can move them.
 */
function buildMesh(bfres, ctx, maxSize, split = new Set()) {
  const model = bfres.models[0];
  const world = boneWorlds(model);
  const prims = [];
  for (const s of model.shapes) {
    const vb = model.vertexBuffers[s.vertexBuffer];
    const pos = vb.read('_p0');
    if (!pos) continue;
    const nrm = vb.read('_n0');
    const uv = vb.read('_u0');
    const idx = vb.read('_i0');
    const mesh = s.meshes[0];
    if (!mesh || mesh.primitive !== 3) continue; // triangles only
    const indices = model.readIndices(mesh);
    // Each vertex goes to the actor frame through its bone: the shape's bone (skin 0) or its rigid matrix (skin 1).
    const boneOf = (vi) => (s.skinCount === 0 ? s.bone : s.skinCount === 1 && idx ? model.matrixToBone[idx[vi][0]] : -1);
    const groups = new Map(); // '' or a split bone name -> { used, P, N, T, I }
    const group = (key) => {
      if (!groups.has(key)) groups.set(key, { used: new Map(), P: [], N: [], T: [], I: [] });
      return groups.get(key);
    };
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const tri = [indices[t], indices[t + 1], indices[t + 2]];
      const bones = tri.map((vi) => { const b = boneOf(vi); return b >= 0 && model.bones[b] ? model.bones[b].name : ''; });
      const g = group(bones[0] && split.has(bones[0]) && bones[1] === bones[0] && bones[2] === bones[0] ? bones[0] : '');
      for (const vi of tri) {
        let k = g.used.get(vi);
        if (k === undefined) {
          let m;
          if (s.skinCount === 0) m = world[s.bone];
          else if (s.skinCount === 1 && idx) m = world[model.matrixToBone[idx[vi][0]]] || world[s.bone];
          else m = null; // smooth skinning: vertices are already in model space
          const p = m ? xf(m, pos[vi]) : pos[vi].slice(0, 3);
          const n = nrm ? (m ? xn(m, nrm[vi]) : nrm[vi].slice(0, 3)) : [0, 1, 0];
          k = g.used.size;
          g.used.set(vi, k);
          g.P.push(p[0], p[1], p[2]);
          g.N.push(n[0], n[1], n[2]);
          g.T.push(uv ? uv[vi][0] : 0, uv ? uv[vi][1] : 0);
        }
        g.I.push(k);
      }
    }
    const m = model.materials[s.material] || { name: 'default', textures: [] };
    const tex = ctx ? materialTextures(m, ctx, maxSize) : { alb: null, emm: null };
    for (const [bone, g] of groups) {
      if (!g.I.length) continue;
      prims.push({ name: bone ? s.name + '@' + bone : s.name, bone: bone || undefined, material: m.name, colour: tex.alb ? [1, 1, 1, 1] : materialColour(m.name), texture: tex.alb, emission: tex.emm, positions: g.P, normals: g.N, uvs: g.T, indices: g.I });
    }
  }
  return prims;
}

/** Retractable axles of a model, with the move in the actor frame: [{ side: 'L' | 'R', bone, delta }]. */
function modelRetractions(romfs, stem, model) {
  const anim = `Model/${stem.split('.')[0]}.anim.bfres.zs`;
  if (!romfs.has(anim)) return [];
  let list;
  try { list = retractions(parseSkeletalAnims(romfs.read(anim))); } catch { return []; }
  const world = boneWorlds(model);
  return list.filter((x) => model.bones.some((b) => b.name === x.bone)).map((x) => {
    const bone = model.bones.find((b) => b.name === x.bone);
    const pw = bone.parent >= 0 ? world[bone.parent] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const d = x.delta;
    const delta = [0, 1, 2].map((i) => pw[i * 4] * d[0] + pw[i * 4 + 1] * d[1] + pw[i * 4 + 2] * d[2]).map((v) => Math.round(v * 1e4) / 1e4);
    return { side: x.side, bone: x.bone, delta };
  });
}

function main() {
  const re = new RegExp(process.argv[2] || '.');
  const lib = JSON.parse(fs.readFileSync(path.join(G, 'library', 'library.json'), 'utf8'));
  const r = new RomFS();
  const reader = new ActorReader(r);
  fs.mkdirSync(MC_DIR, { recursive: true });
  fs.mkdirSync(BFRES_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const texDir = path.join(G, 'library', 'textures');
  fs.mkdirSync(texDir, { recursive: true });
  const ctx = { romfs: r, texDir, cache: new Map() };
  const want = new Map(); // model file stem -> actors
  const actorModel = {};
  const partByActor = Object.fromEntries(lib.parts.map((p) => [p.actor, p]));
  for (const p of lib.parts) {
    if (!re.test(p.actor)) continue;
    const pack = reader.open(p.actor);
    const ap = pack.actorParam();
    const mi = ap && ap.Components && pack.get(ap.Components.ModelInfoRef);
    if (!mi || !mi.ModelProjectName || !mi.FmdbName) continue;
    const stem = `${mi.ModelProjectName}.${mi.FmdbName}`;
    if (!r.has(`Model/${stem}.bfres.mc`)) continue;
    actorModel[p.actor] = stem;
    if (!want.has(stem)) want.set(stem, []);
    want.get(stem).push(p.actor);
  }
  let copied = 0;
  for (const stem of want.keys()) {
    const dst = path.join(MC_DIR, stem + '.bfres.mc');
    if (!fs.existsSync(path.join(BFRES_DIR, stem + '.bfres'))) { fs.writeFileSync(dst, r.raw(`Model/${stem}.bfres.mc`)); copied++; }
  }
  if (copied) {
    console.log(`decompressing ${copied} models in WSL (${DISTRO})`);
    execFileSync('wsl.exe', ['-d', DISTRO, '--', 'bash', '-lc', `${MESHCODEC} "${toWsl(MC_DIR)}" "${toWsl(BFRES_DIR)}" > /dev/null`], { stdio: 'inherit' });
    for (const f of fs.readdirSync(MC_DIR)) fs.unlinkSync(path.join(MC_DIR, f));
  }
  const index = {};
  const changed = new Set(); // actors whose model file changed, so their library picture is stale
  let ok = 0;
  for (const [stem, actors] of want) {
    const file = path.join(BFRES_DIR, stem + '.bfres');
    if (!fs.existsSync(file)) { console.log('missing after decompression:', stem); continue; }
    try {
      const bfres = parseBfres(fs.readFileSync(file));
      // Zonai devices and building materials keep 512-pixel textures; the many other parts use 256 to stay small.
      const core = actors.some((a) => ['zonai', 'material'].includes(partByActor[a] && partByActor[a].category));
      // axles the game pulls in on the side that is not glued (animations *_LeftIn / *_RightIn, big tire)
      const retract = modelRetractions(r, stem, bfres.models[0]);
      const prims = buildMesh(bfres, ctx, core ? 512 : 256, new Set(retract.map((x) => x.bone)));
      if (!prims.length) { console.log('no triangles:', stem); continue; }
      const glb = writeGlb(prims, stem);
      const glbPath = path.join(OUT_DIR, stem + '.glb');
      if (!(fs.existsSync(glbPath) && fs.readFileSync(glbPath).equals(glb))) {
        fs.writeFileSync(glbPath, glb);
        for (const a of actors) changed.add(a);
      }
      const tris = prims.reduce((s, p) => s + p.indices.length / 3, 0);
      for (const a of actors) {
        index[a] = { file: 'models/' + stem + '.glb', triangles: tris, materials: [...new Set(prims.map((p) => p.material))] };
        const rel = restRel(reader.open(a), partByActor[a], bfres.models[0]);
        if (rel) index[a].restRel = rel;
        if (retract.length) index[a].retract = retract;
      }
      ok++;
    } catch (e) {
      console.log('failed:', stem, e.message);
    }
  }
  // pictures rendered from the previous models are stale now
  const thumbs = path.join(G, 'library', 'thumbs');
  for (const a of changed) fs.rmSync(path.join(thumbs, a + '.png'), { force: true });
  const idxPath = path.join(G, 'library', 'models.json');
  const prev = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : {};
  fs.writeFileSync(idxPath, JSON.stringify(Object.assign(prev, index), null, 1));
  console.log(`models: ${changed.size} actors changed; ${ok} written for ${Object.keys(index).length} actors (${lib.parts.length - Object.keys(actorModel).length} parts have no model file)`);
}

if (require.main === module) main();
module.exports = { buildMesh, toWsl, MC_DIR, BFRES_DIR, MESHCODEC, DISTRO };
