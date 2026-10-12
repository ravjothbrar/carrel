import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computePrecache } from '../../tools/build-sw-manifest.mjs';

test('precache.json and the version in sw.js match the files (run `npm run build:sw` if this fails)', () => {
  const { version, files } = computePrecache();
  const committed = JSON.parse(fs.readFileSync('precache.json', 'utf8'));
  assert.deepEqual(committed.files, files);
  assert.equal(committed.version, version);
  assert.match(fs.readFileSync('sw.js', 'utf8'), new RegExp(`const VERSION = '${version}';`));
});

test('everything the app needs offline is precached, and nothing from another origin', () => {
  const { files } = computePrecache();
  for (const f of ['index.html', 'css/app.css', 'js/app.js', 'vendor/transformers/transformers.js', 'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'js/workers/embed.worker.js', 'js/workers/gen.worker.js', 'manifest.webmanifest']) {
    assert.ok(files.includes(f), `${f} missing from precache`);
  }
  assert.ok(files.every((f) => !/^https?:/.test(f)));
  assert.ok(files.some((f) => f.endsWith('.woff2')));
});
