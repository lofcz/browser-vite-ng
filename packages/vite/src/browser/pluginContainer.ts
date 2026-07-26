/**
 * Browser plugin container — full-fidelity analogue of Vite's
 * `createPluginContainer`, decoupled from Rolldown/Environment.
 *
 * Runs the same hook loop a dev transform uses: `resolveId → load → transform`,
 * with `enforce: 'pre' | 'post'` ordering and a `this`-bound plugin context
 * (resolve/load/error/warn/addWatchFile). It intentionally does NOT implement
 * build-only hooks (renderChunk/generateBundle) since in-browser production
 * build is out of scope by design.
 */

import type { BrowserPlugin, BrowserResolvedConfig } from './config'

export interface PluginContext {
  resolve(id: string, importer?: string): Promise<{ id: string } | null>
  load?(id: string): Promise<string | null>
  error(msg: string, pos?: number): never
  warn(msg: string): void
  addWatchFile(id: string): void
  /** plugin name for diagnostics */
  plugin: string
}

export type TransformResult =
  | { code: string; map?: object | null; moduleType?: string }
  | string
  | null
  | undefined

export interface BrowserPluginHooks extends BrowserPlugin {
  load?: (id: string) => string | null | undefined | Promise<string | null | undefined>
}

function sortPlugins(plugins: BrowserPlugin[]): BrowserPlugin[] {
  const pre: BrowserPlugin[] = []
  const normal: BrowserPlugin[] = []
  const post: BrowserPlugin[] = []
  for (const p of plugins) {
    if (p.enforce === 'pre') pre.push(p)
    else if (p.enforce === 'post') post.push(p)
    else normal.push(p)
  }
  return [...pre, ...normal, ...post]
}

export class PluginContainer {
  private plugins: BrowserPlugin[]
  private watchFiles = new Set<string>()

  constructor(public config: BrowserResolvedConfig) {
    this.plugins = sortPlugins(config.plugins)
  }

  private makeContext(plugin: BrowserPlugin): PluginContext {
    const self = this
    return {
      plugin: plugin.name,
      async resolve(id, importer) {
        return self.resolveId(id, importer)
      },
      async load(id) {
        return self.load(id)
      },
      error(msg, pos) {
        const e = new Error(`[${plugin.name}] ${msg}`)
        if (pos !== undefined) (e as { pos?: number }).pos = pos
        throw e
      },
      warn(msg) {
        self.config.logger.warn(`[${plugin.name}] ${msg}`)
      },
      addWatchFile(id) {
        self.watchFiles.add(id)
      },
    }
  }

  async resolveId(
    id: string,
    importer?: string,
  ): Promise<{ id: string; external?: boolean } | null> {
    for (const plugin of this.plugins) {
      if (!plugin.resolveId) continue
      const ctx = this.makeContext(plugin)
      const result = await plugin.resolveId.call(ctx as never, id, importer)
      if (result == null) continue
      return typeof result === 'string' ? { id: result } : result
    }
    return null
  }

  async load(id: string): Promise<string | null> {
    for (const plugin of this.plugins) {
      const hooks = plugin as BrowserPluginHooks
      if (!hooks.load) continue
      const ctx = this.makeContext(plugin)
      const result = await hooks.load.call(ctx as never, id)
      if (result != null) return typeof result === 'string' ? result : String(result)
    }
    return null
  }

  async transform(
    code: string,
    id: string,
  ): Promise<{ code: string; map: object | null }> {
    let result = { code, map: null as object | null }
    for (const plugin of this.plugins) {
      if (!plugin.transform) continue
      const ctx = this.makeContext(plugin)
      const next = (await plugin.transform.call(
        ctx as never,
        result.code,
        id,
      )) as TransformResult
      if (next == null) continue
      if (typeof next === 'string') {
        result = { code: next, map: result.map }
      } else {
        result = {
          code: next.code,
          map: (next.map as object | null) ?? result.map,
        }
      }
    }
    return result
  }

  getWatchFiles(): string[] {
    return [...this.watchFiles]
  }
}

export function createPluginContainer(
  config: BrowserResolvedConfig,
): PluginContainer {
  return new PluginContainer(config)
}
