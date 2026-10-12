// Citation checking. Split a finished answer into sentences, then (given an embedding of each
// sentence) compare it with the passages it cites. Anything below the support threshold is marked
// "not clearly supported by your documents". This is a similarity check, not proof: it can miss a
// wrong claim that happens to sound like its source, and it can flag a correct paraphrase.

import { dot } from './search.js';
import { extractCitations, saysAnswerAbsent } from './prompt.js';
import { splitSentences } from './text.js';

/**
 * Break answer text into display blocks and sentences ready for checking.
 * Markdown is reduced to structure only: paragraphs and list items. It is never turned into HTML here.
 * @returns {{blocks: {type: 'p'|'li', sentences: object[]}[], flat: object[]}}
 */
export function analyseAnswer(answerText, passageCount) {
  const blocks = [];
  const flat = [];
  const lines = answerText.replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) addBlock('p', paragraph.join(' '));
    paragraph = [];
  };
  const addBlock = (type, text) => {
    const sentences = [];
    for (const s of splitSentences(text)) {
      const { clean, cited } = extractCitations(s.text);
      const valid = cited.filter((n) => n >= 1 && n <= passageCount);
      const invalid = cited.filter((n) => n < 1 || n > passageCount);
      const words = clean.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).length;
      const sentence = {
        raw: s.text,
        clean,
        cited: valid,
        invalidCited: invalid,
        checkable: words >= 4 && !saysAnswerAbsent(clean),
        status: 'skipped', // supported | unsupported | skipped
        score: null,
        best: null,
      };
      sentences.push(sentence);
      flat.push(sentence);
    }
    if (sentences.length) blocks.push({ type, sentences });
  };
  for (const line of lines) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      addBlock('li', bullet[1]);
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.replace(/^\s*#{1,6}\s+/, '').trim());
    }
  }
  flush();
  return { blocks, flat };
}

/**
 * Fill in status/score/best for each checkable sentence.
 * @param {object[]} flat           sentences from analyseAnswer
 * @param {Float32Array[]} vectors  one embedding per entry in `flat` (ignored where not checkable)
 * @param {Map<number, Float32Array>} passageVectors  passage number (1-based) to its stored vector
 * @param {{support: number}} thresholds
 */
export function judgeSentences(flat, vectors, passageVectors, thresholds) {
  flat.forEach((s, i) => {
    if (!s.checkable) return;
    // A sentence with no valid citation is compared with every retrieved passage.
    const candidates = s.cited.length ? s.cited : [...passageVectors.keys()];
    let best = -Infinity;
    let bestN = null;
    for (const n of candidates) {
      const pv = passageVectors.get(n);
      if (!pv) continue;
      const score = dot(vectors[i], pv);
      if (score > best) {
        best = score;
        bestN = n;
      }
    }
    s.score = Number.isFinite(best) ? best : null;
    s.best = bestN;
    s.status = s.score !== null && s.score >= thresholds.support ? 'supported' : 'unsupported';
  });
  return flat;
}

export function summarise(flat) {
  const checked = flat.filter((s) => s.checkable);
  return {
    checked: checked.length,
    unsupported: checked.filter((s) => s.status === 'unsupported').length,
    uncited: checked.filter((s) => s.cited.length === 0).length,
    badCitations: flat.filter((s) => s.invalidCited.length).length,
  };
}
