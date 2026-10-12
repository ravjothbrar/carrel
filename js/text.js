// Text helpers shared by chunking, answer checking and the UI. Pure functions, no DOM.

/** Rough token count without a tokenizer: about 4 ASCII characters per token, 1 per other char. */
export function estimateTokens(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) < 128 ? 0.25 : 0.9;
  return Math.ceil(n);
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'sr', 'jr', 'vs', 'etc', 'mt', 'col', 'capt', 'gen', 'lt',
  'rev', 'hon', 'no', 'fig', 'cf', 'inc', 'ltd', 'co', 'sgt', 'cpl', 'maj', 'cmdr', 'gov', 'sen',
  'u.s', 'e.g', 'i.e', 'a.m', 'p.m',
]);

// Terminator, optional closing quotes/brackets, whitespace, then something that can open a sentence.
const BOUNDARY = /([.!?…]+["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])/g;

function endsWithAbbreviation(head) {
  // Only a lone full stop can belong to an abbreviation or an initial.
  const m = /(?:^|[\s("'“‘])([A-Za-z](?:[A-Za-z.]*[A-Za-z])?)\.$/.exec(head);
  if (!m) return false;
  const word = m[1];
  if (/^[A-Z]$/.test(word)) return true; // initial, as in "J. Watson"
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Split text into sentences. Paragraph breaks (blank lines) always end a sentence; single newlines
 * inside a paragraph are treated as hard wrapping and joined.
 * @returns {{text: string, para: number}[]}
 */
export function splitSentences(text) {
  const out = [];
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/);
  let paraIndex = 0;
  for (const raw of paragraphs) {
    const para = raw.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (!para) continue;
    let start = 0;
    BOUNDARY.lastIndex = 0;
    let m;
    while ((m = BOUNDARY.exec(para))) {
      const end = m.index + m[1].length;
      const head = para.slice(start, end);
      if (m[1] === '.' && endsWithAbbreviation(head)) continue;
      out.push({ text: head.trim(), para: paraIndex });
      start = m.index + m[0].length;
    }
    const tail = para.slice(start).trim();
    if (tail) out.push({ text: tail, para: paraIndex });
    paraIndex++;
  }
  return out;
}

/** Break an over-long sentence at clause marks, then at spaces, so no piece exceeds maxTokens. */
export function splitLong(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return [text];
  const pieces = [];
  let current = '';
  const parts = text.split(/(?<=[,;:—–])\s+/);
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = '';
  };
  for (const part of parts) {
    if (estimateTokens(part) > maxTokens) {
      push();
      let line = '';
      for (const word of part.split(/\s+/)) {
        if (line && estimateTokens(`${line} ${word}`) > maxTokens) {
          pieces.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) pieces.push(line);
    } else if (current && estimateTokens(`${current} ${part}`) > maxTokens) {
      push();
      current = part;
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  push();
  return pieces;
}

/** Remove control characters (except tab/newline) and the zero-width / bidi tricks used to hide text. */
export function cleanText(s) {
  return String(s)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '');
}

/** "the-red-headed_league.txt" to "the red headed league" for use as a title in the doc prefix. */
export function titleFromFilename(name) {
  return String(name)
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatMB(bytes, digits = 1) {
  return `${(bytes / 1_000_000).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })} MB`;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
