/**
 * `lilconfig` browser shim (ESM), faithful port of lilconfig/src/index.js.
 *
 * Upstream is CommonJS (`module.exports.lilconfig = ...`) and reads
 * `fs.promises.readFile` at module init. Vite's dep-optimizer force-externalizes
 * `fs` for CJS deps (it does NOT apply resolveId plugins / aliases for builtin
 * specifiers inside pre-bundled CJS), so pre-bundling lilconfig crashes at
 * init. Porting it natively to ESM lets it resolve `path`/`fs` to the REAL
 * VFS-backed shims, so config discovery (package.json "postcss", postcssrc)
 * reads the live VFS exactly as upstream would read disk.
 *
 * Used by postcss-load-config (which we pre-bundle); lilconfig itself is
 * excluded from pre-bundle and resolved to this shim by the resolver plugin.
 */
import * as path from './path';
import * as fs from './fs';

type Loader = (filepath: string, content: string) => unknown | Promise<unknown>;
type LoaderSync = (filepath: string, content: string) => unknown;
type Loaders = Record<string, Loader>;
type LoadersSync = Record<string, LoaderSync>;

export interface LilconfigResult {
  config: unknown;
  filepath: string;
  isEmpty?: boolean;
}
export interface Options {
  stopDir?: string;
  searchPlaces?: string[];
  ignoreEmptySearchPlaces?: boolean;
  cache?: boolean;
  transform?: (result: LilconfigResult | null) => unknown;
  packageProp?: string | string[];
  loaders?: Loaders;
}
export type OptionsSync = Omit<Options, 'loaders'> & { loaders?: LoadersSync };

function getDefaultSearchPlaces(name: string, sync: boolean): string[] {
  return [
    'package.json',
    `.${name}rc.json`,
    `.${name}rc.js`,
    `.${name}rc.cjs`,
    ...(sync ? [] : [`.${name}rc.mjs`]),
    `.config/${name}rc`,
    `.config/${name}rc.json`,
    `.config/${name}rc.js`,
    `.config/${name}rc.cjs`,
    ...(sync ? [] : [`.config/${name}rc.mjs`]),
    `${name}.config.js`,
    `${name}.config.cjs`,
    ...(sync ? [] : [`${name}.config.mjs`]),
  ];
}

function parentDir(p: string): string {
  return path.dirname(p) || path.sep;
}

const jsonLoader: LoaderSync = (_: string, content: string) => JSON.parse(content);

// ESM cannot require() config files; JS/TS configs are loaded via dynamic import.
const dynamicImport: Loader = async (id: string) => {
  const mod = await import(/* @vite-ignore */ `/@fs${id}`);
  return mod.default;
};

export const defaultLoaders: Readonly<Loaders> = Object.freeze({
  '.js': dynamicImport,
  '.mjs': dynamicImport,
  '.cjs': dynamicImport,
  '.json': jsonLoader,
  noExt: jsonLoader,
});

export const defaultLoadersSync: Readonly<LoadersSync> = Object.freeze({
  '.js': jsonLoader,
  '.json': jsonLoader,
  '.cjs': jsonLoader,
  noExt: jsonLoader,
});

function getOptions(name: string, options: Options | OptionsSync, sync: boolean) {
  const conf = {
    stopDir: '/',
    searchPlaces: getDefaultSearchPlaces(name, sync),
    ignoreEmptySearchPlaces: true,
    cache: true,
    transform: (x: unknown) => x,
    packageProp: [name] as string | string[],
    ...options,
    loaders: {
      ...(sync ? defaultLoadersSync : defaultLoaders),
      ...options.loaders,
    } as Record<string, Loader | LoaderSync>,
  };
  conf.searchPlaces.forEach((place) => {
    const key = path.extname(place) || 'noExt';
    const loader = conf.loaders[key];
    if (!loader) throw new Error(`Missing loader for extension "${place}"`);
    if (typeof loader !== 'function')
      throw new Error(`Loader for extension "${place}" is not a function: Received ${typeof loader}.`);
  });
  return conf;
}

function getPackageProp(props: string | string[], obj: Record<string, unknown>): unknown {
  if (typeof props === 'string' && props in obj) return obj[props];
  return (
    (Array.isArray(props) ? props : props.split('.')).reduce<unknown>(
      (acc, prop) => (acc === undefined || acc === null ? acc : (acc as Record<string, unknown>)[prop]),
      obj,
    ) || null
  );
}

function validateFilePath(filepath: string): void {
  if (!filepath) throw new Error('load must pass a non-empty string');
}

function validateLoader(loader: unknown, ext: string): asserts loader is Loader {
  if (!loader) throw new Error(`No loader specified for extension "${ext}"`);
  if (typeof loader !== 'function') throw new Error('loader is not a function');
}

const makeEmplace =
  (enableCache: boolean) =>
  <T>(c: Map<string, T>, filepath: string, res: T): T => {
    if (enableCache) c.set(filepath, res);
    return res;
  };

const cwd = () => '/';

export function lilconfig(name: string, options?: Options) {
  const { ignoreEmptySearchPlaces, loaders, packageProp, searchPlaces, stopDir, transform, cache } =
    getOptions(name, options ?? {}, false);
  const searchCache = new Map<string, unknown>();
  const loadCache = new Map<string, unknown>();
  const emplace = makeEmplace(cache as boolean);

  return {
    async search(searchFrom: string = cwd()) {
      const result: LilconfigResult = { config: null, filepath: '' };
      const visited = new Set<string>();
      let dir = searchFrom;
      dirLoop: while (true) {
        if (cache) {
          const r = searchCache.get(dir);
          if (r !== undefined) {
            for (const p of visited) searchCache.set(p, r);
            return r;
          }
          visited.add(dir);
        }
        for (const searchPlace of searchPlaces) {
          const filepath = path.join(dir, searchPlace);
          try {
            await fs.promises.access(filepath);
          } catch {
            continue;
          }
          const content = String(await fs.promises.readFile(filepath));
          const loaderKey = path.extname(searchPlace) || 'noExt';
          const loader = loaders[loaderKey];
          if (searchPlace === 'package.json') {
            const pkg = await loader(filepath, content);
            const maybeConfig = getPackageProp(packageProp, pkg as Record<string, unknown>);
            if (maybeConfig != null) {
              result.config = maybeConfig;
              result.filepath = filepath;
              break dirLoop;
            }
            continue;
          }
          const isEmpty = content.trim() === '';
          if (isEmpty && ignoreEmptySearchPlaces) continue;
          if (isEmpty) {
            result.isEmpty = true;
            result.config = undefined;
          } else {
            validateLoader(loader, loaderKey);
            result.config = await loader(filepath, content);
          }
          result.filepath = filepath;
          break dirLoop;
        }
        if (dir === stopDir || dir === parentDir(dir)) break dirLoop;
        dir = parentDir(dir);
      }
      const transformed =
        result.filepath === '' && result.config === null ? transform(null) : transform(result);
      if (cache) for (const p of visited) searchCache.set(p, transformed);
      return transformed;
    },
    async load(filepath: string) {
      validateFilePath(filepath);
      const absPath = path.resolve(cwd(), filepath);
      if (cache && loadCache.has(absPath)) return loadCache.get(absPath);
      const { base, ext } = path.parse(absPath);
      const loaderKey = ext || 'noExt';
      const loader = loaders[loaderKey];
      validateLoader(loader, loaderKey);
      const content = String(await fs.promises.readFile(absPath));
      if (base === 'package.json') {
        const pkg = await loader(absPath, content);
        return emplace(
          loadCache,
          absPath,
          transform({ config: getPackageProp(packageProp, pkg as Record<string, unknown>), filepath: absPath }),
        );
      }
      const result: LilconfigResult = { config: null, filepath: absPath };
      const isEmpty = content.trim() === '';
      if (isEmpty && ignoreEmptySearchPlaces)
        return emplace(loadCache, absPath, transform({ config: undefined, filepath: absPath, isEmpty: true }));
      result.config = isEmpty ? undefined : await loader(absPath, content);
      return emplace(loadCache, absPath, transform(isEmpty ? { ...result, isEmpty, config: undefined } : result));
    },
    clearLoadCache() {
      if (cache) loadCache.clear();
    },
    clearSearchCache() {
      if (cache) searchCache.clear();
    },
    clearCaches() {
      if (cache) {
        loadCache.clear();
        searchCache.clear();
      }
    },
  };
}

export function lilconfigSync(name: string, options?: OptionsSync) {
  const { ignoreEmptySearchPlaces, loaders, packageProp, searchPlaces, stopDir, transform, cache } =
    getOptions(name, options ?? {}, true);
  const searchCache = new Map<string, unknown>();
  const loadCache = new Map<string, unknown>();
  const emplace = makeEmplace(cache as boolean);

  return {
    search(searchFrom: string = cwd()) {
      const result: LilconfigResult = { config: null, filepath: '' };
      const visited = new Set<string>();
      let dir = searchFrom;
      dirLoop: while (true) {
        if (cache) {
          const r = searchCache.get(dir);
          if (r !== undefined) {
            for (const p of visited) searchCache.set(p, r);
            return r;
          }
          visited.add(dir);
        }
        for (const searchPlace of searchPlaces) {
          const filepath = path.join(dir, searchPlace);
          try {
            fs.accessSync(filepath);
          } catch {
            continue;
          }
          const loaderKey = path.extname(searchPlace) || 'noExt';
          const loader = loaders[loaderKey];
          const content = String(fs.readFileSync(filepath));
          if (searchPlace === 'package.json') {
            const pkg = (loader as LoaderSync)(filepath, content);
            const maybeConfig = getPackageProp(packageProp, pkg as Record<string, unknown>);
            if (maybeConfig != null) {
              result.config = maybeConfig;
              result.filepath = filepath;
              break dirLoop;
            }
            continue;
          }
          const isEmpty = content.trim() === '';
          if (isEmpty && ignoreEmptySearchPlaces) continue;
          if (isEmpty) {
            result.isEmpty = true;
            result.config = undefined;
          } else {
            validateLoader(loader, loaderKey);
            result.config = (loader as LoaderSync)(filepath, content);
          }
          result.filepath = filepath;
          break dirLoop;
        }
        if (dir === stopDir || dir === parentDir(dir)) break dirLoop;
        dir = parentDir(dir);
      }
      const transformed =
        result.filepath === '' && result.config === null ? transform(null) : transform(result);
      if (cache) for (const p of visited) searchCache.set(p, transformed);
      return transformed;
    },
    load(filepath: string) {
      validateFilePath(filepath);
      const absPath = path.resolve(cwd(), filepath);
      if (cache && loadCache.has(absPath)) return loadCache.get(absPath);
      const { base, ext } = path.parse(absPath);
      const loaderKey = ext || 'noExt';
      const loader = loaders[loaderKey];
      validateLoader(loader, loaderKey);
      const content = String(fs.readFileSync(absPath));
      if (base === 'package.json') {
        const pkg = (loader as LoaderSync)(absPath, content);
        return transform({
          config: getPackageProp(packageProp, pkg as Record<string, unknown>),
          filepath: absPath,
        });
      }
      const result: LilconfigResult = { config: null, filepath: absPath };
      const isEmpty = content.trim() === '';
      if (isEmpty && ignoreEmptySearchPlaces)
        return emplace(loadCache, absPath, transform({ filepath: absPath, config: undefined, isEmpty: true }));
      result.config = isEmpty ? undefined : (loader as LoaderSync)(absPath, content);
      return emplace(loadCache, absPath, transform(isEmpty ? { ...result, isEmpty, config: undefined } : result));
    },
    clearLoadCache() {
      if (cache) loadCache.clear();
    },
    clearSearchCache() {
      if (cache) searchCache.clear();
    },
    clearCaches() {
      if (cache) {
        loadCache.clear();
        searchCache.clear();
      }
    },
  };
}

export default { lilconfig, lilconfigSync, defaultLoaders, defaultLoadersSync };
