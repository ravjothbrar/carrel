// Run the parity test in headless Chromium with WebGPU. Needs sample/sherlock.carrel and a GPU.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchGpuBrowser, requireAdapter } from './gpu-browser.mjs';
import { startServer } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'sample/sherlock.carrel'))) {
  console.error('sample/sherlock.carrel does not exist yet. Run tools/build-sample.mjs on a machine with a GPU first.');
  process.exit(2);
}
const server = await startServer({ root });
const browser = await launchGpuBrowser();
try {
  const page = await browser.newPage();
  await page.goto(`${server.url}/tools/parity.html`);
  await page.waitForFunction(() => window.carrelParity);
  await requireAdapter(page);
  const r = await page.evaluate(() => window.carrelParity(12));
  console.table(r.rows);
  console.table(r.imgRows);
  console.log(`minimum cosine ${r.min.toFixed(5)} (must be >= ${r.threshold}): ${r.pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = r.pass ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
