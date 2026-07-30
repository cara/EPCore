/* One entry point between the native menu, the tab shell and whatever page is open.
 *
 * Menu actions run on the GUI thread and cannot return a value to the page, so
 * the shell drives the page instead: it evaluates `epcoreMenu('<action>')`.
 * Before the merge that call was the handler's own name, which worked only
 * because there was one page. With two modules an unknown identifier in
 * evaluate_js fails silently, so the menu entry would simply do nothing and
 * look broken rather than report anything.
 *
 * The same file runs in three places and has to behave in all of them:
 *
 *   - the shell (top frame)   — routes an action to the module that owns it,
 *                               switching tabs first
 *   - a module (in a frame)   — performs what it claimed, forwards the rest up
 *   - a standalone page       — the public site, or /eptrace opened directly:
 *                               no shell and no backend, so navigation and any
 *                               backend call degrade instead of throwing
 */

const OWNER = {
  // Recordings — the EPTrace module.
  openPath: '/eptrace',
  openFile: '/eptrace',
  openFolder: '/eptrace',
  openExport: '/eptrace',
  exportPNG: '/eptrace',
  exportPDF: '/eptrace',
  exportCSV: '/eptrace',
  togglePlay: '/eptrace',
  measureIntervals: '/eptrace',
  toggleStim: '/eptrace',
  toggleTheme: '/eptrace',
  openAnonymizer: '/eptrace',
  // The cross-link: a map point names a moment, the signal view shows it.
  showMoment: '/eptrace',
  // Maps — the EPView module.
  openMap: '/epview/',
  exportMap: '/epview/',
  // Anywhere.
  goHome: null,
  goSignals: null,
  goMaps: null,
};

const PANE_OF = { '/eptrace': 'eptrace', '/epview/': 'epview' };
const REPLAY_KEY = 'epcore.pendingMenuAction';
const MESSAGE = 'epcore.menu';

const handlers = Object.create(null);
let ready = false;

/* --- where are we? -------------------------------------------------------- */

/** The shell frame, or null when this page stands alone. */
function shell() {
  try {
    if (window.parent !== window && typeof window.parent.epcoreShowPane === 'function') {
      return window.parent;
    }
  } catch {
    // Cross-origin parent — not our shell.
  }
  return null;
}

const isShell = () => typeof window.epcoreShowPane === 'function' && window.parent === window;

/* --- the native host ------------------------------------------------------ */

/** pywebview's API, wherever it lives.
 *
 * It is injected into the top frame only, so a module running inside the shell
 * has to reach through the parent. Same origin, so this is a plain property
 * read — but it has to be a lookup rather than a captured reference, because
 * the injection happens after the page has loaded.
 */
function api() {
  if (window.pywebview?.api) return window.pywebview.api;
  try {
    if (window.parent !== window && window.parent.pywebview?.api) {
      return window.parent.pywebview.api;
    }
  } catch { /* cross-origin */ }
  return null;
}

const hasNativeHost = () => api() !== null;

/* --- the backend ---------------------------------------------------------- */

/* The only absolute URL in the whole static tree. The public site has no
 * backend, so everything that needs one asks here first and degrades to
 * "that part is in the app" instead of throwing on a 404 nobody sees. */
const HEALTH_URL = '/api/health';
let backendProbe = null;

function hasBackend() {
  if (!backendProbe) {
    backendProbe = fetch(HEALTH_URL).then(r => r.ok).catch(() => false);
  }
  return backendProbe;
}

/** Where a map point falls in the recording, or null if nothing is calibrated.
 *
 * The caller must not invent a fallback: a jump computed from an offset nobody
 * established lands on a confident-looking wrong beat, and the picture says
 * nothing about it.
 */
async function locate(studyId, tMap, sampleRate) {
  if (!await hasBackend()) return null;
  const query = new URLSearchParams({ study_id: studyId, t_map: tMap, sample_rate: sampleRate });
  const response = await fetch(`/api/study/locate?${query}`);
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`locate -> ${response.status}`);
  return response.json();
}

/* --- routing -------------------------------------------------------------- */

function report(message) {
  // Visible, not console-only: a menu entry that does nothing is the failure
  // mode this whole file exists to prevent.
  const parent = shell();
  if (parent && typeof parent.epcoreNotify === 'function') parent.epcoreNotify(message);
  else if (typeof window.epcoreNotify === 'function') window.epcoreNotify(message);
  else console.warn('[epcore]', message);
}

/** Shell only: which pane claimed which action, and what could not be delivered yet. */
const claimed = Object.create(null);
const queued = [];

function deliver(pane, action, payload) {
  const frame = window.epcoreFrames?.[pane];
  if (!frame?.contentWindow) return false;
  frame.contentWindow.postMessage({ type: MESSAGE, action, payload }, window.location.origin);
  return true;
}

function routeFromShell(action, payload) {
  const owner = OWNER[action];
  const pane = claimed[action] ?? (owner ? PANE_OF[owner] : null);
  if (!pane) {
    report(`Unbekannte Menü-Aktion: ${action}`);
    return;
  }
  // Switch first: the action is about to change what that module shows, and
  // doing it behind a hidden tab looks like nothing happened.
  window.epcoreShowPane(pane);
  if (!deliver(pane, action, payload)) {
    // The frame was just created and has not announced itself yet; hold it.
    queued.push({ pane, action, payload });
  }
}

function navigate(to, action, payload) {
  if (action) {
    try {
      sessionStorage.setItem(REPLAY_KEY, JSON.stringify({ action, payload }));
    } catch {
      // Private mode, or storage full. The navigation is still worth doing: the
      // user lands on the right page and repeats the action themselves.
    }
  }
  window.location.href = to;
}

/* --- the public surface --------------------------------------------------- */

const epcore = {
  locate,
  hasBackend,
  api,
  hasNativeHost,

  /** A page declares the menu actions it implements. */
  register(map) {
    Object.assign(handlers, map);
    ready = true;
    const parent = shell();
    if (parent) {
      // Tell the shell what lands here, so it can switch tabs before sending.
      parent.postMessage(
        { type: 'epcore.claim', actions: Object.keys(handlers), src: window.location.pathname },
        window.location.origin);
    }
    epcore.replayPending();
  },

  owner(action) {
    return action in OWNER ? OWNER[action] : undefined;
  },

  actions() {
    return Object.keys(OWNER);
  },

  /** Go to another part of the app. Inside the shell that is a tab switch. */
  async go(where) {
    const pane = where === '/' ? 'start' : (PANE_OF[where] ?? 'start');
    if (isShell()) {
      window.epcoreShowPane(pane);
      return;
    }
    const parent = shell();
    if (parent) {
      parent.epcoreShowPane(pane);
      return;
    }
    if (where !== '/' && !await hasBackend()) {
      report('Dieser Bereich ist nur in der EPCore-App verfügbar.');
      return;
    }
    navigate(where, null, null);
  },

  replayPending() {
    let pending = null;
    try {
      const raw = sessionStorage.getItem(REPLAY_KEY);
      if (raw) {
        pending = JSON.parse(raw);
        sessionStorage.removeItem(REPLAY_KEY);
      }
    } catch {
      pending = null;
    }
    if (pending && handlers[pending.action]) handlers[pending.action](pending.payload);
  },
};

/** Called by the native menu, by an in-page menu, and by the shell's tiles. */
function epcoreMenu(action, payload) {
  if (action === 'goHome') return epcore.go('/');
  if (action === 'goSignals') return epcore.go('/eptrace');
  if (action === 'goMaps') return epcore.go('/epview/');

  if (isShell()) return routeFromShell(action, payload);

  if (handlers[action]) return handlers[action](payload);

  const parent = shell();
  if (parent) {
    // Aimed at the other module. The shell knows who claimed what.
    return parent.epcoreMenu(action, payload);
  }

  const owner = epcore.owner(action);
  if (owner === undefined) {
    report(`Unbekannte Menü-Aktion: ${action}`);
    return undefined;
  }
  if (owner && !window.location.pathname.startsWith(owner)) {
    return navigate(owner, action, payload);
  }
  report(ready
    ? `Diese Ansicht kann „${action}" nicht ausführen.`
    : `„${action}" kam an, bevor die Seite bereit war.`);
  return undefined;
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || !event.data) return;

  if (event.data.type === MESSAGE && handlers[event.data.action]) {
    handlers[event.data.action](event.data.payload);
    return;
  }
  if (event.data.type === 'epcore.claim' && isShell()) {
    const pane = event.data.src?.startsWith('/epview') ? 'epview' : 'eptrace';
    for (const action of event.data.actions) claimed[action] = pane;
    for (let i = queued.length - 1; i >= 0; i--) {
      if (queued[i].pane === pane && deliver(pane, queued[i].action, queued[i].payload)) {
        queued.splice(i, 1);
      }
    }
  }
});

window.epcore = epcore;
window.epcoreMenu = epcoreMenu;

export { epcore, epcoreMenu, OWNER };
