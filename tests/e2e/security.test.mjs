import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ask, launch, openApp, paste, waitForDesk } from './harness.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const EVIL = `<img src=x onerror="window.__pwned='doc'"> <script>window.__pwned='script'</script> The speckled band snake <a href="javascript:window.__pwned='link'">click</a> climbed the rope.`;

test('document text is untrusted: markup in a document is shown as text, never run', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await paste(page, EVIL, '<b>evil</b> title');
  await waitForDesk(page);
  await ask(page, 'snake climbed rope');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('.sheet img, .sheet script, .sheet a[href^="javascript"], .shelf-list b').count(), 0);
  assert.match(await page.locator('.note-text').first().innerText(), /<img src=x onerror=/);
  assert.match(await page.locator('.shelf-item-name').first().innerText(), /<b>evil<\/b> title/);
  await app.close();
});

test('model output is untrusted too: HTML in an answer is shown as text', async () => {
  const answer = 'The snake <img src=x onerror="window.__pwned=\'model\'"> climbed the rope [1]. **Bold** and *italic* and `code` are fine [1]. <script>window.__pwned=1</script>';
  const app = await openApp(browser, { fake: { answerOverride: answer } });
  const { page } = app;
  await paste(page, 'The speckled band snake climbed the bell rope.', 'a');
  await waitForDesk(page);
  await ask(page, 'snake rope');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('.answer img, .answer script').count(), 0);
  const html = await page.locator('.answer').innerText();
  assert.match(html, /<img src=x onerror=/);
  assert.equal(await page.locator('.answer strong').innerText(), 'Bold');
  assert.equal(await page.locator('.answer em').innerText(), 'italic');
  assert.equal(await page.locator('.answer code').innerText(), 'code');
  await app.close();
});

test('a citation to a passage that does not exist is flagged, not linked', async () => {
  const app = await openApp(browser, { fake: { answerOverride: 'The snake climbed the bell rope in the room [9].' } });
  const { page } = app;
  await paste(page, 'The speckled band snake climbed the bell rope.', 'a');
  await waitForDesk(page);
  await ask(page, 'snake rope');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  assert.match(await page.locator('.flag').first().textContent(), /does not exist|not clearly supported/);
  assert.equal(await page.locator('.fn a[href$="note-9"]').count(), 0);
  await app.close();
});

test('no request leaves the allowed origin set during a full session', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await paste(page, 'The speckled band snake climbed the bell rope.', 'a');
  await waitForDesk(page);
  await ask(page, 'snake rope');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  assert.deepEqual(app.external, []);
  assert.equal(await page.locator('#net-count').innerText(), '0');
  await app.close();
});
