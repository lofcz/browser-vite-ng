/**
 * Browser ModuleGraph — full Vite 8 EnvironmentModuleGraph fidelity.
 *
 * Ported from `src/node/server/moduleGraph.ts` without Node/Rolldown deps.
 * Soft/hard invalidation, acceptedHmrDeps/Exports, importedBindings preserved.
 */

import type { RawSourceMap } from './sourcemap'

export interface TransformResult {
  code: string
  map: RawSourceMap | null
  etag?: string
}

export class ModuleNode {
  environment: string
  url: string
  id: string | null = null
  file: string | null = null
  type: 'js' | 'css' | 'asset'
  importers = new Set<ModuleNode>()
  importedModules = new Set<ModuleNode>()
  acceptedHmrDeps = new Set<ModuleNode>()
  acceptedHmrExports: Set<string> | null = null
  importedBindings: Map<string, Set<string>> | null = null
  isSelfAccepting?: boolean
  transformResult: TransformResult | null = null
  lastHMRTimestamp = 0
  lastHMRInvalidationReceived = false
  lastInvalidationTimestamp = 0
  /** @internal */
  invalidationState: TransformResult | 'HARD_INVALIDATED' | undefined
  /** @internal */
  staticImportedUrls?: Set<string>

  constructor(url: string, environment = 'client', setIsSelfAccepting = true) {
    this.environment = environment
    this.url = url
    this.type = isCssUrl(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }
}

function isCssUrl(url: string): boolean {
  return /\.css(?:$|\?)/.test(url.split('#')[0])
}

function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, '')
}

function removeTimestampQuery(url: string): string {
  return url.replace(/[?&]t=\d+/g, '').replace(/[?&]$/, '')
}

export class ModuleGraph {
  environment: string
  urlToModuleMap = new Map<string, ModuleNode>()
  idToModuleMap = new Map<string, ModuleNode>()
  fileToModulesMap = new Map<string, Set<ModuleNode>>()
  /** @internal */
  _hasResolveFailedErrorModules = new Set<ModuleNode>()

  constructor(
    environment: string,
    private resolveId: (
      url: string,
    ) => Promise<{ id: string } | null> | { id: string } | null,
  ) {
    this.environment = environment
  }

  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  async getModuleByUrl(rawUrl: string): Promise<ModuleNode | undefined> {
    return this.urlToModuleMap.get(removeTimestampQuery(rawUrl))
  }

  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
  ): Promise<ModuleNode> {
    const url = removeTimestampQuery(rawUrl)
    let mod = this.urlToModuleMap.get(url)
    if (mod) return mod

    mod = new ModuleNode(url, this.environment, setIsSelfAccepting)
    this.urlToModuleMap.set(url, mod)

    const resolved = await this.resolveId(url)
    if (resolved) {
      mod.id = resolved.id
      mod.file = cleanUrl(resolved.id)
      this.idToModuleMap.set(resolved.id, mod)
      if (mod.file) {
        let set = this.fileToModulesMap.get(mod.file)
        if (!set) {
          set = new Set()
          this.fileToModulesMap.set(mod.file, set)
        }
        set.add(mod)
      }
    }
    return mod
  }

  /**
   * Update importer ↔ imported edges (and HMR accept edges when provided).
   */
  updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,
    staticImportedUrls?: Set<string>,
  ): Set<ModuleNode> {
    mod.isSelfAccepting = isSelfAccepting
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings
    if (staticImportedUrls) mod.staticImportedUrls = staticImportedUrls

    const prevImports = mod.importedModules
    const nextImports = new Set<ModuleNode>()
    for (const imported of importedModules) {
      const dep =
        typeof imported === 'string'
          ? this.urlToModuleMap.get(imported) ||
            this.idToModuleMap.get(imported)
          : imported
      if (dep) {
        nextImports.add(dep)
        dep.importers.add(mod)
      }
    }
    // Unlink removed imports
    for (const prev of prevImports) {
      if (!nextImports.has(prev)) {
        prev.importers.delete(mod)
      }
    }
    mod.importedModules = nextImports

    const accepted = new Set<ModuleNode>()
    for (const a of acceptedModules) {
      const dep =
        typeof a === 'string'
          ? this.urlToModuleMap.get(a) || this.idToModuleMap.get(a)
          : a
      if (dep) accepted.add(dep)
    }
    mod.acceptedHmrDeps = accepted

    // Pruned modules = previous imports no longer imported
    const pruned = new Set<ModuleNode>()
    for (const prev of prevImports) {
      if (!nextImports.has(prev) && prev.importers.size === 0) {
        pruned.add(prev)
      }
    }
    return pruned
  }

  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
    isHmr = false,
    softInvalidate = false,
  ): void {
    const prevInvalidationState = mod.invalidationState

    if (softInvalidate) {
      mod.invalidationState ??= mod.transformResult ?? 'HARD_INVALIDATED'
    } else {
      mod.invalidationState = 'HARD_INVALIDATED'
    }

    if (seen.has(mod) && prevInvalidationState === mod.invalidationState) {
      return
    }
    seen.add(mod)

    if (isHmr) {
      mod.lastHMRTimestamp = timestamp
      mod.lastHMRInvalidationReceived = false
    } else {
      mod.lastInvalidationTimestamp = timestamp
    }

    // Soft invalidate: keep transformResult for timestamp-only refresh
    if (mod.invalidationState !== 'HARD_INVALIDATED' && softInvalidate) {
      // keep transformResult
    } else {
      mod.transformResult = null
    }

    mod.importers.forEach((importer) => {
      if (!importer.acceptedHmrDeps.has(mod)) {
        // Soft invalidate importers that statically imported this module
        const shouldSoft =
          softInvalidate &&
          importer.staticImportedUrls?.has(mod.url) === true
        this.invalidateModule(importer, seen, timestamp, isHmr, shouldSoft)
      }
    })
  }

  invalidateAll(): void {
    const seen = new Set<ModuleNode>()
    for (const mod of this.urlToModuleMap.values()) {
      this.invalidateModule(mod, seen)
    }
  }

  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (!mods) return
    const seen = new Set<ModuleNode>()
    mods.forEach((mod) => this.invalidateModule(mod, seen))
  }

  onFileDelete(file: string): void {
    const mods = this.getModulesByFile(file)
    if (!mods) return
    mods.forEach((mod) => {
      mod.importedModules.forEach((importedMod) => {
        importedMod.importers.delete(mod)
      })
    })
  }
}

/** Backward-compat alias matching older browser-vite exports */
export { ModuleNode as EnvironmentModuleNode }
export { ModuleGraph as EnvironmentModuleGraph }
