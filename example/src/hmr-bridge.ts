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

/** Post a Vite HotPayload into the preview iframe (browser HMR client). */
export function sendHotPayload(
  iframe: HTMLIFrameElement | null,
  payload: HotPayload,
): void {
  iframe?.contentWindow?.postMessage({ type: 'vite-hmr', payload }, '*')
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
      background: rgba(20, 12, 12, 0.96);
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
  const runtime = doc.createElement('script');
  runtime.type = 'module';
  runtime.textContent = clientBootstrap;
  runtime.setAttribute('data-vite-hmr-runtime', '');
  doc.body.appendChild(runtime);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
