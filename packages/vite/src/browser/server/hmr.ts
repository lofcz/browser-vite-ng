/**
 * Browser HMR entry — thin adapter over Vite 8's full HMR implementation.
 *
 * CRITICAL: No algorithm simplifications. We call upstream
 * `handleHMRUpdate` / `updateModules` from `src/node/server/hmr.ts`.
 *
 * Browser-only deltas:
 * 1. Virtual FS via `setBrowserVirtualFileContent` (marked patch in upstream hmr.ts)
 * 2. Transport: HotChannel (see `../hotChannel.ts`) instead of WebSocket —
 *    must be wired on DevEnvironment.hot before calling handleHMRUpdate.
 */

import path from 'node:path'
import type { ViteDevServer } from '../../node/server'
import {
  handleHMRUpdate as upstreamHandleHMRUpdate,
  updateModules,
  getShortName,
  setBrowserVirtualFileContent,
} from '../../node/server/hmr'
import type { DevEnvironment } from '../../node/server/environment'
import type { EnvironmentModuleNode } from '../../node/server/moduleGraph'
import { normalizePath } from '../../node/utils'

export type VirtualFileReader = (file: string) => string | Promise<string>

/**
 * Browser-facing HMR update with explicit content (virtual FS).
 *
 * Runs the full Vite 8 HMR pipeline: plugin hotUpdate/handleHotUpdate hooks,
 * EnvironmentModuleGraph invalidation, boundary propagation, circular-import
 * detection, CSS importer chains, prune/full-reload payloads via HotChannel.
 */
export async function handleHMRUpdate(
  file: string,
  content: string,
  server: ViteDevServer,
  type: 'create' | 'delete' | 'update' = 'update',
): Promise<void> {
  const normalized = normalizePath(file)
  setBrowserVirtualFileContent(normalized, content)
  // Also key by the raw path in case callers mix absolute/virtual forms
  if (file !== normalized) {
    setBrowserVirtualFileContent(file, content)
  }
  await upstreamHandleHMRUpdate(type, normalized, server)
}

/**
 * Directly invoke Vite 8 `updateModules` (full fidelity) for a known module set.
 */
export function browserUpdateModules(
  environment: DevEnvironment,
  file: string,
  modules: EnvironmentModuleNode[],
  timestamp: number,
  firstInvalidatedBy?: string,
): void {
  updateModules(
    environment,
    getShortName(file, environment.config.root),
    modules,
    timestamp,
    firstInvalidatedBy,
  )
}

/**
 * File add/unlink — full Vite 8 HMR via create/delete types (includes
 * resolve-failed module recovery on create).
 */
export async function handleFileAddUnlink(
  file: string,
  content: string | null,
  server: ViteDevServer,
  isUnlink = false,
): Promise<void> {
  if (isUnlink) {
    await handleHMRUpdate(file, content ?? '', server, 'delete')
    return
  }
  await handleHMRUpdate(file, content ?? '', server, 'create')
}

export function resolveVirtualFile(root: string, file: string): string {
  return normalizePath(
    file.startsWith('/') ? file : path.posix.join(root, file),
  )
}

// Re-export upstream primitives — never fork these for "simpler" browser HMR
export {
  updateModules,
  getShortName,
  setBrowserVirtualFileContent,
  clearBrowserVirtualFileContent,
  normalizeHotChannel,
  createServerHotChannel,
} from '../../node/server/hmr'
export type {
  HotUpdateOptions,
  HmrContext,
  HotChannel,
  HotChannelClient,
  NormalizedHotChannel,
} from '../../node/server/hmr'
