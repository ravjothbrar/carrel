import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, splitLong, estimateTokens, cleanText, titleFromFilename } from '../../js/text.js';
import { chunkSegments, locLabel } from '../../js/chunk.js';
import { CHUNK } from '../../js/config.js';

test('splitSentences handles abbreviations, initials and quotes', () => {
  const s = splitSentences('Mr. Holmes met Dr. Watson at St. Pancras. "Quite so!" said J. H. Watson. It was late.').map((x) => x.text);
  assert.deepEqual(s, ['Mr. Holmes met Dr. Watson at St. Pancras.', '"Quite so!" said J. H. Watson.', 'It was late.']);
});

test('splitSentences joins hard-wrapped lines and splits on blank lines', () => {
  const s = splitSentences('The cat sat\non the mat. It purred\nloudly.\n\nNew paragraph here.');
  assert.deepEqual(s.map((x) => x.text), ['The cat sat on the mat.', 'It purred loudly.', 'New paragraph here.']);
  assert.deepEqual(s.map((x) => x.para), [0, 0, 1]);
});

test('splitLong keeps every piece under the limit and loses no words', () => {
  const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
  const pieces = splitLong(long, 100);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(estimateTokens(p) <= 100, `piece too long: ${estimateTokens(p)}`);
  assert.equal(pieces.join(' ').split(' ').length, 600);
});

test('cleanText strips control and zero-width characters', () => {
  assert.equal(cleanText('a\u0000b​c‮d\u0007e'), 'abcde');
});

test('titleFromFilename', () => {
  assert.equal(titleFromFilename('the-red_headed league.txt'), 'the red headed league');
});

function makeText(nSentences) {
  return Array.from({ length: nSentences }, (_, i) => `Sentence number ${i} talks about topic ${i % 7} and some more words to fill space nicely.`).join(' ');
}

test('chunks stay within size bounds, overlap by about 15 percent and cover everything', () => {
  const text = makeText(400);
  const chunks = chunkSegments([{ page: null, text }]);
  assert.ok(chunks.length > 5);
  for (const c of chunks.slice(0, -1)) {
    assert.ok(c.tokens <= CHUNK.maxTokens, `chunk over max: ${c.tokens}`);
    assert.ok(c.tokens >= CHUNK.minTokens - 40, `chunk far under min: ${c.tokens}`);
  }
  // overlap: the start of chunk k+1 appears at the end of chunk k
  for (let k = 0; k < chunks.length - 1; k++) {
    const nextFirst = chunks[k + 1].text.split('. ')[0];
    assert.ok(chunks[k].text.includes(nextFirst), `chunk ${k + 1} does not overlap chunk ${k}`);
  }
  // every sentence index appears somewhere
  const joined = chunks.map((c) => c.text).join(' ');
  for (let i = 0; i < 400; i++) assert.ok(joined.includes(`Sentence number ${i} `));
  // deterministic
  assert.deepEqual(chunkSegments([{ page: null, text }]), chunks);
});

test('page numbers follow the sentences', () => {
  const chunks = chunkSegments([
    { page: 1, text: makeText(30) },
    { page: 2, text: makeText(30) },
    { page: 3, text: makeText(30) },
  ]);
  assert.equal(chunks[0].page, 1);
  assert.ok(chunks.some((c) => c.page !== c.pageEnd), 'some chunk should span a page break');
  assert.equal(chunks.at(-1).pageEnd, 3);
  assert.match(locLabel({ page: 2, pageEnd: 3 }, 0), /pp\. 2–3/);
  assert.equal(locLabel({ page: null }, 4), '§5');
});

test('a single huge sentence is split, never dropped', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ') + '.';
  const chunks = chunkSegments([{ page: null, text }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.tokens <= CHUNK.maxTokens));
  assert.ok(chunks.map((c) => c.text).join(' ').includes('w1999'));
});

test('empty input gives no chunks', () => {
  assert.deepEqual(chunkSegments([{ page: null, text: '   \n\n ' }]), []);
});
