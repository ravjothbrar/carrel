# carrel: tasks

Phase by phase, as `CLAUDE.md` asks. `[x]` means done and tested. `[~]` means written and tested against **toy models** or stand-ins, but not against the real Gemma models. `[ ]` means not done.

The build sandbox had **no access to huggingface.co, gutenberg.org or Wikimedia, and no GPU** (only a software WebGPU adapter). Anything that needs those is marked, and listed again in the README under "Read this first".

## Phase 0: scaffold
- [x] Vendor Transformers.js 4.3.1, ONNX Runtime Web wasm, PDF.js; self-host fonts; record versions, hashes and the one patch (`vendor/VENDOR.md`)
- [x] Apache-2.0 licence, NOTICE
- [x] Confirm in the vendored source that `EmbeddingGemma2Model`, `Gemma4ForConditionalGeneration` and `Gemma4ForCausalLM` exist, and how they load sessions
- [ ] Confirm Hugging Face file layout, ONNX output names and file sizes (**needs network access to huggingface.co**: `tools/spike.html`)

## Phase 1: core logic (pure modules, Node tests)
- [x] Sentence splitter + sentence-aware chunker (250 to 350 tokens, about 15% overlap)
- [x] Brute-force cosine search; image ranking kept separate from text
- [x] `.carrel` pack: gzip + JSON header + binary vectors; compatibility check; **identical** search results after a round trip
- [x] Prompt builder, citation parser
- [x] Citation check (support threshold) and abstention rule
- [x] Tiering decision (all five conditions) + failure memory
- [x] Vector sanity check (NaN, all-zero, wrong dimension, duplicates, non-unit)

## Phase 2: workers and storage
- [x] IndexedDB store (docs, chunks, images, meta)
- [x] Text / Markdown / PDF extraction; "no text layer" message for scanned PDFs
- [x] Image downscale to about 512 px JPEG
- [~] Embedding worker (EmbeddingGemma 2, q4, 768-d, audio encoder not loaded): runs for real against a toy ONNX embedder on WebGPU
- [~] Generator worker (Gemma 4 text-only first, vision model loaded on first image question): runs for real against a toy ONNX generator (KV cache, streaming, chat template). The vision path is untested
- [x] Download progress in MB counting only files actually downloaded; size lookup before the download starts
- [x] E4B prefetch into the loader's cache, swap between questions, revert on failure

## Phase 3: interface
- [x] Editorial layout: wordmark, headline, framed window, margin-column answers, `FIG.` images; dark mode; phone width
- [x] Upload-first empty state; sample link; sample badge; one-click removal
- [x] Settings dialog (larger-model toggle, export, import, clear)
- [x] Footer: active model, request counter, licence
- [x] "Verify it yourself" panel; `[H]` / `[G]` / `[U]` / `[P]` / `[S]` keyboard hints
- [x] Strict CSP (meta), inherited by the workers
- [x] Service worker + manifest (installable, offline shell); offline reload tested with the server stopped
- [x] "Needs a WebGPU browser" message with a static preview

## Phase 4: tests
- [x] Unit tests (`npm test`)
- [x] Browser tests with a stand-in engine (`npm run test:e2e`)
- [x] Real worker, ONNX Runtime and WebGPU integration against toy models (`tests/e2e/integration.test.mjs`); it found four real bugs
- [x] Spike and calibration tools run end to end against the toy models (`tests/e2e/tools.test.mjs`)
- [ ] Real-model tests: airplane mode, E4B swap, parity test, calibration (**needs a GPU and Hugging Face**)

## Phase 5: spike, calibration, sample, release
- [~] `tools/spike.html`: sizes, load time, tokens per second, adapter limits, Hugging Face hosts
- [~] `tools/calibrate.html`: abstention / support / image thresholds on a labelled set (`tools/calibration-set.json`, original text)
- [~] `tools/build-sample.mjs`: Gutenberg fetch, header/footer strip (tested), chunk, embed on the GPU, write `sample/sherlock.carrel`
- [~] `tools/parity.mjs`: re-embed stored sample chunks and compare cosine
- [x] Sample images: three original drawings, CC0, source and licence recorded
- [ ] Run the spike, calibration and sample build on a real machine; fill the numbers into the README table; commit `sample/sherlock.carrel`
- [x] Name check: **conflict found** (`coltonbearden/carrel`, PyPI `carrel`); reported in the README, not renamed. Domains, crates.io and trademarks could not be checked
- [x] GitHub Actions: tests, and Pages deploy of the shipped files only
- [ ] Publish on GitHub Pages (needs the repo owner to enable Pages and merge to `main`)
