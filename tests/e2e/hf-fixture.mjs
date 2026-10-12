// Serves toy Hugging Face repos (an embedder and a text generator) from disk at https://huggingface.co/... using Playwright's
// network layer, so the real app, workers and Transformers.js run unmodified. Handles CORS, HEAD-style
// ranged probes and 404s the way the real hub does for missing files.
import fs from 'node:fs';
import path from 'node:path';
import { root } from './harness.mjs';

const EMBED_REPO = 'onnx-community/embeddinggemma-2-ONNX';
const GEN_REPO = 'onnx-community/gemma-4-E2B-it-ONNX';
const embedDir = path.join(root, 'tests/fixtures/toy-embedder/repo');

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, content-length, content-type', 'access-control-allow-headers': '*' };

const genDir = path.join(root, 'tests/fixtures/toy-generator/repo');
const GEN_REPOS = new Set([GEN_REPO, 'onnx-community/gemma-4-E4B-it-ONNX']);

export async function installHfFixture(context, { log = [], genAvailable = true } = {}) {
  await context.route('https://huggingface.co/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.push(`${req.method()} ${url.pathname}`);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const m = url.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
    let body = null;
    if (m && m[1] === EMBED_REPO) {
      const p = path.join(embedDir, m[3]);
      if (p.startsWith(embedDir) && fs.existsSync(p) && fs.statSync(p).isFile()) body = fs.readFileSync(p);
    } else if (m && GEN_REPOS.has(m[1]) && genAvailable) {
      const p = path.join(genDir, m[3]);
      if (p.startsWith(genDir) && fs.existsSync(p) && fs.statSync(p).isFile()) body = fs.readFileSync(p);
    }
    if (!body) return route.fulfill({ status: 404, headers: { ...CORS, 'content-type': 'text/plain' }, body: 'Entry not found' });
    const type = m[3].endsWith('.json') ? 'application/json' : m[3].endsWith('.jinja') ? 'text/plain' : 'application/octet-stream';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers().range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
      return route.fulfill({ status: 206, headers: { ...CORS, 'content-type': type, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(end - start + 1) }, body: body.subarray(start, end + 1) });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': type, 'content-length': String(body.length) }, body });
  });
  return log;
}
