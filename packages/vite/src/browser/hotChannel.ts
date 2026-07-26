/**
 * Browser HotChannel — transport adapter only.
 *
 * Delivers the same HotPayload shapes as Vite 8's WebSocket channel.
 * Does NOT alter HMR algorithm / updateModules / propagateUpdate behavior.
 */

import type { HotPayload } from '../../types/hmrPayload'

export interface HotChannelClient {
  send(payload: HotPayload): void
}

export type HotChannelListener = (
  data: unknown,
  client: HotChannelClient,
) => void

export interface HotChannel {
  /**
   * When true, the fs access check is skipped in fetchModule.
   * Set this for transports that is not exposed over the network.
   */
  skipFsCheck?: boolean
  /**
   * Broadcast events to all clients
   */
  send?(payload: HotPayload): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on?(event: string, listener: HotChannelListener | (() => void)): void
  /**
   * Unregister event listener
   */
  off?(event: string, listener: Function): void
  /**
   * Start listening for messages
   */
  listen?(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close?(): Promise<unknown> | void
}

export type BrowserHotPayloadHandler = (payload: HotPayload) => void

/**
 * Create a HotChannel that broadcasts Vite HMR payloads to registered handlers
 * (typically postMessage into a preview iframe / worker).
 */
export function createBrowserHotChannel(
  onBroadcast?: BrowserHotPayloadHandler,
): HotChannel & {
  subscribe(handler: BrowserHotPayloadHandler): () => void
  receiveFromClient(payload: HotPayload): void
} {
  const listeners = new Map<string, Set<Function>>()
  const subscribers = new Set<BrowserHotPayloadHandler>()
  if (onBroadcast) subscribers.add(onBroadcast)

  const client: HotChannelClient = {
    send(payload: HotPayload) {
      const key =
        payload.type === 'custom' ? (payload as { event: string }).event : payload.type
      const set = listeners.get(key)
      if (set) {
        for (const listener of set) {
          ;(listener as HotChannelListener)(
            payload.type === 'custom'
              ? (payload as { data?: unknown }).data
              : payload,
            client,
          )
        }
      }
    },
  }

  return {
    skipFsCheck: true,

    send(payload: HotPayload) {
      for (const handler of subscribers) {
        handler(payload)
      }
    },

    on(event: string, listener: Function) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
    },

    off(event: string, listener: Function) {
      listeners.get(event)?.delete(listener)
    },

    listen() {
      const connectionListeners = listeners.get('connection')
      if (connectionListeners) {
        for (const listener of connectionListeners) {
          ;(listener as () => void)()
        }
      }
    },

    close() {
      listeners.clear()
      subscribers.clear()
    },

    subscribe(handler: BrowserHotPayloadHandler) {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },

    receiveFromClient(payload: HotPayload) {
      client.send(payload)
    },
  }
}
