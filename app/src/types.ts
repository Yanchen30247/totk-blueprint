// Shared data types. The part library is produced by tools/build_library.js from the local RomFS.

export type Vec3 = [number, number, number];
/** 3x4 row-major rigid transform [R | t], the layout the game uses in CombinedActorInfo. */
export type Mat34 = number[];

export type PrimType = 'Box' | 'Sphere' | 'Cylinder' | 'Capsule' | 'Polytope' | 'Prism';

export interface Prim {
  type: PrimType;
  preset: string;
  material: string;
  offsetT: Vec3;
  /** Euler degrees, game order (R = Rz * Ry * Rx). */
  offsetR: Vec3;
  center?: Vec3;
  half?: Vec3;
  radius?: number;
  a?: Vec3;
  b?: Vec3;
  verts?: Vec3[];
  height?: number;
}

export interface Body {
  name: string;
  /** Index of the body in CombinedActorInfo (0 = main, 1, 2 = sub bodies); -1 for kinematic helper bodies. */
  slot: number;
  mass: number | null;
  motionType: string | null;
  motionProperty: string;
  gravityScale: number;
  linearDamping: number;
  angularDamping: number;
  maxLinearSpeed: number;
  maxAngularSpeed: number;
  comMode: string;
  comOffset: Vec3;
  comPos: Vec3 | null;
  inertiaScale: Vec3;
  buoyancyDensity: number | null;
  layer: string | null;
  shape: { prims: Prim[]; volume: number; center: Vec3; min?: Vec3; max?: Vec3 };
}

export interface Pivot {
  name: string;
  body: number;
  pos: Vec3;
  rotDeg: Vec3;
  mask: string | null;
  attr: string | null;
  strong: boolean;
  short: boolean;
}

export interface PartDef {
  actor: string;
  name: string;
  autoName: boolean;
  /** 'game' = the actor's own text, 'common' = the fuse common name (Grate, Iron Plate...), 'guess' = made from the actor name */
  nameSource?: 'game' | 'common' | 'guess' | 'none';
  caption: string | null;
  /** English name, caption and name source, from the game's USen text (older libraries have none). */
  nameEn?: string;
  nameSourceEn?: 'game' | 'common' | 'guess' | 'none';
  captionEn?: string | null;
  category: 'zonai' | 'material' | 'field' | 'shrine' | 'container' | 'weapon' | 'item' | 'other';
  /** false when the part refuses Autobuild (SpecialPowerReceiverParam AcceptAutoBuilder: False) */
  autoBuilder?: boolean;
  bodies: Body[];
  /** Pose of sub bodies 1 and 2 relative to the main body, measured from the game's schematics; null when unknown. */
  subRel: { 1: Mat34 | null; 2: Mat34 | null } | null;
  subRelKnown: boolean;
  pivots: Pivot[];
  /** Bodies the game's own schematics bond this part by; bonds stay on these when known. */
  bondBodies?: number[];
  joints: { group: string; kind: string; name: string; bodyA?: string; bodyB?: string; params: Record<string, unknown> }[];
  energy: number | null;
  receiver: Record<string, unknown>;
}

/**
 * An axle the game pulls into the part on a side with nothing glued to it (the big tire), from the model's
 * *_LeftIn / *_RightIn animations: the bone and how far its meshes move (actor frame, metres).
 */
export interface Retract { side: 'L' | 'R'; bone: string; delta: Vec3 }

/** gamedata/library/models.json entry (tools/build_models.js). */
export interface ModelInfo { file: string; restRel?: Record<string, Mat34>; retract?: Retract[] }

export interface Library {
  format: string;
  version: number;
  parts: PartDef[];
}

export interface Draft {
  id: string;
  name: string;
  nameEn?: string;
  /** base64 of the RomFS .cai file */
  cai: string;
}

export interface BPPart {
  id: string;
  actor: string;
  /** metres */
  pos: Vec3;
  /** Euler degrees, game order (R = Rz * Ry * Rx) */
  rotDeg: Vec3;
}

export interface BPBond {
  a: string;
  aBody: number;
  b: string;
  bBody: number;
}

export interface Blueprint {
  format: 'totk-blueprint';
  version: 1;
  name: string;
  parts: BPPart[];
  bonds: BPBond[];
}
