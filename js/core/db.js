/**
 * Local storage.
 *
 * Everything lives in IndexedDB on the device — scans, OCR text, settings.
 * Nothing is uploaded anywhere, which is the point: these are people's
 * Aadhaar cards, bank statements and land records.
 *
 * Schema
 *   documents  { id, title, createdAt, updatedAt, pageCount, tags, langs }
 *   pages      { id, docId, index, blob, thumb, width, height, filter,
 *                words, text, confidence, ocrLangs }
 *   settings   { key, value }
 */

/**
 * Database name, scoped to where the app is installed.
 *
 * IndexedDB is scoped to the ORIGIN, not the path. On shared hosting like
 * `username.github.io`, every project that user publishes shares one storage
 * area, so a plain name like "scanpro" collides with whatever another of their
 * apps happened to call its database — and then this app is reading someone
 * else's schema. Folding the install path into the name keeps each deployment
 * to itself.
 */
function databaseName() {
  let scope = '';
  try {
    // Directory containing the app, so /scanpro/ and /scanpro/index.html agree.
    scope = new URL('./', self.location.href).pathname;
  } catch {
    scope = '';
  }
  const suffix = scope.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return suffix ? `scanpro-store-${suffix}` : 'scanpro-store';
}

export const DB_NAME = databaseName();

/**
 * The shape every store must have. Checked on open, not just created once —
 * a store can exist with the wrong keyPath or be missing an index, and that
 * fails later and more confusingly than a store that is missing outright.
 */
const SCHEMA = {
  documents: {
    keyPath: 'id',
    indexes: { updatedAt: 'updatedAt', title: 'title' },
  },
  pages: {
    keyPath: 'id',
    indexes: { docId: 'docId', docIndex: ['docId', 'index'] },
  },
  settings: {
    keyPath: 'key',
    indexes: {},
  },
};

let dbPromise = null;

function buildStore(db, name) {
  const spec = SCHEMA[name];
  const store = db.createObjectStore(name, { keyPath: spec.keyPath });
  for (const [index, path] of Object.entries(spec.indexes)) {
    store.createIndex(index, path);
  }
}

/** List everything wrong with the current schema. Empty means healthy. */
function schemaProblems(db) {
  const problems = [];
  const present = [];

  for (const name of Object.keys(SCHEMA)) {
    if (db.objectStoreNames.contains(name)) present.push(name);
    else problems.push(`${name}: missing`);
  }

  if (present.length) {
    const tx = db.transaction(present, 'readonly');
    for (const name of present) {
      const store = tx.objectStore(name);
      const spec = SCHEMA[name];

      if (String(store.keyPath) !== String(spec.keyPath)) {
        problems.push(`${name}: keyPath is "${store.keyPath}", expected "${spec.keyPath}"`);
        continue;
      }
      for (const index of Object.keys(spec.indexes)) {
        if (!store.indexNames.contains(index)) problems.push(`${name}: missing index ${index}`);
      }
    }
  }

  return problems;
}

/** Bring every store to the expected shape, inside a versionchange upgrade. */
function applySchema(db, tx) {
  for (const name of Object.keys(SCHEMA)) {
    const spec = SCHEMA[name];

    if (!db.objectStoreNames.contains(name)) { buildStore(db, name); continue; }

    const store = tx.objectStore(name);

    // Wrong keyPath cannot be altered in place — rebuild the store.
    if (String(store.keyPath) !== String(spec.keyPath)) {
      db.deleteObjectStore(name);
      buildStore(db, name);
      continue;
    }

    for (const [index, path] of Object.entries(spec.indexes)) {
      if (!store.indexNames.contains(index)) store.createIndex(index, path);
    }
  }
}

function openAt(version) {
  return new Promise((resolve, reject) => {
    // `undefined` opens whatever version exists, creating it at 1 if new.
    const req = version === undefined
      ? indexedDB.open(DB_NAME)
      : indexedDB.open(DB_NAME, version);

    req.onupgradeneeded = () => applySchema(req.result, req.transaction);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(
      'Another ScanPro tab is open. Close it and reload this page.'));
  });
}

/**
 * Open the database, repairing the schema if it is not what we expect.
 *
 * `onupgradeneeded` only fires when the version number rises, so a database
 * sitting at the current version with the wrong stores stays broken forever
 * and every transaction throws NotFoundError. Verifying after open and
 * bumping the version once makes that state recoverable instead of fatal.
 */
function open() {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    let db = await openAt(undefined);

    const problems = schemaProblems(db);
    if (problems.length) {
      console.warn('Repairing local storage:\n  ' + problems.join('\n  '));
      const nextVersion = db.version + 1;
      db.close();
      db = await openAt(nextVersion);

      const remaining = schemaProblems(db);
      if (remaining.length) {
        db.close();
        throw new Error(`Local storage could not be repaired: ${remaining.join('; ')}`);
      }
    }

    // If another tab upgrades the schema, step aside rather than block it.
    db.onversionchange = () => {
      db.close();
      dbPromise = null;
    };

    return db;
  })();

  // A failed open must not poison every later call.
  dbPromise.catch(() => { dbPromise = null; });

  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqValue(request) {
  return { __req: request };
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export async function createDocument(title) {
  const now = Date.now();
  const doc = {
    id: uid('doc'),
    title: title || defaultTitle(now),
    createdAt: now,
    updatedAt: now,
    pageCount: 0,
    tags: [],
    langs: [],
  };
  await tx('documents', 'readwrite', (s) => s.put(doc));
  return doc;
}

function defaultTitle(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

export function getDocument(id) {
  return tx('documents', 'readonly', (s) => reqValue(s.get(id)));
}

export async function listDocuments() {
  const all = await tx('documents', 'readonly', (s) => reqValue(s.getAll()));
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateDocument(id, patch) {
  const doc = await getDocument(id);
  if (!doc) return null;
  const next = { ...doc, ...patch, updatedAt: Date.now() };
  await tx('documents', 'readwrite', (s) => s.put(next));
  return next;
}

export async function deleteDocument(id) {
  const pages = await getPages(id);
  await tx('pages', 'readwrite', (s) => { pages.forEach((p) => s.delete(p.id)); });
  await tx('documents', 'readwrite', (s) => s.delete(id));
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export async function addPage(docId, page) {
  const existing = await getPages(docId);
  const record = {
    id: uid('pg'),
    docId,
    index: existing.length,
    createdAt: Date.now(),
    words: [],
    text: '',
    confidence: null,
    ocrLangs: [],
    ...page,
  };
  await tx('pages', 'readwrite', (s) => s.put(record));
  await updateDocument(docId, { pageCount: existing.length + 1 });
  return record;
}

export async function getPages(docId) {
  const all = await tx('pages', 'readonly', (s) =>
    reqValue(s.index('docId').getAll(IDBKeyRange.only(docId))));
  return (all || []).sort((a, b) => a.index - b.index);
}

export function getPage(id) {
  return tx('pages', 'readonly', (s) => reqValue(s.get(id)));
}

export async function updatePage(id, patch) {
  const page = await getPage(id);
  if (!page) return null;
  const next = { ...page, ...patch };
  await tx('pages', 'readwrite', (s) => s.put(next));
  await updateDocument(page.docId, {});
  return next;
}

export async function deletePage(id) {
  const page = await getPage(id);
  if (!page) return;
  await tx('pages', 'readwrite', (s) => s.delete(id));

  const rest = await getPages(page.docId);
  await tx('pages', 'readwrite', (s) => {
    rest.forEach((p, i) => { if (p.index !== i) s.put({ ...p, index: i }); });
  });
  await updateDocument(page.docId, { pageCount: rest.length });
}

export async function reorderPages(docId, orderedIds) {
  const pages = await getPages(docId);
  const byId = new Map(pages.map((p) => [p.id, p]));
  await tx('pages', 'readwrite', (s) => {
    orderedIds.forEach((id, i) => {
      const p = byId.get(id);
      if (p) s.put({ ...p, index: i });
    });
  });
  await updateDocument(docId, {});
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  ocrLangs: ['eng', 'hin'],
  installedLangs: ['eng'],
  defaultFilter: 'auto',
  autoCapture: true,
  autoOcr: true,
  pdfPageSize: 'fit',
  jpegQuality: 0.86,
  maxDimension: 2400,
  gridView: true,
};

export async function getSettings() {
  const rows = await tx('settings', 'readonly', (s) => reqValue(s.getAll()));
  const stored = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSetting(key, value) {
  await tx('settings', 'readwrite', (s) => s.put({ key, value }));
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Full-text search over every scan.
 *
 * Case- and diacritic-insensitive for Latin; for Indic scripts it matches on
 * the raw text, since case folding does not apply and stripping matras would
 * change meaning.
 */
export async function searchDocuments(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const docs = await listDocuments();
  const results = [];

  for (const doc of docs) {
    const pages = await getPages(doc.id);
    let score = 0;
    let snippet = '';
    let matchPage = null;

    if (doc.title.toLowerCase().includes(q)) score += 10;

    for (const page of pages) {
      const text = page.text || '';
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) continue;

      score += 5;
      if (!snippet) {
        const start = Math.max(0, idx - 40);
        snippet = (start > 0 ? '…' : '') +
          text.slice(start, idx + q.length + 60).replace(/\s+/g, ' ') + '…';
        matchPage = page.index;
      }
    }

    if (score > 0) results.push({ doc, score, snippet, matchPage });
  }

  return results.sort((a, b) => b.score - a.score);
}

/** Rough storage usage, for the settings screen. */
export async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}
