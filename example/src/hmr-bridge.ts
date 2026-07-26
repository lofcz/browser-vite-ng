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
 * Iframe document: React UMD + Chobitsu + inlined browser HMR client bootstrap.
 * The bootstrap must wire `handleMessage` to the same HotPayload switch as
 * `packages/vite/src/client/browser.ts` (update → queueUpdate / css href swap,
 * full-reload, prune, error overlay).
 */
export function createViteHmrIframeHtml(clientBootstrap: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script crossorigin src="https://unpkg.com/chobitsu"></script>
  <style>
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
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
${clientBootstrap}
  </script>
</body>
</html>`
}
