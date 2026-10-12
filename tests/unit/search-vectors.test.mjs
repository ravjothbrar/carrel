import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorIndex, normalise, truncateNormalise, pickImage, dot } from '../../js/search.js';
import { assertGoodVector, startupCheck, planBatches, BadVectorError, STARTUP_TEXTS } from '../../js/vectors.js';
import { fakeEmbed, randomVector } from './helpers.mjs';

test('search ranks lexically related chunks first, with stable ties', () => {
  const texts = ['the speckled band was a snake', 'the cab rattled over cobbles', 'a red headed league advert', 'the snake climbed the bell rope'];
  const index = new VectorIndex(768, texts.map((t, i) => ({ vector: fakeEmbed(t), id: i })));
  const hits = index.search(fakeEmbed('which snake was it'), 3);
  assert.deepEqual(hits.map((h) => h.row.id).slice(0, 2).sort(), [0, 3]);
  assert.equal(hits[0].rank, 1);
  assert.ok(hits[0].score >= hits[1].score);
});

test('truncateNormalise re-normalises', () => {
  const v = randomVector(1024, 7);
  const t = truncateNormalise(v, 768);
  assert.equal(t.length, 768);
  assert.ok(Math.abs(dot(t, t) - 1) < 1e-5);
});

test('dimension mismatch is an error, not a silent wrong answer', () => {
  const index = new VectorIndex(4, [{ vector: new Float32Array([1, 0, 0, 0]) }]);
  assert.throws(() => index.scores(new Float32Array(3)), /dimensions/);
  assert.throws(() => new VectorIndex(4, [{ vector: new Float32Array(3) }]), /dimensions/);
});

test('assertGoodVector rejects NaN, all zeros, wrong size, wrong type and non-unit vectors', () => {
  const good = randomVector(768, 1);
  assertGoodVector(good, 768);
  const nan = good.slice(); nan[10] = NaN;
  assert.throws(() => assertGoodVector(nan, 768), BadVectorError);
  assert.throws(() => assertGoodVector(new Float32Array(768), 768), /all zeros/);
  assert.throws(() => assertGoodVector(good, 512), /dimensions/);
  assert.throws(() => assertGoodVector(Array.from(good), 768), /Float32Array/);
  assert.throws(() => assertGoodVector(good.map((x) => x * 3), 768), /unit length/);
});

test('startupCheck passes for sensible vectors and fails for broken ones', () => {
  const [a, b, c] = STARTUP_TEXTS.map((t) => fakeEmbed(t.replace('investigator', 'detective').replace('marks', 'footprints')));
  // lexical stand-in: make B related to A by sharing words
  const a2 = fakeEmbed('detective footprints window'), b2 = fakeEmbed('detective footprints glass'), c2 = fakeEmbed('quarterly tax filings');
  assert.ok(startupCheck([a2, b2, c2], 768).related > startupCheck([a2, b2, c2], 768).unrelated);
  assert.throws(() => startupCheck([a2, a2, a2], 768), /identical/);
  assert.throws(() => startupCheck([a2, c2, b2], 768), /sanity check failed/);
  const nan = a2.slice(); nan[0] = NaN;
  assert.throws(() => startupCheck([nan, b2, c2], 768), /NaN/);
});

test('planBatches respects the token budget and covers every item once', () => {
  const lengths = [350, 300, 120, 340, 50, 330, 310, 20, 345];
  const batches = planBatches(lengths, 2700);
  const seen = batches.flat().sort((x, y) => x - y);
  assert.deepEqual(seen, lengths.map((_, i) => i));
  for (const b of batches) {
    const longest = Math.max(...b.map((i) => lengths[i]));
    assert.ok(longest * b.length <= 2700, `batch over budget: ${longest} x ${b.length}`);
  }
  assert.deepEqual(planBatches([3000], 2700), [[0]]); // oversize item still gets its own batch
});

test('pickImage uses a floor and a margin, never an absolute text-style threshold', () => {
  const mk = (vecs) => new VectorIndex(2, vecs.map((v, i) => ({ vector: normalise(new Float32Array(v)), id: i })));
  const q = normalise(new Float32Array([1, 0]));
  const cfg = { imageMin: 0.12, imageMargin: 0.04 };
  assert.equal(pickImage(mk([]), q, cfg).show, false);
  assert.equal(pickImage(mk([[1, 0.2]]), q, cfg).show, true, 'single image: floor decides');
  assert.equal(pickImage(mk([[0.05, 1]]), q, cfg).show, false, 'below the floor');
  assert.equal(pickImage(mk([[1, 1], [1, 1.01], [1, 1.02]]), q, cfg).show, false, 'does not stand out');
  const win = pickImage(mk([[1, 0.2], [0.1, 1], [0.05, 1]]), q, cfg);
  assert.equal(win.show, true);
  assert.equal(win.hit.row.id, 0);
});

import { pickEmbedding, rowsOf } from '../../js/embed-output.js';
import { halfToFloat, toFloat32Array } from '../../js/vectors.js';

test('pickEmbedding finds the sentence embedding and refuses to guess otherwise', () => {
  const t = { data: new Float32Array(4), dims: [1, 4], type: 'float32' };
  assert.equal(pickEmbedding({ last_hidden_state: {}, sentence_embedding: t }), t);
  assert.throws(() => pickEmbedding({ last_hidden_state: t }), /will not guess a pooling step/);
});

test('rowsOf truncates wider outputs, re-normalises, and rejects narrower ones', () => {
  const wide = new Float32Array(2 * 1024).map((_, i) => ((i * 7) % 13) - 6);
  const rows = rowsOf({ data: wide, dims: [2, 1024], type: 'float32' }, 768);
  assert.equal(rows.length, 2);
  for (const r of rows) { assert.equal(r.length, 768); assert.ok(Math.abs(dot(r, r) - 1) < 1e-5); }
  assert.throws(() => rowsOf({ data: new Float32Array(512), dims: [1, 512], type: 'float32' }, 768), /needs at least 768/);
});

test('float16 outputs are decoded correctly', () => {
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xc000), -2);
  assert.equal(halfToFloat(0x3555), 0.333251953125);
  assert.ok(Number.isNaN(halfToFloat(0x7e00)));
  assert.equal(halfToFloat(0x7c00), Infinity);
  const f = toFloat32Array(new Uint16Array([0x3c00, 0x4000, 0xbc00]), 'float16');
  assert.deepEqual(Array.from(f), [1, 2, -1]);
  assert.equal(toFloat32Array(new Float32Array([1])).length, 1);
});
