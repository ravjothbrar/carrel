// Interface wiring. All state lives in Session; this file turns events into DOM and DOM events into
// Session calls. Text from documents and from the model only ever reaches the page through
// textContent (see dom.js).

import { APP, GENERATORS, THRESHOLDS, TIERING } from './config.js';
import { $, $$, clear, h } from './dom.js';
import { createEngine, capabilities } from './engine-client.js';
import { NetCounter } from './netcount.js';
import { ConsentDeclined, Session } from './session.js';
import { Store } from './store.js';
import { readSetting, writeSetting } from './tiering.js';
import { formatMB } from './text.js';
import { createSheet } from './view-sheet.js';

const net = new NetCounter();

async function main() {
  registerServiceWorker();
  wireNetCounter();

  const caps = await capabilities();
  if (!caps.webgpu) {
    showUnsupported(caps.reason);
    document.body.dataset.ready = 'true';
    return;
  }

  const store = new Store();
  const engine = createEngine({ net, onDeviceLost: (reason, which) => session.handleDeviceLost(reason, which) });
  const session = new Session({ store, engine, confirmDownload: showDownloadConsent, confirmVisionDownload: showVisionConsent });

  try {
    await session.init();
  } catch (e) {
    showNotice(`carrel could not open its storage: ${e.message}`);
    return;
  }

  wireSession(session);
  wireControls(session);
  wireSettings(session);
  renderLibrary(session.libraryInfo(), session);
  document.body.dataset.ready = 'true';
  $('#calibration-note').textContent = THRESHOLDS.calibrated
    ? ''
    : 'The cut-offs for "not in your documents" and "not clearly supported" are placeholder values that have not been calibrated yet. Treat both as rough.';
}

// ---------------------------------------------------------------------------------------------
// unsupported browsers
// ---------------------------------------------------------------------------------------------
function showUnsupported(reason) {
  document.body.classList.add('no-webgpu');
  $('#unsupported').hidden = false;
  $('#unsupported-reason').textContent = reason ?? '';
  $('#model-state').textContent = 'not loaded: needs WebGPU';
}

// ---------------------------------------------------------------------------------------------
// service worker, install, offline readout
// ---------------------------------------------------------------------------------------------
function registerServiceWorker() {
  const state = $('#offline-state');
  const online = () => (navigator.onLine ? 'online now' : 'offline now');
  const set = (t) => {
    state.textContent = `${t} · ${online()}`;
  };
  if (!('serviceWorker' in navigator)) {
    set('Offline copy: not supported in this browser');
    return;
  }
  navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => set('Offline copy: ready'))
    .catch(() => set('Offline copy: could not be installed'));
  set('Offline copy: installing');
  window.addEventListener('online', () => set(state.textContent.split(' · ')[0]));
  window.addEventListener('offline', () => set(state.textContent.split(' · ')[0]));

  let deferred = null;
  const btn = $('#install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    btn.hidden = true;
  });
}

function wireNetCounter() {
  const paint = (snap) => {
    $('#net-count').textContent = String(snap.count);
    $('#net-label').textContent = snap.count === 1 ? 'network request' : 'network requests';
    $('#verify-count').textContent = String(snap.count);
    $('#verify-blocked').textContent = String(snap.blocked);
    $('#verify-failed').textContent = String(snap.failed);
    const hosts = Object.entries(snap.hosts).map(([host, n]) => `${host} ×${n}`);
    $('#verify-hosts').textContent = hosts.length ? `To: ${hosts.join(', ')}` : 'None so far.';
    $('#verify-local').textContent = `This site's own files fetched after load: ${snap.local}`;
  };
  net.onChange(paint);
  paint(net.snapshot());
  const start = () => net.watchPage(window);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

// ---------------------------------------------------------------------------------------------
// status, notices, model line
// ---------------------------------------------------------------------------------------------
const statusRows = new Map();

function renderStatus({ key, done, text, numbers, loaded, total, indeterminate }) {
  const wrap = $('#status');
  if (done) {
    statusRows.get(key)?.remove();
    statusRows.delete(key);
    wrap.hidden = statusRows.size === 0;
    return;
  }
  let row = statusRows.get(key);
  if (!row) {
    row = h('div', { class: 'status-row mono' },
      h('span', { class: 't' }),
      h('span', { class: 'numbers' }),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Progress' }, h('i')),
    );
    statusRows.set(key, row);
    wrap.append(row);
  }
  wrap.hidden = false;
  $('.t', row).textContent = text ?? '';
  $('.numbers', row).textContent = numbers ?? '';
  const bar = $('.bar', row);
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  bar.classList.toggle('indeterminate', !!indeterminate || !(total > 0));
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.style.setProperty('--p', pct.toFixed(1));
}

function showNotice(text, level = 'error') {
  const n = $('#notice');
  $('#notice-text').textContent = text;
  n.classList.toggle('info', level === 'info');
  n.setAttribute('role', level === 'info' ? 'status' : 'alert');
  n.hidden = false;
}

function renderModel({ label, state, extra }) {
  $('#model-name').textContent = label;
  $('#model-state').textContent = state;
  $('#model-extra').textContent = extra ?? '';
}

// ---------------------------------------------------------------------------------------------
// session events
// ---------------------------------------------------------------------------------------------
function wireSession(session) {
  session.addEventListener('status', (e) => renderStatus(e.detail));
  session.addEventListener('notice', (e) => showNotice(e.detail.text, e.detail.level));
  session.addEventListener('model', (e) => renderModel(e.detail));
  session.addEventListener('library', (e) => renderLibrary(e.detail, session));
  session.addEventListener('stats', (e) => {
    const el = $('#stat-tps');
    if (e.detail.tps) {
      el.hidden = false;
      el.textContent = `${e.detail.tps.toFixed(1)} tokens/s`;
    }
  });
  $('#notice-close').addEventListener('click', () => {
    $('#notice').hidden = true;
  });
}

let thumbUrls = [];

function renderLibrary(info, session) {
  const { docs, images, chunks, hasSample, empty, staleChunks } = info;
  $('#view-empty').hidden = !empty;
  $('#view-desk').hidden = empty;
  $('#sample-badge').hidden = !hasSample;
  $('#stat-docs').textContent = `${docs.length + images.length} ${docs.length + images.length === 1 ? 'item' : 'items'}`;
  $('#stat-chunks').textContent = `${chunks.toLocaleString('en-GB')} chunks indexed`;
  if (staleChunks) $('#empty-note').textContent = `${staleChunks} stored passages were made with a different embedding setup and are not searched.`;

  thumbUrls.forEach(URL.revokeObjectURL);
  thumbUrls = [];
  const list = clear($('#shelf-list'));
  for (const d of docs) {
    list.append(h('li', {},
      h('div', { class: 'shelf-item-main' },
        h('span', { class: 'shelf-item-name' }, d.name),
        h('span', { class: 'shelf-item-meta mono' }, `${d.kind === 'pdf' ? `PDF${d.pages ? `, ${d.pages} pages` : ''}` : 'text'} · ${d.chunkCount ?? 0} chunks`),
        d.sample ? h('span', { class: 'tag mono' }, 'SAMPLE') : null,
      ),
      h('button', { type: 'button', class: 'btn mono small', 'aria-label': `Remove ${d.name}`, onclick: () => session.removeDoc(d.id) }, 'Remove'),
    ));
  }
  for (const im of images) {
    const url = URL.createObjectURL(im.blob);
    thumbUrls.push(url);
    const input = h('input', {
      class: 'caption-input',
      type: 'text',
      value: im.caption,
      maxlength: '200',
      'aria-label': `Caption for ${im.name}`,
      onchange: (e) => session.setImageCaption(im.id, e.currentTarget.value),
    });
    list.append(h('li', {},
      h('div', { class: 'shelf-item-main' },
        h('span', { class: 'shelf-item-label' }, h('img', { class: 'shelf-item-thumb', src: url, alt: '' }), input),
        h('span', { class: 'shelf-item-meta mono' }, `image · ${im.source || 'added by you'}`),
        im.sample ? h('span', { class: 'tag mono' }, 'SAMPLE') : null,
      ),
      h('button', { type: 'button', class: 'btn mono small', 'aria-label': `Remove image ${im.name}`, onclick: () => session.removeImage(im.id) }, 'Remove'),
    ));
  }
}

// ---------------------------------------------------------------------------------------------
// consent panels (before any download)
// ---------------------------------------------------------------------------------------------
function showConsent({ copy, rows, goLabel, goDisabled = false }) {
  const panel = $('#consent');
  $('#consent-copy').textContent = copy;
  const dl = clear($('#consent-sizes'));
  for (const [k, v] of rows) dl.append(h('dt', {}, k), h('dd', {}, v));
  $('#consent-go-label').textContent = goLabel;
  $('#consent-go').disabled = goDisabled;
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest' });
  $('#consent-go').focus({ preventScroll: true });
  return new Promise((resolve) => {
    const done = (v) => {
      panel.hidden = true;
      $('#consent-go').removeEventListener('click', yes);
      $('#consent-cancel').removeEventListener('click', no);
      document.removeEventListener('keydown', key);
      resolve(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const key = (e) => {
      if (e.key.toLowerCase() === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey && !$('#consent-go').disabled) done(true);
      if (e.key === 'Escape') done(false);
    };
    $('#consent-go').addEventListener('click', yes);
    $('#consent-cancel').addEventListener('click', no);
    document.addEventListener('keydown', key);
  });
}

function showDownloadConsent({ embedBytes, genBytes, genLabel, offline }) {
  const mb = (b) => (b === null || b === undefined ? 'size unknown' : formatMB(b));
  const total = embedBytes != null && genBytes != null ? embedBytes + genBytes : null;
  return showConsent({
    copy: offline
      ? 'You appear to be offline. The first download needs a connection.'
      : 'carrel runs Gemma on this device, so it has to fetch the models once. This is the only time it uses the network for them.',
    rows: [
      ['Search', `EmbeddingGemma 2 · ${mb(embedBytes)}`],
      ['Answers', `${genLabel} · ${mb(genBytes)}`],
      ['Total', total === null ? 'size unknown' : formatMB(total)],
    ],
    goLabel: total === null ? 'Download' : `Download ${formatMB(total, 0)}`,
  });
}

function showVisionConsent({ bytes }) {
  return showConsent({
    copy: 'To describe images, Gemma needs its vision files. Transformers.js loads them together with the audio files, which carrel does not use but cannot skip. This is a one-time download.',
    rows: [['Vision files', bytes == null ? 'size unknown' : formatMB(bytes)]],
    goLabel: bytes == null ? 'Download' : `Download ${formatMB(bytes, 0)}`,
  });
}

/** Give focus back to whatever opened a dialog when it closes (browsers do this inconsistently). */
function restoreFocusOnClose(dlg, fallbackSelector) {
  let opener = null;
  const remember = () => {
    opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  };
  dlg.addEventListener('close', () => {
    const target = opener?.isConnected && opener.offsetParent !== null ? opener : $(fallbackSelector);
    if (document.activeElement !== target) target?.focus?.({ preventScroll: true });
    opener = null;
  });
  return remember;
}

// ---------------------------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------------------------
function wireControls(session) {
  const docsInput = $('#file-docs');
  const imgInput = $('#file-images');
  let busyAsking = false;

  const run = (p) => p.catch((e) => {
    if (e instanceof ConsentDeclined) return;
    showNotice(e.message ?? String(e));
  });

  const upload = () => docsInput.click();
  const images = () => imgInput.click();
  const sampleLoad = () => run(session.loadSample());

  docsInput.addEventListener('change', () => {
    const files = [...docsInput.files];
    docsInput.value = '';
    if (files.length) run(session.addFiles(files));
  });
  imgInput.addEventListener('change', () => {
    const files = [...imgInput.files];
    imgInput.value = '';
    if (files.length) run(session.addFiles(files));
  });

  const actions = { upload, images, paste: openPaste, sample: sampleLoad, 'remove-sample': () => run(session.removeSample()) };
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-action]');
    if (t && actions[t.dataset.action]) actions[t.dataset.action]();
  });

  // drag and drop anywhere on the window
  const win = $('#app');
  let depth = 0;
  const over = (on) => {
    win.classList.toggle('over', on);
    $('#drop-overlay').hidden = !on;
  };
  win.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    depth++;
    over(true);
  });
  win.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault();
  });
  win.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) over(false);
  });
  win.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    over(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) run(session.addFiles(files));
  });

  // paste dialog
  const dlg = $('#paste-dialog');
  const rememberPasteOpener = restoreFocusOnClose(dlg, '#app');
  function openPaste() {
    rememberPasteOpener();
    $('#paste-text').value = '';
    $('#paste-name').value = '';
    dlg.showModal();
    $('#paste-text').focus();
  }
  $('#paste-cancel').addEventListener('click', () => dlg.close());
  $('#paste-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#paste-text').value;
    const title = $('#paste-name').value;
    dlg.close();
    if (text.trim()) run(session.addPaste(text, title));
  });

  // asking
  const form = $('#ask');
  const input = $('#question');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question || busyAsking) return;
    busyAsking = true;
    $('#ask-go').disabled = true;
    const sheet = createSheet(question);
    $('#sheets').prepend(sheet.el);
    sheet.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    let streamed = '';
    const view = { ...sheet, stream: (piece) => sheet.stream((streamed += piece)) }; // sheet methods close over their own state
    try {
      const result = await session.ask(question, view);
      input.value = '';
      if (result.image) await showFigure(session, sheet, result, question);
    } catch (err) {
      if (err instanceof ConsentDeclined) {
        sheet.setError('The model download was declined, so carrel cannot answer yet. Ask again whenever you want to download it.');
      } else {
        sheet.setError(err.message ?? String(err));
      }
    } finally {
      busyAsking = false;
      $('#ask-go').disabled = false;
    }
  });
}

async function showFigure(session, sheet, result, question) {
  const img = result.image;
  const url = URL.createObjectURL(img.blob);
  const fig = sheet.addFigure({ url, name: img.name, caption: img.caption, source: img.source, score: img.score, rank: img.rank }, 1);
  const describe = async (confirm) => {
    fig.describing('Gemma is looking at the image…');
    try {
      fig.described(await session.describeImage(img, question, { confirm }));
    } catch (e) {
      if (e instanceof ConsentDeclined) fig.offerDescribe('Describe this image', () => describe(true));
      else fig.failed(`Could not describe the image: ${e.message}`);
    }
  };
  const vs = await session.visionStatus();
  if (result.abstained || !vs.ready) {
    fig.offerDescribe(vs.ready || vs.bytes == null ? 'Describe this image' : `Describe this image (extra download, ${formatMB(vs.bytes, 0)})`, () => describe(true));
  } else {
    await describe(false);
  }
}

// ---------------------------------------------------------------------------------------------
// settings and packs
// ---------------------------------------------------------------------------------------------
function wireSettings(session) {
  const dlg = $('#settings-dialog');
  const rememberSettingsOpener = restoreFocusOnClose(dlg, '#open-settings');
  const toggle = $('#setting-large');
  const packInput = $('#file-pack');

  const openSettings = async () => {
    rememberSettingsOpener();
    toggle.checked = readSetting();
    const info = session.upgradeInfo;
    $('#setting-large-note').textContent = info
      ? info.upgrade
        ? `This device passed the checks (${info.tps?.toFixed(1)} tokens/s measured on ${GENERATORS.e2b.label}).`
        : `Not used on this device: ${info.reasons.join('; ')}.`
      : `Decided after your first answer, from a short speed test, graphics limits (needs maxBufferSize of at least ${(TIERING.minMaxBufferSize / 1024 ** 3).toFixed(0)} GiB, unmeasured) and free storage.`;
    dlg.showModal(); // open at once; the storage figures arrive when the browser answers (it can be slow)
    const line = $('#storage-line');
    line.textContent = 'Reading storage figures…';
    try {
      const answer = Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.()]);
      const [est, persisted] = await Promise.race([answer, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
      line.textContent = `Using ${formatMB(est.usage ?? 0)} of ${formatMB(est.quota ?? 0, 0)} · ${persisted ? 'kept' : 'not guaranteed to be kept'} by the browser`;
    } catch {
      line.textContent = 'Storage figures are not available right now.';
    }
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('#open-settings')) openSettings();
  });
  $('#settings-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target === dlg) $('#export-pack').click();
  });
  toggle.addEventListener('change', () => {
    writeSetting(toggle.checked);
    session.settingChanged(toggle.checked);
  });

  $('#export-pack').addEventListener('click', async () => {
    try {
      const { blob, filename } = await session.exportPack();
      const a = h('a', { href: URL.createObjectURL(blob), download: filename });
      document.body.append(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    } catch (e) {
      dlg.close();
      showNotice(e.message);
    }
  });
  $('#import-pack').addEventListener('click', () => packInput.click());
  packInput.addEventListener('change', async () => {
    const file = packInput.files[0];
    packInput.value = '';
    if (!file) return;
    dlg.close();
    try {
      await session.importPack(file);
    } catch (e) {
      showNotice(e.message);
    }
  });
  $('#clear-all').addEventListener('click', async () => {
    if (!window.confirm('Remove all documents, images and settings that carrel stored in this browser?')) return;
    await session.clearAll();
    dlg.close();
    showNotice('Everything carrel stored has been removed. Downloaded models remain in the browser cache.', 'info');
  });

  // keyboard hints
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target;
    const field = t.closest?.('input, textarea, select, [contenteditable="true"]');
    if ((field && field.offsetParent !== null) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    const pick = (sel) => {
      const el = $$(sel).find((x) => x.offsetParent !== null);
      if (el) {
        e.preventDefault();
        el.click();
      }
    };
    if (k === 'u') pick('[data-action="upload"]');
    else if (k === 'p') pick('[data-action="paste"]');
    else if (k === 'm') pick('[data-action="images"]');
    else if (k === 's') pick('#open-settings');
    else if (k === 'e') openSettings();
    else if (k === 'i') pick('#install');
    else if (k === 'h') {
      e.preventDefault();
      location.hash = 'how';
      $('#how').scrollIntoView();
    } else if (k === 'g') {
      e.preventDefault();
      window.open(APP.repo, '_blank', 'noopener,noreferrer');
    } else if (k === 'a' || k === '/') {
      const q = $('#question');
      if (q && q.offsetParent !== null) {
        e.preventDefault();
        q.focus();
      }
    }
  });
}

main().catch((e) => {
  showNotice(`carrel failed to start: ${e.message}`);
});

window.addEventListener('unhandledrejection', (e) => {
  showNotice(`Something went wrong: ${e.reason?.message ?? e.reason}`);
});
