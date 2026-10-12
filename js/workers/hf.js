// File-level helpers for Hugging Face model repos, built on Transformers.js' own ModelRegistry
// and cache layout (Cache Storage, keyed by the resolved URL; verified against 4.3.1).

import { ModelRegistry, env } from '../../vendor/transformers/transformers.js';

export function cacheUrl(id, revision, file) {
  return `${env.remoteHost.replace(/\/$/, '')}/${id}/resolve/${encodeURIComponent(revision)}/${file}`;
}

/**
 * Which files a load will fetch.
 *  parts: 'embed'       text + vision encoder, never the audio encoder
 *         'gen-text'    embed_tokens + decoder only
 *         'gen-vision'  everything the library loads for Gemma4ForConditionalGeneration
 */
export async function modelFiles(id, { dtype, parts }) {
  const all = await ModelRegistry.get_files(id, { dtype });
  return all.filter((f) => {
    if (parts === 'embed') return !/audio_encoder/.test(f);
    if (parts === 'gen-text') return !/audio_encoder|vision_encoder/.test(f);
    return true;
  });
}

export const isWeightFile = (f) => f.startsWith('onnx/');

/** Cached means every weight file is in Cache Storage. */
export async function cacheStatus(id, revision, files) {
  if (typeof caches === 'undefined') return { cached: false, missing: files.filter(isWeightFile) };
  const cache = await caches.open(env.cacheKey);
  const missing = [];
  for (const f of files.filter(isWeightFile)) {
    if (!(await cache.match(cacheUrl(id, revision, f)))) missing.push(f);
  }
  const cfg = await cache.match(cacheUrl(id, revision, 'config.json'));
  return { cached: missing.length === 0 && !!cfg, missing };
}

/**
 * What a load will really download: the weight files that are not in the cache yet, with their sizes.
 * Transformers.js' own progress total also counts files it probes but never fetches (for example the
 * audio and vision encoders on a text-only load), so carrel computes its own.
 */
export async function downloadPlan(id, revision, files) {
  const { missing } = await cacheStatus(id, revision, files);
  const { files: sizes } = await weightSizes(id, revision, missing);
  return { missing: new Set(missing), bytes: missing.reduce((n, f) => n + (sizes[f] ?? 0), 0) };
}

/** Sizes of the weight files. Cached files answer from the cache; others make a one-byte ranged request. */
export async function weightSizes(id, revision, files) {
  const entries = await Promise.all(
    files.filter(isWeightFile).map(async (f) => {
      const m = await ModelRegistry.get_file_metadata(id, f, { revision });
      return [f, m.exists ? (m.size ?? 0) : 0, m.exists];
    }),
  );
  return { bytes: entries.reduce((n, [, s]) => n + s, 0), files: Object.fromEntries(entries.map(([f, s]) => [f, s])) };
}

/**
 * Download files into the same cache the library reads, without creating any GPU session.
 * Resumes at file granularity: files already cached are skipped, a file cut off mid-way is fetched again.
 */
export async function prefetch(id, revision, files, onProgress, signal) {
  const cache = await caches.open(env.cacheKey);
  const sizes = (await weightSizes(id, revision, files)).files;
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  let doneBytes = 0;
  const report = () => onProgress?.({ kind: 'download', loaded: doneBytes, total, files: files.length });
  for (const file of files) {
    const key = cacheUrl(id, revision, file);
    if (await cache.match(key)) {
      doneBytes += sizes[file] ?? 0;
      continue;
    }
    const res = await env.fetch(key, { signal });
    if (res.status === 404 && !isWeightFile(file)) continue; // optional file
    if (!res.ok || !res.body) throw new Error(`Could not download ${file} (HTTP ${res.status}).`);
    let fileBytes = 0;
    const counted = res.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          fileBytes += chunk.byteLength;
          if (isWeightFile(file)) {
            doneBytes += chunk.byteLength;
            report();
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const headers = new Headers(res.headers);
    await cache.put(key, new Response(counted, { status: 200, headers }));
    if (!isWeightFile(file)) continue;
    // keep the running total honest if the server's size differed from the ranged probe
    doneBytes += (sizes[file] ?? fileBytes) - fileBytes;
  }
  onProgress?.({ kind: 'download', loaded: total, total, files: files.length });
}
