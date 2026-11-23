// Reader for the BFRES v10 files TotK ships (after MeshCodec decompression): skeleton, vertex buffers, shapes, materials.
// Layouts were worked out from the game's own files; only what the editor needs is read (positions, normals, UVs,
// rigid-skin indices, index buffers, bone rest poses, material names).
//
// After MeshCodec decompression the index and vertex data sit behind the FRES file: at align8(fileSize) a u32 gives the
// offset of that buffer area. Mesh index offsets and FVTX buffer offsets are relative to it.
'use strict';

function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// Attribute formats: high byte = component layout, low byte = number type (1 unorm, 2 snorm, 3 uint, 4 sint, 5 float).
// Layouts follow the Switch BFRES AttribFormat values: 0x02 = 8, 0x09 = 8_8, 0x0a = 16, 0x12 = 16_16, ...
const LAYOUT = {
  0x01: { n: 2, bits: [4, 4] }, 0x02: { n: 1, bits: [8] }, 0x09: { n: 2, bits: [8, 8] }, 0x0a: { n: 1, bits: [16] },
  0x0b: { n: 4, bits: [8, 8, 8, 8] },
  0x0e: { n: 4, bits: [10, 10, 10, 2] }, 0x12: { n: 2, bits: [16, 16] }, 0x14: { n: 1, bits: [32] },
  0x15: { n: 4, bits: [16, 16, 16, 16] }, 0x17: { n: 2, bits: [32, 32] }, 0x18: { n: 3, bits: [32, 32, 32] },
  0x19: { n: 4, bits: [32, 32, 32, 32] },
};
const UNORM = 1, SNORM = 2, UINT = 3, SINT = 4, FLOAT = 5;

function readAttr(buf, o, fmt) {
  const L = LAYOUT[fmt >> 8];
  const type = fmt & 0xff;
  if (!L) return null;
  const out = new Array(L.n);
  if (fmt >> 8 === 0x0e) { // 10_10_10_2 packed in a u32
    const w = buf.readUInt32LE(o);
    const parts = [w & 0x3ff, (w >> 10) & 0x3ff, (w >> 20) & 0x3ff, (w >>> 30) & 3];
    for (let i = 0; i < 3; i++) {
      let v = parts[i];
      if (type === SNORM) { if (v & 0x200) v -= 0x400; out[i] = Math.max(-1, v / 511); } else out[i] = v / 1023;
    }
    out[3] = type === SNORM ? ((parts[3] & 2) ? parts[3] - 4 : parts[3]) : parts[3] / 3;
    return out;
  }
  if (fmt >> 8 === 0x01) { // 4_4 packed in one byte
    const v = buf.readUInt8(o);
    return [v & 15, v >> 4].map((x) => (type === UNORM ? x / 15 : x));
  }
  let p = o;
  for (let i = 0; i < L.n; i++) {
    const bits = L.bits[i];
    let v;
    if (bits === 8) v = type === SNORM || type === SINT ? buf.readInt8(p) : buf.readUInt8(p);
    else if (bits === 16) v = type === FLOAT ? half(buf.readUInt16LE(p)) : type === SNORM || type === SINT ? buf.readInt16LE(p) : buf.readUInt16LE(p);
    else v = type === FLOAT ? buf.readFloatLE(p) : type === SNORM || type === SINT ? buf.readInt32LE(p) : buf.readUInt32LE(p);
    if (type === UNORM) v /= 2 ** bits - 1;
    else if (type === SNORM) v = Math.max(-1, v / (2 ** (bits - 1) - 1));
    out[i] = v;
    p += bits / 8;
  }
  return out;
}

function parseBfres(b) {
  if (b.toString('ascii', 0, 4) !== 'FRES') throw new Error('not FRES');
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  const u32 = (o) => b.readUInt32LE(o), u16 = (o) => b.readUInt16LE(o);
  const str = (o) => (o ? b.toString('utf8', o + 2, o + 2 + u16(o)) : '');
  const fileSize = u32(0x1c);
  const tail = (fileSize + 7) & ~7;
  const bufBase = tail + 8 <= b.length ? u32(tail) : 0;
  const dict = u64(0x30);
  const modelCount = dict ? u32(dict + 4) : 1; // dictionary header: u32 magic (0 here), u32 entry count
  const models = [];
  for (let m = 0; m < modelCount; m++) {
    const fm = u64(0x28) + m * 0x78;
    if (b.toString('ascii', fm, fm + 4) !== 'FMDL') throw new Error('FMDL not found');
    const model = { name: str(u64(fm + 8)), bones: [], vertexBuffers: [], shapes: [], materials: [] };
    // skeleton
    const sk = u64(fm + 0x18);
    const skFlags = u32(sk + 4);
    const boneCount = u16(sk + 0x38);
    const rigidCount = u16(sk + 0x3c), smoothCount = u16(sk + 0x3a);
    const m2b = u64(sk + 0x18);
    model.matrixToBone = [];
    for (let i = 0; i < smoothCount + rigidCount; i++) model.matrixToBone.push(u16(m2b + i * 2));
    model.rotationMode = (skFlags >> 12) & 1 ? 'euler' : 'quat';
    for (let i = 0; i < boneCount; i++) {
      const o = u64(sk + 0x10) + i * 0x58;
      const f = (k) => b.readFloatLE(o + k);
      model.bones.push({
        name: str(u64(o)), index: u16(o + 0x20), parent: (u16(o + 0x22) << 16) >> 16, flags: u32(o + 0x2c),
        scale: [f(0x30), f(0x34), f(0x38)], rotation: [f(0x3c), f(0x40), f(0x44), f(0x48)], translation: [f(0x4c), f(0x50), f(0x54)],
      });
    }
    // vertex buffers
    const vtxCount = u16(fm + 0x68), shapeCount = u16(fm + 0x6a), matCount = u16(fm + 0x6c);
    for (let v = 0; v < vtxCount; v++) {
      const f = u64(fm + 0x20) + v * 0x58;
      const na = b[f + 0x4c], nb = b[f + 0x4d];
      const count = u32(f + 0x50);
      const bufOff = u32(f + 0x48);
      const sizes = [], strides = [], starts = [];
      let at = bufOff;
      for (let i = 0; i < nb; i++) {
        sizes.push(u32(u64(f + 0x30) + i * 0x10));
        strides.push(u32(u64(f + 0x38) + i * 0x10));
        starts.push(at);
        at += (sizes[i] + 7) & ~7;
      }
      const attrs = {};
      for (let i = 0; i < na; i++) {
        const a = u64(f + 8) + i * 16;
        attrs[str(u64(a))] = { fmt: u16(a + 8), offset: u16(a + 12), buffer: u16(a + 14) };
      }
      const read = (name) => {
        const a = attrs[name];
        if (!a || !LAYOUT[a.fmt >> 8]) return null;
        const out = new Array(count);
        const base = bufBase + starts[a.buffer] + a.offset;
        for (let k = 0; k < count; k++) out[k] = readAttr(b, base + k * strides[a.buffer], a.fmt);
        return out;
      };
      model.vertexBuffers.push({ count, skinCount: b[f + 0x54], attrs, read });
    }
    // materials: name and texture names (u64 string pointers at +0x20, count at +0xa3)
    for (let i = 0; i < matCount; i++) {
      const o = u64(fm + 0x38) + i * 0xb0;
      const textures = [];
      const ta = u64(o + 0x20);
      for (let k = 0; k < b[o + 0xa3] && ta; k++) textures.push(str(u64(ta + k * 8)));
      model.materials.push({ name: str(u64(o + 8)), textures });
    }
    // shapes
    for (let s = 0; s < shapeCount; s++) {
      const o = u64(fm + 0x28) + s * 0x60;
      const meshCount = b[o + 0x5b];
      const meshes = [];
      for (let k = 0; k < meshCount; k++) {
        const me = u64(o + 0x18) + k * 0x38;
        meshes.push({ indexOffset: u32(me + 0x20), primitive: u32(me + 0x24), indexFormat: u32(me + 0x28), indexCount: u32(me + 0x2c), firstVertex: u32(me + 0x30) });
      }
      const skinBones = [];
      const nsb = u16(o + 0x58);
      for (let i = 0; i < nsb; i++) skinBones.push(u16(u64(o + 0x20) + i * 2));
      model.shapes.push({
        name: str(u64(o + 8)), material: u16(o + 0x52), bone: u16(o + 0x54), vertexBuffer: u16(o + 0x56),
        skinCount: b[o + 0x5a], skinBones, meshes,
      });
    }
    model.readIndices = (mesh) => {
      const n = mesh.indexCount;
      const out = new Uint32Array(n);
      const base = bufBase + mesh.indexOffset;
      for (let i = 0; i < n; i++) {
        out[i] = (mesh.indexFormat === 0 ? b[base + i] : mesh.indexFormat === 1 ? u16(base + i * 2) : u32(base + i * 4)) + mesh.firstVertex;
      }
      return out;
    };
    models.push(model);
  }
  return { name: str(u64(0x20)), bufBase, models };
}

module.exports = { parseBfres, half };
