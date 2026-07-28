import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';
import { builtinModules } from 'node:module';
import { init as initLexer, parse as parseModule } from 'es-module-lexer';
import { iframeRuntimePlugin } from './vite-plugin-iframe-runtime';

/**
 * Exposes the authoritative list of Node builtin modules (from
 * `node:module`.builtinModules, evaluated at config time in Node) to the
 * browser dep-bundler, so NODE_BUILTINS can never drift from the real set.
 * Internal `_`-prefixed modules are excluded (not user-importable); both the
 * canonical name and every public subpath export (fs/promises, etc.) are kept.
 */
const EXAMPLE_NODE_MODULES = path.resolve(__dirname, 'node_modules');
// Normalized to forward slashes — importers may arrive POSIX-ified by the
// bundler even on Windows, so a raw path.resolve() prefix match would fail.
const FORK_SRC = path.resolve(__dirname, '../packages/vite/src').replace(/\\/g, '/');
const toPosix = (p: string) => p.replace(/\\/g, '/');

/**
 * Detect whether a package is CommonJS-format (no `type: 'module'` in its
 * package.json). CJS deps served raw to the browser expose `module.exports`
 * with no synthesized ESM default/named exports — Node interops this at
 * require time; esbuild pre-bundling reproduces it. We therefore collect the
 * full set of CJS packages reachable in the graph so NONE are served raw.
 *
 * `resolvePkgJson` reads a package's manifest from the example node_modules.
 */
/**
 * CJS deps that must be served RAW (excluded from pre-bundle) because they read
 * node builtins (fs.promises) at module init — pre-bundling externalizes fs to
 * the empty stub and crashes them. Served raw they're CJS with no ESM default,
 * so forkDepsPlugin wraps them (namespace-as-default). Kept in sync with the
 * optimizeDeps.exclude list below.
 */
const pkgJsonCache = new Map<string, any | null>();
function readPkgJson(pkgName: string): any | null {
  if (pkgJsonCache.has(pkgName)) return pkgJsonCache.get(pkgName);
  let found: any = null;
  try {
    const p = path.join(EXAMPLE_NODE_MODULES, pkgName, 'package.json');
    found = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    found = null;
  }
  pkgJsonCache.set(pkgName, found);
  return found;
}

/** True if a package (by name) is CommonJS-format (not `type: 'module'`). */
function isCjsPackage(pkgName: string): boolean {
  const pkg = readPkgJson(pkgName);
  return !!pkg && pkg.type !== 'module';
}

/**
 * Recursively collect every CJS package reachable from a set of root packages
 * via their declared `dependencies`. This lets `optimizeDeps.include` cover the
 * ENTIRE CJS subgraph (incl. transitive deps like js-tokens pulled in by an
 * already-bundled CJS dep) without hand-curation — pre-bundling interops each
 * exactly like Node. Pure-ESM packages are left to be served natively.
 */
function collectCjsDeps(roots: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    // Skip type-only stub packages (@types/*) — no runtime entry to bundle.
    if (name.startsWith('@types/')) continue;
    // Only include packages that actually resolve to a directory on disk —
    // optional/platform deps (fsevents) or hoisted-out packages would crash
    // the optimizer with ENOENT otherwise.
    if (!fs.existsSync(path.join(EXAMPLE_NODE_MODULES, name, 'package.json'))) continue;
    if (!isCjsPackage(name)) continue;
    out.add(name);
    const pkg = readPkgJson(name);
    const deps = pkg?.dependencies ? Object.keys(pkg.dependencies) : [];
    for (const d of deps) stack.push(d);
  }
  return [...out];
}

/**
 * The browser-vite fork is aliased to its TypeScript source under
 * ../packages/vite/src, which lives OUTSIDE this package. Bare imports made by
 * that source (es-module-lexer, magic-string, picomatch, …) are therefore
 * resolved by the bundler against the repo-root node_modules rather than this
 * example's. This plugin re-points any bare import originating from the fork
 * source at the example's own node_modules, so those deps only need to exist
 * here.
 */
/**
 * ESM default-export interop, faithful to Node's `import cjs from 'esm'` /
 * bundler `esModuleInterop` semantics: a module with only named exports gets a
 * synthesized `default` equal to its module namespace. Node's dev server
 * interops this at bundle time; raw browser ESM cannot, so we wrap the entry
 * in a virtual module that re-exports the namespace as default.
 *
 * This is GENERIC (not per-package): any fork dep named in
 * `INTEROP_DEFAULT_DEPS` is wrapped. We only list packages the fork imports
 * with a default import but which ship named-only exports (e.g. obug, where
 * `import debug from 'obug'` must yield the `createDebug` callable namespace).
 */
const INTEROP_PREFIX = '\0fork-interop:';

/**
 * True if a package needs a synthesized ESM `default`. This covers BOTH
 * interop failure modes the fork hits in raw-browser ESM:
 *  - CJS-format packages (no `type: 'module'`): `module.exports` has no ESM
 *    default/named exports at all.
 *  - Pure-ESM packages that export only NAMED bindings (no `export default`),
 *    like obug: Node/bundlers synthesize a default equal to the namespace for
 *    `import x from 'pkg'`, but native browser ESM does not — so the
 *    default-import form the fork uses breaks.
 * In both cases we wrap the entry so `default` === module namespace.
 */
/**
 * Authoritative export analysis via es-module-lexer (the same WASM lexer Vite
 * itself uses — no regex, so comments/strings/false-matches can't crash it).
 * Returns the module's real named exports. For a CJS module the lexer yields
 * only its synthetic default (or nothing), which we treat as "needs interop".
 */
const exportsCache = new Map<string, { hasDefault: boolean; named: string[] }>();

/** Lex a module file with es-module-lexer → its real export names. */
async function lexFileExports(file: string): Promise<string[]> {
  await initLexer;
  const src = fs.readFileSync(file, 'utf-8');
  const [, exports] = parseModule(src);
  return exports.map((e) => (typeof e === 'string' ? e : e.n)).filter(Boolean) as string[];
}

/**
 * Decide whether a fork-imported dep needs a synthesized-default wrapper, and
 * which named exports the wrapper must re-export.
 *
 * Cases:
 *  - Pre-bundled dep (resolved into node_modules/.vite/deps): esbuild already
 *    interoped CJS→ESM, so the chunk HAS proper named+default exports. These
 *    must NOT be wrapped (wrapping would shadow the real named exports — the
 *    dotenv-expand bug). Serve natively.
 *  - Raw CJS package (no `type: 'module'`) served unbundled: needs the
 *    namespace-as-default wrapper.
 *  - Raw ESM package with named-only exports (e.g. obug): needs the wrapper.
 */
async function analyzeExports(pkgName: string, resolvedId?: string) {
  if (exportsCache.has(pkgName)) return exportsCache.get(pkgName)!;
  let result = { hasDefault: true, named: [] as string[] };
  const pkg = readPkgJson(pkgName);
  try {
    if (!pkg) {
      // Unknown: leave native.
    } else if (pkg.type !== 'module') {
      // Raw CJS: must be PRE-BUNDLED (esbuild interops named+default), never
      // wrapped — wrapping can't synthesize CJS named exports. hasDefault=true
      // here means "do not wrap; rely on optimizeDeps.include".
      result = { hasDefault: true, named: [] };
    } else {
      // Pure-ESM: lex the real entry. If it has no default export (e.g. obug),
      // wrap it so `import x from 'pkg'` yields the namespace (Node semantics).
      const file = resolvedId && fs.existsSync(resolvedId.split('?')[0])
        ? resolvedId.split('?')[0]
        : path.join(EXAMPLE_NODE_MODULES, pkgName, pkg.module ?? pkg.main ?? 'index.js');
      const names = await lexFileExports(file);
      result = { hasDefault: names.includes('default'), named: names.filter((n) => n !== 'default') };
    }
  } catch {
    result = { hasDefault: true, named: [] }; // unreadable → leave native
  }
  exportsCache.set(pkgName, result);
  return result;
}

function interopWrapperId(id: string, realId: string, named: string[], defaultExport?: string) {
  const params = new URLSearchParams();
  params.set('real', realId);
  if (named.length) params.set('named', named.join(','));
  if (defaultExport) params.set('defaultExport', defaultExport);
  return `${INTEROP_PREFIX}${encodeURIComponent(id)}?${params.toString()}`;
}

/**
 * Named-only ESM deps whose package DEFAULT export (in Node's dist) is one of
 * the named exports. The browser build omits `default`, so the namespace wrap
 * would make `import x from 'pkg'` the whole namespace instead of the callable
 * the Node default points to. Map pkg → the named export that IS the default.
 */
const DEFAULT_EXPORT_HINTS: Record<string, string> = {
  obug: 'createDebug',
};

function forkDepsPlugin(): Plugin {
  return {
    name: 'fork-deps',
    enforce: 'pre',
    async resolveId(id, importer) {
      // Serve the interop wrapper's own id verbatim.
      if (id.startsWith(INTEROP_PREFIX)) return id;
      if (!importer || !toPosix(importer).startsWith(FORK_SRC)) return null;
      if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return null;
      if (id.startsWith('node:')) return null;
      const resolved = await this.resolve(id, EXAMPLE_NODE_MODULES + '/x.js', {
        skipSelf: true,
      });
      if (!resolved) return null;
      // ESM default interop: wrap ONLY pure-ESM deps that lack a default export
      // (e.g. obug), so `import x from 'pkg'` yields the namespace — Node's
      // CJS/ESM default-interop semantics. Raw CJS deps are NOT wrapped here;
      // they're pre-bundled via optimizeDeps.include (esbuild interops them).
      const { hasDefault, named } = await analyzeExports(id, resolved.id);
      if (!hasDefault) {
        return interopWrapperId(id, resolved.id, named, DEFAULT_EXPORT_HINTS[id]);
      }
      return resolved;
    },
    load(id) {
      if (!id.startsWith(INTEROP_PREFIX)) return null;
      const params = new URLSearchParams(id.split('?')[1]);
      const real = params.get('real');
      if (!real) return null;
      // Namespace-as-default interop: `default` is the whole module namespace
      // object, matching Node's synthesized CJS/ESM default. The named exports
      // discovered by the lexer are re-exported EXPLICITLY so named imports
      // (e.g. `import { expand } from 'dotenv-expand'`) resolve through the
      // wrapper exactly as they would against the real entry.
      const named = (params.get('named') ?? '').split(',').filter(Boolean);
      const reexport = named.length
        ? `export { ${named.join(', ')} } from ${JSON.stringify(real)};`
        : `export * from ${JSON.stringify(real)};`;
      // When the package's Node default is one of its named exports (obug →
      // createDebug), bind default to that callable; otherwise namespace.
      const defaultExport = params.get('defaultExport');
      const defaultLine = defaultExport
        ? `export default __ns[${JSON.stringify(defaultExport)}];`
        : `export default __ns;`;
      return [
        `import * as __ns from ${JSON.stringify(real)};`,
        defaultLine,
        reexport,
      ].join('\n');
    },
  };
}

/**
 * Resolve `node:fs` / `fs` (and their subpaths) to browser-safe shims. The
 * Node-side plugins we wire in (css.ts → postcss-load-config → lilconfig)
 * destructure `fs.promises.readFile` at module load; Vite's default browser
 * externalization of node:fs is an EMPTY object, so that destructure throws at
 * import time. We map every fs specifier (incl. `node:fs/promises`) to a
 * structural shim whose methods reject only if actually invoked — the
 * fs-touching PostCSS config path is never exercised in the browser fork.
 *
 * Done as a resolver plugin (not resolve.alias) so subpaths are matched
 * precisely — a naive `fs` alias makes the optimizer append `/promises` to the
 * aliased file path and fail.
 */
const SHIMS_DIR = path.resolve(__dirname, '../packages/vite/src/browser/shims');
/**
 * Node builtin → browser shim map (almostnode-style). Vite's Node-side code
 * imports these builtins; in the browser they'd be externalized to EMPTY stubs.
 * We serve functional shims backed by the VFS / browser APIs instead. Applied
 * in BOTH the dev-server resolver AND the dep-optimizer alias, so the same
 * modules resolve identically whether served natively or pre-bundled.
 */
const BUILTIN_SHIMS: Record<string, string> = {
  fs: 'fs.ts',
  'fs/promises': 'fs-promises.ts',
  path: 'path.ts',
  os: 'os.ts',
  url: 'url.ts',
  util: 'util.ts',
  module: 'module.ts',
  crypto: 'crypto.ts',
  buffer: 'buffer.ts',
  stream: 'stream.ts',
  'stream/promises': 'stream-promises.ts',
  events: 'events.ts',
  tty: 'tty.ts',
  querystring: 'querystring.ts',
  worker_threads: 'worker_threads.ts',
  perf_hooks: 'perf_hooks.ts',
  process: 'process.ts',
  async_hooks: 'async_hooks.ts',
  v8: 'v8.ts',
  inspector: 'inspector.ts',
  diagnostics_channel: 'diagnostics_channel.ts',
  child_process: 'child_process.ts',
  http: 'http.ts',
  https: 'https.ts',
  net: 'net.ts',
  tls: 'tls.ts',
  zlib: 'zlib.ts',
  vm: 'vm.ts',
  readline: 'readline.ts',
  assert: 'assert.ts',
  domain: 'domain.ts',
  dgram: 'dgram.ts',
  dns: 'dns.ts',
  cluster: 'cluster.ts',
  http2: 'http2.ts',
  timers: 'timers.ts',
  'timers/promises': 'timers.ts',
  // Third-party CJS deps the fork imports that need browser-safe shims.
  ws: 'ws.ts',
  etag: 'etag.ts',
  lilconfig: 'lilconfig.ts',
  '@vercel/detect-agent': 'detect-agent.ts',
  // rolldown is Vite's native Rust bundler — it can't run in a browser. The
  // fork never bundles (Oxc WASM dev transforms + custom dep optimizer), but
  // Node modules statically import it, so resolve rolldown + its subpaths to a
  // minimal ESM stub.
  rolldown: 'rolldown.ts',
  'rolldown/utils': 'rolldown.ts',
  'rolldown/experimental': 'rolldown.ts',
  'rolldown/filter': 'rolldown.ts',
  'rolldown/parseAst': 'rolldown.ts',
  'rolldown/plugins': 'rolldown.ts',
};
const SHIM_IDS = new Map<string, string>(
  Object.entries(BUILTIN_SHIMS).flatMap(([id, file]): Array<[string, string]> => {
    const abs = path.join(SHIMS_DIR, file);
    // Real packages (ws, etag, lilconfig, rolldown, @vercel/detect-agent) have
    // no `node:` form. Node builtins get both bare and `node:`-prefixed ids.
    const isPackage =
      id.startsWith('@') || ['ws', 'etag', 'lilconfig'].includes(id) || id.startsWith('rolldown');
    return isPackage ? [[id, abs]] : [[id, abs], [`node:${id}`, abs]];
  }),
);

function nodeFsShimPlugin(): Plugin {
  return {
    name: 'node-fs-shim',
    enforce: 'pre',
    resolveId(id) {
      return SHIM_IDS.get(id) ?? null;
    },
  };
}

/**
 * Same-origin proxy for esm.sh so modern-monaco's TS worker can fetch `.d.ts`
 * under COEP: require-corp. Direct https://esm.sh responses omit CORP and are
 * blocked in the cross-origin-isolated editor page; we re-serve them with the
 * isolation headers and rewrite `x-typescript-types` to stay on this origin.
 */
function esmShTypesProxyPlugin(): Plugin {
  return {
    name: 'esm-sh-types-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const raw = (req.url ?? '').split('?')[0];
        if (!raw.startsWith('/esm-sh/')) return next();
        const targetPath = raw.slice('/esm-sh/'.length);
        if (!targetPath || targetPath.includes('..')) {
          res.statusCode = 400;
          res.end('bad path');
          return;
        }
        const qs = (req.url ?? '').includes('?') ? '?' + (req.url ?? '').split('?')[1] : '';
        const target = `https://esm.sh/${targetPath}${qs}`;
        try {
          const upstream = await fetch(target, {
            headers: { accept: req.headers.accept ?? '*/*' },
            redirect: 'follow',
          });
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.setHeader(
            'content-type',
            upstream.headers.get('content-type') ?? 'application/javascript; charset=utf-8',
          );
          res.setHeader('cross-origin-resource-policy', 'cross-origin');
          res.setHeader('cross-origin-embedder-policy', 'require-corp');
          // Long TTL so modern-monaco's IndexedDB cache (and the browser) keep
          // `.d.ts` hits warm across reloads — IntelliSense cold-start is
          // dominated by re-fetching these when max-age is too short.
          const isDts = /\.d\.(c|m)?ts$/i.test(targetPath);
          res.setHeader(
            'cache-control',
            isDts ? 'public, max-age=604800, immutable' : 'public, max-age=86400',
          )
          const dts = upstream.headers.get('x-typescript-types');
          if (dts) {
            // Absolute same-origin URL so the worker's `new URL(dts, res.url)`
            // never depends on Response.url being populated.
            try {
              const u = new URL(dts, 'https://esm.sh/');
              const host = req.headers.host ?? 'localhost';
              const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
              if (u.hostname === 'esm.sh') {
                res.setHeader(
                  'x-typescript-types',
                  `${proto}://${host}/esm-sh${u.pathname}${u.search}`,
                );
              } else {
                res.setHeader('x-typescript-types', dts);
              }
            } catch {
              res.setHeader('x-typescript-types', dts);
            }
          }
          res.statusCode = upstream.status;
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.end(`esm.sh proxy failed: ${err instanceof Error ? err.message : err}`);
        }
      });
    },
  };
}

/**
 * Serves the installed modern-monaco fork's editor-core and builtin LSP at
 * clean, stable URLs (`/monaco/*.mjs`). modern-monaco's `init()` lazy-loads
 * these from esm.sh unless the page importmap maps them to local URLs — the
 * importmap in index.html points at these, making the editor fully offline.
 */
function monacoModulesPlugin(): Plugin {
  // Resolve the installed package root directly (its `exports` map doesn't
  // expose ./package.json or a resolvable main for require.resolve).
  const monacoRoot = path.resolve(__dirname, 'node_modules', 'modern-monaco');
  const serve = (rel: string) => path.join(monacoRoot, rel);
  return {
    name: 'monaco-modules',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        let file: string | null = null;
        if (url === '/monaco/editor-core.mjs') {
          file = serve('dist/editor-core.mjs');
        } else if (url === '/monaco/lsp.mjs') {
          file = serve('dist/lsp/index.mjs');
        } else if (url.startsWith('/monaco/lsp/') && url.endsWith('.mjs')) {
          // Builtin LSP lazily imports subpath setups (html/css/json/typescript).
          file = serve('dist/lsp/' + url.slice('/monaco/lsp/'.length));
        } else if (url.startsWith('/monaco/') && url.endsWith('.mjs')) {
          // The runtime builds relative URLs from nested lsp modules that escape
          // the /monaco/lsp/ prefix. Try dist/<rest> first (top-level modules
          // like editor-worker-main.mjs), then dist/lsp/<rest> (language setups).
          const rest = url.slice('/monaco/'.length);
          const top = serve('dist/' + rest);
          file = fs.existsSync(top) ? top : serve('dist/lsp/' + rest);
        } else if (/^\/[\w-]+\.mjs$/.test(url)) {
          // Bare single-segment relative imports (e.g. `/cache.mjs`) escape the
          // /monaco/ prefix when a nested lsp module imports a top-level dist
          // helper — serve them from dist/ when they exist there.
          const candidate = serve('dist' + url);
          if (fs.existsSync(candidate)) file = candidate;
        }
        if (!file || !fs.existsSync(file)) return next();
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        // This middleware short-circuits before Vite's `server.headers` middleware,
        // so we must re-apply the isolation headers ourselves. Without them:
        //   - CORP missing → COEP pages block the response as a subresource
        //   - COEP missing → dedicated/module workers fail with
        //     net::ERR_BLOCKED_BY_RESPONSE (sec-fetch-dest: worker). That left
        //     Monaco's TS worker dead and hover/completions spinning forever.
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

function nodeBuiltinsPlugin(): Plugin {
  const ID = 'virtual:node-builtins';
  const list = [
    ...new Set(
      builtinModules
        .map((m) => m.replace(/^node:/, ''))
        .filter((m) => !m.split('/')[0].startsWith('_')),
    ),
  ].sort();
  return {
    name: 'node-builtins',
    resolveId(id) {
      if (id === ID) return '\0' + ID;
    },
    load(id) {
      if (id === '\0' + ID) {
        return `export const NODE_BUILTINS = ${JSON.stringify(list)};`;
      }
    },
  };
}

export default defineConfig({
  plugins: [
    nodeFsShimPlugin(),
    forkDepsPlugin(),
    react(),
    tailwindcss(),
    iframeRuntimePlugin(),
    nodeBuiltinsPlugin(),
    monacoModulesPlugin(),
    esmShTypesProxyPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workspace browser-vite (Vite 8.1.5 fork). NOTE: order matters — the
      // exact 'browser-vite/shims/globals' entry must precede the bare
      // 'browser-vite' prefix alias so the subpath resolves to the shims dir.
      'browser-vite/shims/globals': path.resolve(
        __dirname,
        '../packages/vite/src/browser/shims/globals.ts',
      ),
      'browser-vite': path.resolve(__dirname, '../packages/vite/src/browser/index.ts'),
      'browser-vite/client/browser': path.resolve(
        __dirname,
        '../packages/vite/src/client/browser.ts',
      ),
      // Local patched WASM entry (asyncWorkPoolSize: 0 for Vite/Playwright)
      'oxc-transform/browser.js': path.resolve(
        __dirname,
        'src/vendor/oxc-transform-browser.js',
      ),
      'oxc-transform': path.resolve(__dirname, 'src/vendor/oxc-transform-browser.js'),
      '@oxc-transform/binding-wasm32-wasi': path.resolve(
        __dirname,
        'src/vendor/oxc-transform-browser.js',
      ),
    },
  },
  // Base path for GitHub Pages deploy (repo: lofcz/browser-vite-ng).
  // Locally (dev/preview) we serve from '/'.
  base: process.env.GITHUB_PAGES ? '/browser-vite-ng/' : '/',
  server: {
    port: 5173,
    fs: {
      allow: ['..'],
    },
    // Required headers for SharedArrayBuffer (used by OXC WASM workers)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',  // Required for top-level await in OXC WASM
    outDir: 'dist',
  },
  optimizeDeps: {
    exclude: [
      '@oxc-transform/binding-wasm32-wasi',
      'browser-vite',
      'rolldown',
      // lilconfig reads `fs.promises.readFile` at MODULE INIT. Pre-bundling it
      // externalizes fs to the empty stub → crash. Serve it natively so the
      // resolveId shim supplies the real VFS-backed fs. (postcss-load-config
      // only reads fs THROUGH lilconfig, so it can be pre-bundled — lilconfig
      // resolves via the optimizer alias.)
      'lilconfig',
    ],
    // The optimizer (esbuild) force-externalizes node builtins to an EMPTY
    // browser stub, and its `alias` CANNOT override builtin names. So we use an
    // esbuild onResolve plugin — it runs BEFORE builtin externalization — to
    // point builtins (and the CJS shimmed packages) at the real VFS-backed shim
    // files, matching exactly what the dev-server resolver serves.
    esbuildOptions: {
      plugins: [
        {
          name: 'node-builtin-shims',
          setup(build: {
            onResolve: (
              o: { filter: RegExp },
              cb: (a: { path: string }) => { path: string } | null,
            ) => void;
          }) {
            build.onResolve({ filter: /.*/ }, (args: { path: string }) => {
              const shim = SHIM_IDS.get(args.path);
              return shim ? { path: shim } : null;
            });
          },
        },
      ],
    },
    // browser-vite is excluded above, so its deps would be served raw without
    // CJS interop. We pre-bundle the CJS subgraph so esbuild interops each
    // package exactly like Node. The CJS set is AUTO-COLLECTED (not hand-curated)
    // by walking declared dependencies of the known CJS roots — so transitive
    // CJS deps (e.g. js-tokens pulled in by loose-envify) are covered with no
    // whack-a-mole. Pure-ESM deps are intentionally left OUT (served natively).
    include: [
      // Always-needed runtime deps (entry points esbuild can discover).
      '@zenfs/core',
      'eventemitter3',
      'buffer',
      'readable-stream',
      'utilium',
      'kerium',
      'memium',
      // The auto-collected CJS subgraph: every CJS package reachable from the
      // node-plugin CJS roots, pre-bundled so esbuild synthesizes their
      // ESM default/named exports (CJS interop), matching Node semantics.
      ...collectCjsDeps([
        'picomatch',
        'convert-source-map',
        'escape-html',
        'postcss-load-config',
        'postcss-import',
        'postcss-modules',
        '@rollup/pluginutils',
        '@rollup/plugin-dynamic-import-vars',
        'picocolors',
        'connect',
        'cors',
        'cross-spawn',
        'debug',
        'dotenv',
        'dotenv-expand',
        'launch-editor-middleware',
        'http-proxy-3',
        '@jridgewell/resolve-uri',
        '@jridgewell/trace-mapping',
        '@jridgewell/remapping',
        '@jridgewell/sourcemap-codec',
        '@jridgewell/gen-mapping',
        'js-tokens',
        'loose-envify',
        'object-assign',
      ]),
    ],
  },
  worker: {
    format: 'es',
  },
});
