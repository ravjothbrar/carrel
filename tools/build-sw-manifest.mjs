// Writes precache.json (every file the service worker caches) and stamps a content hash into sw.js,
// so a changed file produces a new worker and a fresh cache. Run after changing anything shipped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : [rel];
  });
}

export function computePrecache() {
  const files = [
    'index.html',
    'manifest.webmanifest',
    ...walk('css'),
    ...walk('js'),
    ...walk('icons'),
    ...walk('vendor').filter((f) => /\.(m?js|wasm)$/.test(f)),
    ...walk('fonts').filter((f) => f.endsWith('.woff2')),
    ...walk('sample').filter((f) => f.endsWith('.carrel')),
  ].sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(root, f)));
  }
  const version = hash.digest('hex').slice(0, 12);
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
  return { version, files, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, files, bytes } = computePrecache();
  fs.writeFileSync(path.join(root, 'precache.json'), JSON.stringify({ version, files }, null, 2) + '\n');
  const swPath = path.join(root, 'sw.js');
  const sw = fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
  fs.writeFileSync(swPath, sw);
  console.log(`precache ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, version ${version}`);
}
