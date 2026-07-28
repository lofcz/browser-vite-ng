/**
 * Bridges our VFS (zustand store) to modern-monaco's `FileSystem` interface so
 * the editor's Workspace + TS language service can resolve cross-file imports
 * (e.g. `Counter`'s props offered in `App.tsx`). The store stays the source of
 * truth; this FS is a read/write/view adapter over it.
 */
import type { FileSystem, FileStat, FileSystemWatchHandle, FileSystemWatchContext } from 'modern-monaco';
import { errors } from 'modern-monaco';
import {
  readVirtualFile,
  listVirtualFiles,
  onVirtualFileEvent,
} from 'browser-vite';
import { editorStore } from './store';

const { NotFound: VFSNotFoundError } = errors as unknown as { NotFound: new (msg: string) => Error };

/**
 * Installed dependencies live in browser-vite's VFS (the installer writes
 * `/node_modules/<pkg>/...` there), NOT in the editor store. The TS worker's
 * node_modules type resolution reads through this FileSystem, so we BRIDGE:
 * reads fall through to browser-vite's VFS, and its file events are forwarded
 * to our watchers. This gives the worker one unified view — source files from
 * the editor store plus real installed `.d.ts` from the dependency VFS.
 */
function bridgedFiles(): string[] {
  return [...Object.keys(editorStore.getState().fileSystem), ...listVirtualFiles()];
}

function readBridged(path: string): string | undefined {
  const f = editorStore.getState().fileSystem[path];
  if (f) return f.content;
  return readVirtualFile(path);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toPath(filename: string): string {
  // modern-monaco passes either a path ('/src/App.tsx') or a file:// URL.
  let p = filename.startsWith('file://') ? filename.slice(7) : filename;
  p = p.replace(/[\\/]+/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * STRICT lookup: a path exists only if it's a real VFS path, extension and all.
 *
 * We deliberately do NOT resolve extension-less specifiers (e.g. `/src/App` →
 * `/src/App.tsx`). The TS worker resolves `import './App'` to `file:///src/App`
 * and calls `workspace.openModel(uri)`; modern-monaco's `_openTextDocument`
 * then does `readTextFile(uri)`, `createModel(content, undefined, uri)` and
 * `editor.setModel(model)`. If we resolved the extension-less path here, it
 * would succeed, create a model keyed to `file:///src/App` with language
 * `plaintext` (no extension) and ATTACH it to the editor — the "flashes
 * uncolored / ends uncolored" phantom-model bug. Throwing NotFound makes
 * `openModel` return false, so the worker marks it a bad import and never
 * materializes a phantom document. (Same behaviour as modern-monaco's own
 * IndexedDB FS.)
 */
function statFor(path: string): FileStat | null {
  const content = readBridged(path);
  if (content !== undefined) {
    return {
      type: 1,
      ctime: 0,
      mtime: 0,
      version: content.length,
      size: encoder.encode(content).byteLength,
    };
  }
  // Directory if any file lives under it.
  const prefix = path === '/' ? '/' : path + '/';
  if (path === '/' || bridgedFiles().some((k) => k.startsWith(prefix))) {
    return { type: 2, ctime: 0, mtime: 0, version: 1, size: 0 };
  }
  return null;
}

export class VFSFileSystem implements FileSystem {
  private watchers = new Set<{ pathname: string; recursive: boolean; handle: FileSystemWatchHandle }>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeVfs: (() => void) | null = null;

  constructor() {
    // Re-notify watchers whenever the editor-store VFS changes (new file,
    // content sync, etc).
    let prev = editorStore.getState().fileSystem;
    this.unsubscribe = editorStore.subscribe((state) => {
      const next = state.fileSystem;
      if (next === prev) return;
      for (const path of Object.keys(next)) {
        if (!prev[path]) this.notify('create', path, 1);
        else if (prev[path].content !== next[path].content) this.notify('modify', path, 1);
      }
      for (const path of Object.keys(prev)) {
        if (!next[path]) this.notify('remove', path, 1);
      }
      prev = next;
    });
    // Forward browser-vite VFS events so the TS worker re-resolves when
    // packages are installed. ONLY node_modules is forwarded: browser-vite's
    // VFS also mirrors /src writes (HMR), and echoing those back into the
    // store/watcher creates a render loop ("Maximum update depth exceeded").
    this.unsubscribeVfs = onVirtualFileEvent((path, event) => {
      const p = toPath(path);
      if (!p.startsWith('/node_modules/')) return;
      const kind = event === 'add' ? 'create' : event === 'unlink' ? 'remove' : 'modify';
      this.notify(kind, p, 1);
    });
  }

  private notify(kind: 'create' | 'modify' | 'remove', path: string, type: number, context?: FileSystemWatchContext) {
    for (const w of this.watchers) {
      if (w.pathname === path || (w.recursive && (w.pathname === '/' || path.startsWith(w.pathname + '/')))) {
        w.handle(kind, path, type, context);
      }
    }
  }

  async stat(filename: string): Promise<FileStat> {
    const s = statFor(toPath(filename));
    if (!s) throw new VFSNotFoundError(filename);
    return s;
  }

  async readFile(filename: string): Promise<Uint8Array> {
    return encoder.encode(await this.readTextFile(filename));
  }

  async readTextFile(filename: string): Promise<string> {
    const content = readBridged(toPath(filename));
    if (content === undefined) throw new VFSNotFoundError(filename);
    return content;
  }

  async readDirectory(filename: string): Promise<[string, number][]> {
    const path = toPath(filename);
    const prefix = path === '/' ? '/' : path + '/';
    const seen = new Map<string, number>();
    for (const key of bridgedFiles()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) seen.set(rest, 1);
      else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), 2);
    }
    return [...seen.entries()];
  }

  async writeFile(filename: string, content: string | Uint8Array, context?: FileSystemWatchContext): Promise<void> {
    const path = toPath(filename);
    const text = typeof content === 'string' ? content : decoder.decode(content);
    const files = editorStore.getState().fileSystem;
    if (files[path]) {
      editorStore.getState().setFileContent(path, text);
    } else {
      editorStore.getState().addFile({ path, content: text, type: guessType(path) });
    }
    this.notify(files[path] ? 'modify' : 'create', path, 1, context);
  }

  async createDirectory(): Promise<void> {
    // Virtual: directories are implied by file paths; nothing to persist.
  }

  async delete(filename: string): Promise<void> {
    // The example doesn't expose delete-file UI; no-op to keep the FS read-mostly.
  }

  async copy(): Promise<void> {
    throw new Error('copy not implemented');
  }

  async rename(): Promise<void> {
    throw new Error('rename not implemented');
  }

  watch(filename: string, handleOrOptions: FileSystemWatchHandle | { recursive: boolean }, handle?: FileSystemWatchHandle): () => void {
    const options = typeof handleOrOptions === 'function' ? undefined : handleOrOptions;
    const h = (typeof handleOrOptions === 'function' ? handleOrOptions : handle)!;
    const watcher = { pathname: toPath(filename), recursive: options?.recursive ?? false, handle: h };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }
}

function guessType(path: string): 'tsx' | 'ts' | 'css' | 'json' | 'html' {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.html')) return 'html';
  return 'ts';
}
