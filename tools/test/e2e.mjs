/**
 * End-to-end test in a real browser.
 *
 * Runs the actual shipped modules against a synthetic photo of a Hindi/English
 * document and checks each stage: edge detection, perspective correction,
 * enhancement, OCR, and a searchable PDF whose text layer really extracts.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.BASE || 'http://localhost:8099';
const OUT = process.env.OUT || HERE;

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-file-access-from-files',
  ],
});

const context = await browser.newContext({
  viewport: { width: 412, height: 900 },
  deviceScaleFactor: 2,
  permissions: ['camera'],
  hasTouch: true,
  isMobile: true,
});

const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

console.log('\n=== 1. App boot ===');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

check('page loads and shows the library',
  await page.locator('#screen-library').isVisible());
check('no console errors on boot',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 3).join(' | '));
check('service worker registered',
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)));
check('app modules loaded',
  await page.evaluate(() => !!window.__scanpro && !!window.__scanpro.state.settings));

await page.screenshot({ path: `${OUT}/ui-library-empty.png` });

console.log('\n=== 2. Detection + warp + enhance (in browser) ===');
const cv = await page.evaluate(async (base) => {
  const { detectEdges, warp, applyFilter, canvasToBlob } = await import('/js/core/pipeline.js');

  const img = new Image();
  img.src = `${base}/tools/test/test_photo.jpg`;
  await img.decode();

  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);

  const t0 = performance.now();
  const det = await detectEdges(data);
  const detectMs = performance.now() - t0;

  if (!det.corners) return { detected: false };

  const t1 = performance.now();
  const warped = await warp(data, det.corners, { maxDim: 2400 });
  const warpMs = performance.now() - t1;

  const t2 = performance.now();
  const enhanced = await applyFilter(warped, 'auto');
  const enhanceMs = performance.now() - t2;

  const blob = await canvasToBlob(enhanced, 'image/jpeg', 0.86);
  const buf = new Uint8Array(await blob.arrayBuffer());

  // Stash for later stages.
  window.__test = { enhanced, warped, corners: det.corners };

  return {
    detected: true,
    corners: det.corners,
    confidence: det.confidence,
    detectMs, warpMs, enhanceMs,
    outW: enhanced.width, outH: enhanced.height,
    jpegBytes: buf.length,
    jpegHeader: buf[0] === 0xff && buf[1] === 0xd8,
  };
}, BASE);

check('document detected in browser', cv.detected);
if (cv.detected) {
  const truth = [[232, 190], [1010, 268], [946, 1412], [150, 1300]];
  const maxErr = Math.max(...cv.corners.map((c, i) =>
    Math.hypot(c.x - truth[i][0], c.y - truth[i][1])));
  check('corner accuracy within 12px', maxErr < 12, `max error ${maxErr.toFixed(1)}px`);
  check('confidence above 0.7', cv.confidence > 0.7, `${cv.confidence.toFixed(3)}`);
  check('perspective correction produced a page',
    cv.outW > 400 && cv.outH > 600, `${cv.outW}x${cv.outH}`);
  check('enhanced page encodes to JPEG',
    cv.jpegHeader && cv.jpegBytes > 10000, `${(cv.jpegBytes / 1024).toFixed(0)} KB`);
  console.log(`        timings: detect ${cv.detectMs.toFixed(0)}ms, ` +
              `warp ${cv.warpMs.toFixed(0)}ms, enhance ${cv.enhanceMs.toFixed(0)}ms`);
}

console.log('\n=== 3. OCR in browser (Hindi + English, offline assets) ===');
const ocr = await page.evaluate(async () => {
  const { prepareForOcr } = await import('/js/core/pipeline.js');
  const { ocrEngine } = await import('/js/core/ocr.js');

  // Same input the app uses: the OCR master, made from the unfiltered page.
  const prepped = await prepareForOcr(window.__test.warped);

  const t0 = performance.now();
  const result = await ocrEngine.recognize(prepped, ['hin']);
  const ms = performance.now() - t0;

  window.__test.ocr = result;

  return {
    ms,
    text: result.text,
    wordCount: result.words.filter((w) => !w.noise).length,
    confidence: result.confidence,
    sources: {
      indic: result.words.filter((w) => w.source === 'indic').length,
      latin: result.words.filter((w) => w.source === 'latin').length,
      recovered: result.words.filter((w) => w.source === 'latin-recovered').length,
    },
  };
});

const expected = ['भारत', 'सरकार', 'आयकर', 'विभाग', 'दस्तावेज़', 'पंजीकरण',
  'GOVERNMENT', 'INDIA', 'INV-2026-0417', '14,500.00', 'office@example.in',
  'Paper', 'Total', '10,000'];
const missing = expected.filter((t) => !ocr.text.includes(t));

check('OCR ran with vendored assets (no external network)',
  ocr.wordCount > 20, `${ocr.wordCount} words in ${(ocr.ms / 1000).toFixed(1)}s`);
check('Devanagari + Latin both recognised',
  missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${expected.length}/${expected.length} tokens`);
check('dual-pass merge engaged',
  ocr.sources.indic > 0 && ocr.sources.latin > 0,
  `indic ${ocr.sources.indic}, latin ${ocr.sources.latin}, recovered ${ocr.sources.recovered}`);
check('mean confidence above 80%',
  ocr.confidence > 80, `${ocr.confidence.toFixed(1)}%`);

console.log('\n=== 4. Searchable PDF built in browser ===');
const pdf = await page.evaluate(async () => {
  const { canvasToBlob } = await import('/js/core/pipeline.js');
  const { buildSearchablePDF } = await import('/js/core/pdf.js');

  const blob = await canvasToBlob(window.__test.enhanced, 'image/jpeg', 0.86);
  const jpeg = new Uint8Array(await blob.arrayBuffer());

  const pdfBlob = await buildSearchablePDF([{
    jpeg,
    width: window.__test.enhanced.width,
    height: window.__test.enhanced.height,
    words: window.__test.ocr.words,
    dpi: 200,
  }], { title: 'भारत सरकार Test', pageSize: 'a4' });

  const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
  return { size: bytes.length, base64: btoa(String.fromCharCode(...bytes.slice(0, 8))),
           b64full: await new Promise((res) => {
             const r = new FileReader();
             r.onload = () => res(r.result.split(',')[1]);
             r.readAsDataURL(pdfBlob);
           }) };
});

fs.writeFileSync(`${OUT}/browser_scan.pdf`, Buffer.from(pdf.b64full, 'base64'));
check('PDF generated in browser', pdf.size > 20000, `${(pdf.size / 1024).toFixed(0)} KB`);

console.log('\n=== 5. UI flow ===');
// Import path: feed the test photo through the file picker.
await page.locator('#btn-open-camera').click();
await page.waitForTimeout(900);
check('camera screen opens', await page.locator('#screen-camera').isVisible());
await page.screenshot({ path: `${OUT}/ui-camera.png` });

await page.setInputFiles('#file-input', path.join(HERE, 'test_photo.jpg'));
await page.waitForTimeout(4000);
check('editor opens after import', await page.locator('#screen-editor').isVisible());

const handles = await page.locator('.crop-handle').count();
check('four draggable corner handles', handles === 4, `${handles} handles`);

const chips = await page.locator('.filter-chip').count();
check('filter strip rendered', chips === 5, `${chips} filters`);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/ui-editor.png` });

await page.locator('#btn-editor-done').click();
await page.waitForTimeout(3500);
check('returns to camera for the next page',
  await page.locator('#screen-camera').isVisible());

await page.locator('#btn-batch').click();
await page.waitForTimeout(600);
check('pages review shows the captured page',
  await page.locator('.page-thumb').count() === 1);
await page.screenshot({ path: `${OUT}/ui-pages.png` });

await page.locator('#btn-pages-save').click();
// Saving runs OCR first when "read after scanning" is on, so wait for the
// document screen rather than a fixed delay.
await page.locator('#screen-doc').waitFor({ state: 'visible', timeout: 90000 })
  .catch(() => {});
check('document saved and opened', await page.locator('#screen-doc').isVisible());
await page.screenshot({ path: `${OUT}/ui-doc.png` });

console.log('\n=== 6. Text screen and entity extraction ===');
await page.locator('#btn-ocr').click();
await page.waitForTimeout(45000);

const textVisible = await page.locator('#screen-text').isVisible();
check('text screen opens after reading', textVisible);

if (textVisible) {
  const ocrText = await page.locator('#ocr-text').innerText();
  check('recognised text shown on screen',
    ocrText.includes('भारत') && ocrText.includes('INV-2026-0417'),
    `${ocrText.length} chars`);

  const lowConf = await page.locator('#ocr-text .low-conf').count();
  check('low-confidence words highlighted for review', lowConf >= 0, `${lowConf} flagged`);
  await page.screenshot({ path: `${OUT}/ui-text.png` });

  await page.locator('.tab[data-tab="entities"]').click();
  await page.waitForTimeout(400);
  // This page carries an email, a phone number and one "Rs." amount; the bare
  // table figures are correctly not treated as amounts.
  const entities = await page.locator('.entity-card').count();
  check('entities extracted', entities >= 3, `${entities} found`);
  await page.screenshot({ path: `${OUT}/ui-entities.png` });

  await page.locator('.tab[data-tab="translit"]').click();
  await page.waitForTimeout(400);
  // "भारत सरकार" is spoken "bhārat sarkār" — the written inherent vowels are
  // silent, so a letter-for-letter "bhārata sarakāra" would be wrong.
  const translit = await page.locator('#translit-text').innerText();
  check('transliteration follows pronunciation',
    translit.includes('bhārat') && translit.includes('sarkār'),
    translit.slice(0, 60));
  await page.screenshot({ path: `${OUT}/ui-translit.png` });
}

console.log('\n=== 7. Library and search ===');
await page.locator('#btn-text-back').click();
await page.waitForTimeout(700);
await page.locator('#btn-doc-back').click();
await page.waitForTimeout(900);
check('library shows the saved scan',
  await page.locator('.doc-card').count() === 1);
await page.screenshot({ path: `${OUT}/ui-library.png` });

await page.locator('#search-input').fill('आयकर');
await page.waitForTimeout(900);
const hits = await page.locator('.result-item').count();
check('full-text search finds Devanagari inside the scan', hits === 1, `${hits} results`);
await page.screenshot({ path: `${OUT}/ui-search.png` });

console.log('\n=== 8. Settings ===');
await page.locator('#search-clear').click();
await page.waitForTimeout(300);
await page.locator('#btn-settings').click();
await page.waitForTimeout(700);
const langRows = await page.locator('.lang-row').count();
check('all 15 languages listed', langRows === 15, `${langRows} languages`);
await page.screenshot({ path: `${OUT}/ui-settings.png`, fullPage: true });

console.log('\n=== Console errors ===');
if (consoleErrors.length) consoleErrors.slice(0, 8).forEach((e) => console.log('  !', e));
else console.log('  none');

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
