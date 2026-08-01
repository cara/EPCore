/* Filling the pages in, in the chosen language.
 *
 * Markup carries keys, not text: `data-i18n="viewer.measure"` on the element,
 * `data-i18n-title` and `data-i18n-placeholder` for the attributes. Switching
 * language re-applies over the live document, so nothing reloads and no state
 * is lost — which matters here, where a reload throws away a decoded recording.
 *
 * A missing key renders as ⟦key⟧ rather than falling back to another language.
 * A silent fallback is how half-translated interfaces ship: the gap only ever
 * shows up to the person who speaks the language nobody on the team does.
 */

import { CATALOGUES, LANGUAGES, LANGUAGE_NAMES } from './i18n.generated.js?v=f2922480a034';

const STORAGE_KEY = 'epcore.language';
const DEFAULT = 'de';

let current = DEFAULT;

/** The language to start in: what was chosen, else the browser's, else German. */
function initial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LANGUAGES.includes(stored)) return stored;
  } catch { /* private mode */ }
  for (const tag of navigator.languages || [navigator.language || '']) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return DEFAULT;
}

/** One string. `params` fills {placeholders}. */
function t(key, params) {
  const text = CATALOGUES[current]?.[key];
  if (text === undefined) return `⟦${key}⟧`;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    (name in params ? String(params[name]) : whole));
}

/** Fill in every marked element below `root`. Safe to call repeatedly. */
function apply(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const text = t(el.dataset.i18n);
    // A few strings carry inline markup — an emphasised word, a <b> around a
    // menu name. Those are ours, from the catalogue, not from a recording.
    if (text.includes('<')) el.innerHTML = text;
    else el.textContent = text;
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    // A title is not an accessible name. Where the element has no visible
    // label, it needs both.
    if (!el.textContent.trim() && !el.hasAttribute('data-i18n-keep-label')) {
      el.setAttribute('aria-label', el.title);
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  }
}

/** Switch language: remember it, tell the document, re-apply, tell listeners. */
function setLanguage(lang, { remember = true } = {}) {
  if (!LANGUAGES.includes(lang)) return current;
  current = lang;
  document.documentElement.lang = lang;
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch { /* private mode: it holds for this page and no longer */ }
  }
  apply();
  window.dispatchEvent(new CustomEvent('epcore:language', { detail: { lang } }));
  return current;
}

const language = () => current;

setLanguage(initial(), { remember: false });
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => apply());
}

const i18n = { t, apply, setLanguage, language, LANGUAGES, LANGUAGE_NAMES };
window.epcoreI18n = i18n;

export { i18n, t, apply, setLanguage, language, LANGUAGES, LANGUAGE_NAMES };
