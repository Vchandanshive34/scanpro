/**
 * ScanPro — application shell.
 *
 * Owns navigation, the capture-to-document flow, the library, the document
 * viewer, export and the Lens screen. Heavy lifting lives in js/core/*.
 */

import {
  $, el, toast, busy, busyUpdate, busyDone, withBusy, openSheet,
  confirmSheet, formatDate, objectUrl, copyText, downloadBlob, escapeHtml,
} from './ui/dom.js';

import { CameraController } from './ui/camera.js';
import { EditorController } from './ui/editor.js';
import { TextViewController } from './ui/textview.js';
import { SettingsController } from './ui/settings.js';

import {
  createDocument, listDocuments, getDocument, updateDocument, deleteDocument,
  addPage, getPages, updatePage, deletePage,
  getSettings, setSetting, searchDocuments,
  DEFAULT_SETTINGS as FALLBACK_SETTINGS,
} from './core/db.js';

import {
  blobToImage, imageDataFrom, makeThumbnail, canvasToBlob, prepareForOcr,
  applyFilter, rotate as rotateCanvas,
} from './core/pipeline.js';

import { ocrEngine } from './core/ocr.js';
import { buildSearchablePDF } from './core/pdf.js';
import { scanBarcodes, barcodeSupported, extractEntities, groupEntities } from './core/lens.js';
import { LANG_BY_CODE } from './core/languages.js';

/* ==================================================================== */
/* State                                                                */
/* ==================================================================== */

const state = {
  settings: null,
  screen: 'library',
  history: [],
  batch: [],          // pages captured but not yet saved
  batchDocId: null,   // set when adding pages to an existing document
  currentDoc: null,
  currentPages: [],
  editingIndex: -1,   // index into batch when re-editing
};

let camera, editor, textView, settingsView;
let lensStream = null;

/* ==================================================================== */
/* Navigation                                                           */
/* ==================================================================== */

function show(screen, { replace = false } = {}) {
  if (!replace && state.screen !== screen) state.history.push(state.screen);

  document.querySelectorAll('.screen').forEach((s) => {
    s.hidden = s.dataset.screen !== screen;
  });
  state.screen = screen;

  if (screen !== 'camera' && camera) camera.stop();
  if (screen !== 'lens') stopLens();
}

function back() {
  const prev = state.history.pop() || 'library';
  show(prev, { replace: true });
  if (prev === 'library') refreshLibrary();
  if (prev === 'doc' && state.currentDoc) openDocument(state.currentDoc.id, true);
}

/* ==================================================================== */
/* Library                                                              */
/* ==================================================================== */

async function refreshLibrary() {
  const docs = await listDocuments();
  const grid = $('#doc-grid');
  grid.innerHTML = '';
  grid.classList.toggle('list-view', !state.settings.gridView);

  $('#library-empty').hidden = docs.length > 0;
  $('#library-count').textContent = docs.length
    ? `${docs.length} document${docs.length === 1 ? '' : 's'}`
    : 'Everything stays on this device';

  for (const doc of docs) {
    const pages = await getPages(doc.id);
    const first = pages[0];
    const hasText = pages.some((p) => p.text && p.text.trim());

    const thumb = el('div', { class: 'doc-thumb' });
    if (first && (first.thumb || first.blob)) {
      const img = new Image();
      img.loading = 'lazy';
      img.src = objectUrl(first.thumb || first.blob);
      thumb.append(img);
    }
    if (pages.length > 1) {
      thumb.append(el('span', { class: 'doc-badge', text: `${pages.length}` }));
    }
    if (hasText) {
      thumb.append(el('span', { class: 'doc-badge ocr', text: 'TEXT' }));
    }

    const card = el('button', { class: 'doc-card' }, [
      thumb,
      el('div', { class: 'doc-info' }, [
        el('div', { class: 'doc-name', text: doc.title }),
        el('div', {
          class: 'doc-meta',
          text: `${formatDate(doc.updatedAt)} · ${pages.length} page${pages.length === 1 ? '' : 's'}`,
        }),
      ]),
    ]);

    card.addEventListener('click', () => openDocument(doc.id));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      documentMenu(doc);
    });

    grid.append(card);
  }
}

async function runSearch(query) {
  const box = $('#search-results');
  const grid = $('#doc-grid');

  if (!query.trim()) {
    box.hidden = true;
    grid.hidden = false;
    $('#library-empty').hidden = (await listDocuments()).length > 0;
    return;
  }

  grid.hidden = true;
  $('#library-empty').hidden = true;
  box.hidden = false;
  box.innerHTML = '';

  const results = await searchDocuments(query);

  if (!results.length) {
    box.append(el('div', { class: 'empty-state' }, [
      el('h2', { text: 'Nothing found' }),
      el('p', { text: 'Search looks inside recognised text, so a page has to be read before it can be found. Open a scan and tap Text.' }),
    ]));
    return;
  }

  box.append(el('div', {
    class: 'section-label',
    text: `${results.length} match${results.length === 1 ? '' : 'es'}`,
  }));

  for (const r of results) {
    const pages = await getPages(r.doc.id);
    const first = pages[0];

    const img = el('img', { class: 'result-thumb', loading: 'lazy' });
    if (first && (first.thumb || first.blob)) img.src = objectUrl(first.thumb || first.blob);

    const highlighted = r.snippet
      ? escapeHtml(r.snippet).replace(
          new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'),
          '<mark>$1</mark>')
      : 'Title match';

    const item = el('div', { class: 'result-item' }, [
      img,
      el('div', { class: 'result-body' }, [
        el('div', { class: 'result-title', text: r.doc.title }),
        el('div', { class: 'result-snippet', html: highlighted }),
      ]),
    ]);

    item.addEventListener('click', () => openDocument(r.doc.id));
    box.append(item);
  }
}

function documentMenu(doc) {
  openSheet(doc.title, [
    { label: 'Open', icon: 'pages', onSelect: () => openDocument(doc.id) },
    { label: 'Rename', icon: 'rename', onSelect: () => renameDocument(doc) },
    { label: 'Export as PDF', icon: 'pdf', onSelect: () => exportPdf(doc.id) },
    {
      label: 'Delete',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmSheet(
          `Delete "${doc.title}"?`, 'Delete permanently',
          { note: 'This cannot be undone.' });
        if (!ok) return;
        await deleteDocument(doc.id);
        toast('Deleted');
        refreshLibrary();
      },
    },
  ]);
}

async function renameDocument(doc) {
  const name = prompt('Document name', doc.title);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  await updateDocument(doc.id, { title: trimmed });
  if (state.currentDoc && state.currentDoc.id === doc.id) {
    state.currentDoc.title = trimmed;
    $('#doc-title').textContent = trimmed;
  }
  refreshLibrary();
}

/* ==================================================================== */
/* Capture flow                                                         */
/* ==================================================================== */

async function openCamera(docId = null) {
  state.batchDocId = docId;
  if (!docId) state.batch = [];

  show('camera');
  $('#auto-capture').checked = !!state.settings.autoCapture;
  camera.autoCapture = !!state.settings.autoCapture;
  camera.setBatchCount(state.batch.length, state.batch[0] && state.batch[0].thumb);
  await camera.start();
}

async function handleCapture(payload) {
  // Imported files take a different path from a live frame.
  if (payload.files) {
    await importFiles(payload.files);
    return;
  }

  const { imageData, corners } = payload;
  camera.stop();
  state.editingIndex = -1;

  show('editor');
  editor.maxDimension = state.settings.maxDimension;
  editor.jpegQuality = state.settings.jpegQuality;
  await editor.load(imageData, corners, state.settings.defaultFilter);
}

async function importFiles(files) {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length) { toast('Those files are not images.', 'error'); return; }

  camera.stop();

  // One image opens the editor; several go straight into the batch so a
  // folder of photos becomes a document in one step.
  if (images.length === 1) {
    await withBusy('Opening photo…', async () => {
      const img = await blobToImage(images[0]);
      const data = imageDataFrom(img, 3000);
      if (img._revoke) img._revoke();
      const { detectEdges } = await import('./core/pipeline.js');
      const det = await detectEdges(data);

      show('editor');
      editor.maxDimension = state.settings.maxDimension;
      editor.jpegQuality = state.settings.jpegQuality;
      state.editingIndex = -1;
      await editor.load(data, det.corners, state.settings.defaultFilter);
    });
    return;
  }

  busy(`Importing ${images.length} photos…`);
  try {
    const { detectEdges } = await import('./core/pipeline.js');
    const { warp } = await import('./core/pipeline.js');

    for (let i = 0; i < images.length; i++) {
      busyUpdate(`Processing ${i + 1} of ${images.length}…`, i / images.length);

      const img = await blobToImage(images[i]);
      const data = imageDataFrom(img, 3000);
      if (img._revoke) img._revoke();

      const det = await detectEdges(data);
      const corners = det.corners || det.fallback;

      const flat = await warp(data, corners, { maxDim: state.settings.maxDimension });

      const ocrBlob = await canvasToBlob(await prepareForOcr(flat), 'image/jpeg', 0.85);

      const canvas = state.settings.defaultFilter !== 'original'
        ? await applyFilter(flat, state.settings.defaultFilter)
        : flat;

      const blob = await canvasToBlob(canvas, 'image/jpeg', state.settings.jpegQuality);
      const thumb = await makeThumbnail(canvas);

      state.batch.push({
        blob, ocrBlob, thumb,
        width: canvas.width, height: canvas.height,
        filter: state.settings.defaultFilter,
      });
    }
  } finally {
    busyDone();
  }

  toast(`${images.length} pages ready`, 'success');
  showPagesReview();
}

async function handleEditorDone(result) {
  const entry = {
    blob: result.blob,
    ocrBlob: result.ocrBlob,
    thumb: await makeThumbnail(result.canvas),
    width: result.width,
    height: result.height,
    filter: result.filter,
  };

  if (state.editingIndex >= 0) {
    state.batch[state.editingIndex] = entry;
    state.editingIndex = -1;
    showPagesReview();
    return;
  }

  state.batch.push(entry);

  // Straight back to the camera: batch scanning should not need a tap
  // between pages.
  show('camera');
  camera.setBatchCount(state.batch.length, state.batch[0].thumb);
  await camera.start();
  toast(`Page ${state.batch.length} captured`, 'success', 1400);
}

/* ==================================================================== */
/* Pages review                                                         */
/* ==================================================================== */

function showPagesReview() {
  if (!state.batch.length) {
    toast('No pages captured yet.');
    return;
  }
  show('pages');
  renderPagesReview();
}

function renderPagesReview() {
  $('#pages-title').textContent = state.batchDocId ? 'Add pages' : 'Review';
  $('#pages-subtitle').textContent =
    `${state.batch.length} page${state.batch.length === 1 ? '' : 's'}`;

  const wrap = $('#page-thumbs');
  wrap.innerHTML = '';

  state.batch.forEach((page, i) => {
    const img = new Image();
    img.src = objectUrl(page.thumb || page.blob);

    const node = el('div', { class: 'page-thumb', draggable: 'true' }, [
      img,
      el('span', { class: 'page-num', text: String(i + 1) }),
      el('div', { class: 'page-actions' }, [
        el('button', {
          class: 'page-action',
          html: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z"/></svg>',
          title: 'Edit this page',
          onclick: (e) => { e.stopPropagation(); reEditPage(i); },
        }),
        el('button', {
          class: 'page-action del',
          html: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
          title: 'Remove this page',
          onclick: async (e) => {
            e.stopPropagation();
            state.batch.splice(i, 1);
            if (!state.batch.length) { show('camera'); await camera.start(); return; }
            renderPagesReview();
          },
        }),
      ]),
    ]);

    // Drag to reorder.
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('drop-target');
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(from) || from === i) return;
      const [moved] = state.batch.splice(from, 1);
      state.batch.splice(i, 0, moved);
      renderPagesReview();
    });

    wrap.append(node);
  });
}

async function reEditPage(index) {
  const page = state.batch[index];
  await withBusy('Opening page…', async () => {
    const img = await blobToImage(page.blob);
    const data = imageDataFrom(img, 3000);
    if (img._revoke) img._revoke();

    state.editingIndex = index;
    show('editor');
    editor.maxDimension = state.settings.maxDimension;
    editor.jpegQuality = state.settings.jpegQuality;
    // Already cropped, so start from the full frame.
    await editor.load(data, null, page.filter || state.settings.defaultFilter);
  });
}

async function savePages() {
  if (!state.batch.length) return;

  await withBusy('Saving…', async () => {
    let doc;
    if (state.batchDocId) {
      doc = await getDocument(state.batchDocId);
    } else {
      doc = await createDocument();
    }

    for (const page of state.batch) {
      await addPage(doc.id, {
        blob: page.blob,
        ocrBlob: page.ocrBlob,
        thumb: page.thumb,
        width: page.width,
        height: page.height,
        filter: page.filter,
      });
    }

    state.batch = [];
    state.batchDocId = null;
    state.currentDoc = doc;
  });

  toast('Saved', 'success');

  if (state.settings.autoOcr) {
    await runOcr(state.currentDoc.id, { silent: true });
  }

  state.history = ['library'];
  openDocument(state.currentDoc.id, true);
}

/* ==================================================================== */
/* Document viewer                                                      */
/* ==================================================================== */

async function openDocument(id, replace = false) {
  const doc = await getDocument(id);
  if (!doc) { toast('That document is gone.', 'error'); refreshLibrary(); return; }

  state.currentDoc = doc;
  state.currentPages = await getPages(id);

  show('doc', { replace });

  $('#doc-title').textContent = doc.title;
  const withText = state.currentPages.filter((p) => p.text && p.text.trim()).length;
  $('#doc-subtitle').textContent =
    `${state.currentPages.length} page${state.currentPages.length === 1 ? '' : 's'} · ` +
    (withText ? `${withText} read` : 'not read yet');

  const pager = $('#doc-pager');
  pager.innerHTML = '';

  state.currentPages.forEach((page, i) => {
    const img = new Image();
    img.loading = 'lazy';
    img.src = objectUrl(page.blob);

    const node = el('div', { class: 'doc-page' }, [
      img,
      el('span', { class: 'doc-page-label', text: `${i + 1} / ${state.currentPages.length}` }),
    ]);
    node.addEventListener('click', () => pageMenu(page, i));
    pager.append(node);
  });
}

function pageMenu(page, index) {
  openSheet(`Page ${index + 1}`, [
    {
      label: 'Rotate 90°',
      icon: 'rename',
      onSelect: () => withBusy('Rotating…', async () => {
        const { canvasFromPixels } = await import('./core/pipeline.js');

        const rotateBlob = async (source, quality) => {
          if (!source) return null;
          const img = await blobToImage(source);
          const data = imageDataFrom(img, 0);
          if (img._revoke) img._revoke();
          const canvas = canvasFromPixels(data.data.buffer, data.width, data.height);
          const out = await rotateCanvas(canvas, 90);
          return { canvas: out, blob: await canvasToBlob(out, 'image/jpeg', quality) };
        };

        const main = await rotateBlob(page.blob, state.settings.jpegQuality);
        const ocr = await rotateBlob(page.ocrBlob, 0.85);

        // Move the word boxes with the pixels, so the page stays searchable
        // and the PDF text layer stays aligned. For a 90° turn of a W×H page,
        // (x, y) becomes (H - y, x).
        const h = page.height;
        const words = (page.words || []).map((w) => {
          const b = w.bbox || w;
          return { ...w, bbox: { x0: h - b.y1, y0: b.x0, x1: h - b.y0, y1: b.x1 } };
        });

        await updatePage(page.id, {
          blob: main.blob,
          ocrBlob: ocr ? ocr.blob : null,
          thumb: await makeThumbnail(main.canvas),
          width: main.canvas.width,
          height: main.canvas.height,
          words,
        });
        openDocument(state.currentDoc.id, true);
      }),
    },
    {
      label: 'Save this page as an image',
      icon: 'download',
      onSelect: () => downloadBlob(page.blob, `${safeName(state.currentDoc.title)}-${index + 1}.jpg`),
    },
    {
      label: 'Delete page',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmSheet(`Delete page ${index + 1}?`, 'Delete page');
        if (!ok) return;
        await deletePage(page.id);
        toast('Page deleted');
        openDocument(state.currentDoc.id, true);
      },
    },
  ]);
}

function safeName(title) {
  return (title || 'scan').replace(/[^\wऀ-෿ -]+/g, '').trim().slice(0, 60) || 'scan';
}

/* ==================================================================== */
/* OCR                                                                  */
/* ==================================================================== */

async function runOcr(docId, { silent = false } = {}) {
  const pages = await getPages(docId);
  if (!pages.length) return null;

  const langs = state.settings.ocrLangs && state.settings.ocrLangs.length
    ? state.settings.ocrLangs
    : ['eng'];

  const langNames = langs.map((c) => (LANG_BY_CODE[c] ? LANG_BY_CODE[c].name : c)).join(' + ');

  busy(`Reading text (${langNames})…`);

  ocrEngine.onProgress = ({ stage, progress }) => busyUpdate(stage, progress);

  const combined = { text: '', words: [], confidence: 0, langs, durationMs: 0 };
  let confSum = 0, confCount = 0;

  try {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      busyUpdate(`Reading page ${i + 1} of ${pages.length}…`, i / pages.length);

      // The OCR master was made from the unfiltered page at capture time and
      // is what reads most accurately. Older pages without one fall back to
      // preparing the display image.
      const source = page.ocrBlob || page.blob;
      const img = await blobToImage(source);
      const data = imageDataFrom(img, 0);
      if (img._revoke) img._revoke();

      const { canvasFromPixels } = await import('./core/pipeline.js');
      const raw = canvasFromPixels(data.data.buffer, data.width, data.height);
      const prepped = page.ocrBlob ? raw : await prepareForOcr(raw);

      const result = await ocrEngine.recognize(prepped, langs);

      await updatePage(page.id, {
        words: result.words,
        text: result.text,
        confidence: result.confidence,
        ocrLangs: langs,
      });

      combined.text += (combined.text ? '\n\n' : '') + result.text;
      combined.words.push(...result.words);
      combined.durationMs += result.durationMs;

      if (result.confidence) { confSum += result.confidence; confCount++; }
    }

    combined.confidence = confCount ? confSum / confCount : 0;
    await updateDocument(docId, { langs });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Text recognition failed.', 'error', 5000);
    return null;
  } finally {
    ocrEngine.onProgress = null;
    busyDone();
  }

  if (!silent) {
    const conf = Math.round(combined.confidence);
    toast(`Read ${combined.words.filter((w) => !w.noise).length} words · ${conf}% confidence`,
      conf >= 80 ? 'success' : '', 3200);
  }

  return combined;
}

async function showText() {
  if (!state.currentDoc) return;

  const pages = await getPages(state.currentDoc.id);
  const alreadyRead = pages.every((p) => p.text && p.text.trim());

  let result;
  if (alreadyRead) {
    result = {
      text: pages.map((p) => p.text).join('\n\n'),
      words: pages.flatMap((p) => p.words || []),
      confidence: pages.reduce((s, p) => s + (p.confidence || 0), 0) / pages.length,
      langs: pages[0].ocrLangs || state.settings.ocrLangs,
    };
  } else {
    result = await runOcr(state.currentDoc.id);
    if (!result) return;
  }

  show('text');
  textView.show(result, {
    title: state.currentDoc.title,
    pageCount: pages.length,
  });
}

/* ==================================================================== */
/* Export                                                               */
/* ==================================================================== */

async function exportPdf(docId) {
  const doc = await getDocument(docId || (state.currentDoc && state.currentDoc.id));
  if (!doc) return;

  const pages = await getPages(doc.id);
  if (!pages.length) { toast('This document has no pages.'); return; }

  const unread = pages.filter((p) => !p.text || !p.text.trim()).length;

  const build = async (searchable) => {
    if (searchable && unread) {
      await runOcr(doc.id, { silent: true });
    }

    const fresh = await getPages(doc.id);

    return withBusy('Building PDF…', async () => {
      const payload = [];
      for (const page of fresh) {
        const bytes = new Uint8Array(await page.blob.arrayBuffer());
        payload.push({
          jpeg: bytes,
          width: page.width,
          height: page.height,
          words: searchable ? (page.words || []) : [],
          dpi: 200,
        });
      }

      const blob = await buildSearchablePDF(payload, {
        title: doc.title,
        pageSize: state.settings.pdfPageSize,
        margin: state.settings.pdfPageSize === 'fit' ? 0 : 24,
      });

      const filename = `${safeName(doc.title)}.pdf`;
      await deliver(blob, filename, doc.title);
      return blob;
    });
  };

  openSheet('Export as PDF', [
    {
      label: 'Searchable PDF',
      note: unread
        ? `Reads ${unread} page${unread === 1 ? '' : 's'} first, then embeds the text`
        : 'Text can be selected and searched',
      icon: 'text',
      onSelect: () => build(true),
    },
    {
      label: 'Image-only PDF',
      note: 'Smaller file, no text layer',
      icon: 'image',
      onSelect: () => build(false),
    },
  ]);
}

/** Share where supported, otherwise download. */
async function deliver(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // user cancelled
    }
  }

  downloadBlob(blob, filename);
  toast(`Saved ${filename}`, 'success');
}

async function shareDocument() {
  if (!state.currentDoc) return;
  const pages = await getPages(state.currentDoc.id);
  if (!pages.length) return;

  openSheet('Share', [
    { label: 'Share as PDF', icon: 'pdf', onSelect: () => exportPdf(state.currentDoc.id) },
    {
      label: pages.length > 1 ? `Share ${pages.length} images` : 'Share image',
      icon: 'image',
      onSelect: async () => {
        const files = pages.map((p, i) =>
          new File([p.blob], `${safeName(state.currentDoc.title)}-${i + 1}.jpg`,
            { type: 'image/jpeg' }));

        if (navigator.canShare && navigator.canShare({ files })) {
          try { await navigator.share({ files, title: state.currentDoc.title }); return; }
          catch (err) { if (err && err.name === 'AbortError') return; }
        }
        files.forEach((f) => downloadBlob(f, f.name));
      },
    },
    {
      label: 'Copy recognised text',
      icon: 'copy',
      onSelect: async () => {
        const text = pages.map((p) => p.text).filter(Boolean).join('\n\n');
        if (!text) { toast('This document has not been read yet. Tap Text first.'); return; }
        const ok = await copyText(text);
        toast(ok ? 'Text copied' : 'Could not copy', ok ? 'success' : 'error');
      },
    },
  ]);
}

/* ==================================================================== */
/* Lens                                                                 */
/* ==================================================================== */

async function openLens() {
  show('lens');
  $('#lens-results').innerHTML = '';

  const video = $('#lens-video');
  try {
    lensStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    });
    video.srcObject = lensStream;
    await video.play().catch(() => {});
  } catch {
    toast('Could not open the camera for Lens.', 'error');
    return;
  }

  if (barcodeSupported()) pollBarcodes();
}

function stopLens() {
  if (lensStream) {
    lensStream.getTracks().forEach((t) => t.stop());
    lensStream = null;
  }
  const video = $('#lens-video');
  if (video) video.srcObject = null;
}

let barcodeTimer = null;

function pollBarcodes() {
  clearTimeout(barcodeTimer);
  if (state.screen !== 'lens' || !lensStream) return;

  barcodeTimer = setTimeout(async () => {
    const video = $('#lens-video');
    if (video && video.videoWidth) {
      try {
        const codes = await scanBarcodes(video);
        if (codes.length) renderLensCards(codes.map(codeToCard));
      } catch { /* keep polling */ }
    }
    pollBarcodes();
  }, 700);
}

function codeToCard(code) {
  const p = code.parsed;
  const actions = [];

  if (p.kind === 'url') {
    actions.push({ label: 'Open', primary: true, run: () => window.open(p.value, '_blank', 'noopener') });
  }
  if (p.kind === 'upi') {
    actions.push({ label: 'Open payment app', primary: true, run: () => { window.location.href = p.value; } });
  }
  if (p.kind === 'phone') {
    actions.push({ label: 'Call', primary: true, run: () => { window.location.href = p.value; } });
  }
  actions.push({ label: 'Copy', run: async () => {
    const ok = await copyText(code.value);
    toast(ok ? 'Copied' : 'Could not copy', ok ? 'success' : 'error');
  } });

  let title = code.format ? code.format.toUpperCase() : 'CODE';
  let value = code.value;

  if (p.kind === 'upi') {
    title = 'UPI PAYMENT';
    value = `${p.payee || 'Payee'} · ${p.vpa}${p.amount ? ` · ₹${p.amount}` : ''}`;
  } else if (p.kind === 'wifi') {
    title = 'WI-FI NETWORK';
    value = p.ssid || code.value;
  } else if (p.kind === 'contact') {
    title = 'CONTACT';
    value = p.name || code.value;
  }

  return { title, value, actions };
}

function renderLensCards(cards) {
  const box = $('#lens-results');
  box.innerHTML = '';

  for (const card of cards) {
    const actionRow = el('div', { class: 'lens-card-actions' },
      card.actions.map((a) => el('button', {
        class: `lens-btn ${a.primary ? 'primary' : ''}`,
        text: a.label,
        onclick: a.run,
      })));

    box.append(el('div', { class: 'lens-card' }, [
      el('div', { class: 'lens-card-title', text: card.title }),
      el('div', { class: 'lens-card-value', text: card.value }),
      actionRow,
    ]));
  }
}

async function lensCapture() {
  const video = $('#lens-video');
  if (!video || !video.videoWidth) return;

  busy('Reading…');
  try {
    const data = imageDataFrom(video, 1800);
    const { canvasFromPixels } = await import('./core/pipeline.js');
    const canvas = canvasFromPixels(data.data.buffer, data.width, data.height);

    const cards = [];

    const codes = await scanBarcodes(canvas);
    cards.push(...codes.map(codeToCard));

    const prepped = await prepareForOcr(canvas);
    ocrEngine.onProgress = ({ stage, progress }) => busyUpdate(stage, progress);

    const langs = state.settings.ocrLangs.length ? state.settings.ocrLangs : ['eng'];
    const result = await ocrEngine.recognize(prepped, langs);

    if (result.text.trim()) {
      cards.push({
        title: 'TEXT',
        value: result.text.trim().slice(0, 400),
        actions: [
          {
            label: 'Copy', primary: true, run: async () => {
              const ok = await copyText(result.text);
              toast(ok ? 'Copied' : 'Could not copy', ok ? 'success' : 'error');
            },
          },
          {
            label: 'Search web', run: () => window.open(
              `https://www.google.com/search?q=${encodeURIComponent(result.text.trim().slice(0, 200))}`,
              '_blank', 'noopener'),
          },
          {
            label: 'Save as scan', run: async () => {
              const blob = await canvasToBlob(canvas, 'image/jpeg', state.settings.jpegQuality);
              const doc = await createDocument();
              await addPage(doc.id, {
                blob,
                thumb: await makeThumbnail(canvas),
                width: canvas.width, height: canvas.height,
                words: result.words, text: result.text,
                confidence: result.confidence, ocrLangs: langs,
              });
              toast('Saved to your scans', 'success');
            },
          },
        ],
      });
    }

    for (const e of groupEntities(extractEntities(result.text))) {
      cards.push({
        title: e.label.toUpperCase(),
        value: e.value,
        actions: [{
          label: e.action.label,
          primary: true,
          run: async () => {
            if (e.action.copy) {
              const ok = await copyText(e.action.copy);
              toast(ok ? 'Copied' : 'Could not copy', ok ? 'success' : 'error');
            } else if (e.action.href) {
              window.open(e.action.href, e.action.external ? '_blank' : '_self', 'noopener');
            }
          },
        }],
      });
    }

    if (!cards.length) {
      toast('Nothing readable found. Move closer or improve the light.');
      return;
    }

    renderLensCards(cards);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that.', 'error');
  } finally {
    ocrEngine.onProgress = null;
    busyDone();
  }
}

/* ==================================================================== */
/* Boot                                                                 */
/* ==================================================================== */

function bindGlobal() {
  $('#btn-open-camera').addEventListener('click', () => openCamera());

  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      if (target === 'lens') openLens();
      else { show('library', { replace: true }); refreshLibrary(); }
    });
  });

  $('#btn-settings').addEventListener('click', async () => {
    show('settings');
    await settingsView.show();
  });

  $('#btn-toggle-view').addEventListener('click', async () => {
    state.settings.gridView = !state.settings.gridView;
    await setSetting('gridView', state.settings.gridView);
    refreshLibrary();
  });

  // Search
  let searchTimer;
  const input = $('#search-input');
  input.addEventListener('input', () => {
    $('#search-clear').hidden = !input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 220);
  });
  $('#search-clear').addEventListener('click', () => {
    input.value = '';
    $('#search-clear').hidden = true;
    runSearch('');
  });

  // Pages review
  $('#btn-pages-back').addEventListener('click', async () => {
    show('camera'); await camera.start();
  });
  $('#btn-pages-save').addEventListener('click', savePages);
  $('#btn-add-page').addEventListener('click', async () => {
    show('camera'); await camera.start();
  });

  // Document viewer
  $('#btn-doc-back').addEventListener('click', () => {
    show('library', { replace: true });
    state.history = [];
    refreshLibrary();
  });
  $('#btn-ocr').addEventListener('click', showText);
  $('#btn-export-pdf').addEventListener('click', () => exportPdf());
  $('#btn-share').addEventListener('click', shareDocument);
  $('#btn-add-more').addEventListener('click', () => {
    state.batch = [];
    openCamera(state.currentDoc.id);
  });
  $('#btn-doc-menu').addEventListener('click', () => {
    if (state.currentDoc) documentMenu(state.currentDoc);
  });

  $('#doc-title').addEventListener('blur', async () => {
    const title = $('#doc-title').textContent.trim();
    if (!state.currentDoc || !title || title === state.currentDoc.title) return;
    await updateDocument(state.currentDoc.id, { title });
    state.currentDoc.title = title;
  });
  $('#doc-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#doc-title').blur(); }
  });

  // Lens
  $('#btn-lens-back').addEventListener('click', () => {
    stopLens();
    show('library', { replace: true });
    refreshLibrary();
  });
  $('#btn-lens-capture').addEventListener('click', lensCapture);

  // Hardware back button / browser history
  window.addEventListener('popstate', () => {
    if (state.screen !== 'library') { back(); history.pushState(null, ''); }
  });
  history.pushState(null, '');
}

async function boot() {
  // Storage must never be able to take the whole interface down with it. If
  // settings cannot be read, carry on with defaults and bind the UI anyway —
  // a half-working app the user can still scan with beats a screen where
  // every button is dead and nothing says why.
  let storageError = null;
  try {
    state.settings = await getSettings();
  } catch (err) {
    console.error('Could not read local settings; using defaults.', err);
    storageError = err;
    state.settings = { ...FALLBACK_SETTINGS };
  }

  camera = new CameraController({
    onCapture: handleCapture,
    onClose: async () => {
      if (state.batch.length) { showPagesReview(); return; }
      show('library', { replace: true });
      refreshLibrary();
    },
    onOpenBatch: showPagesReview,
    onModeChange: (mode) => { if (mode === 'lens') openLens(); },
  });

  editor = new EditorController({
    onDone: handleEditorDone,
    onCancel: async () => {
      if (state.editingIndex >= 0) { state.editingIndex = -1; showPagesReview(); return; }
      show('camera');
      await camera.start();
    },
    onDiscard: async () => {
      if (state.editingIndex >= 0) {
        state.batch.splice(state.editingIndex, 1);
        state.editingIndex = -1;
        state.batch.length ? showPagesReview() : (show('camera'), camera.start());
        return;
      }
      show('camera');
      await camera.start();
    },
  });

  textView = new TextViewController({ onBack: back });

  settingsView = new SettingsController({
    onBack: () => { show('library', { replace: true }); refreshLibrary(); },
    onChange: (next) => { state.settings = { ...state.settings, ...next }; },
  });

  // Bind first: whatever else fails, the buttons respond.
  bindGlobal();

  try {
    await refreshLibrary();
  } catch (err) {
    console.error('Could not load the library.', err);
    storageError = storageError || err;
    $('#library-empty').hidden = false;
  }

  if (storageError) {
    toast('Saved scans are unavailable on this device — scanning still works.',
      'error', 7000);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // The app still works without offline caching.
    });
  }
}

boot().catch((err) => {
  console.error(err);
  // Last resort: say something on the page itself, since a toast can be
  // missed and an unresponsive screen explains nothing.
  const banner = el('div', {
    style: 'position:fixed;left:12px;right:12px;bottom:90px;z-index:80;' +
           'background:#40202a;border:1px solid #7a2b3a;border-radius:12px;' +
           'padding:14px 16px;font-size:13.5px;line-height:1.5',
    text: `ScanPro could not start: ${err && err.message ? err.message : err}. ` +
          'Reloading the page usually fixes it.',
  });
  document.body.append(banner);
});

// Exposed for debugging in the console and for the automated tests.
window.__scanpro = { state, runOcr, exportPdf };
Object.defineProperty(window, '__scanproCamera', { get: () => camera });