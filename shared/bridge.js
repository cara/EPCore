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
  // One choice for the whole program (shared/theme.js), so no module owns it.
  // Routed to the signal view, it switched the user off the map to get there.
  toggleTheme: null,
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

/** Runs `use(api)` once, as soon as the host offers the function `name`.
 *
 * Looking once while the module evaluates finds nothing in the real window:
 * pywebview injects after the page has loaded, from a thread — first an empty
 * `api`, then the functions, then `pywebviewready` on the top frame. Only a
 * test that installs its stand-in before load sees a host that early. A module
 * frame listens on the parent, because nothing is ever injected into it.
 *
 * In a browser the event never comes, and `use` is never called.
 */
function whenHost(name, use) {
  let done = false;
  const attempt = () => {
    const native = api();
    if (done || !native || typeof native[name] !== 'function') return;
    done = true;
    use(native);
  };
  attempt();
  if (done) return;
  for (const target of new Set([window, window.parent])) {
    try { target.addEventListener('pywebviewready', attempt); }
    catch { /* cross-origin parent: not our host */ }
  }
}

/* Was schiefgeht, in das Protokoll der Anwendung.
 *
 * Eine WebView hat keine Konsole, in die jemand schauen könnte. Zwei Fehler
 * dieser Sitzung waren genau deshalb unsichtbar: eine Menü-Aktion, die in einem
 * Ereignis-Zuhörer `openPath is not defined` warf, und ein Schnitt, der auf
 * einem Rechner die Karte leerte und sonst nirgends. Beide wären eine Zeile im
 * Protokoll gewesen.
 *
 * Nur im Fenster, nicht im Browser: dort gibt es eine Konsole, und ein zweiter
 * Weg dorthin wäre Lärm. Eingehängt, sobald der Wirt da ist: pywebview kommt
 * erst nach dem Laden, und ein Haken, der nur beim Auswerten nachsah, fehlte
 * im Fenster deshalb immer — in der Schale und in jedem Modul, das mit ihr
 * zusammen geladen wurde. */
whenHost('report', (native) => {
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
});

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
    // Nothing to read. Asked anyway, `bytes=100-99` comes back as one byte:
    // the backend clamps a range it cannot serve instead of refusing it.
    if (from != null && to <= from) return new ArrayBuffer(0);
    if (!await hasBackend()) throw new Error('no backend to read through');
    const headers = from == null ? {} : { Range: `bytes=${from}-${to - 1}` };
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`${entry.path} -> ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    // The reader copies what arrives into a block of the length it asked for
    // and moves on by that length, so a short or misplaced answer becomes
    // zeros or someone else's bytes in the map. Refused here, it is a message.
    if (from != null && buffer.byteLength !== to - from) {
      throw new Error(`${entry.path}: ${to - from} Bytes ab Byte ${from} angefordert, `
                    + `${buffer.byteLength} erhalten.`);
    }
    return buffer;
  };
  /* Plain arithmetic, not `| 0`: that folds an offset into int32, so a part
   * file past 2 GiB was read from a negative or wrapped offset — the start of
   * the file, or one byte — and nothing said so. */
  const offset = (x) => Math.min(entry.size, Math.max(0, Math.trunc(Number(x)) || 0));
  return {
    name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
    webkitRelativePath: entry.path,
    size: entry.size,
    arrayBuffer: () => range(null, null),
    text: async () => new TextDecoder().decode(await range(null, null)),
    slice(from, to) {
      const start = offset(from);
      const end = Math.max(start, to == null ? entry.size : offset(to));
      return {
        size: end - start,
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
 *
 * Resolves to `{ buffer, mapName, mapNames }`. An archive can hold several
 * maps (sinus and paced, left and right atrium); `map` asks for one by name,
 * and without it the server shows the first by name. Which one that was, and
 * which others exist, come in two headers. Returning only the buffer dropped
 * both, so the view showed one map and said nothing of the rest.
 */
async function velocityMesh(path, map) {
  if (!await hasBackend()) return null;
  let url = '/api/velocity/mesh?path=' + encodeURIComponent(path);
  if (map) url += '&map=' + encodeURIComponent(map);
  const response = await fetch(url);
  if (!response.ok) {
    let detail = 'HTTP ' + response.status;
    try { detail = (await response.json()).detail || detail; } catch { /* kein JSON */ }
    throw new Error(detail);
  }
  const mapNames = (response.headers.get('X-EPCore-Map-Names') || '')
    .split(',').filter(Boolean).map(headerText);
  return {
    buffer: await response.arrayBuffer(),
    mapName: headerText(response.headers.get('X-EPCore-Map-Name') || '') || null,
    mapNames,
  };
}

/** A header value the server percent-encoded: header values are Latin-1, and
 * a map name is a folder name from the archive with no such limit. One that
 * does not decode is shown as it came rather than failing the whole study. */
function headerText(value) {
  try { return decodeURIComponent(value); } catch { return value; }
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

/** What a page says about an action that reached it and has no handler here. */
const cannotRun = (action) => (ready
  ? `Diese Ansicht kann „${action}" nicht ausführen.`
  : `„${action}" kam an, bevor die Seite bereit war.`);

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
  whenHost,

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

/** Switch the theme where the call lands; theme.js passes it to the other panes. */
function toggleTheme() {
  // Looked up, not imported: the page loads theme.js itself, and a page that
  // does not should say so rather than leave the menu entry doing nothing.
  if (window.epcoreTheme) return window.epcoreTheme.toggle();
  report('Das Thema lässt sich auf dieser Seite nicht wechseln.');
  return undefined;
}

/** Called by the native menu, by an in-page menu, and by the shell's tiles. */
function epcoreMenu(action, payload) {
  if (action === 'goHome') return epcore.go('/');
  if (action === 'goSignals') return epcore.go('/eptrace');
  if (action === 'goMaps') return epcore.go('/epview/');
  if (action === 'toggleTheme') return toggleTheme();

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
  report(cannotRun(action));
  return undefined;
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || !event.data) return;

  if (event.data.type === MESSAGE) {
    /* The shell sends here once this page has claimed anything at all — an
     * empty claim included, which is what a module sends when its main script
     * died before defining its actions (the map view without WebGL). Dropped
     * without a word, every menu entry aimed here did nothing. */
    const handler = handlers[event.data.action];
    if (handler) handler(event.data.payload);
    else report(cannotRun(event.data.action));
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
