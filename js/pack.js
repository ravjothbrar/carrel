// The .carrel pack: one gzip file holding a JSON header and binary vector data.
//
//   (before gzip)
//   bytes 0..7    magic "CARREL01"
//   bytes 8..11   header length N, uint32 little-endian
//   bytes 12..    header JSON (UTF-8), then zero padding to a multiple of 4 bytes
//   then          float32 little-endian vectors: all chunks, then all images, `dim` floats each
//   then          image bytes (JPEG), concatenated; the header says where each one starts
//
// A pack is untrusted input. Everything is length-checked, vectors must be finite, and the
// embedding setup must match this build exactly or the import is refused.

import { LIMITS } from './config.js';
import { isFiniteVector } from './vectors.js';

export const PACK_FORMAT = 1;
export const PACK_EXTENSION = '.carrel';
const MAGIC = new TextEncoder().encode('CARREL01');

if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  throw new Error('carrel packs assume a little-endian platform.');
}

export class PackError extends Error {}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes, maxBytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch {
      throw new PackError('This file is not a valid .carrel pack (it is not gzip data).');
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PackError('This pack expands to more data than carrel will load.');
    }
    parts.push(r.value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/**
 * @param {object} p
 * @param {{name: string, sample?: boolean, source?: object}} p.meta
 * @param {{model: string, dtype: string, dim: number, prefixScheme: string}} p.embedding
 * @param {{id: number|string, name: string, title?: string, kind: string}[]} p.docs
 * @param {{doc: number|string, text: string, loc: string, vector: Float32Array}[]} p.chunks
 * @param {{name: string, caption: string, source: string, mime: string, bytes: Uint8Array, vector: Float32Array}[]} p.images
 * @returns {Promise<Uint8Array>} gzip bytes
 */
export async function encodePack({ meta, embedding, docs, chunks, images }) {
  const dim = embedding.dim;
  for (const c of chunks) if (c.vector.length !== dim) throw new PackError('A chunk vector has the wrong dimension.');
  for (const im of images) if (im.vector.length !== dim) throw new PackError('An image vector has the wrong dimension.');

  let offset = 0;
  const imageEntries = images.map((im) => {
    const e = { name: im.name, caption: im.caption, source: im.source, mime: im.mime, offset, length: im.bytes.byteLength };
    offset += im.bytes.byteLength;
    return e;
  });
  const docIndex = new Map(docs.map((d, i) => [d.id, i]));
  const header = {
    format: PACK_FORMAT,
    app: 'carrel',
    created: new Date().toISOString(),
    meta,
    embedding: { model: embedding.model, dtype: embedding.dtype, dim, prefixScheme: embedding.prefixScheme },
    docs: docs.map((d) => ({ name: d.name, title: d.title ?? '', kind: d.kind })),
    chunks: chunks.map((c) => ({ doc: docIndex.get(c.doc), text: c.text, loc: c.loc })),
    images: imageEntries,
  };
  for (const c of header.chunks) if (c.doc === undefined) throw new PackError('A chunk refers to a document that is not in the pack.');

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerEnd = 12 + headerBytes.byteLength;
  const vectorStart = Math.ceil(headerEnd / 4) * 4;
  const vectorCount = chunks.length + images.length;
  const vectorBytes = vectorCount * dim * 4;
  const imageStart = vectorStart + vectorBytes;
  const total = imageStart + offset;

  const buf = new Uint8Array(total);
  buf.set(MAGIC, 0);
  new DataView(buf.buffer).setUint32(8, headerBytes.byteLength, true);
  buf.set(headerBytes, 12);
  const floats = new Float32Array(buf.buffer, vectorStart, vectorCount * dim);
  let v = 0;
  for (const c of chunks) floats.set(c.vector, dim * v++);
  for (const im of images) floats.set(im.vector, dim * v++);
  let o = imageStart;
  for (const im of images) {
    buf.set(im.bytes, o);
    o += im.bytes.byteLength;
  }
  return gzip(buf);
}

/**
 * Parse and validate a pack. Does NOT check compatibility with this build: call checkCompat on
 * `header` first if you want to refuse before doing the work (decodePack calls it for you when
 * `expected` is given).
 * @returns {Promise<{header: object, chunks: object[], images: object[]}>}
 */
export async function decodePack(gzBytes, expected = null, { maxBytes = LIMITS.maxPackDecompressedBytes } = {}) {
  const buf = await gunzip(gzBytes, maxBytes);
  if (buf.byteLength < 12 || MAGIC.some((b, i) => buf[i] !== b)) {
    throw new PackError('This file is not a carrel pack (wrong signature).');
  }
  const headerLength = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(8, true);
  if (headerLength > LIMITS.maxPackHeaderBytes || 12 + headerLength > buf.byteLength) {
    throw new PackError('This pack is damaged (its header is the wrong size).');
  }
  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(12, 12 + headerLength)));
  } catch {
    throw new PackError('This pack is damaged (its header is not valid JSON).');
  }
  if (expected) {
    const compat = checkCompat(header, expected);
    if (!compat.ok) throw new PackError(compat.reason);
  }
  validateHeaderShape(header);

  const dim = header.embedding.dim;
  const nChunks = header.chunks.length;
  const nImages = header.images.length;
  const vectorStart = Math.ceil((12 + headerLength) / 4) * 4;
  const vectorBytes = (nChunks + nImages) * dim * 4;
  const imageStart = vectorStart + vectorBytes;
  const imageBytes = header.images.reduce((n, im) => n + im.length, 0);
  if (imageStart + imageBytes !== buf.byteLength) throw new PackError('This pack is damaged (its sizes do not add up).');

  // Copy to an aligned buffer: the view into `buf` is aligned too, but a copy keeps each vector independent.
  const floats = new Float32Array(buf.slice(vectorStart, imageStart).buffer);
  const chunks = header.chunks.map((c, i) => {
    const vector = floats.slice(i * dim, (i + 1) * dim);
    if (!isFiniteVector(vector)) throw new PackError(`Chunk ${i + 1} contains an invalid vector (NaN or Infinity).`);
    return { doc: c.doc, text: c.text, loc: c.loc, vector };
  });
  const images = header.images.map((im, i) => {
    const vector = floats.slice((nChunks + i) * dim, (nChunks + i + 1) * dim);
    if (!isFiniteVector(vector)) throw new PackError(`Image ${i + 1} contains an invalid vector (NaN or Infinity).`);
    const start = imageStart + im.offset;
    return { name: im.name, caption: im.caption, source: im.source, mime: im.mime, bytes: buf.slice(start, start + im.length), vector };
  });
  return { header, chunks, images };
}

function validateHeaderShape(h) {
  const bad = (m) => {
    throw new PackError(`This pack is damaged (${m}).`);
  };
  if (!h || typeof h !== 'object') bad('no header');
  if (!Array.isArray(h.docs) || !Array.isArray(h.chunks) || !Array.isArray(h.images)) bad('missing lists');
  if (h.chunks.length > LIMITS.maxPackChunks) bad('too many chunks');
  if (h.images.length > LIMITS.maxPackImages) bad('too many images');
  const dim = h.embedding?.dim;
  if (!Number.isInteger(dim) || dim < 1 || dim > 4096) bad('bad dimension');
  for (const d of h.docs) {
    if (typeof d.name !== 'string' || typeof d.kind !== 'string') bad('bad document entry');
  }
  for (const c of h.chunks) {
    if (typeof c.text !== 'string' || typeof c.loc !== 'string' || c.text.length > 50_000) bad('bad chunk entry');
    if (!Number.isInteger(c.doc) || c.doc < 0 || c.doc >= h.docs.length) bad('chunk points at a missing document');
  }
  let expectedOffset = 0;
  for (const im of h.images) {
    if (typeof im.name !== 'string' || typeof im.caption !== 'string' || typeof im.source !== 'string') bad('bad image entry');
    if (!/^image\/(jpeg|png|webp)$/.test(im.mime)) bad('unsupported image type');
    if (!Number.isInteger(im.offset) || !Number.isInteger(im.length) || im.offset !== expectedOffset || im.length < 1) bad('bad image offsets');
    expectedOffset += im.length;
  }
}

/**
 * Compare a pack's embedding setup with this build's. A pack made with a different model, dtype,
 * dimension or prefix scheme would give silently bad search results, so it is refused.
 * @param {object} header
 * @param {{model: string, dtype: string, dim: number, prefixScheme: string}} expected
 */
export function checkCompat(header, expected) {
  if (!header || header.format !== PACK_FORMAT) {
    return { ok: false, reason: `This pack uses format ${header?.format ?? 'unknown'}; this version of carrel reads format ${PACK_FORMAT}.` };
  }
  const e = header.embedding ?? {};
  const diffs = [];
  if (e.model !== expected.model) diffs.push(`model ${e.model ?? 'unknown'}`);
  if (e.dtype !== expected.dtype) diffs.push(`precision ${e.dtype ?? 'unknown'}`);
  if (e.dim !== expected.dim) diffs.push(`${e.dim ?? 'unknown'} dimensions`);
  if (e.prefixScheme !== expected.prefixScheme) diffs.push(`prefix scheme ${e.prefixScheme ?? 'unknown'}`);
  if (diffs.length) {
    return {
      ok: false,
      reason:
        `This pack was made with a different embedding setup (${diffs.join(', ')}). ` +
        `This carrel searches with ${expected.model} (${expected.dtype}, ${expected.dim} dimensions, ${expected.prefixScheme}). ` +
        'Mixing them would return wrong results, so the pack was not imported.',
    };
  }
  return { ok: true, reason: '' };
}
