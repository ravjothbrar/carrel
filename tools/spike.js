// The benchmark spike. Everything it reports is measured here, on this machine, with the real
// engine and the real models; nothing is estimated. Run it, then paste the result block into the README.
import { createEngine, capabilities } from '../js/engine-client.js';
import { GENERATORS, EMBED, PREFIX } from '../js/config.js';
import { dot } from '../js/search.js';
import { formatMB } from '../js/text.js';

const $ = (s) => document.querySelector(s);
const logEl = $('#log');
const log = (m) => { logEl.textContent += `${m}\n`; console.log(m); };
const ms = (t0) => Math.round(performance.now() - t0);

const PROMPT = [
  { role: 'system', content: 'Answer only from the numbered passages and cite them like [1].' },
  { role: 'user', content: 'Passages:\n\n[1] (test, §1)\nThe lighthouse was built in 1874 from grey granite. Its lamp was converted to electricity in 1952.\n\nQuestion: When did the lighthouse lamp become electric?' },
];

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const value = await fn();
    log(`${label}: ${ms(t0)} ms`);
    return { ok: true, ms: ms(t0), value };
  } catch (e) {
    log(`${label}: FAILED after ${ms(t0)} ms: ${e.name}: ${e.message}`);
    return { ok: false, ms: ms(t0), error: `${e.name}: ${e.message}` };
  }
}

async function run() {
  $('#run').disabled = true;
  logEl.textContent = '';
  const result = { when: new Date().toISOString(), userAgent: navigator.userAgent, versions: { transformers: '4.3.1' }, notes: [] };
  const engine = createEngine();

  result.capabilities = await capabilities();
  log(`adapter: ${JSON.stringify(result.capabilities.adapter)}`);
  log(`limits: ${JSON.stringify(result.capabilities.limits)}`);
  if (!result.capabilities.webgpu) throw new Error(result.capabilities.reason);
  const storage = await navigator.storage.estimate();
  result.storage = { quota: storage.quota, usage: storage.usage };
  result.connection = navigator.connection ? { effectiveType: navigator.connection.effectiveType, saveData: navigator.connection.saveData, downlink: navigator.connection.downlink } : null;

  // ---- embeddings
  const es = await engine.embedStatus();
  result.embedding = { id: EMBED.id, dtype: EMBED.dtype, downloadBytes: es.bytes, wasCached: es.cached, files: es.files };
  log(`embedding model: ${formatMB(es.bytes)} (${es.cached ? 'already cached: load time is warm' : 'cold'})`);
  let lastLog = 0;
  const load = await timed('embedding model load (download + session)', () => engine.loadEmbedder((p) => {
    if (p.kind === 'download' && performance.now() - lastLog > 1500) { lastLog = performance.now(); log(`  ${formatMB(p.loaded)} / ${formatMB(p.total)}`); }
  }));
  result.embedding.loadMs = load.ms;
  result.embedding.loadOk = load.ok;
  if (load.ok) {
    result.embedding.startupCheck = load.value.health;
    const texts = ['The detective examined the footprints.', 'A hansom cab waited in the fog.', 'Quarterly tax filings are due.'];
    const e1 = await timed('embed 3 texts', () => engine.embedTexts(texts.map((t) => PREFIX.doc('', t))));
    result.embedding.embed3TextsMs = e1.ms;
    const q = await engine.embedTexts([PREFIX.query('What was parked in the fog?')]);
    result.embedding.sampleScores = e1.value.map((v) => Number(dot(q[0], v).toFixed(3)));
    log(`  sample query scores vs the 3 texts: ${result.embedding.sampleScores.join(', ')} (the cab text should be highest)`);
  }

  // ---- generators
  for (const tier of document.querySelector('#do-e4b').checked ? ['e2b', 'e4b'] : ['e2b']) {
    const cfg = GENERATORS[tier];
    const entry = { id: cfg.id, dtype: cfg.dtype };
    result[tier] = entry;
    const st = await engine.generatorStatus(tier, false);
    entry.downloadBytesTextOnly = st.bytes;
    entry.wasCached = st.cached;
    log(`${cfg.label}: text-only download ${formatMB(st.bytes)} (${st.cached ? 'cached' : 'cold'})`);
    if (tier === 'e4b') {
      const pf = await timed('E4B background prefetch', () => engine.prefetchGenerator('e4b', (p) => { if (p.kind === 'download' && performance.now() - lastLog > 3000) { lastLog = performance.now(); log(`  ${formatMB(p.loaded)} / ${formatMB(p.total)}`); } }));
      entry.prefetchMs = pf.ms;
    }
    const l = await timed(`${cfg.label} load`, () => engine.loadGenerator(tier));
    entry.loadMs = l.ms; entry.loadOk = l.ok; entry.error = l.error;
    if (!l.ok) { result.notes.push(`${cfg.label} failed to load: ${l.error}`); continue; }
    const speeds = [];
    for (let i = 0; i < 3; i++) {
      const w = await timed(`  warm-up ${i + 1} (128 tokens)`, () => engine.warmup(128));
      if (w.ok) speeds.push(Number(w.value.tps?.toFixed(1)));
    }
    entry.decodeTokensPerSecond = speeds;
    const g = await timed('  sample answer', () => engine.generate({ messages: PROMPT }, () => {}));
    if (g.ok) { entry.sampleAnswer = g.value.text; entry.sampleTokens = g.value.tokens; entry.prefillMs = g.value.prefillMs; entry.answerTps = g.value.tps; log(`  answer: ${g.value.text}`); }
    if (performance.memory) entry.jsHeapMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
  }

  if ($('#do-vision').checked) {
    const st = await engine.generatorStatus('e2b', true);
    result.vision = { downloadBytes: st.bytes, wasCached: st.cached };
    const l = await timed('E2B with vision (Gemma4ForConditionalGeneration) load', () => engine.loadGenerator('e2b', { vision: true }));
    result.vision.loadMs = l.ms; result.vision.loadOk = l.ok; result.vision.error = l.error;
  }

  result.hosts = await engine.hosts();
  log(`hosts contacted by the workers (resource timing): ${result.hosts.join(', ')}`);
  result.notes.push('hosts: put exactly these in HF_HOSTS (js/config.js) and connect-src (index.html).');
  $('#result').value = JSON.stringify(result, null, 2);
  $('#run').disabled = false;
}

$('#run').addEventListener('click', () => run().catch((e) => { log(`ERROR: ${e.message}`); $('#run').disabled = false; }));
