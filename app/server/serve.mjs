// Standalone editor server for the release packages: serves the built editor (app/dist) and the local API (api.mjs)
// on http://localhost:5175, or the next free port. No npm packages needed.
//
//   node app/server/serve.mjs [--port 5175] [--open]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localApi, LIB_DIR } from './api.mjs';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
let port = portArg >= 0 ? +args[portArg + 1] : 5175;
const open = args.includes('--open');

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`The built editor is missing (${DIST}). In a source checkout, run: npm --prefix app run build`);
  process.exit(1);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(DIST, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Content-Length', String(statSync(file).size));
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => localApi(req, res, () => serveStatic(req, res)));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* open it by hand */ }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && portArg < 0 && port < 5195) { port++; server.listen(port, 'localhost'); return; }
  console.error(e.message);
  process.exit(1);
});
server.on('listening', () => {
  const url = `http://localhost:${port}/`;
  console.log(`Editor running at ${url}  (Ctrl+C to stop)`);
  if (!existsSync(path.join(LIB_DIR, 'library.json'))) console.log('The part library is not built yet: run setup first (node tools/setup.js).');
  if (open) openBrowser(url);
});
server.listen(port, 'localhost');
