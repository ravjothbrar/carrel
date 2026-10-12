# carrel: build spec

**carrel** is a private research assistant that lives in a browser tab. The visitor adds their own documents and images, asks questions, and gets answers with citations. No accounts, no server, no analytics. After the first load it works with no internet.

Showcase project for the Gemma / Google DeepMind audience: it must be polished, honest about its limits, and open source (Apache-2.0). Hosted on GitHub Pages. Built in one day, so keep it simple and ship phase by phase (see TASKS.md).

## Name

**carrel** (always lowercase). A carrel is a private desk in a library, which is the whole product: a quiet place for your own documents. Repo name `carrel`, pack extension `.carrel`, intended URL under the owner's site (`ravjothbrar.com/carrel/`) like his other projects.

- Show a one-line mono definition near the wordmark: `carrel  n.  a private desk in a library`. Understated, editorial; no explanation beyond that.
- The name has **not** been checked for domain, GitHub, or trademark conflicts. Phase 6 includes that check; report any conflict instead of silently renaming.

## Locked decisions (do not re-open)

1. **Upload-first.** The default state of the app is "Add your own documents". A sample is offered only as a secondary, clearly labelled way to try the app (see "Sample pack").
2. **Sample pack is Sherlock Holmes**, public-domain text. It is a backup for people who have nothing to upload. It must be labelled as a sample everywhere it appears.
3. **Generator is Gemma 4 E2B by default.** If the device is powerful enough, upgrade to E4B silently (see "Model tiering").
4. **Embeddings are EmbeddingGemma 2** (multimodal). Text and images share one search.
5. **Image hits:** show the matching image with its caption/source, and also let Gemma describe it.
6. **Features that must ship:** installable offline app, shareable `.carrel` knowledge packs, citation checking, and a "not in your documents" abstention.
7. **Design:** the demo is the page. A short headline, then the working app directly below it. No separate marketing page. Editorial and understated, see "Design".

## Hard rules

- No accounts, no analytics, no cookies, no third-party scripts or fonts.
- The only network traffic after page load is the one-time model download from Hugging Face. Enforce this with a `<meta http-equiv="Content-Security-Policy">` that limits `connect-src` to `'self'` plus the Hugging Face hosts the model files actually come from (find them in the spike).
- User documents never leave the device. Nothing is uploaded anywhere.
- Treat every document as untrusted data. Never render model output or document text as HTML (use `textContent`, or sanitise any Markdown rendering). The app has no tools, so keep it that way.
- Never claim more than the app does. It is a small on-device model; show that plainly (see "Honesty UI").

## Stack

- Plain HTML, CSS and ES modules. **No bundler, no framework.** Web Workers for all model work. Deploys as static files to GitHub Pages.
- **Vendor all dependencies into the repo** (`/vendor`, pinned versions) so the service worker can precache them. Do not import from a CDN at runtime. Dependencies: `@huggingface/transformers` (Transformers.js) and its ONNX Runtime Web wasm files, and PDF.js for PDF text.
- Vector search is **brute-force cosine** over typed arrays. At the expected scale (low thousands of chunks) it is instant, so do not add HNSW or a vector database.
- Storage: IndexedDB for chunks, vectors and thumbnails; Cache Storage (Transformers.js default) for model files. Call `navigator.storage.persist()` after the first successful model load.
- GitHub Pages cannot set response headers, so cross-origin isolation is unavailable. The WebGPU path does not need it. Do not rely on threaded wasm.
- Target browsers: current Chrome and Edge with WebGPU. On anything else show a plain, friendly "this needs a WebGPU browser" message, with the sample's static screenshots as a preview. Do not build a CPU fallback.

## Models (verify each when you start, and pin what you test)

| Role | Hugging Face id | dtype | Notes |
|---|---|---|---|
| Embeddings | `onnx-community/embeddinggemma-2-ONNX` | `q4` on WebGPU | Parts load separately via dtype keys: `model` (text), `vision_encoder`. Do **not** load `audio_encoder` (out of scope). Apache-2.0. About 175 MB text + 109 MB vision at q4. |
| Generator (default) | `onnx-community/gemma-4-E2B-it-ONNX` | `q4f16` | Use `Gemma4ForConditionalGeneration`. Accepts text and images. |
| Generator (upgrade) | `onnx-community/gemma-4-E4B-it-ONNX` | `q4f16` | Same API. Browser memory use and speed are **unverified**: measure them. |

Embedding rules (from the model card; follow exactly):
- Text queries use the prefix `task: search result | query: {query}`.
- Text documents use `title: {title} | text: {content}`, or `title: none | text: {content}` with no title.
- Images take no prefix.
- Keep vectors at **768 dimensions** (512 at the very most). Do not truncate to 128: multimodal quality drops badly.
- If you truncate, re-normalise the vector, and use the same dimension for queries and documents.
- Context is 8,192 tokens shared across modalities. On WebGPU keep each batch under about 2,700 tokens.
- The official model card says **not to use float16** for this model (it can produce NaNs silently). The ONNX page lists fp16 but recommends q4 on WebGPU. Use q4, and add a startup check that rejects NaN or all-zero vectors.
- Cross-modal similarity scores are not calibrated like text-to-text scores. Use **rank** for images, and calibrate any threshold separately per modality.

Generation rules:
- Thinking mode off by default; greedy decoding or very low temperature; cap at about 512 new tokens.
- Keep the context short: 4 to 6 retrieved chunks of about 250 to 350 tokens each. Small models do poorly with long contexts.
- The system prompt says: answer only from the numbered passages, cite passage numbers, and say so if the passages do not contain the answer.

## Model tiering (silent upgrade to E4B)

Start every visitor on E2B. Quietly move capable devices to E4B. "Silent" means: **no prompt, no banner, no interruption.** It does not mean hidden: see "Honesty UI".

Upgrade only when **all** of these hold (thresholds are tunable constants, set from the benchmark spike):
1. A WebGPU adapter is present and its `maxBufferSize` and `maxStorageBufferBindingSize` are at or above the minimum the spike found necessary for E4B.
2. A short warm-up on the loaded E2B (about 128 tokens) measures decode speed at or above a threshold. Real measurement beats guessing from adapter info.
3. `navigator.storage.estimate()` shows free quota of at least about 2x the E4B download.
4. `navigator.connection.saveData` is not true, and `effectiveType` is not a slow cellular type (where available).
5. The user has not turned the setting off (see below).

Behaviour:
- Download E4B in the background only after the first successful answer, while no generation is running, and resume if interrupted.
- Swap only **between** questions, never mid-answer.
- Keep E2B cached as the fallback. If E4B fails to load, runs out of memory or loses the GPU device, revert to E2B at once, remember the failure in `localStorage`, and do not retry automatically.
- Retrieval, citation checking and abstention run on EmbeddingGemma 2 and are identical on both tiers.

## Honesty UI (small but required)

- A quiet footer line always shows the active model, e.g. `Gemma 4 E2B · running on this device`. When the tier changes the line changes with it.
- A settings toggle: "Use the larger model when this device can handle it" (default on). The first-run copy mentions the one-time model download and its size before it starts.
- Show real numbers: download progress in MB, chunks indexed, tokens per second.
- Every answer shows its source passages. Image descriptions are labelled "described by Gemma on this device".

## Data and packs

- A **document** is split into chunks of about 250 to 350 tokens with about 15 percent overlap, sentence-aware. Each chunk stores: text, source name, page or position, vector, and the model id and embedding settings used.
- An **image** stores: a downscaled copy (about 512 px, JPEG), its filename or user caption, and a vector.
- **`.carrel` pack format:** a single gzip-compressed file (use `CompressionStream`) with a JSON header and binary vector data. The header records format version, embedding model id, dtype, dimension and prefix scheme. On import, **refuse packs made with an incompatible embedding setup** with a clear message instead of silently returning bad results. Export and import must round-trip with identical search results (test this).
- PDF: text extraction only. If a PDF has no text layer, say clearly that scanned PDFs are not supported. No OCR.

## Pipeline

1. **Add**: read files, extract text, chunk, embed in a worker with a progress bar, store.
2. **Ask**: embed the query. Search text chunks (and image vectors, ranked separately). If the best text similarity is below the abstention threshold, **do not call the generator**: reply "That isn't in your documents" and show the closest passages anyway.
3. **Answer**: stream the generator's reply, citing passage numbers.
4. **Check**: split the finished answer into sentences, embed each with the appropriate similarity-task prefix, and compare against the cited passages. Mark sentences that fall below the support threshold as "not clearly supported by your documents". Thresholds are calibrated in the spike on a small labelled set, then stored as named constants with a comment saying how they were chosen.
5. **Images**: show the top image with its caption and source, then pass the image and the question to Gemma to describe what is visible and relevant. Label it as an AI description.

## Sample pack (backup only)

- A few Sherlock Holmes short stories by Arthur Conan Doyle (public domain). Suggested: "A Scandal in Bohemia", "The Red-Headed League", "The Speckled Band".
- Take the text from Project Gutenberg, **strip the Gutenberg header and footer**, and do not use the Project Gutenberg name or logo. Record the source in the pack's metadata.
- Pre-embed the pack at build time with **the same model and dtype the browser uses** (run the build script in headless Chromium with WebGPU, not Node CPU), so the visitor does not re-embed. Add a parity test: re-embed a handful of chunks in the browser and check cosine similarity against the stored vectors.
- Add a few public-domain or CC0 images with captions so the image flow can be tried. Check each licence before committing it, and record the source.
- In the UI the sample is a small secondary link under the upload area: "No documents handy? Try a sample (Sherlock Holmes stories)". When loaded, a persistent badge reads "Sample pack: add your own documents to use this for real", and the sample can be removed in one click.

## Design

**Goal: it should look designed by a person with taste, not generated.** Reference sites, viewed rendered: pooled.run, auth.md (WorkOS), Making Software, factory.com, here.now. Borrow their principles. Do not copy any site's look, colours or layout.

What those sites share:
- **One typeface, used large and tight.** The headline or wordmark is the brand (auth.md's wordmark is the hero). No decorative imagery.
- **Monochrome plus one accent, or none.** Paper-white or near-black, with hairline borders and dotted rules instead of shadows and gradients.
- **Monospace for the machinery.** Uppercase mono labels, buttons and nav (auth.md, factory, Making Software's `FIG.001` labels).
- **The product is the hero.** pooled.run and auth.md put a working mock in a framed window straight under the headline.
- **Keyboard-hint vocabulary:** `[D] Docs`, `[G] GitHub`. Use it for actions here.
- **Concrete copy.** Short sentences, lowercase wordmark, real numbers.

Our identity (a library carrel: a quiet private desk with notes in the margin):
- **Answers are typeset like a page, not chat bubbles.** No avatars, no bubbles. The question is a heading; the answer is set in a serif. Citations are numbered footnote marks, and the source passages sit in a **margin column** beside the text (stacked below on narrow screens). This is the signature element.
- **Images are figures:** labelled `FIG. 1`, with a mono caption and source underneath.
- **Mono for numbers and state:** MB downloaded, chunks indexed, tokens per second, "0 network requests".
- Layout: wordmark top left, two mono links top right (`[H] How it works`, `[G] GitHub`). Then the headline, one line of sub-copy, then the app in a hairline-bordered window. Footer: active-model line, request counter, licence.

Type and colour (suggestions; tune by eye, self-host everything, check each licence):
- Sans: Geist or Hanken Grotesk, tight tracking on large sizes. Serif for answers: Newsreader or Source Serif 4. Mono: Geist Mono or JetBrains Mono. Avoid Inter at default settings.
- Warm paper background (about `#F5F2EB`), near-black ink, hairlines at low contrast. **One accent: a vermilion "library stamp" red (about `#D8452B`)**, used sparingly for the active state, citation marks and the primary button. Deliberately not cobalt: several reference sites use blue.
- Dark variant: warm near-black, same accent. Respect `prefers-color-scheme` and `prefers-reduced-motion`.

Default state (upload-first): a bordered drop zone titled "Add your own documents", with `[U] Upload`, "paste text" and "drop images" beneath. Under it, small and secondary: "No documents handy? Try a sample (Sherlock Holmes stories)". The sample is never auto-loaded.

Avoid the tells of generated sites: gradients (especially purple-to-blue or pink), glassmorphism, soft stacked drop shadows on large rounded cards, sparkle icons, emoji, three identical feature cards in a row, everything centred with huge padding, floating blobs, "powered by AI" badges, and marketing copy full of em dashes and "unlock". One idea per screen. No feature grid at all.

Copy: headline "Ask your documents. They stay put.". Eyebrows: `ADD YOUR OWN`, `WORKS OFFLINE`, `VERIFY IT YOURSELF`. A "Verify it yourself" panel explains the airplane-mode test and shows a live count of network requests since load (it should read 0 once models are cached).

Responsive and keyboard accessible throughout, with visible focus states and real labels on every control.

## Testing and acceptance

- Airplane-mode test: load once, go offline, reload, add a document, ask a question, get a cited answer.
- Install as a PWA and open it from the home screen or desktop offline.
- Export a pack, clear site data, import it, and get identical search results.
- Abstention: ask something clearly absent from the documents and confirm the generator is not called.
- Citation check: a deliberately unsupported sentence is flagged.
- No NaN vectors, no text rendered as HTML, no requests outside the allowed hosts.
- README includes a table of **measured** numbers (download sizes, load time, tokens per second for E2B and E4B on at least one real machine) and clearly lists what was not measured.

## Do not

- Do not add accounts, analytics, a backend, or a framework.
- Do not store or send user documents anywhere.
- Do not present sample content as the user's data, or hide that it is a sample.
- Do not use float16 embeddings, 128-dimension vectors, or add audio support in this build.
- Do not commit anything copyrighted, including Google or DeepMind articles. Check licences for every sample item.
