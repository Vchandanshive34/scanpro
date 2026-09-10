/**
 * Language catalogue for OCR.
 *
 * `script` drives the dual-pass merge in ocr.js and the transliteration and
 * text-shaping choices in the UI. `size` is the approximate on-disk size of
 * the tessdata_fast model, shown before a user downloads a pack.
 */

export const SCRIPTS = {
  latin:      { name: 'Latin',      ranges: [[0x0041, 0x024f]] },
  devanagari: { name: 'Devanagari', ranges: [[0x0900, 0x097f], [0xa8e0, 0xa8ff]] },
  bengali:    { name: 'Bengali',    ranges: [[0x0980, 0x09ff]] },
  gurmukhi:   { name: 'Gurmukhi',   ranges: [[0x0a00, 0x0a7f]] },
  gujarati:   { name: 'Gujarati',   ranges: [[0x0a80, 0x0aff]] },
  odia:       { name: 'Odia',       ranges: [[0x0b00, 0x0b7f]] },
  tamil:      { name: 'Tamil',      ranges: [[0x0b80, 0x0bff]] },
  telugu:     { name: 'Telugu',     ranges: [[0x0c00, 0x0c7f]] },
  kannada:    { name: 'Kannada',    ranges: [[0x0c80, 0x0cff]] },
  malayalam:  { name: 'Malayalam',  ranges: [[0x0d00, 0x0d7f]] },
  arabic:     { name: 'Perso-Arabic', ranges: [[0x0600, 0x06ff], [0x0750, 0x077f], [0xfb50, 0xfdff], [0xfe70, 0xfeff]] },
};

/**
 * Languages offered by the app. `eng` is always installed.
 *
 * `iso` is the ISO 639-1 code translation services expect, which is not the
 * three-letter code Tesseract uses for its models.
 */
export const LANGUAGES = [
  { code: 'eng', iso: 'en', name: 'English',   native: 'English',  script: 'latin',      size: 4.0, core: true },
  { code: 'hin', iso: 'hi', name: 'Hindi',     native: 'हिन्दी',      script: 'devanagari', size: 1.1 },
  { code: 'ben', iso: 'bn', name: 'Bengali',   native: 'বাংলা',      script: 'bengali',    size: 0.8 },
  { code: 'tam', iso: 'ta', name: 'Tamil',     native: 'தமிழ்',      script: 'tamil',      size: 3.1 },
  { code: 'tel', iso: 'te', name: 'Telugu',    native: 'తెలుగు',     script: 'telugu',     size: 2.7 },
  { code: 'mar', iso: 'mr', name: 'Marathi',   native: 'मराठी',      script: 'devanagari', size: 2.1 },
  { code: 'guj', iso: 'gu', name: 'Gujarati',  native: 'ગુજરાતી',     script: 'gujarati',   size: 1.4 },
  { code: 'kan', iso: 'kn', name: 'Kannada',   native: 'ಕನ್ನಡ',      script: 'kannada',    size: 3.5 },
  { code: 'mal', iso: 'ml', name: 'Malayalam', native: 'മലയാളം',    script: 'malayalam',  size: 5.1 },
  { code: 'pan', iso: 'pa', name: 'Punjabi',   native: 'ਪੰਜਾਬੀ',      script: 'gurmukhi',   size: 0.5 },
  { code: 'ori', iso: 'or', name: 'Odia',      native: 'ଓଡ଼ିଆ',       script: 'odia',       size: 1.5 },
  { code: 'asm', iso: 'as', name: 'Assamese',  native: 'অসমীয়া',    script: 'bengali',    size: 2.0 },
  { code: 'urd', iso: 'ur', name: 'Urdu',      native: 'اردو',       script: 'arabic',     size: 1.4, rtl: true },
  { code: 'san', iso: 'sa', name: 'Sanskrit',  native: 'संस्कृतम्',    script: 'devanagari', size: 12.0 },
  { code: 'nep', iso: 'ne', name: 'Nepali',    native: 'नेपाली',      script: 'devanagari', size: 1.0 },
];

export const LANG_BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

const NON_LATIN_SCRIPTS = Object.keys(SCRIPTS).filter((s) => s !== 'latin');

function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** Which script a single codepoint belongs to, or null for shared characters. */
export function scriptOf(cp) {
  for (const [key, def] of Object.entries(SCRIPTS)) {
    if (inRanges(cp, def.ranges)) return key;
  }
  return null;
}

/** True when the string contains any Indic or Perso-Arabic character. */
export function hasIndicText(str) {
  for (const ch of str) {
    const s = scriptOf(ch.codePointAt(0));
    if (s && NON_LATIN_SCRIPTS.includes(s)) return true;
  }
  return false;
}

/** True when a string is only ASCII letters, digits, punctuation and space. */
export function isLatinOnly(str) {
  return /^[ -~ -ɏ‐-‟₹]*$/.test(str);
}

/** Dominant script of a block of text, for display and transliteration. */
export function dominantScript(str) {
  const counts = {};
  for (const ch of str) {
    const s = scriptOf(ch.codePointAt(0));
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  let best = null, n = 0;
  for (const [k, v] of Object.entries(counts)) if (v > n) { n = v; best = k; }
  return best;
}

/**
 * The dominant non-Latin script, by display name.
 *
 * Transliteration only ever concerns the Indic portion of a page, and Indian
 * documents are usually bilingual — a Hindi form with English headings often
 * has more Latin characters than Devanagari, so the plain dominant script
 * would report "Latin" on a page that plainly needs transliterating.
 */
export function dominantIndicScriptName(str) {
  const counts = {};
  for (const ch of str) {
    const s = scriptOf(ch.codePointAt(0));
    if (s && s !== 'latin') counts[s] = (counts[s] || 0) + 1;
  }
  let best = null, n = 0;
  for (const [k, v] of Object.entries(counts)) if (v > n) { n = v; best = k; }
  return best ? SCRIPTS[best].name : null;
}
