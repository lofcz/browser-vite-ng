/**
 * Browser dev server — full-fidelity analogue of Vite's `transformRequest` +
 * dev module serving, backed by the virtual FS instead of node:fs.
 *
 * Pipeline (identical order to upstream dev):
 *   url → ensureEntryFromUrl → resolveId → load (VFS) → plugin transform loop
 *     (alias → resolve → oxc → css → define/client-injections → importAnalysis)
 *   → cache into ModuleNode.transformResult → serve to importUpdatedModule.
 *
 * File changes flow: VFS event → moduleGraph invalidation → handleHMRUpdate
 * (full Vite 8 updateModules/propagateUpdate) → HotChannel → client.
 */

import type { BrowserResolvedConfig } from './config'
import { PluginContainer } from './pluginContainer'
import { ModuleGraph, ModuleNode } from './moduleGraph'
import { importAnalysisTransform, isExplicitImportRequired } from './plugins/importAnalysis'
import { cssAnalysisPlugin } from '../node/plugins/css'
import { transformWithOxc, transformCssDev } from './transform'
import { addRefreshWrapper } from './plugins/refresh'
import {
  readVirtualFile,
  hasVirtualFile,
  resolveVirtualPath,
  onVirtualFileEvent,
} from './vfs'
import {
  handleHMRUpdate,
  handleFileAddUnlink,
  updateModules,
  type BrowserHmrEnvironment,
} from './hmr'
import type { HotChannel } from './hotChannel'

export interface BrowserServerOptions {
  config: BrowserResolvedConfig
  hot: HotChannel
  clientPublicPath?: string
  /**
   * Browser deps-optimizer manifest: bare specifier -> /@deps/* URL. Mutable —
   * the host populates it after running the in-browser installer + bundler.
   */
  optimizedDeps?: Record<string, string>
}

const CLIENT_PUBLIC_PATH = '/@vite/client'

function isJSRequest(url: string): boolean {
  return /\.[cm]?[jt]sx?(?:$|\?)/.test(url.split('#')[0])
}
function isCSSRequest(url: string): boolean {
  return /\.css(?:$|\?)/.test(url.split('#')[0])
}
function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, '')
}

export class BrowserServer {
  readonly config: BrowserResolvedConfig
  readonly moduleGraph: ModuleGraph
  readonly pluginContainer: PluginContainer
  readonly environment: BrowserHmrEnvironment
  readonly clientPublicPath: string
  /** Deps-optimizer manifest (bare specifier -> /@deps/* URL). */
  optimizedDeps: Record<string, string>
  private hotChannel: HotChannel
  /** Real upstream `vite:css-analysis` handler, bound to the browser module graph. */
  private cssAnalysis?: (id: string) => void

  constructor(opts: BrowserServerOptions) {
    this.hotChannel = opts.hot
    this.config = opts.config
    this.clientPublicPath = opts.clientPublicPath ?? CLIENT_PUBLIC_PATH
    this.optimizedDeps = opts.optimizedDeps ?? {}
    this.moduleGraph = new ModuleGraph('client', (url) =>
      this.resolveId(url).then((r) => (r ? { id: r.id } : null)),
    )
    this.pluginContainer = new PluginContainer(opts.config)
    this.environment = {
      name: 'client',
      moduleGraph: this.moduleGraph,
      hot: opts.hot,
      logger: {
        info: (m) => this.config.logger.info(m),
      },
      config: { root: this.config.root },
    }

    onVirtualFileEvent((file, event) => {
      if (event === 'change') {
        void handleHMRUpdate(file, readVirtualFile(file) ?? '', this.environment)
      } else {
        void handleFileAddUnlink(file, this.environment, event === 'unlink')
      }
    })
  }

  async resolveId(
    id: string,
    importer?: string,
  ): Promise<{ id: string; external?: boolean } | null> {
    // user plugins first (pre + normal ordering handled in container)
    const viaPlugins = await this.pluginContainer.resolveId(id, importer)
    if (viaPlugins) return viaPlugins

    if (id.startsWith('/@id/')) return { id }
    if (/^(?:https?|data):/.test(id)) return { id, external: true }
    if (id === this.clientPublicPath) return { id }

    const resolved = resolveVirtualPath(id, importer, this.config.root)
    if (resolved) return { id: resolved }
    return null
  }

  private async load(id: string): Promise<string | null> {
    if (id === this.clientPublicPath) return null // served by runtime client
    const clean = cleanUrl(id.replace(/^\/@id\//, ''))
    if (hasVirtualFile(clean)) return readVirtualFile(clean) ?? null
    const viaPlugins = await this.pluginContainer.load(id)
    if (viaPlugins != null) return viaPlugins
    return null
  }

  /**
   * Full dev transform of one module URL — analogue of `transformRequest`.
   * Returns the transformed ESM code served to the browser/iframe.
   */
  private inFlight = new Map<string, Promise<{ code: string; map: object | null } | null>>()

  async transformRequest(url: string): Promise<{ code: string; map: object | null; etag?: string } | null> {
    const prettyUrl = url.replace(/^\/@id\//, '')
    const mod = await this.moduleGraph.ensureEntryFromUrl(url, true)
    if (mod.transformResult) return mod.transformResult
    // Guard against re-entrant / duplicate transforms (recursive import
    // resolution can re-request the same url) which would double-rewrite
    // import specifiers.
    const pending = this.inFlight.get(url)
    if (pending) return pending
    const p = this.transformRequestInner(url, prettyUrl, mod)
    this.inFlight.set(url, p)
    try {
      return await p
    } catch (err) {
      // Mirror Vite's dev server: a transform error is broadcast as an `error`
      // HotPayload so the client renders its error overlay, instead of only
      // surfacing as an uncaught rejection in the host console.
      const e = err instanceof Error ? err : new Error(String(err))
      this.hotChannel.send?.({
        type: 'error',
        err: {
          message: e.message,
          stack: e.stack,
          id: url,
          plugin: 'vite:oxc',
        },
      } as never)
      throw err
    } finally {
      this.inFlight.delete(url)
    }
  }

  private async transformRequestInner(
    _url: string,
    prettyUrl: string,
    mod: ModuleNode,
  ): Promise<{ code: string; map: object | null } | null> {

    const resolved = await this.resolveId(prettyUrl)
    const id = resolved?.id ?? prettyUrl
    mod.id = id
    mod.file = cleanUrl(id.replace(/^\/@id\//, ''))
    this.registerModule(mod)

    let code: string
    if (isCSSRequest(id)) {
      const raw = (await this.load(id)) ?? ''
      const result = transformCssDev(raw, id, this.clientPublicPath)
      code = result.code
      const analyzed = await importAnalysisTransform(code, id, {
        moduleGraph: this.moduleGraph,
        environment: this.environment,
        clientPublicPath: this.clientPublicPath,
        base: this.config.base,
        resolveId: (u, i) => this.resolveId(u, i),
        isJSRequest,
        isCSSRequest,
      })
      code = analyzed?.code ?? code
      this.runCssAnalysis(id)
      const out = { code, map: null }
      mod.transformResult = out
      return out
    }

    // Dispatch on the RESOLVED id (which carries the real extension), not the
    // raw request url — an extensionless specifier like './Counter' must still
    // be treated as JS once it resolves to '/src/Counter.tsx'.
    if (!isJSRequest(id)) {
      const raw = await this.load(id)
      if (raw == null) return null
      const out = { code: raw, map: null }
      mod.transformResult = out
      return out
    }

    const loaded = await this.load(id)
    if (loaded == null) return null

    // Oxc transform (JS/TS/JSX/TSX → JS) first — identical to Vite's transform
    // order, so import-analysis runs on JavaScript with correct lexer indices.
    // React Fast Refresh is enabled natively by Oxc for JSX/TSX (it emits the
    // $RefreshReg$/$RefreshSig$ calls); we then append the refresh wrapper so
    // component modules self-accept — exactly like @vitejs/plugin-react.
    const isJsxSource = /\.[cm]?[jt]sx(?:$|\?)/.test(id)
    const oxc = await transformWithOxc(loaded, id, {
      jsx: this.config.oxc?.jsx
        ? ({ ...(this.config.oxc.jsx as object), refresh: isJsxSource } as never)
        : isJsxSource
          ? ({ runtime: 'automatic', importSource: 'react', refresh: true } as never)
          : (undefined as never),
    })
    code = oxc.code

    // Fast Refresh wrapper (auto-accept component modules) — analogue of
    // @vitejs/plugin-react; no hand-written import.meta.hot.accept() needed.
    if (isJsxSource) {
      code = addRefreshWrapper(code, id)
    }

    // plugin transform loop (user plugins)
    const viaPlugins = await this.pluginContainer.transform(code, id)
    code = viaPlugins.code

    // Import analysis LAST (Vite post plugin): lexes the transformed JS,
    // rewrites specifiers to servable URLs, injects hot context, builds graph.
    const analyzed = await importAnalysisTransform(code, id, {
      moduleGraph: this.moduleGraph,
      environment: this.environment,
      clientPublicPath: this.clientPublicPath,
      base: this.config.base,
      resolveId: (u, i) => this.resolveId(u, i),
      isJSRequest,
      isCSSRequest,
      optimizedDeps: this.optimizedDeps,
    })
    code = analyzed?.code ?? code

    const out = { code, map: analyzed?.map ?? viaPlugins.map ?? oxc.map ?? null }
    mod.transformResult = out
    return out
  }

  /**
   * Run the REAL upstream `vite:css-analysis` transform handler against the
   * browser module graph. import-analysis intentionally skips module-graph
   * updates for CSS, deferring to this plugin — it marks plain CSS modules
   * self-accepting so an edit hot-swaps in place (`css-update`) instead of
   * triggering a full page reload. The handler only reads
   * `this.environment.moduleGraph` and `this._addedImports`, so we bind just
   * that surface of the dev environment (no Node server required).
   */
  private runCssAnalysis(id: string): void {
    if (!this.cssAnalysis) {
      const plugin = cssAnalysisPlugin(this.config as never)
      const handler =
        typeof plugin.transform === 'object' && plugin.transform !== null
          ? (plugin.transform as { handler: unknown }).handler
          : plugin.transform
      const ctx = {
        environment: this.environment,
        _addedImports: undefined,
      }
      this.cssAnalysis = (cssId) =>
        (handler as (this: unknown, code: string, id: string) => void).call(
          ctx,
          '',
          cssId,
        )
    }
    this.cssAnalysis(id)
  }

  private registerModule(mod: ModuleNode): void {
    if (mod.id) {
      const g = this.moduleGraph as unknown as {
        idToModuleMap: Map<string, ModuleNode>
        fileToModulesMap: Map<string, Set<ModuleNode>>
      }
      g.idToModuleMap.set(mod.id, mod)
      if (mod.file) {
        let set = g.fileToModulesMap.get(mod.file)
        if (!set) {
          set = new Set()
          g.fileToModulesMap.set(mod.file, set)
        }
        set.add(mod)
      }
    }
  }

  /** Serve a module to `importUpdatedModule` / initial load. */
  async fetchModule(url: string): Promise<{ code: string } | null> {
    const res = await this.transformRequest(url)
    return res ? { code: res.code } : null
  }

  /** Trigger full HMR for an edited file (content already written to VFS). */
  async hotUpdate(file: string): Promise<void> {
    const mods = this.moduleGraph.getModulesByFile(cleanUrl(file))
    updateModules(
      this.environment,
      file,
      mods ? [...mods] : [],
      Date.now(),
    )
  }
}

export function createBrowserServer(opts: BrowserServerOptions): BrowserServer {
  return new BrowserServer(opts)
}

export { CLIENT_PUBLIC_PATH, isJSRequest, isCSSRequest, isExplicitImportRequired }
