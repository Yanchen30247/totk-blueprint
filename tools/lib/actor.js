// Read an actor's parameter files straight from its RomFS pack and follow the game's "Work/..." references.
// A reference is looked up in the actor's own pack first, then in ResidentCommon and Bootup; "$parent" is merged.
'use strict';
const { parseSarc } = require('./sarc');
const { parseByml } = require('./byml');

class ActorReader {
  constructor(romfs) {
    this.r = romfs;
    this.shared = [];
    for (const p of ['Pack/ResidentCommon.pack.zs', 'Pack/Bootup.Nin_NX_NVN.pack.zs']) this.shared.push(parseSarc(romfs.read(p)));
    this.cache = new Map();
  }
  exists(name) { return this.r.has('Pack/Actor/' + name + '.pack.zs'); }
  open(name) { return new ActorPack(this, name, this.r.actorPack(name)); }
}

class ActorPack {
  constructor(reader, name, files) {
    this.reader = reader;
    this.name = name;
    this.files = files;
    this.parsed = new Map();
  }
  static innerPath(ref) {
    return ref.replace(/^\?/, '').replace(/^Work\//, '').replace(/\.gyml$/, '.bgyml');
  }
  raw(inner) {
    if (this.files.has(inner)) return this.files.get(inner);
    for (const s of this.reader.shared) if (s.has(inner)) return s.get(inner);
    return null;
  }
  // Parsed BYML for a reference, with $parent chains merged (child keys win, shallowly).
  get(ref) {
    if (!ref) return null;
    const inner = ActorPack.innerPath(ref);
    if (this.parsed.has(inner)) return this.parsed.get(inner);
    const buf = this.raw(inner);
    let v = null;
    if (buf) {
      v = parseByml(buf).root;
      if (v && v.$parent) {
        const parent = this.get(v.$parent) || {};
        v = deepMerge(parent, v);
        delete v.$parent;
      }
    }
    this.parsed.set(inner, v);
    return v;
  }
  actorParam() { return this.get(`Actor/${this.name}.engine__actor__ActorParam.bgyml`); }
}

// gyml inheritance: dictionaries merge key by key, everything else (arrays, scalars) in the child replaces the parent's.
function deepMerge(parent, child) {
  const out = Object.assign({}, parent);
  for (const [k, v] of Object.entries(child)) {
    const p = out[k];
    if (p && v && typeof p === 'object' && typeof v === 'object' && !Array.isArray(p) && !Array.isArray(v)) out[k] = deepMerge(p, v);
    else out[k] = v;
  }
  return out;
}

module.exports = { ActorReader, deepMerge };
