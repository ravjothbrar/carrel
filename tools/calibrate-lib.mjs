// Statistics for threshold calibration. Pure functions, unit-tested; the data run needs a GPU.

export function summarise(values) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  return { n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: v[v.length - 1] };
}

/** Probability that a random positive scores above a random negative (ties count half). 1 = perfectly separable. */
export function auc(pos, neg) {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/**
 * Choose the cut-off that best separates positives (should be >= threshold) from negatives (should be below),
 * maximising balanced accuracy. Candidate cut-offs are midpoints between neighbouring observed scores.
 */
export function bestThreshold(pos, neg) {
  const all = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  const candidates = all.length > 1 ? all.slice(1).map((x, i) => (x + all[i]) / 2) : [all[0]];
  let best = null;
  for (const t of candidates) {
    const tpr = pos.filter((x) => x >= t).length / pos.length;
    const tnr = neg.filter((x) => x < t).length / neg.length;
    const balanced = (tpr + tnr) / 2;
    if (!best || balanced > best.balanced + 1e-12) best = { threshold: t, balanced, tpr, tnr };
  }
  return best;
}

/** Rank-1 accuracy: how often the best-scoring candidate is the correct one. `rows` = [{scores: number[], correct: index}] */
export function rank1(rows) {
  return rows.filter((r) => r.scores.indexOf(Math.max(...r.scores)) === r.correct).length / rows.length;
}

export function round(x, d = 2) {
  return Math.round(x * 10 ** d) / 10 ** d;
}
