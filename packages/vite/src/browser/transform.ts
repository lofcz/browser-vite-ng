/**
 * Browser transforms — full-fidelity analogue of Vite 8's Oxc + CSS dev
 * transforms, using the Oxc WASM binding instead of the native rolldown one.
 *
 * Oxc options are aligned with upstream `getModifiedOxcTransformOptions` /
 * `transformWithOxc` (src/node/plugins/oxc.ts). TypeScript `declaration` is NOT
 * set (upstream dev never emits declarations, which is what triggered TS9007
 * under --isolatedDeclarations).
 */

import { ensureSourcesContent, type RawSourceMap } from './sourcemap'

export interface BrowserTransformOptions {
  lang?: 'js' | 'jsx' | 'ts' | 'tsx' | 'dts'
  jsx?:
    | 'preserve'
    | {
        runtime?: 'classic' | 'automatic'
        importSource?: string
        pragma?: string
        pragmaFrag?: string
        development?: boolean
        refresh?: boolean
      }
  /** Upstream only sets `onlyRemoveTypeImports` / `rewrites`; declaration is left unset. */
  typescript?: {
    onlyRemoveTypeImports?: boolean
  }
  sourcemap?: boolean
  define?: Record<string, string>
}

export interface BrowserTransformResult {
  code: string
  map: RawSourceMap | null
  warnings?: string[]
}

/** Oxc's `ErrorLabel` — byte offsets into the ORIGINAL source. */
interface OxcErrorLabel {
  message?: string | null
  start: number
  end: number
}

interface OxcError {
  severity?: string
  message: string
  labels?: OxcErrorLabel[]
  helpMessage?: string | null
  codeframe?: string | null
}

type OxcWasmTransformSync = (
  filename: string,
  code: string,
  options?: Record<string, unknown>,
) => {
  code: string
  map?: object | null
  errors?: OxcError[]
}

/**
 * A transform failure carrying everything the error overlay needs to point at
 * real source: `loc` (file + 1-based line / 0-based column, like Rollup and
 * Vite's own plugin errors) and a `frame` code excerpt.
 */
export interface TransformErrorLocation {
  file: string
  line: number
  column: number
}

export class BrowserTransformError extends Error {
  readonly id: string
  readonly loc?: TransformErrorLocation
  readonly frame?: string
  readonly plugin = 'vite:oxc'

  constructor(
    message: string,
    id: string,
    loc?: TransformErrorLocation,
    frame?: string,
  ) {
    super(message)
    this.name = 'BrowserTransformError'
    this.id = id
    this.loc = loc
    this.frame = frame
  }
}

/** Byte/char offset → 1-based line, 0-based column. */
function offsetToLineColumn(
  code: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, code.length))
  let line = 1
  let lineStart = 0
  for (let i = 0; i < clamped; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: clamped - lineStart }
}

/**
 * Rollup-style code frame (` 12 |  <div>` + a caret line). Oxc ships its own
 * `codeframe`, but it is ANSI-coloured and references the file by the name we
 * passed, so we render our own for the overlay.
 */
export function generateCodeFrame(
  source: string,
  line: number,
  column: number,
  context = 2,
): string {
  const lines = source.split('\n')
  const start = Math.max(1, line - context)
  const end = Math.min(lines.length, line + context)
  const gutter = String(end).length
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1] ?? ''
    out.push(`${String(n).padStart(gutter, ' ')} |  ${text}`)
    if (n === line) {
      out.push(`${' '.repeat(gutter)} |  ${' '.repeat(Math.max(0, column))}^`)
    }
  }
  return out.join('\n')
}

/**
 * Turn Oxc's error list into one error that names the file and position.
 * Oxc recovers from many syntax errors and still returns code, so upstream also
 * treats a non-empty `errors` array as fatal in dev.
 */
function toTransformError(
  errors: OxcError[],
  code: string,
  filename: string,
): BrowserTransformError {
  const primary = errors[0]
  const label = primary.labels?.find((l) => typeof l.start === 'number')
  const loc = label
    ? {
        file: filename.replace(/[?#].*$/, ''),
        ...offsetToLineColumn(code, label.start),
      }
    : undefined
  const details = errors
    .map((e) =>
      [e.message, e.helpMessage ? `help: ${e.helpMessage}` : '']
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n')
  const where = loc ? ` (${loc.file}:${loc.line}:${loc.column + 1})` : ''
  return new BrowserTransformError(
    `${details || '[browser-vite] Oxc transform failed'}${where}`,
    filename,
    loc,
    loc ? generateCodeFrame(code, loc.line, loc.column) : undefined,
  )
}

let oxcTransformSync: OxcWasmTransformSync | null = null

async function loadOxc(): Promise<OxcWasmTransformSync> {
  if (oxcTransformSync) return oxcTransformSync
  // Static import of the browser (WASM) build so the host bundler resolves and
  // bundles it — no bare runtime specifier the browser can't resolve.
  const mod = (await import('oxc-transform/browser.js')) as {
    transformSync?: OxcWasmTransformSync
    default?: { transformSync?: OxcWasmTransformSync }
  }
  oxcTransformSync = (mod.transformSync ??
    mod.default?.transformSync) as OxcWasmTransformSync
  if (!oxcTransformSync) {
    throw new Error(
      '[browser-vite] Failed to load @oxc-transform/binding-wasm32-wasi (transformSync)',
    )
  }
  return oxcTransformSync
}

function inferLang(
  filename: string,
  explicit?: BrowserTransformOptions['lang'],
): NonNullable<BrowserTransformOptions['lang']> {
  if (explicit) return explicit
  const base = filename.split(/[?#]/)[0]
  if (/\.tsx$/.test(base)) return 'tsx'
  if (/\.[cm]?ts$/.test(base)) return 'ts'
  if (/\.jsx$/.test(base)) return 'jsx'
  return 'js'
}

/**
 * Transform JS/TS/JSX/TSX with Oxc WASM — browser analogue of upstream
 * `transformWithOxc` + `getModifiedOxcTransformOptions` for the dev client.
 */
export async function transformWithOxc(
  code: string,
  filename: string,
  options: BrowserTransformOptions = {},
): Promise<BrowserTransformResult> {
  const transformSync = await loadOxc()
  const lang = inferLang(filename, options.lang)

  // Upstream dev: sourcemap always on, declaration unset, jsx default automatic.
  const oxcOptions: Record<string, unknown> = {
    sourcemap: options.sourcemap ?? true,
    lang,
  }

  if (lang === 'ts' || lang === 'tsx' || lang === 'dts') {
    oxcOptions.typescript = {
      onlyRemoveTypeImports: options.typescript?.onlyRemoveTypeImports ?? false,
    }
  }

  if (lang === 'tsx' || lang === 'jsx') {
    oxcOptions.jsx =
      options.jsx ??
      ({ runtime: 'automatic', importSource: 'react' } as const)
  } else if (options.jsx) {
    oxcOptions.jsx = options.jsx
  }

  if (options.define) {
    oxcOptions.define = options.define
  }

  const result = transformSync(filename, code, oxcOptions)

  if (result.errors?.length) {
    throw toTransformError(result.errors, code, filename)
  }

  // Oxc names the single source after the filename it was handed but omits the
  // content; inline it so the preview (which has no HTTP origin able to serve
  // `/src/App.tsx`) can still show original source in DevTools and code frames.
  const map = ensureSourcesContent(
    (result.map ?? null) as RawSourceMap | null,
    filename,
    code,
  )

  return { code: result.code, map }
}

/**
 * CSS dev transform — byte-for-byte analogue of upstream vite:css-post serve
 * path (src/node/plugins/css.ts). The generated module imports updateStyle /
 * removeStyle from the client public path, applies the style, self-accepts
 * (plain CSS) or exports CSS-module locals, and prunes on removal.
 */
export function transformCssDev(
  css: string,
  id: string,
  clientPublicPath: string,
  cssModules?: Record<string, string> | null,
): BrowserTransformResult {
  const modulesCode = cssModules
    ? `export default ${JSON.stringify(cssModules)}`
    : 'import.meta.hot.accept()'
  const code = [
    `import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from ${JSON.stringify(
      clientPublicPath,
    )}`,
    `const __vite__id = ${JSON.stringify(id)}`,
    `const __vite__css = ${JSON.stringify(css)}`,
    `__vite__updateStyle(__vite__id, __vite__css)`,
    modulesCode,
    `import.meta.hot.prune(() => __vite__removeStyle(__vite__id))`,
  ].join('\n')
  // The dev CSS module is generated code, not a transform of the stylesheet —
  // there is nothing to map back to (upstream returns an empty map here too).
  return { code, map: null }
}
