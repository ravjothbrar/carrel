// Main-thread side of the model workers. Everything model-related happens in two Web Workers:
//   embed.worker.js  EmbeddingGemma 2 (retrieval, citation check, image vectors)
//   gen.worker.js    Gemma 4 E2B / E4B (answers, image descriptions)
//
// Workers are started from a tiny blob wrapper that imports the real script. That matters: a worker
// loaded straight from a URL ignores the page's <meta> Content-Security-Policy, but a blob worker
// inherits it, so connect-src limits the workers too (tests/e2e/csp.test.mjs checks this).

import { GENERATORS } from './config.js';

export function spawn(relative) {
  const src = new URL(relative, import.meta.url).href;
  const blob = new Blob([`import ${JSON.stringify(src)};`], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module', name: relative });
  // Revoke only once the worker has started: revoking at once can race with its script fetch.
  worker.addEventListener('message', () => URL.revokeObjectURL(url), { once: true });
  worker.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
  return worker;
}

class Rpc {
  constructor(path, { onNet, onNetFailed, onDeviceLost }) {
    this.path = path;
    this.onNet = onNet;
    this.onNetFailed = onNetFailed;
    this.onDeviceLost = onDeviceLost;
    this.worker = null;
    this.next = 1;
    this.pending = new Map();
  }

  #start() {
    if (this.worker) return;
    this.worker = spawn(this.path);
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'net') return this.onNet?.(m.host);
      if (m.type === 'net-failed') return this.onNetFailed?.(m.host);
      if (m.type === 'device-lost') return this.onDeviceLost?.(m.reason);
      if (m.type === 'ready') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') return p.onProgress?.(m.p);
      this.pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.result);
      else {
        if (m.stack) console.error(`[carrel worker ${this.path}] ${m.name}: ${m.message}\n${m.stack}`);
        p.reject(Object.assign(new Error(m.message), { name: m.name }));
      }
    };
    const crash = (message) => {
      for (const p of this.pending.values()) p.reject(Object.assign(new Error(message), { name: 'WorkerCrash' }));
      this.pending.clear();
      this.worker = null;
    };
    this.worker.onerror = (e) => crash(e.message || 'The model worker stopped unexpectedly.');
    this.worker.onmessageerror = () => crash('The model worker sent a message carrel could not read.');
  }

  call(op, args = {}, { onProgress, transfer = [] } = {}) {
    this.#start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, op, args }, transfer);
    });
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
    this.pending.clear();
  }
}

export async function capabilities() {
  if (!('gpu' in navigator) || !navigator.gpu) return { webgpu: false, reason: 'This browser does not expose WebGPU.' };
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    /* handled below */
  }
  if (!adapter) return { webgpu: false, reason: 'WebGPU is present but no graphics adapter is available.' };
  const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  return {
    webgpu: true,
    adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' },
    limits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
  };
}

/**
 * @param {{net?: import('./netcount.js').NetCounter, onDeviceLost?: (reason: string, which: string) => void}} [opts]
 */
export function createEngine({ net, onDeviceLost } = {}) {
  const hooks = (which) => ({ onNet: (host) => net?.record(host), onNetFailed: (host) => net?.recordFailed(host), onDeviceLost: (r) => onDeviceLost?.(r, which) });
  const embed = new Rpc('./workers/embed.worker.js', hooks('embed'));
  const gen = new Rpc('./workers/gen.worker.js', hooks('gen'));

  return {
    capabilities,

    /** Size and cache state of the embedding model. May make small ranged requests to Hugging Face if not cached. */
    embedStatus: () => embed.call('status'),
    loadEmbedder: (onProgress) => embed.call('load', {}, { onProgress }),

    /** @param {string[]} texts already carrying their task prefix */
    async embedTexts(texts, onProgress) {
      if (!texts.length) return [];
      const { vectors } = await embed.call('embedTexts', { texts }, { onProgress });
      return vectors;
    },
    async embedImages(blobs, onProgress) {
      if (!blobs.length) return [];
      const { vectors } = await embed.call('embedImages', { blobs }, { onProgress });
      return vectors;
    },

    generatorStatus: (tier, vision = false) => gen.call('status', { tier, vision }),
    loadGenerator: (tier, { vision = false, onProgress } = {}) => gen.call('load', { tier, vision }, { onProgress }),
    prefetchGenerator: (tier, onProgress) => gen.call('prefetch', { tier }, { onProgress }),
    abortPrefetch: () => gen.call('abortPrefetch'),
    generatorInfo: () => gen.call('info'),
    warmup: (tokens) => gen.call('warmup', { tokens }),

    /**
     * @param {{messages: object[], images?: Blob[], maxNewTokens?: number}} req
     * @param {(piece: string) => void} onToken
     */
    generate: (req, onToken) => gen.call('generate', req, { onProgress: (p) => p.kind === 'token' && onToken?.(p.text) }),
    interrupt: () => gen.call('interrupt'),

    async hosts() {
      const [a, b] = await Promise.all([embed.call('hosts').catch(() => []), gen.call('hosts').catch(() => [])]);
      return [...new Set([...a, ...b])];
    },

    /** Free GPU memory. */
    async dispose() {
      await Promise.allSettled([embed.call('dispose'), gen.call('dispose')]);
      embed.terminate();
      gen.terminate();
    },
    terminate() {
      embed.terminate();
      gen.terminate();
    },
    generators: GENERATORS,
  };
}
