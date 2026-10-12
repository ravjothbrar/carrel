// Sentence-aware chunking: about 250 to 350 tokens per chunk, about 15 percent overlap.

import { CHUNK } from './config.js';
import { cleanText, estimateTokens, splitLong, splitSentences } from './text.js';

/**
 * @param {{page: number|null, text: string}[]} segments  one per PDF page, or one for a whole text file
 * @returns {{text: string, tokens: number, page: number|null, pageEnd: number|null}[]}
 */
export function chunkSegments(segments, opts = {}) {
  const { targetTokens, maxTokens, overlapRatio } = { ...CHUNK, ...opts };

  // 1. Flatten to sentences, remembering the page each came from.
  const sentences = [];
  for (const seg of segments) {
    for (const s of splitSentences(cleanText(seg.text))) {
      for (const piece of splitLong(s.text, maxTokens - 2)) {
        sentences.push({ text: piece, tokens: estimateTokens(piece) + 1, page: seg.page ?? null });
      }
    }
  }

  // 2. Greedy fill to the target, never past the maximum; step back for overlap.
  const chunks = [];
  const overlapTarget = Math.round(targetTokens * overlapRatio);
  let i = 0;
  while (i < sentences.length) {
    let j = i;
    let tokens = 0;
    while (j < sentences.length && tokens < targetTokens && tokens + sentences[j].tokens <= maxTokens) {
      tokens += sentences[j].tokens;
      j++;
    }
    if (j === i) j = i + 1; // a single sentence is never dropped
    const slice = sentences.slice(i, j);
    const pages = slice.map((s) => s.page).filter((p) => p !== null);
    chunks.push({
      text: slice.map((s) => s.text).join(' '),
      tokens: slice.reduce((n, s) => n + s.tokens, 0),
      page: pages.length ? pages[0] : null,
      pageEnd: pages.length ? pages[pages.length - 1] : null,
    });
    if (j >= sentences.length) break;

    // Overlap: restart from the last few sentences, about overlapRatio of a chunk, but always advance.
    let k = j;
    let carried = 0;
    while (k > i + 1 && carried < overlapTarget) {
      k--;
      carried += sentences[k].tokens;
    }
    i = Math.max(k, i + 1);
  }
  return chunks;
}

/** A short human label for where a chunk came from: "p. 3", "pp. 3 to 4" or a section number. */
export function locLabel(chunk, index) {
  if (chunk.page !== null && chunk.page !== undefined) {
    return chunk.pageEnd && chunk.pageEnd !== chunk.page ? `pp. ${chunk.page}–${chunk.pageEnd}` : `p. ${chunk.page}`;
  }
  return `§${index + 1}`;
}
