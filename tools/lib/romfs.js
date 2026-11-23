// Read-only access to the game's RomFS. Two layouts work:
//   - an extracted RomFS folder (the one holding Pack/, Model/, Mals/ ...), as dumped from your own copy of the game;
//   - a packed romfs/romfs.bin with romfs/index.json (offsets and sizes of every file) next to it.
// Where to look: TOTK_ROMFS (either layout), else TOTK_INSTALL, else a folder named zelda_king next to this project.
// Nothing here writes into the game folder.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseSarc } = require('./sarc');

/** The game folder: TOTK_INSTALL, or zelda_king next to the project folder. */
const DEFAULT_INSTALL = process.env.TOTK_INSTALL || path.resolve(__dirname, '..', '..', '..', 'zelda_king');

const isPacked = (d) => fs.existsSync(path.join(d, 'index.json')) && fs.existsSync(path.join(d, 'romfs.bin'));
const isFolder = (d) => fs.existsSync(path.join(d, 'Pack', 'ZsDic.pack.zs'));

class RomFS {
  constructor(root = process.env.TOTK_ROMFS || DEFAULT_INSTALL) {
    const candidates = [root, path.join(root, 'romfs')];
    const packed = candidates.find(isPacked);
    const folder = packed ? null : candidates.find(isFolder);
    if (!packed && !folder) {
      throw new Error(`No RomFS found in ${root}. Set TOTK_ROMFS to an extracted RomFS folder (the one with Pack/ and Model/ in it).`);
    }
    this.dir = packed || folder;
    this.dicts = null;
    if (packed) {
      const idx = JSON.parse(fs.readFileSync(path.join(packed, 'index.json'), 'utf8'));
      this.files = new Map();
      for (const f of idx.files) this.files.set(f.path, f);
      this.fd = fs.openSync(path.join(packed, 'romfs.bin'), 'r');
    } else {
      this.files = null; // listed on first use
      this.fd = null;
    }
  }
  /** Every file path in a loose folder, relative with forward slashes. */
  listing() {
    if (this.files) return this.files;
    this.files = new Map();
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), p);
        else this.files.set(p, { path: p });
      }
    };
    walk(this.dir, '');
    return this.files;
  }
  has(p) { return this.fd != null ? this.files.has(p) : fs.existsSync(path.join(this.dir, p)); }
  list(re) { const out = []; for (const k of this.listing().keys()) if (!re || re.test(k)) out.push(k); return out; }
  raw(p) {
    if (this.fd == null) {
      try { return fs.readFileSync(path.join(this.dir, p)); } catch { throw new Error('not in romfs: ' + p); }
    }
    const f = this.files.get(p);
    if (!f) throw new Error('not in romfs: ' + p);
    const b = Buffer.alloc(f.size);
    fs.readSync(this.fd, b, 0, f.size, f.offset);
    return b;
  }
  loadDicts() {
    if (this.dicts) return this.dicts;
    const pack = zlib.zstdDecompressSync(this.raw('Pack/ZsDic.pack.zs'));
    const s = parseSarc(pack);
    this.dicts = {};
    for (const [name, data] of s) this.dicts[name] = data;
    return this.dicts;
  }
  // Pick the dictionary the game uses for a file name.
  dictFor(p) {
    const d = this.loadDicts();
    if (p.endsWith('.bcett.byml.zs')) return d['bcett.byml.zsdic'];
    if (p.endsWith('.pack.zs')) return d['pack.zsdic'];
    return d['zs.zsdic'];
  }
  decompress(buf, p) {
    // Frames record whether a dictionary was used; try with the matching dictionary first.
    try {
      return zlib.zstdDecompressSync(buf, { dictionary: this.dictFor(p) });
    } catch (e) {
      return zlib.zstdDecompressSync(buf);
    }
  }
  read(p) {
    const b = this.raw(p);
    return p.endsWith('.zs') ? this.decompress(b, p) : b;
  }
  // Read an actor pack and return a Map of inner path -> Buffer.
  actorPack(name) {
    return parseSarc(this.read('Pack/Actor/' + name + '.pack.zs'));
  }
}

module.exports = { RomFS, DEFAULT_INSTALL };
