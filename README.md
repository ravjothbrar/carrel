# carrel

*n. a private desk in a library.*

**Ask your documents. They stay put.** carrel is a research assistant that lives in a browser tab. You add your own documents and images, ask a question, and get an answer with its sources set in the margin. Everything runs on your device with Gemma. There are no accounts, no server and no analytics, and after the first load it works with the network off.

Open source, Apache-2.0. Plain HTML, CSS and ES modules; no bundler, no framework.

## Read this first: what has and has not been verified

This repository was built in a sandbox that had **no GPU and no access to huggingface.co, gutenberg.org or Wikimedia**. So:

| | Status |
|---|---|
| Interface, storage, chunking, search, packs, prompts, citation check, abstention, tiering logic, service worker, CSP | Built and tested (see [Tests](#tests)) |
| The workers' use of Transformers.js, ONNX Runtime and WebGPU: wasm loading under the CSP, sessions on a WebGPU adapter, tokenizer, batching, KV cache, streaming, caching, E4B prefetch and swap, offline reload | Built and tested end to end **against toy ONNX models** on a software WebGPU adapter. Four real bugs were found and fixed this way |
| **EmbeddingGemma 2 and Gemma 4 themselves** | **Never run.** Class names and call shapes were checked against the vendored Transformers.js 4.3.1 source, nothing more |
| Model download sizes, load times, tokens per second (E2B and E4B), E4B memory use | **Not measured** |
| The Hugging Face redirect hosts in the CSP | **Unverified** |
| Abstention, support and image thresholds | **Uncalibrated placeholders** (the UI says so) |
| `sample/sherlock.carrel` | **Not built** (needs a GPU and the network). The tooling is written and tested up to the GPU step |
| Name conflicts | **There is one**, see [Name](#name) |

Everything unverified is listed with the exact command that settles it in [What to run on a real machine](#what-to-run-on-a-real-machine).

## What it does

1. **Add.** Text, Markdown and PDF files (text layer only; scanned PDFs are refused, there is no OCR), pasted text, and images. Files are split into passages of about 250 to 350 tokens with about 15 percent overlap, cut at sentence boundaries, and embedded by EmbeddingGemma 2. Images are downscaled to about 512 px JPEG (which also drops EXIF) and embedded into the same space.
2. **Ask.** The question is embedded and compared with every passage by brute-force cosine similarity over typed arrays. If the best match is under the abstention threshold, carrel says *That isn't in your documents*, shows the closest passages, and **does not call the generator**.
3. **Answer.** Gemma 4 gets the five best passages and is told to answer only from them and to cite passage numbers. Output is greedy, thinking is off, at most 512 new tokens. The answer is typeset like a page; citations are footnote marks and the passages sit in the margin.
4. **Check.** Each sentence of the finished answer is embedded and compared with the passages it cites. Sentences below the support threshold are marked *not clearly supported by your documents*. This is a similarity check, not proof.
5. **Images.** A matching image appears as `FIG. 1` with its caption and source. Gemma can describe it, labelled *described by Gemma on this device*.

Gemma 4 E2B is the default. After the first answer, capable devices are quietly moved to E4B (see [Model tiering](#model-tiering)). The footer always names the model in use.

## Privacy and the network rule

- No accounts, cookies, analytics or third-party scripts or fonts. All code, fonts and wasm are vendored in this repository.
- The only network traffic after page load is the one-time model download from Hugging Face. This is enforced twice:
  - a `<meta>` Content-Security-Policy limits `connect-src` to this origin and Hugging Face hosts;
  - the model workers are started from a blob wrapper so that they **inherit** that policy (a worker started directly from a URL ignores a page's meta CSP; `tests/e2e/csp.test.mjs` proves both halves), and their `fetch` is also guarded to https Hugging Face hosts only.
- Documents and model output never become HTML. There is no `innerHTML` anywhere (a test greps for it), text goes through `textContent`, and the little Markdown subset (bold, italic, code, lists) is built from DOM nodes.
- The app has no tools. Passages are untrusted and could contain instructions aimed at the model. The worst a prompt injection can do here is make the answer wrong, which is what the citation check and the visible sources are for.
- The footer shows a live count of requests to other hosts since load, and the *Verify it yourself* panel walks through the airplane-mode test. The counter reports what the page can see; your browser's network panel is the independent check.

## Model tiering

Everyone starts on E2B. E4B is used only if all of these hold (constants in `js/config.js`, logic in `js/tiering.js`, unit-tested):

1. The WebGPU adapter's `maxBufferSize` and `maxStorageBufferBindingSize` meet a minimum. **The minimums are placeholders until the spike has run.**
2. A 128-token warm-up on the loaded E2B decodes at or above a threshold (placeholder).
3. Free storage is at least twice the E4B download (the size is read from the repository, not guessed).
4. `saveData` is off and the connection is not slow cellular.
5. The "Use the larger model when this device can handle it" setting is on (default).

E4B downloads in the background after the first answer, into the same cache the loader reads, and is swapped in only between questions. If it fails to load or the GPU device is lost unexpectedly, carrel reverts to E2B at once, records the failure in `localStorage`, and does not retry. An interrupted download resumes at file granularity on the next visit. No prompt, no banner.

Retrieval, citation checking and abstention use EmbeddingGemma 2 and are identical on both tiers.

## Knowledge packs

*Settings, Export my documents* writes one `.carrel` file: a gzip stream holding a JSON header (format version, embedding model id, precision, dimension, prefix scheme, documents, passage text, image metadata) and the raw float32 vectors, then the image bytes. Importing refuses a pack made with a different embedding setup, with a message saying what differs, rather than returning bad results. Packs are untrusted input: sizes are checked, vectors must be finite, and decompression is capped. Export then import returns **identical** search results (unit test: bit-identical vectors and scores; browser test: after clearing everything).

## Sample pack (backup only)

A few Sherlock Holmes stories by Arthur Conan Doyle (public domain) plus three original drawings, offered under the upload area as *Try a sample*. It is never auto-loaded, is labelled `SAMPLE` everywhere, shows a persistent badge, can be removed in one click, and is never included when you export.

The pack file is not in the repository yet. To build it (needs a GPU with WebGPU, and the network for Gutenberg and the model):

```
npm install --ignore-scripts
node tools/build-sample.mjs            # add --text file.txt if you already downloaded pg1661.txt
node tools/parity.mjs                  # re-embeds 12 chunks and 3 images in the browser and compares cosines
```

The build strips the Project Gutenberg header, footer and name, refuses to continue if it cannot find each story or a story is implausibly short, records the source in the pack metadata, and embeds in headless Chromium with the same engine and dtype the browser uses. The three drawings in `sample/images` were made for this project and are dedicated to the public domain (CC0 1.0); each has its source and licence recorded in `sample/images/images.json`, and the build refuses an image without them.

## What to run on a real machine

Use current Chrome or Edge with WebGPU, serve the repo (`npm run serve`) and:

| What | Command | Settles |
|---|---|---|
| Sizes, load times, decode speed (E2B and E4B), adapter limits, **Hugging Face redirect hosts** | open `/tools/spike.html`, press Run | the table below, `TIERING`, `HF_HOSTS`, the CSP |
| Thresholds | open `/tools/calibrate.html`, press Run, paste the block | `THRESHOLDS` in `js/config.js` |
| Sample pack | `node tools/build-sample.mjs` then `node tools/parity.mjs` | the sample, the parity test |
| Airplane mode with the real models | the *Verify it yourself* steps | the acceptance test |

### Measured numbers

None of these has been measured. They are filled in from the spike's output, not from estimates.

| Item | Value |
|---|---|
| EmbeddingGemma 2 (q4) download | *not measured* (CLAUDE.md says about 175 MB text + 109 MB vision) |
| Gemma 4 E2B (q4f16) download, text only | *not measured* |
| Gemma 4 E4B (q4f16) download, text only | *not measured* |
| Extra download for image description (vision plus audio files) | *not measured* |
| Embedding model load time | *not measured* |
| E2B load time, decode tokens/s | *not measured* |
| E4B load time, decode tokens/s, memory | *not measured* |
| Hugging Face hosts the files really come from | *not measured* |

What *has* been measured, in this repository: the app shell and vendored libraries precache to **30.3 MB** (26.9 MB of that is the ONNX Runtime wasm); fonts are 188 KB.

## Assumptions that could be wrong

These are the places where carrel guesses about files it could not open. Each fails loudly rather than silently:

- **The embedding model's output name.** carrel looks for `sentence_embedding` (and a few alternatives) and refuses to guess a pooling step if none exists.
- **EmbeddingGemma 2's task prefix for citation checking** (`task: fact checking | query: …`) comes from the first EmbeddingGemma's prompt list, not the v2 card. `tools/calibrate.html` reports how well it separates supported from unsupported claims.
- **`q4` and `q4f16` exist** for every part that is loaded (including the vision encoder), and the text-only `Gemma4ForCausalLM` path loads `embed_tokens` + `decoder_model_merged`. The ONNX layout was inferred from Transformers.js' session tables.
- **Gemma 4's chat template** accepts a `system` role and an `enable_thinking` flag; carrel strips thinking-channel debris if the model emits any, but the marker syntax is a guess.
- **Image description needs an extra download**: Transformers.js has no option to skip the audio encoder for `Gemma4ForConditionalGeneration`, so the first image description loads vision and audio files together. carrel asks before downloading them and says the size.
- **Embedding images** with the real model has not been exercised (the toy embedder is text only).
- Model revisions are `main`, **unpinned**. Pin the commit you test (`EMBED.revision`, `GENERATORS.*.revision`).
- The thresholds. Until calibration, the "not in your documents" cut-off and the support cut-off are guesses, and both can misjudge.

## Tests

```
npm install --ignore-scripts      # dev tools only; the app has no build step
npm test                          # 70 unit tests, Node, no browser
npm run test:e2e                  # 45 browser tests in 11 files, headless Chromium
# last full run (all 115 passing): unit 70, flow 9, packs 5, security 4, unsupported 1, csp 3,
# offline 2, pdf 4, images 4, tier 8, integration 3, tools 2
```

| File | What it checks |
|---|---|
| `tests/unit` | chunking, sentence splitting, search, vector checks (NaN, zeros, size), pack round trip with **identical** results, incompatible and damaged packs, decompression cap, prompt and citation parsing, support and abstention logic, every tiering condition, IndexedDB store, no `innerHTML`, no CDN URLs, CSP present, precache manifest not stale, Gutenberg stripping, calibration maths |
| `flow`, `images`, `pdf`, `packs`, `security`, `unsupported`, `tier`, `offline` | the real interface, store, packs, PDF.js and service worker with a **stand-in engine** (hashed bag-of-words embeddings and a scripted "generator", clearly labelled in `tests/fixtures/fake-engine.js`; swapped in at the network layer, so no test hook ships in the app). Covers upload-first start, consent and MB progress, margin typesetting, an unsupported sentence being flagged, abstention not calling the generator (`generate` count stays 0), HTML in documents and answers staying inert, real PDFs made by Chromium (text layer and scanned), export then clear then import, a sample pack's labelling and removal, every reason for staying on E2B, E4B failing and not retrying, and the airplane test: load, **stop the server**, reload, add a document, ask, get a cited answer |
| `csp` | connect-src applies inside a worker started the way carrel starts them, the in-worker guard blocks other hosts and look-alikes, a plain worker is not covered (which is why the wrapper exists), real worker plumbing, and the real app on a browser without WebGPU |
| `integration` | the **real** app, workers, vendored Transformers.js and ONNX Runtime on **WebGPU** against toy ONNX models served at the Hugging Face URLs (`tests/fixtures/toy-embedder`, `toy-generator`, regenerated by `make.py`): consent with real sizes, download progress reaching 100%, 768-d unit vectors, retrieval, a streamed answer with footnotes and a flagged invented sentence, abstention, the E4B background prefetch and swap with no second download, and an offline reload that needs no needed weight file. Skipped automatically if there is no WebGPU adapter. These toys prove the plumbing and nothing about Gemma |

Bugs the integration tests found that the stand-in engine could not: the startup check read a transfer wrapper instead of vectors; fully cached models looked "not downloaded" offline because optional files that had answered 404 online were probed again; a model swap was treated as a GPU failure because disposing a model destroys its WebGPU device on purpose; and the library's download total counted files it never downloads, so progress could not reach 100%.

## Layout

```
index.html  css/  js/            the app (js/workers: embedding and generator workers)
vendor/  fonts/                  vendored libraries and fonts, with versions, hashes and licences
sw.js  precache.json  manifest.webmanifest  icons/
sample/                          sample images (and, once built, sherlock.carrel)
tools/                           dev server, spike, calibration, sample build, parity, previews
tests/                           unit, browser and integration tests, fixtures
```

`npm run build:sw` rewrites `precache.json` and the version in `sw.js`; a unit test fails if they are stale. Deploy by publishing the repository root as static files (`.github/workflows/pages.yml` does this for GitHub Pages).

## Vendored code

Transformers.js 4.3.1, ONNX Runtime Web 1.31.0-dev (the version Transformers.js depends on), PDF.js 6.4.299. Fonts: Hanken Grotesk, Source Serif 4, JetBrains Mono (SIL OFL 1.1). See `vendor/VENDOR.md` for hashes. **One patch:** two 32-letter class names in the Transformers.js bundle are renamed because GitHub push protection mistook one for a Mistral API key; details and the pristine hash are in `vendor/VENDOR.md`.

## Name

carrel is the intended name, repo `carrel`, pack extension `.carrel`, intended home `ravjothbrar.com/carrel/`. **Phase 6's conflict check could only be done in part from the build sandbox (no DNS, no registry access beyond npm and PyPI), and it found a conflict:**

- **PyPI and GitHub already have a project called `carrel`**: `coltonbearden/carrel` ([github.com/coltonbearden/carrel](https://github.com/coltonbearden/carrel)), MIT-licensed, v0.5.0, described as "a library desk for your files, and your agents": a terminal toolkit that reads, indexes, searches and packs documents, with an MCP server. Same metaphor, adjacent purpose (private local document search). That is a real chance of confusion, especially in search results and package names.
- npm: `carrel` returns 404, "unpublished on 2021-05-31", so a package of that name once existed.
- crates.io, domains and trademark databases: **not checked** (blocked or no DNS).

This has been left as it is, as instructed. Decide whether to keep the name and distinguish clearly (for example "carrel, in the browser"), or rename before launch. Nothing in the code depends on the name except `.carrel`, the `carrel` IndexedDB database and the `carrel.*` localStorage keys.

## Licence

Apache-2.0 (see `LICENSE` and `NOTICE`). Models are downloaded at runtime from Hugging Face and are used under their own licences.
