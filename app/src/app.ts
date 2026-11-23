// Editor state, undo history and the panels around the 3D view.
import type { Blueprint, BPPart, Draft, Library, Mat34, PartDef, Vec3 } from './types.ts';
import {
  PartIndex, addBond, alignParts, alignments, bondNearest, distributeParts, duplicateParts, groupCentre, removeBondsWithin, rotationAbout, transformParts, type AlignMode, blueprintAabb, blueprintToCai, measureBond, partCom, partLocalBounds, type Alignment, partAabb, partSize, partTilt, type BondMeasure, partPose, pivotAnchor, quantizeOnFace, snapToAnchor, surfaceAnchor, caiToBlueprint, emptyBlueprint, hasBond, nextId, removeBond, removeBondsOf, removePart, slotCount, stats, validate,
  type Issue,
} from './blueprint.ts';
import { parseCai, writeCai, MAX_PARTS } from './cai.ts';
import { Viewport, type Overlay, type PartMove, type SurfaceHit } from './viewport.ts';
import { apply, inv, mul, pose } from './math.ts';
import type { DisplayMode } from './geometry.ts';
import { round } from './math.ts';
import { Thumbnailer } from './thumbs.ts';
import { contactBond, contactIssues, fixBondBodies } from './contact.ts';
import { lang, nameSource, partCaption, partName, setLang, tr, unnamed } from './i18n.ts';

/** Library tabs, in list order. */
const CATEGORIES = [['all', tr('全部', 'All')], ['zonai', tr('左纳乌装置', 'Zonai devices')], ['material', tr('建材', 'Materials')],
  ['field', tr('野外物件', 'Field objects')], ['shrine', tr('神庙机关', 'Shrine objects')], ['container', tr('宝箱·箱子', 'Chests & crates')],
  ['weapon', tr('武器', 'Weapons')], ['item', tr('素材道具', 'Items')], ['other', tr('其他', 'Other')]] as const;

const AUTOSAVE_KEY = 'totk-blueprint:autosave';
const SETTINGS_KEY = 'totk-blueprint:settings';

type Mode = 'select' | 'snap' | 'bond' | 'unbond';

/** A frame on a part (+X out of the surface), from one of its pivots or from a clicked surface. */
interface Anchor {
  id: string;
  frame: Mat34;
  slot: number;
  pivot: number | null;
  label: string;
}

interface Settings {
  gizmo: 'translate' | 'rotate';
  space: 'local' | 'world';
  step: number;
  angle: number;
  autoBond: boolean;
  display: DisplayMode;
  /** Where a click on a surface anchors: the centre of the flat face, or the clicked point on a grid of the move step. */
  surfaceSnap: 'centre' | 'grid';
  /** Measurement overlay (I): gaps, centre distances and angles of bonds, size and tilt of the selected part. */
  details: boolean;
  /** Alignment guides (G): centres of mass and bounds of every part, alignments of the selected part. */
  guides: boolean;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Size of the main body's collision box, largest side first ("4×2×0.2 m"); '' when unknown. */
function sizeText(p: PartDef): string {
  const b = p.bodies.find((x) => x.slot === 0) || p.bodies[0];
  const s = b && b.shape;
  if (!s || !s.min || !s.max) return '';
  const d = [0, 1, 2].map((i) => s.max![i] - s.min![i]).sort((x, y) => y - x);
  const f = (x: number) => (x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/0$/, ''));
  return d.map(f).join('×') + ' m';
}

const safeName = (s: string) => (s.trim() || 'blueprint').replace(/[\\/:*?"<>|]+/g, '_');
const fmt = (x: number, d = 3) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(d);

export class App {
  private idx: PartIndex;
  private bp: Blueprint;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** The primary part (last clicked): the gizmo target in single selection and the reference of group commands. */
  private selected: string | null = null;
  /** Every selected part, the primary last. */
  private selection: string[] = [];
  private mode: Mode = 'select';
  /** The anchor picked on the part that will move. */
  private snapSource: Anchor | null = null;
  private lastSnap: { moving: Anchor; target: Anchor; roll: number } | null = null;
  /** Body of the selected part used by manual bonding; -1 = the body in contact. */
  private bondSlot = -1;
  private settings: Settings = { gizmo: 'translate', space: 'world', step: 0.05, angle: 15, autoBond: true, display: 'model', surfaceSnap: 'centre', details: false, guides: false };
  readonly view: Viewport;
  private els: Record<string, HTMLElement> = {};
  private libFilter = { text: '', cat: 'all' };
  private drafts: Draft[];
  private models: Record<string, { file: string }>;
  private thumbs: Thumbnailer;

  constructor(root: HTMLElement, lib: Library, drafts: Draft[], models: Record<string, { file: string }>) {
    this.models = models;
    this.thumbs = new Thumbnailer(models);
    this.idx = new PartIndex(lib);
    this.drafts = drafts;
    this.bp = this.loadAutosave() || emptyBlueprint();
    this.lastCommitted = JSON.stringify(this.bp);
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* defaults */ }
    root.append(this.buildLayout());
    this.view = new Viewport(this.els.view, this.idx, models, {
      select: (id, additive) => this.onPick(id, additive),
      boxSelect: (ids, additive) => this.setSelection(additive ? [...this.selection.filter((x) => !ids.includes(x)), ...ids] : ids),
      transform: (moves) => this.liveParts(moves),
      transformEnd: () => this.commit(this.bp, true),
      pivot: (id, pv) => this.onAnchor(this.pivotAnchorOf(id, pv)),
      hoverPivot: (id, pv) => {
        this.view.setAnchorMarker('hover', null, null);
        this.hint(id != null && pv != null ? this.pivotLabel(id, pv) : this.modeHint());
      },
      surface: (hit) => this.onAnchor(this.surfaceAnchorOf(hit)),
      hoverSurface: (hit) => {
        if (this.mode !== 'snap' || !hit) { this.view.setAnchorMarker('hover', null, null); this.hint(this.modeHint()); return; }
        const a = this.surfaceAnchorOf(hit);
        this.view.setAnchorMarker('hover', a.id, a.frame);
        this.hint(a.label);
      },
    });
    this.applySettings();
    this.renderLibrary();
    this.render();
    this.view.frame(this.bp);
    window.addEventListener('keydown', (e) => this.onKey(e));
    // drop a blueprint file anywhere on the editor to open it
    window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      this.openFile(f);
    });
    this.refreshFolder();
  }

  // ---------- state ----------

  private loadAutosave(): Blueprint | null {
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      const bp = s ? JSON.parse(s) : null;
      return bp && bp.format === 'totk-blueprint' ? bp : null;
    } catch { return null; }
  }

  /** Make bp the current blueprint. With record, the previous one goes on the undo stack. */
  private commit(bp: Blueprint, record = true) {
    if (record) {
      const prev = this.lastCommitted;
      const next = JSON.stringify(bp);
      if (prev !== next) {
        if (prev) this.undoStack.push(prev);
        if (this.undoStack.length > 200) this.undoStack.shift();
        this.redoStack = [];
      }
      this.lastCommitted = next;
    }
    this.bp = bp;
    this.selection = this.selection.filter((id) => bp.parts.some((p) => p.id === id));
    if (this.selected && !this.selection.includes(this.selected)) this.selected = this.selection[this.selection.length - 1] ?? null;
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(bp)); } catch { /* storage unavailable */ }
    this.render();
  }
  private lastCommitted = '';

  private undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.lastCommitted);
    this.lastCommitted = s;
    this.commit(JSON.parse(s), false);
  }
  private redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.lastCommitted);
    this.lastCommitted = s;
    this.commit(JSON.parse(s), false);
  }

  private part(id: string | null) { return id ? this.bp.parts.find((p) => p.id === id) : undefined; }
  private def(p: BPPart | undefined) { return p ? this.idx.get(p.actor) : undefined; }
  private label(id: string) {
    const p = this.part(id);
    const d = this.def(p);
    return `${d ? partName(d) : p ? p.actor : id} (${id})`;
  }

  private updatePart(id: string, change: Partial<BPPart>, record = true) {
    this.commit({ ...this.bp, parts: this.bp.parts.map((p) => (p.id === id ? { ...p, ...change } : p)) }, record);
  }

  /** Gizmo drag: update the blueprint without an undo step; the step is recorded when the drag ends. */
  private liveParts(moves: PartMove[]) {
    const by = new Map(moves.map((m) => [m.id, m]));
    this.bp = { ...this.bp, parts: this.bp.parts.map((p) => { const m = by.get(p.id); return m ? { ...p, pos: m.pos, rotDeg: m.rotDeg } : p; }) };
    this.updateDetails(moves.length === 1 ? moves[0].id : undefined);
    this.updateGuides();
    this.renderInspector();
    this.renderStats();
  }

  // ---------- alignment guides ----------

  private guideList: Alignment[] = [];

  private updateGuides() {
    if (!this.settings.guides) { this.guideList = []; this.view.showOverlay('guides', null); return; }
    const AXIS = [0xff5a5a, 0x5ad86a, 0x5a9bff];
    const lines: Overlay['lines'] = [];
    const dots: NonNullable<Overlay['dots']> = [];
    const labels: NonNullable<Overlay['labels']> = [];
    const all = blueprintAabb(this.bp, this.idx);
    const span = Math.max(8, ...[0, 1, 2].map((k) => (all[k + 3] - all[k]) * 1.5));
    for (const p of this.bp.parts) {
      const sel = p.id === this.selected;
      const com = partCom(p, this.idx);
      dots.push({ at: com, colour: 0xffa94d, size: sel ? 2 : 1.4 });
      // a small cross through the centre of mass, in world axes
      for (const k of [0, 1, 2]) {
        const a = [...com] as Vec3, b = [...com] as Vec3;
        a[k] -= 0.18; b[k] += 0.18;
        lines.push({ a, b, colour: AXIS[k], opacity: 0.9 });
      }
      // bounds in the part's own frame (oriented box)
      const lb = partLocalBounds(p, this.idx);
      const m = partPose(p);
      const c = (i: number): Vec3 => apply(m, [i & 1 ? lb.max[0] : lb.min[0], i & 2 ? lb.max[1] : lb.min[1], i & 4 ? lb.max[2] : lb.min[2]]);
      for (const [i, j] of BOX_EDGES) lines.push({ a: c(i), b: c(j), colour: 0x5fd3ff, opacity: sel ? 0.95 : 0.45 });
    }
    const sel = this.part(this.selected);
    this.guideList = sel ? alignments(this.bp, this.idx, sel.id) : [];
    if (sel) {
      const com = partCom(sel, this.idx);
      for (const k of [0, 1, 2]) {
        const a = [...com] as Vec3, b = [...com] as Vec3;
        a[k] -= span; b[k] += span;
        lines.push({ a, b, colour: AXIS[k], opacity: 0.35 });
      }
      const box = partAabb(sel, this.idx);
      const w = (i: number): Vec3 => [i & 1 ? box[3] : box[0], i & 2 ? box[4] : box[1], i & 4 ? box[5] : box[2]];
      for (const [i, j] of BOX_EDGES) lines.push({ a: w(i), b: w(j), colour: 0xe0e6ea, dashed: true, opacity: 0.8 });
      labels.push({ at: [com[0], com[1], com[2]], text: `${tr('质心', 'CoM')} ${com.map((v) => fmt(v, 3)).join(', ')}`, cls: 'sel stagger3' });
      for (const al of this.guideList.slice(0, 30)) {
        lines.push({ a: al.from, b: al.to, colour: AXIS[al.axis], dashed: true });
        dots.push({ at: al.to, colour: AXIS[al.axis] });
        labels.push({ at: al.to, text: `${this.label(al.other)} ${alignText(al)}`, cls: 'guide' });
      }
    }
    this.view.showOverlay('guides', { lines, dots, labels });
  }

  private toggleGuides() {
    this.setSetting({ guides: !this.settings.guides });
    this.updateGuides();
    this.renderStats();
    this.toast(this.settings.guides ? tr('对齐辅助：开', 'Alignment guides: on') : tr('对齐辅助：关', 'Alignment guides: off'));
  }

  /** Right-panel section of the alignment guides. */
  private guidesTable(): HTMLElement {
    const sel = this.part(this.selected);
    const parts = this.bp.parts.map((p) => h('div', { class: 'mrow', onclick: () => this.setSelected(p.id) },
      h('div', {}, this.label(p.id)),
      h('div', { class: 'nums' }, `${tr('质心', 'CoM')} ${partCom(p, this.idx).map((v) => fmt(v, 3)).join(', ')}`)));
    let selInfo: HTMLElement | null = null;
    if (sel) {
      const box = partAabb(sel, this.idx);
      selInfo = h('div', {},
        h('table', { class: 'kv' },
          h('tr', {}, h('td', {}, tr('选中零件', 'Selected')), h('td', {}, this.label(sel.id))),
          h('tr', {}, h('td', {}, tr('质心', 'Centre of mass')), h('td', {}, partCom(sel, this.idx).map((v) => fmt(v, 4)).join(', '))),
          h('tr', {}, h('td', {}, tr('世界边界', 'World bounds')), h('td', {}, `X ${fmt(box[0], 3)} ~ ${fmt(box[3], 3)}`, h('br'), `Y ${fmt(box[1], 3)} ~ ${fmt(box[4], 3)}`, h('br'), `Z ${fmt(box[2], 3)} ~ ${fmt(box[5], 3)}`)),
          h('tr', {}, h('td', {}, tr('自身尺寸', 'Own size')), h('td', {}, partSize(sel, this.idx).map((v) => fmt(v, 3)).join(' × ') + ' m'))),
        h('h3', {}, tr(`对齐关系（${this.guideList.length}）`, `Alignments (${this.guideList.length})`)),
        ...(this.guideList.length
          ? this.guideList.map((al) => h('div', { class: 'mrow', onclick: () => this.setSelected(al.other) },
            h('div', {}, `${this.label(al.other)}${tr('：', ': ')}${alignText(al)}`)))
          : [h('p', { class: 'muted' }, tr('和其他零件没有对齐（容差 2 mm）。', 'Not lined up with any other part (tolerance 2 mm).'))]));
    }
    return h('div', { class: 'details' },
      h('h3', {}, tr('对齐辅助', 'Alignment guides')),
      h('p', { class: 'muted' }, tr('橙点和十字是各零件的质心，青色框是零件自身坐标下的边界。选中零件时，彩色长线是穿过它质心的 X/Y/Z 参考线，白色虚线框是它按世界坐标的边界；与其他零件质心同坐标、边界齐平或贴面时用虚线连起来。',
        'Orange dots and crosses mark each part\'s centre of mass; cyan boxes are the bounds in the part\'s own frame. For the selected part, the long coloured lines are the X/Y/Z lines through its centre of mass and the white dashed box is its world bounds. Dashed lines connect it to parts that share a centre coordinate, a flush edge or a touching face.')),
      selInfo || h('p', { class: 'muted' }, tr('选中一个零件，查看它和其他零件的对齐关系。', 'Select a part to see how it lines up with the others.')),
      h('h3', {}, tr('各零件质心', 'Centres of mass')),
      ...parts);
  }

  // ---------- measurements ----------

  private measures: (BondMeasure & { gap: number | null; closestA: Vec3 | null; closestB: Vec3 | null })[] = [];

  /** Recompute the measurement overlay; while dragging (onlyPart) just the bonds of the dragged part. */
  private updateDetails(onlyPart?: string) {
    if (!this.settings.details) { this.measures = []; this.view.showDetails(null); return; }
    const old = new Map(this.measures.map((m) => [m.index, m]));
    this.measures = [];
    this.bp.bonds.forEach((b, i) => {
      const m = measureBond(this.bp, this.idx, i);
      if (!m) return;
      const prev = old.get(i);
      if (onlyPart && b.a !== onlyPart && b.b !== onlyPart && prev && prev.bond.a === b.a && prev.bond.b === b.b) {
        this.measures.push({ ...m, gap: prev.gap, closestA: prev.closestA, closestB: prev.closestB });
        return;
      }
      const c = this.view.closest(b.a, b.aBody, b.b, b.bBody);
      this.measures.push({ ...m, gap: c ? c.gap : null, closestA: c ? c.a : null, closestB: c ? c.b : null });
    });
    const lines: { a: Vec3; b: Vec3; colour: number }[] = [];
    const labels: { at: Vec3; text: string; cls: string }[] = [];
    this.measures.forEach((m, i) => {
      const touching = m.gap != null && m.gap < 0.0005;
      if (m.closestA && m.closestB && !touching) lines.push({ a: m.closestA, b: m.closestB, colour: 0xff5ccf });
      const at = m.closestA && m.closestB
        ? [0, 1, 2].map((k) => (m.closestA![k] + m.closestB![k]) / 2) as Vec3
        : [0, 1, 2].map((k) => (m.centreA[k] + m.centreB[k]) / 2) as Vec3;
      const gap = m.gap == null ? '?' : touching ? tr('接触', 'touching') : `${tr('间隙', 'gap')} ${fmt(m.gap, 3)} m`;
      // Compact in the view (numbered like the table); labels of neighbouring bonds are staggered vertically.
      labels.push({ at, text: `#${i + 1} ${gap} · ${fmt(m.angle, 1)}°`, cls: (touching ? 'ok' : m.gap != null && m.gap > 0.3 ? 'far' : '') + ' stagger' + (i % 4) });
    });
    const sel = this.part(this.selected);
    if (sel) {
      const box = partAabb(sel, this.idx);
      const size = partSize(sel, this.idx);
      labels.push({
        at: [(box[0] + box[3]) / 2, box[4] + 0.15, (box[2] + box[5]) / 2],
        text: `${tr('尺寸', 'size')} ${size.map((v) => fmt(v, 3)).join(' × ')} m · ${tr('倾斜', 'tilt')} ${fmt(partTilt(sel), 1)}°`,
        cls: 'sel',
      });
    }
    this.view.showDetails({ lines, labels });
  }

  private addPart(actor: string) {
    if (this.bp.parts.length >= MAX_PARTS) this.toast(tr(`注意：游戏最多 ${MAX_PARTS} 个零件，超出的蓝图无法导出到游戏。`, `Note: the game allows at most ${MAX_PARTS} parts; a bigger blueprint cannot be exported to the game.`));
    const id = nextId(this.bp);
    const fresh: BPPart = { id, actor, pos: [0, 0, 0], rotDeg: [0, 0, 0] };
    fresh.pos = this.besideSelection(fresh);
    this.commit({ ...this.bp, parts: [...this.bp.parts, fresh] });
    this.setSelected(id);
  }

  /** A position for a new part: 0.5 m to the +X side of the selected part's bounds, or above the origin. */
  private besideSelection(p: BPPart): Vec3 {
    const own = partAabb(p, this.idx);
    const sel = this.part(this.selected);
    if (!sel) return [0, round(-own[1], 3), 0];
    const box = partAabb(sel, this.idx);
    return [round(box[3] + 0.5 - own[0], 3), round((box[1] + box[4]) / 2 - (own[1] + own[4]) / 2, 3), round((box[2] + box[5]) / 2 - (own[2] + own[5]) / 2, 3)];
  }

  /** Copies of the selected parts (and the bonds among them), placed 0.5 m to the +X side of the selection's bounds. */
  private duplicate() {
    if (!this.selection.length) return;
    const box = blueprintAabb({ ...this.bp, parts: this.bp.parts.filter((p) => this.selection.includes(p.id)) }, this.idx);
    const res = duplicateParts(this.bp, this.selection, [round(box[3] - box[0] + 0.5, 3), 0, 0]);
    if (res.bp.parts.length > MAX_PARTS) this.toast(tr(`注意：游戏最多 ${MAX_PARTS} 个零件。`, `Note: the game allows at most ${MAX_PARTS} parts.`));
    this.commit(res.bp);
    this.setSelection(res.ids);
  }

  private deleteSelected() {
    if (!this.selection.length) return;
    let bp = this.bp;
    for (const id of this.selection) bp = removePart(bp, id);
    this.commit(bp);
    this.setSelected(null);
  }

  private setSelected(id: string | null) {
    this.setSelection(id ? [id] : []);
  }

  /** Select several parts; the primary is the given one or the last. */
  private setSelection(ids: string[], primary?: string) {
    const valid = ids.filter((id, i) => ids.indexOf(id) === i && this.bp.parts.some((p) => p.id === id));
    if (primary && valid.includes(primary)) { valid.splice(valid.indexOf(primary), 1); valid.push(primary); }
    this.selection = valid;
    this.selected = valid[valid.length - 1] ?? null;
    this.bondSlot = -1;
    this.render();
  }

  private toggleInSelection(id: string) {
    if (this.selection.includes(id)) this.setSelection(this.selection.filter((x) => x !== id));
    else this.setSelection([...this.selection, id]);
  }

  /** Apply a world transform to every selected part, as one undo step. */
  private moveSelection(delta: Mat34) {
    if (!this.selection.length) return;
    this.commit(transformParts(this.bp, this.selection, delta));
  }

  // ---------- modes ----------

  private setMode(m: Mode) {
    if (m === 'bond' && !this.selected) { this.toast(tr('先选中一个零件，再按 B 或点“粘合”，然后点另一个零件。', 'Select a part first, press B (or click "Bond"), then click another part.')); return; }
    if (m === 'unbond' && !this.selected) { this.toast(tr('先选中一个零件，再按 U 或点“取消粘合”，然后点和它粘合的零件。', 'Select a part first, press U (or click "Unbond"), then click a part bonded to it.')); return; }
    this.mode = m;
    this.snapSource = null;
    this.view.setSourcePivot(null);
    this.view.setAnchorMarker('source', null, null);
    this.view.showPivots(m === 'snap');
    if (m !== 'snap') this.view.select(this.selection, this.selected);
    this.render();
    this.hint(this.modeHint());
  }

  private modeHint(): string {
    if (this.mode === 'snap') {
      if (!this.snapSource) return tr('吸附：先点要移动的零件上的吸附点（黄色锥）或任意表面，再点目标零件上的吸附点或表面。R 转 90°，Esc 退出。',
        'Snap: click a snap point (yellow cone) or any surface on the part to move, then a snap point or surface on the target part. R turns 90°, Esc leaves.');
      return tr(`吸附：已选 ${this.snapSource.label}。再点目标零件上的吸附点或表面。`, `Snap: picked ${this.snapSource.label}. Now click a snap point or surface on the target part.`);
    }
    const sel = this.selected ? this.label(this.selected) : '';
    if (this.mode === 'bond') return tr(`粘合（切换）：点另一个零件。和 ${sel} 还没粘合就粘上，已经粘合就取消。Esc 退出。`, `Bond (toggle): click another part. It gets bonded to ${sel}, or unbonded if it already is. Esc leaves.`);
    if (this.mode === 'unbond') return tr(`取消粘合：点要和 ${sel} 断开的零件。Esc 退出。`, `Unbond: click the part to separate from ${sel}. Esc leaves.`);
    return tr('左键选择零件，拖动坐标轴移动；W 移动 / E 旋转，Ctrl/Shift+点击 多选，Alt+拖动 框选，S 吸附，B 粘合/取消，U 取消粘合，I 详细信息，G 对齐辅助，Del 删除，Ctrl+D 复制，F 居中，Ctrl+Z 撤销。',
      'Click to select, drag the gizmo to move. W move / E rotate, Ctrl/Shift+click add to selection, Alt+drag box select, S snap, B bond, U unbond, I details, G guides, Del delete, Ctrl+D duplicate, F frame, Ctrl+Z undo.');
  }

  private pivotLabel(id: string, pv: number) {
    const d = this.def(this.part(id));
    const p = d && d.pivots[pv];
    if (!p) return '';
    const where = p.pos.map((v) => fmt(v, 2)).join(', ');
    return tr(`${this.label(id)} 吸附点 #${pv}${p.name ? ' ' + p.name : ''}（刚体 ${p.body}，位置 ${where}）`,
      `${this.label(id)} snap point #${pv}${p.name ? ' ' + p.name : ''} (body ${p.body}, at ${where})`);
  }

  private onPick(id: string | null, additive = false) {
    if (this.mode === 'bond' || this.mode === 'unbond') {
      const a = this.selected;
      if (id && a && id !== a) {
        if (hasBond(this.bp, a, id)) {
          this.commit(removeBond(this.bp, a, id));
          this.toast(tr(`已取消 ${this.label(a)} 和 ${this.label(id)} 的粘合。`, `Unbonded ${this.label(a)} and ${this.label(id)}.`));
        } else if (this.mode === 'bond') {
          // the bodies that touch (a big tire's rim is body 1, its axle body 0); a chosen body overrides this part's side
          const auto = contactBond(this.bp, this.idx, a, id) || { a, aBody: 0, b: id, bBody: 0 };
          this.commit(addBond(this.bp, this.bondSlot >= 0 ? { ...auto, aBody: this.bondSlot } : auto));
          this.toast(tr(`已粘合 ${this.label(a)} 和 ${this.label(id)}。`, `Bonded ${this.label(a)} and ${this.label(id)}.`));
        } else {
          this.toast(tr('这两个零件之间没有粘合。', 'These two parts are not bonded.'));
        }
      }
      this.setMode('select');
      return;
    }
    if (this.mode === 'snap') return;
    if (additive) { if (id) this.toggleInSelection(id); return; }
    this.setSelected(id);
  }

  private pivotAnchorOf(id: string, pv: number): Anchor {
    const d = this.def(this.part(id))!;
    return { id, frame: pivotAnchor(d, pv), slot: d.pivots[pv].body, pivot: pv, label: this.pivotLabel(id, pv) };
  }

  private surfaceAnchorOf(hit: SurfaceHit): Anchor {
    const grid = this.settings.surfaceSnap === 'grid';
    const point = grid ? quantizeOnFace(hit.point, hit.centre, hit.normal, this.settings.step) : hit.centre;
    const where = grid ? tr(`面上网格点（步进 ${this.settings.step || '关'}）`, `grid point on the face (step ${this.settings.step || 'off'})`) : tr('面中心', 'face centre');
    const at = point.map((v) => fmt(v, 2)).join(', '), n = hit.normal.map((v) => fmt(v, 2)).join(', ');
    return {
      id: hit.id, frame: surfaceAnchor(point, hit.normal), slot: hit.slot, pivot: null,
      label: tr(`${this.label(hit.id)} 表面 ${where}（刚体 ${hit.slot}，位置 ${at}，法线 ${n}）`, `${this.label(hit.id)} surface, ${where} (body ${hit.slot}, at ${at}, normal ${n})`),
    };
  }

  /** First anchor picks the part that moves; an anchor on another part then moves it there. */
  private onAnchor(a: Anchor) {
    if (this.mode !== 'snap') return;
    if (!this.snapSource || this.snapSource.id === a.id) {
      this.snapSource = a;
      // the clicked part becomes primary; it keeps its group when it is part of the selection
      if (this.selection.includes(a.id)) { this.selection = [...this.selection.filter((x) => x !== a.id), a.id]; this.selected = a.id; }
      else { this.selection = [a.id]; this.selected = a.id; }
      this.view.setSourcePivot(a.pivot != null ? { id: a.id, pivot: a.pivot } : null);
      this.view.setAnchorMarker('source', a.pivot == null ? a.id : null, a.pivot == null ? a.frame : null);
      this.render();
      this.hint(this.modeHint());
      return;
    }
    this.lastSnap = { moving: this.snapSource, target: a, roll: 0 };
    this.applySnap();
    this.snapSource = null;
    this.view.setSourcePivot(null);
    this.view.setAnchorMarker('source', null, null);
    this.hint(tr('已吸附。R 绕接触面法线转 90°；继续点可以接着吸附，Esc 退出吸附模式。', 'Snapped. R turns 90° about the contact normal; keep clicking to snap more, Esc leaves snap mode.'));
  }

  private applySnap() {
    const s = this.lastSnap;
    if (!s) return;
    const mv = this.part(s.moving.id), tg = this.part(s.target.id);
    if (!mv || !tg) return;
    const res = snapToAnchor(s.moving.frame, mul(partPose(tg), s.target.frame), s.roll);
    let bp: Blueprint;
    const group = this.selection.includes(mv.id) && !this.selection.includes(tg.id) ? this.selection : [mv.id];
    if (group.length > 1) {
      // move the whole selection rigidly with the part that was snapped
      const delta = mul(pose(res.pos, res.rotDeg), inv(partPose(mv)));
      bp = transformParts(this.bp, group, delta);
    } else {
      bp = { ...this.bp, parts: this.bp.parts.map((p) => (p.id === mv.id ? { ...p, ...res } : p)) };
    }
    if (this.settings.autoBond && !hasBond(bp, mv.id, tg.id)) {
      bp = addBond(bp, { a: mv.id, aBody: s.moving.slot, b: tg.id, bBody: s.target.slot });
    }
    this.commit(bp);
  }

  private rollSnap() {
    if (!this.lastSnap) return;
    this.lastSnap.roll = (this.lastSnap.roll + 90) % 360;
    // the moving anchor is in the part's own frame, so snapping again from the current pose gives the same result
    this.applySnap();
    this.toast(tr(`转到 ${this.lastSnap.roll}°`, `Turned to ${this.lastSnap.roll}°`));
  }

  // ---------- files ----------

  private async openFile(file: File) {
    this.openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  private openBytes(buf: Uint8Array, fileName: string) {
    const name = fileName.replace(/\.(json|cai|cmbact|bin)$/i, '');
    try {
      let bp: Blueprint;
      if (String.fromCharCode(...buf.subarray(0, 6)) === 'CmbAct') bp = caiToBlueprint(parseCai(buf), name);
      else {
        const j = JSON.parse(new TextDecoder().decode(buf));
        if (j.format !== 'totk-blueprint') throw new Error(tr('不是本编辑器的蓝图 JSON', 'not a blueprint JSON from this editor'));
        bp = j;
      }
      this.replaceWith(bp);
    } catch (e) {
      this.toast(tr('打开失败：', 'Could not open: ') + (e as Error).message);
    }
  }

  // ---------- blueprint folder (served by the dev server, see vite.config.ts) ----------

  private async refreshFolder() {
    const sel = this.els.folderSel as HTMLSelectElement;
    try {
      const r = await fetch('/api/blueprints');
      const j = await r.json() as { dir: string; files: { name: string; size: number; mtime: number }[] };
      this.folderDir = j.dir;
      sel.replaceChildren(h('option', { value: '' }, tr(`蓝图文件夹（${j.files.length}）…`, `Blueprint folder (${j.files.length})…`)),
        ...j.files.map((f) => h('option', { value: f.name }, `${f.name}  ·  ${new Date(f.mtime).toLocaleString()}`)));
      sel.title = tr('打开蓝图文件夹里的文件：', 'Open a file from the blueprint folder: ') + j.dir;
    } catch {
      sel.replaceChildren(h('option', { value: '' }, tr('蓝图文件夹不可用', 'Blueprint folder unavailable')));
    }
  }
  private folderDir = '';

  private async openFromFolder(name: string) {
    try {
      const r = await fetch('/api/blueprints/' + encodeURIComponent(name));
      if (!r.ok) throw new Error((await r.json()).error || r.status);
      this.openBytes(new Uint8Array(await r.arrayBuffer()), name);
    } catch (e) {
      this.toast(tr('打开失败：', 'Could not open: ') + (e as Error).message);
    }
  }

  /** Write the blueprint into the folder as <name>.json (editor format) and <name>.cai (game format). */
  private async saveToFolder() {
    const base = safeName(this.bp.name);
    let cai: Uint8Array | null = null;
    try { cai = writeCai(blueprintToCai(this.bp, this.idx), 'romfs'); } catch (e) { this.toast(tr('无法生成 .cai：', 'Could not make the .cai: ') + (e as Error).message + tr('（只保存 JSON）', ' (saving the JSON only)')); }
    const put = (name: string, body: BlobPart, overwrite: boolean) =>
      fetch(`/api/blueprints/${encodeURIComponent(name)}${overwrite ? '?overwrite=1' : ''}`, { method: 'PUT', body });
    const files: [string, BlobPart][] = [[base + '.json', JSON.stringify(this.bp, null, 1)]];
    if (cai) files.push([base + '.cai', cai as BlobPart]);
    try {
      const listing = await (await fetch('/api/blueprints')).json() as { files: { name: string }[] };
      const exists = files.filter(([n]) => listing.files.some((f) => f.name === n)).map(([n]) => n);
      if (exists.length && !this.confirmTwice('save-' + base, tr(`${exists.join('、')} 已存在，5 秒内再点一次覆盖。`, `${exists.join(', ')} already exists. Click again within 5 s to overwrite.`))) return;
      for (const [n, body] of files) {
        const r = await put(n, body, exists.length > 0);
        if (!r.ok) throw new Error((await r.json()).error || r.status);
      }
      const names = files.map(([n]) => n);
      this.toast(tr(`已保存到 ${this.folderDir || '蓝图文件夹'}：${names.join('、')}`, `Saved to ${this.folderDir || 'the blueprint folder'}: ${names.join(', ')}`));
      this.refreshFolder();
    } catch (e) {
      this.toast(tr('保存失败：', 'Save failed: ') + (e as Error).message);
    }
  }

  private loadDraft(id: string) {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return;
    const bytes = Uint8Array.from(atob(d.cai), (c) => c.charCodeAt(0));
    this.replaceWith(caiToBlueprint(parseCai(bytes), draftName(d)));
  }

  /**
   * Replace the blueprint. No confirmation dialog (the desktop app's browser pane has none): the previous blueprint is
   * one undo step away.
   */
  private replaceWith(bp: Blueprint) {
    const had = this.bp.parts.length > 0;
    this.commit(bp);
    this.setSelected(null);
    this.view.frame(bp);
    this.toast(tr(`已打开《${bp.name}》（${bp.parts.length} 个零件）${had ? '，Ctrl+Z 可回到之前的蓝图' : ''}`,
      `Opened "${bp.name}" (${bp.parts.length} parts)${had ? '. Ctrl+Z brings back the previous blueprint' : ''}`));
  }

  /** A second press of the same action within a few seconds confirms it (instead of a dialog). */
  private armed: { key: string; until: number } | null = null;
  private confirmTwice(key: string, message: string): boolean {
    if (this.armed && this.armed.key === key && Date.now() < this.armed.until) { this.armed = null; return true; }
    this.armed = { key, until: Date.now() + 5000 };
    this.toast(message);
    return false;
  }

  private exportGame(form: 'romfs' | 'save') {
    const errs = validate(this.bp, this.idx).filter((i) => i.level === 'error');
    if (errs.length && !this.confirmTwice('export-' + form, tr('蓝图有错误：' + errs.map((e) => e.text).join('；') + '。5 秒内再点一次仍然导出。',
      'The blueprint has errors: ' + errs.map((e) => e.text).join(' ') + ' Click again within 5 s to export anyway.'))) return;
    try {
      const bytes = writeCai(blueprintToCai(this.bp, this.idx), form);
      download(`${safeName(this.bp.name)}.${form === 'romfs' ? 'cai' : 'cmbact'}`, bytes as BlobPart, 'application/octet-stream');
    } catch (e) {
      this.toast(tr('导出失败：', 'Export failed: ') + (e as Error).message);
    }
  }

  // ---------- keys ----------

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this.duplicate(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); this.setSelection(this.bp.parts.map((p) => p.id)); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'delete' || k === 'backspace') this.deleteSelected();
    else if (k === 'escape') this.mode !== 'select' ? this.setMode('select') : this.setSelected(null);
    else if (k === 'w') this.setSetting({ gizmo: 'translate' });
    else if (k === 'e') this.setSetting({ gizmo: 'rotate' });
    else if (k === 's') this.setMode(this.mode === 'snap' ? 'select' : 'snap');
    else if (k === 'r') this.rollSnap();
    else if (k === 'b') this.setMode(this.mode === 'bond' ? 'select' : 'bond');
    else if (k === 'u') this.setMode(this.mode === 'unbond' ? 'select' : 'unbond');
    else if (k === 'i') this.toggleDetails();
    else if (k === 'g') this.toggleGuides();
    else if (k === 'f') this.view.frame(this.bp);
  }

  private toggleDetails() {
    this.setSetting({ details: !this.settings.details });
    this.updateDetails();
    this.renderStats();
    this.toast(this.settings.details ? tr('详细信息：开', 'Details: on') : tr('详细信息：关', 'Details: off'));
  }

  private setSetting(s: Partial<Settings>) {
    Object.assign(this.settings, s);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
    this.applySettings();
    this.renderToolbarState();
  }
  private applySettings() {
    this.view.setGizmo(this.settings.gizmo, this.settings.space, this.settings.step, this.settings.angle);
    this.view.setDisplay(this.settings.display);
  }

  // ---------- layout ----------

  private buildLayout(): HTMLElement {
    const fileInput = h('input', { type: 'file', accept: '.json,.cai,.cmbact,.bin', style: 'display:none', onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) this.openFile(f);
      (e.target as HTMLInputElement).value = '';
    } });
    const folderSel = h('select', { title: tr('打开蓝图文件夹里的文件', 'Open a file from the blueprint folder'), onfocus: () => this.refreshFolder(), onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      (e.target as HTMLSelectElement).value = '';
      if (v) this.openFromFolder(v);
    } }, h('option', { value: '' }, tr('蓝图文件夹…', 'Blueprint folder…')));
    this.els.folderSel = folderSel;
    const draftSel = h('select', { title: tr('打开游戏自带的设计图', 'Open one of the game\'s own schematics'), onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      (e.target as HTMLSelectElement).value = '';
      if (v) this.loadDraft(v);
    } }, h('option', { value: '' }, tr('官方设计图…', 'Game schematics…')),
      ...this.drafts.map((d) => h('option', { value: d.id }, tr(`${draftName(d)}（${d.id.replace('Obj_AutoBuilderDraft', '')}）`, `${draftName(d)} (${d.id.replace('Obj_AutoBuilderDraft', '')})`))));
    const stepSel = h('select', { title: tr('移动步进（米）', 'Move step (m)'), onchange: (e: Event) => this.setSetting({ step: +(e.target as HTMLSelectElement).value }) },
      ...[0, 0.01, 0.05, 0.1, 0.25, 0.5, 1].map((s) => h('option', { value: s }, s ? tr(`步进 ${s} m`, `Step ${s} m`) : tr('步进 关', 'Step off'))));
    const angleSel = h('select', { title: tr('旋转步进（度）', 'Rotation step (°)'), onchange: (e: Event) => this.setSetting({ angle: +(e.target as HTMLSelectElement).value }) },
      ...[0, 1, 5, 15, 45, 90].map((s) => h('option', { value: s }, s ? tr(`角度 ${s}°`, `Angle ${s}°`) : tr('角度 关', 'Angle off'))));
    this.els.stepSel = stepSel;
    this.els.angleSel = angleSel;
    const btn = (text: string, title: string, on: () => void, key?: string) => {
      const b = h('button', { title, onclick: on }, text);
      if (key) this.els[key] = b;
      return b;
    };
    const toolbar = h('div', { class: 'toolbar' },
      btn(tr('新建', 'New'), tr('新建空蓝图', 'Start an empty blueprint'), () => this.replaceWith(emptyBlueprint())),
      btn(tr('打开…', 'Open…'), tr('用系统文件框打开 JSON、.cai 或 .cmbact（应用内置的浏览器窗格不支持文件框，可以用旁边的“蓝图文件夹”或把文件拖进来）',
        'Open a JSON, .cai or .cmbact file. You can also pick one from the blueprint folder list or drop a file on the window.'), () => fileInput.click()),
      folderSel,
      draftSel,
      h('span', { class: 'sep' }),
      btn(tr('保存到文件夹', 'Save to folder'), tr('把蓝图保存为蓝图文件夹里的 <名称>.json 和 <名称>.cai', 'Save as <name>.json and <name>.cai in the blueprint folder'), () => this.saveToFolder()),
      btn(tr('下载 JSON', 'Download JSON'), tr('下载本编辑器的蓝图文件', 'Download the blueprint in this editor\'s format'), () => download(`${safeName(this.bp.name)}.json`, JSON.stringify(this.bp, null, 1), 'application/json')),
      btn(tr('导出 .cai', 'Export .cai'), tr('游戏 RomFS 设计图格式（7840 字节）', 'The game\'s RomFS schematic format (7840 bytes)'), () => this.exportGame('romfs')),
      btn(tr('导出存档记录', 'Export save entry'), tr('究极建造历史记录格式（6688 字节，配合 tools/save_inject.js 写进存档）', 'The Autobuild history entry format (6688 bytes, for tools/save_inject.js)'), () => this.exportGame('save')),
      h('span', { class: 'sep' }),
      btn(tr('撤销', 'Undo'), 'Ctrl+Z', () => this.undo(), 'undoBtn'),
      btn(tr('重做', 'Redo'), 'Ctrl+Y', () => this.redo(), 'redoBtn'),
      h('span', { class: 'sep' }),
      btn(tr('移动', 'Move'), 'W', () => this.setSetting({ gizmo: 'translate' }), 'tBtn'),
      btn(tr('旋转', 'Rotate'), 'E', () => this.setSetting({ gizmo: 'rotate' }), 'rBtn'),
      btn(tr('世界', 'World'), tr('坐标轴方向：世界 / 零件自身', 'Gizmo axes: world / the part\'s own'), () => this.setSetting({ space: this.settings.space === 'world' ? 'local' : 'world' }), 'spaceBtn'),
      stepSel, angleSel,
      h('span', { class: 'sep' }),
      btn(tr('吸附', 'Snap'), tr('S：把零件的吸附点或表面对齐到另一个零件', 'S: put a snap point or surface of a part onto another part'), () => this.setMode(this.mode === 'snap' ? 'select' : 'snap'), 'snapBtn'),
      h('select', { title: tr('点击零件表面时吸到哪里', 'Where a click on a surface snaps to'), onchange: (e: Event) => this.setSetting({ surfaceSnap: (e.target as HTMLSelectElement).value as Settings['surfaceSnap'] }) },
        h('option', { value: 'centre', selected: this.settings.surfaceSnap === 'centre' }, tr('表面：面中心', 'Surface: face centre')),
        h('option', { value: 'grid', selected: this.settings.surfaceSnap === 'grid' }, tr('表面：按步进取点', 'Surface: step grid'))),
      btn(tr('粘合', 'Bond'), tr('B：先选中一个零件，再点另一个零件。没粘合就粘上，已粘合就取消', 'B: with a part selected, click another part to bond them, or to unbond them if they already are'), () => this.setMode(this.mode === 'bond' ? 'select' : 'bond'), 'bondBtn'),
      btn(tr('取消粘合', 'Unbond'), tr('U：先选中一个零件，再点和它粘合的零件，断开两者的粘合', 'U: with a part selected, click a part bonded to it to separate them'), () => this.setMode(this.mode === 'unbond' ? 'select' : 'unbond'), 'unbondBtn'),
      h('label', { class: 'chk', title: tr('吸附后自动在两个零件之间建立粘合', 'Bond the two parts after snapping') },
        h('input', { type: 'checkbox', checked: this.settings.autoBond, onchange: (e: Event) => this.setSetting({ autoBond: (e.target as HTMLInputElement).checked }) }), tr('吸附时粘合', 'Bond on snap')),
      h('select', { title: tr('零件外观：游戏模型、碰撞体，或模型加碰撞体线框', 'Show parts as game models, collision shapes, or both'), onchange: (e: Event) => this.setSetting({ display: (e.target as HTMLSelectElement).value as DisplayMode }) },
        ...([['model', tr('显示模型', 'Models')], ['collision', tr('显示碰撞体', 'Collision')], ['both', tr('模型 + 碰撞体', 'Models + collision')]] as const).map(([v, t]) => h('option', { value: v, selected: this.settings.display === v }, t))),
      btn(tr('详细信息', 'Details'), tr('I：显示粘合的间隙、中心距、夹角，以及选中零件的尺寸和倾斜', 'I: gaps, centre distances and angles of bonds; size and tilt of the selected part'), () => this.toggleDetails(), 'detailsBtn'),
      btn(tr('对齐辅助', 'Guides'), tr('G：显示各零件的质心和边界线，以及选中零件与其他零件的对齐关系', 'G: centres of mass and bounds of every part, and what the selected part lines up with'), () => this.toggleGuides(), 'guidesBtn'),
      btn(tr('居中', 'Frame'), 'F', () => this.view.frame(this.bp)),
      h('span', { class: 'sep' }),
      btn(lang === 'en' ? '中文' : 'English', tr('Switch the interface to English', '切换到中文界面'), () => setLang(lang === 'en' ? 'zh' : 'en')),
      fileInput,
    );
    const search = h('input', { type: 'search', placeholder: tr('搜索零件（中文名或 actor 名）', 'Search parts (name or actor name)'), oninput: (e: Event) => { this.libFilter.text = (e.target as HTMLInputElement).value.trim().toLowerCase(); this.renderLibrary(); } });
    const count = (k: string) => (k === 'all' ? this.idx.lib.parts.length : this.idx.lib.parts.filter((p) => p.category === k).length);
    const tabs = h('div', { class: 'tabs' }, ...CATEGORIES.filter(([k]) => count(k) > 0).map(([k, t]) =>
      h('button', { 'data-cat': k, title: String(count(k)), onclick: () => { this.libFilter.cat = k; this.renderLibrary(); } }, t)));
    this.els.tabs = tabs;
    this.els.libList = h('div', { class: 'liblist' });
    this.els.libCount = h('div', { class: 'libcount muted' });
    this.els.view = h('div', { class: 'view' });
    this.els.inspector = h('div', { class: 'inspector' });
    this.els.stats = h('div', { class: 'stats' });
    this.els.status = h('div', { class: 'status' });
    this.els.toast = h('div', { class: 'toast' });
    return h('div', { class: 'app' },
      toolbar,
      h('div', { class: 'main' },
        h('aside', { class: 'library' }, h('h2', {}, tr('零件库', 'Parts')), search, tabs, this.els.libCount, this.els.libList),
        this.els.view,
        h('aside', { class: 'side' }, this.els.inspector, this.els.stats)),
      this.els.status,
      this.els.toast);
  }

  private hint(text: string) { this.els.status.textContent = text; }
  private toastTimer = 0;
  private toast(text: string) {
    this.els.toast.textContent = text;
    this.els.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.els.toast.classList.remove('show'), 3500);
  }

  // ---------- rendering ----------

  private render() {
    const st = stats(this.bp, this.idx);
    this.view.sync(this.bp, st.mass > 0 ? st.com : null);
    this.view.select(this.mode === 'snap' ? [] : this.selection, this.selected);
    this.updateDetails();
    this.updateGuides();
    this.renderInspector();
    this.renderStats(st);
    this.renderToolbarState();
    if (!this.els.status.textContent) this.hint(this.modeHint());
  }

  private renderToolbarState() {
    const on = (k: string, v: boolean) => this.els[k]?.classList.toggle('on', v);
    on('tBtn', this.settings.gizmo === 'translate');
    on('rBtn', this.settings.gizmo === 'rotate');
    on('snapBtn', this.mode === 'snap');
    on('bondBtn', this.mode === 'bond');
    on('unbondBtn', this.mode === 'unbond');
    on('detailsBtn', this.settings.details);
    on('guidesBtn', this.settings.guides);
    if (this.els.spaceBtn) this.els.spaceBtn.textContent = this.settings.space === 'world' ? tr('世界', 'World') : tr('自身', 'Local');
    (this.els.undoBtn as HTMLButtonElement).disabled = !this.undoStack.length;
    (this.els.redoBtn as HTMLButtonElement).disabled = !this.redoStack.length;
    (this.els.stepSel as HTMLSelectElement).value = String(this.settings.step);
    (this.els.angleSel as HTMLSelectElement).value = String(this.settings.angle);
  }

  private renderLibrary() {
    const { text, cat } = this.libFilter;
    for (const b of this.els.tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.cat === cat);
    const order = new Map<string, number>(CATEGORIES.map(([k], i) => [k, i]));
    const noName = (p: PartDef) => Number(unnamed(p));
    const matches = (p: PartDef) => [p.name, p.nameEn || '', p.actor].some((x) => x.toLowerCase().includes(text));
    const parts = this.idx.lib.parts
      .filter((p) => cat === 'all' || p.category === cat)
      .filter((p) => !text || matches(p))
      .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || noName(a) - noName(b) || partName(a).localeCompare(partName(b), lang));
    this.els.libCount.textContent = tr(`${parts.length} 个零件`, `${parts.length} parts`);
    this.els.libList.replaceChildren(...parts.map((p) => {
      const mass = p.bodies.reduce((s, b) => s + (b.slot >= 0 && b.mass ? b.mass : 0), 0);
      const short = p.actor.replace(/^(AsbObj|SpObj)_/, '');
      const noBuild = p.autoBuilder === false;
      const sources: Record<string, string> = {
        game: tr('名称来自游戏文本', 'Name from the game\'s text'),
        common: tr('名称是游戏里融合时的通用名', 'Name is the game\'s generic fuse name'),
        guess: tr('游戏里没有这个零件的名字，名称根据 actor 名推测', 'The game has no name for this part; the name is made up from the actor name'),
      };
      const src = nameSource(p);
      const source = src ? sources[src] || '' : '';
      const tip = [partCaption(p), p.actor, source, noBuild ? tr('游戏数据里标记为不接受究极建造（AcceptAutoBuilder: False），放进设计图后可能造不出来',
        'Marked as not accepting Autobuild in the game data (AcceptAutoBuilder: False); a schematic with it may not build') : ''].filter(Boolean).join('\n');
      return h('button', { class: 'libitem ' + p.category, title: tip, onclick: () => this.addPart(p.actor) },
        h('span', { class: 'txt' },
          h('span', { class: 'n' + (nameSource(p) === 'guess' ? ' guess' : '') }, unnamed(p) ? short : partName(p), noBuild ? h('span', { class: 'badge' }, tr('不可建造', 'no Autobuild')) : null),
          h('span', { class: 'm' }, [mass + ' kg', sizeText(p), short].filter(Boolean).join(' · '))),
        this.thumbs.image(p));
    }));
  }

  private numInput(value: number, step: number, onchange: (v: number) => void, digits = 3) {
    return h('input', { type: 'number', step, value: fmt(value, digits), onchange: (e: Event) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (isFinite(v)) onchange(v);
    } });
  }

  private renderInspector() {
    const el = this.els.inspector;
    if (this.selection.length > 1) { el.replaceChildren(this.multiInspector()); return; }
    const p = this.part(this.selected);
    if (!p) {
      el.replaceChildren(
        h('h2', {}, tr('蓝图', 'Blueprint')),
        h('label', { class: 'row' }, tr('名称', 'Name'), h('input', { type: 'text', value: this.bp.name, onchange: (e: Event) => this.commit({ ...this.bp, name: (e.target as HTMLInputElement).value }) })),
        h('p', { class: 'muted' }, tr('坐标：Y 朝上，单位米；旋转为游戏的欧拉角顺序（先绕 X，再绕 Y，最后绕 Z）。导出时整体会被移到包围盒中心。',
          'Coordinates: Y up, in metres. Rotations use the game\'s Euler order (X first, then Y, then Z). On export the whole blueprint is moved so its bounding box is centred.')),
        this.bondList(null));
      return;
    }
    const d = this.def(p);
    const step = this.settings.step || 0.01, ang = this.settings.angle || 1;
    const axis = ['X', 'Y', 'Z'];
    const posRow = h('div', { class: 'vec' }, ...axis.map((a, k) => h('label', {}, a, this.numInput(p.pos[k], step, (v) => {
      const pos = [...p.pos] as Vec3; pos[k] = v; this.updatePart(p.id, { pos });
    }, 4))));
    const rotRow = h('div', { class: 'vec' }, ...axis.map((a, k) => h('label', {}, a, this.numInput(p.rotDeg[k], ang, (v) => {
      const rotDeg = [...p.rotDeg] as Vec3; rotDeg[k] = v; this.updatePart(p.id, { rotDeg });
    }, 3))));
    const nudge = (k: number, s: number) => () => { const pos = [...p.pos] as Vec3; pos[k] = round(pos[k] + s, 5); this.updatePart(p.id, { pos }); };
    const turn = (k: number, s: number) => () => { const r = [...p.rotDeg] as Vec3; r[k] = round(((r[k] + s + 540) % 360) - 180, 4); this.updatePart(p.id, { rotDeg: r }); };
    const nudges = h('div', { class: 'nudges' },
      ...axis.map((a, k) => h('span', {}, h('button', { onclick: nudge(k, -step) }, `${a}−`), h('button', { onclick: nudge(k, step) }, `${a}+`))),
      ...axis.map((a, k) => h('span', {}, h('button', { onclick: turn(k, -ang) }, `↺${a}`), h('button', { onclick: turn(k, ang) }, `↻${a}`))));
    const slots = slotCount(d);
    const bodies = d ? h('table', { class: 'bodies' },
      h('tr', {}, h('th', {}, tr('刚体', 'Body')), h('th', {}, tr('质量', 'Mass')), h('th', {}, tr('材质', 'Material')), h('th', {}, tr('运动', 'Motion'))),
      ...d.bodies.filter((b) => b.slot >= 0).map((b) => h('tr', {},
        h('td', {}, `${b.slot}: ${b.name}`),
        h('td', {}, String(b.mass ?? '-')),
        h('td', {}, [...new Set(b.shape.prims.map((x) => x.material))].join('/')),
        h('td', {}, b.motionProperty === 'Default' ? tr('默认', 'default') : `${b.motionProperty} (g×${b.gravityScale})`)))) : h('p', { class: 'warn' }, tr('零件库里没有这个 actor。', 'This actor is not in the part library.'));
    el.replaceChildren(...[
      h('h2', {}, d ? partName(d) : p.actor),
      h('div', { class: 'muted' }, `${p.actor} · ${p.id}${d && d.energy ? ` · ${tr('耗能', 'energy')} ${d.energy}` : ''}${d && !d.subRelKnown && slots > 1 ? tr(' · 子刚体位姿未知，按主刚体处理', ' · sub-body poses unknown, using the main body\'s') : ''}`),
      h('div', { class: 'muted' }, tr('视图里的红/绿/蓝轴是这个零件自身的 X/Y/Z。', 'The red/green/blue axes in the view are this part\'s own X/Y/Z.')),
      d && partCaption(d) ? h('p', { class: 'caption' }, partCaption(d)!) : null,
      h('h3', {}, tr('位置（m）', 'Position (m)')), posRow,
      h('h3', {}, tr('旋转（°）', 'Rotation (°)')), rotRow,
      nudges,
      h('div', { class: 'actions' },
        h('button', { onclick: () => this.duplicate() }, tr('复制', 'Duplicate')),
        h('button', { onclick: () => this.deleteSelected() }, tr('删除', 'Delete')),
        h('button', { onclick: () => this.updatePart(p.id, { rotDeg: [0, 0, 0] }) }, tr('旋转归零', 'Reset rotation')),
        h('button', { onclick: () => this.setMode('snap') }, tr('吸附…', 'Snap…')),
        h('button', { title: tr('B：点另一个零件，没粘合就粘上，已粘合就取消', 'B: click another part to bond it, or to unbond it if it already is'), onclick: () => this.setMode('bond') }, tr('粘合/取消…', 'Bond/unbond…')),
        h('button', { title: tr('删除这个零件的所有粘合', 'Remove every bond of this part'), onclick: () => {
          const n = this.bp.bonds.filter((b) => b.a === p.id || b.b === p.id).length;
          if (!n) { this.toast(tr('这个零件没有粘合。', 'This part has no bonds.')); return; }
          this.commit(removeBondsOf(this.bp, p.id));
          this.toast(tr(`已断开 ${this.label(p.id)} 的 ${n} 条粘合。`, `Removed ${n} bond(s) of ${this.label(p.id)}.`));
        } }, tr('断开全部粘合', 'Unbond all')),
        slots > 1 ? h('select', { title: tr('粘合时用本零件的哪个子刚体', 'Which body of this part new bonds use'), onchange: (e: Event) => { this.bondSlot = +(e.target as HTMLSelectElement).value; } },
          h('option', { value: -1, selected: this.bondSlot < 0 }, tr('子刚体：按接触', 'Body: by contact')),
          ...Array.from({ length: slots }, (_, i) => h('option', { value: i, selected: i === this.bondSlot }, tr(`用子刚体 ${i}`, `Use body ${i}`)))) : null),
      bodies,
      this.bondList(p.id)].filter((x): x is HTMLElement => !!x));
  }

  /** Panel for several selected parts: group move and rotation, alignment, distribution, bonds. */
  private multiInspector(): HTMLElement {
    const ids = this.selection;
    const step = this.settings.step || 0.01, ang = this.settings.angle || 1;
    const AX = ['X', 'Y', 'Z'] as const;
    const centre = groupCentre(this.bp, this.idx, ids);
    const chips = h('div', { class: 'chips' }, ...ids.map((id) => h('span', { class: 'chip' + (id === this.selected ? ' primary' : '') },
      h('a', { href: '#', title: tr('设为主零件（对齐的基准）', 'Make this the primary part (the reference for aligning)'), onclick: (e: Event) => { e.preventDefault(); this.setSelection(ids, id); } }, this.label(id)),
      h('button', { class: 'x', title: tr('从选择中移除', 'Remove from the selection'), onclick: () => this.setSelection(ids.filter((x) => x !== id)) }, '×'))));
    const shift = (k: number, d: number) => () => { const t: Vec3 = [0, 0, 0]; t[k] = d; this.moveSelection(pose(t, [0, 0, 0])); };
    const turn = (k: 0 | 1 | 2, d: number) => () => this.moveSelection(rotationAbout(groupCentre(this.bp, this.idx, ids), k, d));
    const offs: Vec3 = [0, 0, 0];
    const offsetRow = h('div', { class: 'vec' }, ...AX.map((a, k) => h('label', {}, a, h('input', { type: 'number', step, value: '0', onchange: (e: Event) => { offs[k] = parseFloat((e.target as HTMLInputElement).value) || 0; } }))));
    const align = (k: 0 | 1 | 2, mode: AlignMode) => () => this.commit(alignParts(this.bp, this.idx, ids, this.selected!, k, mode));
    const dist = (k: 0 | 1 | 2, mode: 'centre' | 'gap') => () => {
      if (ids.length < 3) { this.toast(tr('分布需要至少 3 个零件。', 'Distributing needs at least 3 parts.')); return; }
      this.commit(distributeParts(this.bp, this.idx, ids, k, mode));
    };
    const inner = this.bp.bonds.filter((b) => ids.includes(b.a) && ids.includes(b.b)).length;
    return h('div', {},
      h('h2', {}, tr(`已选 ${ids.length} 个零件`, `${ids.length} parts selected`)),
      h('p', { class: 'muted' }, tr('Ctrl/Shift+点击：加选或取消；Alt+拖动：框选；Ctrl+A：全选；Esc：取消选择。拖动坐标轴会整体移动或旋转；吸附时整组跟着移动。青色框是主零件（最后点选的），对齐以它为基准。',
        'Ctrl/Shift+click adds or removes, Alt+drag box-selects, Ctrl+A selects all, Esc clears. The gizmo moves or rotates the whole group, and snapping moves the group too. The cyan box is the primary part (the last one clicked); aligning uses it as the reference.')),
      chips,
      h('div', { class: 'muted' }, `${tr('选区中心', 'Selection centre')} ${centre.map((v) => fmt(v, 3)).join(', ')}`),
      h('h3', {}, tr('整体平移（m）', 'Move by (m)')),
      offsetRow,
      h('div', { class: 'actions' }, h('button', { onclick: () => this.moveSelection(pose([...offs] as Vec3, [0, 0, 0])) }, tr('按上面的数值平移', 'Move by these values'))),
      h('div', { class: 'nudges' },
        ...AX.map((a, k) => h('span', {}, h('button', { onclick: shift(k, -step) }, `${a}−`), h('button', { onclick: shift(k, step) }, `${a}+`))),
        ...AX.map((a, k) => h('span', {}, h('button', { title: tr('绕选区中心', 'About the selection centre'), onclick: turn(k as 0 | 1 | 2, -ang) }, `↺${a}`), h('button', { title: tr('绕选区中心', 'About the selection centre'), onclick: turn(k as 0 | 1 | 2, ang) }, `↻${a}`)))),
      h('h3', {}, tr('对齐到主零件', 'Align to the primary part')),
      h('table', { class: 'aligntbl' },
        ...AX.map((a, k) => h('tr', {}, h('td', {}, a),
          h('td', {}, h('button', { onclick: align(k as 0 | 1 | 2, 'min') }, k === 1 ? tr('下沿', 'Bottom') : tr('负侧', 'Min'))),
          h('td', {}, h('button', { onclick: align(k as 0 | 1 | 2, 'centre') }, tr('中心', 'Centre'))),
          h('td', {}, h('button', { onclick: align(k as 0 | 1 | 2, 'max') }, k === 1 ? tr('上沿', 'Top') : tr('正侧', 'Max'))),
          h('td', {}, h('button', { onclick: align(k as 0 | 1 | 2, 'com') }, tr('质心', 'CoM')))))),
      h('h3', {}, tr('分布（至少 3 个）', 'Distribute (3 or more)')),
      h('table', { class: 'aligntbl' },
        ...AX.map((a, k) => h('tr', {}, h('td', {}, a),
          h('td', {}, h('button', { title: tr('首尾两个零件不动，中间零件的中心等间距', 'The two end parts stay put; the centres of the others get even spacing'), onclick: dist(k as 0 | 1 | 2, 'centre') }, tr('中心等距', 'Even centres'))),
          h('td', {}, h('button', { title: tr('首尾两个零件不动，相邻零件之间的空隙相等', 'The two end parts stay put; the gaps between neighbours become equal'), onclick: dist(k as 0 | 1 | 2, 'gap') }, tr('间隙相等', 'Even gaps')))))),
      h('h3', {}, tr(`粘合（选中零件之间 ${inner} 条）`, `Bonds (${inner} among the selected)`)),
      h('div', { class: 'actions' },
        h('button', { title: tr('已有粘合保留；按两两之间的最近距离补上缺的粘合，直到所有选中零件连成一体', 'Keeps the existing bonds and adds the shortest missing ones until the selected parts are all connected'), onclick: () => {
          const r = bondNearest(this.bp, this.idx, ids, (a, b) => contactBond(this.bp, this.idx, a, b));
          if (!r.added) { this.toast(tr('选中零件已经连成一体。', 'The selected parts are already connected.')); return; }
          this.commit(r.bp);
          this.toast(tr(`补上了 ${r.added} 条粘合。`, `Added ${r.added} bond(s).`));
        } }, tr('粘成整体', 'Bond together')),
        h('button', { onclick: () => { this.commit(removeBondsWithin(this.bp, ids)); this.toast(tr('已断开选中零件之间的粘合。', 'Removed the bonds among the selected parts.')); } }, tr('断开彼此粘合', 'Unbond each other')),
        h('button', { onclick: () => { let bp = this.bp; for (const id of ids) bp = removeBondsOf(bp, id); this.commit(bp); this.toast(tr('已断开选中零件的全部粘合。', 'Removed every bond of the selected parts.')); } }, tr('断开全部粘合', 'Unbond all'))),
      h('div', { class: 'actions' },
        h('button', { onclick: () => this.duplicate() }, tr('复制（Ctrl+D）', 'Duplicate (Ctrl+D)')),
        h('button', { onclick: () => this.deleteSelected() }, tr('删除（Del）', 'Delete (Del)'))));
  }

  private bondList(id: string | null): HTMLElement {
    const bonds = this.bp.bonds.map((b, i) => ({ b, i })).filter(({ b }) => !id || b.a === id || b.b === id);
    const slotSel = (pid: string, value: number, set: (v: number) => void) => {
      const n = slotCount(this.def(this.part(pid)));
      if (n <= 1) return h('span', { class: 'muted' }, '');
      return h('select', { title: tr('子刚体', 'Body'), onchange: (e: Event) => set(+(e.target as HTMLSelectElement).value) },
        ...Array.from({ length: n }, (_, k) => h('option', { value: k, selected: k === value }, tr(`刚体${k}`, `body ${k}`))));
    };
    const edit = (i: number, change: Partial<Blueprint['bonds'][number]>) =>
      this.commit({ ...this.bp, bonds: this.bp.bonds.map((x, k) => (k === i ? { ...x, ...change } : x)) });
    return h('div', { class: 'bonds' },
      h('h3', {}, tr('粘合', 'Bonds') + tr('（', ' (') + bonds.length + (id ? '' : ' / ' + this.bp.bonds.length) + tr('）', ')')),
      ...bonds.map(({ b, i }) => h('div', { class: 'bond' },
        h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.setSelected(b.a); } }, this.label(b.a)),
        slotSel(b.a, b.aBody, (v) => edit(i, { aBody: v })),
        ' ⟷ ',
        h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); this.setSelected(b.b); } }, this.label(b.b)),
        slotSel(b.b, b.bBody, (v) => edit(i, { bBody: v })),
        h('button', { class: 'x', title: tr('删除这条粘合', 'Remove this bond'), onclick: () => this.commit({ ...this.bp, bonds: this.bp.bonds.filter((_, k) => k !== i) }) }, '×'))),
      bonds.length ? null : h('p', { class: 'muted' }, id ? tr('这个零件还没有粘合。勾选“吸附时粘合”后吸附会自动粘合，也可以按 B 手动粘合。', 'This part has no bonds yet. With "Bond on snap" ticked, snapping bonds parts; B bonds by hand.') : tr('还没有粘合。', 'No bonds yet.')));
  }

  /** Move every bond whose recorded body is not in contact onto the bodies that touch. */
  private fixBondBodies() {
    const r = fixBondBodies(this.bp, this.idx);
    if (!r.changed) { this.toast(tr('粘合的子刚体都和接触位置一致。', 'Every bond already uses the body in contact.')); return; }
    this.commit(r.bp);
    this.toast(tr(`已修正 ${r.changed} 条粘合的子刚体。`, `Fixed the body of ${r.changed} bond(s).`));
  }

  private renderStats(st = stats(this.bp, this.idx)) {
    const issues: Issue[] = [...validate(this.bp, this.idx), ...contactIssues(this.bp, this.idx, (id) => this.label(id))];
    const size = [0, 1, 2].map((k) => st.aabb[k + 3] - st.aabb[k]);
    this.els.stats.replaceChildren(...[
      h('h2', {}, tr('整体', 'Overall')),
      h('table', { class: 'kv' },
        h('tr', {}, h('td', {}, tr('零件', 'Parts')), h('td', {}, `${st.parts} / ${MAX_PARTS}`)),
        h('tr', {}, h('td', {}, tr('粘合', 'Bonds')), h('td', {}, String(st.bonds))),
        h('tr', {}, h('td', {}, tr('总质量', 'Total mass')), h('td', {}, fmt(st.mass, 0) + tr('（游戏单位，约 kg）', ' (game units, about kg)'))),
        h('tr', {}, h('td', {}, tr('质心', 'Centre of mass')), h('td', {}, st.com.map((v) => fmt(v, 2)).join(', '))),
        h('tr', {}, h('td', {}, tr('耗能合计', 'Energy use')), h('td', {}, fmt(st.energy, 1) + tr('（各装置耗能率之和）', ' (sum of the devices\' drain rates)'))),
        h('tr', {}, h('td', {}, tr('尺寸', 'Size')), h('td', {}, size.map((v) => fmt(v, 2)).join(' × ') + ' m'))),
      this.settings.details ? this.detailsTable() : null,
      this.settings.guides ? this.guidesTable() : null,
      h('h3', {}, tr('检查', 'Checks')),
      ...(issues.length ? issues.map((i) => h('div', { class: 'issue ' + i.level, onclick: () => i.parts && i.parts[0] && this.setSelected(i.parts[0]) }, i.text,
        i.fix === 'bondBodies' ? h('button', { class: 'fix', onclick: (e: Event) => { e.stopPropagation(); this.fixBondBodies(); } }, tr('按接触修正', 'Fix by contact')) : null)) : [h('div', { class: 'issue ok' }, tr('没有发现问题。', 'No problems found.'))])].filter((x): x is HTMLElement => !!x));
  }

  /** The measurement table of the details mode: one row per bond, then the selected part. */
  private detailsTable(): HTMLElement {
    const body = (n: number) => (n ? `[${tr('刚体', 'body ')}${n}]` : '');
    const rows = this.measures.map((m, i) => h('div', { class: 'mrow', onclick: () => this.setSelected(m.bond.a), title: tr('点击选中零件 A', 'Click to select part A') },
      h('div', {}, h('b', {}, `#${i + 1} `), `${this.label(m.bond.a)}${body(m.bond.aBody)} ⟷ ${this.label(m.bond.b)}${body(m.bond.bBody)}`),
      h('div', { class: 'nums' },
        `${tr('间隙', 'gap')} ${m.gap == null ? '?' : m.gap < 0.0005 ? tr('接触', 'touching') : fmt(m.gap, 4) + ' m'} · ${tr('中心距', 'centres')} ${fmt(m.centreDistance, 4)} m · ${tr('夹角', 'angle')} ${fmt(m.angle, 2)}°`),
      h('div', { class: 'nums' }, `${tr('B 相对 A 的旋转（X/Y/Z）：', 'Rotation of B relative to A (X/Y/Z): ')}${m.relative.map((v) => fmt(v, 2)).join(' / ')}°`)));
    const sel = this.part(this.selected);
    const selInfo = sel ? h('table', { class: 'kv' },
      h('tr', {}, h('td', {}, tr('选中零件', 'Selected')), h('td', {}, this.label(sel.id))),
      h('tr', {}, h('td', {}, tr('自身尺寸', 'Own size')), h('td', {}, partSize(sel, this.idx).map((v) => fmt(v, 3)).join(' × ') + tr(' m（X × Y × Z）', ' m (X × Y × Z)'))),
      h('tr', {}, h('td', {}, tr('倾斜', 'Tilt')), h('td', {}, fmt(partTilt(sel), 2) + tr('°（自身 +Y 与竖直方向）', '° (own +Y from vertical)'))),
      h('tr', {}, h('td', {}, tr('位置', 'Position')), h('td', {}, sel.pos.map((v) => fmt(v, 4)).join(', '))),
      h('tr', {}, h('td', {}, tr('旋转', 'Rotation')), h('td', {}, sel.rotDeg.map((v) => fmt(v, 3)).join(', ') + '°'))) : null;
    return h('div', { class: 'details' },
      h('h3', {}, tr('详细信息', 'Details')),
      this.measures.length ? h('div', { class: 'measure' }, ...rows) : h('p', { class: 'muted' }, tr('没有粘合。', 'No bonds.')),
      h('p', { class: 'muted' }, tr('间隙：两零件碰撞体表面之间的最近距离（粉线）；中心距：两个粘合刚体的形状中心距离；夹角：两零件朝向之间的总转角。',
        'Gap: the shortest distance between the two collision surfaces (pink line). Centres: distance between the shape centres of the two bonded bodies. Angle: the total rotation between the two parts\' orientations.')),
      selInfo);
  }
}

export type { PartDef };

/** The 12 edges of a box whose corners are numbered by bits (x = 1, y = 2, z = 4). */
const BOX_EDGES: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

function alignText(al: Alignment): string {
  const ax = 'XYZ'[al.axis];
  const v = fmt(al.value, 3);
  if (al.kind === 'com') return tr(`质心 ${ax} 对齐（${ax} = ${v}）`, `centres share ${ax} (${ax} = ${v})`);
  const lowSide = al.axis === 1 ? tr('下沿', 'bottom') : tr('负侧', 'min side');
  const highSide = al.axis === 1 ? tr('上沿', 'top') : tr('正侧', 'max side');
  if (al.kind === 'flush-min') return tr(`${ax} ${lowSide}齐平（${v}）`, `${ax} ${lowSide} flush (${v})`);
  if (al.kind === 'flush-max') return tr(`${ax} ${highSide}齐平（${v}）`, `${ax} ${highSide} flush (${v})`);
  return tr(`${ax} 方向贴面（${v}）`, `faces touch along ${ax} (${v})`);
}

/** An official schematic's name in the current language. */
function draftName(d: Draft): string {
  return lang === 'en' ? d.nameEn || d.name : d.name;
}
