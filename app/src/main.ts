import './style.css';
import { App } from './app.ts';
import type { Draft, Library, ModelInfo } from './types.ts';
import { lang, tr } from './i18n.ts';

async function load<T>(name: string): Promise<T> {
  const r = await fetch(`/gamedata/library/${name}`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function start() {
  const root = document.getElementById('root')!;
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  document.title = tr('究极手蓝图编辑器', 'Ultrahand Blueprint Editor');
  try {
    const [lib, drafts] = await Promise.all([load<Library>('library.json'), load<Draft[]>('drafts.json')]);
    // Models are optional: without tools/build_models.js the editor shows collision shapes.
    const models = await load<Record<string, ModelInfo>>('models.json').catch(() => ({} as Record<string, ModelInfo>));
    // Sub bodies sit where the model's skeleton puts them at rest (tools/build_models.js). This replaces the offsets
    // measured from the game's schematics, which hold whatever state the designer saved (a turned golem head, a
    // compressed suspension).
    for (const part of lib.parts) {
      const rel = models[part.actor] && models[part.actor].restRel;
      if (rel) { part.subRel = { 1: rel[1] ?? null, 2: rel[2] ?? null }; part.subRelKnown = true; }
    }
    const app = new App(root, lib, drafts, models);
    if (import.meta.env.DEV) (window as unknown as { __totk: App }).__totk = app;
  } catch (e) {
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'missing';
    box.innerHTML = tr(
      '<h1>零件库还没生成</h1><p>在项目目录运行：</p><pre>node tools/scan_assemblable.js<br>node tools/build_library.js</pre>' +
      '<p>它们只读取你本机的游戏文件（RomFS 位置用环境变量 TOTK_ROMFS 或 TOTK_INSTALL 指定），结果写到 <code>gamedata/library/</code>。</p>',
      '<h1>The part library has not been built yet</h1><p>In the project folder, run:</p><pre>node tools/scan_assemblable.js<br>node tools/build_library.js</pre>' +
      '<p>They read the game files on your machine (point TOTK_ROMFS or TOTK_INSTALL at the RomFS) and write to <code>gamedata/library/</code>.</p>');
    const err = document.createElement('p');
    err.className = 'muted';
    err.textContent = String((e as Error).message || e);
    box.append(err);
    root.append(box);
  }
}

start();
