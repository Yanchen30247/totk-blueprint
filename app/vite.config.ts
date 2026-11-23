// Dev server for the editor.
// - /gamedata/library/* is served from ../gamedata/library, which tools/build_library.js and build_models.js write from
//   the local game install; that folder is git-ignored and never bundled.
// - /api/blueprints lists, reads and writes blueprint files (.json, .cai, .cmbact) in one local folder, so the editor
//   does not depend on the browser's file dialogs (the desktop app's browser pane has none). The folder is
//   BLUEPRINT_DIR, by default blueprint/ in the game folder (TOTK_INSTALL, or zelda_king next to this project).
import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(here, '..', 'gamedata', 'library');
const INSTALL = process.env.TOTK_INSTALL || path.resolve(here, '..', '..', 'zelda_king');
const BLUEPRINT_DIR = path.resolve(process.env.BLUEPRINT_DIR || path.join(INSTALL, 'blueprint'));
const NAME_OK = /^[^\\/:*?"<>|\x00-\x1f]{1,120}\.(json|cai|cmbact)$/i;
const MAX_BYTES = 1 << 20;

function localLibrary(): Plugin {
  return {
    name: 'local-library',
    configureServer(server) {
      server.middlewares.use('/gamedata/library', (req, res, next) => {
        const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
        if (!/^((models|textures|thumbs)\/)?[\w.-]+\.(json|glb|png)$/.test(name)) return next();
        const file = path.join(LIB_DIR, name);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end('missing: run node tools/build_library.js');
          return;
        }
        res.setHeader('Content-Type', name.endsWith('.glb') ? 'model/gltf-binary' : name.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(statSync(file).size));
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });

      // Library thumbnails rendered by the editor (src/thumbs.ts): GET lists them, PUT stores one.
      server.middlewares.use('/api/thumbs', (req, res) => {
        const dir = path.join(LIB_DIR, 'thumbs');
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
        if (!name && req.method === 'GET') return send(200, { files: existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : [] });
        if (req.method !== 'PUT' || !/^[\w.-]+\.png$/.test(name)) return send(400, { error: 'bad request' });
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size <= 512 * 1024) chunks.push(c); });
        req.on('end', () => {
          if (size > 512 * 1024) return send(413, { error: 'too large' });
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, name), Buffer.concat(chunks));
          send(200, { ok: true });
        });
      });

      server.middlewares.use('/api/blueprints', (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        const [rawPath, query = ''] = (req.url || '/').split('?');
        const name = decodeURIComponent(rawPath).replace(/^\/+/, '');
        // list
        if (!name) {
          if (req.method !== 'GET') return send(405, { error: 'method' });
          if (!existsSync(BLUEPRINT_DIR)) return send(200, { dir: BLUEPRINT_DIR, files: [] });
          const files = readdirSync(BLUEPRINT_DIR)
            .filter((f) => NAME_OK.test(f))
            .map((f) => { const st = statSync(path.join(BLUEPRINT_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
            .sort((a, b) => b.mtime - a.mtime);
          return send(200, { dir: BLUEPRINT_DIR, files });
        }
        if (!NAME_OK.test(name) || name.includes('..')) return send(400, { error: '文件名不合法' });
        const file = path.join(BLUEPRINT_DIR, name);
        if (req.method === 'GET') {
          if (!existsSync(file)) return send(404, { error: '文件不存在' });
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          createReadStream(file).pipe(res);
          return;
        }
        if (req.method === 'PUT') {
          const overwrite = /(^|&)overwrite=1(&|$)/.test(query);
          if (existsSync(file) && !overwrite) return send(409, { error: '文件已存在' });
          const chunks: Buffer[] = [];
          let size = 0;
          req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); });
          req.on('end', () => {
            if (size > MAX_BYTES) return send(413, { error: '文件太大' });
            mkdirSync(BLUEPRINT_DIR, { recursive: true });
            const tmp = file + '.tmp';
            writeFileSync(tmp, Buffer.concat(chunks));
            renameSync(tmp, file);
            send(200, { ok: true, path: file });
          });
          return;
        }
        send(405, { error: 'method' });
      });
    },
  };
}

export default defineConfig({
  plugins: [localLibrary()],
  server: { port: 5175, strictPort: false, host: 'localhost' },
});
