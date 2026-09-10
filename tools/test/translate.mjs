/**
 * Translation tests.
 *
 * The translation service is intercepted rather than called for real, so these
 * verify what the app controls: splitting long pages into request-sized
 * chunks without breaking sentences, reassembling them, reading each
 * provider's response shape, surfacing quota errors, and — most importantly —
 * never sending anything before the reader consents.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.BASE || 'http://localhost:8099';

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 412, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  ! pageerror', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

console.log('\n=== Chunking ===');
const chunking = await page.evaluate(async () => {
  const { chunkText } = await import('/js/core/lens.js');

  const lines = Array.from({ length: 40 },
    (_, i) => `ओळ ${i + 1}: प्रयोग व प्रकार सोप्या भाषेत सांगितले आहेत.`);
  const page1 = lines.join('\n');
  const chunks = chunkText(page1);

  const longSentence = 'क्रियापद '.repeat(200);
  const longChunks = chunkText(longSentence);

  return {
    count: chunks.length,
    maxLen: Math.max(...chunks.map((c) => c.length)),
    // Nothing may be lost: same non-space characters in, same out.
    lossless: chunks.join('\n').replace(/\s+/g, '') === page1.replace(/\s+/g, ''),
    linesIntact: chunks.every((c) => c.split('\n').every((l) => !l.trim() ||
      /^ओळ \d+: /.test(l))),
    longMax: Math.max(...longChunks.map((c) => c.length)),
    shortText: chunkText('नमस्ते').length,
    empty: chunkText('').length,
  };
});

check('long page split into several requests', chunking.count > 1, `${chunking.count} chunks`);
check('every chunk within the service limit', chunking.maxLen <= 450,
  `longest ${chunking.maxLen} chars`);
check('no text lost when splitting', chunking.lossless);
check('lines are not cut mid-way', chunking.linesIntact);
check('a single huge line is broken up too', chunking.longMax <= 450,
  `longest ${chunking.longMax} chars`);
check('short text stays one request', chunking.shortText === 1);
check('empty text makes no request', chunking.empty === 0);

console.log('\n=== MyMemory provider ===');
await page.route('**/api.mymemory.translated.net/**', async (route) => {
  const url = new URL(route.request().url());
  const q = url.searchParams.get('q') || '';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      responseStatus: 200,
      responseData: { translatedText: `[EN]${q}` },
    }),
  });
});

const mymemory = await page.evaluate(async () => {
  const { translate } = await import('/js/core/lens.js');
  const progress = [];
  const out = await translate('भारत सरकार\nआयकर विभाग', {
    target: 'en', source: 'mr', provider: 'mymemory',
    onProgress: (p) => progress.push(p),
  });
  return { out, progress: progress.length };
});
check('MyMemory response parsed', mymemory.out.startsWith('[EN]'), mymemory.out.slice(0, 40));
check('progress reported', mymemory.progress >= 2, `${mymemory.progress} updates`);

const langpair = await page.evaluate(async () => {
  let seen = null;
  const orig = window.fetch;
  window.fetch = (u, o) => { seen = String(u); return orig(u, o); };
  const { translate } = await import('/js/core/lens.js');
  await translate('चाचणी', { target: 'en', source: 'mr', provider: 'mymemory' });
  window.fetch = orig;
  return seen;
});
check('source language taken from what the page was read in',
  langpair.includes('langpair=mr%7Cen') || langpair.includes('langpair=mr|en'),
  decodeURIComponent(langpair.split('langpair=')[1] || ''));

console.log('\n=== Quota and error handling ===');
await page.unroute('**/api.mymemory.translated.net/**');
await page.route('**/api.mymemory.translated.net/**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    responseStatus: 403,
    responseDetails: 'YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY',
  }),
}));

const quota = await page.evaluate(async () => {
  const { translate } = await import('/js/core/lens.js');
  try {
    await translate('चाचणी', { target: 'en', source: 'mr', provider: 'mymemory' });
    return 'no error';
  } catch (e) { return e.message; }
});
check('daily limit explained in plain words',
  /limit/i.test(quota) && /Settings|provider/i.test(quota), quota.slice(0, 70));

const off = await page.evaluate(async () => {
  const { translate } = await import('/js/core/lens.js');
  try {
    await translate('चाचणी', { target: 'en', provider: 'none' });
    return 'no error';
  } catch (e) { return e.message; }
});
check('"off" provider refuses to send anything', /switched off/i.test(off), off.slice(0, 60));

const same = await page.evaluate(async () => {
  const { translate } = await import('/js/core/lens.js');
  return translate('hello', { target: 'en', source: 'en', provider: 'mymemory' });
});
check('translating into its own language is a no-op', same === 'hello');

console.log('\n=== Google and LibreTranslate response shapes ===');
await page.route('**/translation.googleapis.com/**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    data: { translations: [{ translatedText: 'It&#39;s working &amp; escaped' }] },
  }),
}));
await page.route('**/my-libre.example/**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ translatedText: 'from my own server' }),
}));

const shapes = await page.evaluate(async () => {
  const { translate } = await import('/js/core/lens.js');
  const google = await translate('चाचणी', {
    target: 'en', source: 'mr', provider: 'google', apiKey: 'test-key',
  });
  const libre = await translate('चाचणी', {
    target: 'en', source: 'mr', provider: 'libretranslate',
    url: 'https://my-libre.example',
  });
  return { google, libre };
});
check('Google response parsed and unescaped',
  shapes.google === "It's working & escaped", shapes.google);
check('LibreTranslate response parsed', shapes.libre === 'from my own server');

const noKey = await page.evaluate(async () => {
  const { translate } = await import('/js/core/lens.js');
  try {
    await translate('चाचणी', { target: 'en', provider: 'google' });
    return 'no error';
  } catch (e) { return e.message; }
});
check('missing API key explained', /API key/i.test(noKey), noKey.slice(0, 50));

console.log('\n=== Consent: nothing is sent before the reader agrees ===');
let requestsMade = 0;
page.on('request', (r) => {
  if (r.url().includes('mymemory') || r.url().includes('googleapis')) requestsMade++;
});

// Back to a working service for the consent flow.
await page.unroute('**/api.mymemory.translated.net/**');
await page.route('**/api.mymemory.translated.net/**', (route) => {
  const q = new URL(route.request().url()).searchParams.get('q') || '';
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      responseStatus: 200,
      responseData: { translatedText: `Doer, object and verb are called "usage".` },
    }),
  });
});

// Seed a scan with Marathi text, then open the Text screen.
await page.evaluate(async () => {
  const db = await import('/js/core/db.js');
  await db.setSetting('translateConsent', false);
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const panel = await page.evaluate(async () => {
  const view = window.__scanproText;
  if (!view) return { missing: true };

  // Navigate to the text screen the way the router would.
  document.querySelectorAll('.screen').forEach((s) => {
    s.hidden = s.dataset.screen !== 'text';
  });

  view.show({
    text: 'कर्ता, कर्म आणि क्रियापद परस्पर संबंधाला "प्रयोग" म्हणतात.',
    words: [], confidence: 90, langs: ['mar'],
  }, { title: 'Test', pageCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  document.querySelector('.tab[data-tab="translate"]').click();
  await new Promise((r) => setTimeout(r, 200));
  return {
    tabVisible: !!document.querySelector('[data-panel="translate"].active'),
    note: document.querySelector('#translate-note').textContent,
    buttonEnabled: !document.querySelector('#btn-translate').disabled,
    targets: document.querySelector('#translate-target').options.length,
  };
});

check('Translate tab present and reachable', !panel.missing && panel.tabVisible);
check('all 15 target languages offered', panel.targets === 15, `${panel.targets} options`);
check('panel names the service before use',
  /MyMemory/i.test(panel.note), panel.note.slice(0, 60) + '…');
check('panel warns about sensitive documents',
  /Aadhaar|PAN|bank/i.test(panel.note));
check('nothing sent while merely viewing the tab', requestsMade === 0,
  `${requestsMade} requests`);

await page.locator('#btn-translate').click();
await page.waitForTimeout(700);
const sheetOpen = await page.locator('#sheet').isVisible();
check('tapping Translate asks for consent first', sheetOpen);
check('still nothing sent while the prompt is open', requestsMade === 0,
  `${requestsMade} requests`);

// Decline: still nothing should go out.
await page.locator('#sheet-backdrop').click();
await page.waitForTimeout(500);
check('declining sends nothing', requestsMade === 0, `${requestsMade} requests`);

// Accept, and it should translate.
await page.locator('#btn-translate').click();
await page.waitForTimeout(500);
await page.locator('.sheet-item').first().click();
await page.waitForTimeout(2500);

const after = await page.evaluate(() => ({
  shown: !document.querySelector('#translate-text').hidden,
  text: document.querySelector('#translate-text').textContent,
  button: document.querySelector('#btn-translate').textContent,
}));

check('consenting sends the request', requestsMade > 0, `${requestsMade} requests`);
check('translation displayed', after.shown && after.text.length > 0,
  after.text.slice(0, 50));
check('consent remembered for next time',
  await page.evaluate(async () => {
    const db = await import('/js/core/db.js');
    return (await db.getSettings()).translateConsent === true;
  }));
check('button offers a re-run', /again/i.test(after.button), after.button);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
