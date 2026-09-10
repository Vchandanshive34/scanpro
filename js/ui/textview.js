/**
 * Recognised-text screen: the text itself, what was found in it, and a
 * transliteration.
 *
 * Words the engine was unsure about are highlighted rather than hidden. OCR is
 * never perfect, and a scanner that quietly presents a wrong digit as fact is
 * worse than one that shows you where to look.
 */

import { $, el, toast, copyText, escapeHtml } from './dom.js';
import { extractEntities, groupEntities, transliterate, canTransliterate } from '../core/lens.js';
import { LANG_BY_CODE, dominantIndicScriptName } from '../core/languages.js';

const LOW_CONFIDENCE = 72;

export class TextViewController {
  constructor({ onBack }) {
    this.onBack = onBack;
    this.current = null;

    $('#btn-text-back').addEventListener('click', () => this.onBack && this.onBack());
    $('#btn-copy-text').addEventListener('click', () => this._copyAll());

    $('#text-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      this._selectTab(tab.dataset.tab);
    });
  }

  _selectTab(name) {
    document.querySelectorAll('#text-tabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('#screen-text .tab-panel').forEach((p) =>
      p.classList.toggle('active', p.dataset.panel === name));
  }

  /**
   * @param {Object} result  { text, words, confidence, langs, durationMs }
   * @param {Object} context { title, pageCount }
   */
  show(result, context = {}) {
    this.current = result;
    this._selectTab('text');

    $('#text-subtitle').textContent = context.title || '';

    this._renderMeta(result, context);
    this._renderText(result);
    this._renderEntities(result.text);
    this._renderTransliteration(result.text, result.langs || []);
  }

  _renderMeta(result, context) {
    const meta = $('#ocr-meta');
    meta.innerHTML = '';

    const conf = Math.round(result.confidence || 0);
    const confClass = conf >= 85 ? 'good' : conf >= 70 ? '' : 'warn';

    const langNames = (result.langs || [])
      .map((c) => (LANG_BY_CODE[c] ? LANG_BY_CODE[c].name : c))
      .join(', ');

    const words = (result.words || []).filter((w) => !w.noise);
    const lowCount = words.filter((w) => (w.confidence || 0) < LOW_CONFIDENCE).length;

    const pills = [
      { html: `<strong>${words.length}</strong> words`, cls: '' },
      { html: `<strong>${conf}%</strong> mean confidence`, cls: confClass },
      langNames ? { html: langNames, cls: '' } : null,
      context.pageCount > 1 ? { html: `${context.pageCount} pages`, cls: '' } : null,
      lowCount ? { html: `<strong>${lowCount}</strong> to check`, cls: 'warn' } : null,
    ].filter(Boolean);

    for (const p of pills) {
      meta.append(el('span', { class: `meta-pill ${p.cls}`, html: p.html }));
    }
  }

  _renderText(result) {
    const box = $('#ocr-text');
    const words = (result.words || []).filter((w) => !w.noise);

    if (!words.length) {
      box.textContent = result.text || 'No text was found on this page.';
      return;
    }

    // Rebuild the text with low-confidence words wrapped, preserving lines.
    const lines = [];
    let line = [];
    let prevMid = null;

    for (const w of words) {
      const b = w.bbox || w;
      const mid = (b.y0 + b.y1) / 2;
      const tol = Math.max(6, (b.y1 - b.y0) * 0.55);

      if (prevMid !== null && Math.abs(mid - prevMid) > tol) {
        lines.push(line);
        line = [];
      }
      line.push(w);
      prevMid = mid;
    }
    if (line.length) lines.push(line);

    box.innerHTML = lines.map((ln) => ln.map((w) => {
      const safe = escapeHtml(w.text);
      return (w.confidence || 0) < LOW_CONFIDENCE
        ? `<span class="low-conf" title="Confidence ${Math.round(w.confidence)}%">${safe}</span>`
        : safe;
    }).join(' ')).join('\n');

    const legend = el('p', {
      class: 'legend',
      html: '<span class="swatch"></span>Highlighted words are ones the engine was ' +
            'less sure about — worth a glance before you rely on them.',
    });
    box.after(legend);

    // Only one legend, even after repeated renders.
    const existing = box.parentElement.querySelectorAll('.legend');
    for (let i = 0; i < existing.length - 1; i++) existing[i].remove();
  }

  _renderEntities(text) {
    const list = $('#entity-list');
    list.innerHTML = '';

    const entities = groupEntities(extractEntities(text || ''));

    if (!entities.length) {
      list.append(el('p', {
        class: 'group-note',
        text: 'No phone numbers, links, amounts or IDs were found on this page.',
      }));
      return;
    }

    for (const e of entities) {
      const card = el('div', { class: 'entity-card' }, [
        el('div', { class: 'entity-icon', text: e.icon }),
        el('div', { class: 'entity-body' }, [
          el('div', { class: 'entity-label' }, [
            e.label,
            e.sensitive ? el('span', { class: 'sensitive-tag', text: 'sensitive' }) : null,
          ]),
          el('div', { class: 'entity-value' }, [
            e.value,
            e.count > 1 ? el('span', { class: 'count', text: ` ×${e.count}` }) : null,
          ]),
        ]),
        el('button', {
          class: 'entity-act',
          text: e.action.label,
          onclick: () => this._runAction(e),
        }),
      ]);
      list.append(card);
    }
  }

  async _runAction(entity) {
    const { action } = entity;

    if (action.copy) {
      const ok = await copyText(action.copy);
      toast(ok ? 'Copied' : 'Could not copy', ok ? 'success' : 'error');
      return;
    }
    if (action.href) {
      // Leaving the app is the user's call — open in a new context.
      window.open(action.href, action.external ? '_blank' : '_self',
        action.external ? 'noopener,noreferrer' : '');
    }
  }

  _renderTransliteration(text, langs) {
    const note = $('#translit-note');
    const box = $('#translit-text');

    if (!canTransliterate(text || '')) {
      note.textContent = 'This page has no Indic script to transliterate.';
      box.textContent = '';
      return;
    }

    // Sanskrit speaks every inherent vowel; the modern languages drop most of
    // them. रामायणम् is "rāmāyaṇam" as Sanskrit but "rāmāyṇam" by Hindi
    // pronunciation rules, so honour the language the page was read in.
    const indic = (langs || []).filter((c) => LANG_BY_CODE[c] &&
      LANG_BY_CODE[c].script !== 'latin');
    const sanskritOnly = indic.length > 0 && indic.every((c) => c === 'san');
    this.sanskritOnly = sanskritOnly;

    const script = dominantIndicScriptName(text);
    note.innerHTML =
      `Roman letters for the same words — useful for reading a name or address ` +
      `aloud in a script you do not read. This is <strong>transliteration, not ` +
      `translation</strong>: the sounds are converted, the meaning is unchanged.` +
      (script ? ` Script detected: <strong>${escapeHtml(script)}</strong>.` : '') +
      (sanskritOnly
        ? ' Read as Sanskrit, so every inherent vowel is kept.'
        : ' Silent inherent vowels are dropped the way the language is spoken ' +
          '(प्रयोग → prayog). Compound words and proper names sometimes keep ' +
          'a vowel this rule drops.');

    box.textContent = transliterate(text, { schwaDeletion: !sanskritOnly });
  }

  async _copyAll() {
    if (!this.current) return;
    const active = document.querySelector('#text-tabs .tab.active');
    const which = active ? active.dataset.tab : 'text';

    let payload = this.current.text || '';
    if (which === 'translit') {
      payload = transliterate(payload, { schwaDeletion: !this.sanskritOnly });
    }
    if (which === 'entities') {
      payload = groupEntities(extractEntities(this.current.text || ''))
        .map((e) => `${e.label}: ${e.value}`).join('\n');
    }

    const ok = await copyText(payload);
    toast(ok ? 'Copied to clipboard' : 'Could not copy', ok ? 'success' : 'error');
  }
}
