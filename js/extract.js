// Turn a File into text segments. Text, Markdown and PDF (text layer only; no OCR).
// Everything read here is untrusted: it is cleaned of control characters and only ever used as data.

import { LIMITS } from './config.js';
import { cleanText, titleFromFilename } from './text.js';

export class ExtractError extends Error {}

const TEXT_EXT = /\.(txt|text|md|markdown|csv|log)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

export function classifyFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name) || file.type === 'application/json') return 'text';
  return 'unsupported';
}

/** @returns {Promise<{kind: 'text'|'pdf', name: string, title: string, segments: {page: number|null, text: string}[], pages: number|null}>} */
export async function extractDocument(file, { pdfjs = loadPdfjs } = {}) {
  const kind = classifyFile(file);
  if (file.size > LIMITS.maxFileBytes) throw new ExtractError(`${file.name} is larger than ${Math.round(LIMITS.maxFileBytes / 1e6)} MB, which is more than carrel will read.`);
  if (kind === 'text') {
    let text = await file.text();
    text = cleanText(text.replace(/^﻿/, ''));
    if (text.length > LIMITS.maxTextChars) text = text.slice(0, LIMITS.maxTextChars);
    if (!text.trim()) throw new ExtractError(`${file.name} has no text in it.`);
    return { kind: 'text', name: file.name, title: titleFromFilename(file.name), segments: [{ page: null, text }], pages: null };
  }
  if (kind === 'pdf') return extractPdf(file, pdfjs);
  if (kind === 'image') throw new ExtractError(`${file.name} is an image. Drop images onto the images target instead.`);
  throw new ExtractError(`${file.name}: carrel reads .txt, .md and .pdf files, and images.`);
}

export function textFromPaste(text, title = '') {
  const t = cleanText(text);
  if (!t.trim()) throw new ExtractError('There is nothing to add: the pasted text is empty.');
  const name = title.trim() || `Pasted text ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  return { kind: 'text', name, title: title.trim(), segments: [{ page: null, text: t.slice(0, LIMITS.maxTextChars) }], pages: null };
}

let pdfjsPromise = null;
async function loadPdfjs() {
  pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
    // The PDF.js worker is started from a blob wrapper so it inherits this page's CSP, like our own workers.
    const src = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    const blob = new Blob([`import ${JSON.stringify(src)};`], { type: 'text/javascript' });
    lib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: 'module' });
    return lib;
  });
  return pdfjsPromise;
}

async function extractPdf(file, pdfjs) {
  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new ExtractError(`${file.name} is password protected.`);
    throw new ExtractError(`${file.name} could not be read as a PDF.`);
  }
  try {
    if (doc.numPages > LIMITS.maxPdfPages) throw new ExtractError(`${file.name} has ${doc.numPages} pages; carrel reads up to ${LIMITS.maxPdfPages}.`);
    const segments = [];
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        text += item.hasEOL ? '\n' : item.str.endsWith(' ') ? '' : ' ';
      }
      text = cleanText(text).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ');
      chars += text.replace(/\s/g, '').length;
      if (text.trim()) segments.push({ page: p, text });
      page.cleanup();
    }
    if (chars < LIMITS.minPdfCharsPerDoc) {
      throw new ExtractError(
        `${file.name} has no text layer. It looks like a scan, and carrel does not read scanned PDFs (there is no OCR). ` +
          'Try a PDF that was exported from a document, or paste the text in.',
      );
    }
    return { kind: 'pdf', name: file.name, title: titleFromFilename(file.name), segments, pages: doc.numPages };
  } finally {
    doc.destroy?.();
  }
}
