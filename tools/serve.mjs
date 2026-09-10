#!/usr/bin/env node
/**
 * Tiny static server for local development and testing.
 *
 * Exists mainly to send the right Content-Type for .wasm and .webmanifest,
 * which several simple servers get wrong — and a wrong wasm MIME type breaks
 * OCR with a confusing error.
 *
 *   node tools/serve.mjs [port]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.traineddata': 'application/octet-stream',
  '.pdf': 'application/pdf',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // Never serve outside the project root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) {
      if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      else { res.writeHead(404).end('Not found'); return; }
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) { res.writeHead(404).end('Not found'); return; }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        // Service workers and modules need a same-origin, non-sandboxed page.
        'Cross-Origin-Opener-Policy': 'same-origin',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`ScanPro served at http://localhost:${PORT}`);
});
