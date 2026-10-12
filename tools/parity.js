// Parity test: the sample's stored vectors were made at build time. Re-embed a handful of its chunks
// here, in the browser, with the same engine, and compare cosine similarity with what is stored.
import { createEngine } from '../js/engine-client.js';
import { PREFIX, EMBED } from '../js/config.js';
import { decodePack } from '../js/pack.js';
import { dot } from '../js/search.js';

// Same model and dtype on the same GPU should agree almost exactly. Batch composition can change
// padding and so cause tiny differences, hence a threshold slightly below 1 rather than equality.
const MIN_COSINE = 0.99;

window.carrelParity = async function run(sampleCount = 12) {
  const bytes = new Uint8Array(await (await fetch('../sample/sherlock.carrel')).arrayBuffer());
  const { header, chunks, images } = await decodePack(bytes, { model: EMBED.id, dtype: EMBED.dtypeLabel, dim: EMBED.dim, prefixScheme: EMBED.prefixScheme });
  const engine = createEngine();
  await engine.loadEmbedder();
  const step = Math.max(1, Math.floor(chunks.length / sampleCount));
  const picks = Array.from({ length: Math.min(sampleCount, chunks.length) }, (_, i) => i * step);
  const fresh = await engine.embedTexts(picks.map((i) => PREFIX.doc(header.docs[chunks[i].doc].title, chunks[i].text)));
  const rows = picks.map((i, k) => ({ chunk: i, cosine: dot(fresh[k], chunks[i].vector) }));
  // images: stored thumbnails are the exact bytes that were embedded
  const imgRows = [];
  for (let i = 0; i < Math.min(3, images.length); i++) {
    const [v] = await engine.embedImages([new Blob([images[i].bytes], { type: images[i].mime })]);
    imgRows.push({ image: images[i].name, cosine: dot(v, images[i].vector) });
  }
  const all = [...rows, ...imgRows];
  return { min: Math.min(...all.map((r) => r.cosine)), threshold: MIN_COSINE, rows, imgRows, pass: all.every((r) => r.cosine >= MIN_COSINE) };
};
