// Tiny static file server for development and tests. GitHub Pages is the real host; this only
// mimics it (static files, correct MIME types, no special headers, so no cross-origin isolation).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.carrel': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
};

export function startServer({ root, port = 0, overrides = new Map() } = {}) {
  const base = path.resolve(root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const override = overrides.get(rel);
    if (override) {
      res.writeHead(200, { 'Content-Type': override.type ?? MIME[path.extname(rel)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(override.body);
      return;
    }
    const file = path.join(base, rel);
    if (!file.startsWith(base)) { res.writeHead(403).end('forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.unref(); // a leaked test server must never keep the process alive; the CLI below keeps itself alive
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, requests, overrides, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
  const s = await startServer({ port });
  console.log(`carrel dev server: ${s.url}  (Ctrl-C to stop)`);
  setInterval(() => {}, 1 << 30); // keep the process alive
}
