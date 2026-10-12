// Shared helpers for the browser tests.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../tools/serve.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fakeEngineSource = fs.readFileSync(path.join(root, 'tests/fixtures/fake-engine.js'), 'utf8');

export async function launch() {
  return chromium.launch({ args: ['--no-proxy-server'] });
}

/**
 * Open the real app with the fake engine in place of engine-client.js.
 * @param {object} [fake]  values for window.__FAKE__
 */
export async function openApp(browser, { fake = {}, serverOverrides = new Map(), viewport = { width: 1280, height: 900 }, colorScheme = 'light', initScript = null } = {}) {
  const overrides = new Map([['/js/engine-client.js', { body: fakeEngineSource, type: 'text/javascript' }], ...serverOverrides]);
  const server = await startServer({ root, overrides });
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const external = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol.startsWith('http')) external.push(r.url());
  });
  await page.addInitScript((f) => {
    window.__FAKE__ = f;
  }, fake);
  if (initScript) await page.addInitScript(initScript);
  await page.goto(server.url + '/index.html');
  await page.waitForSelector('#app', { state: 'attached' });
  await page.waitForSelector('body[data-ready]');
  return {
    page,
    context,
    server,
    errors,
    external,
    async close() {
      await context.close();
      await server.close();
    },
  };
}

export async function paste(page, text, title = '') {
  await page.keyboard.press('p');
  await page.fill('#paste-name', title);
  await page.fill('#paste-text', text);
  await page.click('#paste-add');
}

export async function waitForDesk(page) {
  await page.waitForSelector('#view-desk:not([hidden])');
}

export async function ask(page, q) {
  await page.fill('#question', q);
  await page.keyboard.press('Enter');
}

// One document per topic, so each is its own chunk and the lexical stand-in embedder can tell them apart.
export const DOCS = {
  'speckled band': 'The speckled band was a swamp adder, a deadly snake that Doctor Roylott kept in his room and trained to climb the bell rope. The snake returned through the ventilator.',
  'baker street cab': 'A hansom cab waited outside Baker Street in the thick fog, and its horse stamped on the cobbles. The driver wore a heavy grey coat.',
  'red-headed league': 'Mr. Jabez Wilson was paid four pounds a week by the Red-Headed League for copying the Encyclopaedia Britannica. The office was closed after eight weeks.',
};

export async function pasteAll(page, docs = DOCS) {
  for (const [title, text] of Object.entries(docs)) {
    await paste(page, text, title);
    await page.waitForFunction((t) => [...document.querySelectorAll('.shelf-item-name')].some((e) => e.textContent === t), title);
  }
}

export const HOLMES = `The speckled band was a swamp adder, a deadly snake that Doctor Roylott kept in his room and trained to climb the bell rope.

A hansom cab waited outside Baker Street in the thick fog, and its horse stamped on the cobbles.

Mr. Jabez Wilson was paid four pounds a week by the Red-Headed League for copying the Encyclopaedia Britannica.`;

/** Minimal solid-colour PNG, no dependencies. */
import zlib from 'node:zlib';
export function makePng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
