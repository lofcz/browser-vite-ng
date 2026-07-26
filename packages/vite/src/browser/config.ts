/**
 * Browser resolveConfig — no config-file FS discovery.
 * Intentionally small so upstream Vite config churn rarely breaks the browser entry.
 */

export type BrowserCommand = 'build' | 'serve'

export interface BrowserInlineConfig {
  root?: string
  base?: string
  mode?: string
  plugins?: BrowserPlugin[]
  define?: Record<string, string>
  oxc?: {
    jsx?: unknown
    include?: string | RegExp | Array<string | RegExp>
    exclude?: string | RegExp | Array<string | RegExp>
  }
  [key: string]: unknown
}

export interface BrowserPlugin {
  name: string
  enforce?: 'pre' | 'post'
  apply?:
    | 'build'
    | 'serve'
    | ((
        config: BrowserInlineConfig,
        env: { mode: string; command: BrowserCommand },
      ) => boolean)
  config?: (
    config: BrowserInlineConfig,
    env: { mode: string; command: BrowserCommand },
  ) => BrowserInlineConfig | void | Promise<BrowserInlineConfig | void>
  transform?: (
    code: string,
    id: string,
  ) =>
    | { code: string; map?: object | null }
    | null
    | undefined
    | Promise<{ code: string; map?: object | null } | null | undefined>
  resolveId?: (
    id: string,
    importer?: string,
  ) =>
    | string
    | { id: string; external?: boolean }
    | null
    | undefined
    | Promise<string | { id: string; external?: boolean } | null | undefined>
}

export interface BrowserResolvedConfig extends BrowserInlineConfig {
  root: string
  base: string
  mode: string
  command: BrowserCommand
  isProduction: boolean
  plugins: BrowserPlugin[]
  logger: {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
}

export async function resolveConfig(
  inlineConfig: BrowserInlineConfig = {},
  command: BrowserCommand = 'serve',
  defaultMode = 'development',
): Promise<BrowserResolvedConfig> {
  let config: BrowserInlineConfig = { ...inlineConfig }
  const mode = config.mode ?? defaultMode
  const configEnv = { mode, command }

  const rawPlugins = (config.plugins ?? []).filter((p): p is BrowserPlugin => {
    if (!p) return false
    if (!p.apply) return true
    if (typeof p.apply === 'function') {
      return p.apply({ ...config, mode }, configEnv)
    }
    return p.apply === command
  })

  for (const p of rawPlugins) {
    if (p.config) {
      const res = await p.config(config, configEnv)
      if (res) config = { ...config, ...res }
    }
  }

  const root = config.root ?? '/'
  const base = config.base ?? '/'

  return {
    ...config,
    root,
    base,
    mode,
    command,
    isProduction: false,
    plugins: rawPlugins,
    logger: {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    },
  }
}
