// Every tunable number and model id lives here, so nothing is hidden in the code.
//
// STATUS OF THESE VALUES (read before trusting any of them):
//   * Model ids, dtypes and the embedding prefix rules come from CLAUDE.md / the model cards.
//   * Everything marked UNCALIBRATED or UNMEASURED is a placeholder. The build sandbox could not
//     reach Hugging Face and had no GPU, so tools/calibrate.html and tools/spike.html have not
//     been run. Run them on a WebGPU machine and paste the results here.

export const APP = Object.freeze({
  name: 'carrel',
  version: '0.1.0',
  repo: 'https://github.com/ravjothbrar/carrel',
  licence: 'Apache-2.0',
});

// ---------------------------------------------------------------------------------------------
// Embeddings: EmbeddingGemma 2 (text and images share one space)
// ---------------------------------------------------------------------------------------------
export const EMBED = Object.freeze({
  id: 'onnx-community/embeddinggemma-2-ONNX',
  // UNPINNED: "main". After testing, replace with the commit hash that was tested.
  revision: 'main',
  // Parts load separately. audio_encoder is deliberately absent (out of scope, and the worker
  // removes audio_config so Transformers.js does not fetch it). Never fp16: the model card warns
  // it can silently produce NaNs.
  dtype: Object.freeze({ model: 'q4', vision_encoder: 'q4' }),
  dtypeLabel: 'q4',
  dim: 768, // 768 or 512 at most. Never 128: multimodal quality drops badly.
  prefixScheme: 'embeddinggemma-2/search-v1',
  maxBatchTokens: 2700, // model card: keep WebGPU batches under about 2,700 tokens
  maxContextTokens: 8192,
});

// Prefix rules from the model card. Images take no prefix.
export const PREFIX = Object.freeze({
  query: (q) => `task: search result | query: ${q}`,
  doc: (title, text) => `title: ${title && title.trim() ? title.trim() : 'none'} | text: ${text}`,
  // Used by the citation check: a claim from the answer is compared with the passages it cites.
  // UNVERIFIED for EmbeddingGemma 2: this task name is taken from the EmbeddingGemma (300M)
  // prompt list. tools/calibrate.html reports how well it separates supported from unsupported.
  verify: (s) => `task: fact checking | query: ${s}`,
});

/** One string that identifies the embedding setup. Stored with every chunk and image. */
export function embedKey() {
  return `${EMBED.id}|${EMBED.dtypeLabel}|${EMBED.dim}|${EMBED.prefixScheme}`;
}

// ---------------------------------------------------------------------------------------------
// Generators: Gemma 4 E2B by default, E4B for capable devices
// ---------------------------------------------------------------------------------------------
export const GENERATORS = Object.freeze({
  e2b: Object.freeze({
    tier: 'e2b',
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    revision: 'main', // UNPINNED, see EMBED.revision
    label: 'Gemma 4 E2B',
    dtype: 'q4f16',
  }),
  e4b: Object.freeze({
    tier: 'e4b',
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    revision: 'main',
    label: 'Gemma 4 E4B',
    dtype: 'q4f16',
  }),
});

export const GENERATION = Object.freeze({
  maxNewTokens: 512,
  doSample: false, // greedy
  enableThinking: false,
  warmupTokens: 128,
});

// ---------------------------------------------------------------------------------------------
// Chunking and retrieval
// ---------------------------------------------------------------------------------------------
export const CHUNK = Object.freeze({
  minTokens: 250,
  targetTokens: 300,
  maxTokens: 350,
  overlapRatio: 0.15,
});

export const RETRIEVAL = Object.freeze({
  passages: 5, // CLAUDE.md: 4 to 6 chunks. Small models do poorly with long contexts.
  closestWhenAbstaining: 3,
  // Passages scoring below this fraction of the best score are left out of the prompt: a small
  // model reads weak, off-topic passages as if they mattered.
  relativeFloor: 0.5,
});

// ---------------------------------------------------------------------------------------------
// Thresholds. UNCALIBRATED placeholders.
//
// How they must be set: run tools/calibrate.html on a WebGPU machine. It embeds a small labelled
// set (questions that are / are not answered by a passage; answer sentences that are / are not
// supported by a passage), prints the score distributions per class and the threshold that
// maximises accuracy, and emits a block to paste here. Until then the values below are
// conservative guesses taken from typical cosine ranges for embedding models of this family
// (related text about 0.5 to 0.8, unrelated about 0.1 to 0.3) and the UI says so.
// ---------------------------------------------------------------------------------------------
export const THRESHOLDS = Object.freeze({
  calibrated: false,
  // Best text-to-text similarity below this: do not call the generator.
  abstain: 0.35,
  // An answer sentence whose best similarity to the passages it cites is below this is flagged.
  support: 0.45,
  // Images are compared by rank, and only shown if the best text-to-image score clears this
  // (cross-modal scores are lower and not comparable to text-to-text scores) and beats the median
  // image score by at least this margin.
  imageMin: 0.12,
  imageMargin: 0.04,
});

// ---------------------------------------------------------------------------------------------
// Model tiering (silent upgrade to E4B). UNMEASURED: set from tools/spike.html.
// ---------------------------------------------------------------------------------------------
export const TIERING = Object.freeze({
  minMaxBufferSize: 2 * 1024 ** 3, // UNMEASURED
  minMaxStorageBufferBindingSize: 1 * 1024 ** 3, // UNMEASURED
  minDecodeTokensPerSecond: 12, // UNMEASURED: E2B decode speed needed before E4B is worth trying
  storageHeadroomFactor: 2, // free quota must be at least 2x the E4B download (CLAUDE.md)
  slowConnectionTypes: Object.freeze(['slow-2g', '2g', '3g']),
  failureKey: 'carrel.e4bFailed',
  settingKey: 'carrel.useLargerModel',
});

// ---------------------------------------------------------------------------------------------
// Network policy. The CSP in index.html must list exactly these hosts.
// ---------------------------------------------------------------------------------------------
// Transformers.js asks https://huggingface.co/... and follows redirects to a CDN. Which CDN hosts
// the redirects land on is one of the things tools/spike.html records. UNVERIFIED list:
export const HF_HOSTS = Object.freeze([
  'huggingface.co',
  // suffix matches, used by the in-worker fetch guard and mirrored in the CSP
  '.huggingface.co',
  '.hf.co',
]);

export function isAllowedModelHost(hostname) {
  return HF_HOSTS.some((h) => (h.startsWith('.') ? hostname.endsWith(h) : hostname === h));
}

// ---------------------------------------------------------------------------------------------
// Limits (documents are untrusted input)
// ---------------------------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  maxFileBytes: 60 * 1024 * 1024,
  maxPdfPages: 1500,
  maxTextChars: 8_000_000,
  maxImageBytes: 25 * 1024 * 1024,
  imageMaxSide: 512,
  imageJpegQuality: 0.85,
  maxPackDecompressedBytes: 1.5 * 1024 ** 3,
  maxPackHeaderBytes: 64 * 1024 * 1024,
  maxPackChunks: 250_000,
  maxPackImages: 5_000,
  minPdfCharsPerDoc: 40,
});

export const SAMPLE = Object.freeze({
  url: new URL('../sample/sherlock.carrel', import.meta.url).href,
  label: 'Sherlock Holmes stories',
});
