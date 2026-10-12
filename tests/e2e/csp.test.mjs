import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from './harness.mjs';
import { startServer } from '../../tools/serve.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const CSP = /Content-Security-Policy" content="([^"]+)"/.exec(indexHtml)[1];

const PAGE = `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>csp</title><script type="module" src="/__csp.js"></script>`;

// Page script: starts probe workers the way engine-client does (blob wrapper) and the way it must NOT (direct).
const PAGE_JS = `
import { spawn } from '/js/engine-client.js';
const ask = (w) => new Promise((res) => { w.onmessage = (e) => e.data.probe && res(e.data); w.onerror = (e) => res({ error: e.message }); });
const wrapped = ask(spawn('../__probe.worker.js'));
const direct = ask(new Worker('/__probe.worker.js', { type: 'module' }));
let main;
try { await fetch('https://example.com/'); main = 'allowed'; } catch (e) { main = 'failed'; }
window.__result = { wrapped: await wrapped, direct: await direct, main };
`;

const PROBE = `
import { setupRuntime, env } from '/js/workers/runtime.js';
let violated = [];
self.addEventListener('securitypolicyviolation', (e) => violated.push(e.violatedDirective + ' ' + e.blockedURI));
setupRuntime();
const out = { violations: null, guard: {} };
const ac = () => { const c = new AbortController(); setTimeout(() => c.abort(), 2500); return c.signal; };
try { await fetch('https://example.com/', { signal: ac() }); } catch {}
await new Promise((r) => setTimeout(r, 50));
out.violations = violated.slice();
for (const [k, u] of Object.entries({ other: 'https://example.com/x', plainHttp: 'http://huggingface.co/x', lookalike: 'https://huggingface.co.evil.example/x', hf: 'https://huggingface.co/x' })) {
  try { await env.fetch(u, { signal: ac() }); out.guard[k] = 'passed the guard'; } catch (e) { out.guard[k] = /carrel blocked/.test(e.message) ? 'blocked by guard' : 'passed the guard (network: ' + e.name + ')'; }
}
postMessage({ probe: true, ...out });
`;

test('workers inherit the page CSP only when started from the blob wrapper', async () => {
  const server = await startServer({ root, overrides: new Map([
    ['/__csp.html', { body: PAGE, type: 'text/html' }],
    ['/__csp.js', { body: PAGE_JS, type: 'text/javascript' }],
    ['/__probe.worker.js', { body: PROBE, type: 'text/javascript' }],
  ]) });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(server.url + '/__csp.html');
  await page.waitForFunction(() => window.__result, null, { timeout: 40000 });
  const r = await page.evaluate(() => window.__result);
  assert.equal(r.main, 'failed', 'main thread fetch to another site must not succeed');
  // blob wrapper: connect-src applied inside the worker
  assert.ok(r.wrapped.violations.some((v) => /connect-src https:\/\/example\.com/.test(v)), JSON.stringify(r.wrapped.violations));
  // the guard in env.fetch is a second lock
  assert.equal(r.wrapped.guard.other, 'blocked by guard');
  assert.equal(r.wrapped.guard.plainHttp, 'blocked by guard');
  assert.equal(r.wrapped.guard.lookalike, 'blocked by guard');
  assert.match(r.wrapped.guard.hf, /passed the guard/);
  // documents why the wrapper exists: a plain worker is NOT covered by the page's meta CSP
  assert.deepEqual(r.direct.violations, [], 'plain module workers ignore the meta CSP');
  await ctx.close();
  await server.close();
});

test('real worker plumbing: boots, answers (or fails cleanly), counts only the allowed host', async () => {
  const PAGE_REAL = `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>real</title><script type="module" src="/__real.js"></script>`;
  const REAL_JS = `
import { createEngine } from '/js/engine-client.js';
import { NetCounter } from '/js/netcount.js';
const net = new NetCounter();
const engine = createEngine({ net });
const t0 = performance.now();
let outcome;
try { await engine.embedStatus(); outcome = { ok: true }; } catch (e) { outcome = { ok: false, name: e.name, message: e.message }; }
window.__real = { outcome, ms: performance.now() - t0, net: net.snapshot() };
`;
  const server = await startServer({ root, overrides: new Map([['/__real.html', { body: PAGE_REAL, type: 'text/html' }], ['/__real.js', { body: REAL_JS, type: 'text/javascript' }]]) });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/__real.html');
  await page.waitForFunction(() => window.__real, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.__real);
  // Whether Hugging Face is reachable depends on where this runs (blocked in the original build sandbox,
  // open on GitHub's runners). Either way the call must finish cleanly and the worker must have really
  // started, loaded the vendored library and tried the allowed host.
  if (r.outcome.ok) assert.ok(r.net.count >= 1, JSON.stringify(r.net));
  else {
    assert.ok(r.outcome.message.length > 0);
    assert.ok(r.net.count + r.net.failed >= 1, JSON.stringify(r.net));
  }
  assert.ok(Object.keys(r.net.hosts).every((h) => h === 'huggingface.co'), JSON.stringify(r.net.hosts));
  assert.deepEqual(errors, []);
  await ctx.close();
  await server.close();
});

test('the real app on a browser without WebGPU shows the friendly message', async () => {
  const server = await startServer({ root });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }); });
  await page.goto(server.url + '/index.html');
  await page.waitForSelector('#unsupported:not([hidden])');
  assert.match(await page.locator('#unsupported-reason').innerText(), /does not expose WebGPU/);
  assert.equal(await page.locator('#app').isHidden(), true);
  await ctx.close();
  await server.close();
});
