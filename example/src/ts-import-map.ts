/**
 * Host-owned TypeScript import map for modern-monaco.
 *
 * Real IDEs don't ask the user to maintain an import map in project files —
 * the editor host wires package → types. We do the same: build an import map
 * from the resolved install set and push it into the TS worker via
 * `updateCompilerOptions({ importMap })`. Nothing is written into user code.
 *
 * URLs go through the same-origin `/esm-sh/*` Vite proxy (not raw esm.sh) so
 * `.d.ts` fetches work under COEP: require-corp.
 *
 * Prefer mapping bare specifiers **directly to `.d.ts` URLs** (via `@types/*`
 * when present). Pointing at the JS module and waiting for `x-typescript-types`
 * is the Deno-compatible path, but it adds a serial hop before IntelliSense
 * can start — we skip that when we already know the types package.
 */

export type InstalledDep = { name: string; version: string };

/** Origin-absolute `/esm-sh/...` base for a package@version. */
function esmShBase(name: string, version: string): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/esm-sh/${name}@${version}`;
}

/** DefinitelyTyped name for a runtime package. */
function atTypesName(pkgName: string): string {
  if (pkgName.startsWith('@types/')) return pkgName;
  if (pkgName.startsWith('@')) {
    const [scope, name] = pkgName.slice(1).split('/');
    return `@types/${scope}__${name}`;
  }
  return `@types/${pkgName}`;
}

/** Import map entries for a resolved dependency set. */
export function buildTypesImportMap(
  installed: InstalledDep[],
): { imports: Record<string, string> } {
  const versions = new Map(installed.map((d) => [d.name, d.version]));
  const imports: Record<string, string> = {};

  for (const { name, version } of installed) {
    if (name.startsWith('@types/')) continue;

    const typesName = atTypesName(name);
    const typesVer = versions.get(typesName);
    if (typesVer) {
      // One-hop: worker fetches the declaration file directly (no JS probe).
      const base = esmShBase(typesName, typesVer);
      imports[name] = `${base}/index.d.ts`;
      imports[`${name}/`] = `${base}/`;
      // Hot subpaths — avoid `…/jsx-runtime` → JS stub → `.d.ts` redirect.
      if (name === 'react') {
        imports['react/jsx-runtime'] = `${base}/jsx-runtime.d.ts`;
        imports['react/jsx-dev-runtime'] = `${base}/jsx-dev-runtime.d.ts`;
      }
      if (name === 'react-dom') {
        imports['react-dom/client'] = `${base}/client.d.ts`;
        imports['react-dom/server'] = `${base}/server.d.ts`;
      }
    } else {
      // Package ships its own types (or esm.sh will advertise them). Keep the
      // module URL; warmTypesCache resolves `x-typescript-types` up front.
      const base = esmShBase(name, version);
      imports[name] = base;
      imports[`${name}/`] = `${base}/`;
    }
  }
  return { imports };
}

/**
 * Best-effort map from package.json dependency ranges (before Install resolves
 * concrete versions). Install replaces this with exact pins.
 */
export function buildTypesImportMapFromPackageJson(
  packageJsonContent: string,
): { imports: Record<string, string> } {
  try {
    const pkg = JSON.parse(packageJsonContent) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const installed: InstalledDep[] = [];
    for (const [name, range] of Object.entries(deps)) {
      // Keep @types/* in the list so runtime packages can map to them.
      const version = range.replace(/^[\^~>=<\s]+/, '') || 'latest';
      installed.push({ name, version });
    }
    return buildTypesImportMap(installed);
  } catch {
    return { imports: {} };
  }
}

/**
 * Warm modern-monaco's IndexedDB HTTP cache with declaration files so the TS
 * worker's first resolve is a cache hit (not a cold esm.sh waterfall).
 */
export async function warmTypesCache(importMap: {
  imports: Record<string, string>;
}): Promise<{ warmed: number; failed: number }> {
  // Lazy import so the example entry doesn't pull cache.mjs before monaco loads.
  const { cache } = await import('modern-monaco/cache');
  const entryUrls = Object.entries(importMap.imports)
    .filter(([key]) => !key.endsWith('/'))
    .map(([, url]) => url);

  let warmed = 0;
  let failed = 0;

  const warmDts = async (dtsUrl: string, depth = 0): Promise<void> => {
    if (depth > 3) return;
    const res = await cache.fetch(dtsUrl);
    if (!res.ok) {
      failed++;
      return;
    }
    warmed++;
    const text = await res.text();
    // Strip comments first — @types/react JSDoc examples contain
    // `from './user-context'` which is not a real file (404 storms).
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const refs = new Set<string>();
    for (const m of code.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) refs.add(m[1]);
    for (const m of code.matchAll(/\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g)) {
      refs.add(m[1]);
    }
    await Promise.all(
      [...refs].map(async (ref) => {
        try {
          let href = new URL(ref, dtsUrl).href;
          if (!/\.d\.(c|m)?ts$/.test(href) && !/\.(c|m)?tsx?$/.test(href)) {
            href = href + '.d.ts';
          }
          await warmDts(href, depth + 1);
        } catch {
          failed++;
        }
      }),
    );
  };

  await Promise.all(
    entryUrls.map(async (url) => {
      try {
        if (/\.d\.(c|m)?ts$/.test(url)) {
          await warmDts(url);
          return;
        }
        // Module URL: follow x-typescript-types (lucide-react, etc.).
        const res = await cache.fetch(url);
        if (!res.ok) {
          failed++;
          return;
        }
        const dts = res.headers.get('x-typescript-types');
        res.body?.cancel?.();
        if (dts) {
          await warmDts(new URL(dts, url).href);
        } else {
          warmed++;
        }
      } catch {
        failed++;
      }
    }),
  );

  return { warmed, failed };
}
