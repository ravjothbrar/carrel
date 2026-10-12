import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePack, decodePack, checkCompat, PackError, PACK_FORMAT } from '../../js/pack.js';
import { VectorIndex } from '../../js/search.js';
import { EMBED } from '../../js/config.js';
import { fakeEmbed } from './helpers.mjs';

const EXPECTED = { model: EMBED.id, dtype: EMBED.dtypeLabel, dim: EMBED.dim, prefixScheme: EMBED.prefixScheme };

const DOCS = [
  { id: 'd1', name: 'adventure.txt', title: 'adventure', kind: 'text' },
  { id: 'd2', name: 'notes.pdf', title: 'notes', kind: 'pdf' },
];
const TEXTS = [
  ['d1', 'The speckled band was a swamp adder that climbed the bell rope.', '§1'],
  ['d1', 'A hansom cab waited outside Baker Street in the fog.', '§2'],
  ['d2', 'Quarterly tax filings are due at the end of the month.', 'p. 3'],
  ['d2', 'The red headed league paid four pounds a week for copying.', 'p. 4'],
];

function sampleInput() {
  return {
    meta: { name: 'test', sample: false },
    embedding: EXPECTED,
    docs: DOCS,
    chunks: TEXTS.map(([doc, text, loc]) => ({ doc, text, loc, vector: fakeEmbed(text) })),
    images: [
      { name: 'cab.jpg', caption: 'A cab at night', source: 'own work', mime: 'image/jpeg', bytes: new Uint8Array([255, 216, 255, 1, 2, 3]), vector: fakeEmbed('cab night') },
      { name: 'snake.png', caption: 'A snake', source: 'own work', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 9, 9, 9, 9, 9]), vector: fakeEmbed('snake') },
    ],
  };
}

test('export then import round-trips data and gives IDENTICAL search results', async () => {
  const input = sampleInput();
  const gz = await encodePack(input);
  assert.equal(gz[0], 0x1f); assert.equal(gz[1], 0x8b); // gzip magic
  const out = await decodePack(gz, EXPECTED);

  assert.equal(out.header.format, PACK_FORMAT);
  assert.deepEqual(out.chunks.map((c) => [c.text, c.loc]), input.chunks.map((c) => [c.text, c.loc]));
  assert.deepEqual(out.images.map((i) => [i.name, i.caption, i.source, i.mime, Array.from(i.bytes)]), input.images.map((i) => [i.name, i.caption, i.source, i.mime, Array.from(i.bytes)]));

  const before = new VectorIndex(768, input.chunks);
  const after = new VectorIndex(768, out.chunks);
  for (const q of ['which snake climbed the rope', 'tax deadline', 'cab in the fog', 'league copying pay', 'unrelated zebra']) {
    const a = before.search(fakeEmbed(`task: search result | query: ${q}`), 4).map((h) => [h.index, h.score]);
    const b = after.search(fakeEmbed(`task: search result | query: ${q}`), 4).map((h) => [h.index, h.score]);
    assert.deepEqual(b, a, `search results differ for "${q}"`); // exact equality, including float scores
  }
  // vectors are bit-identical
  out.chunks.forEach((c, i) => assert.deepEqual(Array.from(c.vector), Array.from(input.chunks[i].vector)));
  out.images.forEach((im, i) => assert.deepEqual(Array.from(im.vector), Array.from(input.images[i].vector)));
});

test('a pack with no images or no chunks still round-trips', async () => {
  const a = sampleInput(); a.images = [];
  assert.equal((await decodePack(await encodePack(a), EXPECTED)).images.length, 0);
  const b = sampleInput(); b.chunks = []; b.docs = [];
  assert.equal((await decodePack(await encodePack(b), EXPECTED)).images.length, 2);
});

test('incompatible embedding setups are refused with a clear message', async () => {
  const gz = await encodePack(sampleInput());
  for (const [field, value, mention] of [
    ['model', 'someone/other-model', 'model'],
    ['dtype', 'fp16', 'precision'],
    ['dim', 128, '128 dimensions'],
    ['prefixScheme', 'other/v9', 'prefix scheme'],
  ]) {
    await assert.rejects(decodePack(gz, { ...EXPECTED, [field]: value }), (e) => {
      assert.ok(e instanceof PackError);
      assert.match(e.message, /different embedding setup/);
      assert.match(e.message, /Mixing them would return wrong results/);
      assert.ok(e.message.includes(mention), e.message);
      return true;
    });
  }
  assert.equal(checkCompat({ format: 99, embedding: EXPECTED }, EXPECTED).ok, false);
  assert.equal(checkCompat({ format: 1, embedding: EXPECTED }, EXPECTED).ok, true);
});

test('garbage, truncated and tampered packs are rejected, not half-imported', async () => {
  await assert.rejects(decodePack(new TextEncoder().encode('hello'), EXPECTED), PackError);
  const gz = await encodePack(sampleInput());
  await assert.rejects(decodePack(gz.slice(0, gz.length - 40), EXPECTED), PackError);

  // valid gzip, wrong magic
  const bad = new Uint8Array(100).fill(7);
  const stream = new Blob([bad]).stream().pipeThrough(new CompressionStream('gzip'));
  await assert.rejects(decodePack(new Uint8Array(await new Response(stream).arrayBuffer()), EXPECTED), /wrong signature/);
});

test('NaN vectors inside a pack are rejected on import', async () => {
  const input = sampleInput();
  input.chunks[1].vector = input.chunks[1].vector.slice();
  input.chunks[1].vector[5] = NaN;
  await assert.rejects(decodePack(await encodePack(input), EXPECTED), /invalid vector/);
});

test('a decompression bomb is stopped by the size cap', async () => {
  const gz = await encodePack(sampleInput());
  await assert.rejects(decodePack(gz, EXPECTED, { maxBytes: 1000 }), /more data than carrel will load/);
  // and the same pack loads fine under the real cap
  assert.equal((await decodePack(gz, EXPECTED)).chunks.length, 4);
});
