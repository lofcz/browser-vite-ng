/**
 * browser-vite public API (Vite 8.1.5)
 *
 * Self-contained browser entry — no Node/Rolldown imports.
 *
 * - Transforms: Oxc WASM (`./transform`)
 * - Module graph + HMR: full Vite 8 fidelity (`./moduleGraph`, `./hmr`)
 * - Transport: HotChannel (`./hotChannel`) instead of WebSocket
 */

export const version = '8.1.5-browser.1'

// Oxc WASM transforms (upstream-aligned options + CSS dev codegen)
export {
  transformWithOxc,
  transformCssDev,
  generateCodeFrame,
  BrowserTransformError,
  type BrowserTransformOptions,
  type BrowserTransformResult,
  type TransformErrorLocation,
} from './transform'

// Sourcemap chaining + inlining (browser analogue of node/server/sourcemap.ts)
export {
  combineSourcemaps,
  ensureSourcesContent,
  applySourcemapIgnoreList,
  genSourceMapUrl,
  getCodeWithSourcemap,
  type RawSourceMap,
} from './sourcemap'

// Browser dev server (transformRequest + module serving, VFS-backed)
export {
  BrowserServer,
  createBrowserServer,
  CLIENT_PUBLIC_PATH,
  ERR_LOAD_URL,
  type BrowserServerOptions,
} from './server'

// Virtual file system (browser file IO + watch events)
export {
  setVirtualFile,
  withVirtualFileBatch,
  deleteVirtualFile,
  readVirtualFile,
  hasVirtualFile,
  listVirtualFiles,
  clearVirtualFiles,
  onVirtualFileEvent,
  resolveVirtualPath,
  type VirtualFileEvent,
  type VirtualFileListener,
} from './vfs'

// Real import analysis (es-module-lexer + hot-context injection)
export { importAnalysisTransform } from './plugins/importAnalysis'

// Full-fidelity HMR (ported from Vite 8 src/node/server/hmr.ts)
export {
  updateModules,
  propagateUpdate,
  handleHMRUpdate,
  handleFileAddUnlink,
  handlePrunedModules,
  lexAcceptedHmrDeps,
  type BrowserHmrEnvironment,
  type HasDeadEnd,
} from './hmr'

export {
  createBrowserHotChannel,
  type HotChannel,
  type HotChannelClient,
  type BrowserHotPayloadHandler,
} from './hotChannel'
export type { HotPayload, Update } from './hmr'

// Full-fidelity module graph (ported from Vite 8 EnvironmentModuleGraph)
export {
  ModuleGraph,
  ModuleNode,
  EnvironmentModuleGraph,
  EnvironmentModuleNode,
  type TransformResult,
} from './moduleGraph'

// Plugin container + config (browser, full hook loop)
export {
  createPluginContainer,
  PluginContainer,
  type PluginContext,
  type BrowserPluginHooks,
} from './pluginContainer'
export {
  resolveConfig,
  type BrowserInlineConfig,
  type BrowserResolvedConfig,
  type BrowserPlugin,
  type BrowserCommand,
} from './config'

export {
  createBrowserEnvironment,
  shouldApplyPlugin,
  filterPluginsForEnvironment,
  getDefaultBrowserEnvironment,
  BROWSER_ENVIRONMENT_NAME,
} from './environment'

// Path helpers (browser-safe, no node:path)
export function normalizePath(id: string): string {
  return id.replace(/\\/g, '/')
}

export function injectQuery(url: string, queryToInject: string): string {
  const [file, postfix = ''] = url.split(/(?=[?#])/)
  return `${file}?${queryToInject}${postfix.startsWith('?') ? `&${postfix.slice(1)}` : postfix}`
}

export function removeImportQuery(url: string): string {
  return url.replace(/[?&]import\b/, '').replace(/[?&]$/, '')
}

export function isCSSRequest(url: string): boolean {
  return /\.css(?:$|\?)/.test(url.split('#')[0])
}
