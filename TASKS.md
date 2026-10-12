# carrel: tasks

Phase by phase, as `CLAUDE.md` asks. `[x]` means done and tested in the build sandbox.
`[~]` means written and unit-tested, but needs a real WebGPU machine to prove.
`[ ]` means not done.

The build sandbox had **no access to huggingface.co, gutenberg.org or Wikimedia, and no GPU**.
Anything that needs those is marked and listed again in the README under "Not measured".

## Phase 0: scaffold
- [x] Vendor Transformers.js 4.3.1, ONNX Runtime Web wasm, PDF.js; self-host fonts; record versions + hashes
- [x] Apache-2.0 licence, NOTICE
- [x] Confirm in the vendored source that `EmbeddingGemma2Model`, `Gemma4ForConditionalGeneration` and `Gemma4ForCausalLM` exist
- [ ] Confirm Hugging Face file layout, ONNX output names and file sizes (**needs network access to huggingface.co**: `tools/spike.html`)

## Phase 1: core logic (pure modules, Node tests)
- [x] Sentence splitter + sentence-aware chunker (250 to 350 tokens, about 15% overlap)
- [x] Brute-force cosine search; image ranking kept separate from text
- [x] `.carrel` pack: gzip + JSON header + binary vectors; compatibility check; round-trip test
- [x] Prompt builder, citation parser
- [x] Citation check (support threshold) and abstention rule
- [x] Tiering decision (all five conditions) + failure memory
- [x] Vector sanity check (NaN, all-zero, wrong dimension, duplicates)

## Phase 2: workers and storage
- [x] IndexedDB store (docs, chunks, images, meta) with tests
- [x] Text / Markdown / PDF extraction; "no text layer" message for scanned PDFs
- [x] Image downscale to about 512 px JPEG
- [~] Embedding worker (EmbeddingGemma 2, q4, 768-d, audio encoder not loaded)
- [~] Generator worker (Gemma 4 E2B, text-only first; vision model loaded on first image question)
- [~] Download progress in MB; size lookup before the download starts

## Phase 3: interface
- [x] Editorial layout: wordmark, headline, framed window, margin-column answers, `FIG.` images
- [x] Upload-first empty state; sample link; sample badge; one-click removal
- [x] Settings dialog (larger-model toggle, export, import, clear)
- [x] Footer: active model, network request counter, licence
- [x] "Verify it yourself" panel; `[H]` / `[G]` / `[U]` keyboard hints
- [x] Strict CSP (meta), enforced inside workers too
- [x] Service worker + manifest (installable, offline shell)
- [x] "Needs a WebGPU browser" message with static preview

## Phase 4: tests
- [x] Unit tests (`npm test`)
- [x] Browser tests with a stand-in engine (`npm run test:e2e`): flows, abstention does not call the generator, unsupported sentence flagged, pack round trip, CSP, offline reload, no HTML injection
- [x] Real worker plumbing against the real vendored library (fails cleanly without WebGPU)
- [ ] Real-model tests: airplane mode, E4B swap, parity test, calibration (**needs a WebGPU machine**)

## Phase 5: spike, calibration, sample, release
- [~] `tools/spike.html`: measures download size, load time, tokens per second, memory, Hugging Face hosts (for the CSP)
- [~] `tools/calibrate.html`: calibrates abstention / support / image thresholds on a labelled set
- [~] `tools/build-sample.mjs`: Gutenberg fetch, header/footer strip, chunk, embed in headless Chromium with WebGPU, write `sample/sherlock.carrel`
- [~] `tools/parity.html`: re-embed stored sample chunks and compare cosine
- [ ] Run the above, fill the numbers into the README table, commit `sample/sherlock.carrel`
- [ ] Name check (domain, GitHub, trademark): the sandbox could not reach registries; see README
- [ ] Publish on GitHub Pages
