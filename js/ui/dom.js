/** Small DOM and feedback helpers shared by every screen. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Attach a listener only if the element is actually there.
 *
 * A cached service-worker shell can be one version behind the scripts that
 * run against it, and then a selector that has always worked returns null.
 * Wiring up a feature that is missing from the page must degrade to "that
 * feature is unavailable", never to a dead application.
 */
export function on(sel, event, handler, root = document) {
  const node = root.querySelector(sel);
  if (node) node.addEventListener(event, handler);
  return node;
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ------------------------------ Toast ----------------------------------- */

export function toast(message, kind = '', ms = 2600) {
  const stack = $('#toast-stack');
  const node = el('div', { class: `toast ${kind}`, text: message });
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

/* ------------------------------ Busy ------------------------------------ */

let busyDepth = 0;

export function busy(label = 'Working…') {
  busyDepth++;
  $('#busy-label').textContent = label;
  $('#busy-progress').style.width = '0%';
  $('#busy').hidden = false;
}

export function busyUpdate(label, progress) {
  if (label) $('#busy-label').textContent = label;
  if (typeof progress === 'number') {
    $('#busy-progress').style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }
}

export function busyDone() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (busyDepth === 0) $('#busy').hidden = true;
}

/** Run an async task behind the busy overlay, always clearing it. */
export async function withBusy(label, fn) {
  busy(label);
  try { return await fn(); }
  finally { busyDone(); }
}

/* ------------------------------ Sheet ----------------------------------- */

let sheetCloser = null;

export function openSheet(title, items) {
  const body = $('#sheet-body');
  body.innerHTML = '';
  if (title) body.append(el('div', { class: 'sheet-title', text: title }));

  for (const item of items) {
    if (!item) continue;
    body.append(el('button', {
      class: `sheet-item ${item.danger ? 'danger' : ''}`,
      onclick: () => { closeSheet(); item.onSelect && item.onSelect(); },
    }, [
      item.icon ? svgIcon(item.icon) : null,
      el('span', {}, [
        item.label,
        item.note ? el('span', { class: 'item-note', text: item.note }) : null,
      ]),
    ]));
  }

  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;

  sheetCloser = () => closeSheet();
  $('#sheet-backdrop').onclick = sheetCloser;
}

export function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  sheetCloser = null;
}

export function sheetIsOpen() { return !!sheetCloser; }

/** Confirmation as a bottom sheet, resolving true/false. */
export function confirmSheet(title, confirmLabel, { danger = true, note = '' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    openSheet(title, [
      { label: confirmLabel, note, danger, icon: danger ? 'trash' : 'check', onSelect: () => done(true) },
      { label: 'Cancel', icon: 'x', onSelect: () => done(false) },
    ]);

    const backdrop = $('#sheet-backdrop');
    backdrop.onclick = () => { closeSheet(); done(false); };
  });
}

const ICONS = {
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l6 6L20 6"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6"/>',
  pdf: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  rename: '<path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z"/>',
  pages: '<rect x="4" y="3" width="12" height="16" rx="2"/><path d="M8 21h10a2 2 0 0 0 2-2V7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>',
};

export function svgIcon(name) {
  const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrap.setAttribute('viewBox', '0 0 24 24');
  wrap.innerHTML = ICONS[name] || ICONS.check;
  return wrap;
}

/* ------------------------------ Formatting ------------------------------ */

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Object-URL bookkeeping so long sessions do not leak blobs. */
const urls = new Set();

export function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}

export function releaseUrls() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}

/** Copy text, falling back to a hidden textarea where the API is blocked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Save a blob to the user's device. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}
