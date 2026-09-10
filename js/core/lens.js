/**
 * Lens features: understanding what is *in* the text, not just reading it.
 *
 * Three parts:
 *   - entity extraction tuned for Indian documents (UPI, PAN, GSTIN, IFSC,
 *     Aadhaar, vehicle numbers, PIN codes, ₹ amounts) with an action for each
 *   - barcode and QR scanning, including UPI payment QRs
 *   - offline transliteration between Indic scripts and Latin
 */

/* ------------------------------------------------------------------ */
/* Entity extraction                                                   */
/* ------------------------------------------------------------------ */

const PATTERNS = [
  {
    type: 'email',
    icon: '✉',
    label: 'Email',
    re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    action: (v) => ({ label: 'Send email', href: `mailto:${v}` }),
  },
  {
    type: 'url',
    icon: '🔗',
    label: 'Link',
    re: /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi,
    action: (v) => ({
      label: 'Open link',
      href: v.startsWith('http') ? v : `https://${v}`,
      external: true,
    }),
  },
  {
    type: 'upi',
    icon: '₹',
    label: 'UPI ID',
    // A UPI handle looks like an email but the domain is a bank handle with
    // no dot, which is what separates the two.
    re: /\b[a-zA-Z0-9._-]{2,}@(?:okaxis|oksbi|okhdfcbank|okicici|paytm|ybl|ibl|axl|apl|upi|abfspay|airtel|freecharge|jupiteraxis|fam|slc|yesg|dbs|idfcbank|indus|kotak|sbi|hdfcbank|icici|axisbank)\b/gi,
    action: (v) => ({ label: 'Copy UPI ID', copy: v }),
  },
  {
    type: 'phone',
    icon: '☎',
    label: 'Phone',
    re: /(?:\+91[-\s]?|\b0)?[6-9]\d{4}[-\s]?\d{5}\b/g,
    action: (v) => ({ label: 'Call', href: `tel:${v.replace(/[^\d+]/g, '')}` }),
  },
  {
    type: 'pan',
    icon: '🪪',
    label: 'PAN',
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    action: (v) => ({ label: 'Copy PAN', copy: v }),
    sensitive: true,
  },
  {
    type: 'gstin',
    icon: '🏢',
    label: 'GSTIN',
    re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g,
    action: (v) => ({ label: 'Copy GSTIN', copy: v }),
  },
  {
    type: 'ifsc',
    icon: '🏦',
    label: 'IFSC',
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    action: (v) => ({ label: 'Copy IFSC', copy: v }),
  },
  {
    type: 'aadhaar',
    icon: '🆔',
    label: 'Aadhaar',
    re: /\b[2-9]\d{3}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    action: (v) => ({ label: 'Copy', copy: v }),
    sensitive: true,
    validate: verhoeffValid,
  },
  {
    type: 'vehicle',
    icon: '🚗',
    label: 'Vehicle',
    re: /\b[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{4}\b/g,
    action: (v) => ({ label: 'Copy', copy: v }),
  },
  {
    type: 'amount',
    icon: '💰',
    label: 'Amount',
    re: /(?:₹|\bRs\.?|\bINR)\s?\d[\d,]*(?:\.\d{1,2})?\b/gi,
    action: (v) => ({ label: 'Copy', copy: v }),
  },
  {
    type: 'pincode',
    icon: '📍',
    label: 'PIN code',
    re: /\b[1-9]\d{5}\b/g,
    action: (v) => ({ label: 'Copy', copy: v }),
  },
  {
    type: 'date',
    icon: '📅',
    label: 'Date',
    re: /\b(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/gi,
    action: (v) => ({ label: 'Copy', copy: v }),
  },
];

/**
 * The Verhoeff checksum Aadhaar numbers carry. Without it, every 12-digit
 * number in a document reads as an Aadhaar number.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffValid(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 12) return false;
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(rev[i])]];
  }
  return c === 0;
}

/**
 * Pull actionable entities out of recognised text.
 * Overlapping matches are resolved by keeping the longer, more specific one —
 * so a UPI ID is not also reported as an email.
 */
export function extractEntities(text) {
  if (!text) return [];
  const found = [];

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const value = m[0].trim();
      if (p.validate && !p.validate(value)) continue;
      found.push({
        type: p.type,
        icon: p.icon,
        label: p.label,
        value,
        start: m.index,
        end: m.index + m[0].length,
        sensitive: !!p.sensitive,
        action: p.action(value),
      });
    }
  }

  // Specific beats general on overlap: UPI over email, PAN over vehicle.
  const priority = {
    upi: 10, aadhaar: 9, gstin: 9, pan: 8, ifsc: 8, email: 7,
    url: 6, vehicle: 5, phone: 5, amount: 4, date: 3, pincode: 1,
  };

  found.sort((a, b) =>
    (b.end - b.start) - (a.end - a.start) ||
    (priority[b.type] || 0) - (priority[a.type] || 0));

  const kept = [];
  for (const e of found) {
    const clash = kept.some((k) => e.start < k.end && k.start < e.end);
    if (!clash) kept.push(e);
  }

  return kept.sort((a, b) => a.start - b.start);
}

/** Deduplicate entities for display, keeping counts. */
export function groupEntities(entities) {
  const groups = new Map();
  for (const e of entities) {
    const key = `${e.type}:${e.value}`;
    if (groups.has(key)) groups.get(key).count++;
    else groups.set(key, { ...e, count: 1 });
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ */
/* Barcodes and QR                                                     */
/* ------------------------------------------------------------------ */

export function barcodeSupported() {
  return typeof BarcodeDetector !== 'undefined';
}

let detectorPromise = null;

async function getDetector() {
  if (!barcodeSupported()) return null;
  if (!detectorPromise) {
    detectorPromise = (async () => {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        return new BarcodeDetector({ formats });
      } catch {
        return new BarcodeDetector();
      }
    })();
  }
  return detectorPromise;
}

/** Scan a canvas or video frame for barcodes and QR codes. */
export async function scanBarcodes(source) {
  const detector = await getDetector();
  if (!detector) return [];
  try {
    const codes = await detector.detect(source);
    return codes.map((c) => ({
      format: c.format,
      value: c.rawValue,
      box: c.boundingBox,
      parsed: parseCodeValue(c.rawValue),
    }));
  } catch {
    return [];
  }
}

/** Recognise common QR payloads so the UI can offer the right action. */
export function parseCodeValue(raw) {
  if (!raw) return { kind: 'text', value: raw };

  if (/^upi:\/\//i.test(raw)) {
    const params = new URLSearchParams(raw.split('?')[1] || '');
    return {
      kind: 'upi',
      payee: params.get('pn') || '',
      vpa: params.get('pa') || '',
      amount: params.get('am') || '',
      note: params.get('tn') || '',
      value: raw,
    };
  }
  if (/^(https?:)?\/\//i.test(raw)) return { kind: 'url', value: raw };
  if (/^WIFI:/i.test(raw)) {
    const ssid = /S:([^;]*)/.exec(raw);
    return { kind: 'wifi', ssid: ssid ? ssid[1] : '', value: raw };
  }
  if (/^BEGIN:VCARD/i.test(raw)) {
    const fn = /\nFN:(.*)/i.exec(raw);
    return { kind: 'contact', name: fn ? fn[1].trim() : '', value: raw };
  }
  if (/^(tel:|mailto:)/i.test(raw)) {
    return { kind: raw.toLowerCase().startsWith('tel:') ? 'phone' : 'email', value: raw };
  }
  return { kind: 'text', value: raw };
}

/* ------------------------------------------------------------------ */
/* Transliteration                                                     */
/* ------------------------------------------------------------------ */

/**
 * Indic scripts descended from Brahmi share a parallel code-point layout
 * (an ISCII inheritance): Devanagari क is U+0915, Bengali ক is U+0995,
 * Gujarati ક is U+0A95 — the same offset within each 128-point block.
 *
 * That lets one Devanagari table serve every aligned script: shift the
 * codepoint into the Devanagari block, then transliterate once. Tamil is the
 * partial exception — it has a smaller consonant inventory and does not
 * distinguish aspirates — so its output is approximate, which the UI says.
 */
const SCRIPT_BASES = {
  devanagari: 0x0900, bengali: 0x0980, gurmukhi: 0x0a00, gujarati: 0x0a80,
  odia: 0x0b00, tamil: 0x0b80, telugu: 0x0c00, kannada: 0x0c80,
  malayalam: 0x0d00,
};

const DEVA_CONSONANTS = {
  0x0915: 'k', 0x0916: 'kh', 0x0917: 'g', 0x0918: 'gh', 0x0919: 'ṅ',
  0x091a: 'c', 0x091b: 'ch', 0x091c: 'j', 0x091d: 'jh', 0x091e: 'ñ',
  0x091f: 'ṭ', 0x0920: 'ṭh', 0x0921: 'ḍ', 0x0922: 'ḍh', 0x0923: 'ṇ',
  0x0924: 't', 0x0925: 'th', 0x0926: 'd', 0x0927: 'dh', 0x0928: 'n',
  0x0929: 'ṉ', 0x092a: 'p', 0x092b: 'ph', 0x092c: 'b', 0x092d: 'bh',
  0x092e: 'm', 0x092f: 'y', 0x0930: 'r', 0x0931: 'ṟ', 0x0932: 'l',
  0x0933: 'ḷ', 0x0934: 'ḻ', 0x0935: 'v', 0x0936: 'ś', 0x0937: 'ṣ',
  0x0938: 's', 0x0939: 'h',
};

const DEVA_VOWELS = {
  0x0905: 'a', 0x0906: 'ā', 0x0907: 'i', 0x0908: 'ī', 0x0909: 'u',
  0x090a: 'ū', 0x090b: 'ṛ', 0x090c: 'ḷ', 0x090f: 'e', 0x0910: 'ai',
  0x0913: 'o', 0x0914: 'au', 0x090d: 'ê', 0x0911: 'ô',
};

const DEVA_MATRAS = {
  0x093e: 'ā', 0x093f: 'i', 0x0940: 'ī', 0x0941: 'u', 0x0942: 'ū',
  0x0943: 'ṛ', 0x0947: 'e', 0x0948: 'ai', 0x094b: 'o', 0x094c: 'au',
  0x0945: 'ê', 0x0949: 'ô', 0x0946: 'e', 0x094a: 'o',
};

const DEVA_SIGNS = {
  0x0902: 'ṃ', 0x0901: 'm̐', 0x0903: 'ḥ', 0x0964: '.',
  0x0965: '..', 0x093d: "'",
};

const VIRAMA = 0x094d;
const NUKTA = 0x093c;

/**
 * The nukta modifies the consonant *before* it — ड + ़ is ṛ, not "ḍa" then
 * nothing. It must never flush the inherent vowel, or "पढ़ें" comes out as
 * "paḍhaeṃ" instead of "paṛheṃ".
 */
const NUKTA_FORMS = {
  k: 'q', kh: 'x', g: 'ġ', j: 'z', ḍ: 'ṛ', ḍh: 'ṛh', ph: 'f', r: 'ṟ',
};

/**
 * Characters that sit outside the shared Brahmi alignment and need their own
 * mapping. Gurmukhi carries the load here: tippi and addak have no Devanagari
 * counterpart at the same offset.
 */
const SCRIPT_EXCEPTIONS = {
  0x0a70: { text: 'ṃ' },                      // Gurmukhi tippi (nasal)
  0x0a71: { geminateNext: true },              // Gurmukhi addak
  0x0a3c: { nukta: true },                    // Gurmukhi nukta
  0x0b3c: { nukta: true },                    // Odia nukta
  0x09bc: { nukta: true },                    // Bengali nukta
  0x0abc: { nukta: true },                    // Gujarati nukta
};

/** Devanagari digits and their aligned equivalents in other scripts. */
function digitFor(cp, base) {
  const offset = cp - base;
  if (offset >= 0x66 && offset <= 0x6f) return String(offset - 0x66);
  return null;
}

/**
 * Transliterate Indic text to Latin (ISO 15919-flavoured).
 * Works offline, with no model and no network.
 */
/**
 * Scripts whose modern languages drop the word-final inherent vowel.
 *
 * These scripts write an inherent "a" after every bare consonant, but Hindi,
 * Marathi, Bengali and their relatives stopped pronouncing it centuries ago —
 * प्रयोग is "prayog", not "prayoga". The Dravidian scripts are deliberately
 * absent: Tamil, Telugu, Kannada and Malayalam do pronounce it.
 */
const FINAL_SCHWA_BASES = new Set([0x0900, 0x0980, 0x0a00, 0x0a80, 0x0b00]);

/**
 * Scripts that also drop schwas *inside* words.
 *
 * Only Devanagari here. Medial deletion is regular and well documented for
 * Hindi and Marathi (म्हणतात is "mhaṇtāt"), but Gujarati, Bengali, Gurmukhi and
 * Odia follow different patterns — applying the Hindi rule to them turns
 * ગુજરાતી into "gujrātī" instead of "gujarātī".
 */
const MEDIAL_SCHWA_BASES = new Set([0x0900]);

/** Consonant classes, for turning anusvara into the nasal actually spoken. */
const CONSONANT_CLASSES = {
  'ṅ': ['k', 'kh', 'g', 'gh', 'ṅ'],
  'ñ': ['c', 'ch', 'j', 'jh', 'ñ'],
  'ṇ': ['ṭ', 'ṭh', 'ḍ', 'ḍh', 'ṇ'],
  'n': ['t', 'th', 'd', 'dh', 'n'],
  'm': ['p', 'ph', 'b', 'bh', 'm'],
};

const NASAL_FOR_CONSONANT = {};
for (const [nasal, members] of Object.entries(CONSONANT_CLASSES)) {
  for (const c of members) NASAL_FOR_CONSONANT[c] = nasal;
}

/*
 * Tokens carry the structure schwa deletion needs:
 *   C  consonant
 *   V  explicit vowel (independent letter or matra)
 *   A  inherent schwa, provisional until we know it survives
 *   M  anusvara / candrabindu / visarga
 *   O  anything else (digits, punctuation)
 */

const isVowelToken = (t) => !!t && !t.deleted && (t.t === 'V' || t.t === 'A');

/**
 * Delete inherent vowels the way the language actually speaks them.
 *
 * Two rules, applied right to left so each decision sees the ones already
 * made to its right:
 *
 *   1. A word-final schwa goes, as long as the word keeps another vowel.
 *      प्रयोग is "prayog", not "prayoga".
 *   2. A medial schwa in the pattern V C _ C V goes. म्हणतात is "mhaṇtāt",
 *      not "mhaṇatāta"; बदलते is "badalte", not "badalate".
 *
 * A schwa followed by anusvara is nasalised and always spoken, so it stays.
 */
function deleteSchwas(tokens, allowMedial) {
  const countVowels = () => tokens.filter(isVowelToken).length;

  // Index of the next vowel slot to the right, deleted or not — a deleted one
  // still tells us that syllable lost its vowel.
  const nextVowelSlot = (i) => {
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].t === 'V' || tokens[j].t === 'A') return j;
    }
    return -1;
  };

  let stopped = false;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (!tok || tok.deleted || tok.t !== 'A') continue;

    const slot = nextVowelSlot(i);

    // Rule 1 — word-final schwa, as long as the word keeps a vowel.
    if (slot === -1) {
      let trailing = false;
      for (let j = i + 1; j < tokens.length; j++) {
        if (!tokens[j].deleted && (tokens[j].t === 'C' || tokens[j].t === 'M')) {
          trailing = true;
          break;
        }
      }
      // A trailing anusvara nasalises the schwa, so it is still spoken.
      if (!trailing && countVowels() > 1) tok.deleted = true;
      continue;
    }

    if (stopped || !allowMedial) continue;

    // Rule 2 — medial schwa in V C _ C V, under three constraints.
    const prev = tokens[i - 1];
    const eligible = (() => {
      if (!prev || prev.deleted || prev.t !== 'C') return false;

      // The syllable before must itself have a vowel.
      let vowelBefore = false;
      for (let j = i - 2; j >= 0; j--) {
        if (isVowelToken(tokens[j])) { vowelBefore = true; break; }
      }
      if (!vowelBefore) return false;

      // The next syllable must keep its vowel: two schwas in a row cannot both
      // go, or उदाहरणे would collapse to "udāhrṇe" instead of "udāharṇe".
      if (tokens[slot].t === 'A' && tokens[slot].deleted) return false;
      if (!isVowelToken(tokens[slot])) return false;

      // Exactly one consonant may separate this schwa from that vowel.
      // Deleting before an existing cluster produces unsayable runs —
      // परस्पर would become "parspar" rather than "paraspar".
      let consonants = 0;
      for (let j = i + 1; j < slot; j++) {
        if (!tokens[j].deleted && tokens[j].t === 'C') consonants++;
        if (!tokens[j].deleted && tokens[j].t === 'M') return false;
      }
      return consonants === 1;
    })();

    if (eligible) tok.deleted = true;
    // Once a medial schwa survives, the ones further left survive too:
    // deletion works inward from the end of the word, not everywhere at once.
    else stopped = true;
  }
}

/**
 * Anusvara takes the sound of the consonant that follows it, so संबंध is
 * "sambandh" rather than the technically-correct but unreadable "saṃbaṃdh".
 */
function applyHomorganicNasals(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.deleted || tok.t !== 'M' || tok.s !== 'ṃ') continue;

    let j = i + 1;
    while (j < tokens.length && tokens[j].deleted) j++;
    const next = tokens[j];
    if (!next || next.t !== 'C') continue;

    const nasal = NASAL_FOR_CONSONANT[next.s];
    if (nasal) tok.s = nasal;
  }
}

function renderWord(tokens, { final, medial }) {
  if (final) deleteSchwas(tokens, medial);
  applyHomorganicNasals(tokens);
  return tokens.filter((t) => !t.deleted).map((t) => t.s).join('');
}

/**
 * Transliterate Indic text to Latin letters, following pronunciation.
 *
 * Works offline, with no model and no network.
 *
 * @param {string} text
 * @param {{schwaDeletion?: boolean}} options
 *   `schwaDeletion` defaults to true, which is right for every modern
 *   language. Turn it off for Sanskrit, where every inherent vowel is spoken.
 */
export function transliterate(text, options = {}) {
  const { schwaDeletion = true } = options;
  if (!text) return '';

  let out = '';
  let word = [];
  let wordBase = null;
  let geminateNext = false;

  const lastConsonant = () => {
    for (let i = word.length - 1; i >= 0; i--) {
      if (word[i].t === 'C') return word[i];
    }
    return null;
  };

  const flushWord = () => {
    if (!word.length) return;
    const rules = {
      final: schwaDeletion && wordBase !== null && FINAL_SCHWA_BASES.has(wordBase),
      medial: schwaDeletion && wordBase !== null && MEDIAL_SCHWA_BASES.has(wordBase),
    };
    out += renderWord(word, rules);
    word = [];
    wordBase = null;
  };

  const applyNukta = () => {
    const c = lastConsonant();
    if (!c) return;
    const replacement = NUKTA_FORMS[c.s];
    if (replacement) c.s = replacement;
  };

  for (const ch of text) {
    const cp = ch.codePointAt(0);

    // Characters outside the shared Brahmi alignment.
    const exception = SCRIPT_EXCEPTIONS[cp];
    if (exception) {
      if (exception.nukta) { applyNukta(); continue; }
      if (exception.geminateNext) { geminateNext = true; continue; }
      word.push({ t: 'M', s: exception.text || '' });
      continue;
    }

    // Which script block is this character in?
    let base = null;
    for (const b of Object.values(SCRIPT_BASES)) {
      if (cp >= b && cp < b + 0x80) { base = b; break; }
    }

    if (base === null) {
      flushWord();
      out += ch;
      continue;
    }

    if (wordBase === null) wordBase = base;

    const digit = digitFor(cp, base);
    if (digit !== null) { word.push({ t: 'O', s: digit }); continue; }

    // Shift into the Devanagari block and look it up once.
    const deva = cp - base + 0x0900;

    if (deva === NUKTA) { applyNukta(); continue; }

    if (DEVA_CONSONANTS[deva]) {
      const c = DEVA_CONSONANTS[deva];
      // A doubled aspirate doubles only the stop: ਸਿੱਖ is "sikkh".
      const doubled = c.endsWith('h') && c.length > 1 ? c.slice(0, -1) + c : c + c;
      word.push({ t: 'C', s: geminateNext ? doubled : c });
      word.push({ t: 'A', s: 'a' });   // provisional inherent vowel
      geminateNext = false;
      continue;
    }

    if (DEVA_VOWELS[deva]) { word.push({ t: 'V', s: DEVA_VOWELS[deva] }); continue; }

    if (DEVA_MATRAS[deva]) {
      // A matra replaces the inherent vowel it follows.
      const last = word[word.length - 1];
      if (last && last.t === 'A') word.pop();
      word.push({ t: 'V', s: DEVA_MATRAS[deva] });
      continue;
    }

    if (deva === VIRAMA) {
      const last = word[word.length - 1];
      if (last && last.t === 'A') word.pop();   // consonant cluster
      continue;
    }

    if (deva in DEVA_SIGNS) {
      const sign = DEVA_SIGNS[deva];
      // The danda is punctuation and ends the word.
      if (deva === 0x0964 || deva === 0x0965) {
        flushWord();
        out += sign;
      } else {
        word.push({ t: 'M', s: sign });
      }
      continue;
    }
  }

  flushWord();
  return out;
}

/** True when transliteration is meaningful for this text. */
export function canTransliterate(text) {
  if (!text) return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    for (const b of Object.values(SCRIPT_BASES)) {
      if (cp >= b && cp < b + 0x80) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Translation                                                         */
/* ------------------------------------------------------------------ */


/**
 * Machine translation.
 *
 * This is the one feature that sends anything off the device, so it is
 * deliberately explicit: nothing is transmitted until the reader asks for a
 * translation, the service that will receive the text is named on screen, and
 * the first request needs consent. People scan Aadhaar cards and bank
 * statements with this app; silently posting a page to a third party would
 * betray the rest of the design.
 *
 * A neural translation model is far too large to ship in a web app, so
 * translation needs a service. The default works with no setup; the other two
 * are for people who want their own key or their own server.
 */

const CHUNK_LIMIT = 450;     // MyMemory rejects much more than 500 per request
const CHUNK_PAUSE_MS = 260;  // be a polite client of a free service

export const TRANSLATION_PROVIDERS = {
  mymemory: {
    name: 'MyMemory (free, no setup)',
    needsKey: false,
    needsUrl: false,
    needsEmail: true,
    note: 'Free translation memory. No account needed; adding an email raises the daily limit.',
  },
  libretranslate: {
    name: 'LibreTranslate (your own server)',
    needsKey: false,
    needsUrl: true,
    note: 'Runs wherever you host it, so the text stays under your control.',
  },
  google: {
    name: 'Google Cloud Translation',
    needsKey: true,
    needsUrl: false,
    note: 'The most accurate option for Indian languages. Needs your own API key, and is billed to you.',
  },
  none: {
    name: 'Off',
    needsKey: false,
    needsUrl: false,
    note: 'No text ever leaves the device.',
  },
};

/**
 * Split text into request-sized pieces without cutting sentences in half.
 *
 * Line structure is preserved so the translated page still looks like the
 * page: headings on their own lines, table rows intact.
 */
export function chunkText(text, limit = CHUNK_LIMIT) {
  const chunks = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };

  for (const line of String(text).split('\n')) {
    if (!line.trim()) {
      if (current) current += '\n';
      continue;
    }

    if (current.length + line.length + 1 <= limit) {
      current += (current ? '\n' : '') + line;
      continue;
    }

    push();

    if (line.length <= limit) { current = line; continue; }

    // A single very long line: break it at sentence ends, then hard-wrap.
    let rest = line;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      let cut = Math.max(
        window.lastIndexOf('। '), window.lastIndexOf('. '),
        window.lastIndexOf('? '), window.lastIndexOf('! '));
      if (cut < limit * 0.4) cut = window.lastIndexOf(' ');
      if (cut < limit * 0.4) cut = limit;
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
    current = rest;
  }

  push();
  return chunks;
}

async function translateChunkMyMemory(chunk, source, target, config) {
  const params = new URLSearchParams({
    q: chunk,
    langpair: `${source || 'autodetect'}|${target}`,
  });
  if (config.email) params.set('de', config.email);

  const res = await fetch(`https://api.mymemory.translated.net/get?${params}`);
  if (!res.ok) throw new Error(`Translation service returned ${res.status}.`);

  const data = await res.json();

  // MyMemory reports quota problems in the body, with a 200 HTTP status. The
  // wording varies ("USED ALL AVAILABLE FREE TRANSLATIONS", "QUERY LENGTH
  // LIMIT EXCEEDED"), so match the shape of the complaint rather than a phrase.
  const status = Number(data.responseStatus);
  const quotaHit = (s) => /limit|quota|used all|too many|exceed/i.test(s || '');

  if (status && status !== 200) {
    const detail = String(data.responseDetails || '');
    if (quotaHit(detail)) {
      throw new Error('Daily free translation limit reached. Add an email in ' +
        'Settings to raise it, or switch to your own key or server.');
    }
    throw new Error(detail || `Translation failed (${status}).`);
  }

  const out = data.responseData && data.responseData.translatedText;
  if (!out) throw new Error('The translation service returned nothing.');

  // The free tier sometimes puts the complaint in the translation itself.
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|USED ALL/i.test(out)) {
    throw new Error('Daily free translation limit reached. Add an email in ' +
      'Settings to raise it, or switch to your own key or server.');
  }

  return out;
}

async function translateChunkLibre(chunk, source, target, config) {
  if (!config.url) throw new Error('Set your LibreTranslate server URL in Settings.');

  const body = {
    q: chunk,
    source: source || 'auto',
    target,
    format: 'text',
  };
  if (config.apiKey) body.api_key = config.apiKey;

  const res = await fetch(`${config.url.replace(/\/+$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Your server returned ${res.status}.`);

  const data = await res.json();
  if (!data.translatedText) throw new Error('The server returned nothing.');
  return data.translatedText;
}

async function translateChunkGoogle(chunk, source, target, config) {
  if (!config.apiKey) throw new Error('Add your Google Cloud API key in Settings.');

  const payload = { q: chunk, target, format: 'text' };
  if (source) payload.source = source;

  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message = detail && detail.error && detail.error.message;
    throw new Error(message || `Translation failed (${res.status}).`);
  }

  const data = await res.json();
  const out = data.data.translations[0].translatedText;

  // Google escapes entities even in text mode.
  return out.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const CHUNK_TRANSLATORS = {
  mymemory: translateChunkMyMemory,
  libretranslate: translateChunkLibre,
  google: translateChunkGoogle,
};

/**
 * Translate a block of text.
 *
 * @param {string} text
 * @param {Object} options
 *   target    ISO 639-1 code to translate into, e.g. "en"
 *   source    ISO 639-1 code of the text, or null to let the service guess
 *   provider  key of TRANSLATION_PROVIDERS
 *   url       LibreTranslate server, when that provider is selected
 *   apiKey    key, for providers that need one
 *   email     optional, raises the MyMemory free limit
 *   onProgress({done, total})
 *   signal    AbortSignal
 * @returns {Promise<string>}
 */
export async function translate(text, options = {}) {
  const {
    target, source = null, provider = 'mymemory',
    onProgress = null, signal = null,
  } = options;

  if (!text || !text.trim()) return '';
  if (provider === 'none') {
    throw new Error('Translation is switched off. Choose a provider in Settings.');
  }
  if (!target) throw new Error('Pick a language to translate into.');

  const translateChunk = CHUNK_TRANSLATORS[provider];
  if (!translateChunk) throw new Error('Unknown translation provider.');

  if (!navigator.onLine) {
    throw new Error('Translation needs a connection. Transliteration works offline.');
  }

  // Translating into the language it is already in is a no-op.
  if (source && source === target) return text;

  const chunks = chunkText(text);
  const out = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal && signal.aborted) throw new Error('Translation cancelled.');
    if (onProgress) onProgress({ done: i, total: chunks.length });

    out.push(await translateChunk(chunks[i], source, target, options));

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
    }
  }

  if (onProgress) onProgress({ done: chunks.length, total: chunks.length });
  return out.join('\n');
}
