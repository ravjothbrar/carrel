// Embedding worker: EmbeddingGemma 2 (text and images share one vector space).
//
// Runs on WebGPU with the q4 weights. The audio encoder is never loaded. Strings arrive already
// carrying their task prefix (see PREFIX in config.js); images take none.
//
// NOT YET RUN AGAINST THE REAL MODEL: the build sandbox could not reach Hugging Face. The classes
// and call shapes below were checked against the vendored Transformers.js 4.3.1 source. What is
// unconfirmed is the ONNX output name; pickEmbedding() fails loudly rather than guess.

import { AutoConfig, EmbeddingGemma2Model, EmbeddingGemma2Processor, RawImage } from '../../vendor/transformers/transformers.js';
import { EMBED } from '../config.js';
import { pickEmbedding, rowsOf } from '../embed-output.js';
import { STARTUP_TEXTS, assertGoodVector, planBatches, startupCheck } from '../vectors.js';
import { cacheStatus, downloadPlan, modelFiles, weightSizes } from './hf.js';
import { classifyGpuError, makeProgressReporter, resourceHosts, serve, setupRuntime, watchDeviceLoss, withTransfer } from './runtime.js';

setupRuntime();

let model = null;
let processor = null;
let loading = null;
let health = null;

async function files() {
  return modelFiles(EMBED.id, { dtype: EMBED.dtype, parts: 'embed', revision: EMBED.revision });
}

async function load(_, progress) {
  if (model) return { ms: 0, health, alreadyLoaded: true };
  loading ??= (async () => {
    if (!navigator.gpu) throw Object.assign(new Error('WebGPU is not available in this browser.'), { name: 'NoWebGPU' });
    const t0 = performance.now();
    const report = makeProgressReporter(progress, await downloadPlan(EMBED.id, EMBED.revision, await files()));
    // Dropping audio_config is how Transformers.js is told not to fetch audio_encoder.
    const config = await AutoConfig.from_pretrained(EMBED.id, { revision: EMBED.revision });
    delete config.audio_config;
    // No progress_callback here: with one, Transformers.js probes tokenizer files on `main` (ignoring the pinned revision).
    processor = await EmbeddingGemma2Processor.from_pretrained(EMBED.id, { revision: EMBED.revision });
    model = await EmbeddingGemma2Model.from_pretrained(EMBED.id, {
      revision: EMBED.revision,
      config,
      device: 'webgpu',
      dtype: EMBED.dtype,
      progress_callback: report,
    });
    watchDeviceLoss((m) => self.postMessage(m));
    // Startup check: reject NaN, all-zero, wrong-size or non-sensical vectors before anything is stored.
    const vecs = await embedBatch(STARTUP_TEXTS.map((t) => `task: search result | query: ${t}`));
    health = startupCheck(vecs, EMBED.dim);
    return { ms: Math.round(performance.now() - t0), health };
  })().catch((e) => {
    loading = null;
    model = null;
    processor = null;
    throw e;
  });
  return loading;
}

async function embedTexts({ texts }, progress) {
  const vectors = await embedBatch(texts, progress);
  return withTransfer({ vectors }, vectors.map((v) => v.buffer));
}

/** @returns {Promise<Float32Array[]>} one validated, unit-length vector per text, in input order */
async function embedBatch(texts, progress) {
  if (!model) throw new Error('The embedding model is not loaded.');
  const lengths = texts.map((t) => {
    try {
      return processor.tokenizer.encode(t).length;
    } catch {
      return Math.ceil(t.length / 3);
    }
  });
  const batches = planBatches(lengths, EMBED.maxBatchTokens);
  const vectors = new Array(texts.length);
  let done = 0;
  for (const batch of batches) {
    const inputs = await processor(batch.map((i) => texts[i]), null, null, null, { padding: true, truncation: true, max_length: 2048 });
    let outputs;
    try {
      outputs = await model(inputs);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { name: classifyGpuError(e) });
    }
    const rows = rowsOf(pickEmbedding(outputs));
    if (rows.length !== batch.length) throw new Error(`Expected ${batch.length} embeddings, got ${rows.length}.`);
    batch.forEach((orig, k) => {
      assertGoodVector(rows[k], EMBED.dim, `Embedding for text ${orig + 1}`);
      vectors[orig] = rows[k];
    });
    done += batch.length;
    progress?.({ kind: 'embed', done, total: texts.length });
  }
  return vectors;
}

async function embedImages({ blobs }, progress) {
  if (!model) throw new Error('The embedding model is not loaded.');
  const vectors = [];
  for (let i = 0; i < blobs.length; i++) {
    const image = await RawImage.fromBlob(blobs[i]);
    const inputs = await processor(null, [image]); // images take no prefix
    let outputs;
    try {
      outputs = await model(inputs);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { name: classifyGpuError(e) });
    }
    const [row] = rowsOf(pickEmbedding(outputs));
    assertGoodVector(row, EMBED.dim, `Embedding for image ${i + 1}`);
    vectors.push(row);
    progress?.({ kind: 'embed', done: i + 1, total: blobs.length });
  }
  return withTransfer({ vectors }, vectors.map((v) => v.buffer));
}

async function status() {
  const f = await files();
  const [{ cached }, sizes] = await Promise.all([cacheStatus(EMBED.id, EMBED.revision, f), weightSizes(EMBED.id, EMBED.revision, f)]);
  return { cached, bytes: sizes.bytes, files: sizes.files };
}

serve({
  status,
  load,
  embedTexts,
  embedImages,
  hosts: async () => resourceHosts(),
  dispose: async () => {
    await model?.dispose?.();
    model = null;
    processor = null;
    loading = null;
    return true;
  },
});
