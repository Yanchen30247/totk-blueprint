// Minimal glTF 2.0 binary writer: one mesh, one primitive per shape (POSITION, NORMAL, TEXCOORD_0, indices), plain
// metallic-roughness materials with a base colour.
'use strict';

function writeGlb(prims, name) {
  const chunks = [];
  let offset = 0;
  const bufferViews = [], accessors = [];
  const add = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes, Buffer.alloc(pad));
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const materials = [];
  const matIndex = new Map();
  // textures are PNG files next to the models folder (../textures/<name>.png), shared by all models
  const images = [], textures = [];
  const texIndex = new Map();
  const texOf = (t) => {
    if (!t) return undefined;
    if (!texIndex.has(t.file)) {
      images.push({ uri: '../' + t.file });
      textures.push({ source: images.length - 1, sampler: 0 });
      texIndex.set(t.file, textures.length - 1);
    }
    return { index: texIndex.get(t.file) };
  };
  const primitives = prims.map((p) => {
    const pos = new Float32Array(p.positions);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const count = pos.length / 3;
    accessors.push({ bufferView: add(pos, 34962), componentType: 5126, count, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;
    accessors.push({ bufferView: add(new Float32Array(p.normals), 34962), componentType: 5126, count, type: 'VEC3' });
    const aNrm = accessors.length - 1;
    accessors.push({ bufferView: add(new Float32Array(p.uvs), 34962), componentType: 5126, count, type: 'VEC2' });
    const aUv = accessors.length - 1;
    const idx = count < 65536 ? new Uint16Array(p.indices) : new Uint32Array(p.indices);
    accessors.push({ bufferView: add(idx, 34963), componentType: count < 65536 ? 5123 : 5125, count: idx.length, type: 'SCALAR' });
    const aIdx = accessors.length - 1;
    if (!matIndex.has(p.material)) {
      matIndex.set(p.material, materials.length);
      const mat = { name: p.material, pbrMetallicRoughness: { baseColorFactor: p.colour, metallicFactor: 0.1, roughnessFactor: 0.8 } };
      if (p.texture) {
        mat.pbrMetallicRoughness.baseColorTexture = texOf(p.texture);
        if (p.texture.alpha) { mat.alphaMode = 'MASK'; mat.alphaCutoff = 0.5; mat.doubleSided = true; }
      }
      if (p.emission) { mat.emissiveTexture = texOf(p.emission); mat.emissiveFactor = [0.35, 1, 0.85]; }
      materials.push(mat);
    }
    return { attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv }, indices: aIdx, material: matIndex.get(p.material), extras: p.bone ? { shape: p.name, bone: p.bone } : { shape: p.name } };
  });
  const json = {
    asset: { version: '2.0', generator: 'totk-blueprint build_models.js' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives }], materials, accessors, bufferViews, buffers: [{ byteLength: offset }],
  };
  if (textures.length) {
    json.images = images;
    json.textures = textures;
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  }
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'ascii');
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

module.exports = { writeGlb };
