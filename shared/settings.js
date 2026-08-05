/* What the user has decided, once, for the whole program.
 *
 * Small and deliberately dumb: a flat object in localStorage, defaults in one
 * place, and a notification when something changes so a page that is already
 * open follows without a reload. The theme lives next door in theme.js — it has
 * to be applied before the first paint and is therefore its own thing.
 *
 * Everything here has to survive being absent: private mode, a fresh profile,
 * a locked-down browser. A missing setting is the default, never an error.
 */

const KEY = 'epcore.settings';
const MESSAGE = 'epcore.settings';

/** Every setting, with what it means when nobody has said otherwise. */
export const DEFAULTS = {
  /* Save straight to the downloads folder instead of asking every time.
   * On by default: the dialog is a click on every single export, and the
   * answer is the same one every time. The host makes the name unique there,
   * so nothing is overwritten unseen. */
  saveWithoutDialog: true,

  /* Which saved lead layout a recording opens with. Empty means the viewer's
   * own defaults — surface ECG plus the usual catheters, whatever the study
   * actually recorded on. The layouts themselves live on the server, because
   * they belong to the person rather than to the browser profile. */
  defaultProfile: '',

  /* What lies behind the map in a saved snapshot: 'transparent', 'theme', or a
   * CSS colour. Transparent by default so the picture can go on any slide; the
   * 3D canvas is drawn with alpha anyway, and filling it was a decision taken
   * on the user's behalf. */
  snapshotBackground: 'transparent',
};

const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? JSON.parse(raw) : {};
    return (stored && typeof stored === 'object') ? stored : {};
  } catch {
    return {};                       // storage off, or something else's data
  }
}

/** Every setting, defaults filled in. */
export function all() {
  return { ...DEFAULTS, ...read() };
}

export function get(name) {
  const value = all()[name];
  return value === undefined ? undefined : value;
}

function announce(settings) {
  for (const listener of listeners) {
    try { listener(settings); } catch (e) { console.warn('[epcore] settings listener', e); }
  }
  const share = (target) => {
    try { target.postMessage({ type: MESSAGE, settings }, window.location.origin); }
    catch { /* not ours */ }
  };
  if (window.parent !== window) share(window.parent);
  for (const frame of document.querySelectorAll('iframe')) {
    if (frame.contentWindow) share(frame.contentWindow);
  }
}

export function set(name, value) {
  const next = { ...read(), [name]: value };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage off */ }
  const settings = { ...DEFAULTS, ...next };
  announce(settings);
  return settings;
}

/** Run `fn(settings)` on every change, and once now. */
export function onChange(fn) {
  listeners.add(fn);
  fn(all());
  return () => listeners.delete(fn);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== MESSAGE) return;
  // Written by whoever changed it; this side only has to notice and pass on.
  for (const listener of listeners) {
    try { listener({ ...DEFAULTS, ...event.data.settings }); } catch { /* reported above */ }
  }
  if (document.querySelector('iframe')) {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        frame.contentWindow?.postMessage(
          { type: MESSAGE, settings: event.data.settings }, window.location.origin);
      } catch { /* not ours */ }
    }
  }
});

window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  for (const listener of listeners) {
    try { listener(all()); } catch { /* reported above */ }
  }
});

const settings = { DEFAULTS, all, get, set, onChange };
window.epcoreSettings = settings;

export default settings;
