// Generator worker: Gemma 4 E2B (default) or E4B.
//
// Text answers use Gemma4ForCausalLM, which Transformers.js resolves to text-only sessions
// (embed_tokens + decoder), so no vision or audio weights are downloaded for them. The vision-capable
// class is loaded only when someone asks Gemma to describe an image. Transformers.js has no option
// to skip the audio encoder for that class, so that first image description costs an extra download.
//
// NOT YET RUN AGAINST THE REAL MODEL: the build sandbox could not reach Hugging Face. Class names,
// session layout and the processor call shape were checked against the vendored Transformers.js
// 4.3.1 source only.

import {
  Gemma4ForCausalLM,
  Gemma4ForConditionalGeneration,
  Gemma4Processor,
  InterruptableStoppingCriteria,
  RawImage,
  TextStreamer,
} from '../../vendor/transformers/transformers.js';
import { GENERATION, GENERATORS } from '../config.js';
import { cacheStatus, downloadPlan, modelFiles, prefetch, weightSizes } from './hf.js';
import { classifyGpuError, makeProgressReporter, resourceHosts, serve, setupRuntime, watchDeviceLoss } from './runtime.js';

setupRuntime();

let current = null; // { tier, vision, model, processor }
let loading = null;
let stopping = null;
let prefetchAbort = null;

const partsFor = (vision) => (vision ? 'gen-vision' : 'gen-text');
const dtypeFor = (cfg) => cfg.dtype;

async function disposeCurrent() {
  if (!current) return;
  const old = current;
  current = null;
  try {
    await old.model.dispose?.();
  } catch {
    /* freeing GPU memory is best effort */
  }
}

async function load({ tier, vision = false }, progress) {
  const cfg = GENERATORS[tier];
  if (!cfg) throw new Error(`Unknown generator tier: ${tier}`);
  if (current && current.tier === tier && (current.vision || !vision)) return { ms: 0, tier, vision: current.vision, alreadyLoaded: true };
  if (loading) await loading.catch(() => {});
  if (current && current.tier === tier && (current.vision || !vision)) return { ms: 0, tier, vision: current.vision, alreadyLoaded: true };
  if (!navigator.gpu) throw Object.assign(new Error('WebGPU is not available in this browser.'), { name: 'NoWebGPU' });

  loading = (async () => {
    const t0 = performance.now();
    await disposeCurrent();
    const report = makeProgressReporter(progress, await downloadPlan(cfg.id, cfg.revision, await modelFiles(cfg.id, { dtype: dtypeFor(cfg), parts: partsFor(vision) })));
    // Gemma4Processor directly: AutoProcessor would additionally insist on a preprocessor_config.json.
    const processor = await Gemma4Processor.from_pretrained(cfg.id, { revision: cfg.revision, progress_callback: report });
    const Model = vision ? Gemma4ForConditionalGeneration : Gemma4ForCausalLM;
    const model = await Model.from_pretrained(cfg.id, {
      revision: cfg.revision,
      device: 'webgpu',
      dtype: dtypeFor(cfg),
      progress_callback: report,
    });
    current = { tier, vision, model, processor };
    watchDeviceLoss((m) => self.postMessage(m));
    return { ms: Math.round(performance.now() - t0), tier, vision };
  })();
  try {
    return await loading;
  } catch (e) {
    const error = Object.assign(e instanceof Error ? e : new Error(String(e)), { name: classifyGpuError(e) });
    loading = null;
    // A failed vision load must not leave the app with no answer model at all.
    if (vision && !current) await load({ tier, vision: false }, () => {}).catch(() => {});
    throw error;
  } finally {
    loading = null;
  }
}

async function run({ messages, images = null, maxNewTokens = GENERATION.maxNewTokens, minNewTokens = 0 }, progress) {
  if (!current) throw new Error('The answer model is not loaded.');
  const { model, processor } = current;
  const prompt = processor.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
    enable_thinking: GENERATION.enableThinking,
  });
  let raw = null;
  if (images?.length) {
    if (!current.vision) throw new Error('This model was loaded without vision.');
    raw = await Promise.all(images.map((b) => RawImage.fromBlob(b)));
  }
  // The template already contains <bos>; tokenising must not add a second one.
  const inputs = await processor(prompt, raw, null, { add_special_tokens: false });

  let text = '';
  let tokens = 0;
  let tFirst = 0;
  const t0 = performance.now();
  stopping = new InterruptableStoppingCriteria();
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (piece) => {
      text += piece;
      progress({ kind: 'token', text: piece });
    },
    token_callback_function: () => {
      tokens++;
      if (tokens === 1) tFirst = performance.now();
    },
  });
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      min_new_tokens: minNewTokens,
      do_sample: GENERATION.doSample,
      streamer,
      stopping_criteria: stopping,
    });
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { name: classifyGpuError(e) });
  } finally {
    stopping = null;
  }
  const t1 = performance.now();
  const decodeMs = tokens > 1 ? t1 - tFirst : 0;
  return {
    text,
    tokens,
    ms: Math.round(t1 - t0),
    prefillMs: tokens ? Math.round(tFirst - t0) : null,
    tps: decodeMs > 0 ? (tokens - 1) / (decodeMs / 1000) : null, // decode speed, excluding prefill
  };
}

async function warmup({ tokens = GENERATION.warmupTokens }, progress) {
  const out = await run(
    { messages: [{ role: 'user', content: 'Count upwards from one in words, separated by commas, and keep going.' }], maxNewTokens: tokens, minNewTokens: tokens },
    () => {},
  );
  progress?.({ kind: 'warmup', tps: out.tps });
  return { tps: out.tps, tokens: out.tokens };
}

async function status({ tier, vision = false }) {
  const cfg = GENERATORS[tier];
  const f = await modelFiles(cfg.id, { dtype: dtypeFor(cfg), parts: partsFor(vision) });
  const [{ cached }, sizes] = await Promise.all([cacheStatus(cfg.id, cfg.revision, f), weightSizes(cfg.id, cfg.revision, f)]);
  return { cached, bytes: sizes.bytes };
}

async function prefetchModel({ tier, vision = false }, progress) {
  const cfg = GENERATORS[tier];
  const f = await modelFiles(cfg.id, { dtype: dtypeFor(cfg), parts: partsFor(vision) });
  prefetchAbort = new AbortController();
  try {
    await prefetch(cfg.id, cfg.revision, f, progress, prefetchAbort.signal);
  } finally {
    prefetchAbort = null;
  }
  return true;
}

serve({
  status,
  load,
  generate: run,
  warmup,
  prefetch: prefetchModel,
  interrupt: async () => {
    stopping?.interrupt();
    return true;
  },
  abortPrefetch: async () => {
    prefetchAbort?.abort();
    return true;
  },
  info: async () => (current ? { tier: current.tier, vision: current.vision } : null),
  hosts: async () => resourceHosts(),
  dispose: async () => {
    await disposeCurrent();
    return true;
  },
});
