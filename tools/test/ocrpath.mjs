/** Compare OCR input preparation strategies to pick the best app path. */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://localhost:8099';

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const out = await page.evaluate(async (base) => {
  const { detectEdges, warp, applyFilter, prepareForOcr } = await import('/js/core/pipeline.js');
  const { ocrEngine } = await import('/js/core/ocr.js');

  const img = new Image();
  img.src = `${base}/tools/test/test_photo.jpg`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);

  const det = await detectEdges(data);
  const warped = await warp(data, det.corners, { maxDim: 2400 });
  const autoFiltered = await applyFilter(warped, 'auto');
  const bwFiltered = await applyFilter(warped, 'bw');

  const variants = {
    'warped raw -> prep':        await prepareForOcr(warped),
    'warped raw (no prep)':      warped,
    'auto filter -> prep':       await prepareForOcr(autoFiltered),
    'auto filter (no prep)':     autoFiltered,
    'bw filter (no prep)':       bwFiltered,
  };

  const expected = ['भारत','सरकार','आयकर','विभाग','दस्तावेज़','पंजीकरण','कृपया','ध्यान',
    'GOVERNMENT','INDIA','INV-2026-0417','14,500.00','office@example.in','Paper','Total','10,000'];

  const results = [];
  for (const [name, canvas] of Object.entries(variants)) {
    const t0 = performance.now();
    const r = await ocrEngine.recognize(canvas, ['hin']);
    const ms = performance.now() - t0;
    const miss = expected.filter((t) => !r.text.includes(t));
    results.push({
      name, ms: Math.round(ms),
      recall: `${expected.length - miss.length}/${expected.length}`,
      conf: r.confidence.toFixed(1),
      words: r.words.filter((w) => !w.noise).length,
      miss: miss.join(', '),
    });
  }
  return results;
}, BASE);

console.log('\nOCR input preparation comparison\n');
for (const r of out) {
  console.log(`  ${r.name.padEnd(24)} recall ${r.recall.padEnd(6)} conf ${r.conf.padStart(5)}  ` +
              `${String(r.ms).padStart(5)}ms  ${r.words}w  ${r.miss ? 'miss: ' + r.miss : '✓'}`);
}

await browser.close();
