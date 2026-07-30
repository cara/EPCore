/* One entry point between the native menu and whatever page is open.
 *
 * Menu actions run on the GUI thread and cannot return a value to the page, so
 * the shell drives the page instead: it evaluates `epcoreMenu('<action>')`.
 * Before the merge that call was the handler's own name, which worked only
 * because there was one page. With two modules in one window, half the menu
 * would land on a page that has never heard of the function — and an unknown
 * identifier in evaluate_js fails silently, so the menu entry would simply do
 * nothing and look broken rather than report anything.
 *
 * So: a page registers what it can do, this file knows which page owns each
 * action, and an action aimed elsewhere navigates there and replays once the
 * target page has registered. An action nobody claims is reported, not swallowed.
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
  // Maps — the EPView module.
  openMap: '/epview/',
  exportMap: '/epview/',
  // The cross-link: a map point names a moment, the signal view shows it.
  // Owned by the signal view because that is where the cursor ends up; the
  // bridge navigates there and replays, which is the whole reason replay exists.
  showMoment: '/eptrace',
  // Anywhere.
  goHome: null,
  goSignals: null,
  goMaps: null,
};

const REPLAY_KEY = 'epcore.pendingMenuAction';

const handlers = Object.create(null);
let ready = false;

function navigate(to, action, payload) {
  if (action) {
    try {
      sessionStorage.setItem(REPLAY_KEY, JSON.stringify({ action, payload }));
    } catch {
      // Private mode, or storage full. The navigation is still worth doing:
      // the user lands on the right page and repeats the action themselves.
    }
  }
  window.location.href = to;
}

function report(message) {
  // Visible, not console-only: a menu entry that does nothing is the failure
  // mode this whole file exists to prevent.
  if (typeof window.epcoreNotify === 'function') window.epcoreNotify(message);
  else console.warn('[epcore]', message);
}

/* This file is served two ways: by the app, which has the backend behind it,
 * and by the public site, which does not. The only absolute URL in the whole
 * static tree is the health probe below — everything that needs the backend
 * asks first, so the site degrades to "that part is in the app" instead of
 * throwing on a 404 nobody sees. */
const HEALTH_URL = '/api/health';
let backendProbe = null;

/** Is a backend behind this page? Probed once, then remembered. */
function hasBackend() {
  if (!backendProbe) {
    backendProbe = fetch(HEALTH_URL, { method: 'GET' })
      .then(r => r.ok)
      .catch(() => false);
  }
  return backendProbe;
}

/** Ask the backend where a map point falls in the recording.
 *
 * Returns null when nothing has been calibrated (409) or when there is no
 * backend at all. The caller must not invent a fallback: a jump computed from
 * an offset nobody established lands on a confident-looking wrong beat, and
 * the picture says nothing about it.
 */
async function locate(studyId, tMap, sampleRate) {
  if (!await hasBackend()) return null;
  const query = new URLSearchParams({ study_id: studyId, t_map: tMap, sample_rate: sampleRate });
  const response = await fetch(`${HEALTH_URL.replace('/health', '/study/locate')}?${query}`);
  if (response.status === 409) return null;
  if (!response.ok) throw new Error(`locate -> ${response.status}`);
  return response.json();
}

const epcore = {
  locate,
  hasBackend,

  /** A page declares the menu actions it implements. */
  register(map) {
    Object.assign(handlers, map);
    ready = true;
    epcore.replayPending();
  },

  /** Which route owns an action, or null if any page can do it. */
  owner(action) {
    return action in OWNER ? OWNER[action] : undefined;
  },

  /** Every action the menu may send. Cross-checked against the shell's menu. */
  actions() {
    return Object.keys(OWNER);
  },

  /** Navigate to another part of the app.
   *
   * On the public site there is no other part — the signal view needs the
   * decoder. Saying so beats a 404 that looks like a broken link.
   */
  async go(where) {
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
    if (pending && handlers[pending.action]) {
      handlers[pending.action](pending.payload);
    }
  },
};

/** Called by the native menu. Also usable from an in-page menu. */
function epcoreMenu(action, payload) {
  if (action === 'goHome') return epcore.go('/');
  if (action === 'goSignals') return epcore.go('/eptrace');
  if (action === 'goMaps') return epcore.go('/epview/');

  const owner = epcore.owner(action);
  if (owner === undefined) {
    report(`Unbekannte Menü-Aktion: ${action}`);
    return undefined;
  }
  if (handlers[action]) return handlers[action](payload);
  if (owner && !window.location.pathname.startsWith(owner)) {
    return navigate(owner, action, payload);
  }
  report(ready
    ? `Diese Ansicht kann „${action}" nicht ausführen.`
    : `„${action}" kam an, bevor die Seite bereit war.`);
  return undefined;
}

window.epcore = epcore;
window.epcoreMenu = epcoreMenu;

export { epcore, epcoreMenu, OWNER };
