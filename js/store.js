// IndexedDB storage: documents, chunks (with vectors), images (with thumbnails and vectors), and
// a small key/value table. Nothing here ever leaves the device.
//
// Each chunk and image records the embedding setup it was made with (`embedKey`). Rows made with a
// different setup are kept but never searched, so a future model change cannot silently mix spaces.

const DB_NAME = 'carrel';
const DB_VERSION = 1;

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted.'));
  });
}

export class Store {
  /** @param {IDBFactory} [idb] injectable for tests */
  constructor(idb = globalThis.indexedDB, name = DB_NAME) {
    this.idb = idb;
    this.name = name;
    this.db = null;
  }

  async open() {
    if (this.db) return this;
    this.db = await new Promise((resolve, reject) => {
      const req = this.idb.open(this.name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
        const chunks = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        chunks.createIndex('doc', 'docId');
        db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('The carrel database is open in another tab. Close it and reload.'));
    });
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  /** @returns {Promise<number>} new document id */
  async addDoc({ name, title = '', kind, sample = false, pages = null }) {
    const tx = this.db.transaction('docs', 'readwrite');
    const id = await wrap(tx.objectStore('docs').add({ name, title, kind, sample, pages, addedAt: Date.now() }));
    await done(tx);
    return id;
  }

  /** Add all chunks for a document in one transaction (all or nothing). */
  async addChunks(docId, rows) {
    const tx = this.db.transaction(['chunks', 'docs'], 'readwrite');
    const store = tx.objectStore('chunks');
    for (const r of rows) {
      store.add({ docId, text: r.text, loc: r.loc, vector: r.vector, embedKey: r.embedKey });
    }
    const docs = tx.objectStore('docs');
    const doc = await wrap(docs.get(docId));
    if (doc) docs.put({ ...doc, chunkCount: rows.length });
    await done(tx);
  }

  async addImage({ name, caption, source, blob, mime, vector, embedKey, sample = false }) {
    const tx = this.db.transaction('images', 'readwrite');
    const id = await wrap(tx.objectStore('images').add({ name, caption, source, blob, mime, vector, embedKey, sample, addedAt: Date.now() }));
    await done(tx);
    return id;
  }

  async updateImageCaption(id, caption) {
    const tx = this.db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    const row = await wrap(store.get(id));
    if (row) store.put({ ...row, caption });
    await done(tx);
  }

  /** Everything, for building the in-memory search indexes. */
  async loadAll() {
    const tx = this.db.transaction(['docs', 'chunks', 'images'], 'readonly');
    const [docs, chunks, images] = await Promise.all([
      wrap(tx.objectStore('docs').getAll()),
      wrap(tx.objectStore('chunks').getAll()),
      wrap(tx.objectStore('images').getAll()),
    ]);
    return { docs, chunks, images };
  }

  async removeDoc(docId) {
    const tx = this.db.transaction(['docs', 'chunks'], 'readwrite');
    tx.objectStore('docs').delete(docId);
    const idx = tx.objectStore('chunks').index('doc');
    const keys = await wrap(idx.getAllKeys(docId));
    for (const k of keys) tx.objectStore('chunks').delete(k);
    await done(tx);
  }

  async removeImage(id) {
    const tx = this.db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    await done(tx);
  }

  /** One-click removal of the sample pack: every doc, chunk and image flagged as sample. */
  async removeSample() {
    const { docs, images } = await this.loadAll();
    for (const d of docs) if (d.sample) await this.removeDoc(d.id);
    for (const im of images) if (im.sample) await this.removeImage(im.id);
  }

  async clearAll() {
    const tx = this.db.transaction(['docs', 'chunks', 'images', 'meta'], 'readwrite');
    for (const n of ['docs', 'chunks', 'images', 'meta']) tx.objectStore(n).clear();
    await done(tx);
  }

  async getMeta(key, fallback = null) {
    const row = await wrap(this.db.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : fallback;
  }

  async setMeta(key, value) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await done(tx);
  }
}
