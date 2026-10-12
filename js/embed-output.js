// Pure helpers for reading EmbeddingGemma 2 outputs. Kept out of the worker so they can be tested.

import { EMBED } from './config.js';
import { truncateNormalise } from './search.js';
import { toFloat32Array } from './vectors.js';

export const OUTPUT_NAMES = ['sentence_embedding', 'sentence_embeddings', 'embeddings', 'embedding', 'pooler_output'];

/** Find the pooled sentence embedding in the model outputs, or say clearly that it is not there. */
export function pickEmbedding(outputs) {
  for (const name of OUTPUT_NAMES) if (outputs[name]) return outputs[name];
  throw new Error(
    `EmbeddingGemma 2 returned [${Object.keys(outputs).join(', ')}] and none of those is a pooled sentence embedding ` +
      `(looked for ${OUTPUT_NAMES.join(', ')}). carrel will not guess a pooling step, because that would give silently wrong search results.`,
  );
}

/** Tensor of shape [rows, width] (or [width]) to one unit-length, `dim`-wide vector per row. */
export function rowsOf(tensor, dim = EMBED.dim) {
  const data = toFloat32Array(tensor.data, tensor.type);
  const [rows, width] = tensor.dims.length === 1 ? [1, tensor.dims[0]] : tensor.dims;
  if (width < dim) throw new Error(`The model returned ${width}-dimensional embeddings but carrel needs at least ${dim}.`);
  const out = [];
  for (let r = 0; r < rows; r++) out.push(truncateNormalise(data.subarray(r * width, (r + 1) * width), dim));
  return out;
}
