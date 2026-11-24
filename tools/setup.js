// First-time setup: find the game files, remember where they are (config.json), build the part library.
//
//   node tools/setup.js                      asks for anything it cannot find
//   node tools/setup.js --romfs <dir> [--save <dir>] [--yes]
//
// --yes never asks; anything missing is an error (RomFS) or skipped (save folder).
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const config = require('./lib/config');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const quiet = args.includes('--yes');
const clean = (s) => (s || '').trim().replace(/^["']|["']$/g, '');

const isRomfs = (d) => [d, path.join(d, 'romfs')].some((x) =>
  fs.existsSync(path.join(x, 'Pack', 'ZsDic.pack.zs')) || (fs.existsSync(path.join(x, 'romfs.bin')) && fs.existsSync(path.join(x, 'index.json'))));
const hasSlots = (d) => { try { return fs.readdirSync(d).some((x) => /^slot_\d\d$/.test(x)); } catch { return false; } };
const isSaveRoot = (d) => hasSlots(d) || (() => { try { return fs.readdirSync(d).filter((x) => /^[0-9a-f]{32}$/.test(x) && hasSlots(path.join(d, x))).length === 1; } catch { return false; } })();

async function ask(rl, question, valid, optional) {
  for (;;) {
    const a = clean(await rl.question(question));
    if (!a && optional) return null;
    if (a && valid(path.resolve(a))) return path.resolve(a);
    console.log(optional ? '  Not found there. Try again, or press Enter to skip. / 没找到，请重新输入，或回车跳过。'
      : '  Not found there. Try again. / 没找到，请重新输入。');
  }
}

async function main() {
  console.log('Zelda TotK Blueprint Editor setup / 初始化\n');
  const rl = quiet ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const changes = {};

  // RomFS
  let romfs = opt('--romfs') ? path.resolve(clean(opt('--romfs'))) : config.romfs();
  if (!isRomfs(romfs)) {
    if (opt('--romfs')) throw new Error('No RomFS in ' + romfs);
    if (quiet) throw new Error('RomFS not found. Pass --romfs <folder> (the one with Pack/ and Model/ in it).');
    console.log('Where is the game\'s RomFS? Give the extracted folder, the one with Pack/ and Model/ in it.');
    console.log('游戏的 RomFS 在哪？请给出解包后的文件夹（里面有 Pack/ 和 Model/ 的那一层）。');
    romfs = await ask(rl, 'RomFS: ', isRomfs, false);
  }
  if (romfs !== config.romfs()) changes.romfs = romfs;
  console.log('RomFS: ' + romfs);

  // save folder (only needed to import into a save)
  let save = opt('--save') ? path.resolve(clean(opt('--save'))) : config.saveRoot();
  if (!isSaveRoot(save)) {
    if (opt('--save')) throw new Error('No save slots (slot_00 ...) in ' + save);
    if (!quiet) {
      console.log('\nOptional: the save folder, the one with slot_00, slot_01 ... in it (needed to put blueprints into a save).');
      console.log('可选：存档文件夹，也就是里面有 slot_00、slot_01 的那个（往存档里导入蓝图时要用）。回车跳过。');
      save = await ask(rl, 'Save folder / 存档文件夹: ', isSaveRoot, true);
    } else save = null;
  }
  if (save && save !== config.saveRoot()) changes.saveRoot = save;
  console.log('Saves / 存档: ' + (save || '(not set / 未设置)'));
  if (rl) rl.close();

  if (Object.keys(changes).length) {
    config.save(changes);
    console.log('Saved to / 已保存到 ' + config.FILE);
  }

  // build the part library
  for (const script of ['scan_assemblable.js', 'build_library.js']) {
    console.log(`\n> node tools/${script}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(script + ' failed');
  }
  console.log('\nDone. Start the editor with editor.cmd (or: node app/server/serve.mjs --open).');
  console.log('完成。用 editor.cmd 打开编辑器（或者 node app/server/serve.mjs --open）。');
  console.log('3D models are optional and need MeshCodec in WSL; see the README. / 3D 模型是可选的，需要 WSL 里的 MeshCodec，见 README。');
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
