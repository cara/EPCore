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
 *
 * Pages load this module in their <head> with blocking="render". Their markup
 * ships empty, and a module runs only after the parse, which leaves time for a
 * first frame with every button and heading blank; the text then lands and
 * shoves everything below it about. Render-blocking holds that frame until the
 * text is in. Browsers honour it only in <head>, and one that does not know the
 * attribute paints early, as before.
 */

import { CATALOGUES, LANGUAGES, LANGUAGE_NAMES } from './i18n.generated.js?v=c4ae27508f81';

const STORAGE_KEY = 'epcore.language';
const DEFAULT = 'de';

/* The backend words its errors in the language the request asks for, and
 * without this the request asks in the browser's or the OS language — never
 * in the one picked here, which lives in localStorage and the DOM and does not
 * leave the page. A cookie travels with every request — once an earlier page
 * has set it, also with the ones the classic scripts send before this module
 * runs — and spares the fifty-odd fetch calls from each having to remember
 * it. web/messages.py reads it.
 *
 * Only where the backend lives, on loopback: shared/ also ships on the public
 * site, which has no backend and promises to set no cookies. Named per port
 * because cookies ignore the port, and two servers on this machine would
 * otherwise answer in each other's language. No expiry: the shell takes a new
 * port at every launch, and a kept cookie per port would only pile up. */
const LANGUAGE_COOKIE = 'epcore_language';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

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

/** Tell the backend which language the page shows — see LANGUAGE_COOKIE. */
function tellBackend(lang) {
  if (!LOOPBACK.has(location.hostname)) return;
  const name = location.port ? `${LANGUAGE_COOKIE}_${location.port}` : LANGUAGE_COOKIE;
  try {
    document.cookie = `${name}=${lang}; path=/; SameSite=Strict`;
  } catch { /* cookies refused: backend errors come in the browser's language */ }
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
  // Also when not remembered: the page shows this language either way, and
  // a cookie left over from an earlier pick must not outvote what it shows.
  tellBackend(lang);
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
