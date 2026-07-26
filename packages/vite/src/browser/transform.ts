/**
 * Browser transforms — full-fidelity analogue of Vite 8's Oxc + CSS dev
 * transforms, using the Oxc WASM binding instead of the native rolldown one.
 *
 * Oxc options are aligned with upstream `getModifiedOxcTransformOptions` /
 * `transformWithOxc` (src/node/plugins/oxc.ts). TypeScript `declaration` is NOT
 * set (upstream dev never emits declarations, which is what triggered TS9007
 * under --isolatedDeclarations).
 */

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
  map: object | null
  warnings?: string[]
}

type OxcWasmTransformSync = (
  filename: string,
  code: string,
  options?: Record<string, unknown>,
) => {
  code: string
  map?: object | null
  errors?: Array<{ message: string }>
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
    throw new Error(
      result.errors.map((e) => e.message).join('\n') ||
        '[browser-vite] Oxc transform failed',
    )
  }

  return { code: result.code, map: result.map ?? null }
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
  return { code, map: { mappings: '' } }
}
