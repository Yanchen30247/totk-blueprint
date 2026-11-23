// The 3D view: parts, selection, move/rotate gizmo, pivot markers, bond lines and the centre of mass.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Blueprint, Mat34, ModelInfo, Vec3 } from './types.ts';
import { PartIndex, axleOffsets, bodyPose, blueprintAabb } from './blueprint.ts';
import { apply, round } from './math.ts';
import { applyDisplay, setAxleOffsets, setDisplayMode, buildPartObject, pivotColours, toMatrix4, type DisplayMode, type PartObject } from './geometry.ts';

export interface PartMove { id: string; pos: Vec3; rotDeg: Vec3 }

export interface ViewportEvents {
  /** A click on a part (or on nothing); additive with Ctrl/Shift held. */
  select(id: string | null, additive: boolean): void;
  /** Alt + drag: the parts whose bounds' centre lies in the rectangle. */
  boxSelect(ids: string[], additive: boolean): void;
  /** Live while dragging the gizmo: the new poses of every selected part. */
  transform(moves: PartMove[]): void;
  /** Once when a drag ends. */
  transformEnd(): void;
  pivot(id: string, pivot: number): void;
  hoverPivot(id: string | null, pivot: number | null): void;
  /** A click on a part's surface in snap mode. */
  surface(hit: SurfaceHit): void;
  hoverSurface(hit: SurfaceHit | null): void;
}

/** A point on a part's collision surface, in the part's own frame. */
export interface SurfaceHit {
  id: string;
  /** body slot of the clicked shape */
  slot: number;
  point: Vec3;
  /** outward normal of the clicked face */
  normal: Vec3;
  /** centre of the flat face the point lies on (all coplanar triangles of that shape) */
  centre: Vec3;
}

interface Entry { actor: string; obj: PartObject }

const D2R = Math.PI / 180;

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private entries = new Map<string, Entry>();
  /** The primary part of the selection (gizmo in single selection, reference for alignment). */
  private selected: string | null = null;
  private selection: string[] = [];
  private selBoxes = new THREE.Group();
  /** Gizmo target while several parts are selected: sits at the centre of their bounds. */
  private groupPivot = new THREE.Object3D();
  private dragStart: { pivot: THREE.Matrix4; parts: Map<string, THREE.Matrix4> } | null = null;
  private boxSel: { x: number; y: number; el: HTMLDivElement } | null = null;
  private bondLines: THREE.LineSegments;
  private comMarker: THREE.Mesh;
  private grid: THREE.GridHelper;
  private pivotsVisible = false;
  private sourcePivot: { id: string; pivot: number } | null = null;
  private hover: THREE.Object3D | null = null;
  private dragging = false;
  private hoverMarker: THREE.Group;
  private sourceMarker: THREE.Group;
  private labelRenderer = new CSS2DRenderer();
  private overlays = new Map<string, THREE.Group>();

  private host: HTMLElement;
  private idx: PartIndex;
  private ev: ViewportEvents;
  private models: Record<string, ModelInfo>;

  constructor(host: HTMLElement, idx: PartIndex, models: Record<string, ModelInfo>, ev: ViewportEvents) {
    this.host = host;
    this.idx = idx;
    this.models = models;
    this.ev = ev;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1d2328);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
    this.camera.position.set(8, 6, 10);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.target.set(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a3226, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(12, 20, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(60, 60, 0x5a6670, 0x343c43);
    this.scene.add(this.grid);
    const axes = new THREE.AxesHelper(1.5);
    (axes.material as THREE.Material).depthTest = false;
    axes.renderOrder = 5;
    this.scene.add(axes);
    this.scene.add(this.selBoxes, this.groupPivot);

    this.bondLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }));
    this.bondLines.renderOrder = 8;
    this.scene.add(this.bondLines);
    this.comMarker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4d6d, depthTest: false, transparent: true }));
    this.comMarker.renderOrder = 9;
    this.scene.add(this.comMarker);
    this.hoverMarker = anchorMarker(0xffffff);
    this.sourceMarker = anchorMarker(0x3dd6ff);
    this.scene.add(this.hoverMarker, this.sourceMarker);
    const ld = this.labelRenderer.domElement;
    Object.assign(ld.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
    host.appendChild(ld);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = !!e.value;
      this.orbit.enabled = !e.value;
      if (e.value) {
        const parts = new Map<string, THREE.Matrix4>();
        for (const id of this.selection) {
          const en = this.entries.get(id);
          if (en) parts.set(id, en.obj.root.matrix.clone());
        }
        this.groupPivot.updateMatrix();
        this.dragStart = { pivot: this.groupPivot.matrix.clone(), parts };
      } else {
        this.dragStart = null;
        if (this.selection.length) this.ev.transformEnd();
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      const poseOf = (id: string, o: THREE.Object3D): PartMove => {
        const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'ZYX');
        return { id, pos: [round(o.position.x, 5), round(o.position.y, 5), round(o.position.z, 5)], rotDeg: [round(e.x / D2R, 4), round(e.y / D2R, 4), round(e.z / D2R, 4)] };
      };
      if (this.selection.length === 1) {
        const id = this.selection[0];
        this.ev.transform([poseOf(id, this.entries.get(id)!.obj.root)]);
        return;
      }
      // Several parts: apply the pivot's motion since the drag started to every selected part, rigidly.
      if (!this.dragStart) return;
      this.groupPivot.updateMatrix();
      const delta = this.groupPivot.matrix.clone().multiply(this.dragStart.pivot.clone().invert());
      const moves: PartMove[] = [];
      const sc = new THREE.Vector3();
      for (const [id, start] of this.dragStart.parts) {
        const o = this.entries.get(id)?.obj.root;
        if (!o) continue;
        new THREE.Matrix4().multiplyMatrices(delta, start).decompose(o.position, o.quaternion, sc);
        moves.push(poseOf(id, o));
      }
      this.ev.transform(moves);
    });

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.orbit.update();
      for (const b of this.selBoxes.children as THREE.Box3Helper[]) {
        const en = this.entries.get(b.userData.id);
        if (en) b.box.setFromObject(en.obj.root, true);
      }
      this.renderer.render(this.scene, this.camera);
      if ([...this.overlays.values()].some((g) => g.children.length)) this.labelRenderer.render(this.scene, this.camera);
      else if (this.labelRenderer.domElement.childElementCount) this.labelRenderer.domElement.replaceChildren();
    };
    loop();
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Bring the scene in line with the blueprint (rebuilds only parts whose actor changed). */
  sync(bp: Blueprint, com: Vec3 | null) {
    const ids = new Set(bp.parts.map((p) => p.id));
    for (const [id, e] of this.entries) {
      if (!ids.has(id)) {
        if (this.gizmo.object === e.obj.root) this.gizmo.detach();
        this.scene.remove(e.obj.root);
        this.entries.delete(id);
      }
    }
    for (const p of bp.parts) {
      let e = this.entries.get(p.id);
      if (!e || e.actor !== p.actor) {
        if (e) this.scene.remove(e.obj.root);
        const model = this.models[p.actor];
        const obj = buildPartObject(this.idx.get(p.actor), model ? `/gamedata/library/${model.file}` : undefined);
        obj.root.traverse((o) => { o.userData.partId = p.id; });
        obj.pivots.visible = this.pivotsVisible;
        this.scene.add(obj.root);
        e = { actor: p.actor, obj };
        this.entries.set(p.id, e);
      }
      if (!(this.dragging && this.selection.includes(p.id))) {
        e.obj.root.position.set(p.pos[0], p.pos[1], p.pos[2]);
        e.obj.root.quaternion.setFromEuler(new THREE.Euler(p.rotDeg[0] * D2R, p.rotDeg[1] * D2R, p.rotDeg[2] * D2R, 'ZYX'));
      }
      // the big tire shows its axle only on the side it is glued to, as in the game
      const retract = this.models[p.actor] && this.models[p.actor].retract;
      if (retract) setAxleOffsets(e.obj, axleOffsets(bp, this.idx, p, retract));
    }
    // bond lines between the bonded bodies' shape centres
    const pts: number[] = [];
    const centre = (id: string, slot: number) => {
      const p = bp.parts.find((x) => x.id === id);
      if (!p) return null;
      const def = this.idx.get(p.actor);
      const body = def && def.bodies.find((b) => b.slot === slot);
      return apply(bodyPose(p, def, slot), body ? body.shape.center : [0, 0, 0]);
    };
    for (const b of bp.bonds) {
      const A = centre(b.a, b.aBody), B = centre(b.b, b.bBody);
      if (A && B) pts.push(...A, ...B);
    }
    this.bondLines.geometry.dispose();
    this.bondLines.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.comMarker.visible = !!com && bp.parts.length > 0;
    if (com) this.comMarker.position.set(com[0], com[1], com[2]);
    this.refreshPivotColours();
  }

  /** Show a selection: boxes around every selected part, the primary part's axes, and the gizmo. */
  select(ids: string[], primary: string | null = ids.length ? ids[ids.length - 1] : null) {
    for (const e of this.entries.values()) e.obj.axes.visible = false;
    this.selection = ids.filter((id) => this.entries.has(id));
    this.selected = primary && this.entries.has(primary) ? primary : this.selection[this.selection.length - 1] ?? null;
    for (const c of [...this.selBoxes.children]) this.selBoxes.remove(c);
    for (const id of this.selection) {
      const b = new THREE.Box3Helper(new THREE.Box3(), id === this.selected ? 0x3dd6ff : 0x8fb8ff);
      b.userData.id = id;
      this.selBoxes.add(b);
    }
    if (this.selected) this.entries.get(this.selected)!.obj.axes.visible = true;
    if (this.dragging) return;
    if (this.selection.length === 1) {
      this.gizmo.attach(this.entries.get(this.selection[0])!.obj.root);
    } else if (this.selection.length > 1) {
      const box = new THREE.Box3();
      for (const id of this.selection) box.expandByObject(this.entries.get(id)!.obj.root, true);
      box.getCenter(this.groupPivot.position);
      // On the move grid, so that the gizmo's snapping (which rounds the target's absolute position) moves the group
      // by whole steps.
      if (this.snapStep > 0) this.groupPivot.position.set(...this.groupPivot.position.toArray().map((v) => Math.round(v / this.snapStep) * this.snapStep) as [number, number, number]);
      this.groupPivot.quaternion.copy(this.entries.get(this.selected!)!.obj.root.quaternion);
      this.groupPivot.updateMatrixWorld(true);
      this.gizmo.attach(this.groupPivot);
    } else {
      this.gizmo.detach();
    }
  }

  private snapStep = 0;

  setGizmo(mode: 'translate' | 'rotate', space: 'local' | 'world', step: number, angle: number) {
    this.snapStep = step;
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(space);
    this.gizmo.setTranslationSnap(step > 0 ? step : null);
    this.gizmo.setRotationSnap(angle > 0 ? angle * D2R : null);
  }

  setDisplay(mode: DisplayMode) {
    setDisplayMode(mode);
    for (const e of this.entries.values()) applyDisplay(e.obj, mode);
  }

  showPivots(on: boolean) {
    this.pivotsVisible = on;
    if (!on) { this.hoverMarker.visible = false; this.sourceMarker.visible = false; }
    for (const e of this.entries.values()) e.obj.pivots.visible = on;
    this.gizmo.enabled = !on;
    this.gizmo.getHelper().visible = !on;
  }

  setSourcePivot(src: { id: string; pivot: number } | null) {
    this.sourcePivot = src;
    this.refreshPivotColours();
  }

  private refreshPivotColours() {
    for (const [id, e] of this.entries) {
      const def = this.idx.get(e.actor);
      e.obj.pivots.children.forEach((g, i) => {
        const isSrc = this.sourcePivot && this.sourcePivot.id === id && this.sourcePivot.pivot === i;
        const isHover = this.hover === g;
        const strong = def && def.pivots[i] && def.pivots[i].strong;
        const c = isHover ? pivotColours.hover : isSrc ? pivotColours.source : strong ? pivotColours.strong : pivotColours.idle;
        g.children.forEach((m) => ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(c));
        g.scale.setScalar(isSrc || isHover ? 1.6 : 1);
      });
    }
  }

  frame(bp: Blueprint) {
    const box = blueprintAabb(bp, this.idx);
    const c = new THREE.Vector3((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
    const size = Math.max(2, box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    this.orbit.target.copy(c);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (!isFinite(dir.x)) dir.set(0.6, 0.45, 0.65);
    this.camera.position.copy(c).add(dir.multiplyScalar(size * 1.6 + 2));
    this.grid.position.y = Math.min(0, box[1]);
  }

  setGridY(y: number) { this.grid.position.y = y; }

  /** Client coordinates of a part's pivot marker (debugging and automated checks). */
  pivotScreen(id: string, pivot: number): { x: number; y: number } | null {
    const e = this.entries.get(id);
    const g = e && e.obj.pivots.children[pivot];
    if (!g) return null;
    g.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  /**
   * An overlay layer (measurements, alignment guides): line segments (solid or dashed), dots and text labels at world
   * positions. Each named layer replaces its previous content; null clears it. Labels are HTML drawn by a CSS2DRenderer.
   */
  showOverlay(name: string, d: Overlay | null) {
    let g = this.overlays.get(name);
    if (!g) { g = new THREE.Group(); this.overlays.set(name, g); this.scene.add(g); }
    for (const c of [...g.children]) {
      g.remove(c);
      if ((c as THREE.LineSegments).isLineSegments) {
        (c as THREE.LineSegments).geometry.dispose();
        ((c as THREE.LineSegments).material as THREE.Material).dispose();
      }
    }
    if (!d) return;
    // one LineSegments per style
    const styles = new Map<string, { colour: number; dashed: boolean; opacity: number; pts: number[] }>();
    for (const l of d.lines) {
      const key = `${l.colour}|${!!l.dashed}|${l.opacity ?? 1}`;
      let st = styles.get(key);
      if (!st) { st = { colour: l.colour, dashed: !!l.dashed, opacity: l.opacity ?? 1, pts: [] }; styles.set(key, st); }
      st.pts.push(...l.a, ...l.b);
    }
    for (const st of styles.values()) {
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(st.pts, 3));
      const mat = st.dashed
        ? new THREE.LineDashedMaterial({ color: st.colour, dashSize: 0.08, gapSize: 0.06, depthTest: false, transparent: true, opacity: st.opacity })
        : new THREE.LineBasicMaterial({ color: st.colour, depthTest: false, transparent: true, opacity: st.opacity });
      const line = new THREE.LineSegments(geo, mat);
      if (st.dashed) line.computeLineDistances();
      line.renderOrder = 12;
      g.add(line);
    }
    for (const dt of d.dots || []) {
      const dot = new THREE.Mesh(dotGeo, dotMaterial(dt.colour));
      dot.position.set(dt.at[0], dt.at[1], dt.at[2]);
      dot.scale.setScalar(dt.size ?? 1);
      dot.renderOrder = 13;
      g.add(dot);
    }
    for (const l of d.labels || []) {
      const el = document.createElement('div');
      el.className = 'label3d ' + l.cls;
      el.textContent = l.text;
      const o = new CSS2DObject(el);
      o.position.set(l.at[0], l.at[1], l.at[2]);
      g.add(o);
    }
  }

  /** The measurement layer of the details mode; segment ends get dots. */
  showDetails(d: { lines: { a: Vec3; b: Vec3; colour: number }[]; labels: { at: Vec3; text: string; cls: string }[] } | null) {
    if (!d) { this.showOverlay('details', null); return; }
    this.showOverlay('details', {
      lines: d.lines,
      dots: d.lines.flatMap((l) => [{ at: l.a, colour: l.colour }, { at: l.b, colour: l.colour }]),
      labels: d.labels,
    });
  }

  /**
   * Closest points between the solid collision shapes of two parts (only the given body slots when they are set), in
   * world coordinates: vertex-to-triangle distances both ways. A distance near 0 means touching or overlapping.
   */
  closest(idA: string, slotA: number | null, idB: string, slotB: number | null): { a: Vec3; b: Vec3; gap: number } | null {
    const tris = (id: string, slot: number | null) => {
      const e = this.entries.get(id);
      if (!e) return null;
      e.obj.root.updateWorldMatrix(true, true);
      let meshes = e.obj.meshes.filter((m) => slot == null || m.userData.slot === slot);
      if (!meshes.length) meshes = e.obj.meshes;
      const out: THREE.Triangle[] = [];
      const verts: THREE.Vector3[] = [];
      for (const m of meshes) {
        const geo = m.geometry as THREE.BufferGeometry;
        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
        const index = geo.getIndex();
        const w: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++) w.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
        verts.push(...w);
        const n = index ? index.count : pos.count;
        for (let t = 0; t < n; t += 3) {
          const ia = index ? index.getX(t) : t, ib = index ? index.getX(t + 1) : t + 1, ic = index ? index.getX(t + 2) : t + 2;
          out.push(new THREE.Triangle(w[ia], w[ib], w[ic]));
        }
      }
      return { tris: out, verts };
    };
    const A = tris(idA, slotA), B = tris(idB, slotB);
    if (!A || !B || !A.verts.length || !B.verts.length) return null;
    let best = Infinity;
    let pa = new THREE.Vector3(), pb = new THREE.Vector3();
    const q = new THREE.Vector3();
    const scan = (verts: THREE.Vector3[], tris: THREE.Triangle[], flip: boolean) => {
      for (const v of verts) {
        for (const t of tris) {
          t.closestPointToPoint(v, q);
          const d = q.distanceToSquared(v);
          if (d < best) { best = d; if (flip) { pa = q.clone(); pb = v.clone(); } else { pa = v.clone(); pb = q.clone(); } }
        }
      }
    };
    scan(A.verts, B.tris, false);
    scan(B.verts, A.tris, true);
    const r = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
    return { a: r(pa), b: r(pb), gap: Math.sqrt(best) };
  }

  /** Show a marker at an anchor (a frame in a part's own frame, +X out of the surface); null hides it. */
  setAnchorMarker(kind: 'hover' | 'source', id: string | null, anchor: Mat34 | null) {
    const m = kind === 'hover' ? this.hoverMarker : this.sourceMarker;
    const e = id ? this.entries.get(id) : undefined;
    if (!e || !anchor) { m.visible = false; return; }
    e.obj.root.updateWorldMatrix(true, false);
    m.matrix.copy(e.obj.root.matrixWorld).multiply(toMatrix4(anchor));
    m.visible = true;
  }

  /** The surface under a ray hit, in the part's frame, with the centre of the flat face it belongs to. */
  private surfaceFromHit(hit: THREE.Intersection): SurfaceHit | null {
    const mesh = hit.object as THREE.Mesh;
    const id = mesh.userData.partId as string;
    const e = this.entries.get(id);
    if (!e || !hit.face) return null;
    e.obj.root.updateWorldMatrix(true, true);
    const toPart = e.obj.root.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const index = geo.getIndex();
    const n0 = hit.face.normal.clone();
    const d0 = n0.dot(new THREE.Vector3().fromBufferAttribute(pos, hit.face.a));
    const tris = index ? index.count / 3 : pos.count / 3;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), tn = new THREE.Vector3(), t2 = new THREE.Vector3();
    const seen = new Map<string, THREE.Vector3>();
    for (let t = 0; t < tris; t++) {
      const ia = index ? index.getX(3 * t) : 3 * t, ib = index ? index.getX(3 * t + 1) : 3 * t + 1, ic = index ? index.getX(3 * t + 2) : 3 * t + 2;
      va.fromBufferAttribute(pos, ia); vb.fromBufferAttribute(pos, ib); vc.fromBufferAttribute(pos, ic);
      tn.subVectors(vc, vb).cross(t2.subVectors(va, vb)).normalize();
      if (tn.dot(n0) < 0.999 || Math.abs(n0.dot(va) - d0) > 1e-3) continue;
      for (const v of [va, vb, vc]) seen.set(`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`, v.clone());
    }
    const centre = new THREE.Vector3();
    for (const v of seen.values()) centre.add(v);
    if (seen.size) centre.multiplyScalar(1 / seen.size);
    centre.applyMatrix4(toPart);
    const point = hit.point.clone().applyMatrix4(e.obj.root.matrixWorld.clone().invert());
    const normal = n0.applyMatrix3(new THREE.Matrix3().getNormalMatrix(toPart)).normalize();
    const r = (v: THREE.Vector3): Vec3 => [round(v.x, 5), round(v.y, 5), round(v.z, 5)];
    return { id, slot: mesh.userData.slot ?? 0, point: r(point), normal: r(normal), centre: r(centre) };
  }

  private pick(ev: PointerEvent, pivots: boolean): { id: string; pivot: number | null; point: THREE.Vector3; surface: SurfaceHit | null } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    if (pivots) {
      const markers: THREE.Object3D[] = [];
      for (const e of this.entries.values()) e.obj.pivots.traverse((o) => { if ((o as THREE.Mesh).isMesh) markers.push(o); });
      const hit = ray.intersectObjects(markers, false)[0];
      if (hit) return { id: hit.object.userData.partId, pivot: hit.object.userData.pivot, point: hit.point, surface: null };
    }
    const meshes: THREE.Object3D[] = [];
    for (const e of this.entries.values()) meshes.push(...e.obj.meshes);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? { id: hit.object.userData.partId, pivot: null, point: hit.point, surface: pivots ? this.surfaceFromHit(hit) : null } : null;
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    // Alt + drag starts a rectangle selection. Listening on the host in the capture phase runs this before the orbit
    // controls see the press, so the view does not turn.
    this.host.addEventListener('pointerdown', (e) => {
      if (e.target !== el) return;
      if (e.altKey && e.button === 0 && !this.pivotsVisible) {
        e.stopPropagation();
        down = null;
        // Alt + drag: rectangle selection (the orbit stays still meanwhile)
        this.orbit.enabled = false;
        const r = this.host.getBoundingClientRect();
        const box = document.createElement('div');
        box.className = 'boxsel';
        Object.assign(box.style, { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px`, width: '0px', height: '0px' });
        this.host.appendChild(box);
        this.boxSel = { x: e.clientX, y: e.clientY, el: box };
      }
    }, { capture: true });
    window.addEventListener('pointermove', (e) => {
      if (!this.boxSel) return;
      const r = this.host.getBoundingClientRect();
      const x0 = Math.min(this.boxSel.x, e.clientX), y0 = Math.min(this.boxSel.y, e.clientY);
      Object.assign(this.boxSel.el.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${Math.abs(e.clientX - this.boxSel.x)}px`, height: `${Math.abs(e.clientY - this.boxSel.y)}px` });
    });
    window.addEventListener('pointerup', (e) => {
      if (!this.boxSel) return;
      const b = this.boxSel;
      this.boxSel = null;
      b.el.remove();
      this.orbit.enabled = true;
      down = null;
      const x0 = Math.min(b.x, e.clientX), x1 = Math.max(b.x, e.clientX), y0 = Math.min(b.y, e.clientY), y1 = Math.max(b.y, e.clientY);
      if (x1 - x0 < 4 && y1 - y0 < 4) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ids: string[] = [];
      const c = new THREE.Vector3();
      for (const [id, en] of this.entries) {
        new THREE.Box3().setFromObject(en.obj.root, true).getCenter(c).project(this.camera);
        const sx = r.left + ((c.x + 1) / 2) * r.width, sy = r.top + ((1 - c.y) / 2) * r.height;
        if (c.z < 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(id);
      }
      this.ev.boxSelect(ids, e.ctrlKey || e.shiftKey || e.metaKey);
    });
    el.addEventListener('pointerup', (e) => {
      if (!down || this.dragging) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4 || e.button !== 0) return;
      const hit = this.pick(e, this.pivotsVisible);
      if (hit && hit.pivot != null) this.ev.pivot(hit.id, hit.pivot);
      else if (hit && hit.surface) this.ev.surface(hit.surface);
      else if (!this.gizmo.dragging) this.ev.select(hit ? hit.id : null, e.ctrlKey || e.shiftKey || e.metaKey);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pivotsVisible || e.buttons) return;
      const hit = this.pick(e, true);
      const g = hit && hit.pivot != null ? this.entries.get(hit.id)!.obj.pivots.children[hit.pivot] : null;
      if (g !== this.hover) {
        this.hover = g;
        this.refreshPivotColours();
        if (g) this.ev.hoverPivot(hit!.id, hit!.pivot);
      }
      if (!g) this.ev.hoverSurface(hit && hit.surface ? hit.surface : null);
    });
  }
}

/** A ring lying on the surface, an arrow along the outward normal (+X of the anchor) and a tick along its +Y. */
function anchorMarker(colour: number): THREE.Group {
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.visible = false;
  const mat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.13, 32).rotateY(Math.PI / 2), mat);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 12).rotateZ(-Math.PI / 2).translate(0.12, 0, 0), mat);
  const up = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.12, 0.01).translate(0, 0.1, 0), mat);
  ring.renderOrder = arrow.renderOrder = up.renderOrder = 11;
  g.add(ring, arrow, up);
  return g;
}

const dotGeo = new THREE.SphereGeometry(0.035, 10, 8);
const dotMaterials = new Map<number, THREE.MeshBasicMaterial>();
function dotMaterial(colour: number) {
  let m = dotMaterials.get(colour);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true }); dotMaterials.set(colour, m); }
  return m;
}

export interface Overlay {
  lines: { a: Vec3; b: Vec3; colour: number; dashed?: boolean; opacity?: number }[];
  dots?: { at: Vec3; colour: number; size?: number }[];
  labels?: { at: Vec3; text: string; cls: string }[];
}
