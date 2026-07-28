/**
 * Browser sourcemap utilities — the analogue of Vite's
 * `src/node/server/sourcemap.ts` + `combineSourcemaps` from `src/node/utils.ts`,
 * with the Node-only parts removed.
 *
 * Differences from upstream, all forced by the browser environment:
 * - No `escapeToLinuxLikePath` round-trip: VFS ids are already POSIX
 *   (`/src/App.tsx`), so the Windows-drive-letter hack upstream needs to keep
 *   `remapping`'s URL parsing happy can't apply here.
 * - No `fs` fallback for `sourcesContent`: sources are read from the VFS.
 * - Base64 encoding goes through TextEncoder, because `btoa` throws on the
 *   non-Latin1 characters that routinely appear in real source files.
 */

import remapping from '@jridgewell/remapping'
import { readVirtualFile } from './vfs'

/** Minimal raw-sourcemap shape (matches oxc + magic-string output). */
export interface RawSourceMap {
  version?: number
  file?: string
  sources: (string | null)[]
  sourcesContent?: (string | null)[]
  names?: string[]
  mappings: string
  sourceRoot?: string
  /** DevTools "ignore list" — frames from these sources are hidden by default. */
  x_google_ignoreList?: number[]
}

const nullSourceMap: RawSourceMap = {
  names: [],
  sources: [],
  mappings: '',
  version: 3,
}

function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, '')
}

/**
 * Chain a list of sourcemaps into one map from the FINAL generated code back to
 * the original source. `sourcemapList` is ordered newest-first (the same order
 * upstream's `combineSourcemaps` expects), e.g.
 * `[importAnalysisMap, pluginMap, oxcMap]`.
 */
export function combineSourcemaps(
  filename: string,
  sourcemapList: Array<RawSourceMap>,
): RawSourceMap {
  const list = sourcemapList.filter(
    (m) => m && m.mappings !== '' && m.sources.length > 0,
  )
  if (list.length === 0) return { ...nullSourceMap }
  if (list.length === 1) return { ...list[0], file: filename }

  let mapIndex = 1
  const useArrayInterface =
    list.slice(0, -1).find((m) => m.sources.length !== 1) === undefined

  const map = useArrayInterface
    ? remapping(list as never, () => null)
    : remapping(list[0] as never, (sourcefile) =>
        sourcefile === filename && list[mapIndex]
          ? (list[mapIndex++] as never)
          : null,
      )

  const combined = map as unknown as RawSourceMap
  combined.file = filename
  return combined
}

/**
 * Fill in `sourcesContent` from the VFS for any source that lacks it, and
 * normalize `sources` to root-absolute VFS paths.
 *
 * DevTools and our own stack remapper both key off `sources`; without inlined
 * content the preview would show "could not load content for /src/App.tsx",
 * since there is no HTTP origin that can serve the virtual file.
 */
export function ensureSourcesContent(
  map: RawSourceMap | null,
  fallbackId: string,
  fallbackContent?: string,
): RawSourceMap | null {
  if (!map) return null
  const sources = map.sources.map((s) => normalizeSourcePath(s, fallbackId))
  const content = map.sourcesContent ? [...map.sourcesContent] : []
  for (let i = 0; i < sources.length; i++) {
    if (typeof content[i] === 'string') continue
    const source = sources[i]
    content[i] =
      (source ? readVirtualFile(cleanUrl(source)) : undefined) ??
      (i === 0 ? (fallbackContent ?? null) : null)
  }
  map.sources = sources
  map.sourcesContent = content
  return map
}

/**
 * Oxc reports `sources` as the filename it was handed, which for us is already
 * the resolved VFS id — but magic-string and plugin maps can emit a bare
 * relative name. Normalize everything to a root-absolute VFS path so the editor
 * can match a mapped frame to an open file.
 */
function normalizeSourcePath(
  source: string | null,
  fallbackId: string,
): string | null {
  if (!source) return cleanUrl(fallbackId)
  if (/^(?:[a-z]+:)?\/\//i.test(source)) return source
  const clean = cleanUrl(source)
  return clean.startsWith('/') ? clean : `/${clean}`
}

/**
 * Upstream `applySourcemapIgnoreList` with Vite's default predicate: hide
 * dependency frames behind DevTools' "ignore listed" filter so a stack trace
 * opens on user code instead of inside React.
 */
export function applySourcemapIgnoreList(map: RawSourceMap): RawSourceMap {
  const ignoreList: number[] = []
  map.sources.forEach((source, index) => {
    if (source && (source.includes('/node_modules/') || source.startsWith('/@deps/'))) {
      ignoreList.push(index)
    }
  })
  if (ignoreList.length) map.x_google_ignoreList = ignoreList
  return map
}

/** UTF-8 safe base64 (btoa alone throws on any code point > 0xff). */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  // Chunked to stay well under the argument-count limit for large maps.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** `//# sourceMappingURL=data:...` payload — upstream `genSourceMapUrl`. */
export function genSourceMapUrl(map: RawSourceMap | string): string {
  const json = typeof map === 'string' ? map : JSON.stringify(map)
  return `data:application/json;base64,${toBase64(json)}`
}

/**
 * Append the sourcemap comment to a module — upstream `getCodeWithSourcemap`,
 * minus the CSS branch's `/*# *​/` form (browser CSS goes through
 * `transformCssDev`, which has no meaningful map).
 */
export function getCodeWithSourcemap(
  code: string,
  map: RawSourceMap | null,
): string {
  if (!map || !map.mappings) return code
  const suffix = code.endsWith('\n') ? '' : '\n'
  return `${code}${suffix}//# sourceMappingURL=${genSourceMapUrl(map)}\n`
}
