/**
 * Browser dependency optimizer — the analogue of Vite's `optimizeDeps`.
 *
 * Bundles the packages installed into the VFS (`/node_modules/<pkg>`) into
 * browser-ready ESM under `/node_modules/.deps/`, using esbuild-wasm with
 * code-splitting so that all entries (react, react/jsx-runtime,
 * react-dom/client, ...) share ONE copy of each library via a common chunk —
 * the single-instance guarantee Fast Refresh relies on.
 *
 * File IO goes through a VFS-backed esbuild plugin (`onResolve`/`onLoad`) so
 * esbuild never touches a real filesystem.
 */

import * as esbuild from 'esbuild-wasm';
import { parse as parseCjs, init as initCjsLexer } from 'cjs-module-lexer';
import { init as initEsmLexer, parse as parseEsm } from 'es-module-lexer';
import { readVirtualFile, setVirtualFile, listVirtualFiles, withVirtualFileBatch } from 'browser-vite';
import { NODE_BUILTINS as NODE_BUILTINS_LIST } from 'virtual:node-builtins';
import type { InstallLogger } from './installer';

let initPromise: Promise<void> | null = null;

export function initEsbuild(): Promise<void> {
  if (!initPromise) {
    // cjs-module-lexer + es-module-lexer are WASM-based and must be initialized
    // before parse() can run.
    // public/esbuild.wasm is copied to the build root; resolve it relative to
    // the configured base so the deploy works under a subpath (GitHub Pages).
    const wasmURL = `${import.meta.env.BASE_URL}esbuild.wasm`;
    initPromise = Promise.all([
      esbuild.initialize({ wasmURL, worker: true }),
      initCjsLexer(),
      initEsmLexer,
    ]).then(() => undefined);
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Package entry resolution (exports / browser / module / main)
// ---------------------------------------------------------------------------

interface PkgJson {
  name?: string;
  module?: string;
  main?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  dependencies?: Record<string, string>;
}

// Memoize package.json reads and resolution results: the esbuild resolver
// calls onResolve once per module across the worker boundary, and re-parsing
// the same package.json / re-probing the same paths each time is pure CPU
// waste on the host thread. Caches are per-process and safe because the VFS
// node_modules are rewritten wholesale on install (which reloads the page).
const pkgJsonCache = new Map<string, PkgJson | null>();
const resolveCache = new Map<string, string | null>();

function readPkgJson(pkgDir: string): PkgJson | null {
  if (pkgJsonCache.has(pkgDir)) return pkgJsonCache.get(pkgDir)!;
  const raw = readVirtualFile(`${pkgDir}/package.json`);
  let parsed: PkgJson | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as PkgJson;
    } catch {
      parsed = null;
    }
  }
  pkgJsonCache.set(pkgDir, parsed);
  return parsed;
}

function fileExists(p: string): boolean {
  return readVirtualFile(p) !== undefined;
}

/** Resolve a subpath export target from a package.json `exports` field. */
function resolveExportsField(exportsField: unknown, subpath: string): string | null {
  if (exportsField == null) return null;
  const key = subpath === '.' ? '.' : `./${subpath}`;
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const cond of ['browser', 'import', 'module', 'default', 'require', 'node']) {
        if (cond in o) {
          const r = pick(o[cond]);
          if (r) return r;
        }
      }
    }
    return null;
  };
  if (typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const o = exportsField as Record<string, unknown>;
    if (key in o) return pick(o[key]);
    // No subpath keys → root conditions object.
    if (!Object.keys(o).some((k) => k.startsWith('.'))) return pick(o);
  }
  return null;
}

/** Resolve the entry file (VFS path) for `<pkgDir>/<subpath>`. */
function resolvePackageEntry(pkgDir: string, subpath: string): string | null {
  const pkg = readPkgJson(pkgDir);
  if (pkg) {
    const exp = resolveExportsField(pkg.exports, subpath);
    if (exp) {
      const p = normalizePath(`${pkgDir}/${exp}`);
      if (fileExists(p)) return p;
    }
  }
  if (subpath === '.') {
    const candidates = [
      typeof pkg?.module === 'string' ? pkg.module : null,
      typeof pkg?.main === 'string' ? pkg.main : null,
      'index.js',
      'index.mjs',
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      const p = normalizePath(`${pkgDir}/${c}`);
      if (fileExists(p)) return p;
    }
    return null;
  }
  // Subpath without exports: try the file directly.
  return resolveAsFileOrDir(`${pkgDir}/${subpath}`);
}

function resolveAsFileOrDir(base: string): string | null {
  const b = normalizePath(base);
  if (resolveCache.has(b)) return resolveCache.get(b)!;
  let result: string | null = null;
  if (fileExists(b)) result = b;
  else {
    for (const ext of ['.js', '.mjs', '.cjs', '.json']) {
      if (fileExists(b + ext)) { result = b + ext; break; }
    }
    if (!result) {
      for (const idx of ['/index.js', '/index.mjs', '/index.cjs']) {
        if (fileExists(b + idx)) { result = b + idx; break; }
      }
    }
  }
  resolveCache.set(b, result);
  return result;
}

function normalizePath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

/** Split a bare specifier into package name + subpath (handles @scope). */
function splitSpecifier(spec: string): { pkg: string; subpath: string } {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return { pkg: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') || '.' };
  }
  return { pkg: parts[0], subpath: parts.slice(1).join('/') || '.' };
}

// ---------------------------------------------------------------------------
// esbuild VFS plugin
// ---------------------------------------------------------------------------

function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (/\.[cm]?tsx?$/.test(path)) return path.endsWith('x') ? 'tsx' : 'ts';
  if (path.endsWith('.jsx')) return 'jsx';
  return 'js';
}

const VFS_NS = 'vfs';

// Node builtins have no browser meaning in optimized deps — they are stubbed
// with an empty module so packages referencing them (e.g. loose-envify) still
// bundle. The authoritative list is generated at config time from
// `node:module`.builtinModules (see nodeBuiltinsPlugin in vite.config.ts), so
// it always matches the real set incl. public subpath exports (fs/promises…).
const NODE_BUILTINS = new Set(NODE_BUILTINS_LIST);

function vfsPlugin(onPackage?: (pkg: string) => void): esbuild.Plugin {
  return {
    name: 'vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Entry points arrive as their VFS path already.
        if (args.kind === 'entry-point') {
          return { path: normalizePath(args.path), namespace: VFS_NS };
        }
        const spec = args.path;
        // Report the package being resolved for progress display (bare
        // specifiers name the package; relative paths inherit the importer's).
        if (onPackage) {
          if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) {
            onPackage(splitSpecifier(spec).pkg);
          } else {
            const m = args.importer.match(/^\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
            if (m) onPackage(m[1]);
          }
        }
        if (NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.replace(/^node:/, ''))) {
          // Stub Node builtins with an empty module so browser bundles don't
          // try to import an unresolvable specifier.
          return { path: spec, namespace: 'node-builtin' };
        }
        // Relative / absolute within the VFS.
        if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
          const importerDir = args.importer
            ? args.importer.split('/').slice(0, -1).join('/')
            : '/';
          const base = spec.startsWith('/') ? spec : `${importerDir}/${spec}`;
          const resolved = resolveAsFileOrDir(base);
          if (resolved) return { path: resolved, namespace: VFS_NS };
          return { path: normalizePath(base), namespace: VFS_NS, external: false };
        }
        // Bare specifier → resolve into installed /node_modules.
        const { pkg, subpath } = splitSpecifier(spec);
        const pkgDir = `/node_modules/${pkg}`;
        const entry = resolvePackageEntry(pkgDir, subpath);
        if (entry) return { path: entry, namespace: VFS_NS };
        throw new Error(`[dep-bundler] Cannot resolve ${spec} (imported by ${args.importer})`);
      });

      build.onLoad({ filter: /.*/, namespace: 'node-builtin' }, () => ({
        contents: 'export default {}; export {};',
        loader: 'js',
      }));

      build.onLoad({ filter: /.*/, namespace: VFS_NS }, (args) => {
        const contents = readVirtualFile(args.path);
        if (contents === undefined) {
          throw new Error(`[dep-bundler] Not in VFS: ${args.path}`);
        }
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Public: bundle installed deps -> /node_modules/.deps/* + manifest
// ---------------------------------------------------------------------------

/** Well-known entry specifiers we always expose to the app. */
export interface DepManifest {
  /** specifier (e.g. "react", "react-dom/client") -> public /@deps URL */
  [specifier: string]: string;
}

/**
 * Turn a public specifier into a stable entry file name.
 * "react-dom/client" -> "react-dom__client"
 */
function entryName(specifier: string): string {
  return specifier.replace(/^@/, '').replace(/\//g, '__');
}

/**
 * Enumerate the named exports a CommonJS module exposes, using
 * `cjs-module-lexer` — the same production lexer Node.js uses for CJS→ESM
 * named-export detection (and Vite's dep scanner). This lets a pre-bundled
 * CJS dep be served as a standalone ESM module whose named imports
 * (`import { jsx } from "react/jsx-runtime"`) resolve — something `export *`
 * cannot do across a CJS boundary (esbuild yields default-only there).
 *
 * `cjs-module-lexer` handles all real-world CJS shapes (assignments,
 * Object.defineProperty, transpiled ESM, and `module.exports = require(...)`
 * re-export via its `reexports` list, which we recurse into).
 */
const cjsExportsCache = new Map<string, Promise<string[]>>();

/**
 * Whether an ESM module exposes a `default` export, detected with
 * `es-module-lexer` (the production lexer Vite itself uses for ESM analysis).
 *
 * `export * from` does NOT forward `default`, but a package may still surface
 * one through a re-export chain (`export { N as default } from './x.js'`, or a
 * star chain that ends in a real `export default`). We lex the entry, return
 * true immediately on an explicit `default` export, and otherwise recurse only
 * into `export *` sources (named `export {…} from` re-exports already list
 * `default` explicitly when they forward it, so they need no recursion).
 */
const esmDefaultCache = new Map<string, Promise<boolean>>();

function esmHasDefaultExport(entryVfsPath: string): Promise<boolean> {
  let cached = esmDefaultCache.get(entryVfsPath);
  if (!cached) {
    cached = esmHasDefaultExportInner(entryVfsPath, new Set());
    esmDefaultCache.set(entryVfsPath, cached);
  }
  return cached;
}

async function esmHasDefaultExportInner(vfsPath: string, seen: Set<string>): Promise<boolean> {
  if (seen.has(vfsPath)) return false; // cycle in a star chain
  seen.add(vfsPath);
  await initEsbuild();
  const src = readVirtualFile(vfsPath);
  if (src === undefined) return false;
  let imports: ReturnType<typeof parseEsm>[0];
  let exports: ReturnType<typeof parseEsm>[1];
  try {
    [imports, exports] = parseEsm(src);
  } catch {
    return false;
  }
  for (const e of exports) {
    if (e.n === 'default') return true;
  }
  // Follow `export * from '<src>'` re-exports. Distinguish star re-exports
  // from named `export {…} from` by the statement text the lexer spans.
  const dir = vfsPath.split('/').slice(0, -1).join('/');
  for (const imp of imports) {
    if (imp.n === undefined) continue;
    const stmt = src.slice(imp.ss, imp.se);
    if (!/^export\s*\*/.test(stmt.trimStart())) continue;
    const target = resolveAsFileOrDir(`${dir}/${imp.n}`);
    if (target && (await esmHasDefaultExportInner(target, seen))) return true;
  }
  return false;
}

function detectCjsExports(entryVfsPath: string): Promise<string[]> {
  let cached = cjsExportsCache.get(entryVfsPath);
  if (!cached) {
    cached = detectCjsExportsInner(entryVfsPath, 0);
    cjsExportsCache.set(entryVfsPath, cached);
  }
  return cached;
}

async function detectCjsExportsInner(entryVfsPath: string, depth: number): Promise<string[]> {
  if (depth > 4) return [];
  await initEsbuild();
  let src = readVirtualFile(entryVfsPath);
  if (src === undefined) return [];
  let exports: string[];
  let reexports: string[];
  try {
    ({ exports, reexports } = parseCjs(src));
  } catch {
    return [];
  }
  // Conditional re-export wrappers (`if (NODE_ENV==='production') module.exports
  // = require('./a') else module.exports = require('./b')`) are intentionally
  // opaque to the lexer. Fold dead branches with esbuild (honouring our
  // NODE_ENV define) so the surviving re-export becomes analyzable, then re-lex.
  if (exports.length === 0 && reexports.length === 0 && /module\.exports\s*=\s*require\(/.test(src)) {
    src = await foldToCjs(entryVfsPath);
    try {
      ({ exports, reexports } = parseCjs(src));
    } catch {
      return [];
    }
  }
  const names = new Set(exports.filter((n) => n !== 'default' && n !== '__esModule'));
  const dir = entryVfsPath.split('/').slice(0, -1).join('/');
  for (const re of reexports) {
    const target = resolveAsFileOrDir(`${dir}/${re}`);
    if (target) {
      for (const n of await detectCjsExports(target)) names.add(n);
    }
  }
  return [...names];
}

/**
 * Fold dead `process.env.NODE_ENV` branches in a single CJS source, returning
 * the collapsed source for analysis. Used to make conditional
 * `module.exports = require(...)` wrappers lexable.
 *
 * These wrappers are single self-contained files, so a full esbuild *bundle*
 * (with its VFS onResolve/onLoad worker round-trips) is unnecessary — a
 * `transform` with the NODE_ENV define folds the dead branch in-process at a
 * fraction of the cost. `minifySyntax` performs the constant folding.
 */
async function foldToCjs(entryVfsPath: string): Promise<string> {
  await initEsbuild();
  const src = readVirtualFile(entryVfsPath);
  if (src === undefined) return '';
  const result = await esbuild.transform(src, {
    loader: 'js',
    format: 'cjs',
    define: { 'process.env.NODE_ENV': '"development"' },
    minifySyntax: true,
    logLevel: 'silent',
  });
  return result.code;
}

/**
 * Entry module for a public specifier — a real ESM facade over the package.
 *
 * Two complementary re-export mechanisms make it shape-agnostic:
 *  - `export * from <spec>`: forwards all named exports of a genuine ESM
 *    package (esbuild analyzes these statically). It is a no-op for CJS,
 *    where esbuild yields default-only.
 *  - an explicit `export const { ... } = __ns` for every named export that
 *    `cjs-module-lexer` detects in a CJS package (its CJS→ESM interop
 *    populates the namespace at runtime), which `export *` cannot surface.
 * Plus `export default` (the CJS module.exports / ESM default).
 */
async function entryModule(specifier: string, entryVfsPath: string): Promise<string> {
  const spec = JSON.stringify(specifier);
  const named = await detectCjsExports(entryVfsPath);
  if (named.length > 0) {
    // CJS package: surface lexer-detected named exports via the CJS→ESM
    // namespace (`export *` yields default-only across a CJS boundary).
    return (
      `import * as __ns from ${spec};\n` +
      `export * from ${spec};\n` +
      `export const { ${named.join(', ')} } = __ns;\n` +
      `export default __ns.default !== undefined ? __ns.default : __ns;\n`
    );
  }
  // Pure-ESM package (e.g. lucide-react, @number-flow/react): avoid
  // `import * as __ns`, which materializes the whole namespace and defeats
  // tree-shaking — forcing esbuild to parse every re-exported module.
  // `export *` lets esbuild drop unused re-exports (sideEffects:false),
  // collapsing icon-barrel packages from ~1000 parsed modules to the few used.
  //
  // `export *` does NOT forward `default`, so a real default must be
  // re-exported explicitly. Importing a non-existent default is a hard error,
  // so only add it when the entry actually declares one. We detect this with
  // es-module-lexer (the production lexer Vite uses) — following `export …
  // from` re-export chains like number-flow's `export { N as default }`.
  const def = (await esmHasDefaultExport(entryVfsPath))
    ? `export { default } from ${spec};\n`
    : `export default undefined;\n`;
  return `export * from ${spec};\n${def}`;
}

export interface BundleResult {
  manifest: DepManifest;
  /** VFS path -> contents for every emitted /node_modules/.deps/* file. */
  files: Record<string, string>;
}

/**
 * Bundle the given specifiers (must be installed in the VFS) into
 * /node_modules/.deps/*.js. Returns the manifest specifier -> /@deps URL
 * plus the emitted files (so the caller can persist them in the dep cache).
 */
export async function bundleDeps(
  specifiers: string[],
  log: InstallLogger,
  progress?: (message: string) => void,
): Promise<BundleResult> {
  await initEsbuild();
  const report = progress ?? (() => {});

  // Each public specifier becomes an entry module that re-exports it. The
  // entry lives in the VFS so the resolver treats all modules uniformly.
  // Generate all entry facades concurrently — detectCjsExports may run an
  // esbuild fold per CJS entry, and overlapping those hides worker latency.
  const entryPoints = await Promise.all(
    specifiers.map(async (spec) => {
      const name = entryName(spec);
      const stubPath = `/node_modules/.deps-entry/${name}.js`;
      const { pkg, subpath } = splitSpecifier(spec);
      const resolvedEntry =
        resolvePackageEntry(`/node_modules/${pkg}`, subpath) ?? '';
      setVirtualFile(stubPath, await entryModule(spec, resolvedEntry));
      return { in: stubPath, out: name };
    }),
  );

  log(`Bundling deps: ${specifiers.join(', ')}...`);
  // Per-package progress: track which package esbuild is currently resolving.
  // onResolve already crosses the worker boundary per module, so reading a
  // shared counter here adds no extra hops — we just surface the package name.
  let currentPkg = '';
  let moduleCount = 0;
  const start = Date.now();
  const ticker = setInterval(() => {
    const where = currentPkg ? ` ${currentPkg}` : '';
    report(`bundling${where}… ${moduleCount} modules, ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }, 120);
  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      entryPoints,
      bundle: true,
      write: false,
      format: 'esm',
      splitting: true,
      treeShaking: true,
      outdir: '/node_modules/.deps',
      platform: 'browser',
      target: 'esnext',
      mainFields: ['browser', 'module', 'main'],
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        vfsPlugin((pkg) => {
          currentPkg = pkg;
          moduleCount++;
        }),
      ],
      logLevel: 'silent',
    });
  } finally {
    clearInterval(ticker);
  }

  const manifest: DepManifest = {};
  const files: Record<string, string> = {};
  for (const out of result.outputFiles ?? []) {
    // out.path is "<outdir>/<name>.js" (posix in esbuild-wasm).
    const vfsPath = normalizePath(out.path);
    files[vfsPath] = out.text;
  }
  // Write outputs to the VFS in bulk (no per-file HMR events).
  withVirtualFileBatch(() => {
    for (const [p, c] of Object.entries(files)) setVirtualFile(p, c);
  });
  for (const spec of specifiers) {
    manifest[spec] = `/@deps/${entryName(spec)}.js`;
  }
  log(
    `Bundled ${result.outputFiles?.length ?? 0} module(s) into /@deps/ in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
  return { manifest, files };
}

/**
 * Compute the public entry specifiers to bundle from the project's DIRECT
 * dependencies (from /package.json), not transitive ones. Transitive deps are
 * bundled internally as library code, not exposed as importable entries.
 */
export function defaultEntrySpecifiers(directNames: string[]): string[] {
  const specs = new Set<string>();
  for (const name of directNames) {
    specs.add(name);
    if (name === 'react') specs.add('react/jsx-runtime');
    if (name === 'react-dom') {
      specs.delete('react-dom');
      specs.add('react-dom/client');
    }
  }
  return [...specs];
}

/** List installed top-level package names currently in the VFS. */
export function listInstalledPackages(): string[] {
  const names = new Set<string>();
  for (const path of listVirtualFiles()) {
    const m = path.match(/^\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//);
    if (m && !m[1].startsWith('.')) names.add(m[1]);
  }
  return [...names];
}
