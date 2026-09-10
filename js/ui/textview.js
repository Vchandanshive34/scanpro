/**
 * Recognised-text screen: the text itself, what was found in it, and a
 * transliteration.
 *
 * Words the engine was unsure about are highlighted rather than hidden. OCR is
 * never perfect, and a scanner that quietly presents a wrong digit as fact is
 * worse than one that shows you where to look.
 */

import { $, el, toast, copyText, escapeHtml, confirmSheet } from './dom.js';
import {
  extractEntities, groupEntities, transliterate, canTransliterate,
  translate, TRANSLATION_PROVIDERS,
} from '../core/lens.js';
import { LANGUAGES, LANG_BY_CODE, dominantIndicScriptName } from '../core/languages.js';
import { getSettings, setSetting } from '../core/db.js';

const LOW_CONFIDENCE = 72;

export class TextViewController {
  constructor({ onBack }) {
    this.onBack = onBack;
    this.current = null;
    this.translations = new Map();   // cache key -> translated text

    $('#btn-text-back').addEventListener('click', () => this.onBack && this.onBack());
    $('#btn-copy-text').addEventListener('click', () => this._copyAll());

    $('#text-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      this._selectTab(tab.dataset.tab);
    });

    this._buildTargetOptions();
    $('#btn-translate').addEventListener('click', () => this._runTranslation());
    $('#translate-target').addEventListener('change', (e) => {
      setSetting('translateTarget', e.target.value);
      this._showCachedTranslation();
    });
  }

  _buildTargetOptions() {
    const select = $('#translate-target');
    select.innerHTML = '';
    for (const lang of LANGUAGES) {
      if (!lang.iso) continue;
      select.append(el('option', {
        value: lang.iso,
        text: lang.code === 'eng' ? lang.name : `${lang.name} · ${lang.native}`,
      }));
    }
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
    this._renderTranslatePanel(result);
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

  /* ---------------------------- Translation ---------------------------- */

  /**
   * The source language comes from what the page was actually read in, which
   * beats asking a service to guess from a page of OCR output.
   */
  _sourceIso() {
    const langs = (this.current && this.current.langs) || [];
    const indic = langs
      .map((c) => LANG_BY_CODE[c])
      .filter((l) => l && l.script !== 'latin');
    if (indic.length === 1) return indic[0].iso;
    if (indic.length > 1) return indic[0].iso;
    return LANG_BY_CODE.eng ? LANG_BY_CODE.eng.iso : 'en';
  }

  _cacheKey(target, provider) {
    const text = (this.current && this.current.text) || '';
    return `${provider}:${this._sourceIso()}>${target}:${text.length}:${text.slice(0, 60)}`;
  }

  async _renderTranslatePanel(result) {
    const settings = await getSettings();
    this.settings = settings;

    const select = $('#translate-target');
    const preferred = settings.translateTarget || 'en';
    select.value = [...select.options].some((o) => o.value === preferred) ? preferred : 'en';

    const provider = settings.translateProvider || 'mymemory';
    const def = TRANSLATION_PROVIDERS[provider] || TRANSLATION_PROVIDERS.mymemory;
    const note = $('#translate-note');

    if (provider === 'none') {
      note.innerHTML =
        'Translation is switched off, so nothing is ever sent anywhere. ' +
        'Turn on a provider in <strong>Settings → Translation</strong> to use it.';
      $('#btn-translate').disabled = true;
    } else {
      note.innerHTML =
        `Unlike everything else in this app, translation needs a service: the ` +
        `text on this page is sent to <strong>${escapeHtml(def.name.replace(/ \(.*\)$/, ''))}</strong> ` +
        `when you tap Translate, and not before. ` +
        `<strong>Do not translate pages holding Aadhaar, PAN or bank details</strong> ` +
        `unless you are using your own server or key.`;
      $('#btn-translate').disabled = false;
    }

    $('#translate-progress').hidden = true;
    this._showCachedTranslation();
    void result;
  }

  _showCachedTranslation() {
    const box = $('#translate-text');
    const provider = (this.settings && this.settings.translateProvider) || 'mymemory';
    const cached = this.translations.get(this._cacheKey($('#translate-target').value, provider));

    if (cached) {
      box.textContent = cached;
      box.hidden = false;
      $('#btn-translate').textContent = 'Translate again';
    } else {
      box.hidden = true;
      $('#btn-translate').textContent = 'Translate page';
    }
  }

  async _runTranslation() {
    if (!this.current || !this.current.text) return;

    const settings = this.settings || await getSettings();
    const provider = settings.translateProvider || 'mymemory';
    const target = $('#translate-target').value;
    const source = this._sourceIso();

    if (source === target) {
      toast('That is already the language of this page.');
      return;
    }

    // Text leaves the device here, so ask once and remember the answer.
    if (!settings.translateConsent) {
      const def = TRANSLATION_PROVIDERS[provider] || {};
      const ok = await confirmSheet(
        'Send this page for translation?',
        'Send and translate',
        {
          danger: false,
          note: `The recognised text will be sent to ${def.name || provider}. ` +
                'Everything else in ScanPro stays on this device.',
        });
      if (!ok) return;
      await setSetting('translateConsent', true);
      settings.translateConsent = true;
      this.settings = settings;
    }

    const button = $('#btn-translate');
    const progress = $('#translate-progress');
    const fill = $('#translate-progress-fill');
    const label = $('#translate-progress-label');

    button.disabled = true;
    progress.hidden = false;
    fill.style.width = '0%';
    label.textContent = 'Translating…';

    try {
      const out = await translate(this.current.text, {
        target,
        source,
        provider,
        url: settings.translateUrl,
        apiKey: settings.translateKey,
        email: settings.translateEmail,
        onProgress: ({ done, total }) => {
          fill.style.width = `${Math.round((done / total) * 100)}%`;
          label.textContent = total > 1
            ? `Translating… part ${Math.min(done + 1, total)} of ${total}`
            : 'Translating…';
        },
      });

      this.translations.set(this._cacheKey(target, provider), out);
      this._showCachedTranslation();
      toast('Translated', 'success');
    } catch (err) {
      console.error(err);
      toast(err.message || 'Translation failed.', 'error', 6000);
    } finally {
      button.disabled = false;
      progress.hidden = true;
    }
  }

  async _copyAll() {
    if (!this.current) return;
    const active = document.querySelector('#text-tabs .tab.active');
    const which = active ? active.dataset.tab : 'text';

    let payload = this.current.text || '';
    if (which === 'translit') {
      payload = transliterate(payload, { schwaDeletion: !this.sanskritOnly });
    }
    if (which === 'translate') {
      const provider = (this.settings && this.settings.translateProvider) || 'mymemory';
      const cached = this.translations.get(
        this._cacheKey($('#translate-target').value, provider));
      if (!cached) { toast('Nothing translated yet — tap Translate page first.'); return; }
      payload = cached;
    }
    if (which === 'entities') {
      payload = groupEntities(extractEntities(this.current.text || ''))
        .map((e) => `${e.label}: ${e.value}`).join('\n');
    }

    const ok = await copyText(payload);
    toast(ok ? 'Copied to clipboard' : 'Could not copy', ok ? 'success' : 'error');
  }
}
