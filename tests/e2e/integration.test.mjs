// INTEGRATION TESTS WITH TOY MODELS. They run the real app, the real workers, the vendored
// Transformers.js and ONNX Runtime, and real WebGPU sessions (a software adapter in the sandbox this
// was written in), against tiny hand-made ONNX models served at the Hugging Face URLs (see
// tests/fixtures/toy-embedder and toy-generator). They prove the plumbing: CSP, wasm loading, caching,
// progress, batching, KV cache, streaming, checks, retrieval, the E4B prefetch and swap, offline reload.
// They prove NOTHING about EmbeddingGemma 2 or Gemma 4: no real model files were reachable.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchGpuBrowser } from '../../tools/gpu-browser.mjs';
import { startServer } from '../../tools/serve.mjs';
import { installHfFixture } from './hf-fixture.mjs';
import { paste, root } from './harness.mjs';

let browser;
let adapterOk = false;
before(async () => {
  browser = await launchGpuBrowser();
  const probe = await startServer({ root });
  const p = await browser.newPage();
  await p.goto(probe.url + '/tools/embed.html'); // navigator.gpu needs a secure context, which about:blank is not
  adapterOk = await p.evaluate(async () => !!navigator.gpu && !!(await navigator.gpu.requestAdapter()));
  await p.close();
  await probe.close();
});
after(async () => { await browser.close(); });

const DOCS = {
  snakes: 'The speckled band was a swamp adder, a deadly snake that Doctor Roylott kept in his room and trained to climb the bell rope.',
  taxes: 'Quarterly tax filings and accounts are due at the end of every month, and late returns are charged.',
  cab: 'A hansom cab waited outside Baker Street in the thick fog, and its horse stamped on the cobbles.',
};

async function openReal(context, server) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/index.html');
  await page.waitForSelector('body[data-ready]');
  return { page, errors };
}

async function addDocs(page, docs) {
  let n = (await page.locator('.shelf-item-name').count()) || 0;
  for (const [title, text] of Object.entries(docs)) {
    await paste(page, text, title);
    n++;
    await page.waitForFunction((k) => document.querySelectorAll('.shelf-item-name').length >= k, n, { timeout: 60000 });
  }
}

const ROOMY = () => { navigator.storage.estimate = async () => ({ quota: 500e9, usage: 1e9 }); };

test('full real pipeline: consent, download, index, retrieve, stream an answer, check it, abstain, and reload offline', async (t) => {
  if (!adapterOk) return t.skip('no WebGPU adapter (not even a software one) in this environment');
  const server = await startServer({ root });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const hfLog = await installHfFixture(context);
  // record every progress readout, so the test can see the download reach its total
  await context.addInitScript(() => {
    window.__progress = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.status-row')) window.__progress.push(el.textContent);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const { page, errors } = await openReal(context, server);

  // --- consent shows real sizes taken from the repos before anything downloads
  await paste(page, DOCS.snakes, 'snakes');
  await page.waitForSelector('#consent:not([hidden])', { timeout: 30000 });
  const consent = await page.locator('#consent').innerText();
  const onnxBytes = fs.statSync(path.join(root, 'tests/fixtures/toy-embedder/repo/onnx/model_q4.onnx')).size;
  assert.match(consent, new RegExp(`EmbeddingGemma 2 · ${(onnxBytes / 1e6).toFixed(1)} MB`));
  assert.match(consent, /Gemma 4 E2B · \d+\.\d MB/);
  assert.ok(hfLog.some((l) => /model_q4\.onnx/.test(l)), 'sizes were looked up');
  assert.equal(hfLog.filter((l) => /\.onnx$/.test(l)).length, 3, 'one ranged probe per weight file (embedder 1, generator 2), nothing else');
  await page.keyboard.press('d');

  // --- the real embedder ran: documents indexed, vectors valid
  await page.waitForFunction(() => /1 chunks indexed/i.test(document.querySelector('#stat-chunks').textContent), null, { timeout: 60000 });
  await addDocs(page, { taxes: DOCS.taxes, cab: DOCS.cab });
  assert.match(await page.locator('#stat-chunks').textContent(), /3 chunks indexed/i);
  const stored = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('carrel'); q.onsuccess = () => r(q.result); });
    const rows = await new Promise((r) => { const g = db.transaction('chunks').objectStore('chunks').getAll(); g.onsuccess = () => r(g.result); });
    return rows.map((c) => ({ len: c.vector.length, norm: Math.hypot(...c.vector), finite: c.vector.every(Number.isFinite), key: c.embedKey }));
  });
  assert.equal(stored.length, 3);
  for (const v of stored) {
    assert.equal(v.len, 768);
    assert.ok(Math.abs(v.norm - 1) < 1e-3, `norm ${v.norm}`);
    assert.equal(v.finite, true);
    assert.match(v.key, /embeddinggemma-2.*\|q4\|768\|/);
  }

  // --- the generator loaded on WebGPU too
  await page.waitForFunction(() => /Gemma 4 E2B · running on this device/.test(document.querySelector('#model-line').textContent), null, { timeout: 60000 });

  // --- progress counted only the files that were downloaded, and reached 100% (no phantom audio/vision bytes)
  const readouts = (await page.evaluate(() => window.__progress)).join('\n');
  for (const [what, re] of [['search model', /Downloading the search model[^\n]*?([\d.]+) MB \/ ([\d.]+) MB/g], ['answer model', /Downloading Gemma 4 E2B([\d.]+) MB \/ ([\d.]+) MB/g]]) {
    const all = [...readouts.matchAll(re)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(all.length > 0, `no progress readout for the ${what}`);
    const [loaded, total] = all.at(-1);
    assert.equal(loaded, total, `${what}: ended at ${loaded} / ${total} MB`);
  }

  // --- ask: retrieval, streaming through the real generator, footnotes, and the citation check
  await page.fill('#question', 'Which snake climbed the bell rope?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sheet .answer:not(.streaming) .fn', { timeout: 60000 });
  const sheet = page.locator('.sheet').first();
  const first = sheet.locator('.note').first();
  assert.match(await first.locator('.note-src').textContent(), /snakes/i, 'right passage ranked first');
  assert.ok(Number(await first.locator('.note-score').textContent()) > 0.4);
  assert.equal(await sheet.locator('.answer').textContent().then((x) => /The speckled band was a swamp adder/.test(x)), true);
  assert.ok((await sheet.locator('.fn a').count()) >= 2, 'footnote marks for the model\'s citations');
  assert.equal(await sheet.locator('.flag').count(), 1, 'the invented sentence is flagged');
  assert.match(await sheet.locator('.s.unsupported').textContent(), /Australia/);
  assert.equal(await sheet.locator('.s.supported').count(), 1);
  assert.match(await sheet.locator('.sheet-meta').textContent(), /Gemma 4 E2B · \d+ tokens · [\d.]+ tok\/s/);
  assert.match(await page.locator('#stat-tps').textContent(), /tokens\/s/);

  // --- abstention with the real embedder: an on-vocabulary but unrelated question finds nothing close
  await page.fill('#question', 'Where is the lighthouse telescope?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.sheet').length === 2);
  await page.waitForSelector('.sheet:first-child .abstain');
  assert.match(await page.locator('.sheet:first-child .abstain').textContent(), /isn't in your documents/);

  // --- only Hugging Face, only GET, and the counter agrees
  assert.ok(hfLog.every((l) => /^GET \/onnx-community\//.test(l)), hfLog.join('\n'));
  assert.ok(hfLog.every((l) => /\/resolve\/[0-9a-f]{40}\//.test(l)), 'every request is pinned to a commit on the wire');
  assert.ok(Number(await page.locator('#net-count').textContent()) >= 10);
  assert.deepEqual(errors, []);
  await page.close();

  // --- second visit with the network to Hugging Face cut: both models come from the browser cache
  await context.unroute('https://huggingface.co/**');
  const blocked = [];
  await context.route('https://huggingface.co/**', (r) => { blocked.push(r.request().url()); return r.abort('internetdisconnected'); });
  const second = await openReal(context, server);
  const p2 = second.page;
  await p2.waitForFunction(() => /\d+ chunks indexed/i.test(document.querySelector('#stat-chunks').textContent));
  assert.match(await p2.locator('#stat-chunks').textContent(), /3 chunks indexed/i, 'documents survive a reload');
  await p2.fill('#question', 'Which snake climbed the bell rope?');
  await p2.keyboard.press('Enter');
  await p2.waitForSelector('.sheet .answer:not(.streaming) .fn', { timeout: 60000 });
  assert.equal(await p2.locator('#consent').isHidden(), true, 'no download prompt when the models are cached');
  assert.match(await p2.locator('.sheet').first().locator('.note').first().locator('.note-src').textContent(), /snakes/i);
  assert.match(await p2.locator('.sheet').first().locator('.sheet-meta').textContent(), /Gemma 4 E2B/);
  // No weight file the app needs was requested. (The loader still makes one-byte metadata probes for the
  // audio and vision encoders it never loads, and for optional config files; those are not downloads.)
  const needed = blocked.filter((u) => /(embed_tokens|decoder_model_merged|model_q4)[^/]*\.onnx$/.test(u));
  assert.deepEqual(needed, [], `a needed weight file was requested offline: ${needed.join(', ')}`);
  assert.equal(await p2.locator('#net-count').textContent(), '0', 'nothing got through');
  await context.close();
  await server.close();
});

test('E4B: prefetched in the background into the loader\'s own cache, swapped in between questions, no second download', async (t) => {
  if (!adapterOk) return t.skip('no WebGPU adapter in this environment');
  // The software adapter reports a 1 GiB maxBufferSize, below the placeholder threshold, so lower the
  // threshold in a test-only copy of config.js. Everything else is the shipped code.
  const patched = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8')
    .replace(/minMaxBufferSize: [^,]+,/, 'minMaxBufferSize: 0,')
    .replace(/minMaxStorageBufferBindingSize: [^,]+,/, 'minMaxStorageBufferBindingSize: 0,')
    .replace(/minDecodeTokensPerSecond: [^,]+,/, 'minDecodeTokensPerSecond: 1,');
  assert.match(patched, /minMaxBufferSize: 0,/);
  const server = await startServer({ root, overrides: new Map([['/js/config.js', { body: patched, type: 'text/javascript' }]]) });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const hfLog = await installHfFixture(context);
  await context.addInitScript(ROOMY);
  const { page, errors } = await openReal(context, server);
  await paste(page, DOCS.snakes, 'snakes');
  await page.waitForSelector('#consent:not([hidden])', { timeout: 30000 });
  await page.keyboard.press('d');
  await page.waitForFunction(() => /Gemma 4 E2B · running on this device/.test(document.querySelector('#model-line').textContent), null, { timeout: 60000 });
  assert.equal(hfLog.filter((l) => /E4B/.test(l)).length, 0, 'E4B untouched before the first answer');

  await page.fill('#question', 'Which snake climbed the bell rope?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sheet .answer:not(.streaming) .fn', { timeout: 60000 });
  assert.match(await page.locator('#model-line').textContent(), /Gemma 4 E2B/);

  // silent: no consent panel, no prompt; the footer ends up naming E4B
  await page.waitForFunction(() => /Gemma 4 E4B · running on this device/.test(document.querySelector('#model-line').textContent), null, { timeout: 60000 });
  assert.equal(await page.locator('#consent').isHidden(), true);
  // 2 size probes + 2 downloads (prefetch) + 2 one-byte metadata probes that the loader makes for the
  // audio and vision encoders it will not download. The swap itself read the prefetched cache.
  const e4bGets = hfLog.filter((l) => /E4B.*\.onnx$/.test(l));
  assert.equal(e4bGets.length, 6, e4bGets.join(' | '));
  assert.equal(e4bGets.filter((l) => /embed_tokens|decoder_model_merged/.test(l)).length, 4, 'each weight file: one size probe and one download, never two downloads');

  // the next answer comes from E4B, through the same retrieval and checks
  await page.fill('#question', 'Which snake climbed the bell rope?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.sheet').length === 2 && !document.querySelector('.answer.streaming'), null, { timeout: 60000 });
  assert.match(await page.locator('.sheet').first().locator('.sheet-meta').textContent(), /Gemma 4 E4B/);
  assert.equal(await page.locator('.sheet').first().locator('.flag').count(), 1);
  assert.equal(hfLog.filter((l) => /E4B.*\.onnx$/.test(l)).length, 6, 'still no further requests for weights');
  assert.deepEqual(errors, []);
  await context.close();
  await server.close();
});

test('if the answer model cannot be loaded, the sheet and the footer say so plainly', async (t) => {
  if (!adapterOk) return t.skip('no WebGPU adapter in this environment');
  const server = await startServer({ root });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await installHfFixture(context, { genAvailable: false });
  const { page } = await openReal(context, server);
  await paste(page, DOCS.snakes, 'snakes');
  // the size lookup for the generator fails, so carrel says it could not check, rather than guessing sizes
  await page.waitForSelector('#notice:not([hidden])', { timeout: 30000 });
  assert.equal(await page.locator('#consent').isHidden(), true);
  assert.match(await page.locator('#notice-text').textContent(), /Could not check the models|could not/i);
  await context.close();
  await server.close();
});
