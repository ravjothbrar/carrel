import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('app code never writes HTML from strings', () => {
  const banned = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(|\.srcdoc\s*=/;
  for (const file of walk('js').filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!banned.test(src), `${file} uses an HTML-from-string or eval API`);
  }
});

test('index.html has no inline script or style, and the CSP is present', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/\sstyle=/i.test(html), 'inline style attribute');
  assert.ok(!/\son[a-z]+=/i.test(html), 'inline event handler');
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp, 'no CSP meta tag');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/huggingface\.co/);
  assert.ok(!/unsafe-inline|unsafe-eval(?!.*wasm)/.test(csp.replace('wasm-unsafe-eval', '')), 'unsafe CSP keywords');
  assert.ok(!/https?:\/\/(?!huggingface\.co|\*\.huggingface\.co|\*\.hf\.co|github\.com\/ravjothbrar|ravjothbrar\.com)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'external URL in HTML');
});

test('no CDN or third-party hosts anywhere in shipped code', () => {
  const allowed = /huggingface\.co|hf\.co|github\.com\/ravjothbrar|gutenberg|www\.w3\.org|ravjothbrar\.com/;
  for (const file of walk('js').concat(['index.html', 'css/app.css', 'css/fonts.css', 'sw.js', 'manifest.webmanifest']).filter((f) => fs.existsSync(f))) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of src.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) assert.ok(allowed.test(m[0]), `${file}: unexpected URL ${m[0]}`);
  }
});
