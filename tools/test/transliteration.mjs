/**
 * Transliteration tests.
 *
 * Devanagari writes an inherent "a" after every bare consonant, but Hindi and
 * Marathi stopped pronouncing most of them centuries ago. A letter-for-letter
 * transliteration therefore reads wrong to a speaker — प्रयोग comes out
 * "prayoga" instead of "prayog". These cases are taken from a real scanned
 * Marathi grammar page.
 */
import { transliterate } from '../../js/core/lens.js';

const results = [];
function check(name, got, want, { known = false } = {}) {
  const pass = got === want;
  results.push({ pass, known });
  const mark = pass ? 'PASS' : (known ? 'KNOWN' : 'FAIL');
  console.log(`  ${mark.padEnd(5)} ${name.padEnd(16)} ${got}` +
              (pass ? '' : `   (expected ${want})`));
}

console.log('\n=== Marathi: schwa deletion ===');
const MARATHI = [
  ['प्रयोग', 'prayog'], ['क्रियापद', 'kriyāpad'], ['म्हणतात', 'mhaṇtāt'],
  ['बदलते', 'badalte'], ['शब्द', 'śabd'], ['वचन', 'vacan'],
  ['कर्म', 'karm'], ['भाषेत', 'bhāṣet'], ['कर्ता', 'kartā'],
  ['आणि', 'āṇi'], ['करणारा', 'karṇārā'], ['उदाहरणे', 'udāharṇe'],
  ['मारले', 'mārle'], ['खातो', 'khāto'], ['रामाने', 'rāmāne'],
];
for (const [deva, want] of MARATHI) check(deva, transliterate(deva), want);

console.log('\n=== Consonant clusters must not be over-collapsed ===');
// Deleting these schwas would create unsayable three-consonant runs.
const CLUSTERS = [
  ['परस्पर', 'paraspar'], ['आधारस्तंभ', 'ādhārastambh'],
  ['विभक्तीत', 'vibhaktīt'], ['ओलखण्याची', 'olakhaṇyācī'],
];
for (const [deva, want] of CLUSTERS) check(deva, transliterate(deva), want);

console.log('\n=== Anusvara takes the sound of what follows ===');
const NASALS = [
  ['संबंधाला', 'sambandhālā'], ['आंबा', 'āmbā'],
  ['नपुंसकलिंगी', 'napuṃsakliṅgī'], ['अंक', 'aṅk'],
];
for (const [deva, want] of NASALS) check(deva, transliterate(deva), want);

console.log('\n=== Sanskrit keeps every inherent vowel ===');
const SANSKRIT = [
  ['रामायणम्', 'rāmāyaṇam'], ['भगवद्गीता', 'bhagavadgītā'], ['नमस्ते', 'namaste'],
];
for (const [deva, want] of SANSKRIT) {
  check(deva, transliterate(deva, { schwaDeletion: false }), want);
}

console.log('\n=== Scripts that do pronounce the inherent vowel ===');
const OTHER = [
  ['தமிழ்', 'tamiḻ'], ['ಕನ್ನಡ', 'kannaḍa'], ['తెలుగు', 'telugu'],
  ['മലയാളം', 'malayāḷaṃ'], ['ਪੰਜਾਬੀ', 'pañjābī'], ['ગુજરાતી', 'gujarātī'],
];
for (const [word, want] of OTHER) check(word, transliterate(word), want);

console.log('\n=== Nukta and gemination ===');
for (const [word, want] of [['पढ़ें', 'paṛheṃ'], ['ज़रूरी', 'zarūrī'],
  ['फ़ोन', 'fon'], ['क़ानून', 'qānūn'], ['ਸਿੱਖ', 'sikkh']]) {
  check(word, transliterate(word), want);
}

console.log('\n=== Whole line from the scan ===');
const line = 'कर्ता, कर्म आणि क्रियापद परस्पर संबंधाला "प्रयोग" म्हणतात.';
const want = 'kartā, karm āṇi kriyāpad paraspar sambandhālā "prayog" mhaṇtāt.';
check('sentence', transliterate(line), want);

console.log('\n=== Known limits (compounds and proper names need a lexicon) ===');
// Rule-based schwa deletion cannot see morpheme boundaries. These are
// documented rather than silently wrong.
check('रावणास', transliterate('रावणास'), 'rāvaṇās', { known: true });
check('तृतीयपुरुषी', transliterate('तृतीयपुरुषी'), 'tṛtīyapuruṣī', { known: true });

const hard = results.filter((r) => !r.pass && !r.known).length;
const known = results.filter((r) => !r.pass && r.known).length;
console.log(`\n${results.length - hard - known}/${results.length - known} checks passed` +
            (known ? `  (${known} known lexical limits)` : ''));
process.exit(hard ? 1 : 0);
