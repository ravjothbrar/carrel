import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ask, fakeEngineSource, launch, paste, root, DOCS, waitForDesk } from './harness.mjs';
import { startServer } from '../../tools/serve.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

test('airplane-mode path: load once, kill the server, reload, add a document, ask, get a cited answer', async () => {
  // The fake engine stands in for the models (this test is about the page, storage and service worker).
  // It is served by the dev server at install time, so that is the copy the service worker precaches.
  const server = await startServer({ root, overrides: new Map([['/js/engine-client.js', { body: fakeEngineSource, type: 'text/javascript' }]]) });
  const ctx = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.__FAKE__ = { cached: true }; });
  await page.goto(server.url + '/index.html');
  await page.waitForSelector('body[data-ready]');

  // wait for the service worker to take control and finish precaching
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true), null, { timeout: 30000 });
  const manifest = await (await fetch(server.url + '/precache.json')).json();
  await page.waitForFunction(async (n) => {
    const keys = await caches.keys();
    const k = keys.find((x) => x.startsWith('carrel-shell-'));
    return k && (await (await caches.open(k)).keys()).length >= n;
  }, manifest.files.length, { timeout: 60000 });
  await page.reload(); // now controlled by the worker
  await page.waitForSelector('body[data-ready]');
  assert.match(await page.locator('#offline-state').innerText(), /Offline copy: ready/i);

  // pull the plug: the origin is gone entirely
  await server.close();
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  assert.equal(await page.locator('h1').innerText(), 'Ask your documents.\nThey stay put.');
  assert.match(await page.locator('#offline-state').innerText(), /Offline copy: ready/i);

  for (const [title, text] of Object.entries(DOCS)) {
    await paste(page, text, title);
    await page.waitForFunction((t) => [...document.querySelectorAll('.shelf-item-name')].some((e) => e.textContent === t), title);
  }
  await ask(page, 'What kind of snake was the speckled band?');
  await page.waitForSelector('.sheet .answer:not(.streaming) .fn');
  assert.match(await page.locator('.sheet .margin').innerText(), /speckled band/i);

  // everything came from the offline copy: nothing from this site was fetched from the network, nothing left the device
  assert.equal(await page.locator('#net-count').innerText(), '0');
  assert.match(await page.locator('#verify-local').innerText(), /fetched after load: 0/i);
  assert.equal(await page.locator('#verify-count').innerText(), '0');

  // a document added offline survives another offline reload
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  await waitForDesk(page);
  assert.equal(await page.locator('.shelf-item-name').count(), 3);
  await ctx.close();
});

test('the manifest makes it installable', async () => {
  const server = await startServer({ root });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(server.url + '/index.html');
  const manifest = await (await fetch(server.url + '/manifest.webmanifest')).json();
  assert.equal(manifest.name, 'carrel');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  for (const i of manifest.icons) assert.equal((await fetch(`${server.url}/${i.src}`)).status, 200, i.src);
  assert.equal(await page.locator('link[rel="manifest"]').count(), 1);
  await ctx.close();
  await server.close();
});
