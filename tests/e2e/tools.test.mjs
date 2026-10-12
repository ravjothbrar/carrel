// The measurement tools (spike, calibration) run end to end against the toy models, so a typo in them is
// caught here and not on the one machine that has the real models. The numbers they print here mean nothing.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { launchGpuBrowser } from '../../tools/gpu-browser.mjs';
import { startServer } from '../../tools/serve.mjs';
import { installHfFixture } from './hf-fixture.mjs';
import { root } from './harness.mjs';

let browser;
let adapterOk = false;
before(async () => {
  browser = await launchGpuBrowser();
  const probe = await startServer({ root });
  const p = await browser.newPage();
  await p.goto(probe.url + '/tools/embed.html');
  adapterOk = await p.evaluate(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter()));
  await p.close();
  await probe.close();
});
after(async () => { await browser.close(); });

async function open(path) {
  const server = await startServer({ root });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await installHfFixture(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + path);
  return { server, context, page, errors, async close() { await context.close(); await server.close(); } };
}

test('tools/spike.html: runs the whole measurement and produces a complete result block', async (t) => {
  if (!adapterOk) return t.skip('no WebGPU adapter in this environment');
  const app = await open('/tools/spike.html');
  await app.page.click('#run');
  await app.page.waitForFunction(() => document.querySelector('#result').value.length > 100, null, { timeout: 120000 });
  const r = JSON.parse(await app.page.locator('#result').inputValue());
  assert.equal(r.capabilities.webgpu, true);
  assert.ok(r.capabilities.limits.maxBufferSize > 0);
  assert.equal(r.embedding.loadOk, true);
  assert.ok(r.embedding.downloadBytes > 0);
  assert.ok(r.embedding.startupCheck.related > r.embedding.startupCheck.unrelated);
  assert.equal(r.embedding.sampleScores.indexOf(Math.max(...r.embedding.sampleScores)), 1, 'the cab text matches the fog question best');
  for (const tier of ['e2b', 'e4b']) {
    assert.equal(r[tier].loadOk, true, tier);
    assert.equal(r[tier].decodeTokensPerSecond.length, 3, tier);
    assert.ok(r[tier].decodeTokensPerSecond.every((x) => x > 0), tier);
    assert.match(r[tier].sampleAnswer, /speckled band/, tier);
  }
  assert.ok(r.e4b.prefetchMs >= 0);
  assert.ok(r.hosts.includes('huggingface.co'), r.hosts.join(','));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('tools/calibrate.html: produces a THRESHOLDS block with the statistics behind it', async (t) => {
  if (!adapterOk) return t.skip('no WebGPU adapter in this environment');
  const app = await open('/tools/calibrate.html');
  await app.page.click('#run');
  await app.page.waitForFunction(() => document.querySelector('#result').value.length > 50 || /ERROR/.test(document.querySelector('#log').textContent), null, { timeout: 120000 });
  const log = await app.page.locator('#log').textContent();
  assert.ok(!/ERROR/.test(log), log);
  const block = await app.page.locator('#result').inputValue();
  assert.match(block, /export const THRESHOLDS = Object\.freeze\(\{/);
  assert.match(block, /calibrated: true,/);
  for (const k of ['abstain', 'support', 'imageMin', 'imageMargin']) assert.match(block, new RegExp(`${k}: -?\\d`));
  assert.match(log, /ABSTENTION[\s\S]*AUC/);
  assert.match(log, /SUPPORT[\s\S]*AUC/);
  assert.match(log, /IMAGES skipped/, 'the toy embedder is text only, so images are skipped, not fatal');
  assert.match(block, /images NOT calibrated, placeholders kept/);
  await app.close();
});
