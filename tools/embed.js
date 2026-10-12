// Exposes the real engine (EmbeddingGemma 2 on WebGPU) to the Playwright build scripts.
import { createEngine } from '../js/engine-client.js';
import { downscaleToJpeg } from '../js/image.js';
import { PREFIX } from '../js/config.js';

const engine = createEngine();
const log = (m) => {
  document.getElementById('log').textContent += `\n${m}`;
  console.log(m);
};

window.carrelTool = {
  async start() {
    const t0 = performance.now();
    let lastPct = -1;
    const r = await engine.loadEmbedder((p) => {
      if (p.kind !== 'download') return;
      const pct = Math.floor((p.loaded / p.total) * 10) * 10;
      if (pct !== lastPct) log(`downloading embedding model ${pct}% (${(p.loaded / 1e6).toFixed(0)} / ${(p.total / 1e6).toFixed(0)} MB)`);
      lastPct = pct;
    });
    return { ...r, totalMs: Math.round(performance.now() - t0) };
  },
  /** @param {string[]} texts already prefixed */
  async embedTexts(texts) {
    const out = [];
    const step = 64;
    for (let i = 0; i < texts.length; i += step) {
      const part = await engine.embedTexts(texts.slice(i, i + step));
      out.push(...part.map((v) => Array.from(v)));
      log(`embedded ${Math.min(i + step, texts.length)} / ${texts.length} chunks`);
    }
    return out;
  },
  /** @param {string[]} svgTexts */
  async embedSvgImages(svgTexts) {
    const jpegs = [];
    for (const svg of svgTexts) {
      const file = new File([svg], 'image.svg', { type: 'image/svg+xml' });
      const { blob } = await downscaleToJpeg(file);
      jpegs.push(blob);
    }
    const vectors = await engine.embedImages(jpegs);
    const bytes = await Promise.all(jpegs.map(async (b) => Array.from(new Uint8Array(await b.arrayBuffer()))));
    return jpegs.map((_, i) => ({ vector: Array.from(vectors[i]), jpeg: bytes[i] }));
  },
  async hosts() {
    return engine.hosts();
  },
  prefixDoc: (title, text) => PREFIX.doc(title, text),
};
log('ready');
