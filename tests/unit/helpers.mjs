// Deterministic stand-in embedder for tests: hashed bag of words, L2-normalised. It is NOT a model;
// it only gives lexical overlap a meaningful cosine so search logic can be tested without a GPU.
import { normalise } from '../../js/search.js';

const DIM = 768;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const STOP = new Set('the a an of and to in is was were it that for on with as by at from this be are or not but his her he she they we you i what who which when where how did do does'.split(' '));

export function fakeEmbed(text, dim = DIM) {
  const v = new Float32Array(dim);
  const words = text.toLowerCase().replace(/^(?:task: [a-z ]+ \| query: |title: [^|]*\| text: )/, '').match(/[a-z0-9']+/g) ?? [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    v[hash(w) % dim] += 1;
    v[hash(w + '#') % dim] += 0.5;
  }
  return normalise(v);
}

export function randomVector(dim, seed) {
  let s = seed >>> 0 || 1;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    v[i] = s / 2 ** 32 - 0.5;
  }
  return normalise(v);
}
