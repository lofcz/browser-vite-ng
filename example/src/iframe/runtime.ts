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

import {
  registerModule,
  shiftMappings,
  withInlineSourceMap,
  installStackTraceInterceptor,
  mapPosition,
  remapStackString,
  firstMappedFrame,
  codeFrame,
  type CodeEdit,
  type RawSourceMap,
} from './sourcemap';

interface HotUpdate {
  type: 'js-update' | 'css-update';
  timestamp: number;
  path: string;
  acceptedPath: string;
}
interface ErrorDetail {
  message: string
  stack?: string
  frame?: string
  plugin?: string
  loc?: { file?: string; line: number; column: number }
  id?: string
}

type Payload =
  | { type: 'connected' }
  | { type: 'ping' }
  | { type: 'update'; updates: HotUpdate[] }
  | { type: 'full-reload'; path?: string }
  | { type: 'prune'; paths: string[] }
  | { type: 'error'; err: ErrorDetail }
  | { type: 'custom'; event: string; data?: unknown };

/** A rejected module fetch carries the server's error payload on the Error. */
interface ServerFailure extends Error {
  detail?: ErrorDetail;
}

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

// Must run before ANY module is imported: from here on every `error.stack` in
// the preview is rendered at original source positions.
installStackTraceInterceptor();

/**
 * Render a server-side (transform / load) failure. The position and code frame
 * come from the server, which had the ORIGINAL source in hand — there is no
 * stack to map here, and the module never existed in the iframe.
 */
function showServerError(title: string, err: ErrorDetail): void {
  // `loc.column` is 0-based (Rollup/Vite convention); display it 1-based so it
  // matches what the editor's status bar shows.
  const loc = err.loc
    ? `${err.loc.file || err.id || ''}:${err.loc.line}:${err.loc.column + 1}`
    : err.id;
  hmrLog(`${title}: ${err.message}${loc ? ` (${loc})` : ''}`);
  showErrorOverlay(title, err.message, err.frame ? undefined : err.stack, {
    frame: err.frame,
    plugin: err.plugin,
    loc,
  });
}

/** Report a runtime error to the host with a source-mapped stack + code frame. */
function reportRuntimeError(kind: string, err: unknown, fallbackLocation?: string): void {
  const failure = err as ServerFailure;
  if (failure?.detail) {
    // A failed transform is a build error, not a runtime one, no matter which
    // phase happened to request the module.
    showServerError(failure.detail.plugin ? 'Transform Error' : kind, failure.detail);
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  // Reading `.stack` runs the interceptor; blob positions that slip through
  // (or non-V8 engines) are caught by the string remapper.
  const stack = remapStackString(error.stack);
  const frame = firstMappedFrame(error.stack);
  const loc = frame
    ? `${frame.source}:${frame.line}:${frame.column}`
    : fallbackLocation;
  showErrorOverlay(kind, error.message, stack, {
    loc,
    frame: frame ? codeFrame(frame.source, frame.line, frame.column) : undefined,
  });
  post('runtime-error', {
    kind,
    message: error.message,
    stack,
    file: frame?.source,
    line: frame?.line,
    column: frame?.column,
  });
}

// Uncaught errors and rejections previously died in the iframe console. Surface
// them like Vite's overlay does, at real file positions.
window.addEventListener(
  'error',
  (e: ErrorEvent) => {
    // A module parse error has no stack — the event's own position is the only
    // location, and it points into the blob, so map it explicitly.
    const mapped = e.filename ? mapPosition(e.filename, e.lineno, e.colno) : null;
    const location = mapped
      ? `${mapped.source}:${mapped.line}:${mapped.column}`
      : e.filename
        ? `${e.filename}:${e.lineno}:${e.colno}`
        : undefined;

    if (e.error instanceof SyntaxError || /SyntaxError/.test(e.message)) {
      hmrLog(`SYNTAX ${e.message} @ ${location ?? '?'}`);
      showErrorOverlay('Syntax Error', e.message, undefined, {
        loc: location,
        frame: mapped ? codeFrame(mapped.source, mapped.line, mapped.column) : undefined,
      });
      return;
    }
    if (e.error) reportRuntimeError('Runtime Error', e.error, location);
  },
  true,
);

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  reportRuntimeError('Unhandled Rejection', e.reason);
});

// /@vite/client + /@react-refresh module URLs, provided by the host.
const CLIENT_MOD_URL = (window as unknown as { __VITE_CLIENT_URL: string }).__VITE_CLIENT_URL;
const REACT_REFRESH_URL = (window as unknown as { __REACT_REFRESH_URL: string }).__REACT_REFRESH_URL;

// These two are blob-ified by the bootstrap before this module runs, so they
// never pass through `serveModule`. Name them so their frames are readable.
registerModule(CLIENT_MOD_URL, '/@vite/client', null);
registerModule(REACT_REFRESH_URL, '/@react-refresh', null);

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

/**
 * Rewrite every import specifier to a directly-importable blob URL, reporting
 * the edits so the module's sourcemap can be re-based (blob URLs are much longer
 * than the specifiers they replace, which moves every column after them).
 */
async function linkModule(
  code: string,
  forPath = '',
): Promise<{ code: string; edits: CodeEdit[] }> {
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
  const edits: CodeEdit[] = [];
  for (let i = imports.length - 1; i >= 0; i--) {
    const imp = imports[i];
    if (imp.n === undefined) continue;
    const resolved = cache.get(imp.n);
    if (!resolved) continue;
    const sPos = imp.d > -1 ? imp.s : imp.s - 1;
    const ePos = imp.d > -1 ? imp.e : imp.e + 1;
    const replacement = JSON.stringify(resolved);
    // Offsets are against the pre-edit code (the loop runs backwards), which is
    // the coordinate space `shiftMappings` works in.
    edits.push({ start: sPos, removed: ePos - sPos, inserted: replacement.length });
    out = out.slice(0, sPos) + replacement + out.slice(ePos);
  }
  return { code: out, edits };
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

interface ServedModule {
  code: string;
  map: RawSourceMap | null;
}

function fetchModuleCode(path: string): Promise<ServedModule> {
  return new Promise((resolve, reject) => {
    const id = 'serve-' + Math.random().toString(36).slice(2);
    function onMsg(event: MessageEvent): void {
      if (event.data && event.data.type === 'hmr-module' && event.data.id === id) {
        window.removeEventListener('message', onMsg);
        if (event.data.error) {
          // Carry the server's loc/frame through the rejection so the overlay
          // can show the transform's real position, not this listener's frame.
          const failure: ServerFailure = new Error(event.data.error);
          failure.detail = event.data.errorDetail;
          reject(failure);
        } else {
          resolve({ code: event.data.code, map: event.data.map ?? null });
        }
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
  const linked = await linkModule(raw.code, clean);
  // Re-base the map onto the linked code, then inline it so the iframe's own
  // DevTools resolves original sources (there is no origin that could serve a
  // separate .map for a VFS file).
  const map = raw.map ? shiftMappings(raw.map, raw.code, linked.edits) : null;
  const code = withInlineSourceMap(linked.code, map);
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  // Register even when there is no map: frames then read `/@deps/react.js`
  // rather than an opaque blob id.
  registerModule(blobUrl, clean, map);
  moduleBlobByPath.set(clean, blobUrl);
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The module the page boots from (declared by /index.html), and whether it has
// actually executed. A hot update that applies cleanly does NOT mean the app is
// healthy while its entry never ran — the update swaps a module in a graph no
// live app was built from — so it must not clear the error that is still true.
let entryPath: string | null = null;
let entryBooted = false;

// Markup currently rendered in the overlay. A single broken file can produce
// several identical `error` payloads (the server broadcasts one per failed
// transform, and the import that follows rejects with the same message);
// re-writing the same markup would repaint the overlay and make it flicker.
let overlayHtml = '';

// Quiet window for painting the overlay. A structural burst (delete folder,
// missing entry + cascading import failures) produces many distinct errors in
// rapid succession; showing each one looks like flashing. Keep the latest and
// paint once the channel settles — same SETTLE_MS as the host transport.
const OVERLAY_SETTLE_MS = 120;
type OverlayPaint = {
  title: string;
  message: string;
  stack?: string;
  extra?: { frame?: string; plugin?: string; loc?: string };
};
let pendingOverlay: OverlayPaint | null = null;
let overlayTimer: ReturnType<typeof setTimeout> | null = null;

function paintErrorOverlay(paint: OverlayPaint): void {
  let overlay = document.getElementById('hmr-error-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'hmr-error-overlay';
    overlay.className = 'hmr-error';
    document.body.appendChild(overlay);
  }
  // Escape HTML — JSX/parse errors routinely contain `<`/`>` and would otherwise
  // break the overlay markup (empty / half-rendered "error state").
  const meta = [
    paint.extra?.plugin ? `[plugin: ${paint.extra.plugin}]` : '',
    paint.extra?.loc ? paint.extra.loc : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Any stack reaching the overlay goes through the remapper — host-side
  // payloads arrive as plain strings that never hit `prepareStackTrace`.
  const body = [meta, paint.message, paint.extra?.frame, remapStackString(paint.stack)]
    .filter(Boolean)
    .join('\n');
  const html = '<h2>' + escapeHtml(paint.title) + '</h2><pre>' + escapeHtml(body) + '</pre>';
  if (html !== overlayHtml) {
    overlay.innerHTML = html;
    overlayHtml = html;
  }
  overlay.style.display = 'block';
  // Lock background scroll while the overlay is up (the overlay itself still
  // scrolls its own content via overflow:auto).
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
}

// Error overlay lives in a SEPARATE container so it never clobbers #root —
// otherwise React's root (created against #root's original children) loses
// its container content and a later successful update cannot recover.
function showErrorOverlay(
  title: string,
  message: string,
  stack?: string,
  extra?: { frame?: string; plugin?: string; loc?: string },
): void {
  pendingOverlay = { title, message, stack, extra };
  if (overlayTimer !== null) clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => {
    overlayTimer = null;
    const paint = pendingOverlay;
    pendingOverlay = null;
    if (paint) paintErrorOverlay(paint);
  }, OVERLAY_SETTLE_MS);
}

function clearErrorOverlay(): void {
  if (overlayTimer !== null) {
    clearTimeout(overlayTimer);
    overlayTimer = null;
  }
  pendingOverlay = null;
  const overlay = document.getElementById('hmr-error-overlay');
  if (overlay) overlay.style.display = 'none';
  overlayHtml = '';
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
}

type UpdateFailure = {
  err: unknown
  path: string
  /** Server already broadcast an `error` HotPayload for this — don't paint twice. */
  serverReported: boolean
};

/**
 * Apply one js-update. Returns a failure instead of painting so a coalesced
 * batch can settle on a single overlay message.
 */
async function applyJsUpdate(update: HotUpdate): Promise<UpdateFailure | null> {
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
    hmrLog('hot updated: ' + acceptedPath + (path !== acceptedPath ? ' via ' + path : ''));
    return null;
  } catch (err) {
    // A js-update that fails to import/execute must not vanish silently — and
    // must NOT clear an existing overlay. The caller paints once after the
    // whole coalesced batch so intermediate failures don't flash.
    const e = err as Error;
    hmrLog('HMR update failed: ' + e.message);
    // transformRequest already pushed an `error` HotPayload for load/transform
    // misses ("Failed to load url…"). Painting from the import rejection too
    // would show the same failure twice, a fetch-round-trip apart.
    const serverReported = /Failed to load url|Does the file exist\?/.test(e.message);
    return { err, path: acceptedPath, serverReported };
  }
}

async function handlePayload(payload: Payload): Promise<void> {
  switch (payload.type) {
    case 'connected':
      hmrLog('Vite HMR connected');
      break;
    case 'update': {
      hmrLog('Received update with ' + payload.updates.length + ' change(s)');
      let lastFailure: UpdateFailure | null = null;
      let awaitingServerError = false;
      let anySuccess = false;
      for (const update of payload.updates) {
        if (update.type === 'css-update') {
          post('hmr-fetch-module', {
            id: 'css-' + update.timestamp,
            path: update.acceptedPath,
            boundary: update.path,
            css: true,
          });
          hmrLog('css-update ' + update.path);
          anySuccess = true;
        } else {
          const failure = await applyJsUpdate(update);
          if (failure) {
            if (failure.serverReported) awaitingServerError = true;
            else lastFailure = failure;
          } else {
            anySuccess = true;
          }
        }
      }
      // One overlay for the whole coalesced batch. Load/transform misses are
      // owned by the server's `error` payload (already in flight); only paint
      // execution errors here. Don't clear when we're waiting on that payload.
      if (lastFailure) reportRuntimeError('HMR Error', lastFailure.err, lastFailure.path);
      else if (anySuccess && entryBooted && !awaitingServerError) clearErrorOverlay();
      break;
    }
    case 'full-reload':
      hmrLog('full-reload' + (payload.path ? ' path=' + payload.path : ''));
      post('hmr-full-reload-ack', { path: payload.path });
      // The iframe document is a blob URL frozen at creation time — a plain
      // location.reload() would re-serve the STALE html. Ask the host to rebuild
      // the document from the latest VFS index.html (the analogue of the dev
      // server re-serving the page on reload).
      post('hmr-request-reload');
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
    case 'error': {
      const { err } = payload;
      // The entry failing to load invalidates the running app, even though this
      // document was never reloaded (the host skips reloads it knows will fail).
      if (err.id && err.id === entryPath) entryBooted = false;
      showServerError('HMR Error', err);
      break;
    }
    default:
      break;
  }
}

// Serialize HotPayload handling: the host may postMessage several payloads
// back-to-back, and an un-awaited async handler would let them race — e.g. an
// `error` painting while an earlier `update` is still fetching modules.
let payloadChain: Promise<void> = Promise.resolve();
function enqueuePayload(payload: Payload): void {
  payloadChain = payloadChain.then(() => handlePayload(payload)).catch((err) => {
    hmrLog('payload handler failed: ' + (err instanceof Error ? err.message : String(err)));
  });
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
    enqueuePayload(event.data.payload);
  }
  if (event.data && event.data.type === 'hmr-update') {
    updateCount++;
    hmrLog('Received bootstrap entry #' + updateCount);
    try {
      await installRefreshPreamble();
      // The entry (e.g. /src/main.tsx, declared by /index.html) is
      // self-executing: it imports react-dom/client and calls
      // createRoot().render() itself — exactly like a real Vite scaffold. The
      // runtime no longer renders the entry's default export.
      const entry: string = event.data.entry || '/src/main.tsx';
      entryPath = entry;
      await import(await serveModule(entry));
      entryBooted = true;
      clearErrorOverlay();
      hmrLog('Bootstrap render complete');
    } catch (err) {
      entryBooted = false;
      // Previously this dumped every served blob's full text into the host log
      // as a last-resort debugging aid. A source-mapped stack points at the
      // actual line instead, so the dump is pure noise now.
      const e = err as Error;
      hmrLog('Bootstrap failed: ' + e.message);
      reportRuntimeError('Bootstrap Error', e);
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
