// Guards against the failure the model card warns about: embeddings that silently come out as NaN
// or all zeros (for example if float16 sneaks in).

export function isFiniteVector(v) {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

export function isZeroVector(v) {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

export class BadVectorError extends Error {}

/** Throws BadVectorError with a plain message if a vector is unusable. */
export function assertGoodVector(v, dim, label = 'vector') {
  if (!(v instanceof Float32Array)) throw new BadVectorError(`${label} is not a Float32Array.`);
  if (v.length !== dim) throw new BadVectorError(`${label} has ${v.length} dimensions, expected ${dim}.`);
  if (!isFiniteVector(v)) throw new BadVectorError(`${label} contains NaN or Infinity. The embedding model produced invalid output.`);
  if (isZeroVector(v)) throw new BadVectorError(`${label} is all zeros. The embedding model produced invalid output.`);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  if (Math.abs(Math.sqrt(n) - 1) > 1e-3) throw new BadVectorError(`${label} is not unit length (norm ${Math.sqrt(n).toFixed(4)}).`);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Startup check. `vectors` are the embeddings of, in order:
 *   [related A, related B, unrelated C]
 * They must be valid, distinct, and A should sit closer to B than to C.
 */
export function startupCheck(vectors, dim) {
  if (vectors.length !== 3) throw new BadVectorError('Startup check needs exactly three vectors.');
  vectors.forEach((v, i) => assertGoodVector(v, dim, `Startup vector ${i + 1}`));
  const [a, b, c] = vectors;
  if (cosine(a, b) > 0.9999 && cosine(a, c) > 0.9999) {
    throw new BadVectorError('All startup vectors are identical. The embedding model is not reading its input.');
  }
  if (!(cosine(a, b) > cosine(a, c))) {
    throw new BadVectorError(
      `Startup sanity check failed: related sentences scored ${cosine(a, b).toFixed(3)} but an unrelated one scored ${cosine(a, c).toFixed(3)}.`,
    );
  }
  return { related: cosine(a, b), unrelated: cosine(a, c) };
}

export const STARTUP_TEXTS = Object.freeze([
  'The detective examined the footprints beside the window.',
  'An investigator studied the marks on the ground near the glass.',
  'Quarterly tax filings are due at the end of the month.',
]);

/**
 * Split texts into batches whose padded size (batch size x longest item) stays under a token budget.
 * `lengths` are token counts. Returns arrays of indexes into the original order.
 */
export function planBatches(lengths, budget) {
  const order = lengths.map((l, i) => i).sort((a, b) => lengths[b] - lengths[a]);
  const batches = [];
  let current = [];
  let longest = 0;
  for (const idx of order) {
    const len = Math.max(1, lengths[idx]);
    if (current.length && Math.max(longest, len) * (current.length + 1) > budget) {
      batches.push(current);
      current = [];
      longest = 0;
    }
    current.push(idx);
    longest = Math.max(longest, len);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Decode one IEEE half-precision value stored in a Uint16. */
export function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * Model outputs can arrive as float32, float16 (as Uint16Array or Float16Array) or other typed
 * arrays depending on the build. Always hand back a Float32Array.
 */
export function toFloat32Array(data, type = 'float32') {
  if (data instanceof Float32Array) return data;
  if (type === 'float16' && data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = halfToFloat(data[i]);
    return out;
  }
  return Float32Array.from(data, Number);
}
