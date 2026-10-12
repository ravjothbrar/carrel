// Build sample/sherlock.carrel: three Sherlock Holmes stories (public domain) plus the original
// illustrations in sample/images, pre-embedded with the SAME model and dtype the browser uses
// (EmbeddingGemma 2, q4, 768-d, WebGPU), so visitors do not re-embed.
//
//   node tools/build-sample.mjs                      fetch the text from Project Gutenberg
//   node tools/build-sample.mjs --text path/to.txt   use a copy you already downloaded
//   add --headed if headless Chromium has no WebGPU on your machine
//
// Needs: a GPU with WebGPU, network access to huggingface.co (model) and, unless --text is given,
// gutenberg.org. NOT YET RUN: the sandbox this repo was written in had neither.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkSegments, locLabel } from '../js/chunk.js';
import { EMBED, embedKey } from '../js/config.js';
import { encodePack } from '../js/pack.js';
import { launchGpuBrowser, requireAdapter } from './gpu-browser.mjs';
import { pickStories, splitStories, stripGutenberg } from './gutenberg.mjs';
import { startServer } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://www.gutenberg.org/cache/epub/1661/pg1661.txt';
const WANTED = ['A Scandal in Bohemia', 'The Red-Headed League', 'The Adventure of the Speckled Band'];

async function getText() {
  const i = process.argv.indexOf('--text');
  if (i > -1) return { raw: fs.readFileSync(process.argv[i + 1], 'utf8'), how: `local copy ${process.argv[i + 1]}` };
  let last = '';
  for (const url of [SOURCE_URL, 'https://www.gutenberg.org/files/1661/1661-0.txt', 'https://www.gutenberg.org/ebooks/1661.txt.utf-8']) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'carrel-sample-build (https://github.com/ravjothbrar/carrel)' } });
        if (res.ok) return { raw: await res.text(), how: url };
        last = `${url}: HTTP ${res.status}`;
      } catch (e) {
        last = `${url}: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`Could not fetch the text from Project Gutenberg (${last}). Download it yourself and pass --text file.txt`);
}

const { raw, how } = await getText();
console.log(`fetched ${raw.length} characters from ${how}`);
let body;
try {
  body = stripGutenberg(raw);
} catch (e) {
  console.error(`${e.message}\nFirst 300 characters: ${JSON.stringify(raw.slice(0, 300))}\nLines containing "***":`);
  raw.split(/\r?\n/).forEach((l, i) => l.includes('***') && console.error(`  ${i + 1}: ${JSON.stringify(l.slice(0, 120))}`));
  throw e;
}
let stories;
try {
  stories = pickStories(splitStories(body), WANTED);
} catch (e) {
  console.error(`${e.message}\nLines mentioning the stories (to fix the heading pattern):`);
  body.split('\n').forEach((l, i) => /bohemia|speckled band|red-headed league/i.test(l) && console.error(`  ${i + 1}: ${JSON.stringify(l.slice(0, 100))}`));
  throw e;
}
console.log(stories.map((s) => `  ${s.title}: ${s.text.split(/\s+/).length} words`).join('\n'));

// 1. text: chunk with the app's own chunker, prefix as the model card says
const docs = [];
const chunks = [];
for (const s of stories) {
  const id = docs.length + 1;
  docs.push({ id, name: s.title, title: s.title, kind: 'text' });
  chunkSegments([{ page: null, text: s.text }]).forEach((c, i) => chunks.push({ doc: id, text: c.text, loc: locLabel(c, i) }));
}
console.log(`${chunks.length} chunks`);

// 2. images: original drawings, licence recorded per file
const imageMeta = JSON.parse(fs.readFileSync(path.join(root, 'sample/images/images.json'), 'utf8'));
for (const m of imageMeta) {
  if (!m.licence || !m.licenceUrl || !m.source) throw new Error(`${m.file}: every sample image needs source, licence and licenceUrl recorded.`);
}
const svgs = imageMeta.map((m) => fs.readFileSync(path.join(root, 'sample/images', m.file), 'utf8'));

// 3. embed on the GPU with the real engine
const server = await startServer({ root });
const browser = await launchGpuBrowser();
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`  [page] ${m.text()}`));
  await page.goto(`${server.url}/tools/embed.html`);
  await page.waitForFunction(() => window.carrelTool);
  const adapter = await requireAdapter(page);
  console.log(`adapter: ${adapter.vendor} ${adapter.architecture} ${adapter.description}`);
  const start = await page.evaluate(() => window.carrelTool.start()).catch((e) => {
    throw new Error(`The embedding model could not be loaded: ${e.message}\nThis step needs network access to huggingface.co (one-time download of about 300 MB).`);
  });
  console.log(`embedding model ready in ${(start.totalMs / 1000).toFixed(1)} s; startup check: related ${start.health.related.toFixed(3)}, unrelated ${start.health.unrelated.toFixed(3)}`);
  console.log(`hosts contacted (put these in the CSP connect-src): ${(await page.evaluate(() => window.carrelTool.hosts())).join(', ')}`);

  const docTitle = new Map(docs.map((d) => [d.id, d.title]));
  const texts = chunks.map((c) => `title: ${docTitle.get(c.doc)} | text: ${c.text}`);
  const vectors = await page.evaluate((t) => window.carrelTool.embedTexts(t), texts);
  const images = await page.evaluate((s) => window.carrelTool.embedSvgImages(s), svgs);

  const pack = await encodePack({
    meta: {
      name: 'Sherlock Holmes stories (sample)',
      sample: true,
      source: {
        work: 'The Adventures of Sherlock Holmes',
        author: 'Arthur Conan Doyle (died 1930; public domain)',
        text: `Project Gutenberg ebook #1661, retrieved from ${how}; header, footer and licence boilerplate removed`,
        stories: stories.map((s) => s.title),
        images: imageMeta.map(({ file, source, licence, licenceUrl }) => ({ file, source, licence, licenceUrl })),
        embedKey: embedKey(),
        builtAt: new Date().toISOString(),
        adapter: `${adapter.vendor} ${adapter.architecture}`.trim(),
      },
    },
    embedding: { model: EMBED.id, dtype: EMBED.dtypeLabel, dim: EMBED.dim, prefixScheme: EMBED.prefixScheme },
    docs,
    chunks: chunks.map((c, i) => ({ ...c, vector: Float32Array.from(vectors[i]) })),
    images: images.map((im, i) => ({ name: imageMeta[i].file, caption: imageMeta[i].caption, source: imageMeta[i].source, mime: 'image/jpeg', bytes: Uint8Array.from(im.jpeg), vector: Float32Array.from(im.vector) })),
  });
  fs.writeFileSync(path.join(root, 'sample/sherlock.carrel'), pack);
  console.log(`wrote sample/sherlock.carrel (${(pack.length / 1e6).toFixed(2)} MB): ${chunks.length} chunks, ${images.length} images`);
} finally {
  await browser.close();
  await server.close();
}

// 4. so the service worker precaches the new pack
const { computePrecache } = await import('./build-sw-manifest.mjs');
const { version, files } = computePrecache();
fs.writeFileSync(path.join(root, 'precache.json'), JSON.stringify({ version, files }, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'sw.js'), fs.readFileSync(path.join(root, 'sw.js'), 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`));
console.log('precache updated. Now run tools/parity.mjs, then commit sample/sherlock.carrel.');
