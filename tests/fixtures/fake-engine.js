// TEST DOUBLE. Not shipped, not a model. Served in place of /js/engine-client.js by the e2e tests so
// the real interface, session, store, packs and view code can be exercised without a GPU or network.
//
//   * Embeddings are hashed bags of words (lexical overlap gives a meaningful cosine).
//   * The "generator" quotes the first sentence of passage 1 with a citation, then adds one invented
//     claim, so the citation checker has something supported and something unsupported to judge.
//
// Behaviour is configured from window.__FAKE__ (set with page.addInitScript) and calls are recorded
// in window.__fakeLog so tests can assert, for example, that the generator was NOT called.

const DIM = 768;
const cfg = () => ({
  cached: true,
  embedBytes: 284_000_000,
  genBytes: 1_500_000_000,
  e4bBytes: 3_000_000_000,
  visionBytes: 900_000_000,
  webgpu: true,
  limits: { maxBufferSize: 4 * 1024 ** 3, maxStorageBufferBindingSize: 2 * 1024 ** 3 },
  tps: 40,
  e4bLoadFails: false,
  visionCached: false,
  invented: 'The culprit escaped to Australia aboard a steamship.',
  answerOverride: null,
  slowMs: 0,
  ...(window.__FAKE__ ?? {}),
});
const log = (window.__fakeLog = window.__fakeLog ?? { generate: 0, embedTexts: 0, embedImages: 0, loadGenerator: [], prefetch: 0, warmup: 0, prompts: [], images: 0 });
const state = { embedderCached: null, genCached: new Set(['e2b']), visionLoaded: false, loaded: null };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const STOP = new Set('the a an of and to in is was were it that for on with as by at from this be are or not but his her he she they we you i what who which when where how did do does'.split(' '));
function embed(text) {
  const v = new Float32Array(DIM);
  const body = text.replace(/^(?:task: [a-z ]+ \| query: |title: [^|]*\| text: )/, '');
  for (const w of body.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    if (STOP.has(w)) continue;
    v[hash(w) % DIM] += 1;
    v[hash(`${w}#`) % DIM] += 0.5;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slow = () => sleep(cfg().slowMs);

export async function capabilities() {
  const c = cfg();
  if (!c.webgpu) return { webgpu: false, reason: 'This browser does not expose WebGPU.' };
  return { webgpu: true, adapter: { vendor: 'fake', architecture: '', device: '', description: 'test double' }, limits: c.limits };
}

export function spawn() {
  throw new Error('spawn is not available in the fake engine');
}

export function createEngine({ net } = {}) {
  const c = () => cfg();
  const progressSteps = async (total, onProgress, label) => {
    for (let i = 1; i <= 4; i++) {
      onProgress?.({ kind: 'download', loaded: (total * i) / 4, total, label });
      await sleep(20);
    }
  };
  return {
    capabilities,
    async embedStatus() {
      state.embedderCached ??= c().cached;
      return { cached: state.embedderCached, bytes: c().embedBytes, files: {} };
    },
    async loadEmbedder(onProgress) {
      if (!state.embedderCached) {
        net?.record('huggingface.co');
        await progressSteps(c().embedBytes, onProgress);
        state.embedderCached = true;
      }
      return { ms: 5, health: { related: 0.9, unrelated: 0.1 } };
    },
    async embedTexts(texts, onProgress) {
      log.embedTexts++;
      await slow();
      const out = texts.map(embed);
      onProgress?.({ kind: 'embed', done: texts.length, total: texts.length });
      return out;
    },
    async embedImages(blobs) {
      log.embedImages++;
      const words = (window.__fakeImageKeywords ?? []).shift() ?? 'unlabelled picture';
      return blobs.map(() => embed(words));
    },
    async generatorStatus(tier, vision) {
      if (vision) return { cached: state.visionLoaded || c().visionCached, bytes: c().visionBytes };
      return { cached: state.genCached.has(tier), bytes: tier === 'e4b' ? c().e4bBytes : c().genBytes };
    },
    async loadGenerator(tier, { vision = false, onProgress } = {}) {
      log.loadGenerator.push({ tier, vision });
      if (tier === 'e4b' && c().e4bLoadFails) throw Object.assign(new Error('Failed to allocate GPU buffer (fake)'), { name: 'GpuError' });
      if (!state.genCached.has(tier)) {
        await progressSteps(c().genBytes, onProgress);
        state.genCached.add(tier);
      }
      if (vision) state.visionLoaded = true;
      state.loaded = { tier, vision: vision || (state.loaded?.tier === tier && state.loaded.vision) };
      return { ms: 5, tier, vision };
    },
    async prefetchGenerator(tier, onProgress) {
      log.prefetch++;
      await progressSteps(c().e4bBytes, onProgress);
      state.genCached.add(tier);
    },
    async abortPrefetch() {},
    async generatorInfo() {
      return state.loaded;
    },
    async warmup() {
      log.warmup++;
      return { tps: c().tps, tokens: 128 };
    },
    async generate({ messages, images }, onToken) {
      log.generate++;
      log.prompts.push(messages);
      if (images?.length) {
        log.images++;
        return { text: 'A fake description of what is visible.', tokens: 8, tps: c().tps, ms: 10 };
      }
      await slow();
      const user = messages.find((m) => m.role === 'user').content;
      const m = /\[1\] \([^)]*\)\n([\s\S]*?)(?:\n\n\[2\]|\n\nQuestion:)/.exec(user);
      const first = (m?.[1] ?? 'No passage.').split(/(?<=[.!?])\s+/)[0];
      const text = c().answerOverride ?? `${first} [1] ${c().invented} [1]`;
      for (const piece of text.match(/\S+\s*/g) ?? []) {
        onToken?.(piece);
        await sleep(5);
      }
      return { text, tokens: text.split(/\s+/).length, tps: c().tps, ms: 50 };
    },
    async interrupt() {},
    async hosts() {
      return [];
    },
    async dispose() {},
    terminate() {},
    generators: {},
  };
}
