// Shared by both model workers. Configures Transformers.js so that:
//   * ONNX Runtime loads its wasm from our own /vendor folder (not a CDN),
//   * no blob: scripts are needed (useWasmCache off),
//   * every request goes through one guarded, counted fetch that only allows Hugging Face.
// The page CSP says the same thing; this is the second lock, and it is what makes the request
// counter honest.

import { env } from '../../vendor/transformers/transformers.js';
import { isAllowedModelHost } from '../config.js';

export { env };

export function setupRuntime() {
  const ort = new URL('../../vendor/ort/', import.meta.url).href;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.useWasmCache = false;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${ort}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${ort}ort-wasm-simd-threaded.asyncify.wasm`,
  };
  env.backends.onnx.wasm.numThreads = 1; // no cross-origin isolation on GitHub Pages
  env.backends.onnx.wasm.proxy = false;

  const realFetch = env.fetch;
  env.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input.url ?? String(input);
    const url = new URL(href, self.location.href);
    if (url.protocol !== 'https:' || !isAllowedModelHost(url.hostname)) {
      throw new Error(`carrel blocked a request to ${url.host}. Only Hugging Face model files may be fetched.`);
    }
    self.postMessage({ type: 'net', host: url.host, method: init?.method ?? 'GET' });
    return realFetch(input, init);
  };
}

/** Send results as { id, type: 'result' | 'progress' | 'error' }. Handlers get (args, progress). */
export function serve(handlers) {
  self.onmessage = async (e) => {
    const { id, op, args } = e.data;
    const progress = (p) => self.postMessage({ id, type: 'progress', p });
    try {
      const fn = handlers[op];
      if (!fn) throw new Error(`Unknown operation: ${op}`);
      const out = await fn(args ?? {}, progress);
      if (out && out.__transfer) self.postMessage({ id, type: 'result', result: out.value }, out.__transfer);
      else self.postMessage({ id, type: 'result', result: out });
    } catch (err) {
      self.postMessage({ id, type: 'error', name: err?.name ?? 'Error', message: String(err?.message ?? err) });
    }
  };
  self.postMessage({ type: 'ready' });
}

export function withTransfer(value, transfer) {
  return { __transfer: transfer, value };
}

/** Hosts this worker actually talked to, including redirect targets, from Resource Timing. */
export function resourceHosts() {
  const hosts = new Set();
  for (const e of performance.getEntriesByType('resource')) {
    try {
      hosts.add(new URL(e.name).host);
    } catch {
      /* ignore */
    }
  }
  return [...hosts];
}

/** Make a progress callback for from_pretrained that reports bytes, throttled. */
export function makeProgressReporter(progress) {
  let last = 0;
  return (info) => {
    if (info.status === 'progress_total') {
      const now = performance.now();
      if (now - last < 120 && info.loaded < info.total) return;
      last = now;
      progress({ kind: 'download', loaded: info.loaded, total: info.total, files: Object.keys(info.files ?? {}).length });
    } else if (info.status === 'done' || info.status === 'ready') {
      progress({ kind: info.status, file: info.file });
    }
  };
}

const DEVICE_LOST = /device.{0,20}lost|GPUDevice|out of memory|OOM|Failed to allocate|buffer.{0,40}(size|limit)|createBuffer|mapAsync|WebGPU/i;
export function classifyGpuError(err) {
  return DEVICE_LOST.test(String(err?.message ?? err)) ? 'GpuError' : (err?.name ?? 'Error');
}

export async function watchDeviceLoss(report) {
  try {
    const device = env.backends.onnx.webgpu?.device;
    device?.lost?.then((info) => report({ type: 'device-lost', reason: `${info.reason}: ${info.message}` }));
  } catch {
    /* best effort */
  }
}
