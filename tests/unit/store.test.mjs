import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { Store } from '../../js/store.js';
import { embedKey } from '../../js/config.js';
import { fakeEmbed } from './helpers.mjs';

async function fresh() {
  return new Store(new IDBFactory()).open();
}

test('documents, chunks and images are stored and loaded back with their vectors', async () => {
  const s = await fresh();
  const d = await s.addDoc({ name: 'a.txt', title: 'a', kind: 'text' });
  const v = fakeEmbed('hello world');
  await s.addChunks(d, [{ text: 'hello world', loc: '§1', vector: v, embedKey: embedKey() }]);
  await s.addImage({ name: 'x.jpg', caption: 'cap', source: 'me', blob: new Blob(['x'], { type: 'image/jpeg' }), mime: 'image/jpeg', vector: v, embedKey: embedKey() });
  const all = await s.loadAll();
  assert.equal(all.docs.length, 1);
  assert.equal(all.docs[0].chunkCount, 1);
  assert.equal(all.chunks.length, 1);
  assert.equal(all.chunks[0].embedKey, embedKey());
  assert.ok(all.chunks[0].vector instanceof Float32Array);
  assert.deepEqual(Array.from(all.chunks[0].vector), Array.from(v));
  assert.equal(all.images[0].caption, 'cap');
  await s.updateImageCaption(all.images[0].id, 'new caption');
  assert.equal((await s.loadAll()).images[0].caption, 'new caption');
});

test('removing a document removes its chunks and nothing else', async () => {
  const s = await fresh();
  const a = await s.addDoc({ name: 'a', kind: 'text' });
  const b = await s.addDoc({ name: 'b', kind: 'text' });
  const row = (t) => ({ text: t, loc: '§1', vector: fakeEmbed(t), embedKey: embedKey() });
  await s.addChunks(a, [row('one'), row('two')]);
  await s.addChunks(b, [row('three')]);
  await s.removeDoc(a);
  const all = await s.loadAll();
  assert.deepEqual(all.docs.map((d) => d.name), ['b']);
  assert.deepEqual(all.chunks.map((c) => c.text), ['three']);
});

test('removeSample removes only sample rows (one click)', async () => {
  const s = await fresh();
  const mine = await s.addDoc({ name: 'mine', kind: 'text' });
  const sample = await s.addDoc({ name: 'sherlock', kind: 'text', sample: true });
  const row = (t) => ({ text: t, loc: '§1', vector: fakeEmbed(t), embedKey: embedKey() });
  await s.addChunks(mine, [row('mine')]);
  await s.addChunks(sample, [row('sample 1'), row('sample 2')]);
  await s.addImage({ name: 's.jpg', caption: '', source: '', blob: new Blob(['x']), mime: 'image/jpeg', vector: fakeEmbed('s'), embedKey: embedKey(), sample: true });
  await s.addImage({ name: 'm.jpg', caption: '', source: '', blob: new Blob(['x']), mime: 'image/jpeg', vector: fakeEmbed('m'), embedKey: embedKey() });
  await s.removeSample();
  const all = await s.loadAll();
  assert.deepEqual(all.docs.map((d) => d.name), ['mine']);
  assert.deepEqual(all.chunks.map((c) => c.text), ['mine']);
  assert.deepEqual(all.images.map((i) => i.name), ['m.jpg']);
});

test('clearAll empties everything including meta', async () => {
  const s = await fresh();
  await s.setMeta('k', 1);
  await s.addDoc({ name: 'a', kind: 'text' });
  await s.clearAll();
  const all = await s.loadAll();
  assert.equal(all.docs.length + all.chunks.length + all.images.length, 0);
  assert.equal(await s.getMeta('k', 'none'), 'none');
});

test('meta round-trips', async () => {
  const s = await fresh();
  await s.setMeta('embedCheck', { ok: true });
  assert.deepEqual(await s.getMeta('embedCheck'), { ok: true });
});
