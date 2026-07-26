/**
 * Browser HMR — full Vite 8 fidelity.
 *
 * Ported from `src/node/server/hmr.ts` (`updateModules`, `propagateUpdate`,
 * `isNodeWithinCircularImports`, `handlePrunedModules`, `lexAcceptedHmrDeps`).
 *
 * Transport is injected via HotChannel (`hot.send`) — not WebSocket.
 * Do not simplify boundary propagation / circular-import / partial-accept logic.
 */

import type { HotPayload, Update } from '../../types/hmrPayload'
import type { ModuleGraph, ModuleNode } from './moduleGraph'
import type { HotChannel } from './hotChannel'

export type HasDeadEnd = string | boolean

interface PropagationBoundary {
  boundary: ModuleNode & { type: 'js' | 'css' }
  acceptedVia: ModuleNode
  isWithinCircularImport: boolean
}

export interface BrowserHmrEnvironment {
  name: string
  moduleGraph: ModuleGraph
  hot: HotChannel
  logger?: {
    info: (msg: string, opts?: { clear?: boolean; timestamp?: boolean }) => void
  }
  config?: { root?: string; server?: { middlewareMode?: boolean } }
}

function normalizeHmrUrl(url: string): string {
  return url.startsWith('/') ||
    url.startsWith('http:') ||
    url.startsWith('https:') ||
    url.startsWith('data:')
    ? url
    : `/${url}`
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
): boolean {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

/**
 * Check importers recursively if it's an import loop. An accepted module within
 * an import loop cannot recover its execution order and should be reloaded.
 * (Vite 8 identical)
 */
function isNodeWithinCircularImports(
  node: ModuleNode,
  nodeChain: ModuleNode[],
  currentChain: ModuleNode[] = [node],
  traversedModules = new Set<ModuleNode>(),
): boolean {
  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  for (const importer of node.importers) {
    if (importer === node) continue

    const importerIndex = nodeChain.indexOf(importer)
    if (importerIndex > -1) {
      return true
    }

    if (!currentChain.includes(importer)) {
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        currentChain.concat(importer),
        traversedModules,
      )
      if (result) return result
    }
  }
  return false
}

/**
 * Vite 8 `propagateUpdate` — do not simplify.
 */
export function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: ModuleNode[] = [node],
): HasDeadEnd {
  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  // #7561 — not yet analyzed → stop propagation
  if (node.id && node.isSelfAccepting === undefined) {
    return false
  }

  if (node.isSelfAccepting) {
    const boundary = node as ModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
    return false
  }

  if (node.acceptedHmrExports) {
    const boundary = node as ModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
  } else {
    if (!node.importers.size) {
      return true
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)

    if (importer.acceptedHmrDeps.has(node)) {
      const boundary = importer as ModuleNode & { type: 'js' | 'css' }
      boundaries.push({
        boundary,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (
      !currentChain.includes(importer) &&
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      return true
    }
  }
  return false
}

/**
 * Vite 8 `updateModules` — full fidelity. Sends HotPayload via environment.hot.
 */
export function updateModules(
  environment: BrowserHmrEnvironment,
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  firstInvalidatedBy?: string,
): void {
  const { hot } = environment
  const updates: Update[] = []
  const invalidatedModules = new Set<ModuleNode>()
  const traversedModules = new Set<ModuleNode>()
  let needFullReload: HasDeadEnd = modules.length === 0

  for (const mod of modules) {
    const boundaries: PropagationBoundary[] = []
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    environment.moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
    )

    if (needFullReload) {
      continue
    }

    if (hasDeadEnd) {
      needFullReload = hasDeadEnd
      continue
    }

    if (
      firstInvalidatedBy &&
      boundaries.some(
        ({ acceptedVia }) =>
          normalizeHmrUrl(acceptedVia.url) === firstInvalidatedBy,
      )
    ) {
      needFullReload = 'circular import invalidate'
      continue
    }

    updates.push(
      ...boundaries.map(
        ({ boundary, acceptedVia, isWithinCircularImport }) =>
          ({
            type: `${boundary.type}-update` as const,
            timestamp,
            path: normalizeHmrUrl(boundary.url),
            acceptedPath: normalizeHmrUrl(acceptedVia.url),
            explicitImportRequired: false,
            isWithinCircularImport,
            firstInvalidatedBy,
          }) satisfies Update,
      ),
    )
  }

  const isClientHtmlChange =
    file.endsWith('.html') &&
    environment.name === 'client' &&
    modules.every((mod) => mod.type !== 'js')

  if (needFullReload || isClientHtmlChange) {
    const reason =
      typeof needFullReload === 'string' ? ` (${needFullReload})` : ''
    environment.logger?.info(`page reload ${file}${reason}`, {
      clear: !firstInvalidatedBy,
      timestamp: true,
    })
    hot.send?.({
      type: 'full-reload',
      path: '*',
      triggeredBy: file,
    })
    return
  }

  if (updates.length === 0) {
    return
  }

  environment.logger?.info(
    `hmr update ${[...new Set(updates.map((u) => u.path))].join(', ')}`,
    { clear: !firstInvalidatedBy, timestamp: true },
  )
  hot.send?.({
    type: 'update',
    updates,
  })
}

export function handlePrunedModules(
  mods: Set<ModuleNode>,
  environment: BrowserHmrEnvironment,
): void {
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    mod.lastHMRInvalidationReceived = false
  })
  environment.hot.send?.({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

/**
 * Run HMR for a changed file with known content (virtual FS).
 * Collects modules from the graph and runs full `updateModules`.
 */
export async function handleHMRUpdate(
  file: string,
  _content: string,
  environment: BrowserHmrEnvironment,
): Promise<void> {
  const mods = environment.moduleGraph.getModulesByFile(file)
  const modules = mods ? [...mods] : []
  updateModules(environment, file, modules, Date.now())
}

export async function handleFileAddUnlink(
  file: string,
  environment: BrowserHmrEnvironment,
  isUnlink = false,
): Promise<void> {
  if (isUnlink) {
    environment.moduleGraph.onFileDelete(file)
  }
  const mods = environment.moduleGraph.getModulesByFile(file)
  const modules = mods ? [...mods] : []
  if (modules.length > 0) {
    updateModules(environment, file, modules, Date.now())
  }
}

// --- lexAcceptedHmrDeps (Vite 8 identical) ---------------------------------

const whitespaceRE = /\s/

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  let state: LexerState = LexerState.inCall
  let prevState: LexerState = LexerState.inCall
  let currentDep = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  function error(i: number): never {
    throw new Error(
      `import.meta.hot.accept() can only accept string literals or an ` +
        `Array of string literals (at char ${i})`,
    )
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              return true // self-accepting
            }
          } else {
            if (char === `]`) {
              return false
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) return false
          state = prevState
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) return false
          state = prevState
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) return false
          state = prevState
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        error(i)
    }
  }
  return false
}

export type { HotPayload, Update }
