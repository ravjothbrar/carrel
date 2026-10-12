// Minimal lint config with no dependencies: catches unused names and undefined variables.
const browser = Object.fromEntries(
  ['window', 'document', 'navigator', 'location', 'localStorage', 'indexedDB', 'caches', 'self', 'console', 'fetch', 'performance', 'URL', 'Blob', 'File', 'Image', 'Response', 'Request', 'Headers',
   'Worker', 'TextEncoder', 'TextDecoder', 'CompressionStream', 'DecompressionStream', 'ReadableStream', 'TransformStream', 'AbortController', 'CustomEvent', 'EventTarget', 'MutationObserver',
   'PerformanceObserver', 'WeakSet', 'structuredClone', 'createImageBitmap', 'setTimeout', 'clearTimeout', 'crypto', 'Uint8Array', 'Float32Array', 'Uint16Array', 'Intl', 'queueMicrotask',
   'ServiceWorkerGlobalScope', 'DOMException', 'requestAnimationFrame', 'getComputedStyle'].map((n) => [n, 'readonly']),
);
const node = Object.fromEntries(['process', 'Buffer', 'console', 'URL', 'fetch', 'setTimeout', 'CompressionStream', 'DecompressionStream', 'Blob', 'Response', 'TextEncoder', 'TextDecoder', 'File', 'structuredClone', 'AbortController', 'setInterval', 'clearInterval'].map((n) => [n, 'readonly']));

export default [
  { ignores: ['vendor/**', 'node_modules/**', 'sample/**', 'tests/fixtures/**/repo/**'] },
  {
    files: ['js/**/*.js', 'tools/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browser },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-undef': 'error', 'no-var': 'error', eqeqeq: ['error', 'always', { null: 'ignore' }] },
  },
  {
    files: ['tools/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...node, ...browser } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-undef': 'error', eqeqeq: ['error', 'always', { null: 'ignore' }] },
  },
  { files: ['tests/fixtures/fake-engine.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browser } },
];
