import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ask, launch, openApp, pasteAll, waitForDesk } from './harness.mjs';
import { encodePack } from '../../js/pack.js';
import { EMBED } from '../../js/config.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function marginOf(page, nth = 0) {
  return page.locator('.sheet').nth(nth).locator('.note').evaluateAll((els) => els.map((e) => e.querySelector('.note-src').textContent + '|' + e.querySelector('.note-score').textContent + '|' + e.querySelector('.note-text').textContent));
}

test('export, clear everything, import: identical search results', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await pasteAll(page);
  await ask(page, 'Which snake climbed the bell rope?');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  const before = await marginOf(page);
  assert.ok(before.length >= 1);

  await page.click('#open-settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-pack')]);
  assert.match(download.suggestedFilename(), /^carrel-\d{4}-\d{2}-\d{2}\.carrel$/);
  const file = await download.path();
  const bytes = fs.readFileSync(file);
  assert.equal(bytes[0], 0x1f); assert.equal(bytes[1], 0x8b); // gzip

  page.once('dialog', (d) => d.accept());
  await page.click('#clear-all');
  await page.waitForSelector('#view-empty:not([hidden])');
  assert.match(await page.locator('#stat-chunks').innerText(), /^0 chunks/i);

  await page.click('#open-settings');
  await page.waitForSelector('#settings-dialog[open]');
  await page.setInputFiles('#file-pack', file);
  await waitForDesk(page);
  await ask(page, 'Which snake climbed the bell rope?');
  await page.waitForSelector('.sheet:first-child .answer:not(.streaming)');
  const after = await marginOf(page);
  assert.deepEqual(after, before, 'search results must be identical after a round trip');
  assert.deepEqual(app.errors.filter((e) => !/404/.test(e)), []);
  await app.close();
});

test('a pack made with a different embedding setup is refused with a clear message', async () => {
  const app = await openApp(browser);
  const { page } = app;
  const vec = new Float32Array(EMBED.dim); vec[0] = 1;
  const bad = await encodePack({
    meta: { name: 'x' },
    embedding: { model: 'someone/other-embedder', dtype: 'fp16', dim: EMBED.dim, prefixScheme: EMBED.prefixScheme },
    docs: [{ id: 1, name: 'd', kind: 'text' }],
    chunks: [{ doc: 1, text: 'hello', loc: '§1', vector: vec }],
    images: [],
  });
  const path = '/tmp/claude-bad.carrel';
  fs.writeFileSync(path, bad);
  await page.keyboard.press('u');
  await page.setInputFiles('#file-docs', path);
  await page.waitForSelector('#notice:not([hidden])');
  const msg = await page.locator('#notice-text').innerText();
  assert.match(msg, /different embedding setup/);
  assert.match(msg, /someone\/other-embedder/);
  assert.match(msg, /Mixing them would return wrong results/);
  assert.equal(await page.locator('#view-desk').isHidden(), true, 'nothing imported');
  await app.close();
});

test('a damaged file with the .carrel name is rejected, not half-imported', async () => {
  const app = await openApp(browser);
  const { page } = app;
  fs.writeFileSync('/tmp/claude-junk.carrel', 'definitely not gzip');
  await page.setInputFiles('#file-docs', '/tmp/claude-junk.carrel');
  await page.waitForSelector('#notice:not([hidden])');
  assert.match(await page.locator('#notice-text').innerText(), /not a valid \.carrel pack/);
  assert.equal(await page.locator('#view-desk').isHidden(), true);
  await app.close();
});

test('sample pack: labelled everywhere, searchable, removable in one click, never exported', async () => {
  // Build a tiny stand-in "sample" with the same format the real build script writes.
  const { fakeEmbed } = await import('../unit/helpers.mjs');
  const text = 'A hansom cab waited outside Baker Street in the thick fog.';
  const gz = await encodePack({
    meta: { name: 'Sherlock Holmes stories (test stand-in)', sample: true, source: { note: 'test' } },
    embedding: { model: EMBED.id, dtype: EMBED.dtypeLabel, dim: EMBED.dim, prefixScheme: EMBED.prefixScheme },
    docs: [{ id: 1, name: 'A Scandal in Bohemia', kind: 'text' }],
    chunks: [{ doc: 1, text, loc: '§1', vector: fakeEmbed(`title: A Scandal in Bohemia | text: ${text}`) }],
    images: [],
  });
  const app = await openApp(browser, { serverOverrides: new Map([['/sample/sherlock.carrel', { body: Buffer.from(gz), type: 'application/octet-stream' }]]) });
  const { page } = app;
  await page.click('[data-action="sample"]');
  await waitForDesk(page);
  assert.equal(await page.locator('#sample-badge').isVisible(), true);
  assert.match(await page.locator('#sample-badge').innerText(), /Sample pack: add your own documents to use this for real/i);
  assert.match(await page.locator('.shelf-list').innerText(), /SAMPLE/);
  await ask(page, 'What waited outside Baker Street in the fog?');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  assert.match(await page.locator('.sheet .margin').innerText(), /A Scandal in Bohemia/i);
  // export refuses to present the sample as the user's data
  await page.click('#open-settings');
  await page.click('#export-pack');
  await page.waitForSelector('#notice:not([hidden])');
  assert.match(await page.locator('#notice-text').innerText(), /sample pack is not exported/i);
  await page.keyboard.press('Escape');
  await page.click('[data-action="remove-sample"]');
  await page.waitForSelector('#view-empty:not([hidden])');
  await app.close();
});

test('without a built sample the link says so plainly', async () => {
  const app = await openApp(browser);
  await app.page.click('[data-action="sample"]');
  await app.page.waitForSelector('#notice:not([hidden])');
  assert.match(await app.page.locator('#notice-text').innerText(), /does not include the sample pack yet/);
  await app.close();
});
