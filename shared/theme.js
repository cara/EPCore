/* Which theme the whole program is in.
 *
 * One choice, not one per page. The signal view kept it in its own
 * localStorage key and applied it by hand to six elements; the map view and the
 * shell knew nothing about it, so switching to light left the tab bar and the
 * 3D view dark and the application looked like two programs again.
 *
 * The state lives in one key, the switch is one attribute on the root element
 * (`data-theme`), and the tokens in shared/epcore.css do the rest. What cannot
 * be done in CSS — a canvas, a WebGL scene — subscribes with onChange.
 *
 * Pages in frames announce a change upwards; the shell applies it to itself and
 * passes it to the other frame, so both modules switch together. A page opened
 * on its own does the same thing minus the neighbours.
 */

const KEY = 'epcore.theme';
//: What the signal view used before the theme became shared. Read once, so a
//: user who had chosen light keeps it.
const OLD_KEY = 'eptrace-theme';
const MESSAGE = 'epcore.theme';

const listeners = new Set();

function read() {
  try {
    return localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || 'dark';
  } catch {
    return 'dark';                 // private mode, or storage disabled
  }
}

/** 'light' or 'dark' — never anything else, whatever is in storage. */
export function current() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Paint this document, without storing or telling anybody. */
export function apply(name) {
  const theme = name === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) {
    try { listener(theme); } catch (e) { console.warn('[epcore] theme listener', e); }
  }
  return theme;
}

function share(theme) {
  // Upwards to the shell, which owns the other frames.
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: MESSAGE, theme }, window.location.origin);
    }
  } catch { /* cross-origin parent — not our shell */ }
  // Downwards, for the shell itself.
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      frame.contentWindow?.postMessage({ type: MESSAGE, theme }, window.location.origin);
    } catch { /* not ours */ }
  }
}

/** Choose a theme: stored, painted here, and passed to the other panes. */
export function set(name) {
  const theme = apply(name);
  try { localStorage.setItem(KEY, theme); } catch { /* storage disabled */ }
  share(theme);
  return theme;
}

export function toggle() {
  return set(current() === 'dark' ? 'light' : 'dark');
}

/** Run `fn(theme)` whenever the theme changes, and once now. */
export function onChange(fn) {
  listeners.add(fn);
  fn(current());
  return () => listeners.delete(fn);
}

/** A token off the root element, for the things CSS cannot paint. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== MESSAGE) return;
  if (event.data.theme === current()) return;
  apply(event.data.theme);
  // The shell has to keep passing it on; a module frame has nobody below it.
  if (document.querySelector('iframe')) share(event.data.theme);
});

// Another tab, or the shell writing while this frame was hidden.
window.addEventListener('storage', (event) => {
  if (event.key === KEY && event.newValue) apply(event.newValue);
});

apply(read());

const theme = { current, apply, set, toggle, onChange, token };
window.epcoreTheme = theme;

export default theme;
