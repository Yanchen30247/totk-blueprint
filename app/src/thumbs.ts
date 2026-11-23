// Small pictures of parts for the library list. Rendered in the browser from the part's model (or collision shapes) on
// one off-screen renderer, one at a time, only for list rows that come into view. Each picture is also sent to the dev
// server, which keeps it in gamedata/library/thumbs so later sessions load it directly.
import * as THREE from 'three';
import type { PartDef } from './types.ts';
import { buildPartObject } from './geometry.ts';

const SIZE = 96;

export class Thumbnailer {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
  private queue: { def: PartDef; img: HTMLImageElement }[] = [];
  private busy = false;
  private saved = new Set<string>();
  private done = new Map<string, string>();
  private models: Record<string, { file: string }>;
  private observer: IntersectionObserver;

  constructor(models: Record<string, { file: string }>) {
    this.models = models;
    this.scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x40362c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target as HTMLImageElement & { _def?: PartDef };
        this.observer.unobserve(img);
        if (img._def) this.request(img._def, img);
      }
    }, { rootMargin: '200px' });
    fetch('/api/thumbs').then((r) => r.json()).then((j: { files: string[] }) => { for (const f of j.files) this.saved.add(f); }).catch(() => { /* no cache */ });
  }

  /** An <img> that fills itself in once it is scrolled into view. */
  image(def: PartDef): HTMLImageElement {
    const img = document.createElement('img') as HTMLImageElement & { _def?: PartDef };
    img.className = 'thumb';
    img.alt = '';
    img._def = def;
    const known = this.done.get(def.actor);
    if (known) img.src = known;
    else this.observer.observe(img);
    return img;
  }

  private request(def: PartDef, img: HTMLImageElement) {
    const known = this.done.get(def.actor);
    if (known) { img.src = known; return; }
    if (this.saved.has(def.actor + '.png')) {
      const url = `/gamedata/library/thumbs/${encodeURIComponent(def.actor)}.png`;
      this.done.set(def.actor, url);
      img.src = url;
      return;
    }
    this.queue.push({ def, img });
    this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const { def, img } = this.queue.shift()!;
      try {
        const url = await this.render(def);
        if (url) { this.done.set(def.actor, url); img.src = url; }
      } catch { /* leave the row without a picture */ }
    }
    this.busy = false;
  }

  private async render(def: PartDef): Promise<string | null> {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setSize(SIZE, SIZE);
      this.renderer.setClearColor(0x000000, 0);
    }
    const model = this.models[def.actor];
    const obj = buildPartObject(def, model ? `/gamedata/library/${model.file}` : undefined, true);
    if (model) await obj.ready;
    const root = obj.root;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const target = obj.hasModel ? obj.visual : obj.collision;
    box.setFromObject(target, true);
    if (box.isEmpty()) return null;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = new THREE.Vector3(1, 0.75, 1.3).normalize();
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.02;
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 4;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(centre);
    this.scene.add(root);
    this.renderer!.render(this.scene, this.camera);
    this.scene.remove(root);
    const blob: Blob | null = await new Promise((res) => this.renderer!.domElement.toBlob(res, 'image/png'));
    if (!blob) return null;
    // keep it for later sessions (the dev server writes gamedata/library/thumbs/<actor>.png)
    fetch(`/api/thumbs/${encodeURIComponent(def.actor)}.png`, { method: 'PUT', body: blob }).then((r) => { if (r.ok) this.saved.add(def.actor + '.png'); }).catch(() => { /* not cached */ });
    return URL.createObjectURL(blob);
  }
}
