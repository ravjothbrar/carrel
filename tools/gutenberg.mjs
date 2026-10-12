// Turn a Project Gutenberg plain-text file into clean story text. Pure functions, unit-tested.
// The result carries no Gutenberg header, footer, licence boilerplate or trademark; the source is
// recorded in the pack metadata instead.

const START = /^\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*{3}\s*$/im;
const END = /^\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*{3}\s*$/im;

export function stripGutenberg(raw) {
  const text = raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const s = START.exec(text);
  const e = END.exec(text);
  if (!s || !e || e.index <= s.index) {
    throw new Error('Could not find the start and end markers of the file, so the header and footer cannot be removed safely.');
  }
  const body = text.slice(s.index + s[0].length, e.index).trim();
  if (/project gutenberg/i.test(body.slice(0, 2000)) && /(?:license|licence|trademark)/i.test(body.slice(0, 2000))) {
    throw new Error('Gutenberg boilerplate is still present after the start marker; refusing to continue.');
  }
  return body;
}

const ROMAN = '[IVXL]+';
// "ADVENTURE I. A SCANDAL IN BOHEMIA" or "I. A SCANDAL IN BOHEMIA": an UPPERCASE title after a Roman numeral.
// The table of contents lists the same titles in mixed case, so requiring uppercase skips it.
const HEADING = new RegExp(`^(?:ADVENTURE\\s+)?(${ROMAN})\\.\\s+([A-Z][A-Z'’,;:!? -]{6,}?)\\s*$`, 'gm');

/** @returns {{numeral: string, title: string, text: string}[]} */
export function splitStories(body) {
  const heads = [...body.matchAll(HEADING)];
  return heads.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    return { numeral: m[1], title: toTitle(m[2]), text: body.slice(start, end).trim() };
  });
}

export function toTitle(upper) {
  const small = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'and', 'or', 'to']);
  return upper
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

/**
 * Pick the wanted stories by title. Throws if any is missing or implausibly short, so a changed
 * file layout cannot silently produce a bad sample.
 */
export function pickStories(stories, wanted, { minWords = 2500 } = {}) {
  return wanted.map((want) => {
    const hit = stories.find((s) => s.title.toLowerCase().includes(want.toLowerCase()));
    if (!hit) throw new Error(`Story not found: "${want}". Found: ${stories.map((s) => s.title).join('; ')}`);
    const words = hit.text.split(/\s+/).length;
    if (words < minWords) throw new Error(`"${hit.title}" has only ${words} words; the file layout is probably not what this script expects.`);
    return hit;
  });
}
