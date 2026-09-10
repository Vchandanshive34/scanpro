/**
 * OCR engine.
 *
 * Wraps Tesseract with two things that matter for Indian documents:
 *
 * 1. **Language packs on demand.** Models are fetched once from the app's own
 *    /tessdata/ folder and cached in IndexedDB, so after the first use the
 *    app recognises that language with no network at all.
 *
 * 2. **A script-aware dual pass.** Running an Indic model and English
 *    together reads Devanagari well but mangles Latin digits — measured on
 *    test pages, "14,500.00" comes back as "4,500.00" and invoice numbers
 *    lose a digit. Running English alone reads every digit correctly but
 *    cannot see Indic script at all. So we run both and merge at word level,
 *    keeping each pass's words for the script it is actually good at.
 *
 * Real-world accuracy on clean printed text lands around 90-97%. It is not
 * 100% and no OCR engine is; every word carries a confidence score so the UI
 * can flag what needs a human eye.
 */

import { hasIndicText, isLatinOnly, LANG_BY_CODE } from './languages.js';

const TESSDATA_PATH = './tessdata';
const CORE_PATH = './vendor/core';
const WORKER_PATH = './vendor/worker.min.js';

/* ------------------------------------------------------------------ */
/* Word-level merge (pure — unit tested in tools/test-merge.mjs)        */
/* ------------------------------------------------------------------ */

function boxOf(word) {
  const b = word.bbox || word;
  return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  return inter / (areaA + areaB - inter);
}

/**
 * Reject OCR noise: fragments of table rules and paper texture come back as
 * short strings of dashes, pipes and stray marks. A word must carry some
 * alphanumeric content and not be mostly symbols.
 */
function isJunk(text) {
  const t = (text || '').trim();
  if (!t) return true;

  // Combining marks (\p{M}) must count as real content: Devanagari matras,
  // the nukta, Tamil vowel signs and Gurmukhi diacritics are all marks, not
  // letters. Counting only \p{L}\p{N} scores a correctly-read word like
  // "पढ़ें।" as one-third junk and throws it away.
  const alnum = (t.match(/[\p{L}\p{N}\p{M}]/gu) || []).length;
  if (alnum === 0) return true;

  // Long strings that are mostly symbols are rule lines, not words.
  if (t.length > 3 && alnum / t.length < 0.5) return true;

  // Runs of repeated punctuation, e.g. "———_————__——".
  if (/(.)\1{3,}/.test(t) && alnum / t.length < 0.6) return true;

  return false;
}

/**
 * Merge an Indic pass with a Latin pass.
 *
 * Rules, in order:
 *  - A word containing Indic characters always comes from the Indic pass.
 *  - A Latin/numeric word is taken from whichever pass is more confident,
 *    with a bias toward the Latin pass since that is what it is for.
 *  - Latin words the Indic pass missed entirely are inserted, which is how
 *    dropped table cells and invoice numbers come back.
 *
 * @param {Array} indicWords words from the Indic+English pass
 * @param {Array} latinWords words from the English-only pass
 * @returns {Array} merged words, in reading order
 */
export function mergeWordPasses(indicWords, latinWords) {
  const LATIN_BIAS = 8;      // confidence points the Latin pass gets for free
  const OVERLAP = 0.35;

  const merged = [];
  const usedLatin = new Set();

  for (const w of indicWords) {
    const wb = boxOf(w);

    let bestIdx = -1, bestIou = OVERLAP;
    for (let i = 0; i < latinWords.length; i++) {
      if (usedLatin.has(i)) continue;
      const o = iou(wb, boxOf(latinWords[i]));
      if (o > bestIou) { bestIou = o; bestIdx = i; }
    }

    if (bestIdx === -1) { merged.push(w); continue; }

    const cand = latinWords[bestIdx];

    // Indic text is the Indic pass's job — never overwrite it.
    if (hasIndicText(w.text)) { merged.push(w); continue; }

    usedLatin.add(bestIdx);
    const takeLatin = isLatinOnly(cand.text) &&
      cand.confidence + LATIN_BIAS >= w.confidence;

    merged.push(takeLatin ? { ...cand, source: 'latin' } : w);
  }

  // Recover confident Latin words the Indic pass never produced.
  for (let i = 0; i < latinWords.length; i++) {
    if (usedLatin.has(i)) continue;
    const cand = latinWords[i];
    if (!isLatinOnly(cand.text) || cand.confidence < 60) continue;
    if (isJunk(cand.text)) continue;

    const cb = boxOf(cand);
    const overlapsIndic = indicWords.some((w) => iou(cb, boxOf(w)) > OVERLAP);
    if (overlapsIndic) continue;

    merged.push({ ...cand, source: 'latin-recovered' });
  }

  // Flag rather than delete: the UI still shows uncertain words so a human can
  // fix them, but text output and the PDF layer skip them.
  // Indic models report systematically lower confidence than the Latin model
  // on correct output, so a flat cut-off would discard good Devanagari and
  // Tamil words. Structural junk detection applies to everything; a
  // confidence floor applies only to Latin, where the second pass gives us a
  // reliable cross-check.
  for (const w of merged) {
    const indic = hasIndicText(w.text);
    w.noise = isJunk(w.text) ||
      (!indic && (w.confidence || 0) < 40) ||
      (indic && (w.confidence || 0) < 12);
  }

  // Reading order: group into lines by vertical overlap, then left to right.
  merged.sort((a, b) => {
    const ab = boxOf(a), bb = boxOf(b);
    const aMid = (ab.y0 + ab.y1) / 2, bMid = (bb.y0 + bb.y1) / 2;
    const aH = ab.y1 - ab.y0, bH = bb.y1 - bb.y0;
    const tol = Math.max(6, Math.min(aH, bH) * 0.55);
    if (Math.abs(aMid - bMid) > tol) return aMid - bMid;
    return ab.x0 - bb.x0;
  });

  return merged;
}

/** Rebuild readable text (with line breaks) from merged words. */
export function wordsToText(allWords) {
  const words = allWords.filter((w) => !w.noise && w.text && w.text.trim());
  if (!words.length) return '';

  const lines = [];
  let current = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const prev = boxOf(words[i - 1]);
    const cur = boxOf(words[i]);
    const prevMid = (prev.y0 + prev.y1) / 2;
    const curMid = (cur.y0 + cur.y1) / 2;
    const tol = Math.max(6, (cur.y1 - cur.y0) * 0.55);

    if (Math.abs(curMid - prevMid) > tol) { lines.push(current); current = []; }
    current.push(words[i]);
  }
  lines.push(current);

  return lines.map((l) => l.map((w) => w.text).join(' ').trim())
    .filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class OCREngine {
  constructor() {
    this.workers = new Map();   // langKey -> Tesseract worker
    this.installed = new Set(['eng']);
    this.onProgress = null;
  }

  _report(stage, progress) {
    if (this.onProgress) this.onProgress({ stage, progress });
  }

  /** Load (and cache) a Tesseract worker for a language set. */
  async _worker(langKey) {
    if (this.workers.has(langKey)) return this.workers.get(langKey);

    if (!self.Tesseract) throw new Error('Tesseract runtime is not loaded.');

    const worker = await self.Tesseract.createWorker(langKey, 1, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      langPath: TESSDATA_PATH,
      gzip: false,
      cacheMethod: 'readwrite',   // keeps models in IndexedDB for offline use
      logger: (m) => {
        if (m.status === 'loading language traineddata' ||
            m.status === 'initializing tesseract') {
          this._report('Loading language', m.progress);
        } else if (m.status === 'recognizing text') {
          this._report('Reading text', m.progress);
        }
      },
    });

    // Auto page segmentation measured best on mixed text-and-table pages.
    await worker.setParameters({ tessedit_pageseg_mode: '3' });

    this.workers.set(langKey, worker);
    langKey.split('+').forEach((c) => this.installed.add(c));
    return worker;
  }

  /** Download a language pack ahead of time so it works offline later. */
  async installLanguage(code) {
    await this._worker(code === 'eng' ? 'eng' : `${code}+eng`);
    return true;
  }

  isInstalled(code) {
    return this.installed.has(code);
  }

  /**
   * Recognise a page.
   *
   * @param {HTMLCanvasElement|ImageBitmap|Blob|string} image
   * @param {string[]} langs  language codes, e.g. ['hin'] or ['tam','hin']
   * @returns {{text, words, confidence, langs, durationMs}}
   */
  async recognize(image, langs = ['eng']) {
    const codes = [...new Set(langs.filter((c) => LANG_BY_CODE[c]))];
    if (!codes.length) codes.push('eng');

    const started = Date.now();
    const nonLatin = codes.filter((c) => LANG_BY_CODE[c].script !== 'latin');

    // Single Latin pass is enough when no Indic language is selected.
    if (!nonLatin.length) {
      const worker = await this._worker('eng');
      const { data } = await worker.recognize(image);
      const words = (data.words || []).map((w) => ({ ...w, source: 'latin' }));
      return {
        text: data.text.trim(),
        words,
        confidence: data.confidence,
        langs: codes,
        durationMs: Date.now() - started,
      };
    }

    const indicKey = `${nonLatin.join('+')}+eng`;

    this._report('Reading text', 0);
    const indicWorker = await this._worker(indicKey);
    const indicResult = await indicWorker.recognize(image);
    const indicWords = (indicResult.data.words || [])
      .map((w) => ({ ...w, source: 'indic' }));

    // Second pass in English only, to rescue Latin text and digits.
    this._report('Checking numbers', 0.6);
    let latinWords = [];
    try {
      const latinWorker = await this._worker('eng');
      const latinResult = await latinWorker.recognize(image);
      latinWords = (latinResult.data.words || []).map((w) => ({ ...w, source: 'latin' }));
    } catch (err) {
      console.warn('Latin verification pass failed; using single pass.', err);
    }

    const words = latinWords.length
      ? mergeWordPasses(indicWords, latinWords)
      : indicWords;

    const conf = words.length
      ? words.reduce((s, w) => s + (w.confidence || 0), 0) / words.length
      : indicResult.data.confidence;

    this._report('Done', 1);

    return {
      text: wordsToText(words) || indicResult.data.text.trim(),
      words,
      confidence: conf,
      langs: codes,
      durationMs: Date.now() - started,
    };
  }

  async terminate() {
    for (const w of this.workers.values()) {
      try { await w.terminate(); } catch { /* already gone */ }
    }
    this.workers.clear();
  }
}

export const ocrEngine = new OCREngine();
