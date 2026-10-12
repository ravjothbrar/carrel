import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ask, launch, openApp, pasteAll, waitForDesk, paste, DOCS } from './harness.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

test('default state is upload-first, the sample is offered but never auto-loaded', async () => {
  const app = await openApp(browser);
  const { page } = app;
  assert.equal(await page.locator('h1').innerText(), 'Ask your documents.\nThey stay put.');
  assert.match(await page.locator('.definition').innerText(), /carrel n\. a private desk in a library/i);
  assert.equal(await page.locator('#dz-title').innerText(), 'Add your own documents');
  for (const label of ['Upload', 'Paste text', 'Drop images']) assert.ok(await page.getByRole('button', { name: new RegExp(label, 'i') }).first().isVisible(), label);
  assert.match(await page.locator('.sample-line').innerText(), /No documents handy\? Try a sample \(Sherlock Holmes stories\)/);
  assert.equal(await page.locator('#view-desk').isHidden(), true);
  assert.equal(await page.locator('#sample-badge').isHidden(), true);
  assert.equal((await page.locator('.eyebrow').allInnerTexts()).filter((t) => /ADD YOUR OWN|WORKS OFFLINE|VERIFY IT YOURSELF/.test(t)).length, 3);
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.external, []);
  await app.close();
});

test('footer names the model honestly, before and after it runs', async () => {
  const app = await openApp(browser);
  const { page } = app;
  assert.match(await page.locator('#model-line').innerText(), /Gemma 4 E2B · not downloaded yet/);
  await pasteAll(page, { one: DOCS['speckled band'] });
  await page.waitForFunction(() => /running on this device/.test(document.querySelector('#model-line').textContent));
  assert.match(await page.locator('#model-line').innerText(), /Gemma 4 E2B · running on this device/);
  await app.close();
});

test('first run asks before downloading, shows sizes in MB, and a refusal adds nothing', async () => {
  const app = await openApp(browser, { fake: { cached: false } });
  const { page } = app;
  await paste(page, DOCS['speckled band'], 'a');
  await page.waitForSelector('#consent:not([hidden])');
  const text = await page.locator('#consent').innerText();
  assert.match(text, /EmbeddingGemma 2 · 284\.0 MB/);
  assert.match(text, /Gemma 4 E2B · 1,500\.0 MB/);
  assert.match(text, /1,784\.0 MB/);
  assert.match(text, /from Hugging Face, once/i);
  assert.match(text, /Nothing you add is uploaded/);
  await page.click('#consent-cancel');
  await page.waitForSelector('#consent', { state: 'hidden' });
  assert.equal(await page.locator('#view-desk').isHidden(), true, 'declining must add nothing');
  assert.match(await page.locator('#notice-text').innerText(), /declined/);
  await app.close();
});

test('first run: accepting shows MB progress, then indexes with real counts', async () => {
  const app = await openApp(browser, { fake: { cached: false } });
  const { page } = app;
  await paste(page, DOCS['speckled band'], 'a');
  await page.waitForSelector('#consent:not([hidden])');
  await page.keyboard.press('d'); // the [D] hint works
  await page.waitForSelector('#status:not([hidden])');
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    for (const t of await page.locator('.status-row .numbers').allInnerTexts()) seen.add(t);
    await page.waitForTimeout(25);
  }
  assert.ok([...seen].some((t) => /\d[\d,.]* MB \/ [\d,.]+ MB/.test(t)), `no MB progress seen: ${[...seen]}`);
  await waitForDesk(page);
  assert.match(await page.locator('#stat-chunks').innerText(), /1 chunks indexed/i);
  await app.close();
});

test('answer is typeset with footnote marks, margin passages, and flags the unsupported sentence', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await pasteAll(page);
  await ask(page, 'What kind of snake was the speckled band?');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  const sheet = page.locator('.sheet').first();
  assert.match(await sheet.locator('.sheet-q').innerText(), /What kind of snake/);
  // no chat bubbles or avatars
  assert.equal(await page.locator('.bubble, .avatar, [class*="chat"]').count(), 0);
  // serif answer
  assert.match(await sheet.locator('.answer').evaluate((e) => getComputedStyle(e).fontFamily), /Source Serif/);
  // supported sentence cites passage 1 and links to the margin
  const marks = sheet.locator('.fn a');
  assert.ok((await marks.count()) >= 2);
  assert.equal(await marks.first().innerText(), '1');
  const href = await marks.first().getAttribute('href');
  assert.ok(await sheet.locator(href.replace('#', '#')).count() === 1, 'footnote target exists in the margin');
  // margin has passages with source names
  assert.match(await sheet.locator('.margin').innerText(), /speckled band · §1/i);
  // the invented claim is flagged, the quoted one is not
  const flags = sheet.locator('.flag');
  assert.equal(await flags.count(), 1);
  assert.equal(await flags.first().textContent(), 'not clearly supported by your documents');
  assert.match(await sheet.locator('.s.unsupported').innerText(), /Australia/);
  assert.equal(await sheet.locator('.s.supported').count(), 1);
  assert.match(await sheet.locator('.check-line').textContent(), /1 not clearly supported by your documents/);
  // honest numbers
  assert.match(await sheet.locator('.sheet-meta').textContent(), /Gemma 4 E2B · \d+ tokens · 40\.0 tok\/s/);
  assert.equal(await page.locator('#stat-tps').textContent(), '40.0 tokens/s');
  await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/answer.png` : '/dev/null', fullPage: false }).catch(() => {});
  await app.close();
});

test('abstention: something absent from the documents does NOT call the generator', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await pasteAll(page);
  await ask(page, 'Quantum chromodynamics lattice gauge renormalisation?');
  await page.waitForSelector('.sheet .abstain');
  const sheet = page.locator('.sheet').first();
  assert.equal(await sheet.locator('.abstain').innerText(), "That isn't in your documents.");
  assert.match(await sheet.locator('.margin h3').innerText(), /Closest passages/i);
  assert.ok((await sheet.locator('.note').count()) >= 1, 'closest passages are still shown');
  assert.equal(await page.evaluate(() => window.__fakeLog.generate), 0, 'generator must not be called');
  assert.match(await sheet.locator('.sheet-meta').textContent(), /no model was used/);
  // and a relevant question afterwards still works
  await ask(page, 'What was the cab outside Baker Street?');
  await page.waitForSelector('.sheet:first-child .answer:not(.streaming) .fn');
  assert.equal(await page.evaluate(() => window.__fakeLog.generate), 1);
  await app.close();
});

test('the prompt sent to the generator numbers the passages and demands citations', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await pasteAll(page);
  await ask(page, 'Who was paid four pounds a week?');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  const prompts = await page.evaluate(() => window.__fakeLog.prompts);
  const [system, user] = prompts[0];
  assert.match(system.content, /only the numbered passages/);
  assert.match(user.content, /\[1\] \(red-headed league, §1\)/);
  assert.ok((user.content.match(/^\[\d\] \(/gm) ?? []).length <= 5);
  await app.close();
});

test('keyboard hints work and settings has the larger-model toggle on by default', async () => {
  const app = await openApp(browser);
  const { page } = app;
  // [U] must click the (hidden) file input. Count the click and cancel it, so no native dialog is left open.
  await page.evaluate(() => {
    window.__fileClicks = 0;
    document.querySelector('#file-docs').addEventListener('click', (e) => { e.preventDefault(); window.__fileClicks++; });
  });
  await page.keyboard.press('u');
  assert.equal(await page.evaluate(() => window.__fileClicks), 1);
  await page.keyboard.press('p');
  await page.waitForSelector('#paste-dialog[open]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#paste-dialog', { state: 'hidden' });
  await page.keyboard.press('s');
  await page.waitForSelector('#settings-dialog[open]');
  assert.equal(await page.locator('#setting-large').isChecked(), true);
  assert.match(await page.locator('#settings-dialog').innerText(), /Use the larger model when this device can handle it/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settings-dialog', { state: 'hidden' });
  // closing a dialog must not strand keyboard focus inside it (a real bug this test once exposed)
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'setting-large');
  await page.keyboard.press('h');
  await page.waitForFunction(() => location.hash === '#how');
  await app.close();
});

test('every control has a real label and focus is visible', async () => {
  const app = await openApp(browser);
  const { page } = app;
  await pasteAll(page, { one: DOCS['speckled band'] });
  const unlabeled = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, input, textarea, select')) {
      if (el.hidden || el.closest('[hidden]') || el.closest('dialog:not([open])')) continue;
      const name = el.getAttribute('aria-label') || el.textContent.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent.trim()) || el.closest('label')?.textContent.trim();
      if (!name) bad.push(el.outerHTML.slice(0, 80));
    }
    return bad;
  });
  assert.deepEqual(unlabeled, []);
  await page.focus('#question');
  await page.keyboard.press('Tab'); // keyboard modality, so :focus-visible applies
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ask-go');
  const outline = await page.locator('#ask-go').evaluate((e) => getComputedStyle(e).outlineStyle + ' ' + getComputedStyle(e).outlineWidth);
  assert.match(outline, /solid 2px/);
  await app.close();
});
