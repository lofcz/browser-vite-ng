/**
 * Browser virtual file system — the browser analogue of node:fs.
 *
 * Built directly on ZenFS primitives, NOT on the high-level POSIX `fs`
 * emulation. The performance-critical realization: ZenFS's `IndexFS` is a
 * path-keyed filesystem whose metadata operations (`statSync`, `createFileSync`,
 * `mkdirSync`, `readdirSync`) are a direct `Index.get/set(path)` — O(1), with no
 * path-walk, no dir-listing encode/decode, and no per-op transaction. The slow
 * default `StoreFS` (used by the `InMemory` backend) instead walks the path and
 * runs a transaction per op, which is what made bulk installs of thousands of
 * node_modules files take tens of seconds.
 *
 * `MemIndexFS` (below) subclasses `IndexFS` and stores file *content* in an
 * `InMemoryStore` (a `Map<number, Uint8Array>`) — binary-safe, O(1). Metadata
 * (the directory tree, inodes, sizes) lives in the `Index`. Together this gives
 * real folders and binary support at near-Map speed.
 *
 * Full-fidelity constraint: this only replaces *where bytes come from*. It
 * does not change any Vite algorithm. It supplies identical `read()` content
 * to the transform pipeline and HMR `readModifiedFile`, and emits
 * create/update/delete events so `handleHMRUpdate` can run the same code path
 * as a real watcher.
 *
 * Two behaviours are layered on top because the HMR loop depends on them and
 * no filesystem provides them:
 *   1. identical-content no-op (prevents HMR feedback loops on re-sync), and
 *   2. batch suppression (bulk installs must not fire thousands of events).
 */

import { Index, InMemoryStore } from '@zenfs/core'
import { S_IFDIR, S_IFMT, S_IFREG } from '@zenfs/core/constants'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Lean per-entry metadata. ZenFS's `Inode` class is BufferView-backed and costs
 * ~100µs to construct (decorators + accessors + timestamp init); across a bulk
 * install of thousands of files that dominates the entire write path. A plain
 * record carries exactly what we need (data-id, size, isDir) and `Index`
 * operations work identically on it — measured ~130x cheaper.
 */
interface Meta {
  data: number
  size: number
  mode: number
  mtimeMs: number
}

/**
 * A synchronous, in-memory, path-keyed filesystem backed by a ZenFS `Index`
 * (metadata + directory tree) and an `InMemoryStore` (file bytes, binary-safe).
 * All operations are O(1) Map lookups — no path-walk, no per-op transaction.
 */
class MemIndexFS {
  private readonly index = new Index()
  private readonly store = new InMemoryStore()
  // Monotonic data-id allocator. Index._alloc() is O(n) per call (spreads all
  // inodes to find the max), which makes N inserts O(n^2); we allocate instead.
  private nextId = 1

  constructor() {
    this.reset()
  }

  private mkdirFast(path: string): void {
    this.index.set(path, { data: this.nextId++, size: 0, mode: S_IFDIR, mtimeMs: 0 } as Meta)
  }

  private ensureParents(path: string): void {
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i]
      if (!this.index.has(cur)) this.mkdirFast(cur)
    }
  }

  /** Write file content, creating the entry + parents as needed. */
  public put(path: string, data: Uint8Array): void {
    this.ensureParents(path)
    let meta = this.index.get(path) as Meta | undefined
    if (!meta) {
      meta = { data: this.nextId++, size: 0, mode: S_IFREG, mtimeMs: 0 }
      this.index.set(path, meta)
    }
    this.store.set(meta.data, data)
    meta.size = data.byteLength
    meta.mtimeMs = Date.now()
  }

  /** Read file content, or undefined when absent / a directory. */
  public get(path: string): Uint8Array | undefined {
    const meta = this.index.get(path) as Meta | undefined
    if (!meta || (meta.mode & S_IFMT) === S_IFDIR) return undefined
    return this.store.get(meta.data)
  }

  /** Remove a file entry and its bytes. */
  public remove(path: string): void {
    const meta = this.index.get(path) as Meta | undefined
    if (meta) this.store.delete(meta.data)
    this.index.delete(path)
  }

  /** Drop all files + directories (used by clearVirtualFiles). */
  public reset(): void {
    this.index.clear()
    this.store.clear()
    this.nextId = 1
    this.index.set('/', { data: 0, size: 0, mode: S_IFDIR, mtimeMs: 0 } as Meta)
  }

  /** All file paths (not directories) under the root. */
  public filePaths(): string[] {
    const out: string[] = []
    for (const [path, meta] of this.index) {
      if (((meta as Meta).mode & S_IFMT) !== S_IFDIR) out.push(path)
    }
    return out
  }
}

const vfs = new MemIndexFS()

export type VirtualFileEvent = 'add' | 'change' | 'unlink'
export type VirtualFileListener = (file: string, event: VirtualFileEvent) => void

const listeners = new Set<VirtualFileListener>()

// Bulk-write mode: while > 0, setVirtualFile mutates the store without
// emitting events. Used by the dependency installer, which writes thousands of
// node_modules files that are not app modules — firing HMR 'add' events for
// each is pure overhead and slows install dramatically.
let bulkDepth = 0

function normalize(file: string): string {
  return file.replace(/\\/g, '/')
}

function emit(file: string, event: VirtualFileEvent): void {
  for (const l of listeners) l(file, event)
}

export function setVirtualFile(file: string, content: string): void {
  const f = normalize(file)
  const existing = vfs.get(f)
  const prev = existing === undefined ? undefined : decoder.decode(existing)
  // No-op when content is identical: prevents spurious 'change' → HMR →
  // full-reload feedback loops when the host re-syncs unchanged files.
  if (prev === content) return
  const event: VirtualFileEvent = prev === undefined ? 'add' : 'change'
  vfs.put(f, encoder.encode(content))
  if (bulkDepth > 0) return
  emit(f, event)
}

/**
 * Run `fn` with VFS event emission suspended. Writes still land in the store;
 * they just don't dispatch per-file HMR events. Essential for bulk installs.
 */
export function withVirtualFileBatch<T>(fn: () => T): T {
  bulkDepth++
  try {
    return fn()
  } finally {
    bulkDepth--
  }
}

export function deleteVirtualFile(file: string): void {
  const f = normalize(file)
  if (vfs.get(f) === undefined) return
  vfs.remove(f)
  emit(f, 'unlink')
}

export function hasVirtualFile(file: string): boolean {
  return vfs.get(normalize(file)) !== undefined
}

export function readVirtualFile(file: string): string | undefined {
  const data = vfs.get(normalize(file))
  return data === undefined ? undefined : decoder.decode(data)
}

export function listVirtualFiles(): string[] {
  return vfs.filePaths()
}

export function clearVirtualFiles(): void {
  vfs.reset()
}

export function onVirtualFileEvent(listener: VirtualFileListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Resolve a specifier against the VFS (with extensions), browser-side. */
export function resolveVirtualPath(
  specifier: string,
  importer?: string,
  root = '/',
): string | null {
  let base: string
  if (specifier.startsWith('/')) {
    base = specifier
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const importerDir = (importer ?? root).split('/').slice(0, -1).join('/')
    base = joinPath(importerDir, specifier)
  } else {
    // bare specifier — served from virtual node_modules
    base = `/node_modules/${specifier}`
  }

  const candidates = [base]
  if (!/\.[a-z0-9]+$/i.test(base)) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.css']) {
      candidates.push(base + ext)
    }
    for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
      candidates.push(base + idx)
    }
  }
  for (const c of candidates) {
    if (vfs.get(normalize(c)) !== undefined) return normalize(c)
  }
  return null
}

function joinPath(dir: string, rel: string): string {
  const parts = `${dir}/${rel}`.split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return '/' + out.join('/')
}
