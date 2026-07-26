/**
 * Browser-vite HMR client — full Vite 8 HMRClient fidelity.
 *
 * Differs from `client.ts` ONLY in transport: host-driven HotPayload delivery
 * via `handleMessage` / postMessage instead of WebSocket.
 *
 * Uses the same shared HMRClient / createHMRHandler / import.meta.hot semantics
 * as upstream Vite 8 (accept, acceptExports, dispose, prune, invalidate, queueUpdate).
 */

import type { ErrorPayload, HotPayload, Update } from '#types/hmrPayload'
import type { ModuleNamespace } from '#types/hot'
import { HMRClient, HMRContext } from '../shared/hmr'
import { createHMRHandler } from '../shared/hmrHandler'
import {
  normalizeModuleRunnerTransport,
  type ModuleRunnerTransport,
} from '../shared/moduleRunnerTransport'
import { ErrorOverlay, overlayId } from './overlay'
// @ts-expect-error internal virtual module
import '@vite/env'

declare const __BASE__: string
declare const __HMR_ENABLE_OVERLAY__: boolean

const base = __BASE__ || '/'
const enableOverlay = __HMR_ENABLE_OVERLAY__

console.debug('[vite] browser HMR client connecting...')

type HostMessageHandler = (payload: HotPayload) => void

const hostListeners = new Set<HostMessageHandler>()
let transportHandler: ((payload: HotPayload) => void) | undefined
let disconnectHandler: (() => void) | undefined

/** Transport that receives payloads via exported `handleMessage`. */
const browserTransport: ModuleRunnerTransport = {
  connect({ onMessage, onDisconnection }) {
    transportHandler = onMessage
    disconnectHandler = onDisconnection
    onMessage({ type: 'connected' })
  },
  disconnect() {
    disconnectHandler?.()
    transportHandler = undefined
    disconnectHandler = undefined
  },
  send(payload) {
    // Client → host (invalidate, custom events)
    for (const listener of hostListeners) {
      listener(payload)
    }
    if (typeof window !== 'undefined' && window.parent !== window) {
      window.parent.postMessage({ type: 'vite-hmr-from-client', payload }, '*')
    }
  },
}

const transport = normalizeModuleRunnerTransport(browserTransport)

function cleanUrl(pathname: string): string {
  const url = new URL(pathname, 'http://vite.dev')
  url.searchParams.delete('direct')
  return url.pathname + url.search
}

function warnFailedFetch(err: Error, path: string | string[]): void {
  if (!err.message.includes('fetch')) {
    console.error(err)
  }
  console.error(
    `[hmr] Failed to reload ${path}. ` +
      `This could be due to syntax errors or importing non-existent modules.`,
  )
}

function createErrorOverlay(err: ErrorPayload['err']): void {
  if (!enableOverlay) return
  clearErrorOverlay()
  document.body.appendChild(new ErrorOverlay(err))
}

function clearErrorOverlay(): void {
  document.querySelectorAll(overlayId).forEach((n) => n.remove())
}

function hasErrorOverlay(): boolean {
  return document.querySelectorAll(overlayId).length > 0
}

const hmrClient = new HMRClient(
  {
    error: (err) => console.error('[vite]', err),
    debug: (...msg) => console.debug('[vite]', ...msg),
  },
  transport,
  async function importUpdatedModule({
    acceptedPath,
    timestamp,
    explicitImportRequired,
    isWithinCircularImport,
  }: Update): Promise<ModuleNamespace> {
    const [acceptedPathWithoutQuery, query] = acceptedPath.split('?')
    const importPromise = import(
      /* @vite-ignore */
      base +
        acceptedPathWithoutQuery.slice(1) +
        `?${explicitImportRequired ? 'import&' : ''}t=${timestamp}${
          query ? `&${query}` : ''
        }`
    )
    if (isWithinCircularImport) {
      importPromise.catch(() => {
        console.info(
          `[hmr] ${acceptedPath} failed to apply HMR as it's within a circular import. Reload required.`,
        )
      })
    }
    return importPromise
  },
)

const handlePayload = createHMRHandler(async (payload: HotPayload) => {
  switch (payload.type) {
    case 'connected':
      console.debug('[vite] browser HMR connected.')
      break
    case 'update':
      await hmrClient.notifyListeners('vite:beforeUpdate', payload)
      if (hasErrorOverlay()) clearErrorOverlay()
      await Promise.all(
        payload.updates.map((update) => {
          if (update.type === 'js-update') {
            return hmrClient.queueUpdate(update)
          }
          // css-update
          const { path, timestamp } = update
          hmrClient.logger.debug(`[css] hmr update for ${path}`)
          const searchUrl = cleanUrl(path)
          const el = Array.from(
            document.querySelectorAll<HTMLLinkElement>('link'),
          ).find((e) => e.href.includes(searchUrl))
          if (el) {
            const newPath = `${base}${searchUrl.slice(1)}${
              searchUrl.includes('?') ? '&' : '?'
            }t=${timestamp}`
            el.href = new URL(newPath, el.href).href
          }
          return Promise.resolve()
        }),
      )
      await hmrClient.notifyListeners('vite:afterUpdate', payload)
      break
    case 'custom':
      await hmrClient.notifyListeners(payload.event, payload.data)
      break
    case 'full-reload':
      await hmrClient.notifyListeners('vite:beforeFullReload', payload)
      if (payload.path && payload.path.endsWith('.html')) {
        const pagePath = decodeURI(location.pathname)
        const payloadPath = base + payload.path.slice(1)
        if (
          pagePath === payloadPath ||
          payload.path === '/index.html' ||
          pagePath.endsWith('/')
        ) {
          location.reload()
        }
      } else {
        location.reload()
      }
      break
    case 'prune':
      await hmrClient.notifyListeners('vite:beforePrune', payload)
      await hmrClient.prunePaths(payload.paths)
      break
    case 'error':
      await hmrClient.notifyListeners('vite:error', payload)
      if (enableOverlay) {
        createErrorOverlay(payload.err)
      } else {
        console.error(
          `[vite] Internal Server Error\n${payload.err.message}\n${payload.err.stack}`,
        )
      }
      break
    case 'ping':
      break
    default:
      break
  }
})

/**
 * Host / HotChannel entry point — deliver a Vite HotPayload into the real
 * HMRClient pipeline (same as WS onmessage in client.ts).
 */
export async function handleMessage(payload: HotPayload): Promise<void> {
  if (transportHandler) {
    transportHandler(payload)
  }
  await handlePayload(payload)
}

/** Subscribe to client→host payloads (invalidate, custom). */
export function onClientMessage(handler: HostMessageHandler): () => void {
  hostListeners.add(handler)
  return () => {
    hostListeners.delete(handler)
  }
}

// Expose createHotContext for import analysis injection (parity with client.ts)
export function createHotContext(ownerPath: string): HMRContext {
  return new HMRContext(hmrClient, ownerPath)
}

// Style utilities used by Vite CSS HMR (parity with client.ts)
const sheetsMap = new Map<string, HTMLStyleElement>()

export function updateStyle(id: string, content: string): void {
  let style = sheetsMap.get(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('type', 'text/css')
    style.setAttribute('data-vite-dev-id', id)
    style.textContent = content
    document.head.appendChild(style)
  } else {
    style.textContent = content
  }
  sheetsMap.set(id, style)
}

export function removeStyle(id: string): void {
  const style = sheetsMap.get(id)
  if (style) {
    document.head.removeChild(style)
    sheetsMap.delete(id)
  }
}

// Auto-connect transport so handleMessage works immediately
void transport.connect?.({
  onMessage: (data) => {
    void handlePayload(data)
  },
  onDisconnection: () => {
    console.debug('[vite] browser HMR disconnected.')
  },
})

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const data = event.data
    if (data && data.type === 'vite-hmr' && data.payload) {
      void handleMessage(data.payload as HotPayload)
    }
  })
}

console.debug('[vite] browser HMR client ready.')
