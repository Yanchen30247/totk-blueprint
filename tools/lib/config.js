// Where things are. Each setting comes from an environment variable if set, else from config.json in the project folder
// (written by tools/setup.js), else a default that assumes the game folder is called zelda_king and sits next to the
// project folder.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = path.join(ROOT, 'config.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
const cfg = load();
const pick = (env, key) => process.env[env] || cfg[key] || null;

/** The game folder (holds romfs/, profile/save/, blueprint/ in the PC layout this was developed with). */
const install = () => path.resolve(pick('TOTK_INSTALL', 'install') || path.join(ROOT, '..', 'zelda_king'));
/** The RomFS: an extracted folder, or a folder with romfs.bin + index.json. */
const romfs = () => path.resolve(pick('TOTK_ROMFS', 'romfs') || install());
/** The folder with slot_00, slot_01 ... (or the folder above one account folder that holds them). */
const saveRoot = () => path.resolve(pick('TOTK_SAVE_ROOT', 'saveRoot') || path.join(install(), 'profile', 'save'));
/** The game's Autobuild picture cache (Draft_<n>.png). */
const iconDir = () => path.resolve(pick('TOTK_ICON_DIR', 'iconDir') || path.join(saveRoot(), '..', 'cache', '0', 'icon'));
/** The editor's blueprint folder: blueprint/ in the game folder when there is one, else blueprints/ in the project. */
const blueprintDir = () => path.resolve(pick('BLUEPRINT_DIR', 'blueprintDir')
  || (fs.existsSync(install()) ? path.join(install(), 'blueprint') : path.join(ROOT, 'blueprints')));
/** Where save backups go. */
const backupRoot = () => path.resolve(pick('TOTK_BACKUP_ROOT', 'backupRoot') || path.join(ROOT, 'backups'));
/** The generated part library. */
const libraryDir = () => path.join(ROOT, 'gamedata', 'library');

/** Merge values into config.json (null removes a key). */
function save(values) {
  const next = { ...load() };
  for (const [k, v] of Object.entries(values)) { if (v == null) delete next[k]; else next[k] = v; }
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  Object.assign(cfg, next);
}

module.exports = { ROOT, FILE, install, romfs, saveRoot, iconDir, blueprintDir, backupRoot, libraryDir, save };
