// A question and its answer, typeset like a page: the question is a heading, the answer is set in a
// serif with numbered footnote marks, and the source passages sit in a margin column beside it
// (stacked below on narrow screens). Images are figures. No bubbles, no avatars.
//
// Everything is built from DOM nodes with textContent. Model output and document text never become HTML.

import { h, inlineMarkdown } from './dom.js';
import { splitCitations } from './prompt.js';

let sheetCounter = 0;

export function createSheet(question) {
  const id = `sheet${++sheetCounter}`;
  const meta = h('p', { class: 'sheet-meta mono' }, 'Starting…');
  const answer = h('div', { class: 'answer streaming', 'aria-live': 'off' });
  const checkLine = h('p', { class: 'check-line mono', hidden: true });
  const figures = h('div', { class: 'figures' });
  const notes = h('ol', { class: 'notes' });
  const marginTitle = h('h3', {}, 'Sources in your documents');
  const margin = h('aside', { class: 'margin', 'aria-label': 'Source passages' }, marginTitle, notes);
  margin.hidden = true;
  const el = h('article', { class: 'sheet', id, 'aria-label': `Answer to: ${question}` },
    h('h2', { class: 'sheet-q' }, question),
    meta,
    h('div', { class: 'sheet-main' }, answer, checkLine, figures),
    margin,
  );

  return {
    el,
    id,
    phase(text) {
      meta.textContent = text;
    },
    /** Streaming view: raw text only. The typeset version replaces it when the answer is complete. */
    stream(text) {
      answer.textContent = text;
    },
    showPassages(passages, { title, citedSet = null } = {}) {
      notes.textContent = '';
      marginTitle.textContent = title ?? 'Sources in your documents';
      for (const p of passages) notes.append(noteEl(id, p, citedSet));
      margin.hidden = passages.length === 0;
    },
    markCited(citedSet) {
      for (const li of notes.children) li.classList.toggle('uncited', !citedSet.has(Number(li.dataset.n)));
    },
    abstain({ noText, closest }) {
      answer.classList.remove('streaming');
      answer.textContent = '';
      answer.append(
        h('p', { class: 'abstain' }, "That isn't in your documents."),
        h('p', {}, noText
          ? 'There is no text on your desk yet, so there is nothing to answer from.'
          : closest
            ? 'The closest passages are in the margin. None was close enough to answer from, so carrel did not ask the model.'
            : 'Nothing close enough was found, so carrel did not ask the model.'),
      );
    },
    renderAnswer(blocks, passages, { unsupportedLabel = 'not clearly supported by your documents' } = {}) {
      answer.classList.remove('streaming');
      answer.textContent = '';
      const valid = new Set(passages.map((p) => p.n));
      let list = null;
      for (const block of blocks) {
        const sentenceNodes = block.sentences.map((s) => sentenceEl(s, id, valid, unsupportedLabel));
        if (block.type === 'li') {
          if (!list) {
            list = h('ul');
            answer.append(list);
          }
          list.append(h('li', {}, sentenceNodes));
        } else {
          list = null;
          answer.append(h('p', {}, sentenceNodes));
        }
        if (block.type !== 'li') list = null;
      }
    },
    setCheckLine(text) {
      checkLine.hidden = !text;
      checkLine.textContent = text ?? '';
    },
    setError(message) {
      answer.classList.remove('streaming');
      answer.textContent = '';
      answer.append(h('p', { class: 'abstain' }, 'Something went wrong.'), h('p', {}, message));
    },
    final(text) {
      meta.textContent = text;
    },
    /** @param {{url: string, name: string, caption: string, source: string, score: number, rank: number}} img */
    addFigure(img, number = 1) {
      const fig = h('figure', { class: 'figure' },
        h('img', { src: img.url, alt: img.caption || img.name, loading: 'lazy' }),
        h('figcaption', {},
          h('span', { class: 'fig-n' }, `FIG. ${number}`),
          img.caption || img.name,
          h('br'),
          `Source: ${img.source || 'added by you'} · matched your question at rank ${img.rank} (score ${img.score.toFixed(3)})`,
        ),
      );
      const slot = h('div', { class: 'fig-slot' });
      fig.append(slot);
      figures.append(fig);
      return {
        fig,
        describing(text) {
          slot.textContent = '';
          slot.append(h('p', { class: 'mono dim' }, text));
        },
        described(text) {
          slot.textContent = '';
          slot.append(h('p', { class: 'desc' }, h('span', { class: 'desc-label' }, 'described by Gemma on this device'), text));
        },
        offerDescribe(label, onClick) {
          slot.textContent = '';
          slot.append(h('button', { type: 'button', class: 'btn mono small', onclick: onClick }, h('kbd', {}, 'D'), label));
        },
        failed(text) {
          slot.textContent = '';
          slot.append(h('p', { class: 'mono dim' }, text));
        },
      };
    },
  };
}

function sentenceEl(s, sheetId, validNumbers, unsupportedLabel) {
  const span = h('span', { class: `s ${s.status}`, dataset: { status: s.status } });
  const parts = splitCitations(s.raw);
  for (const [i, part] of parts.entries()) {
    if (part.type === 'text') {
      // no gap between the words and the footnote mark that follows them
      const text = parts[i + 1]?.type === 'cite' ? part.text.replace(/\s+$/, '') : part.text;
      span.append(...inlineMarkdown(text.replace(/^\s*#{1,6}\s+/, '')));
    } else {
      const sup = h('sup', { class: 'fn' });
      part.nums.forEach((n, i) => {
        if (i) sup.append(',');
        if (validNumbers.has(n)) {
          sup.append(h('a', {
            href: `#${sheetId}-note-${n}`,
            'aria-label': `Passage ${n}`,
            onmouseenter: () => light(sheetId, n, true),
            onmouseleave: () => light(sheetId, n, false),
            onfocus: () => light(sheetId, n, true),
            onblur: () => light(sheetId, n, false),
          }, String(n)));
        } else {
          sup.append(h('span', { title: 'This passage number does not exist', class: 'dim' }, `${n}?`));
        }
      });
      span.append(sup);
    }
  }
  const out = [span];
  if (s.status === 'unsupported') out.push(h('span', { class: 'flag' }, unsupportedLabel));
  else if (s.invalidCited?.length) out.push(h('span', { class: 'flag' }, 'cites a passage that does not exist'));
  out.push(' ');
  return out;
}

function light(sheetId, n, on) {
  document.getElementById(`${sheetId}-note-${n}`)?.classList.toggle('lit', on);
}

function noteEl(sheetId, p, citedSet) {
  const text = h('p', { class: 'note-text' }, p.text);
  const more = h('button', {
    type: 'button',
    class: 'linklike note-more',
    'aria-expanded': 'false',
    onclick: (e) => {
      const open = text.classList.toggle('open');
      e.currentTarget.textContent = open ? 'Show less' : 'Show full passage';
      e.currentTarget.setAttribute('aria-expanded', String(open));
    },
  }, 'Show full passage');
  return h('li', {
    class: `note${citedSet && !citedSet.has(p.n) ? ' uncited' : ''}`,
    id: `${sheetId}-note-${p.n}`,
    dataset: { n: p.n },
  },
    h('div', { class: 'note-head' },
      h('span', { class: 'note-n' }, String(p.n)),
      h('span', { class: 'note-src' }, `${p.source} · ${p.loc}`),
      h('span', { class: 'note-score', title: 'Cosine similarity to your question' }, p.score.toFixed(2)),
    ),
    text,
    p.text.length > 280 ? more : null,
  );
}
