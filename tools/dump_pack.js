// Dump the BYML files of a non-actor pack (or plain RomFS BYML files) as JSON into gamedata/<outdir>/...
// Usage: node dump_pack.js <romfs path of pack or file> <outdir> [inner-path-regex]
'use strict';
const fs = require('fs');
const path = require('path');
const { RomFS } = require('./lib/romfs');
const { parseSarc } = require('./lib/sarc');
const { parseByml } = require('./lib/byml');

const [src, outName, filt] = process.argv.slice(2);
const re = filt ? new RegExp(filt) : null;
const OUT = path.join(__dirname, '..', 'gamedata', outName);
const r = new RomFS();
const data = r.read(src);
const entries = data.toString('ascii', 0, 4) === 'SARC' ? parseSarc(data) : new Map([[src.replace(/\.zs$/, ''), data]]);
let n = 0;
for (const [inner, buf] of entries) {
  if (re && !re.test(inner)) continue;
  const dst = path.join(OUT, inner);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const m = buf.toString('ascii', 0, 2);
  if (m === 'YB' || m === 'BY') {
    try { fs.writeFileSync(dst.replace(/\.b?g?yml$/, '') + '.json', JSON.stringify(parseByml(buf).root, null, 1)); n++; continue; } catch (e) { console.error('byml fail', inner, e.message); }
  }
  fs.writeFileSync(dst, buf);
}
console.log('wrote', n, 'json from', src);
