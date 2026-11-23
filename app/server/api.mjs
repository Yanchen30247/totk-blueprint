// The editor's local API, shared by the Vite dev server (vite.config.ts) and the standalone server (serve.mjs).
// - /gamedata/library/*  the part library that tools/build_library.js and build_models.js write from your game files
// - /api/thumbs          library thumbnails rendered by the editor: GET lists them, PUT stores one
// - /api/blueprints      lists, reads and writes blueprint files (.json, .cai, .cmbact) in the blueprint folder, so the
//                        editor does not depend on the browser's file dialogs
// Everything stays on this machine; the server only listens on localhost.
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const config = createRequire(import.meta.url)('../../tools/lib/config.js');

const NAME_OK = /^[^\\/:*?"<>|\x00-\x1f]{1,120}\.(json|cai|cmbact)$/i;
const MAX_BYTES = 1 << 20;
const MAX_THUMB = 512 * 1024;

export const LIB_DIR = config.libraryDir();
export const BLUEPRINT_DIR = config.blueprintDir();

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req, limit, done) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
  req.on('end', () => done(size > limit ? null : Buffer.concat(chunks)));
}

function library(req, res, rest) {
  const name = decodeURIComponent(rest.split('?')[0]).replace(/^\/+/, '');
  if (!/^((models|textures|thumbs)\/)?[\w.-]+\.(json|glb|png)$/.test(name)) return send(res, 404, { error: 'not found' });
  const file = path.join(LIB_DIR, name);
  if (!existsSync(file)) return send(res, 404, { error: 'missing: run node tools/setup.js' });
  res.setHeader('Content-Type', name.endsWith('.glb') ? 'model/gltf-binary' : name.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(statSync(file).size));
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(file).pipe(res);
}

function thumbs(req, res, rest) {
  const dir = path.join(LIB_DIR, 'thumbs');
  const name = decodeURIComponent(rest.split('?')[0]).replace(/^\/+/, '');
  if (!name && req.method === 'GET') return send(res, 200, { files: existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : [] });
  if (req.method !== 'PUT' || !/^[\w.-]+\.png$/.test(name)) return send(res, 400, { error: 'bad request' });
  readBody(req, MAX_THUMB, (body) => {
    if (!body) return send(res, 413, { error: 'too large' });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), body);
    send(res, 200, { ok: true });
  });
}

function blueprints(req, res, rest) {
  const [rawPath, query = ''] = rest.split('?');
  const name = decodeURIComponent(rawPath).replace(/^\/+/, '');
  if (!name) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    if (!existsSync(BLUEPRINT_DIR)) return send(res, 200, { dir: BLUEPRINT_DIR, files: [] });
    const files = readdirSync(BLUEPRINT_DIR)
      .filter((f) => NAME_OK.test(f))
      .map((f) => { const st = statSync(path.join(BLUEPRINT_DIR, f)); return { name: f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, { dir: BLUEPRINT_DIR, files });
  }
  if (!NAME_OK.test(name) || name.includes('..')) return send(res, 400, { error: 'bad file name' });
  const file = path.join(BLUEPRINT_DIR, name);
  if (req.method === 'GET') {
    if (!existsSync(file)) return send(res, 404, { error: 'no such file' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(res);
    return;
  }
  if (req.method === 'PUT') {
    const overwrite = /(^|&)overwrite=1(&|$)/.test(query);
    if (existsSync(file) && !overwrite) return send(res, 409, { error: 'file exists' });
    readBody(req, MAX_BYTES, (body) => {
      if (!body) return send(res, 413, { error: 'file too large' });
      mkdirSync(BLUEPRINT_DIR, { recursive: true });
      const tmp = file + '.tmp';
      writeFileSync(tmp, body);
      renameSync(tmp, file);
      send(res, 200, { ok: true, path: file });
    });
    return;
  }
  send(res, 405, { error: 'method' });
}

const ROUTES = [['/gamedata/library', library], ['/api/thumbs', thumbs], ['/api/blueprints', blueprints]];

/** Connect-style middleware: handles the routes above and passes everything else to next(). */
export function localApi(req, res, next) {
  const url = req.url || '/';
  for (const [prefix, handler] of ROUTES) {
    if (url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?')) return handler(req, res, url.slice(prefix.length) || '/');
  }
  next();
}
