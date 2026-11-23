// Dev server for the editor. The local API (part library, thumbnails, blueprint folder) lives in server/api.mjs and is
// shared with the standalone server of the release packages (server/serve.mjs).
import { defineConfig, type Plugin } from 'vite';
import { localApi } from './server/api.mjs';

function localLibrary(): Plugin {
  return {
    name: 'local-library',
    configureServer(server) {
      server.middlewares.use((req, res, next) => localApi(req, res, next));
    },
  };
}

export default defineConfig({
  plugins: [localLibrary()],
  server: { port: 5175, strictPort: false, host: 'localhost' },
  // three.js alone is ~600 kB; one bundle is fine for a local tool
  build: { chunkSizeWarningLimit: 1500 },
});
