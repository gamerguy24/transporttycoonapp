import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { describeStorage, load, persistenceHealthy, save, setPersistence, startAutosave, state } from './store.js';
import { filePersistence } from './persistence/file.js';
import { seed } from './seed.js';
import { startEngine, stopEngine } from './engine/tick.js';
import { handleApi } from './api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, relative);

  // Refuse anything that escapes public/ — the classic ../ traversal.
  if (!resolved.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      // Unknown path with no extension: let the single-page app route it.
      if (!path.extname(resolved)) {
        fs.readFile(path.join(publicDir, 'index.html'), (fallbackErr, html) => {
          if (fallbackErr) res.writeHead(404).end('Not found');
          else res.writeHead(200, { 'content-type': MIME['.html'] }).end(html);
        });
        return;
      }
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  serveStatic(res, url.pathname);
});

// Nothing between here and listen() may be fatal. A hosted deployment that fails
// to open its port just looks "unreachable", which is a miserable thing to debug.
setPersistence(filePersistence());

try {
  const existed = await load();
  if (!existed || Object.keys(state.coins).length === 0) {
    seed();
    await save();
  }
  startAutosave();
} catch (err) {
  console.error(`[startup] state could not be initialised: ${err.stack ?? err.message}`);
  console.error('[startup] continuing with an in-memory exchange.');
}

// Bind every interface explicitly — a platform router cannot reach a loopback bind.
server.listen(config.port, '0.0.0.0', () => {
  console.log(`🚛 Tycoon Crypto Exchange`);
  console.log(`   listening 0.0.0.0:${config.port}`);
  console.log(`   data      ${describeStorage()}${persistenceHealthy() ? '' : '  ** NOT WRITABLE — running from memory **'}`);
  console.log(`   source    ${config.source}${config.source === 'mock' ? ' (set DATA_SOURCE=tycoon for live data)' : ` -> ${config.tycoon.baseUrl}`}`);
  console.log(`   admin     ${config.adminKey ? 'ADMIN_KEY set' : 'no ADMIN_KEY — diagnostics visible from localhost only'}`);
  console.log(`   tick      every ${Math.round(config.tickMs / 1000)}s`);

  // Start pricing only once the port is open, so a slow or failing game API can
  // never delay the platform's health check.
  startEngine();
});

server.on('error', (err) => {
  console.error(`[server] could not listen on ${config.port}: ${err.message}`);
  process.exit(1);
});

function shutdown() {
  console.log('\n[server] shutting down — saving state');
  stopEngine();
  save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
