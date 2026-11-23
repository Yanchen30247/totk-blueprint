// three.js objects for parts: the game's model (GLB built by tools/build_models.js) and the collision shapes.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Mat34, PartDef, Prim, Vec3 } from './types.ts';
import { bodyRel, isSolid } from './blueprint.ts';
import { pose } from './math.ts';

export function toMatrix4(m: Mat34): THREE.Matrix4 {
  return new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
}

const MATERIAL_COLOURS: Record<string, number> = {
  Wood: 0xb07a45, Metal: 0x8d99a6, MetalSlip: 0x8d99a6, MetalNoSlip: 0x8d99a6, Stone: 0x9fb5a8, StoneSlip: 0x9fb5a8,
  StoneNoSlip: 0x7f9488, WireNet: 0x6c7a70, Glass: 0x8fd3e8, Cloth: 0xd8c9a3, Rope: 0xc2a878, Bone: 0xe6e0cf, Cart: 0x9fb5a8,
  SlipBoard: 0x9fb5a8, Ice: 0xc8ecff, Meat: 0xc47a6a, Vegetable: 0x8bbd5a, Bomb: 0x5a6b8c,
};
const ZONAI_TINT = 0x3fb6a8;

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function surface(material: string, zonai: boolean): THREE.MeshStandardMaterial {
  const key = material + (zonai ? ':z' : '');
  let m = matCache.get(key);
  if (!m) {
    const base = new THREE.Color(MATERIAL_COLOURS[material] ?? 0xaaaaaa);
    if (zonai && material.startsWith('Stone')) base.lerp(new THREE.Color(ZONAI_TINT), 0.35);
    m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.75, metalness: material.startsWith('Metal') ? 0.35 : 0.05, flatShading: true });
    matCache.set(key, m);
  }
  return m;
}
const helperMaterial = new THREE.MeshBasicMaterial({ color: 0x8888ff, wireframe: true, transparent: true, opacity: 0.25 });

function v(a: Vec3) { return new THREE.Vector3(a[0], a[1], a[2]); }

/** A geometry along +Y from a to b, placed between the two points. */
function alongAxis(geo: THREE.BufferGeometry, a: Vec3, b: Vec3): THREE.BufferGeometry {
  const A = v(a), B = v(b);
  const dir = B.clone().sub(A);
  const len = dir.length() || 1e-6;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  geo.applyMatrix4(new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  void len;
  return geo;
}

function primGeometry(pr: Prim): THREE.BufferGeometry | null {
  const r = pr.radius || 0.05;
  switch (pr.type) {
    case 'Box': {
      const h = pr.half || [0.5, 0.5, 0.5], c = pr.center || [0, 0, 0];
      return new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2).translate(c[0], c[1], c[2]);
    }
    case 'Sphere': {
      const c = pr.center || [0, 0, 0];
      return new THREE.SphereGeometry(r, 20, 14).translate(c[0], c[1], c[2]);
    }
    case 'Cylinder': {
      const len = v(pr.a!).distanceTo(v(pr.b!));
      return alongAxis(new THREE.CylinderGeometry(r, r, len, 24), pr.a!, pr.b!);
    }
    case 'Capsule': {
      const len = v(pr.a!).distanceTo(v(pr.b!));
      return alongAxis(new THREE.CapsuleGeometry(r, len, 6, 16), pr.a!, pr.b!);
    }
    case 'Polytope': {
      const pts = (pr.verts || []).map(v);
      if (pts.length < 4) return null;
      try { return new ConvexGeometry(pts); } catch { return null; }
    }
    case 'Prism': {
      const h = pr.height || 1;
      return new THREE.CylinderGeometry(r, r, h, 6).translate(0, h / 2, 0);
    }
  }
  return null;
}

export interface PartObject {
  root: THREE.Group;
  /** Collision meshes, used for picking whether shown or not. */
  meshes: THREE.Mesh[];
  pivots: THREE.Group;
  collision: THREE.Group;
  /** The game's model (loaded asynchronously). */
  visual: THREE.Group;
  hasModel: boolean;
  /** The part's own axes, shown while it is selected. */
  axes: THREE.AxesHelper;
  /** Settles once the model has loaded (or failed to). */
  ready: Promise<void>;
  /** Model meshes riding on a retractable axle bone (big tire), by bone name. */
  axles: Map<string, THREE.Object3D[]>;
  /** Where each retractable axle's meshes should sit (bone -> offset); applied again when the model arrives. */
  axleOffsets: Map<string, Vec3>;
}

/** Move retractable axles: `offsets` gives each axle bone's offset from rest (missing = rest). */
export function setAxleOffsets(obj: PartObject, offsets: Map<string, Vec3>) {
  obj.axleOffsets = offsets;
  for (const [bone, list] of obj.axles) {
    const d = offsets.get(bone) || [0, 0, 0];
    for (const m of list) m.position.set(d[0], d[1], d[2]);
  }
}

export type DisplayMode = 'model' | 'collision' | 'both';
let displayMode: DisplayMode = 'model';
/** The display mode that parts created from now on start with. */
export function setDisplayMode(mode: DisplayMode) { displayMode = mode; }
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true, transparent: true, opacity: 0.35, depthTest: false });

/** Show the model, the collision shapes, or the model with the collision shapes as wireframe. */
export function applyDisplay(obj: PartObject, mode: DisplayMode = displayMode, remember = true) {
  if (remember) displayMode = mode;
  const showModel = obj.hasModel && mode !== 'collision';
  obj.visual.visible = showModel;
  obj.collision.visible = !showModel || mode === 'both';
  obj.collision.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData.solidMaterial) return;
    m.material = showModel && mode === 'both' ? wireMaterial : m.userData.solidMaterial;
    m.renderOrder = showModel && mode === 'both' ? 6 : 0;
  });
}

const modelCache = new Map<string, Promise<THREE.Group | null>>();
const loader = new GLTFLoader();
function loadModel(url: string): Promise<THREE.Group | null> {
  let p = modelCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => {
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = m.receiveShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.flatShading = false;
        // Zonai light strips glow in game. Materials with an emission texture use it; untextured light materials get a
        // little emission so they stand out.
        if (!mat.emissiveMap && !mat.map && /light/i.test(mat.name)) { mat.emissive = mat.color.clone(); mat.emissiveIntensity = 0.5; }
      });
      return gltf.scene;
    }).catch(() => null);
    modelCache.set(url, p);
  }
  return p;
}

/**
 * The object for one part: the game model (when one was built), the collision shapes per body (sub bodies at their
 * measured offsets) and hidden pivot markers.
 */
export function buildPartObject(def: PartDef | undefined, modelUrl?: string, forThumbnail = false): PartObject {
  const root = new THREE.Group();
  const collision = new THREE.Group();
  const visual = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  if (!def) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshStandardMaterial({ color: 0xff5577 }));
    m.userData.solidMaterial = m.material;
    collision.add(m);
    meshes.push(m);
  } else {
    for (const b of def.bodies) {
      if (b.slot < 0) continue;
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(toMatrix4(bodyRel(def, b.slot)));
      for (const pr of b.shape.prims) {
        const geo = primGeometry(pr);
        if (!geo) continue;
        geo.applyMatrix4(toMatrix4(pose(pr.offsetT, pr.offsetR)));
        const solid = isSolid(pr);
        const mesh = new THREE.Mesh(geo, solid ? surface(pr.material, def.category === 'zonai') : helperMaterial);
        mesh.castShadow = solid;
        mesh.receiveShadow = solid;
        mesh.userData.slot = b.slot;
        if (solid) { meshes.push(mesh); mesh.userData.solidMaterial = mesh.material; }
        g.add(mesh);
      }
      collision.add(g);
    }
  }
  const pivots = new THREE.Group();
  pivots.visible = false;
  if (def) def.pivots.forEach((pv, i) => pivots.add(pivotMarker(def, i)));
  const axes = new THREE.AxesHelper(1.2);
  (axes.material as THREE.Material).depthTest = false;
  axes.renderOrder = 7;
  axes.visible = false;
  root.add(collision, visual, pivots, axes);
  const obj: PartObject = { root, meshes, pivots, collision, visual, hasModel: false, axes, ready: Promise.resolve(), axles: new Map(), axleOffsets: new Map() };
  const show = () => (forThumbnail ? applyDisplay(obj, 'model', false) : applyDisplay(obj));
  show();
  if (modelUrl) {
    obj.ready = loadModel(modelUrl).then((scene) => {
      if (!scene) return;
      const inst = scene.clone(true);
      inst.traverse((o) => {
        o.userData.partId = root.userData.partId;
        // primitives the model builder split off onto a retractable axle bone (GLB primitive extras -> geometry.userData)
        const bone = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry.userData.bone : undefined;
        if (bone) {
          if (!obj.axles.has(bone)) obj.axles.set(bone, []);
          obj.axles.get(bone)!.push(o);
        }
      });
      visual.add(inst);
      setAxleOffsets(obj, obj.axleOffsets);
      obj.hasModel = true;
      show();
    });
  }
  return obj;
}

const pivotGeo = new THREE.ConeGeometry(0.06, 0.18, 10).rotateZ(-Math.PI / 2).translate(0.09, 0, 0);
const pivotBall = new THREE.SphereGeometry(0.045, 10, 8);
export const pivotColours = { idle: 0xffc23d, strong: 0xff7a3d, source: 0x3dd6ff, hover: 0xffffff };

function pivotMarker(def: PartDef, i: number): THREE.Group {
  const pv = def.pivots[i];
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.matrix.copy(toMatrix4(bodyRel(def, pv.body)).multiply(toMatrix4(pose(pv.pos, pv.rotDeg))));
  const mat = new THREE.MeshBasicMaterial({ color: pv.strong ? pivotColours.strong : pivotColours.idle, depthTest: false, transparent: true });
  const cone = new THREE.Mesh(pivotGeo, mat);
  const ball = new THREE.Mesh(pivotBall, mat);
  cone.renderOrder = ball.renderOrder = 10;
  g.add(cone, ball);
  g.userData.pivot = i;
  cone.userData.pivot = i;
  ball.userData.pivot = i;
  return g;
}
