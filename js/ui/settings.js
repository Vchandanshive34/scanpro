/**
 * Settings, including the language-pack manager.
 *
 * A pack downloads once and is then cached for offline use, so the screen
 * shows the size up front — on a metered connection that matters, and
 * Sanskrit is 12 MB.
 */

import { $, el, toast, formatBytes } from './dom.js';
import { LANGUAGES } from '../core/languages.js';
import { FILTER_MODES, FILTER_LABELS } from '../core/enhance.js';
import { TRANSLATION_PROVIDERS } from '../core/lens.js';
import { getSettings, setSetting, storageEstimate } from '../core/db.js';
import { ocrEngine } from '../core/ocr.js';

export class SettingsController {
  constructor({ onBack, onChange }) {
    this.onBack = onBack;
    this.onChange = onChange;
    this.settings = null;

    $('#btn-settings-back').addEventListener('click', () => this.onBack && this.onBack());
    this._buildStaticOptions();
    this._bind();
  }

  _buildStaticOptions() {
    const filterSel = $('#set-filter');
    filterSel.innerHTML = '';
    for (const mode of FILTER_MODES) {
      filterSel.append(el('option', { value: mode, text: FILTER_LABELS[mode] }));
    }

    const provSel = $('#set-translate-provider');
    provSel.innerHTML = '';
    for (const [key, def] of Object.entries(TRANSLATION_PROVIDERS)) {
      provSel.append(el('option', { value: key, text: def.name }));
    }
  }

  _bind() {
    const save = async (key, value) => {
      await setSetting(key, value);
      this.settings[key] = value;
      if (this.onChange) this.onChange(this.settings);
    };

    $('#set-filter').addEventListener('change', (e) => save('defaultFilter', e.target.value));
    $('#set-autocapture').addEventListener('change', (e) => save('autoCapture', e.target.checked));
    $('#set-autoocr').addEventListener('change', (e) => save('autoOcr', e.target.checked));
    $('#set-quality').addEventListener('change', (e) => save('maxDimension', Number(e.target.value)));
    $('#set-pagesize').addEventListener('change', (e) => save('pdfPageSize', e.target.value));

    $('#set-translate-provider').addEventListener('change', (e) => {
      save('translateProvider', e.target.value);
      this._updateTranslationRows(e.target.value);
    });
    $('#set-translate-url').addEventListener('change', (e) => save('translateUrl', e.target.value.trim()));
    $('#set-translate-key').addEventListener('change', (e) => save('translateKey', e.target.value.trim()));
    $('#set-translate-email').addEventListener('change', (e) => save('translateEmail', e.target.value.trim()));

    // Turning the prompt back on clears the stored consent, so the next
    // translation asks again.
    $('#set-translate-ask').addEventListener('change', (e) => save('translateConsent', !e.target.checked));
  }

  _updateTranslationRows(provider) {
    const def = TRANSLATION_PROVIDERS[provider] || {};
    $('#row-translate-url').hidden = !def.needsUrl;
    $('#row-translate-key').hidden = !def.needsKey;
    $('#row-translate-email').hidden = !def.needsEmail;
    $('#translate-provider-note').textContent = def.note || '';
  }

  async show() {
    this.settings = await getSettings();
    const s = this.settings;

    $('#set-filter').value = s.defaultFilter;
    $('#set-autocapture').checked = !!s.autoCapture;
    $('#set-autoocr').checked = !!s.autoOcr;
    $('#set-quality').value = String(s.maxDimension);
    $('#set-pagesize').value = s.pdfPageSize;

    const provider = s.translateProvider || 'none';
    $('#set-translate-provider').value = provider;
    $('#set-translate-url').value = s.translateUrl || '';
    $('#set-translate-key').value = s.translateKey || '';
    $('#set-translate-email').value = s.translateEmail || '';
    $('#set-translate-ask').checked = !s.translateConsent;
    this._updateTranslationRows(provider);

    this._renderLanguages();
    this._renderStorage();
  }

  _renderLanguages() {
    const list = $('#lang-list');
    list.innerHTML = '';

    const selected = new Set(this.settings.ocrLangs || ['eng']);
    const installed = new Set(this.settings.installedLangs || ['eng']);

    for (const lang of LANGUAGES) {
      const isCore = !!lang.core;
      const isInstalled = installed.has(lang.code) || isCore;

      const check = el('input', {
        type: 'checkbox',
        class: 'lang-check',
        checked: selected.has(lang.code) || isCore,
        disabled: isCore,
      });

      const state = el('button', {
        class: `lang-state ${isInstalled ? 'installed' : ''}`,
        text: isInstalled ? 'Ready' : 'Download',
      });

      check.addEventListener('change', async () => {
        const next = new Set(this.settings.ocrLangs || []);
        if (check.checked) {
          next.add(lang.code);
          if (!isInstalled) await this._install(lang, state);
        } else {
          next.delete(lang.code);
        }
        next.add('eng');
        await setSetting('ocrLangs', [...next]);
        this.settings.ocrLangs = [...next];
        if (this.onChange) this.onChange(this.settings);
      });

      state.addEventListener('click', async () => {
        if (state.classList.contains('installed')) {
          toast(`${lang.name} is already available offline.`);
          return;
        }
        await this._install(lang, state);
      });

      list.append(el('div', { class: 'lang-row' }, [
        check,
        el('div', { class: 'lang-names' }, [
          el('div', { class: 'lang-native', text: lang.native }),
          el('div', { class: 'lang-en', text: `${lang.name} · ${lang.size} MB` }),
        ]),
        state,
      ]));
    }
  }

  async _install(lang, stateButton) {
    stateButton.textContent = 'Downloading…';
    stateButton.disabled = true;

    ocrEngine.onProgress = ({ stage, progress }) => {
      if (stage === 'Loading language') {
        stateButton.textContent = `${Math.round((progress || 0) * 100)}%`;
      }
    };

    try {
      await ocrEngine.installLanguage(lang.code);

      const installed = new Set(this.settings.installedLangs || ['eng']);
      installed.add(lang.code);
      await setSetting('installedLangs', [...installed]);
      this.settings.installedLangs = [...installed];

      stateButton.textContent = 'Ready';
      stateButton.classList.add('installed');
      toast(`${lang.name} is ready and works offline.`, 'success');
    } catch (err) {
      console.error(err);
      stateButton.textContent = 'Retry';
      toast(`Could not download ${lang.name}. Check your connection.`, 'error');
    } finally {
      stateButton.disabled = false;
      ocrEngine.onProgress = null;
      this._renderStorage();
    }
  }

  async _renderStorage() {
    const { usage, quota } = await storageEstimate();
    const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
    $('#storage-fill').style.width = `${pct}%`;
    $('#storage-note').textContent = quota
      ? `${formatBytes(usage)} used of about ${formatBytes(quota)} available on this device.`
      : 'Storage usage is not reported by this browser.';
  }
}
