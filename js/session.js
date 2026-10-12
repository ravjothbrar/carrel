// The controller: everything the app does, with no DOM. The interface listens to its events.
//
//   events:  status   {key, text, numbers, loaded, total, indeterminate} | {key, done: true}
//            notice   {text, level: 'error' | 'info'}
//            library  (documents / images / indexes changed)
//            model    {label, state, extra}
//            stats    {tps}

import { EMBED, GENERATION, GENERATORS, LIMITS, PREFIX, RETRIEVAL, SAMPLE, THRESHOLDS, embedKey } from './config.js';
import { chunkSegments, locLabel } from './chunk.js';
import { classifyFile, extractDocument, ExtractError, textFromPaste } from './extract.js';
import { captionFromFilename, downscaleToJpeg } from './image.js';
import { decodePack, encodePack, PackError } from './pack.js';
import { buildImageMessages, buildMessages, stripThinking } from './prompt.js';
import { pickImage, VectorIndex } from './search.js';
import { formatMB } from './text.js';
import { clearFailure, decideUpgrade, readFailure, readSetting, writeFailure } from './tiering.js';
import { analyseAnswer, judgeSentences, summarise } from './verify.js';

export class ConsentDeclined extends Error {
  constructor() {
    super('Download declined.');
    this.name = 'ConsentDeclined';
  }
}

export class Session extends EventTarget {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {ReturnType<import('./engine-client.js').createEngine>} deps.engine
   * @param {(info: {embedBytes: number|null, genBytes: number|null, genLabel: string, offline: boolean}) => Promise<boolean>} deps.confirmDownload
   * @param {(info: {bytes: number|null}) => Promise<boolean>} deps.confirmVisionDownload
   */
  constructor({ store, engine, confirmDownload, confirmVisionDownload, storage = globalThis.localStorage }) {
    super();
    this.store = store;
    this.engine = engine;
    this.confirmDownload = confirmDownload;
    this.confirmVisionDownload = confirmVisionDownload;
    this.storage = storage;

    this.docs = [];
    this.images = [];
    this.chunks = [];
    this.textIndex = new VectorIndex(EMBED.dim);
    this.imageIndex = new VectorIndex(EMBED.dim);
    this.staleChunks = 0;

    this.caps = null;
    this.embedderReady = false;
    this.embedderPromise = null;
    this.genPromise = null;
    this.gen = { tier: 'e2b', state: 'idle', vision: false };
    this.answeredOnce = false;
    this.upgradeStarted = false;
    this.e4bReady = false;
    this.upgradeInfo = null;
    this.chain = Promise.resolve(); // serialises anything that touches the generator
    this.persisted = false;
  }

  // ------------------------------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------------------------------
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  status(key, s) {
    this.emit('status', { key, ...s });
  }
  statusDone(key) {
    this.emit('status', { key, done: true });
  }
  notice(text, level = 'error') {
    this.emit('notice', { text, level });
  }
  #modelEvent(extra = '') {
    const cfg = GENERATORS[this.gen.tier];
    const state = {
      idle: 'not downloaded yet',
      downloading: 'downloading',
      loading: 'loading on this device',
      ready: 'running on this device',
      error: 'could not load',
    }[this.gen.state];
    this.emit('model', { label: cfg.label, state, tier: this.gen.tier, extra });
  }

  /** Run `fn` after everything queued before it has finished. */
  #exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------------------------------
  // start-up
  // ------------------------------------------------------------------------------------------
  async init() {
    await this.store.open();
    await this.reload();
    this.caps = await this.engine.capabilities();
    this.#modelEvent();
    return this.caps;
  }

  async reload() {
    const { docs, chunks, images } = await this.store.loadAll();
    this.docs = docs;
    this.chunks = chunks;
    this.images = images;
    const key = embedKey();
    const docById = new Map(docs.map((d) => [d.id, d]));
    const textRows = chunks
      .filter((c) => c.embedKey === key)
      .map((c) => ({ vector: c.vector, id: c.id, docId: c.docId, text: c.text, loc: c.loc, source: docById.get(c.docId)?.name ?? 'unknown' }));
    this.staleChunks = chunks.length - textRows.length;
    this.textIndex = new VectorIndex(EMBED.dim, textRows);
    const imgRows = images.filter((i) => i.embedKey === key).map((i) => ({ vector: i.vector, id: i.id, name: i.name, caption: i.caption, source: i.source, blob: i.blob }));
    this.imageIndex = new VectorIndex(EMBED.dim, imgRows);
    this.emit('library', this.libraryInfo());
  }

  libraryInfo() {
    return {
      docs: this.docs,
      images: this.images,
      chunks: this.textIndex.size,
      staleChunks: this.staleChunks,
      hasSample: this.docs.some((d) => d.sample) || this.images.some((i) => i.sample),
      empty: this.docs.length === 0 && this.images.length === 0,
    };
  }

  // ------------------------------------------------------------------------------------------
  // models: consent, download, load
  // ------------------------------------------------------------------------------------------
  async ensureEmbedder() {
    if (this.embedderReady) return;
    this.embedderPromise ??= this.#loadEmbedder().finally(() => {
      this.embedderPromise = null;
    });
    return this.embedderPromise;
  }

  async #loadEmbedder() {
    if (!this.caps?.webgpu) throw new Error(this.caps?.reason ?? 'WebGPU is not available.');
    let embed;
    let gen = null;
    this.status('prep', { text: 'Checking what needs downloading', indeterminate: true });
    try {
      embed = await this.engine.embedStatus();
      if (!embed.cached) gen = await this.engine.generatorStatus('e2b', false);
    } catch (e) {
      this.statusDone('prep');
      const offline = !navigator.onLine || /fetch|network|Failed/i.test(e.message);
      throw new Error(offline
        ? 'carrel needs the internet once, to download its models. Connect, then try again. After that it works offline.'
        : `Could not check the models: ${e.message}`);
    }
    this.statusDone('prep');

    if (!embed.cached) {
      const ok = await this.confirmDownload({ embedBytes: embed.bytes, genBytes: gen?.bytes ?? null, genLabel: GENERATORS.e2b.label, offline: !navigator.onLine });
      if (!ok) throw new ConsentDeclined();
    }

    const t0 = performance.now();
    this.status('embed', { text: embed.cached ? 'Loading the search model' : 'Downloading the search model (EmbeddingGemma 2)', indeterminate: true });
    try {
      await this.engine.loadEmbedder((p) => {
        if (p.kind === 'download') this.status('embed', { text: 'Downloading the search model (EmbeddingGemma 2)', numbers: `${formatMB(p.loaded)} / ${formatMB(p.total)}`, loaded: p.loaded, total: p.total });
      });
    } catch (e) {
      this.statusDone('embed');
      throw this.#friendly(e, 'The search model could not start');
    }
    this.statusDone('embed');
    this.embedderReady = true;
    this.embedLoadMs = Math.round(performance.now() - t0);
    this.#persistStorage();
    this.#startGenerator(); // not awaited: the first question waits for it, indexing does not
  }

  #startGenerator() {
    if (this.genPromise || this.gen.state === 'ready') return this.genPromise;
    this.genPromise = this.#loadGenerator('e2b').finally(() => {
      this.genPromise = null;
    });
    this.genPromise.catch((e) => this.notice(e.message)); // the first question would also surface it, but say so now
    return this.genPromise;
  }

  async #loadGenerator(tier, { vision = false } = {}) {
    const cfg = GENERATORS[tier];
    this.gen = { tier, state: 'downloading', vision: false };
    this.#modelEvent();
    try {
      const st = await this.engine.generatorStatus(tier, vision);
      // E2B's download was covered by the first-run consent. E4B is only ever loaded after the
      // background prefetch has put it in the cache; this load must never download it silently.
      if (!st.cached && tier !== 'e2b') throw new Error(`${cfg.label} has not been downloaded.`);
      await this.engine.loadGenerator(tier, {
        vision,
        onProgress: (p) => {
          if (p.kind !== 'download') return;
          this.status('gen', { text: `Downloading ${cfg.label}`, numbers: `${formatMB(p.loaded)} / ${formatMB(p.total)}`, loaded: p.loaded, total: p.total });
          if (p.loaded >= p.total) {
            this.gen.state = 'loading';
            this.#modelEvent();
            this.status('gen', { text: `Loading ${cfg.label} onto the graphics chip`, indeterminate: true });
          }
        },
      });
      this.gen = { tier, state: 'ready', vision };
      this.statusDone('gen');
      this.#modelEvent();
      this.#persistStorage();
    } catch (e) {
      this.statusDone('gen');
      this.gen = { tier, state: 'error', vision: false };
      this.#modelEvent();
      throw this.#friendly(e, `${cfg.label} could not start`);
    }
  }

  async #ensureGenerator() {
    if (this.gen.state === 'ready') return;
    if (this.genPromise) return this.genPromise;
    await this.#startGenerator();
  }

  #friendly(e, prefix) {
    if (e.name === 'NoWebGPU') return new Error(e.message);
    if (e.name === 'GpuError') return new Error(`${prefix}: the graphics chip ran out of memory or was reset (${e.message.slice(0, 160)}). Close other tabs that use the GPU and reload.`);
    if (e.name === 'TypeError' && /fetch/i.test(e.message)) return new Error(`${prefix}: the download failed. Check your connection and try again.`);
    return new Error(`${prefix}: ${e.message}`);
  }

  #persistStorage() {
    if (this.persisted) return;
    this.persisted = true;
    navigator.storage?.persist?.().catch(() => {});
  }

  // ------------------------------------------------------------------------------------------
  // adding things
  // ------------------------------------------------------------------------------------------
  /** @param {File[]} files */
  async addFiles(files) {
    const problems = [];
    let added = 0;
    for (const file of files) {
      try {
        const kind = classifyFile(file);
        if (/\.carrel$/i.test(file.name)) {
          await this.importPack(file);
        } else if (kind === 'image') {
          await this.addImages([file]);
        } else {
          const doc = await extractDocument(file);
          await this.#addExtracted(doc);
        }
        added++;
      } catch (e) {
        if (e instanceof ConsentDeclined) {
          problems.length = 0;
          this.notice('Nothing was added. carrel needs its models to read your documents, and the download was declined.', 'info');
          return { added, problems };
        }
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (problems.length) this.notice([...new Set(problems)].join(' '), 'error');
    return { added, problems };
  }

  async addPaste(text, title = '') {
    try {
      await this.#addExtracted(textFromPaste(text, title));
    } catch (e) {
      if (e instanceof ConsentDeclined) return this.notice('Nothing was added: the model download was declined.', 'info');
      this.notice(e.message);
    }
  }

  async #addExtracted(doc) {
    const chunks = chunkSegments(doc.segments);
    if (!chunks.length) throw new ExtractError(`${doc.name} has no text carrel can use.`);
    await this.ensureEmbedder();
    const texts = chunks.map((c) => PREFIX.doc(doc.title, c.text));
    this.status('index', { text: `Indexing ${doc.name}`, numbers: `0 / ${chunks.length} chunks`, loaded: 0, total: chunks.length });
    let vectors;
    try {
      vectors = await this.engine.embedTexts(texts, (p) => {
        if (p.kind === 'embed') this.status('index', { text: `Indexing ${doc.name}`, numbers: `${p.done} / ${p.total} chunks`, loaded: p.done, total: p.total });
      });
    } finally {
      this.statusDone('index');
    }
    const existing = this.docs.find((d) => d.name === doc.name && !d.sample);
    if (existing) await this.store.removeDoc(existing.id);
    const docId = await this.store.addDoc({ name: doc.name, title: doc.title, kind: doc.kind, pages: doc.pages });
    const key = embedKey();
    await this.store.addChunks(docId, chunks.map((c, i) => ({ text: c.text, loc: locLabel(c, i), vector: vectors[i], embedKey: key })));
    await this.reload();
    this.notice(`Added ${doc.name}: ${chunks.length} chunks indexed${existing ? ' (replaced the earlier copy)' : ''}.`, 'info');
  }

  /** @param {File[]} files */
  async addImages(files) {
    await this.ensureEmbedder();
    for (const file of files) {
      const { blob } = await downscaleToJpeg(file);
      this.status('index', { text: `Embedding ${file.name}`, indeterminate: true });
      let vec;
      try {
        [vec] = await this.engine.embedImages([blob]);
      } finally {
        this.statusDone('index');
      }
      await this.store.addImage({ name: file.name, caption: captionFromFilename(file.name), source: 'added by you', blob, mime: 'image/jpeg', vector: vec, embedKey: embedKey() });
    }
    await this.reload();
  }

  async setImageCaption(id, caption) {
    await this.store.updateImageCaption(id, caption.slice(0, 200));
    await this.reload();
  }

  async removeDoc(id) {
    await this.store.removeDoc(id);
    await this.reload();
  }
  async removeImage(id) {
    await this.store.removeImage(id);
    await this.reload();
  }
  async removeSample() {
    await this.store.removeSample();
    await this.reload();
  }
  async clearAll() {
    await this.store.clearAll();
    await this.reload();
  }

  // ------------------------------------------------------------------------------------------
  // packs
  // ------------------------------------------------------------------------------------------
  static get expectedEmbedding() {
    return { model: EMBED.id, dtype: EMBED.dtypeLabel, dim: EMBED.dim, prefixScheme: EMBED.prefixScheme };
  }

  async exportPack() {
    const docs = this.docs.filter((d) => !d.sample);
    const ids = new Set(docs.map((d) => d.id));
    const key = embedKey();
    const chunks = this.chunks.filter((c) => ids.has(c.docId) && c.embedKey === key);
    const images = this.images.filter((i) => !i.sample && i.embedKey === key);
    if (!chunks.length && !images.length) throw new Error('There is nothing of yours to export yet. The sample pack is not exported.');
    const imageData = await Promise.all(images.map(async (i) => ({ name: i.name, caption: i.caption, source: i.source, mime: i.mime, bytes: new Uint8Array(await i.blob.arrayBuffer()), vector: i.vector })));
    const bytes = await encodePack({
      meta: { name: 'carrel pack', sample: false },
      embedding: Session.expectedEmbedding,
      docs: docs.map((d) => ({ id: d.id, name: d.name, title: d.title, kind: d.kind })),
      chunks: chunks.map((c) => ({ doc: c.docId, text: c.text, loc: c.loc, vector: c.vector })),
      images: imageData,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return { blob: new Blob([bytes], { type: 'application/octet-stream' }), filename: `carrel-${stamp}.carrel`, chunks: chunks.length, images: images.length };
  }

  async importPack(file, { sample = false } = {}) {
    if (file.size > LIMITS.maxPackDecompressedBytes) throw new PackError('That file is too large to be a carrel pack.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { header, chunks, images } = await decodePack(bytes, Session.expectedEmbedding);
    const isSample = sample || header.meta?.sample === true;
    const key = embedKey();
    const docIds = [];
    for (const d of header.docs) docIds.push(await this.store.addDoc({ name: d.name, title: d.title ?? '', kind: d.kind, sample: isSample }));
    const byDoc = new Map();
    chunks.forEach((c) => {
      if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
      byDoc.get(c.doc).push({ text: c.text, loc: c.loc, vector: c.vector, embedKey: key });
    });
    for (const [doc, rows] of byDoc) await this.store.addChunks(docIds[doc], rows);
    for (const im of images) {
      await this.store.addImage({ name: im.name, caption: im.caption, source: im.source, blob: new Blob([im.bytes], { type: im.mime }), mime: im.mime, vector: im.vector, embedKey: key, sample: isSample });
    }
    await this.reload();
    this.notice(`Imported ${chunks.length} chunks and ${images.length} images${isSample ? ' (sample pack)' : ''}.`, 'info');
    return { chunks: chunks.length, images: images.length };
  }

  async loadSample() {
    let res;
    try {
      res = await fetch(SAMPLE.url);
    } catch {
      throw new Error('The sample pack could not be loaded. Are you offline?');
    }
    if (!res.ok) throw new Error('This copy of carrel does not include the sample pack yet (sample/sherlock.carrel is missing).');
    const blob = await res.blob();
    await this.importPack(new File([blob], 'sherlock.carrel'), { sample: true });
  }

  // ------------------------------------------------------------------------------------------
  // asking
  // ------------------------------------------------------------------------------------------
  /**
   * @param {string} question
   * @param {{phase: (t: string) => void, stream: (t: string) => void, passages: Function, abstain: Function, ...}} view
   */
  async ask(question, view) {
    await this.ensureEmbedder();
    return this.#exclusive(async () => {
      const t0 = performance.now();
      view.phase('Searching your documents');
      const [qv] = await this.engine.embedTexts([PREFIX.query(question)]);

      const found = this.textIndex.size ? this.textIndex.search(qv, RETRIEVAL.passages) : [];
      const best = found[0]?.score ?? null;
      const hits = found.filter((h) => h.score >= best * RETRIEVAL.relativeFloor);
      const toPassage = (h, i) => ({ n: i + 1, source: h.row.source, loc: h.row.loc, text: h.row.text, score: h.score, chunkId: h.row.id, vector: h.row.vector });

      const imageChoice = pickImage(this.imageIndex, qv, THRESHOLDS);
      const image = imageChoice.show
        ? {
            id: imageChoice.hit.row.id,
            name: imageChoice.hit.row.name,
            caption: imageChoice.hit.row.caption,
            source: imageChoice.hit.row.source,
            blob: imageChoice.hit.row.blob,
            score: imageChoice.hit.score,
            rank: imageChoice.hit.rank,
          }
        : null;

      // Abstention: below the threshold the generator is NOT called.
      if (!hits.length || best < THRESHOLDS.abstain) {
        const closest = hits.slice(0, RETRIEVAL.closestWhenAbstaining).map(toPassage);
        view.showPassages(closest, { title: closest.length ? 'Closest passages (none close enough)' : 'Sources' });
        view.abstain({ noText: !this.textIndex.size, closest: closest.length > 0 });
        view.final(`Searched ${this.textIndex.size} chunks · best match ${best === null ? 'none' : best.toFixed(2)} · below the ${THRESHOLDS.abstain} cut-off, so no model was used`);
        return { abstained: true, passages: closest, image, best, generatorCalled: false };
      }

      const passages = hits.map(toPassage);
      view.showPassages(passages);
      view.phase(`Reading ${passages.length} passage${passages.length === 1 ? '' : 's'}`);
      await this.#ensureGenerator();

      view.phase(`Writing with ${GENERATORS[this.gen.tier].label}`);
      const messages = buildMessages(question, passages);
      let out;
      try {
        out = await this.#generateWithFallback(messages, (piece) => view.stream(piece));
      } catch (e) {
        throw this.#friendly(e, 'The answer could not be written');
      }
      const text = stripThinking(out.text);
      if (!text) throw new Error('The model returned an empty answer. Try rephrasing the question.');

      // Check: compare every sentence with the passages it cites.
      view.phase('Checking each sentence against its sources');
      const { blocks, flat } = analyseAnswer(text, passages.length);
      const checkable = flat.filter((s) => s.checkable);
      let vectors = [];
      if (checkable.length) {
        const embedded = await this.engine.embedTexts(checkable.map((s) => PREFIX.verify(s.clean)));
        let k = 0;
        vectors = flat.map((s) => (s.checkable ? embedded[k++] : null));
      }
      const passageVectors = new Map(passages.map((p) => [p.n, p.vector]));
      judgeSentences(flat, vectors, passageVectors, THRESHOLDS);
      const sum = summarise(flat);
      const cited = new Set(flat.flatMap((s) => s.cited));

      view.renderAnswer(blocks, passages);
      view.markCited(cited);
      view.setCheckLine(
        sum.checked === 0
          ? 'Nothing to check in this answer.'
          : sum.unsupported
            ? `Checked ${sum.checked} sentences against their sources: ${sum.unsupported} not clearly supported by your documents.`
            : `Checked ${sum.checked} sentences against their sources: all clearly supported.${THRESHOLDS.calibrated ? '' : ' (Thresholds are not yet calibrated.)'}`,
      );
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      view.final(`${GENERATORS[this.gen.tier].label} · ${out.tokens} tokens${out.tps ? ` · ${out.tps.toFixed(1)} tok/s` : ''} · ${secs} s`);
      this.emit('stats', { tps: out.tps });
      this.answeredOnce = true;
      setTimeout(() => this.#considerUpgrade(), 1500);

      return { abstained: false, passages, image, best, text, summary: sum, tps: out.tps, generatorCalled: true };
    });
  }

  async #generateWithFallback(messages, onToken, images = null) {
    try {
      return await this.engine.generate({ messages, images, maxNewTokens: GENERATION.maxNewTokens }, onToken);
    } catch (e) {
      if (this.gen.tier === 'e4b') {
        await this.#fallbackToE2B(e.message);
        return this.engine.generate({ messages, images, maxNewTokens: GENERATION.maxNewTokens }, onToken);
      }
      throw e;
    }
  }

  /** Is describing images possible now without a surprise download? */
  async visionStatus() {
    if (this.gen.state === 'ready' && this.gen.vision) return { ready: true, bytes: 0 };
    try {
      const st = await this.engine.generatorStatus(this.gen.tier, true);
      return { ready: st.cached, bytes: st.bytes };
    } catch {
      return { ready: false, bytes: null };
    }
  }

  /** Ask Gemma to describe an image with respect to the question. May need the vision weights. */
  async describeImage(image, question, { confirm = true } = {}) {
    return this.#exclusive(async () => {
      await this.ensureEmbedder();
      await this.#ensureGenerator();
      if (!(this.gen.state === 'ready' && this.gen.vision)) {
        const vs = await this.visionStatus();
        if (!vs.ready && confirm) {
          const ok = await this.confirmVisionDownload({ bytes: vs.bytes });
          if (!ok) throw new ConsentDeclined();
        }
        await this.#loadGenerator(this.gen.tier, { vision: true }).catch(async (e) => {
          // the text model was restored by the worker; keep the app usable
          this.gen = { tier: this.gen.tier, state: 'ready', vision: false };
          this.#modelEvent();
          throw e;
        });
      }
      const out = await this.#generateWithFallback(buildImageMessages(question, image.caption), () => {}, [image.blob]);
      return stripThinking(out.text);
    });
  }

  // ------------------------------------------------------------------------------------------
  // the silent upgrade to E4B
  // ------------------------------------------------------------------------------------------
  async #considerUpgrade() {
    if (this.upgradeStarted || this.gen.tier !== 'e2b' || this.gen.state !== 'ready') return;
    if (!readSetting(this.storage) || readFailure(this.storage)) return;
    if (!this.caps?.webgpu) return;
    this.upgradeStarted = true;
    try {
      const tps = (await this.#exclusive(() => this.engine.warmup(GENERATION.warmupTokens))).tps;
      const e4b = await this.engine.generatorStatus('e4b', false);
      const storage = await navigator.storage?.estimate?.().catch(() => null);
      const decision = decideUpgrade({
        limits: this.caps.limits,
        decodeTps: tps,
        storage: storage ? { quota: storage.quota ?? 0, usage: storage.usage ?? 0 } : null,
        e4bBytes: e4b.cached ? 0 : e4b.bytes,
        connection: navigator.connection ? { saveData: navigator.connection.saveData, effectiveType: navigator.connection.effectiveType } : null,
        settingOn: true,
        previouslyFailed: false,
      });
      this.upgradeInfo = { ...decision, tps, e4bBytes: e4b.bytes };
      this.emit('upgrade', this.upgradeInfo);
      if (!decision.upgrade) return;

      if (!e4b.cached) {
        await this.engine.prefetchGenerator('e4b', (p) => {
          if (p.kind === 'download') this.#modelEvent(` · fetching the larger model ${Math.round((p.loaded / Math.max(1, p.total)) * 100)}%`);
        });
        this.#modelEvent();
      }
      this.e4bReady = true;
      await this.#swapToE4B();
    } catch (e) {
      // An interrupted download is not a failure of the larger model: the next visit resumes it
      // (finished files are skipped). Load failures are recorded by #fallbackToE2B.
      this.#modelEvent();
      this.upgradeInfo = { upgrade: false, reasons: [`upgrade paused: ${e.message}`] };
    }
  }

  async #swapToE4B() {
    // Between questions only: #exclusive waits for any running answer to finish first.
    await this.#exclusive(async () => {
      if (!readSetting(this.storage) || this.gen.tier === 'e4b') return;
      this.#modelEvent(' · switching to the larger model');
      try {
        await this.#loadGenerator('e4b');
        this.#modelEvent();
      } catch (e) {
        await this.#fallbackToE2B(e.message);
      }
    });
  }

  async #fallbackToE2B(reason) {
    writeFailure(reason, this.storage);
    this.e4bReady = false;
    try {
      await this.#loadGenerator('e2b');
    } catch (e) {
      this.notice(`The larger model failed and ${GENERATORS.e2b.label} could not be restored: ${e.message}`);
      return;
    }
    this.#modelEvent();
  }

  /** The browser told us the GPU device was lost. */
  handleDeviceLost(reason, which) {
    if (which === 'gen' && this.gen.tier === 'e4b') {
      this.#fallbackToE2B(`GPU device lost: ${reason}`);
      return;
    }
    this.embedderReady = which === 'embed' ? false : this.embedderReady;
    this.gen = { ...this.gen, state: 'error' };
    this.#modelEvent();
    this.notice('The graphics chip was reset, which stops the models. Reload the page to continue; your documents are safe.');
  }

  /** Called when the user flips the setting. */
  settingChanged(on) {
    if (on) {
      clearFailure(this.storage); // switching it on again is a deliberate request to try once more
      this.upgradeStarted = false;
      if (this.answeredOnce) setTimeout(() => this.#considerUpgrade(), 500);
    } else if (this.gen.tier === 'e4b') {
      this.#exclusive(() => this.#loadGenerator('e2b').then(() => this.#modelEvent())).catch(() => {});
    }
  }
}
