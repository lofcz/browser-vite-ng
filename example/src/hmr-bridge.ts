/**
 * Transport bridge for Vite HotPayloads between the example host and preview.
 *
 * Does NOT reimplement HMR propagation — that must come from browser-vite /
 * Vite 8 `handleHMRUpdate` + `updateModules` (full fidelity).
 */

export type HotPayload =
  | { type: 'connected' }
  | { type: 'ping' }
  | {
      type: 'update'
      updates: Array<{
        type: 'js-update' | 'css-update'
        timestamp: number
        path: string
        acceptedPath: string
        explicitImportRequired?: boolean
        isWithinCircularImport?: boolean
        firstInvalidatedBy?: string
      }>
    }
  | { type: 'full-reload'; path?: string; triggeredBy?: string }
  | { type: 'prune'; paths: string[] }
  | {
      type: 'error'
      err: {
        message: string
        stack: string
        id?: string
        frame?: string
        plugin?: string
        loc?: { file?: string; line: number; column: number }
      }
    }
  | { type: 'custom'; event: string; data?: unknown }

export interface ErrorPayload {
  message: string
  stack: string
  id?: string
  frame?: string
  plugin?: string
  loc?: { file?: string; line: number; column: number }
}

/**
 * Serialize a thrown error for transport to the preview — the analogue of
 * Vite's `prepareError` in `server/ws.ts`.
 *
 * Duck-typed rather than keyed off a specific error class so any plugin error
 * carrying Rollup's `loc` / `frame` convention keeps its position through
 * postMessage (structured clone drops the prototype and non-enumerable
 * `message`/`stack`, so every field has to be copied explicitly).
 */
export function prepareError(err: unknown, fallbackId?: string): ErrorPayload {
  const e = (err ?? {}) as {
    message?: string
    stack?: string
    id?: string
    frame?: string
    plugin?: string
    loc?: { file?: string; line: number; column: number }
  }
  return {
    message: e.message ?? String(err),
    stack: e.stack ?? '',
    id: e.id ?? fallbackId,
    frame: e.frame,
    plugin: e.plugin,
    loc: e.loc,
  }
}

/**
 * Quiet window for coalescing payload bursts. Structural ops (delete a folder,
 * rename the entry) emit one HotPayload per file; without this the preview
 * would flash through every intermediate error / rebuild. Sized to cover a
 * couple of host↔iframe fetchModule round-trips so a cascade settles as one.
 */
const SETTLE_MS = 120

type UpdatePayload = Extract<HotPayload, { type: 'update' }>
type ErrorPayloadMsg = Extract<HotPayload, { type: 'error' }>
type ReloadPayload = Extract<HotPayload, { type: 'full-reload' }>

let settleIframe: HTMLIFrameElement | null = null
let pendingUpdates: UpdatePayload['updates'] = []
let pendingError: ErrorPayloadMsg | null = null
let pendingReload: ReloadPayload | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null

function deliver(iframe: HTMLIFrameElement | null, payload: HotPayload): void {
  iframe?.contentWindow?.postMessage({ type: 'vite-hmr', payload }, '*')
}

function flushSettled(): void {
  settleTimer = null
  const iframe = settleIframe
  // Priority: reload > updates > error. A reload rebuilds the document, so
  // queued updates/errors about the old graph must not ride along after it.
  if (pendingReload) {
    const reload = pendingReload
    pendingReload = null
    pendingUpdates = []
    pendingError = null
    deliver(iframe, reload)
    return
  }
  // Prefer the settled error over updates from the same burst. The updates
  // would just re-fetch modules that already failed to transform/load and paint
  // a second, nearly-identical overlay a fetch-round-trip later.
  if (pendingError) {
    const err = pendingError
    pendingError = null
    pendingUpdates = []
    deliver(iframe, err)
    return
  }
  if (pendingUpdates.length > 0) {
    const updates = pendingUpdates
    pendingUpdates = []
    deliver(iframe, { type: 'update', updates })
  }
}

function scheduleSettle(iframe: HTMLIFrameElement | null): void {
  settleIframe = iframe
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = setTimeout(flushSettled, SETTLE_MS)
}

/**
 * Post a Vite HotPayload into the preview iframe (browser HMR client).
 *
 * `update`, `error`, and `full-reload` are debounced: a burst merges updates
 * and keeps only the latest error/reload, delivering once the channel is quiet.
 * Prune / connected / ping go through immediately.
 */
export function sendHotPayload(
  iframe: HTMLIFrameElement | null,
  payload: HotPayload,
): void {
  if (payload.type === 'update') {
    pendingUpdates.push(...payload.updates)
    scheduleSettle(iframe)
    return
  }
  if (payload.type === 'error') {
    pendingError = payload
    scheduleSettle(iframe)
    return
  }
  if (payload.type === 'full-reload') {
    pendingReload = payload
    // The reload is authoritative; drop queued work from the same burst.
    pendingUpdates = []
    pendingError = null
    scheduleSettle(iframe)
    return
  }
  deliver(iframe, payload)
}

/**
 * Error-overlay styles + the minimal base styles the preview relies on.
 * Injected into the project's real index.html <head>.
 */
const INJECTED_STYLES = `
    body { margin: 0; }
    #root { min-height: 100vh; }
    .hmr-error {
      position: fixed;
      inset: 0;
      z-index: 99999;
      overflow: auto;
      font-family: monospace;
      /* Opaque: a load error can leave the previous render on the page (the
         host skips reloads that cannot succeed), and letting an orphaned app
         ghost through the error reads as a paint glitch. */
      background: #140c0c;
      color: #ff6b6b;
      padding: 20px;
      margin: 0;
      box-sizing: border-box;
    }
    .hmr-error h2 { margin-top: 0; color: #ff8787; }
    .hmr-error pre { white-space: pre-wrap; word-wrap: break-word; }
  `;

/**
 * Build the iframe document from the project's REAL index.html. Its <title>,
 * <meta>, and <body> content (including the app's own markup) are preserved;
 * we inject the HMR runtime module + overlay styles the way Vite injects
 * /@vite/client into your HTML at dev time. A #root mount point is added when
 * the document doesn't declare one.
 */
export function createViteHmrIframeHtml(indexHtml: string, clientBootstrap: string): string {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');

  // Head: keep the project's own title/meta/links; append Chobitsu (CDP) and
  // the runtime styles.
  const chobitsu = doc.createElement('script');
  chobitsu.setAttribute('crossorigin', '');
  chobitsu.src = 'https://unpkg.com/chobitsu';
  doc.head.appendChild(chobitsu);

  const style = doc.createElement('style');
  style.textContent = INJECTED_STYLES;
  doc.head.appendChild(style);

  // Body: preserve the project's markup; guarantee a #root mount point.
  if (!doc.getElementById('root')) {
    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.appendChild(root);
  }

  // The entry <script type="module" src="..."> is NOT executed from the
  // document — blob-URL documents can't resolve /src/... natively. The runtime
  // imports the entry itself after HMR bootstrap. Strip it to avoid a dead
  // fetch, then append the inline HMR runtime module.
  for (const s of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    s.remove();
  }
  // Strip any user importmap from the preview document. The preview resolves
  // bare imports through optimized-deps, not the browser's native import map
  // (which would hijack them to CDN URLs and break HMR).
  for (const s of Array.from(doc.querySelectorAll('script[type="importmap"]'))) {
    s.remove();
  }
  const runtime = doc.createElement('script');
  runtime.type = 'module';
  runtime.textContent = clientBootstrap;
  runtime.setAttribute('data-vite-hmr-runtime', '');
  doc.body.appendChild(runtime);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
