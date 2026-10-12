import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ask, launch, openApp, pasteAll } from './harness.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

// The sandbox has under 1 GB of free storage, so (correctly) it refuses the upgrade. Simulate a roomy device.
// Init scripts are serialised into the page, so each must be self-contained (no closures).
const ROOMY = () => { navigator.storage.estimate = async () => ({ quota: 500e9, usage: 1e9 }); };
const SETTING_OFF = () => { navigator.storage.estimate = async () => ({ quota: 500e9, usage: 1e9 }); localStorage.setItem('carrel.useLargerModel', 'off'); };
const DATA_SAVER = () => { navigator.storage.estimate = async () => ({ quota: 500e9, usage: 1e9 }); Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' } }); };
const SLOW_CELL = () => { navigator.storage.estimate = async () => ({ quota: 500e9, usage: 1e9 }); Object.defineProperty(navigator, 'connection', { value: { saveData: false, effectiveType: '3g' } }); };

const answerOnce = async (page) => {
  await pasteAll(page, { 'speckled band': 'The speckled band was a swamp adder, a deadly snake that climbed the bell rope.' });
  await ask(page, 'What kind of snake was the speckled band?');
  await page.waitForSelector('.sheet .answer:not(.streaming) .fn');
};
const model = (page) => page.locator('#model-line').textContent();
const log = (page) => page.evaluate(() => window.__fakeLog);

test('capable device: starts on E2B, silently moves to E4B after the first answer, with no prompt', async () => {
  const app = await openApp(browser, { initScript: ROOMY });
  const { page } = app;
  await answerOnce(page);
  assert.match(await model(page), /Gemma 4 E2B · running on this device/);
  assert.equal((await log(page)).prefetch, 0, 'nothing is fetched before the first answer');
  await page.waitForFunction(() => /Gemma 4 E4B · running on this device/.test(document.querySelector('#model-line').textContent), null, { timeout: 15000 });
  const l = await log(page);
  assert.equal(l.warmup, 1, 'speed is measured, not guessed');
  assert.equal(l.prefetch, 1);
  assert.deepEqual(l.loadGenerator.map((x) => x.tier), ['e2b', 'e4b']);
  // silent: no banner, no consent panel, no notice about it
  assert.equal(await page.locator('#consent').isHidden(), true);
  assert.equal(await page.locator('#notice').isHidden() || !/larger|E4B/i.test(await page.locator('#notice-text').textContent()), true);
  // retrieval is untouched and the next answer uses the new tier
  await ask(page, 'What kind of snake was the speckled band?');
  await page.waitForFunction(() => document.querySelectorAll('.sheet').length === 2 && !document.querySelector('.answer.streaming'));
  assert.match(await page.locator('.sheet').first().locator('.sheet-meta').textContent(), /Gemma 4 E4B/);
  await app.close();
});

for (const [name, fake, init, reason] of [
  ['setting off', {}, SETTING_OFF, null],
  ['small graphics limits', { limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2 } }, ROOMY, /maxBufferSize/],
  ['slow decode', { tps: 3 }, ROOMY, /decode speed/],
  ['data saver on', {}, DATA_SAVER, /data saver/],
  ['slow cellular', {}, SLOW_CELL, /connection is 3g/],
]) {
  test(`stays on E2B: ${name}`, async () => {
    const app = await openApp(browser, { fake, initScript: init });
    const { page } = app;
    await answerOnce(page);
    await page.waitForTimeout(setting(name) ? 2500 : 4500);
    assert.match(await model(page), /Gemma 4 E2B · running on this device/);
    assert.equal((await log(page)).prefetch, 0, 'no background download');
    if (reason) {
      await page.click('#open-settings');
      await page.waitForSelector('#settings-dialog[open]');
      assert.match(await page.locator('#setting-large-note').textContent(), reason);
    }
    await app.close();
  });
}
function setting(n) { return n === 'setting off'; }

test('E4B fails to load: revert to E2B at once, remember it, and do not retry', async () => {
  const app = await openApp(browser, { fake: { e4bLoadFails: true }, initScript: ROOMY });
  const { page } = app;
  await answerOnce(page);
  await page.waitForFunction(() => window.__fakeLog.loadGenerator.length >= 3, null, { timeout: 15000 });
  assert.deepEqual((await log(page)).loadGenerator.map((x) => x.tier), ['e2b', 'e4b', 'e2b']);
  assert.match(await model(page), /Gemma 4 E2B · running on this device/);
  const stored = await page.evaluate(() => localStorage.getItem('carrel.e4bFailed'));
  assert.match(stored, /Failed to allocate/);
  // answers still work on E2B
  await ask(page, 'What kind of snake was the speckled band?');
  await page.waitForFunction(() => document.querySelectorAll('.sheet').length === 2 && !document.querySelector('.answer.streaming'));
  assert.match(await page.locator('.sheet').first().locator('.sheet-meta').textContent(), /Gemma 4 E2B/);
  // a fresh visit: the remembered failure stops any automatic retry
  const page2 = await app.context.newPage();
  await page2.addInitScript(() => { window.__FAKE__ = { e4bLoadFails: true }; navigator.storage.estimate = async () => ({ quota: 500e9, usage: 1e9 }); });
  await page2.goto(app.server.url + '/index.html');
  await page2.waitForSelector('body[data-ready]');
  await answerOnce(page2);
  await page2.waitForTimeout(4000);
  const l2 = await log(page2);
  assert.equal(l2.warmup, 0);
  assert.equal(l2.prefetch, 0);
  assert.deepEqual(l2.loadGenerator.map((x) => x.tier), ['e2b']);
  await app.close();
});

test('turning the setting off while on E4B returns to E2B', async () => {
  const app = await openApp(browser, { initScript: ROOMY });
  const { page } = app;
  await answerOnce(page);
  await page.waitForFunction(() => /E4B · running/.test(document.querySelector('#model-line').textContent), null, { timeout: 15000 });
  await page.click('#open-settings');
  await page.uncheck('#setting-large');
  await page.waitForFunction(() => /E2B · running/.test(document.querySelector('#model-line').textContent), null, { timeout: 5000 });
  await app.close();
});
