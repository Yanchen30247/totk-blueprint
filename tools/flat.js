// Print the scalar leaves of dumped JSON parameter files as path=value lines.
// Usage: node flat.js <file-or-dir> [filter-regex-on-file-path]
'use strict';
const fs = require('fs');
const path = require('path');

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e), out);
  else if (p.endsWith('.json')) out.push(p);
  return out;
}

function flat(v, pre, lines) {
  if (Array.isArray(v)) {
    if (v.length > 12 && v.every((x) => x && typeof x === 'object' && 'X' in x)) { lines.push(`${pre}=[${v.length} vectors]`); return; }
    v.forEach((x, i) => flat(x, `${pre}[${i}]`, lines));
  } else if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (ks.length && ks.every((k) => 'XYZW'.includes(k) || 'RGBA'.includes(k))) {
      lines.push(`${pre}=(${ks.map((k) => +(+v[k]).toPrecision(6)).join(', ')})`);
      return;
    }
    for (const k of ks) flat(v[k], pre ? `${pre}.${k}` : k, lines);
  } else {
    lines.push(`${pre}=${typeof v === 'number' ? +v.toPrecision(7) : v}`);
  }
}

const [root, filt] = process.argv.slice(2);
const re = filt ? new RegExp(filt) : null;
for (const f of walk(root, [])) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  if (re && !re.test(rel)) continue;
  const lines = [];
  flat(JSON.parse(fs.readFileSync(f, 'utf8')), '', lines);
  console.log('### ' + rel);
  for (const l of lines) console.log('  ' + l);
}
