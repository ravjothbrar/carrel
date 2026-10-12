import test from 'node:test';
import assert from 'node:assert/strict';
import { stripGutenberg, splitStories, pickStories, toTitle } from '../../tools/gutenberg.mjs';

const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
const FILE = `The Project Gutenberg eBook of The Adventures of Sherlock Holmes, by Arthur Conan Doyle

This eBook is for the use of anyone anywhere. You may copy it, give it away or re-use it under the terms of the Project Gutenberg License.

*** START OF THE PROJECT GUTENBERG EBOOK THE ADVENTURES OF SHERLOCK HOLMES ***

Contents
   I.     A Scandal in Bohemia
   II.    The Red-Headed League

ADVENTURE I. A SCANDAL IN BOHEMIA

To Sherlock Holmes she is always the woman. ${words(3000)}

ADVENTURE II. THE RED-HEADED LEAGUE

I had called upon my friend, Mr. Sherlock Holmes. ${words(3000)}

ADVENTURE VIII. THE ADVENTURE OF THE SPECKLED BAND

On glancing over my notes of the seventy odd cases. ${words(3000)}

*** END OF THE PROJECT GUTENBERG EBOOK THE ADVENTURES OF SHERLOCK HOLMES ***

Updated editions will replace the previous one. Project Gutenberg is a registered trademark.
`;

test('header and footer are removed, including every mention of the name', () => {
  const body = stripGutenberg(FILE);
  assert.ok(!/gutenberg/i.test(body), 'no Gutenberg name left in the text');
  assert.ok(body.startsWith('Contents'));
  assert.ok(body.includes('To Sherlock Holmes she is always the woman'));
  assert.ok(!body.includes('Updated editions'));
});

test('files without markers are refused rather than guessed at', () => {
  assert.throws(() => stripGutenberg('just some text'), /markers/);
  assert.throws(() => stripGutenberg('*** END OF THE PROJECT GUTENBERG EBOOK X ***\nfoo\n*** START OF THE PROJECT GUTENBERG EBOOK X ***'), /markers/);
});

test('stories are split at their headings, ignoring the contents list', () => {
  const stories = splitStories(stripGutenberg(FILE));
  assert.deepEqual(stories.map((s) => s.title), ['A Scandal in Bohemia', 'The Red-Headed League', 'The Adventure of the Speckled Band']);
  assert.ok(stories[0].text.startsWith('To Sherlock Holmes'));
  assert.ok(!stories[0].text.includes('ADVENTURE II'));
});

test('pickStories finds the wanted ones by title and fails loudly otherwise', () => {
  const stories = splitStories(stripGutenberg(FILE));
  assert.deepEqual(pickStories(stories, ['Scandal in Bohemia', 'Red-Headed League', 'Speckled Band']).map((s) => s.numeral), ['I', 'II', 'VIII']);
  assert.throws(() => pickStories(stories, ['The Blue Carbuncle']), /Story not found/);
  assert.throws(() => pickStories([{ title: 'Tiny', text: 'a b c', numeral: 'I' }], ['Tiny']), /only 3 words/);
});

test('toTitle', () => {
  assert.equal(toTitle('THE ADVENTURE OF THE SPECKLED BAND'), 'The Adventure of the Speckled Band');
  assert.equal(toTitle('THE RED-HEADED LEAGUE'), 'The Red-Headed League');
});

test('headings without the word ADVENTURE are found too, and mixed-case contents lines are not', () => {
  const alt = FILE.replace(/ADVENTURE (I|II|VIII)\./g, '$1.');
  const stories = splitStories(stripGutenberg(alt));
  assert.deepEqual(stories.map((s) => s.title), ['A Scandal in Bohemia', 'The Red-Headed League', 'The Adventure of the Speckled Band']);
});
