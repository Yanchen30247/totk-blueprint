// Build the release packages into release/:
//   totk-blueprint-v<version>.zip                    the built editor, the tools, launchers and docs (needs Node.js)
//   totk-blueprint-v<version>-win-x64-portable.zip   the same plus node\node.exe and its LICENSE
//
//   node tools/make_release.js [--node-zip <node-vX.Y.Z-win-x64.zip from nodejs.org>]
//
// Without --node-zip only the first package is made. Only files git tracks are copied (plus the built editor in
// app/dist), so game data, config.json, backups and local notes never go in.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'release');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8')).version;
const NAME = `totk-blueprint-v${version}`;
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const args = process.argv.slice(2);
const nodeZip = args.includes('--node-zip') ? path.resolve(args[args.indexOf('--node-zip') + 1]) : null;

// what goes in, relative to the project folder (folders: every tracked file in them)
const FILES = [
  'README.md', 'README.zh-CN.md', 'LICENSE', 'config.example.json',
  'setup.cmd', 'editor.cmd', 'import-blueprint.cmd',
  'docs', 'tools', 'app/dist', 'app/server/api.mjs', 'app/server/serve.mjs',
];
const SKIP = new Set(['tools/make_release.js']);
const TRACKED = new Set(execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));

function copy(rel, destRoot) {
  const src = path.join(ROOT, rel);
  const key = rel.split(path.sep).join('/');
  if (SKIP.has(key)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) { for (const f of fs.readdirSync(src)) copy(path.join(rel, f), destRoot); return; }
  if (!key.startsWith('app/dist/') && !TRACKED.has(key)) return; // untracked: local only
  const dst = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function zip(stageParent, zipName) {
  const file = path.join(OUT, zipName);
  fs.rmSync(file, { force: true });
  execFileSync(TAR, ['-a', '-c', '-f', file, '-C', stageParent, NAME], { stdio: 'inherit' });
  console.log(`${zipName}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
}

function main() {
  console.log('building the editor');
  execSync('npm --prefix app run build', { cwd: ROOT, stdio: 'inherit' });

  fs.rmSync(OUT, { recursive: true, force: true });
  const plain = path.join(OUT, 'plain');
  const stage = path.join(plain, NAME);
  for (const f of FILES) copy(f, stage);
  zip(plain, `${NAME}.zip`);

  if (!nodeZip) { console.log('no --node-zip: skipping the portable package'); return; }
  const portable = path.join(OUT, 'portable');
  fs.cpSync(plain, portable, { recursive: true });
  const unpack = path.join(OUT, 'node-unpack');
  fs.mkdirSync(unpack, { recursive: true });
  const base = path.basename(nodeZip, '.zip'); // node-vX.Y.Z-win-x64
  execFileSync(TAR, ['-x', '-f', nodeZip, '-C', unpack, `${base}/node.exe`, `${base}/LICENSE`], { stdio: 'inherit' });
  const nodeDir = path.join(portable, NAME, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  for (const f of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(unpack, base, f), path.join(nodeDir, f));
  fs.writeFileSync(path.join(nodeDir, 'README.txt'), `${base} from https://nodejs.org, unchanged. Its license is in LICENSE.\r\n`);
  zip(portable, `${NAME}-win-x64-portable.zip`);
}

main();
