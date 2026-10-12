// Brute-force cosine search over typed arrays. Vectors are L2-normalised on the way in, so cosine
// similarity is a plain dot product. At the expected scale (low thousands of vectors) this takes
// well under a millisecond per query. No index structure, on purpose.

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function normalise(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Keep the first `dim` values and re-normalise. Same dimension must be used for queries and documents. */
export function truncateNormalise(v, dim) {
  return normalise(v.length === dim ? v : v.subarray(0, dim));
}

export class VectorIndex {
  /**
   * @param {number} dim
   * @param {{vector: Float32Array}[]} rows  each row also carries whatever metadata the caller wants back
   */
  constructor(dim, rows = []) {
    this.dim = dim;
    this.rows = rows;
    this.matrix = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => {
      if (r.vector.length !== dim) throw new Error(`Vector ${i} has ${r.vector.length} dimensions, expected ${dim}.`);
      this.matrix.set(r.vector, i * dim);
    });
  }

  get size() {
    return this.rows.length;
  }

  /** Scores for every row, in row order. */
  scores(query) {
    if (query.length !== this.dim) throw new Error(`Query has ${query.length} dimensions, expected ${this.dim}.`);
    const out = new Float32Array(this.rows.length);
    const { matrix, dim } = this;
    for (let r = 0; r < out.length; r++) {
      let s = 0;
      const base = r * dim;
      for (let d = 0; d < dim; d++) s += matrix[base + d] * query[d];
      out[r] = s;
    }
    return out;
  }

  /** Top k rows, best first. Ties break by row order so results are stable across export/import. */
  search(query, k) {
    const scores = this.scores(query);
    const order = Array.from(scores.keys());
    order.sort((a, b) => scores[b] - scores[a] || a - b);
    return order.slice(0, k).map((i, rank) => ({ row: this.rows[i], index: i, score: scores[i], rank: rank + 1 }));
  }
}

/**
 * Decide whether the best image match is worth showing. Images are judged by rank within the
 * image set plus a per-modality floor, because text-to-image cosine scores are lower than
 * text-to-text scores and are not comparable with them.
 * @returns {{show: boolean, hit: object|null, reason: string}}
 */
export function pickImage(imageIndex, query, { imageMin, imageMargin }) {
  if (!imageIndex || imageIndex.size === 0) return { show: false, hit: null, reason: 'no images' };
  const scores = imageIndex.scores(query);
  const sorted = Array.from(scores).sort((a, b) => b - a);
  const top = imageIndex.search(query, 1)[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  if (top.score < imageMin) return { show: false, hit: top, reason: `best image score ${top.score.toFixed(3)} is below ${imageMin}` };
  // With a single image there is no distribution to compare against; the floor alone decides.
  if (sorted.length >= 3 && top.score - median < imageMargin) {
    return { show: false, hit: top, reason: 'best image does not stand out from the others' };
  }
  return { show: true, hit: top, reason: 'ok' };
}
