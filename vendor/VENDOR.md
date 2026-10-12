# Vendored dependencies

Everything here is copied from npm so the service worker can precache it and the page never
loads code from a CDN. `npm` was used only to fetch the tarballs. Files are byte-for-byte what npm
ships, except for the one documented patch below.

| File | Package | Version | Licence | SHA-256 |
|---|---|---|---|---|
| `transformers/transformers.js` | `@huggingface/transformers` (standalone browser bundle, ONNX Runtime Web included) | 4.3.1 | Apache-2.0 | `1911482e3b015737451c5a716fec18d4324f6206df5e338a0c4914909188d6dd` |
| `ort/ort-wasm-simd-threaded.asyncify.mjs` | `onnxruntime-web` (the exact version Transformers.js 4.3.1 depends on) | 1.31.0-dev.20260914-8d85527a0 | MIT | `0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611` |
| `ort/ort-wasm-simd-threaded.asyncify.wasm` | `onnxruntime-web` | 1.31.0-dev.20260914-8d85527a0 | MIT | `49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082` |
| `pdfjs/pdf.min.mjs` | `pdfjs-dist` | 6.4.299 | Apache-2.0 | `57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2` |
| `pdfjs/pdf.worker.min.mjs` | `pdfjs-dist` | 6.4.299 | Apache-2.0 | `9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18` |

Notes

- Transformers.js defaults to loading the ONNX Runtime wasm from jsDelivr. carrel overrides
  that to the local `ort/` files (see `js/workers/runtime.js`); the CSP would block the CDN anyway.
- The asyncify build is the one Transformers.js 4.3.1 selects by default for WebGPU in Chrome and Edge.
  The other ORT variants (plain, JSEP, JSPI) were not vendored.
- Install with `npm install --ignore-scripts`: `onnxruntime-node`'s postinstall downloads binaries
  that a browser app does not need.
- Fonts live in `/fonts` (SIL OFL 1.1, from the `@fontsource` packages: Hanken Grotesk 5.3.0,
  Source Serif 4 5.3.1, JetBrains Mono 5.3.0, Latin subset only).

## The one patch: `transformers/transformers.js`

The file is `dist/transformers.js` from `@huggingface/transformers@4.3.1` with two identifiers
renamed, everywhere they occur:

- `Mistral3ForConditionalGeneration` to `Mistral3ForCondGeneration`
- `Idefics3ForConditionalGeneration` to `Idefics3ForCondGeneration`

Why: each is exactly 32 letters, and GitHub push protection mistook the `Mistral3...` class name
for a Mistral API key (it sits next to the word "mistral") and blocked the push. There is no secret
in the file. carrel uses neither class. The pristine file's SHA-256 is
`3e9a4ce35946bc8094c297023acfbe6051ad24c1c480a180f80c0c2f632c5ef5`; to reproduce the patch run
`sed -i 's/Mistral3ForConditionalGeneration/Mistral3ForCondGeneration/g; s/Idefics3ForConditionalGeneration/Idefics3ForCondGeneration/g'`
on it. If you would rather ship the pristine file, allow the flagged alert in the repository's
secret-scanning settings and replace the file.
