// Static preview for browsers without WebGPU. Shows the interface only (empty start screen), never
// model output: the stand-in engine used by the tests must not be used to fake an answer.
import { launch, openApp } from '../tests/e2e/harness.mjs';
const browser = await launch();
const app = await openApp(browser, { viewport: { width: 1200, height: 960 } });
await app.page.waitForTimeout(500);
await app.page.screenshot({ path: 'docs/preview-empty.png', clip: { x: 0, y: 0, width: 1200, height: 960 } });
await app.close();
await browser.close();
console.log('docs/preview-empty.png written');
