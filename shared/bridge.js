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
  openBulk: '/eptrace',
  openExport: '/eptrace',
  exportPNG: '/eptrace',
  exportPDF: '/eptrace',
  exportCSV: '/eptrace',
  togglePlay: '/eptrace',
  measureIntervals: '/eptrace',
  toggleTheme: '/eptrace',
  openAnonymizer: '/eptrace',
  // The cross-link: a map point names a moment, the signal view shows it.
  showMoment: '/eptrace',
  // Maps — the EPView module. A map export is a folder; the single-file case
  // is the exception and has its own action rather than being the default.
  openMap: '/epview/',
  openMapFile: '/epview/',
  // A path the shell already decided is a map: EPView reads it through the
  // backend, because a page cannot open a file off the disk.
  openMapPath: '/epview/',
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

/* Was schiefgeht, in das Protokoll der Anwendung.
 *
 * Eine WebView hat keine Konsole, in die jemand schauen könnte. Zwei Fehler
 * dieser Sitzung waren genau deshalb unsichtbar: eine Menü-Aktion, die in einem
 * Ereignis-Zuhörer `openPath is not defined` warf, und ein Schnitt, der auf
 * einem Rechner die Karte leerte und sonst nirgends. Beide wären eine Zeile im
 * Protokoll gewesen.
 *
 * Nur im Fenster, nicht im Browser: dort gibt es eine Konsole, und ein zweiter
 * Weg dorthin wäre Lärm. */
(() => {
  const native = api();
  if (!native || typeof native.report !== 'function') return;
  const send = (level, text) => {
    try { native.report(level, String(text).slice(0, 2000), location.pathname); }
    catch { /* das Protokollieren darf nie das sein, was etwas kaputtmacht */ }
  };
  addEventListener('error', (event) => {
    send('error', `${event.message} (${event.filename}:${event.lineno})`);
  });
  addEventListener('unhandledrejection', (event) => {
    send('error', `unhandled rejection: ${event.reason && event.reason.message || event.reason}`);
  });
  /* console.warn('%d von %d', a, b) ist die übliche Schreibweise, und ohne das
   * hier stünde im Protokoll wörtlich „%d von %d" mit den Zahlen hinten dran.
   * Ein Protokoll, das man erst zusammensetzen muss, ist ein schlechteres
   * Protokoll — und es ist der einzige Weg, auf dem das Fenster etwas sagt. */
  const asText = (value) => (value && value.message) ? value.message : String(value);
  const merge = (args) => {
    const [first, ...rest] = args;
    if (typeof first !== 'string' || !/%[sdifoOc]/.test(first)) {
      return args.map(asText).join(' ');
    }
    let next = 0;
    const filled = first.replace(/%([sdifoOc%])/g, (match, kind) => {
      if (kind === '%') return '%';
      if (kind === 'c') { next++; return ''; }        // Stilangabe, kein Wert
      if (next >= rest.length) return match;
      const value = rest[next++];
      if (kind === 'd' || kind === 'i') return String(Math.trunc(Number(value)));
      if (kind === 'f') return String(Number(value));
      return asText(value);
    });
    return [filled, ...rest.slice(next).map(asText)].join(' ');
  };

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      send(level === 'warn' ? 'warning' : 'error', merge(args));
    };
  }
})();

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

/** What lies under a path on this machine, or null without a backend.
 *
 * A native dialog hands back a path, and a page cannot open a file off the
 * disk. The application's backend lists and reads it instead; on the public
 * site there is none, and the answer is null rather than a broken promise —
 * there is no native dialog there either, so nothing asks.
 */
async function localFiles(path) {
  if (!await hasBackend()) return null;
  const response = await fetch('/api/local/list?root=' + encodeURIComponent(path));
  if (!response.ok) throw new Error(`listing ${path} -> ${response.status}`);
  return response.json();
}

/** One of those files, shaped like the File objects the readers expect.
 *
 * Lazy and ranged: a Rhythmia export is several gigabytes and the reader takes
 * slices out of it. Fetching the whole thing so it can read two megabytes puts
 * the file through memory twice for nothing.
 */
function localFile(root, entry) {
  const url = `/api/local/read?root=${encodeURIComponent(root)}`
            + `&path=${encodeURIComponent(entry.path)}`;
  const range = async (from, to) => {
    if (!await hasBackend()) throw new Error('no backend to read through');
    const headers = from == null ? {} : { Range: `bytes=${from}-${to - 1}` };
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`${entry.path} -> ${response.status}`);
    }
    return response.arrayBuffer();
  };
  return {
    name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
    webkitRelativePath: entry.path,
    size: entry.size,
    arrayBuffer: () => range(null, null),
    text: async () => new TextDecoder().decode(await range(null, null)),
    slice(from, to) {
      const start = Math.max(0, from | 0);
      const end = Math.min(entry.size, to == null ? entry.size : to | 0);
      return {
        size: Math.max(0, end - start),
        arrayBuffer: () => range(start, end),
        text: async () => new TextDecoder().decode(await range(start, end)),
      };
    },
  };
}

/** Ein EnSite-Velocity-Studienarchiv, gelesen und als PLY zurück.
 *
 * Velocity packt die Studie in ein geteiltes gzip-tar und legt darin eine
 * Punktwolke ab. Ein Browser kann beides nicht: das Archiv nicht auspacken und
 * die Oberfläche nicht rekonstruieren — der Leser dafür steht in Python. Ohne
 * Backend gibt es hier deshalb nichts zu holen, und `null` sagt genau das: auf
 * der öffentlichen Seite bleibt es bei „das kann nur die Anwendung".
 */
async function velocityMesh(path) {
  if (!await hasBackend()) return null;
  const response = await fetch('/api/velocity/mesh?path=' + encodeURIComponent(path));
  if (!response.ok) {
    let detail = 'HTTP ' + response.status;
    try { detail = (await response.json()).detail || detail; } catch { /* kein JSON */ }
    throw new Error(detail);
  }
  return response.arrayBuffer();
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
/** Panes whose page has actually announced itself. */
const announced = new Set();

/* A frame that exists is not a frame that can listen.
 *
 * `contentWindow` is there the moment the iframe element is — pointing at
 * about:blank, because the module has not loaded yet. Posting to it succeeded,
 * so nothing was queued, and the message went to a document that would be
 * replaced a moment later. Opening a study from the start tab therefore did
 * nothing the first time and worked the second, when the frame was already
 * there: the difference the user sees, and no error anywhere.
 *
 * The claim a module sends on registering is the only honest sign that
 * somebody is home. Until it arrives, the action waits in the queue. */
function deliver(pane, action, payload) {
  const frame = window.epcoreFrames?.[pane];
  if (!frame?.contentWindow || !announced.has(pane)) return false;
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
  /** Inside the tab shell, or standing alone on the public site.
   *
   * The modules carry their own way in — an Open button, a drop zone with
   * buttons under it — because on epcore.app there is nothing else. Inside the
   * shell there is one Open in the bar for both modules, and a second one in
   * each view is a second answer to a question already answered. */
  inShell: () => shell() !== null,
  locate,
  velocityMesh,
  localFiles,
  localFile,
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
    announced.add(pane);
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
