// Put a blueprint into the Autobuild history of a TotK save, so it appears in the game's Autobuild menu.
//
//   node tools/save_inject.js --list [--slot 03]             list the history of a slot
//   node tools/save_inject.js <blueprint.cmbact|.cai> [--slot 03]          dry run: show what would change
//   node tools/save_inject.js <blueprint.cmbact|.cai> [--slot 03] --write  back up the slot, then write
//
// The blueprint file comes from the editor ("导出存档记录" writes the 6688-byte form; a .cai works too).
// Without --slot the most recently saved slot is used. The game must be closed.
// The functions are also used by import_backend.js (the import window).
//
// What an Autobuild history entry is, from the saves (GameDataList Struct 1439382339, 30 entries):
//   progress.sav  BinaryArray 2774999734[i]  the CombinedActorInfo blob (6688 bytes)
//                 IntArray    3531572817[i]  -1 when unused; recency order, 0 = newest (the game shifts the others up)
//                 Vector3Array 3317639189[i], 4017413287[i]  two vectors, likely the preview camera
//                 BoolArray   1744090219[i], 121274663[i]  false in the sample
//                 Int         1388727046     a running count: +1 per new entry (it read 7 with 5 entries after more play)
//   direct_file_save_related.sav  IntArray 1079518842[i] (newest has the largest number), BoolArray 2982606130[i] (used)
// After the game saved a new entry next to two injected ones, 3531572817 went 0,1,2 -> 1,2,3 with the new one 0, and
// 1079518842 read 3,4,5,6 (newest 6). A written entry follows that: order 0, the others +1, 1388727046 + 1, and a
// 1079518842 number no slot uses and no cached picture has (see ICON_DIR). The same blueprint is not written twice unless forced. Every write is preceded by a backup.
// When an entry is built, the game saves it again with the poses it measured, so a later import of the same file is
// only "similar" (same parts and bonds), not identical; that is reported as a warning.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { SaveFile } = require('./lib/save');
const { parseCai } = require('./lib/cai');

const H = {
  log: 2774999734, seq: 3531572817, camA: 3317639189, camB: 4017413287, flagA: 1744090219, flagB: 121274663, counter: 1388727046,
  directSeq: 1079518842, directUsed: 2982606130,
};
// TOTK_SAVE_ROOT: the folder with the slot_00 ... folders, or the folder above one account folder that holds them.
// By default the PC build's profile/save in the game folder (TOTK_INSTALL, or zelda_king next to this project).
const INSTALL = process.env.TOTK_INSTALL || path.resolve(__dirname, '..', '..', 'zelda_king');
const SAVE_ROOT = process.env.TOTK_SAVE_ROOT || path.join(INSTALL, 'profile', 'save');
const BACKUP_ROOT = process.env.TOTK_BACKUP_ROOT || path.join(__dirname, '..', 'backups');
// The game caches a picture of each Autobuild history entry as Draft_<id>.png, <id> being the entry's number in
// direct_file_save_related.sav 1079518842. The cache is shared by every slot and is used whenever a file exists for
// the number, so an entry given a number that once belonged to another blueprint shows that blueprint's picture
// (seen once: a new blueprint showed an older one's picture). Without a file the game draws a new picture.
const ICON_DIR = process.env.TOTK_ICON_DIR || path.join(SAVE_ROOT, '..', 'cache', '0', 'icon');
const SIZE = 6688;

function accountDir(given) {
  if (given) return given;
  if (fs.existsSync(SAVE_ROOT) && listSlots(SAVE_ROOT).length) return SAVE_ROOT;
  const dirs = fs.readdirSync(SAVE_ROOT).filter((d) => /^[0-9a-f]{32}$/.test(d));
  if (dirs.length !== 1) throw new Error(`在 ${SAVE_ROOT} 里应有一个账号文件夹，实际 ${dirs.length} 个；请用 --save-dir 指定`);
  return path.join(SAVE_ROOT, dirs[0]);
}

/** Slots that have a progress.sav, newest save first: [{ slot: '03', savedAt: Date }]. */
function listSlots(dir) {
  return fs.readdirSync(dir)
    .filter((d) => /^slot_\d\d$/.test(d) && fs.existsSync(path.join(dir, d, 'progress.sav')))
    .map((d) => ({ slot: d.slice(5), savedAt: fs.statSync(path.join(dir, d, 'progress.sav')).mtime }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

function latestSlot(dir) {
  const s = listSlots(dir);
  if (!s.length) throw new Error('没有找到存档槽');
  return s[0].slot;
}

/** Read one slot: both save files and its Autobuild history. */
function openSlot(dir, slot) {
  const slotDir = path.join(dir, 'slot_' + slot);
  const progPath = path.join(slotDir, 'progress.sav');
  const directPath = path.join(slotDir, 'direct_file_save_related.sav');
  const prog = new SaveFile(fs.readFileSync(progPath));
  const direct = new SaveFile(fs.readFileSync(directPath));
  prog.layout();
  direct.layout();
  return {
    dir, slot, slotDir, progPath, directPath, prog, direct,
    savedAt: fs.statSync(progPath).mtime,
    log: prog.readBinaryArray(H.log),
    seq: prog.readArray(H.seq),
    counter: prog.value(H.counter) | 0,
  };
}

/** The blueprint as the 6688-byte history form (a 7840-byte .cai starts with it). */
function readBlueprint(file) {
  let blob = fs.readFileSync(file);
  if (blob.toString('ascii', 0, 6) !== 'CmbAct') throw new Error('不是 CmbAct 蓝图文件');
  if (blob.length === 7840) blob = blob.subarray(0, SIZE);
  if (blob.length !== SIZE) throw new Error(`蓝图应为 ${SIZE} 字节，实际 ${blob.length}`);
  return Buffer.from(blob);
}

/** Parts and bonds of a blueprint: { parts, bonds, items: [{ actor, count }] }. */
function contents(blob) {
  const c = parseCai(Buffer.concat([blob, Buffer.alloc(Math.max(0, 7840 - blob.length))]));
  const count = new Map();
  for (const p of c.parts) count.set(p.actor, (count.get(p.actor) || 0) + 1);
  return { parts: c.parts.length, bonds: c.bonds.length, items: [...count].map(([actor, n]) => ({ actor, count: n })) };
}

function describe(blob, names = {}) {
  const c = contents(blob);
  return `${c.parts} 个零件、${c.bonds} 条粘合：` + c.items.map((x) => `${names[x.actor] || x.actor}×${x.count}`).join('、');
}

function gameRunning() {
  try {
    return /totk\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq totk.exe" /NH', { encoding: 'utf8', windowsHide: true }));
  } catch { return false; }
}

/** Write through a temporary file and a rename, so a hard link to the old file (the game's save-backup) keeps the old data. */
function replaceFile(file, data) {
  const tmp = file + '.tmp-blueprint';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Every data item of a save keyed by hash, for comparing two saves. */
function items(sv) {
  const m = new Map();
  for (const it of sv.layout()) m.set(it.p.group + ':' + it.p.hash, sv.buf.subarray(it.off, it.off + it.len));
  for (const p of sv.pairs) if (['Bool', 'Int', 'Float', 'Enum', 'UInt'].includes(p.group)) m.set(p.group + ':' + p.hash, sv.buf.subarray(p.pos + 4, p.pos + 8));
  return m;
}

function verifyOnly(before, after, allowed) {
  const a = items(before), b = items(after);
  const changed = [];
  for (const [k, v] of a) {
    if (!b.has(k)) throw new Error('item vanished: ' + k);
    if (!v.equals(b.get(k))) changed.push(k);
  }
  const unexpected = changed.filter((k) => !allowed.includes(+k.split(':')[1]));
  if (unexpected.length) throw new Error('unexpected changes: ' + unexpected.join(', '));
  return changed;
}

/** Numbers with a cached history picture (Draft_<n>.png). */
function cachedDraftIds() {
  try {
    return new Set(fs.readdirSync(ICON_DIR).map((f) => f.match(/^Draft_(\d+)\.png$/)).filter(Boolean).map((m) => +m[1]));
  } catch { return new Set(); }
}

/** Entry numbers (1079518842) in use in any slot of the account. */
function usedDraftIds(dir) {
  const used = new Set();
  for (const { slot } of listSlots(dir)) {
    try {
      const d = new SaveFile(fs.readFileSync(path.join(dir, 'slot_' + slot, 'direct_file_save_related.sav')));
      d.layout();
      for (const v of d.readArray(H.directSeq)) if (v >= 0) used.add(v);
    } catch { /* unreadable slot: ignore */ }
  }
  return used;
}

/**
 * A number for a new history entry that no slot uses and that has no cached picture, so the game draws one for this
 * blueprint: from the running count 1388727046 (which only grows) upward.
 */
function freshDraftId(s) {
  const used = usedDraftIds(s.dir), cached = cachedDraftIds();
  for (const v of s.direct.readArray(H.directSeq)) if (v >= 0) used.add(v);
  let id = Math.max(s.counter, Math.max(-1, ...used) + 1);
  while (used.has(id) || cached.has(id)) id++;
  return id;
}

/** Index of the history entry holding exactly this blueprint, or -1. */
function findEntry(s, blob) {
  return s.log.findIndex((b) => b.length && b.equals(blob));
}

/** Parts in order and bonds, the part of a blueprint the game keeps when it saves the entry again. */
function signature(blob) {
  const c = parseCai(Buffer.concat([blob, Buffer.alloc(Math.max(0, 7840 - blob.length))]));
  return JSON.stringify([c.parts.map((p) => p.actor), c.bonds.map((b) => [b.a, b.b, b.u0, b.u1])]);
}

/**
 * Index of an entry with the same parts and bonds, or -1. After the game builds a history entry it saves it again with
 * the poses it measured (seen: every part 5 cm along X, the control stick at a different angle), so an imported
 * blueprint stops being byte-identical to its entry.
 */
function findSimilar(s, blob) {
  const sig = signature(blob);
  return s.log.findIndex((b) => {
    if (!b.length) return false;
    try { return signature(b) === sig; } catch { return false; }
  });
}

/**
 * The new save contents with the blueprint added on top of the history, checked but not written.
 * Throws when the blueprint is already there (unless force) or the history is full.
 */
function plan(s, blob, force = false) {
  const dup = findEntry(s, blob);
  if (dup >= 0 && !force) throw new Error(`这个蓝图已经在历史第 ${dup} 条里了。`);
  const i = s.log.findIndex((b) => b.length === 0);
  if (i < 0) throw new Error('历史已满（30 条）。先在游戏里删除一条历史再试。');
  const { prog, direct, log, seq } = s;
  const n = s.counter;
  const nextDirect = freshDraftId(s);
  const filled = log.findIndex((b) => b.length > 0);
  const camA = filled >= 0 ? prog.readArray(H.camA)[filled] : [0, 24.56, 51.07];
  const camB = filled >= 0 ? prog.readArray(H.camB)[filled] : [0, 21.96, 45.68];

  const next = log.slice();
  next[i] = blob;
  const newProg = prog.withBinaryArray(H.log, next);
  seq.forEach((v, k) => { if (k !== i && v >= 0) newProg.writeArrayElement(H.seq, k, v + 1); });
  newProg.writeArrayElement(H.seq, i, 0);
  newProg.writeArrayElement(H.camA, i, camA);
  newProg.writeArrayElement(H.camB, i, camB);
  newProg.setInline(H.counter, n + 1);
  const newDirect = new SaveFile(Buffer.from(direct.buf));
  newDirect.writeArrayElement(H.directSeq, i, nextDirect);
  newDirect.writeArrayElement(H.directUsed, i, true);

  // Checks before anything is written: the layout still tiles, the entry reads back, nothing else changed.
  newProg.layout();
  newDirect.layout();
  if (!newProg.readBinaryArray(H.log)[i].equals(blob)) throw new Error('entry does not read back');
  const changed = verifyOnly(prog, newProg, [H.log, H.seq, H.camA, H.camB, H.counter])
    .concat(verifyOnly(direct, newDirect, [H.directSeq, H.directUsed]));
  return { index: i, counter: [n, n + 1], draftId: nextDirect, cameraFrom: filled, dup, similar: findSimilar(s, blob), blob, newProg, newDirect, changed };
}

/** Back up the slot, then write the planned save. Returns the backup folder. */
function apply(s, p) {
  if (gameRunning()) throw new Error('游戏正在运行，请先退出游戏再写入。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bdir = path.join(BACKUP_ROOT, stamp, 'slot_' + s.slot);
  fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(s.progPath, path.join(bdir, 'progress.sav'));
  fs.copyFileSync(s.directPath, path.join(bdir, 'direct_file_save_related.sav'));
  replaceFile(s.progPath, p.newProg.buf);
  replaceFile(s.directPath, p.newDirect.buf);
  const check = new SaveFile(fs.readFileSync(s.progPath));
  if (!check.readBinaryArray(H.log)[p.index].equals(p.blob)) throw new Error('写入后读回不一致，请用备份恢复：' + bdir);
  return bdir;
}

// ---------- command line ----------

function args() {
  const a = process.argv.slice(2);
  const o = { file: null, slot: null, write: false, list: false, dir: null, force: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--slot') o.slot = a[++i].padStart(2, '0');
    else if (a[i] === '--write') o.write = true;
    else if (a[i] === '--force') o.force = true;
    else if (a[i] === '--list') o.list = true;
    else if (a[i] === '--save-dir') o.dir = a[++i];
    else o.file = a[i];
  }
  return o;
}

function main() {
  const o = args();
  const dir = accountDir(o.dir);
  const s = openSlot(dir, o.slot || latestSlot(dir));
  console.log(`存档：${s.slotDir}（最后保存 ${s.savedAt.toLocaleString()}）`);
  console.log(`究极建造历史：${s.log.filter((x) => x.length).length} / ${s.log.length} 条，计数 ${s.counter}`);
  s.log.forEach((b, i) => { if (b.length) console.log(`  #${i} 序号 ${s.seq[i]}：${describe(b)}`); });
  if (o.list) return;
  if (!o.file) throw new Error('需要蓝图文件（编辑器里“导出存档记录”得到的 .cmbact，或 .cai）');
  const blob = readBlueprint(o.file);
  console.log(`要写入的蓝图：${describe(blob)}`);
  let p;
  try { p = plan(s, blob, o.force); } catch (e) { throw new Error(e.message + (/已经在历史/.test(e.message) ? '（加 --force 仍然写入）' : '')); }
  console.log(`计划：写入第 ${p.index} 条，排在历史最前（顺序号 0，其余 +1），图片编号 ${p.draftId}，计数 ${p.counter[0]} -> ${p.counter[1]}；两个预览向量沿用${p.cameraFrom >= 0 ? '第 ' + p.cameraFrom + ' 条' : '样本值'}。`);
  if (p.similar >= 0 && p.dup < 0) console.log(`注意：历史第 ${p.similar} 条的零件和粘合与它相同，可能已经导入过（游戏建造后会微调保存的位置）。`);
  console.log('校验通过。改动的项：', p.changed.join(', '));
  if (!o.write) { console.log('这是试运行，没有写入。加 --write 才会写。'); return; }
  const bdir = apply(s, p);
  console.log('已备份到', bdir);
  console.log(`已写入 slot_${s.slot} 的究极建造历史第 ${p.index} 条。进游戏读取这个存档，在究极建造的“历史”里查看。`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('错误：' + e.message); process.exit(1); }
}

module.exports = { accountDir, listSlots, latestSlot, openSlot, readBlueprint, contents, describe, gameRunning, findEntry, findSimilar, plan, apply, cachedDraftIds, ICON_DIR, SIZE };
