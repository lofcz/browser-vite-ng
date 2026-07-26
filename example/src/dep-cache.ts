/**
 * Persistent optimized-deps cache — the browser analogue of Vite's
 * `node_modules/.vite/deps/_metadata.json` + cached bundles on disk.
 *
 * Bundling ~2000 modules through esbuild-wasm costs several seconds, and the
 * result depends ONLY on the resolved package versions (react@19.2.8, …), not
 * on anything that changes between page loads. So we persist the bundled
 * `/node_modules/.deps/*` output in IndexedDB keyed by a hash of the resolved
 * `name@version` set. On a cache hit the entire bundling step is skipped.
 *
 * The cache is invalidated automatically whenever the resolved versions
 * change (editing /package.json, a new publish matching a range, …) because
 * that changes the hash.
 */

import { setVirtualFile, withVirtualFileBatch } from 'browser-vite';

const DB_NAME = 'browser-vite-deps';
const STORE = 'deps';
const CACHE_VERSION = 1;

export interface DepCacheEntry {
  /** Cache key (hash of resolved versions + cache format version). */
  key: string;
  /** specifier -> /@deps URL manifest. */
  manifest: Record<string, string>;
  /** VFS path -> file contents for every /node_modules/.deps/* output. */
  files: Record<string, string>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, CACHE_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Compute the cache key from the resolved dependency set. Order-independent
 * so a stable install yields a stable key.
 */
export async function depCacheKey(resolved: Array<{ name: string; version: string }>): Promise<string> {
  const canonical = resolved
    .map((d) => `${d.name}@${d.version}`)
    .sort()
    .join('\n');
  const data = new TextEncoder().encode(`v${CACHE_VERSION}\n${canonical}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Load a cached bundle for `key`, restoring its files into the VFS. */
export async function loadDepCache(key: string): Promise<Record<string, string> | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<DepCacheEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as DepCacheEntry) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!entry || entry.key !== key) return null;
    withVirtualFileBatch(() => {
      for (const [path, contents] of Object.entries(entry.files)) {
        setVirtualFile(path, contents);
      }
    });
    return entry.manifest;
  } catch {
    return null;
  }
}

/** Persist a bundle's manifest + output files under `key`. */
export async function saveDepCache(
  key: string,
  manifest: Record<string, string>,
  files: Record<string, string>,
): Promise<void> {
  try {
    const db = await openDb();
    const entry: DepCacheEntry = { key, manifest, files };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Caching is best-effort; a failed write must not break the install.
  }
}
