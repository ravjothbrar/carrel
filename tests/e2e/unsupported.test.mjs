import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openApp } from './harness.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

test('without WebGPU: a plain friendly message and a static preview, no app', async () => {
  const app = await openApp(browser, { fake: { webgpu: false } });
  const { page } = app;
  await page.waitForSelector('#unsupported:not([hidden])');
  assert.match(await page.locator('#unsupported').innerText(), /THIS NEEDS A WEBGPU BROWSER/i);
  assert.match(await page.locator('#unsupported').innerText(), /Chrome or Edge/);
  assert.equal(await page.locator('#app').isHidden(), true);
  await page.locator('.preview img').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('.preview img').complete);
  assert.ok(await page.locator('.preview img').evaluate((i) => i.naturalWidth > 100), 'preview image loads');
  assert.match(await page.locator('.preview figcaption').innerText(), /interface only, not model output/);
  assert.match(await page.locator('#model-line').innerText(), /needs WebGPU/);
  await app.close();
});
