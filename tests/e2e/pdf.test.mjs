import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ask, launch, openApp, waitForDesk } from './harness.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function makePdfs() {
  // Real PDFs, made by Chromium's own PDF printer: one with a text layer (2 pages), one image-only ("scanned").
  const p = await browser.newPage();
  await p.setContent(`<body style="font:16px serif"><p>The speckled band was a swamp adder, a deadly snake that Doctor Roylott trained to climb the bell rope.</p><div style="page-break-after:always"></div><p>A hansom cab waited outside Baker Street in the thick fog and the horse stamped on the cobbles.</p></body>`);
  fs.writeFileSync('/tmp/claude-text.pdf', await p.pdf({ format: 'A4' }));
  await p.setContent(`<body><canvas id=c width=600 height=300></canvas><script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#ccc';c.fillRect(0,0,600,300);c.fillStyle='#000';c.font='40px serif';c.fillText('scanned words',20,100);</script></body>`);
  const img = await p.evaluate(() => document.getElementById('c').toDataURL('image/png'));
  await p.setContent(`<body style="margin:0"><img src="${img}" width=600></body>`);
  fs.writeFileSync('/tmp/claude-scan.pdf', await p.pdf({ format: 'A4' }));
  await p.close();
}

test('a PDF with a text layer is read, page by page, with page numbers in the citations', async () => {
  await makePdfs();
  const app = await openApp(browser);
  const { page } = app;
  await page.setInputFiles('#file-docs', '/tmp/claude-text.pdf');
  await waitForDesk(page);
  assert.match(await page.locator('.shelf-list').innerText(), /claude-text\.pdf/);
  assert.match(await page.locator('.shelf-item-meta').first().innerText(), /PDF, 2 pages/i);
  await ask(page, 'What waited outside Baker Street in the fog?');
  await page.waitForSelector('.sheet .answer:not(.streaming)');
  assert.match(await page.locator('.sheet .margin').textContent(), /claude-text\.pdf · pp?\. ?\d/);
  assert.deepEqual(app.errors.filter((e) => !/404/.test(e)), []);
  assert.deepEqual(app.external, []);
  await app.close();
});

test('a scanned PDF is refused plainly: no text layer, no OCR', async () => {
  await makePdfs();
  const app = await openApp(browser);
  const { page } = app;
  await page.setInputFiles('#file-docs', '/tmp/claude-scan.pdf');
  await page.waitForSelector('#notice:not([hidden])');
  const msg = await page.locator('#notice-text').textContent();
  assert.match(msg, /no text layer/);
  assert.match(msg, /does not read scanned PDFs/);
  assert.match(msg, /no OCR/);
  assert.equal(await page.locator('#view-desk').isHidden(), true);
  await app.close();
});

test('unsupported file types and empty text say so', async () => {
  const app = await openApp(browser);
  const { page } = app;
  fs.writeFileSync('/tmp/claude-x.docx', 'PK');
  fs.writeFileSync('/tmp/claude-empty.txt', '   \n ');
  await page.setInputFiles('#file-docs', ['/tmp/claude-x.docx', '/tmp/claude-empty.txt']);
  await page.waitForSelector('#notice:not([hidden])');
  const msg = await page.locator('#notice-text').textContent();
  assert.match(msg, /reads \.txt, \.md and \.pdf/);
  assert.match(msg, /has no text in it/);
  await app.close();
});

test('a Markdown file is read as text', async () => {
  const app = await openApp(browser);
  const { page } = app;
  fs.writeFileSync('/tmp/claude-notes.md', '# Notes\n\nThe speckled band was a swamp adder, a deadly snake that Doctor Roylott kept.\n');
  await page.setInputFiles('#file-docs', '/tmp/claude-notes.md');
  await waitForDesk(page);
  assert.match(await page.locator('.shelf-list').innerText(), /claude-notes\.md/);
  await app.close();
});
