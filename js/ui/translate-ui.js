/**
 * Shared translation flow.
 *
 * Both the document text screen and the Lens screen offer translation, and
 * both must obey the same rule: nothing leaves the device until the reader has
 * been told which service will receive it and has agreed. That check is worth
 * exactly one implementation — duplicating it is how one copy quietly drifts
 * and starts sending text without asking.
 */

import { confirmSheet, toast } from './dom.js';
import { translate, TRANSLATION_PROVIDERS } from '../core/lens.js';
import { LANG_BY_CODE } from '../core/languages.js';
import { getSettings, setSetting } from '../core/db.js';

/** Human name for an ISO 639-1 code, for labels like "Translate → Marathi". */
export function languageName(iso) {
  const lang = Object.values(LANG_BY_CODE).find((l) => l.iso === iso);
  return lang ? lang.name : (iso || '').toUpperCase();
}

/** The language a page was read in, which beats asking a service to guess. */
export function sourceIsoFor(langs) {
  const indic = (langs || [])
    .map((c) => LANG_BY_CODE[c])
    .filter((l) => l && l.script !== 'latin');
  if (indic.length) return indic[0].iso;
  return 'en';
}

/**
 * Translate text, asking permission the first time.
 *
 * @param {string} text
 * @param {Object} options
 *   sourceIso   language of the text
 *   targetIso   language to translate into; defaults to the saved preference
 *   onStart     called once consent is settled, before any request. Show a
 *               busy indicator here and not before — a blocking overlay put
 *               up earlier covers the consent sheet and the buttons cannot be
 *               reached.
 *   onProgress  ({done, total}) => void
 * @returns {Promise<{text, target, provider}|null>} null when declined
 */
export async function translateWithConsent(text, options = {}) {
  const settings = await getSettings();
  const provider = settings.translateProvider || 'mymemory';

  if (provider === 'none') {
    throw new Error('Translation is switched off. Choose a provider in Settings.');
  }

  const target = options.targetIso || settings.translateTarget || 'en';
  const source = options.sourceIso || null;

  if (source && source === target) {
    throw new Error(`This is already in ${languageName(target)}.`);
  }

  if (!settings.translateConsent) {
    const def = TRANSLATION_PROVIDERS[provider] || {};
    const ok = await confirmSheet(
      'Send this text for translation?',
      'Send and translate',
      {
        danger: false,
        note: `The recognised text will be sent to ${def.name || provider}. ` +
              'Everything else in ScanPro stays on this device.',
      });
    if (!ok) return null;
    await setSetting('translateConsent', true);
  }

  if (options.onStart) options.onStart();

  const translated = await translate(text, {
    target,
    source,
    provider,
    url: settings.translateUrl,
    apiKey: settings.translateKey,
    email: settings.translateEmail,
    onProgress: options.onProgress,
  });

  return { text: translated, target, provider };
}

/** Saved target language, for labelling a button before anything is sent. */
export async function preferredTarget() {
  const settings = await getSettings();
  return settings.translateTarget || 'en';
}

export { toast };
