import test from 'node:test';
import assert from 'node:assert/strict';
import { auc, bestThreshold, rank1, summarise } from '../../tools/calibrate-lib.mjs';

test('auc is 1 for separable data, 0.5 for identical, 0 for inverted', () => {
  assert.equal(auc([0.6, 0.7], [0.1, 0.2]), 1);
  assert.equal(auc([0.5], [0.5]), 0.5);
  assert.equal(auc([0.1], [0.9]), 0);
});

test('bestThreshold separates clean data exactly and lands between the classes', () => {
  const r = bestThreshold([0.5, 0.6, 0.7], [0.1, 0.2, 0.3]);
  assert.equal(r.balanced, 1);
  assert.ok(r.threshold > 0.3 && r.threshold <= 0.5);
});

test('bestThreshold copes with overlap and picks the best balanced split', () => {
  const pos = [0.4, 0.5, 0.6, 0.7, 0.35];
  const neg = [0.1, 0.2, 0.3, 0.38, 0.45];
  const r = bestThreshold(pos, neg);
  assert.ok(r.balanced >= 0.8 && r.balanced < 1, JSON.stringify(r));
  assert.ok(r.threshold > 0.3 && r.threshold < 0.5);
});

test('summarise and rank1', () => {
  assert.deepEqual(summarise([3, 1, 2, 5, 4]), { n: 5, min: 1, p25: 2, median: 3, p75: 4, max: 5 });
  assert.equal(rank1([{ scores: [0.1, 0.9], correct: 1 }, { scores: [0.8, 0.2], correct: 1 }]), 0.5);
});
