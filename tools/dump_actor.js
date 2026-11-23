// Dump the BYML parameter files of actor packs as JSON into gamedata/actors/<Actor>/...
// Usage: node dump_actor.js <ActorName|re:regex> [...]
'use strict';
const fs = require('fs');
const path = require('path');
const { RomFS } = require('./lib/romfs');
const { parseByml } = require('./lib/byml');

const OUT = path.join(__dirname, '..', 'gamedata', 'actors');
const r = new RomFS();

function actorsFor(arg) {
  if (arg.startsWith('re:')) {
    const re = new RegExp(arg.slice(3));
    return r.list(/^Pack\/Actor\//).map((p) => p.slice(11, -8)).filter((n) => re.test(n));
  }
  return [arg];
}

function dumpOne(name) {
  const pack = r.actorPack(name);
  const dir = path.join(OUT, name);
  let n = 0;
  for (const [inner, data] of pack) {
    const dst = path.join(dir, inner);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.(bgyml|byml)$/.test(inner)) {
      try {
        const j = parseByml(data).root;
        fs.writeFileSync(dst.replace(/\.b(gyml|yml)$/, '.json'), JSON.stringify(j, null, 1));
        n++;
        continue;
      } catch (e) { /* fall through to raw */ }
    }
    fs.writeFileSync(dst, data);
  }
  return n;
}

const args = process.argv.slice(2);
let total = 0;
for (const a of args) for (const name of actorsFor(a)) { total++; const n = dumpOne(name); console.log(name, n); }
console.log('actors', total);
