/**
 * File-system operations for the Explorer tree. These are the single entry
 * point for structural VFS changes (create / delete / rename / move) so that
 * every side-effect — zustand store, browser-vite module graph, and Monaco —
 * stays in sync. The tree UI only calls into here; it never mutates the store
 * directly.
 */
import { editorStore, type VirtualFile } from './store';
import type { BrowserVite } from './browser-vite-wrapper';

export type FileType = VirtualFile['type'];

export function guessType(path: string): FileType {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.jsx') || path.endsWith('.js')) return 'ts';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.html')) return 'html';
  return 'ts';
}

function defaultContent(name: string, type: FileType): string {
  if (type === 'css') return `/* ${name} */\n`;
  if (type === 'json') return '{}\n';
  if (type === 'html')
    return `<!doctype html>\n<html>\n  <head><meta charset="UTF-8" /></head>\n  <body></body>\n</html>\n`;
  if (type === 'tsx') {
    const comp = name.replace(/\.tsx$/, '').replace(/[^A-Za-z0-9_$]/g, '') || 'Component';
    return `import React from 'react';\n\nexport function ${comp}() {\n  return <div>New Component</div>;\n}\n`;
  }
  return `// ${name}\n`;
}

// Set by main.ts once the pipeline exists; optional so the tree works before init.
let vite: Pick<BrowserVite, 'setFile' | 'deleteFile'> | null = null;
export function bindBrowserVite(instance: Pick<BrowserVite, 'setFile' | 'deleteFile'> | null) {
  vite = instance;
}

// Set by main.ts so structural changes can dispose/retitle Monaco models.
let monacoHooks: {
  deleteModel?: (path: string) => void;
  renameModel?: (from: string, to: string) => void;
  openFile?: (path: string) => void;
} = {};
export function bindMonacoHooks(hooks: typeof monacoHooks) {
  monacoHooks = hooks;
}

export function createFile(path: string) {
  const name = path.split('/').pop() ?? path;
  const type = guessType(path);
  const content = defaultContent(name, type);
  editorStore.getState().addFile({ path, content, type });
  vite?.setFile(path, content);
}

/** Create an empty folder marker file? No — folders are implicit. Creating a
 *  "folder" is a no-op until a file exists inside it; the tree UI handles
 *  folder creation by immediately starting a new-file rename inside it. */

export function deletePath(path: string, isFolder: boolean) {
  const st = editorStore.getState();
  const victims = isFolder
    ? Object.keys(st.fileSystem).filter((p) => p.startsWith(path + '/'))
    : [path];
  for (const p of victims) {
    monacoHooks.deleteModel?.(p);
    st.deleteFile(p);
    vite?.deleteFile?.(p);
  }
}

export function renamePath(from: string, to: string, isFolder: boolean) {
  const st = editorStore.getState();
  if (from === to) return;
  // Guard: don't move a folder into itself.
  if (isFolder && (to === from || to.startsWith(from + '/'))) return;
  st.renamePath(from, to);
  // Keep browser-vite + monaco in sync for every affected file.
  const now = editorStore.getState().fileSystem;
  const affected = isFolder
    ? Object.keys(now).filter((p) => p === to || p.startsWith(to + '/'))
    : [to];
  for (const newP of affected) {
    const oldP = isFolder ? from + '/' + newP.slice(to.length + 1) : from;
    monacoHooks.renameModel?.(oldP, newP);
    vite?.setFile(newP, now[newP].content);
    vite?.deleteFile?.(oldP);
  }
  // Keep the open file pointing at the new location.
  if (!isFolder && editorStore.getState().currentFile === to) monacoHooks.openFile?.(to);
}

export function movePath(from: string, toDir: string, isFolder: boolean) {
  const name = from.split('/').pop()!;
  const to = (toDir === '/' ? '' : toDir) + '/' + name;
  if (to === from) return;
  renamePath(from, to, isFolder);
}

export function fileExists(path: string) {
  return path in editorStore.getState().fileSystem;
}

export function dirHasFiles(path: string) {
  const prefix = path === '/' ? '/' : path + '/';
  return Object.keys(editorStore.getState().fileSystem).some((p) => p.startsWith(prefix));
}

export function openFileInEditor(path: string) {
  monacoHooks.openFile?.(path);
}
