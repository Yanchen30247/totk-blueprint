// JSON answers for the import window (import_gui.ps1). Every command prints one JSON object on stdout.
//
//   node tools/import_backend.js state [--slot 03] [--extra <file>]...   slots, the slot's history, blueprint files
//   node tools/import_backend.js plan <file> [--slot 03]                  what an import would do (nothing written)
//   node tools/import_backend.js write <file> [--slot 03] [--force]       back up the slot and import
//
// Blueprint files are the .cai / .cmbact files in the blueprint folder plus any --extra. The folder is BLUEPRINT_DIR, or
// blueprint/ in the game folder (TOTK_INSTALL, or zelda_king next to this project).
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./save_inject');

const INSTALL = process.env.TOTK_INSTALL || path.resolve(__dirname, '..', '..', 'zelda_king');
const BLUEPRINT_DIR = path.resolve(process.env.BLUEPRINT_DIR || path.join(INSTALL, 'blueprint'));

/** Chinese part names from the editor's library, when it has been built. */
function partNames() {
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gamedata', 'library', 'library.json'), 'utf8'));
    return Object.fromEntries(lib.parts.map((p) => [p.actor, p.name]));
  } catch { return {}; }
}

function args(argv) {
  const o = { cmd: argv[0], file: null, slot: null, force: false, extra: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--slot') o.slot = String(argv[++i]).padStart(2, '0');
    else if (argv[i] === '--force') o.force = true;
    else if (argv[i] === '--extra') o.extra.push(argv[++i]);
    else o.file = argv[i];
  }
  return o;
}

function summary(blob, names) {
  const c = S.contents(blob);
  return { parts: c.parts, bonds: c.bonds, text: c.items.map((x) => `${names[x.actor] || x.actor}×${x.count}`).join('、') };
}

function fileInfo(file, s, names) {
  const st = fs.statSync(file);
  const info = { path: path.resolve(file), name: path.basename(file), modified: st.mtime.toISOString(), ok: true };
  try {
    const blob = S.readBlueprint(file);
    Object.assign(info, summary(blob, names));
    const same = S.findEntry(s, blob);
    const similar = same >= 0 ? same : S.findSimilar(s, blob);
    info.status = same >= 0 ? 'same' : similar >= 0 ? 'similar' : 'new';
    info.entry = similar;
  } catch (e) {
    info.ok = false;
    info.error = e.message;
  }
  return info;
}

function state(o) {
  const dir = S.accountDir();
  const slots = S.listSlots(dir);
  const slot = o.slot || (slots[0] && slots[0].slot);
  if (!slot) throw new Error('没有找到存档槽');
  const s = S.openSlot(dir, slot);
  const names = partNames();
  const history = [];
  s.log.forEach((b, i) => { if (b.length) history.push({ index: i, order: s.seq[i], ...summary(b, names) }); });
  history.sort((a, b) => a.order - b.order);
  let files = [];
  if (fs.existsSync(BLUEPRINT_DIR)) {
    files = fs.readdirSync(BLUEPRINT_DIR).filter((f) => /\.(cai|cmbact)$/i.test(f)).map((f) => path.join(BLUEPRINT_DIR, f));
  }
  for (const f of o.extra) if (fs.existsSync(f) && !files.some((x) => path.resolve(x) === path.resolve(f))) files.push(f);
  files = files.map((f) => fileInfo(f, s, names)).sort((a, b) => b.modified.localeCompare(a.modified));
  return {
    ok: true,
    saveDir: dir,
    blueprintDir: BLUEPRINT_DIR,
    gameRunning: S.gameRunning(),
    slots: slots.map((x) => ({ slot: x.slot, savedAt: x.savedAt.toISOString() })),
    slot,
    slotDir: s.slotDir,
    savedAt: s.savedAt.toISOString(),
    used: history.length,
    capacity: s.log.length,
    history,
    files,
  };
}

function planOrWrite(o, write) {
  if (!o.file) throw new Error('没有选择蓝图文件');
  const dir = S.accountDir();
  const slot = o.slot || S.latestSlot(dir);
  const s = S.openSlot(dir, slot);
  const blob = S.readBlueprint(o.file);
  const p = S.plan(s, blob, o.force);
  const out = { ok: true, slot, index: p.index, similar: p.similar, dup: p.dup, ...summary(blob, partNames()) };
  if (write) out.backup = S.apply(s, p);
  return out;
}

function main() {
  const o = args(process.argv.slice(2));
  if (o.cmd === 'state') return state(o);
  if (o.cmd === 'plan') return planOrWrite(o, false);
  if (o.cmd === 'write') return planOrWrite(o, true);
  throw new Error('未知命令：' + o.cmd);
}

let result;
try { result = main(); } catch (e) { result = { ok: false, error: e.message }; }
process.stdout.write(JSON.stringify(result));
