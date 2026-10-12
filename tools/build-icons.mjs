// Renders icons/icon.svg to the PNG sizes the manifest needs, using the Chromium Playwright ships with.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();

async function render(size, file, { inset = 1 } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * inset);
  const pad = Math.round((size - inner) / 2);
  await page.setContent(`<body style="margin:0;background:#f5f2eb"><div style="width:${size}px;height:${size}px;display:grid;place-items:center"><div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></div></body>`);
  await page.screenshot({ path: path.join(root, 'icons', file), clip: { x: 0, y: 0, width: size, height: size } });
  void pad;
}
await render(192, 'icon-192.png');
await render(512, 'icon-512.png');
await render(512, 'icon-maskable-512.png', { inset: 0.8 });
await browser.close();
console.log('icons written');
