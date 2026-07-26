/**
 * Browser import-analysis — full-fidelity port of Vite 8's
 * `src/node/plugins/importAnalysis.ts` (dev path), decoupled from node:fs,
 * node:path, es-module-lexer's WASM init location, and the deps optimizer.
 *
 * Semantics preserved verbatim:
 * - es-module-lexer for import/export parsing (no regex)
 * - `import.meta.hot` detection; `lexAcceptedHmrDeps` / `lexAcceptedHmrExports`
 * - `importedBindings` extraction for partial accept
 * - import specifier rewriting with dep `lastHMRTimestamp` (`?t=`)
 * - hot-context injection: `import.meta.hot = createHotContext("<url>")`
 * - `moduleGraph.updateModuleInfo(...)` + `handlePrunedModules(...)`
 */

import { init as initLexer, parse as parseImports } from 'es-module-lexer'
import MagicString from 'magic-string'
import type { ImportSpecifier } from 'es-module-lexer'
import type { ModuleGraph } from '../moduleGraph'
import { handlePrunedModules, lexAcceptedHmrDeps } from '../hmr'
import type { BrowserHmrEnvironment } from '../hmr'

export interface ImportAnalysisOptions {
  moduleGraph: ModuleGraph
  environment: BrowserHmrEnvironment
  clientPublicPath: string
  base?: string
  enablePartialAccept?: boolean
  resolveId: (url: string, importer: string) => Promise<{ id: string } | null>
  isJSRequest: (url: string) => boolean
  isCSSRequest: (url: string) => boolean
  /**
   * Browser analogue of Vite's deps optimizer manifest: bare specifier
   * (e.g. "react", "react-dom/client") -> public optimized URL ("/@deps/x.js").
   * When a bare import matches, it is rewritten to the optimized module.
   */
  optimizedDeps?: Record<string, string>
}

interface UrlPosition {
  url: string
  start: number
  end: number
}

let lexerReady: Promise<unknown> | null = null
function ensureLexer(): Promise<unknown> {
  if (!lexerReady) lexerReady = initLexer
  return lexerReady
}

function removeTimestampQuery(url: string): string {
  return url.replace(/[?&]t=\d+/g, '').replace(/[?&]$/, '')
}

function stripBase(url: string, base: string): string {
  return base !== '/' && url.startsWith(base) ? url.slice(base.length - 1) : url
}

function normalizeHmrUrl(url: string): string {
  return url.startsWith('/') || /^(?:https?|data):/.test(url) ? url : `/${url}`
}

function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, '')
}

function extractImportedBindings(
  id: string,
  source: string,
  importSpec: ImportSpecifier,
  importedBindings: Map<string, Set<string>>,
): void {
  let bindings = importedBindings.get(id)
  if (!bindings) {
    bindings = new Set<string>()
    importedBindings.set(id, bindings)
  }
  const isDynamic = importSpec.d > -1
  const isMeta = importSpec.d === -2
  if (isDynamic || isMeta) {
    bindings.add('*')
    return
  }
  // Static-import binding extraction, equivalent to upstream's use of mlly's
  // parseStaticImport — implemented here to avoid pulling node builtins into
  // the browser bundle (mlly imports node:path/fs/v8).
  const exp = source.slice(importSpec.ss, importSpec.se)
  if (/\*\s+as\s+/.test(exp)) bindings.add('*')
  const namedMatch = exp.match(/\{([\s\S]*?)\}/)
  if (namedMatch) {
    for (let name of namedMatch[1].split(',')) {
      name = name.trim()
      if (!name) continue
      const asParts = name.split(/\s+as\s+/)
      bindings.add(asParts[0].trim())
    }
  }
  // default import = identifier(s) before `{` or `*`
  const beforeBraces = exp
    .replace(/^\s*import\s+/, '')
    .replace(/\{[\s\S]*?\}/, '')
    .replace(/\*\s+as\s+\w+/, '')
    .replace(/from[\s\S]*$/, '')
    .trim()
    .replace(/,$/, '')
    .trim()
  if (beforeBraces && !beforeBraces.startsWith('{') && !beforeBraces.startsWith('*')) {
    bindings.add('default')
  }
}

function lexAcceptedHmrExports(
  code: string,
  start: number,
  exports: Set<string>,
): void {
  // minimal faithful lexer for acceptExports(['a','b'] | '*')
  let i = start
  const ws = /\s/
  while (i < code.length) {
    const ch = code[i]
    if (ws.test(ch) || ch === ',' || ch === '[' || ch === ']') {
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      let name = ''
      while (j < code.length && code[j] !== quote) name += code[j++]
      exports.add(name)
      i = j + 1
      continue
    }
    break
  }
}

export function isExplicitImportRequired(url: string): boolean {
  return !/\.[cm]?[jt]sx?(?:$|\?)/.test(cleanUrl(url)) && !/\.css(?:$|\?)/.test(cleanUrl(url))
}

/**
 * Full import analysis transform. Returns transformed source or null to skip.
 */
export async function importAnalysisTransform(
  source: string,
  importer: string,
  opts: ImportAnalysisOptions,
): Promise<{ code: string; map: object | null } | null> {
  const {
    moduleGraph,
    environment,
    clientPublicPath,
    base = '/',
    enablePartialAccept = true,
    resolveId,
    isJSRequest,
    isCSSRequest,
    optimizedDeps,
  } = opts

  if (/\.(?:map|json)(?:$|\?)/.test(importer)) return null

  await ensureLexer()
  let imports: readonly ImportSpecifier[]
  let exports: readonly { n: string }[]
  try {
    ;[imports, exports] = parseImports(source)
  } catch {
    return null
  }

  const importerModule = moduleGraph.getModuleById(importer)
  if (!importerModule) return null

  if (!imports.length) {
    const pruned = moduleGraph.updateModuleInfo(
      importerModule,
      new Set(),
      null,
      new Set(),
      null,
      false,
      new Set(),
    )
    if (pruned) handlePrunedModules(pruned, environment)
    return { code: source, map: null }
  }

  let hasHMR = false
  let isSelfAccepting = false
  let isPartiallySelfAccepting = false
  const importedBindings = enablePartialAccept
    ? new Map<string, Set<string>>()
    : null
  const importedUrls = new Set<string>()
  const staticImportedUrls = new Set<string>()
  const acceptedUrls = new Set<UrlPosition>()
  const acceptedExports = new Set<string>()
  const orderedAcceptedUrls = new Map<number, Set<UrlPosition>>()
  const orderedAcceptedExports = new Map<number, Set<string>>()

  let s: MagicString | undefined
  const str = () => (s ||= new MagicString(source))

  const normalizeUrl = async (url: string, _pos: number): Promise<string> => {
    // Bare imports that were pre-bundled by the browser deps optimizer are
    // rewritten to their optimized /@deps/* module (analogue of upstream
    // tryOptimizedResolve / the /@id/__x00__dep URLs). Only bare specifiers
    // (no ./ / / protocol) are optimizer candidates.
    if (
      optimizedDeps &&
      !url.startsWith('.') &&
      !url.startsWith('/') &&
      !/^(?:https?|data):/.test(url)
    ) {
      const optimized = optimizedDeps[url]
      if (optimized) return optimized
    }
    const resolved = await resolveId(url, importer)
    const id = resolved?.id ?? url
    let normalized = id
    const depModule = await moduleGraph.ensureEntryFromUrl(
      removeTimestampQuery(normalized),
      true,
    )
    if (depModule.lastHMRTimestamp > 0) {
      normalized = injectTimestamp(normalized, depModule.lastHMRTimestamp)
    }
    // browser-valid specifier
    if (normalized[0] !== '.' && normalized[0] !== '/' && !/^(?:https?|data):/.test(normalized)) {
      normalized = `/@id/${normalized}`
    }
    return normalized
  }

  for (let index = 0; index < imports.length; index++) {
    const { s: start, e: end, d: dynamicIndex } = imports[index]
    const rawUrl = source.slice(start, end)

    if (rawUrl === 'import.meta') {
      const prop = source.slice(end, end + 4)
      if (prop === '.url') {
        // Rewrite import.meta.url → servable module URL (upstream importAnalysis
        // does this via importMetaUrlRE). Blob-served modules would otherwise
        // expose a blob: URL the runtime can't re-import for Fast Refresh.
        const importMetaUrl = `${base}${stripBase(
          normalizeHmrUrl(importerModule.url),
          base,
        ).replace(/^\//, '')}`
        // `end` is the index after "import.meta"; ".url" is 4 chars.
        str().overwrite(start, end + 4, JSON.stringify(importMetaUrl), {
          contentOnly: true,
        })
        continue
      }
      if (prop === '.hot') {
        hasHMR = true
        const endHot = end + 4 + (source[end + 4] === '?' ? 1 : 0)
        if (source.slice(endHot, endHot + 7) === '.accept') {
          if (source.slice(endHot, endHot + 14) === '.acceptExports') {
            const set = (orderedAcceptedExports.set(index, new Set()).get(index))!
            lexAcceptedHmrExports(source, source.indexOf('(', endHot + 14) + 1, set)
            isPartiallySelfAccepting = true
          } else {
            const set = (orderedAcceptedUrls.set(index, new Set()).get(index))!
            if (lexAcceptedHmrDeps(source, source.indexOf('(', endHot + 7) + 1, set)) {
              isSelfAccepting = true
            }
          }
        }
      }
      continue
    }

    const specifier = imports[index].n
    if (specifier === undefined) continue
    if (/^(?:https?|data):/.test(specifier)) continue

    const isDynamicImport = dynamicIndex > -1
    if (!isDynamicImport && enablePartialAccept && importedBindings) {
      extractImportedBindings(specifier, source, imports[index], importedBindings)
    }

    const normalized = await normalizeUrl(specifier, start)
    importedUrls.add(stripBase(normalized, base))
    if (!isDynamicImport && isJSRequest(normalized)) {
      staticImportedUrls.add(stripBase(normalized, base))
    }
    if (normalized !== specifier) {
      // Upstream overwrites the surrounding quotes too (start-1 / end+1) with
      // the already-quoted JSON string; dynamic imports keep the paren form.
      const sPos = isDynamicImport ? start : start - 1
      const ePos = isDynamicImport ? end : end + 1
      str().overwrite(sPos, ePos, JSON.stringify(normalized), { contentOnly: true })
    }
  }

  // collect accepted urls
  for (const set of orderedAcceptedUrls.values()) {
    for (const u of set) acceptedUrls.add(u)
  }
  for (const set of orderedAcceptedExports.values()) {
    for (const e of set) acceptedExports.add(e)
  }

  // inject hot context
  if (hasHMR) {
    str().prepend(
      `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
        `import.meta.hot = __vite__createHotContext(${JSON.stringify(
          normalizeHmrUrl(importerModule.url),
        )});`,
    )
  }

  // normalize accepted urls
  const normalizedAcceptedUrls = new Set<string>()
  for (const { url, start, end } of acceptedUrls) {
    const normalized = await normalizeUrl(url, start)
    normalizedAcceptedUrls.add(normalized)
    str().overwrite(start, end, JSON.stringify(normalizeHmrUrl(normalized)), {
      contentOnly: true,
    })
  }

  if (!isCSSRequest(importer) || /[?&](raw|url)\b/.test(importer)) {
    if (
      !isSelfAccepting &&
      isPartiallySelfAccepting &&
      acceptedExports.size >= exports.length &&
      exports.every((e) => acceptedExports.has(e.n))
    ) {
      isSelfAccepting = true
    }
    const pruned = moduleGraph.updateModuleInfo(
      importerModule,
      importedUrls,
      importedBindings,
      normalizedAcceptedUrls,
      isPartiallySelfAccepting ? acceptedExports : null,
      isSelfAccepting,
      staticImportedUrls,
    )
    if (pruned) handlePrunedModules(pruned, environment)
  }

  return s ? { code: s.toString(), map: s.generateMap({ hires: 'boundary' }) } : { code: source, map: null }
}

function injectTimestamp(url: string, ts: number): string {
  return url.includes('?') ? `${url}&t=${ts}` : `${url}?t=${ts}`
}
