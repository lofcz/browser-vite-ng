/**
 * Preview-iframe HMR runtime.
 *
 * Runs inside the sandboxed preview iframe as a `<script type="module">`.
 * Speaks the same HotPayload protocol as Vite 8's client (`update` /
 * `full-reload` / `prune` / `error`), but transports over postMessage instead
 * of a WebSocket and serves transformed modules as blob-URL ESM.
 *
 * Written as a real module (no giant template string) so escaping is explicit
 * and syntax errors surface at build time, not inside the iframe.
 */

declare const chobitsu: { setOnMessage(cb: (m: string) => void): void; sendRawMessage(m: string): void } | undefined;

interface ReactLike {
  createElement(...args: unknown[]): unknown;
}
interface ReactDomLike {
  createRoot(el: Element | null): { render(node: unknown): void };
}

// React / ReactDOM come from the SAME optimized-dep blob URLs the transformed
// component modules import (the deps optimizer code-splits so all entries
// share ONE React instance). Loaded lazily via the normal serve path.
let reactPromise: Promise<ReactLike> | null = null;
let reactDomPromise: Promise<ReactDomLike> | null = null;
async function loadReact(): Promise<ReactLike> {
  if (!reactPromise)
    reactPromise = import(/* @vite-ignore */ await serveModule('/@deps/react.js')) as Promise<ReactLike>;
  return reactPromise;
}
async function loadReactDom(): Promise<ReactDomLike> {
  if (!reactDomPromise)
    reactDomPromise = import(
      /* @vite-ignore */ await serveModule('/@deps/react-dom__client.js')
    ) as Promise<ReactDomLike>;
  return reactDomPromise;
}

interface HotUpdate {
  type: 'js-update' | 'css-update';
  timestamp: number;
  path: string;
  acceptedPath: string;
}
type Payload =
  | { type: 'connected' }
  | { type: 'ping' }
  | { type: 'update'; updates: HotUpdate[] }
  | { type: 'full-reload'; path?: string }
  | { type: 'prune'; paths: string[] }
  | { type: 'error'; err: { message: string; stack?: string } }
  | { type: 'custom'; event: string; data?: unknown };

type Lexer = {
  init: Promise<unknown>;
  parse(code: string): [Array<{ n?: string; s: number; e: number; d: number }>, unknown[]];
};

function post(type: string, extra: Record<string, unknown> = {}): void {
  window.parent.postMessage({ type, ...extra }, '*');
}
function hmrLog(msg: string): void {
  post('hmr-log', { message: msg });
}

// Surface exact SyntaxError location (source + line:col) to the host.
window.addEventListener(
  'error',
  (e: ErrorEvent) => {
    if (e.error instanceof SyntaxError || /SyntaxError/.test(e.message)) {
      hmrLog(`SYNTAX ${e.message} @ ${e.filename || '?'}:${e.lineno}:${e.colno}`);
    }
  },
  true,
);

// /@vite/client + /@react-refresh module URLs, provided by the host.
const CLIENT_MOD_URL = (window as unknown as { __VITE_CLIENT_URL: string }).__VITE_CLIENT_URL;
const REACT_REFRESH_URL = (window as unknown as { __REACT_REFRESH_URL: string }).__REACT_REFRESH_URL;

/**
 * Resolve a specifier to a directly-importable URL, or null to fall through
 * to the normal host serve path (`fetchModuleCode` → VFS / browser-vite).
 * Optimized deps (`/@deps/*`) intentionally return null so they are served
 * from the VFS-backed optimizer output like any other module.
 */
function resolveSpecifier(url: string): string | null {
  if (/^https?:/.test(url)) return url;
  if (url === '/@vite/client') return CLIENT_MOD_URL;
  if (url === '/@react-refresh') return REACT_REFRESH_URL;
  return null;
}

const hotModulesMap = new Map<string, { id: string; callbacks: Array<{ deps: string[]; fn: (m: unknown[]) => void }> }>();
const disposeMap = new Map<string, (data: unknown) => void | Promise<void>>();
const pruneMap = new Map<string, (data: unknown) => void | Promise<void>>();
const dataMap = new Map<string, unknown>();
const blobUrls = new Map<string, string>();

let reactRoot: { render(node: unknown): void } | null = null;
let updateCount = 0;

let lexerPromise: Promise<Lexer> | null = null;
function lexer(): Promise<Lexer> {
  if (!lexerPromise) {
    lexerPromise = import(/* @vite-ignore */ (window as unknown as { __ES_MODULE_LEXER_URL: string }).__ES_MODULE_LEXER_URL).then(
      async (m) => {
        await (m as Lexer).init;
        return m as Lexer;
      },
    );
  }
  return lexerPromise;
}

async function linkModule(code: string, forPath = ''): Promise<string> {
  const { parse } = await lexer();
  let imports: Array<{ n?: string; s: number; e: number; d: number }>;
  try {
    [imports] = parse(code);
  } catch (err) {
    const e = err as Error & { idx?: number };
    const idx = e.idx ?? 0;
    hmrLog(
      `LEXER PARSE FAIL in ${forPath}: ${e.message} @idx=${idx} region=${JSON.stringify(
        code.slice(Math.max(0, idx - 60), idx + 60),
      )}`,
    );
    throw err;
  }
  const cache = new Map<string, string>();
  for (const imp of imports) {
    if (imp.n === undefined) continue;
    if (!/^https?:/.test(imp.n)) {
      // Resolve relative/absolute specifiers against the importing module so
      // e.g. "./chunk-x.js" inside /@deps/react.js -> /@deps/chunk-x.js.
      const resolved = resolveImportSpecifier(imp.n, forPath);
      if (!cache.has(imp.n)) cache.set(imp.n, await serveModule(resolved));
    }
  }
  let out = code;
  for (let i = imports.length - 1; i >= 0; i--) {
    const imp = imports[i];
    if (imp.n === undefined) continue;
    const resolved = cache.get(imp.n);
    if (!resolved) continue;
    const sPos = imp.d > -1 ? imp.s : imp.s - 1;
    const ePos = imp.d > -1 ? imp.e : imp.e + 1;
    out = out.slice(0, sPos) + JSON.stringify(resolved) + out.slice(ePos);
  }
  return out;
}

/** Resolve a (possibly relative) import specifier against its importer path. */
function resolveImportSpecifier(spec: string, importer: string): string {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const baseParts = importer.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') baseParts.pop();
      else baseParts.push(seg);
    }
    return baseParts.join('/');
  }
  return spec;
}

function fetchModuleCode(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = 'serve-' + Math.random().toString(36).slice(2);
    function onMsg(event: MessageEvent): void {
      if (event.data && event.data.type === 'hmr-module' && event.data.id === id) {
        window.removeEventListener('message', onMsg);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.code);
      }
    }
    window.addEventListener('message', onMsg);
    post('hmr-fetch-module', { id, path });
    setTimeout(() => {
      window.removeEventListener('message', onMsg);
      reject(new Error('fetch-module timeout: ' + path));
    }, 10000);
  });
}

const moduleBlobByPath = new Map<string, string>();

async function serveModule(url: string): Promise<string> {
  const clean = url.replace(/[?&]t=\d+/g, '').replace(/[?&]$/, '');
  const external = resolveSpecifier(clean);
  if (external) return external;
  const isUpdate = /[?&]t=\d+/.test(url);
  // Non-timestamped requests resolve to the module's single live blob URL so a
  // dependency always links to the same instance (mirrors Vite's stable
  // /src/foo.tsx URL). Timestamped (?t=) HMR requests force a fresh fetch+blob.
  if (!isUpdate) {
    const existing = moduleBlobByPath.get(clean);
    if (existing) return existing;
  }
  const raw = await fetchModuleCode(clean);
  const code = await linkModule(raw, clean);
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  moduleBlobByPath.set(clean, blobUrl);
  blobUrls.set(url, blobUrl);
  return blobUrl;
}

function createHotContext(ownerPath: string) {
  if (!dataMap.has(ownerPath)) dataMap.set(ownerPath, {});
  return {
    get data() {
      return dataMap.get(ownerPath);
    },
    accept(deps?: string[] | string | ((m: unknown[]) => void), cb?: (m: unknown[]) => void) {
      const mod = hotModulesMap.get(ownerPath) || { id: ownerPath, callbacks: [] };
      if (typeof deps === 'function' || deps === undefined) {
        mod.callbacks.push({ deps: [ownerPath], fn: (deps as (m: unknown[]) => void) || (() => {}) });
      } else if (typeof deps === 'string') {
        mod.callbacks.push({ deps: [deps], fn: cb || (() => {}) });
      } else if (Array.isArray(deps)) {
        mod.callbacks.push({ deps, fn: cb || (() => {}) });
      }
      hotModulesMap.set(ownerPath, mod);
    },
    acceptExports(_exports: unknown, cb?: (m: unknown[]) => void) {
      this.accept(cb);
    },
    dispose(cb: (data: unknown) => void) {
      disposeMap.set(ownerPath, cb);
    },
    prune(cb: (data: unknown) => void) {
      pruneMap.set(ownerPath, cb);
    },
    invalidate(message?: string) {
      hmrLog(`INVALIDATE ${ownerPath}: ${message ?? '(no message)'}`);
      post('vite-hmr-from-client', {
        payload: { type: 'custom', event: 'vite:invalidate', data: { path: ownerPath, message } },
      });
    },
    on() {},
    off() {},
    send(event: string, data?: unknown) {
      post('vite-hmr-from-client', { payload: { type: 'custom', event, data } });
    },
  };
}

(window as unknown as { __vite_createHotContext: typeof createHotContext }).__vite_createHotContext =
  createHotContext;

// Used by /@react-refresh's __hmr_import: resolve a servable module path to
// its live blob URL and import it (blob modules can't resolve /src/... natively).
(window as unknown as { __vite_hmr_import: (m: string) => Promise<unknown> }).__vite_hmr_import =
  async (m: string) => import(await serveModule(m));
(window as unknown as { __vite_refresh_log: (m: string) => void }).__vite_refresh_log = hmrLog;

// React Fast Refresh preamble — faithful analogue of @vitejs/plugin-react's
// getPreambleCode: install the devtools global hook + registration globals
// BEFORE any component module runs so Oxc's $RefreshReg$/$RefreshSig$ calls
// register into the real react-refresh runtime (state-preserving updates).
interface ReactRefreshRuntime {
  injectIntoGlobalHook(globalObject: Window): void;
}
let refreshPreambleInstalled = false;
async function installRefreshPreamble(): Promise<void> {
  if (refreshPreambleInstalled) return;
  const RefreshRuntime = (await import(/* @vite-ignore */ REACT_REFRESH_URL)) as ReactRefreshRuntime;
  RefreshRuntime.injectIntoGlobalHook(window);
  (window as unknown as { $RefreshReg$: unknown }).$RefreshReg$ = () => {};
  (window as unknown as { $RefreshSig$: unknown }).$RefreshSig$ = () => (type: unknown) => type;
  refreshPreambleInstalled = true;
  const hook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers?: Map<number, unknown>; inject?: unknown } })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  hmrLog(
    `[refresh] preamble installed; devtools hook=${hook ? 'present' : 'MISSING'} renderers=${
      hook?.renderers ? hook.renderers.size : 'n/a'
    }`,
  );
}

// Error overlay lives in a SEPARATE container so it never clobbers #root —
// otherwise React's root (created against #root's original children) loses
// its container content and a later successful update cannot recover.
function showErrorOverlay(title: string, message: string, stack?: string): void {
  let overlay = document.getElementById('hmr-error-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'hmr-error-overlay';
    overlay.className = 'hmr-error';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML =
    '<h2>' + title + '</h2><pre>' + message + (stack ? '\n' + stack : '') + '</pre>';
  overlay.style.display = 'block';
  // Lock background scroll while the overlay is up (the overlay itself still
  // scrolls its own content via overflow:auto).
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
}

function clearErrorOverlay(): void {
  const overlay = document.getElementById('hmr-error-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
}

async function renderApp(AppComponent: unknown): Promise<void> {
  try {
    const [React, ReactDOM] = await Promise.all([loadReact(), loadReactDom()]);
    if (!reactRoot) {
      reactRoot = ReactDOM.createRoot(document.getElementById('root'));
      hmrLog('Created new React root');
    }
    reactRoot.render(React.createElement(AppComponent as never));
    clearErrorOverlay();
    hmrLog('Rendered component (update #' + updateCount + ')');
  } catch (err) {
    const e = err as Error;
    hmrLog('Render error: ' + e.message);
    showErrorOverlay('Render Error', e.message, e.stack);
  }
}

async function applyJsUpdate(update: HotUpdate): Promise<void> {
  const { path, acceptedPath, timestamp } = update;
  hmrLog(`js-update path=${path} acceptedPath=${acceptedPath} t=${timestamp}`);
  const mod = hotModulesMap.get(path);
  const isSelfUpdate = path === acceptedPath;
  const qualified = mod ? mod.callbacks.filter(({ deps }) => deps.includes(acceptedPath)) : [];

  let fetchedModule: { default?: unknown } | undefined;
  try {
    if (isSelfUpdate || qualified.length > 0) {
      const disposer = disposeMap.get(acceptedPath);
      if (disposer) await disposer(dataMap.get(acceptedPath));
      fetchedModule = await import(await serveModule(acceptedPath + '?t=' + timestamp));
    }

    updateCount++;
    for (const { deps, fn } of qualified) {
      // Vite client semantics: a single-dep accept callback receives the module
      // namespace object directly (nextExports), not an array — Fast Refresh's
      // wrapper relies on this (accept((nextExports) => ...)).
      if (deps.length === 1) {
        fn((deps[0] === acceptedPath ? fetchedModule : undefined) as never);
      } else {
        fn(deps.map((d) => (d === acceptedPath ? fetchedModule : undefined)));
      }
    }
    // The update applied cleanly — any prior error state is now stale.
    clearErrorOverlay();
    hmrLog('hot updated: ' + acceptedPath + (path !== acceptedPath ? ' via ' + path : ''));
  } catch (err) {
    // A js-update that fails to import/execute (e.g. the new module still has
    // a syntax/runtime error) must surface as an overlay, not vanish silently
    // — and must NOT clear an existing overlay.
    const e = err as Error;
    hmrLog('HMR update failed: ' + e.message);
    showErrorOverlay('HMR Error', e.message, e.stack);
  }
}

async function handlePayload(payload: Payload): Promise<void> {
  switch (payload.type) {
    case 'connected':
      hmrLog('Vite HMR connected');
      break;
    case 'update':
      hmrLog('Received update with ' + payload.updates.length + ' change(s)');
      for (const update of payload.updates) {
        if (update.type === 'css-update') {
          post('hmr-fetch-module', {
            id: 'css-' + update.timestamp,
            path: update.acceptedPath,
            boundary: update.path,
            css: true,
          });
          hmrLog('css-update ' + update.path);
        } else {
          await applyJsUpdate(update);
        }
      }
      break;
    case 'full-reload':
      hmrLog('full-reload' + (payload.path ? ' path=' + payload.path : ''));
      post('hmr-full-reload-ack', { path: payload.path });
      location.reload();
      break;
    case 'prune':
      hmrLog('prune ' + (payload.paths || []).join(', '));
      for (const p of payload.paths || []) {
        const fn = pruneMap.get(p);
        if (fn) await fn(dataMap.get(p));
        const disp = disposeMap.get(p);
        if (disp) await disp(dataMap.get(p));
      }
      break;
    case 'error':
      hmrLog('HMR Error: ' + payload.err.message);
      showErrorOverlay('HMR Error', payload.err.message, payload.err.stack);
      break;
    default:
      break;
  }
}

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.data && event.data.type === 'hmr-module' && event.data.css) {
    let style = document.getElementById('hmr-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hmr-styles';
      document.head.appendChild(style);
    }
    style.textContent = event.data.code;
    hmrLog('CSS injected without reload');
  }
  if (event.data && event.data.type === 'vite-hmr' && event.data.payload) {
    handlePayload(event.data.payload);
  }
  if (event.data && event.data.type === 'hmr-update') {
    updateCount++;
    hmrLog('Received bootstrap entry #' + updateCount);
    try {
      await installRefreshPreamble();
      const entry = event.data.entry || '/src/App.tsx';
      const mod = await import(await serveModule(entry));
      if (mod && mod.default) renderApp(mod.default);
      clearErrorOverlay();
      hmrLog('Bootstrap render complete');
    } catch (err) {
      const e = err as Error;
      let dump = '';
      for (const [u, b] of blobUrls) {
        try {
          const t = await (await fetch(b)).text();
          dump += '\n=== ' + u + ' ===\n' + t;
        } catch {
          /* ignore */
        }
      }
      hmrLog('HMR Error: ' + e.message + dump);
      showErrorOverlay('HMR Error', e.message, e.stack);
    }
  }
  if (event.data && event.data.type === 'cdp-command' && typeof chobitsu !== 'undefined') {
    (chobitsu as { sendRawMessage(m: string): void }).sendRawMessage(event.data.message);
  }
});

post('hmr-ready');
hmrLog('HMR Runtime initialized');
setTimeout(() => {
  if (typeof chobitsu !== 'undefined') {
    (chobitsu as { setOnMessage(cb: (m: string) => void): void }).setOnMessage((message: string) => {
      post('cdp-response', { message });
    });
    hmrLog('Chobitsu CDP initialized');
    post('cdp-ready');
  } else {
    hmrLog('Chobitsu not loaded, skipping CDP initialization');
  }
}, 100);
