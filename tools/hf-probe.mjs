// Probes the real Hugging Face repos (no GPU needed): file lists and sizes, the hosts downloads redirect
// to, whether the config files carrel relies on exist, and the config that decides which sessions load.
// Run in CI (.github/workflows/probe.yml) because the build sandbox could not reach huggingface.co.
import fs from 'node:fs';
import { EMBED, GENERATORS } from '../js/config.js';

const repos = [
  { name: 'embedder', id: EMBED.id, suffix: '_q4' },
  { name: 'E2B', id: GENERATORS.e2b.id, suffix: '_q4f16' },
  { name: 'E4B', id: GENERATORS.e4b.id, suffix: '_q4f16' },
];
const out = {};
const mb = (n) => (n / 1e6).toFixed(1);

for (const r of repos) {
  const o = (out[r.name] = { id: r.id });
  const tree = await (await fetch(`https://huggingface.co/api/models/${r.id}/tree/main?recursive=1`)).json();
  if (!Array.isArray(tree)) { o.error = JSON.stringify(tree).slice(0, 300); continue; }
  const files = tree.filter((f) => f.type === 'file');
  o.rootFiles = files.filter((f) => !f.path.includes('/')).map((f) => `${f.path} (${f.size})`);
  o.onnxFiles = files.filter((f) => f.path.startsWith('onnx/')).map((f) => ({ path: f.path, bytes: f.size }));
  const sum = (re) => files.filter((f) => re.test(f.path)).reduce((n, f) => n + f.size, 0);
  const part = (name) => sum(new RegExp(`^onnx/${name}${r.suffix}\\.onnx(_data(_\\d+)?)?$`));
  o.partBytes = { model: part('model'), vision_encoder: part('vision_encoder'), audio_encoder: part('audio_encoder'), embed_tokens: part('embed_tokens'), decoder_model_merged: part('decoder_model_merged') };
  o.summaryMB = Object.fromEntries(Object.entries(o.partBytes).filter(([, v]) => v).map(([k, v]) => [k, mb(v)]));
  o.suffixesPresent = [...new Set(files.filter((f) => f.path.endsWith('.onnx')).map((f) => f.path.replace(/^onnx\/[a-z_]+?(_[a-z0-9]+)?\.onnx$/, '$1') || 'fp32'))];
  o.recentCommit = (await (await fetch(`https://huggingface.co/api/models/${r.id}`)).json()).sha;

  // does each file carrel's loaders insist on exist?
  const need = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'processor_config.json', 'preprocessor_config.json', 'generation_config.json', 'chat_template.jinja'];
  o.configFilesPresent = Object.fromEntries(need.map((n) => [n, files.some((f) => f.path === n)]));

  // redirect target of a real weight file: this is the host the CSP must allow
  const weight = o.onnxFiles.find((f) => f.path.endsWith('.onnx') || f.path.includes('_data'));
  if (weight) {
    const res = await fetch(`https://huggingface.co/${r.id}/resolve/main/${weight.path}`, { method: 'GET', redirect: 'manual', headers: { Range: 'bytes=0-0' } });
    const loc = res.headers.get('location');
    o.redirect = { status: res.status, host: loc ? new URL(loc).host : null };
    if (loc) {
      const res2 = await fetch(loc, { headers: { Range: 'bytes=0-0' }, redirect: 'manual' });
      o.redirect.secondHopStatus = res2.status;
      o.redirect.secondHopLocationHost = res2.headers.get('location') ? new URL(res2.headers.get('location')).host : null;
      o.redirect.corsAllowOrigin = res2.headers.get('access-control-allow-origin');
    }
  }
  // the configs that matter
  for (const n of ['config.json', 'processor_config.json', 'preprocessor_config.json']) {
    if (!files.some((f) => f.path === n)) continue;
    const j = await (await fetch(`https://huggingface.co/${r.id}/resolve/main/${n}`)).json();
    if (n === 'config.json') o.config = { model_type: j.model_type, architectures: j.architectures, hasVision: !!j.vision_config, hasAudio: !!j.audio_config, text_hidden: j.text_config?.hidden_size, layers: j.text_config?.num_hidden_layers, tjs: j['transformers.js_config'] ?? null };
    else o[n] = j.processor_class ? { processor_class: j.processor_class } : Object.keys(j).slice(0, 12);
  }
  if (files.some((f) => f.path === 'chat_template.jinja')) {
    const t = await (await fetch(`https://huggingface.co/${r.id}/resolve/main/chat_template.jinja`)).text();
    o.chatTemplate = { bytes: t.length, mentionsSystem: /system/.test(t), mentionsThinking: /thinking|thought|channel/i.test(t), head: t.slice(0, 600) };
  }
  console.log(`\n=== ${r.name} (${r.id})\n${JSON.stringify(o, null, 1)}`);
}
fs.writeFileSync('hf-probe.json', JSON.stringify(out, null, 2));

// compact summary, last in the log so a tailed log always includes it
for (const [name, o] of Object.entries(out)) {
  console.log(`SUMMARY ${name} ${JSON.stringify({ sha: o.recentCommit, MB: o.summaryMB, files: o.configFilesPresent, redirect: o.redirect, model: o.config && { type: o.config.model_type, vision: o.config.hasVision, audio: o.config.hasAudio, layers: o.config.layers }, suffixes: o.suffixesPresent, template: o.chatTemplate && { system: o.chatTemplate.mentionsSystem, thinking: o.chatTemplate.mentionsThinking } })}`);
}
