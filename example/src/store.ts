import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface VirtualFile {
  path: string;
  content: string;
  type: 'tsx' | 'ts' | 'css' | 'json' | 'html';
}

/** Dependency sources are read-only and live outside the project tree. */
export const isDependencyPath = (path: string) => path.startsWith('/node_modules/');

interface EditorState {
  /** VFS keyed by absolute path. Monaco models are the live edit buffers; this
   *  map is the durable source of truth that HMR syncs from. */
  fileSystem: Record<string, VirtualFile>;
  /**
   * Dependency sources opened from `/node_modules`, kept out of `fileSystem` so
   * the explorer tree stays the project and HMR never sees them. Populated on
   * demand (go-to-definition into a package) and read-only.
   */
  dependencyFiles: Record<string, VirtualFile>;
  currentFile: string | null;
  modifiedFiles: Record<string, true>;
  /** Open editor-tab paths, in tab order. The editor area is a tab strip over a
   *  single Monaco host; each entry maps to a Monaco model (per-file buffer). */
  openFiles: string[];
  /** The active editor tab: a file path, or the built-in Preview. */
  activeTab: string | 'preview' | null;
  /** Explorer selection (paths). Single source of truth for the tree; the
   *  active editor file is always the last-selected file. */
  selectedItems: string[];
  /** Monotonic counter bumped by the shell when a file panel is closed
   *  directly in the dock (× button, drag-out close). The engine subscribes
   *  and disposes the corresponding Monaco editor. */
  editorCloseRequest: { path: string; n: number } | null;

  setFiles: (files: VirtualFile[]) => void;
  setCurrentFile: (path: string | null) => void;
  setSelectedItems: (paths: string[]) => void;
  /** Open (or focus) a file tab. Pure store op; the shell syncs Monaco. */
  openTab: (path: string) => void;
  /** Activate an existing tab (file path or 'preview'). */
  activateTab: (id: string | 'preview') => void;
  /**
   * Replace the open-tab list from the dock (e.g. after `fromJSON` restore).
   * Paths may arrive before the VFS is seeded; unknown paths are kept and
   * filtered once files exist.
   */
  replaceOpenTabs: (paths: string[], active: string | null) => void;
  /** Close a file tab; activates a sensible neighbour. */
  closeTab: (path: string) => void;
  /** Open a read-only dependency source in a tab (go-to-definition target). */
  openDependencyFile: (file: VirtualFile) => void;
  setFileContent: (path: string, content: string) => void;
  markModified: (path: string) => void;
  addFile: (file: VirtualFile) => void;
  /** Remove a file. Deleting a "directory" means deleting each file under it. */
  deleteFile: (path: string) => void;
  /** Rename/move a file or a whole directory subtree to a new path. */
  renamePath: (from: string, to: string) => void;
  /** Signal that a file's dock panel was closed (engine disposes the editor). */
  requestEditorClose: (path: string) => void;
}

export const useEditorStore = create<EditorState>()(
  immer((set) => ({
    fileSystem: {},
    dependencyFiles: {},
    currentFile: null,
    modifiedFiles: {},
    openFiles: [],
    activeTab: null,
    selectedItems: [],
    editorCloseRequest: null,

    setFiles: (files) =>
      set((s) => {
        s.fileSystem = {};
        for (const f of files) s.fileSystem[f.path] = { ...f };
        s.modifiedFiles = {};
      }),

    setCurrentFile: (path) =>
      set((s) => {
        s.currentFile = path;
      }),

    setSelectedItems: (paths) =>
      set((s) => {
        s.selectedItems = paths;
        // The active editor file tracks the last-selected *file*.
        const lastFile = [...paths].reverse().find((p) => p in s.fileSystem);
        if (lastFile) s.currentFile = lastFile;
      }),

    openTab: (path) =>
      set((s) => {
        if (!(path in s.fileSystem) && !(path in s.dependencyFiles)) return;
        if (!s.openFiles.includes(path)) s.openFiles.push(path);
        s.activeTab = path;
        s.currentFile = path;
      }),

    openDependencyFile: (file) =>
      set((s) => {
        s.dependencyFiles[file.path] = { ...file };
        if (!s.openFiles.includes(file.path)) s.openFiles.push(file.path);
        s.activeTab = file.path;
        s.currentFile = file.path;
      }),

    activateTab: (id) =>
      set((s) => {
        if (id === 'preview') {
          s.activeTab = 'preview';
          return;
        }
        if (s.openFiles.includes(id)) {
          s.activeTab = id;
          s.currentFile = id;
        }
      }),

    replaceOpenTabs: (paths, active) =>
      set((s) => {
        const hasFs = Object.keys(s.fileSystem).length > 0;
        const next = hasFs
          ? paths.filter((p) => p in s.fileSystem || p in s.dependencyFiles)
          : [...paths];
        // Preserve order; drop duplicates.
        s.openFiles = [...new Set(next)];
        if (active && (active === 'preview' || s.openFiles.includes(active))) {
          s.activeTab = active;
          if (active !== 'preview') s.currentFile = active;
        } else {
          s.activeTab = s.openFiles[0] ?? null;
          s.currentFile = s.activeTab;
        }
      }),

    closeTab: (path) =>
      set((s) => {
        const idx = s.openFiles.indexOf(path);
        if (idx === -1) return;
        s.openFiles.splice(idx, 1);
        // Dependency sources are re-read from the VFS on demand, so don't hold
        // a package's files in memory once its tab is gone.
        delete s.dependencyFiles[path];
        if (s.activeTab === path) {
          const next = s.openFiles[idx - 1] ?? s.openFiles[idx] ?? null;
          s.activeTab = next;
          s.currentFile = next;
        }
        if (s.currentFile === path) {
          s.currentFile = s.activeTab !== 'preview' ? s.activeTab : null;
        }
      }),

    setFileContent: (path, content) =>
      set((s) => {
        const f = s.fileSystem[path];
        if (f && f.content !== content) f.content = content;
      }),

    markModified: (path) =>
      set((s) => {
        s.modifiedFiles[path] = true;
      }),

    addFile: (file) =>
      set((s) => {
        s.fileSystem[file.path] = { ...file };
      }),

    deleteFile: (path) =>
      set((s) => {
        delete s.fileSystem[path];
        delete s.modifiedFiles[path];
        if (s.currentFile === path) s.currentFile = null;
        s.selectedItems = s.selectedItems.filter((p) => p !== path);
        // Drop it from open tabs (mirror of closeTab, without re-derivation).
        const idx = s.openFiles.indexOf(path);
        if (idx !== -1) {
          s.openFiles.splice(idx, 1);
          if (s.activeTab === path) {
            const next = s.openFiles[idx - 1] ?? s.openFiles[idx] ?? null;
            s.activeTab = next;
            s.currentFile = next;
          }
        }
      }),

    renamePath: (from, to) =>
      set((s) => {
        if (from === to) return;
        // Collect the file itself plus any file under it (directory move).
        const prefix = from + '/';
        const moved: Array<[string, string]> = [];
        for (const p of Object.keys(s.fileSystem)) {
          if (p === from) moved.push([p, to]);
          else if (p.startsWith(prefix)) moved.push([p, to + '/' + p.slice(prefix.length)]);
        }
        for (const [oldP, newP] of moved) {
          // The record repeats its own path, so it has to move with the key:
          // a stale `file.path` makes every consumer that iterates the map
          // write the file back to its old location.
          s.fileSystem[newP] = { ...s.fileSystem[oldP], path: newP };
          delete s.fileSystem[oldP];
          if (s.modifiedFiles[oldP]) {
            s.modifiedFiles[newP] = true;
            delete s.modifiedFiles[oldP];
          }
          if (s.currentFile === oldP) s.currentFile = newP;
          const si = s.selectedItems.indexOf(oldP);
          if (si !== -1) s.selectedItems[si] = newP;
          const oi = s.openFiles.indexOf(oldP);
          if (oi !== -1) s.openFiles[oi] = newP;
          if (s.activeTab === oldP) s.activeTab = newP;
        }
      }),

    requestEditorClose: (path) =>
      set((s) => {
        s.editorCloseRequest = { path, n: (s.editorCloseRequest?.n ?? 0) + 1 };
      }),
  })),
);

/** Non-reactive accessor for the raw store (imperative HMR code paths). */
export const editorStore = useEditorStore;
