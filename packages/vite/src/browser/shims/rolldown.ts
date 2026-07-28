/**
 * `rolldown` browser stub (ESM).
 *
 * Rolldown is Vite's native Rust bundler — it CANNOT run in a browser. The
 * browser-vite fork never bundles: dev transforms go through Oxc WASM and
 * dep-optimization is a custom in-VFS pipeline. But several fork Node modules
 * (`config.ts`, `build.ts`, …) STATICALLY import the rolldown runtime, so the
 * bare specifier must resolve to *something* ESM or module evaluation fails.
 *
 * This stub satisfies those imports without loading the native binding. Every
 * function that would actually bundle throws a clear error (it is dead code in
 * the fork); constants/classes used at module scope are provided so importing
 * modules initialize cleanly. Subpath imports (`rolldown/utils`,
 * `rolldown/experimental`, `rolldown/filter`) map here too via the resolver.
 */

export const VERSION = '8.1.5-browser.1';
export const RUNTIME_MODULE_ID = 'rolldown:runtime';

function dead(name: string): never {
  throw new Error(
    `[browser-vite] rolldown.${name}() is unavailable in the browser fork. ` +
      `Bundling runs natively (Rolldown/Rust); the browser fork transforms via Oxc WASM.`,
  );
}

export function rolldown(): never {
  return dead('rolldown');
}
export function build(): never {
  return dead('build');
}
export function watch(): never {
  return dead('watch');
}
export function defineConfig<T>(config: T): T {
  // Pure identity — safe to call in the fork.
  return config;
}

export class RolldownMagicString {
  private _s: string;
  constructor(s: string) {
    this._s = s;
  }
  toString() {
    return this._s;
  }
}

// rolldown/experimental
export function dev(): never {
  return dead('dev');
}
export function parseAst(): never {
  return dead('parseAst');
}
export function parseAstAsync(): Promise<never> {
  return Promise.resolve(dead('parseAstAsync'));
}
export function moduleRunnerTransform(): never {
  return dead('moduleRunnerTransform');
}
export const DevEngine = class {};
export const ResolverFactory = class {};
export const BindingRebuildStrategy = {};

// rolldown/experimental — native Vite plugin factories. In the browser fork
// these are replaced by browser plugin ports, so they're never instantiated;
// the factories exist only so static imports resolve. Return inert objects.
const inertPlugin = (name: string) => () => ({ name: `stub:${name}` });
export const viteTransformPlugin = inertPlugin('viteTransform');
export const viteAliasPlugin = inertPlugin('viteAlias');
export const viteJsonPlugin = inertPlugin('viteJson');
export const oxcRuntimePlugin = inertPlugin('oxcRuntime');
export const viteReactRefreshWrapperPlugin = inertPlugin('viteReactRefreshWrapper');
export const viteModulePreloadPolyfillPlugin = inertPlugin('viteModulePreloadPolyfill');
export const viteImportGlobPlugin = inertPlugin('viteImportGlob');
export const viteManifestPlugin = inertPlugin('viteManifest');
export const viteWebWorkerPostPlugin = inertPlugin('viteWebWorkerPost');
export const viteLoadFallbackPlugin = inertPlugin('viteLoadFallback');
export const viteResolvePlugin = inertPlugin('viteResolve');
export const viteReporterPlugin = inertPlugin('viteReporter');
export const viteBuildImportAnalysisPlugin = inertPlugin('viteBuildImportAnalysis');
export const viteDynamicImportVarsPlugin = inertPlugin('viteDynamicImportVars');
export const dynamicImportVarsPlugin = viteDynamicImportVarsPlugin;
export const importGlobPlugin = viteImportGlobPlugin;
export function resolveTsconfig(): never {
  return dead('resolveTsconfig');
}
export function scan(): Promise<never> {
  return Promise.resolve(dead('scan'));
}
export function isolatedDeclaration(): never {
  return dead('isolatedDeclaration');
}
export function isolatedDeclarationSync(): never {
  return dead('isolatedDeclarationSync');
}
export const isolatedDeclarationPlugin = inertPlugin('isolatedDeclaration');
export const bundleAnalyzerPlugin = inertPlugin('bundleAnalyzer');
export function defineParallelPlugin(x: unknown): unknown {
  return x;
}
export function esmExternalRequirePlugin(): never {
  return dead('esmExternalRequirePlugin');
}
export function freeExternalMemory(): void {}
export function memfs(): never {
  return dead('memfs');
}

// rolldown/utils
export function transformSync(): never {
  return dead('transformSync');
}
export function transform(): Promise<never> {
  return Promise.resolve(dead('transform'));
}
export function minify(): Promise<never> {
  return Promise.resolve(dead('minify'));
}
export function minifySync(): never {
  return dead('minifySync');
}
export function parse(): Promise<never> {
  return Promise.resolve(dead('parse'));
}
export function parseSync(): never {
  return dead('parseSync');
}
export const TsconfigCache = class {};
export const Visitor = class {};

// rolldown/filter
export function exactRegex(s: string): RegExp {
  return new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}
export function prefixRegex(s: string): RegExp {
  return new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}
export function includeRegex(re: RegExp): RegExp {
  return re;
}
export function excludeRegex(re: RegExp): RegExp {
  return re;
}
/** Attach a filter to a plugin hook (rolldown/filter). Pass-through in fork. */
export function withFilter<T>(fn: T, _filter?: unknown): T {
  return fn;
}
/** Convert a hook filter — pass-through in fork. */
export function bindingifyHookFilter(filter?: unknown): unknown {
  return filter;
}
/** Build id filters that match with query — pass-through in fork. */
export function makeIdFiltersToMatchWithQuery(filters?: unknown): unknown {
  return filters;
}
export function filterVitePlugins(plugins?: unknown): unknown {
  return plugins;
}
export const and = (...args: unknown[]) => args;
export const or = (...args: unknown[]) => args;
export const not = (arg: unknown) => arg;
export const id = (f: unknown) => f;
export const code = (f: unknown) => f;
export const importerId = (f: unknown) => f;
export const moduleType = (f: unknown) => f;
export const include = (f: unknown) => f;
export const exclude = (f: unknown) => f;
export const query = (f: unknown) => f;
export const queries = (f: unknown) => f;
export const exprInterpreter = () => ({ eval: () => true });
export const interpreter = () => ({ eval: () => true });
export const interpreterImpl = () => ({ eval: () => true });

export default {
  VERSION,
  rolldown,
  build,
  watch,
  defineConfig,
  RolldownMagicString,
};
