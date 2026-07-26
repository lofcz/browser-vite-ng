/**
 * Browser virtual file system — the browser analogue of node:fs.
 *
 * Full-fidelity constraint: this only replaces *where bytes come from*. It does
 * not change any Vite algorithm. It supplies identical `read()` content to the
 * transform pipeline and HMR `readModifiedFile`, and emits create/update/delete
 * events so `handleHMRUpdate` can run the same code path as a real watcher.
 */

export type VirtualFileEvent = 'add' | 'change' | 'unlink'
export type VirtualFileListener = (file: string, event: VirtualFileEvent) => void

const files = new Map<string, string>()
const listeners = new Set<VirtualFileListener>()

// Bulk-write mode: while > 0, setVirtualFile mutates the map without emitting
// events. Used by the dependency installer, which writes thousands of
// node_modules files that are not app modules — firing HMR 'add' events for
// each is pure overhead and slows install dramatically.
let bulkDepth = 0

function normalize(file: string): string {
  return file.replace(/\\/g, '/')
}

export function setVirtualFile(file: string, content: string): void {
  const f = normalize(file)
  const prev = files.get(f)
  // No-op when content is identical: prevents spurious 'change' → HMR →
  // full-reload feedback loops when the host re-syncs unchanged files.
  if (prev === content) return
  const event: VirtualFileEvent = prev === undefined ? 'add' : 'change'
  files.set(f, content)
  if (bulkDepth > 0) return
  for (const l of listeners) l(f, event)
}

/**
 * Run `fn` with VFS event emission suspended. Writes still land in the map;
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
  if (files.delete(f)) {
    for (const l of listeners) l(f, 'unlink')
  }
}

export function hasVirtualFile(file: string): boolean {
  return files.has(normalize(file))
}

export function readVirtualFile(file: string): string | undefined {
  return files.get(normalize(file))
}

export function listVirtualFiles(): string[] {
  return [...files.keys()]
}

export function clearVirtualFiles(): void {
  files.clear()
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
    if (files.has(normalize(c))) return normalize(c)
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
