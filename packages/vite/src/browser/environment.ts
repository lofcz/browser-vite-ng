/**
 * Minimal Environment API surface for browser-vite (Vite 8-aligned naming).
 * Full Vite 8 DevEnvironment depends on Node server + Rolldown; browser keeps
 * a thin stand-in so plugins/docs can talk about environments.
 */

export const BROWSER_ENVIRONMENT_NAME = 'client'

export type EnvironmentMode = 'dev' | 'build' | 'scan'

export interface EnvironmentOptions {
  name?: string
  mode?: EnvironmentMode
}

export interface EnvironmentMeta {
  name: string
  mode: EnvironmentMode
}

export interface DevEnvironment {
  name: string
  mode: EnvironmentMode
  config: Record<string, unknown>
}

export function createBrowserEnvironment(
  options: EnvironmentOptions = {},
): DevEnvironment {
  return {
    name: options.name ?? BROWSER_ENVIRONMENT_NAME,
    mode: options.mode ?? 'dev',
    config: {},
  }
}

export function getDefaultBrowserEnvironment(): DevEnvironment {
  return createBrowserEnvironment()
}

export function shouldApplyPlugin(
  plugin: { applyToEnvironment?: (env: DevEnvironment) => boolean | void },
  environment: DevEnvironment,
): boolean {
  if (typeof plugin.applyToEnvironment === 'function') {
    return plugin.applyToEnvironment(environment) !== false
  }
  return true
}

export function filterPluginsForEnvironment<
  T extends { applyToEnvironment?: (env: DevEnvironment) => boolean | void },
>(plugins: T[], environment: DevEnvironment): T[] {
  return plugins.filter((p) => shouldApplyPlugin(p, environment))
}
