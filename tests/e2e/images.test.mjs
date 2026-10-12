import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ask, launch, makePng, openApp, pasteAll, waitForDesk } from './harness.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const PNG = '/tmp/carrel-test/hansom_cab.png';
before(() => fs.writeFileSync(PNG, makePng(1200, 800, [60, 60, 70])));

async function addImage(page, keywords) {
  await page.evaluate((k) => { window.__fakeImageKeywords = [k]; }, keywords);
  await page.setInputFiles('#file-images', PNG);
}

test('image: stored downscaled (about 512 px JPEG), shown on the shelf with an editable caption', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await addImage(page, 'hansom cab fog night');
  await waitForDesk(page);
  assert.equal(await page.locator('.caption-input').inputValue(), 'hansom cab');
  const meta = await page.evaluate(async () => {
    const req = indexedDB.open('carrel');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const row = await new Promise((r) => { const g = db.transaction('images').objectStore('images').getAll(); g.onsuccess = () => r(g.result[0]); });
    const bmp = await createImageBitmap(row.blob);
    return { type: row.blob.type, w: bmp.width, h: bmp.height, hasVector: row.vector.length, embedKey: row.embedKey };
  });
  assert.equal(meta.type, 'image/jpeg');
  assert.equal(Math.max(meta.w, meta.h), 512);
  assert.equal(meta.hasVector, 768);
  assert.match(meta.embedKey, /embeddinggemma-2.*\|q4\|768\|/);
  await page.fill('.caption-input', 'A cab in the fog');
  await page.locator('.caption-input').blur();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.caption-input').inputValue(), 'A cab in the fog');
  await app.close();
});

test('image hit appears as FIG. 1 with caption and source, and Gemma describes it after consent, labelled', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await pasteAll(page);
  await addImage(page, 'hansom cab fog night');
  await page.waitForFunction(() => document.querySelector('.caption-input'));
  await ask(page, 'What did the hansom cab outside Baker Street look like in the fog?');
  await page.waitForSelector('.figure');
  const fig = page.locator('.figure').first();
  assert.match(await fig.locator('figcaption').textContent(), /FIG\. 1/);
  assert.match(await fig.locator('figcaption').textContent(), /hansom cab/);
  assert.match(await fig.locator('figcaption').textContent(), /Source: added by you/);
  assert.match(await fig.locator('figcaption').textContent(), /rank 1/);
  // vision weights are not cached: it offers, with the size, rather than downloading silently
  const btn = fig.getByRole('button', { name: /Describe this image \(extra download, 900 MB\)/ });
  await btn.click();
  await page.waitForSelector('#consent:not([hidden])');
  assert.match(await page.locator('#consent').innerText(), /vision files/i);
  await page.keyboard.press('d');
  await page.waitForSelector('.desc');
  assert.equal(await page.locator('.desc-label').first().textContent(), 'described by Gemma on this device');
  assert.match(await page.locator('.desc').first().textContent(), /A fake description/);
  assert.equal(await page.evaluate(() => window.__fakeLog.images), 1);
  await app.close();
});

test('when the vision files are already there, the description is automatic', async () => {
  const app = await openApp(browser, { fake: { visionCached: true } });
  const { page } = app;
  await pasteAll(page);
  await addImage(page, 'hansom cab fog night');
  await page.waitForFunction(() => document.querySelector('.caption-input'));
  await ask(page, 'What did the hansom cab outside Baker Street look like in the fog?');
  await page.waitForSelector('.desc');
  assert.equal(await page.locator('#consent').isHidden(), true);
  await app.close();
});

test('an unrelated question shows no figure; an image-only desk abstains without calling the generator', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await addImage(page, 'hansom cab fog night');
  await waitForDesk(page);
  await ask(page, 'hansom cab fog night');
  await page.waitForSelector('.sheet .abstain');
  assert.match(await page.locator('.abstain').innerText(), /isn't in your documents/i);
  assert.match(await page.locator('.sheet-main').innerText(), /no text on your desk/i);
  await page.waitForSelector('.figure');
  assert.equal(await page.evaluate(() => window.__fakeLog.generate), 0, 'abstaining must not call the generator');
  // description is offered, not run
  assert.equal(await page.locator('.desc').count(), 0);
  assert.ok(await page.getByRole('button', { name: /Describe this image/ }).isVisible());
  await ask(page, 'quarterly tax filings deadline');
  await page.waitForFunction(() => document.querySelectorAll('.sheet').length === 2);
  await page.waitForSelector('.sheet:first-child .abstain');
  assert.equal(await page.locator('.sheet:first-child .figure').count(), 0, 'no figure when the image does not match');
  await app.close();
});
