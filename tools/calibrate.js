// Calibrates the three score thresholds on a small labelled set, using the same prefixes and the
// same engine as the app:
//   abstain   best text-to-text score of a question against the passages (answerable vs not)
//   support   score of an answer sentence against its passage (supported vs not)
//   image     text-to-image scores, by rank, for the three original sample drawings
import { createEngine } from '../js/engine-client.js';
import { PREFIX, THRESHOLDS } from '../js/config.js';
import { dot } from '../js/search.js';
import { auc, bestThreshold, rank1, round, summarise } from './calibrate-lib.mjs';
import { downscaleToJpeg } from '../js/image.js';

const $ = (s) => document.querySelector(s);
const log = (m) => { $('#log').textContent += `${m}\n`; };
const fmt = (s) => `n=${s.n} min ${round(s.min)} p25 ${round(s.p25)} median ${round(s.median)} p75 ${round(s.p75)} max ${round(s.max)}`;

async function run() {
  $('#run').disabled = true;
  $('#log').textContent = '';
  const set = await (await fetch('calibration-set.json')).json();
  const engine = createEngine();
  log('loading the embedding model (downloads it the first time)…');
  await engine.loadEmbedder();

  const passages = set.passages;
  const pv = await engine.embedTexts(passages.map((p) => PREFIX.doc(p.title, p.text)));
  const pById = new Map(passages.map((p, i) => [p.id, pv[i]]));

  // ---- abstention: best score over ALL passages for each question
  const bestFor = async (qs) => (await engine.embedTexts(qs.map((q) => PREFIX.query(q)))).map((qv) => Math.max(...pv.map((v) => dot(qv, v))));
  const answerable = await bestFor(set.answerable.map((a) => a.q));
  const near = await bestFor(set.unanswerable_near);
  const far = await bestFor(set.unanswerable_far);
  const absent = [...near, ...far];
  const abstain = bestThreshold(answerable, absent);
  log(`\nABSTENTION (best score over all passages)\n  answerable   ${fmt(summarise(answerable))}\n  near-topic   ${fmt(summarise(near))}\n  far-topic    ${fmt(summarise(far))}\n  AUC ${round(auc(answerable, absent), 3)}; best cut-off ${round(abstain.threshold, 3)} (answerable kept ${round(abstain.tpr * 100, 0)}%, absent rejected ${round(abstain.tnr * 100, 0)}%)`);
  const abstainNearOnly = bestThreshold(answerable, near);
  log(`  near-topic only: AUC ${round(auc(answerable, near), 3)}, cut-off ${round(abstainNearOnly.threshold, 3)} (the harder case: related but unanswered)`);

  // ---- support: sentence against its own passage, using the verify prefix
  const sup = await engine.embedTexts(set.supported.map((c) => PREFIX.verify(c.claim)));
  const uns = await engine.embedTexts(set.unsupported.map((c) => PREFIX.verify(c.claim)));
  const supScores = sup.map((v, i) => dot(v, pById.get(set.supported[i].p)));
  const unsScores = uns.map((v, i) => dot(v, pById.get(set.unsupported[i].p)));
  const support = bestThreshold(supScores, unsScores);
  log(`\nSUPPORT (claim vs the passage it cites, prefix "${PREFIX.verify('…')}")\n  supported    ${fmt(summarise(supScores))}\n  unsupported  ${fmt(summarise(unsScores))}\n  AUC ${round(auc(supScores, unsScores), 3)}; best cut-off ${round(support.threshold, 3)} (supported kept ${round(support.tpr * 100, 0)}%, unsupported flagged ${round(support.tnr * 100, 0)}%)`);

  // ---- images: scores by rank for the original drawings (skipped, not fatal, if they cannot be embedded)
  let imageMin = THRESHOLDS.imageMin;
  let imageMargin = THRESHOLDS.imageMargin;
  let imageNote = `images NOT calibrated, placeholders kept`;
  try {
    const imgs = [];
    for (const name of [...new Set(set.images.queries.map((q) => q.image))]) {
      const svg = await (await fetch(`../sample/images/${name}`)).text();
      const { blob } = await downscaleToJpeg(new File([svg], name, { type: 'image/svg+xml' }));
      imgs.push({ name, vec: (await engine.embedImages([blob]))[0] });
    }
    const qv = await engine.embedTexts(set.images.queries.map((q) => PREFIX.query(q.q)));
    const rows = set.images.queries.map((q, i) => ({ scores: imgs.map((im) => dot(qv[i], im.vec)), correct: imgs.findIndex((im) => im.name === q.image) }));
    const matched = rows.map((r) => r.scores[r.correct]);
    const unmatched = rows.flatMap((r) => r.scores.filter((_, i) => i !== r.correct));
    const gaps = rows.map((r) => r.scores[r.correct] - [...r.scores].sort((a, b) => a - b)[Math.floor(r.scores.length / 2)]);
    log(`\nIMAGES (text query vs image, only ${imgs.length} images: indicative, not a calibration)\n  rank-1 accuracy ${round(rank1(rows) * 100, 0)}%\n  matching pairs   ${fmt(summarise(matched))}\n  other pairs      ${fmt(summarise(unmatched))}\n  gap of the right image above the median image: ${fmt(summarise(gaps))}`);
    imageMin = Math.min(...matched) > Math.max(...unmatched) ? (Math.min(...matched) + Math.max(...unmatched)) / 2 : bestThreshold(matched, unmatched).threshold;
    imageMargin = Math.max(0.01, summarise(gaps).p25 * 0.5);
    imageNote = `${imgs.length} images, indicative only`;
  } catch (e) {
    log(`\nIMAGES skipped: ${e.message}`);
  }

  const block = `export const THRESHOLDS = Object.freeze({
  // Calibrated ${new Date().toISOString().slice(0, 10)} with tools/calibrate.html on tools/calibration-set.json
  // (${answerable.length} answerable and ${absent.length} unanswerable questions, ${supScores.length} supported and ${unsScores.length} unsupported claims,
  // ${imageNote}). Abstain: AUC ${round(auc(answerable, absent), 3)}. Support: AUC ${round(auc(supScores, unsScores), 3)}. Small set: treat as a starting point.
  calibrated: true,
  abstain: ${round(abstain.threshold, 2)},
  support: ${round(support.threshold, 2)},
  imageMin: ${round(imageMin, 2)},
  imageMargin: ${round(imageMargin, 2)},
});

// previous (uncalibrated) values were: abstain ${THRESHOLDS.abstain}, support ${THRESHOLDS.support}, imageMin ${THRESHOLDS.imageMin}, imageMargin ${THRESHOLDS.imageMargin}
`;
  $('#result').value = block;
  $('#run').disabled = false;
}

$('#run').addEventListener('click', () => run().catch((e) => { log(`ERROR: ${e.stack ?? e.message}`); $('#run').disabled = false; }));
