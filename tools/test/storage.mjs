/**
 * Storage resilience test.
 *
 * Reproduces the failure seen in production: a database that already exists at
 * the current version but carries the wrong object stores — which happens when
 * another app on the same origin (GitHub Pages shares one origin across every
 * project) claimed the name, or when a first load was interrupted mid-upgrade.
 *
 * Because `onupgradeneeded` only fires when the version rises, that state is
 * permanent and every transaction throws NotFoundError forever. The app must
 * detect it and repair itself.
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

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\n=== Storage collision and repair ===');

// Boot once to learn the path-scoped database name the app actually uses.
await page.goto(BASE, { waitUntil: 'networkidle' });
const DB = await page.evaluate(async () => (await import('/js/core/db.js')).DB_NAME);
console.log(`  (database name for this deployment: ${DB})`);

// Wipe it, then seed a hostile one: right name, right version, foreign stores
// — and a "pages" store shaped for a different app, which is what production
// actually had. That last part is the nasty case: the store exists, so a
// naive "create missing stores" repair leaves it broken.
const seeded = await page.evaluate(async (name) => {
  await new Promise((res) => {
    const del = indexedDB.deleteDatabase(name);
    del.onsuccess = del.onerror = del.onblocked = () => res();
  });

  await new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('docs', { keyPath: 'id' });
      db.createObjectStore('kv', { keyPath: 'k' });
      db.createObjectStore('pages', { keyPath: 'other' });  // wrong shape
    };
    r.onsuccess = () => { r.result.close(); res(); };
    r.onerror = () => rej(r.error);
  });

  return new Promise((res) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => {
      const store = r.result.transaction(['pages'], 'readonly').objectStore('pages');
      const out = {
        version: r.result.version,
        stores: [...r.result.objectStoreNames],
        pagesKeyPath: store.keyPath,
        pagesIndexes: [...store.indexNames],
      };
      r.result.close();
      res(out);
    };
  });
}, DB);

check('hostile database seeded', seeded.stores.includes('docs'),
  `v${seeded.version} stores: ${seeded.stores.join(', ')}`);
check('seeded "pages" store has the wrong shape',
  seeded.pagesKeyPath === 'other' && seeded.pagesIndexes.length === 0,
  `keyPath="${seeded.pagesKeyPath}", indexes: none`);

// Now boot the app against it.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const after = await page.evaluate(async (name) => new Promise((res) => {
  const r = indexedDB.open(name);
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['pages'], 'readonly');
    const store = tx.objectStore('pages');
    const out = {
      version: db.version,
      stores: [...db.objectStoreNames],
      pagesKeyPath: store.keyPath,
      pagesIndexes: [...store.indexNames],
    };
    db.close();
    res(out);
  };
}), DB);

const required = ['documents', 'pages', 'settings'];
const present = required.filter((s) => after.stores.includes(s));

check('app repaired the schema on boot',
  present.length === required.length,
  `v${after.version} stores: ${after.stores.join(', ')}`);
check('wrong-shaped "pages" store was rebuilt',
  after.pagesKeyPath === 'id' && after.pagesIndexes.includes('docId'),
  `keyPath="${after.pagesKeyPath}", indexes: ${after.pagesIndexes.join(', ')}`);
check('unrelated foreign stores left untouched',
  after.stores.includes('docs') && after.stores.includes('kv'),
  'other data not destroyed');

const notFound = errors.filter((e) => /NotFoundError|object stores was not found/i.test(e));
check('no NotFoundError during boot', notFound.length === 0,
  notFound.length ? notFound[0].slice(0, 90) : 'clean');

// The real test: is the interface actually alive?
check('empty state rendered (library query succeeded)',
  await page.locator('#library-empty').isVisible());

await page.locator('#btn-open-camera').click();
await page.waitForTimeout(1200);
check('camera button responds', await page.locator('#screen-camera').isVisible());

await page.locator('#btn-camera-close').click();
await page.waitForTimeout(800);
await page.locator('#btn-settings').click();
await page.waitForTimeout(900);
check('settings button responds', await page.locator('#screen-settings').isVisible());
check('settings loaded from repaired storage',
  await page.locator('.lang-row').count() === 15);

// A write must survive a reload.
await page.locator('#btn-settings-back').click();
await page.waitForTimeout(500);
const wrote = await page.evaluate(async () => {
  const db = await import('/js/core/db.js');
  await db.setSetting('defaultFilter', 'magic');
  const doc = await db.createDocument('Persistence check');
  return doc.id;
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const persisted = await page.evaluate(async () => {
  const db = await import('/js/core/db.js');
  const s = await db.getSettings();
  const docs = await db.listDocuments();
  return { filter: s.defaultFilter, titles: docs.map((d) => d.title) };
});

check('writes persist across reload',
  persisted.filter === 'magic' && persisted.titles.includes('Persistence check'),
  `filter=${persisted.filter}, docs=${persisted.titles.length}`);
const libState = await page.evaluate(() => ({
  cards: document.querySelectorAll('.doc-card').length,
  gridHidden: document.querySelector('#doc-grid').hidden,
  gridChildren: document.querySelector('#doc-grid').children.length,
  resultsHidden: document.querySelector('#search-results').hidden,
  searchValue: document.querySelector('#search-input').value,
  screen: [...document.querySelectorAll('.screen')].find((s) => !s.hidden)?.dataset.screen,
}));
check('saved document appears in the library',
  libState.cards === 1, JSON.stringify(libState));
void wrote;

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
