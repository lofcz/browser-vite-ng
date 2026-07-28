/**
 * VS Code-faithful file Explorer built on @pierre/trees, mounted into the
 * sidebar by the React shell (App.tsx). The tree renders inside a shadow root;
 * selection stays owned by the zustand store (single source of truth), and
 * structural edits (create / rename / move / delete) flow through `fs-ops.ts`
 * so the store, browser-vite module graph, and Monaco models stay in sync.
 *
 * Path model: @pierre/trees speaks *relative* canonical paths with NO leading
 * slash and marks directories with a TRAILING slash (`src/components/`). The
 * VFS / Monaco / module graph speak *absolute* paths WITH a leading slash and
 * only ever store files (`/` + `src/components/Button.tsx`). `toVfs` /
 * `toTree` translate between the two at every boundary so nothing inside the
 * tree ever leaks a leading slash into the VFS (which is what corrupted drops
 * and manufactured phantom directories).
 *
 * Theme: the tree paints from CSS custom properties inside its shadow root.
 * We map the real `--vscode-*` Dark+ tokens (defined in `vscode-explorer.css`)
 * onto the `--trees-*-override` surface on the host so rows, focus, selection,
 * search input, and Git badges match the editor theme.
 */
import { useEffect, useMemo, useRef } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { GitStatusEntry } from '@pierre/trees';
import { editorStore, useEditorStore } from './store';
import * as fs from './fs-ops';

// ---- Path translation (tree-relative <-> VFS-absolute) ---------------------

/** tree path -> VFS path. Directories keep their trailing slash. */
function toVfs(treePath: string): string {
  return '/' + treePath;
}

/** VFS path -> tree path. `isDir` adds the trailing slash the tree expects. */
function toTree(vfsPath: string, isDir: boolean): string {
  const rel = vfsPath.replace(/^\//, '');
  return isDir ? rel.replace(/\/?$/, '/') : rel;
}

/** Directory portion of a tree path, as a tree directory path ('' at root). */
function treeParentDir(treePath: string): string {
  const trimmed = treePath.endsWith('/') ? treePath.slice(0, -1) : treePath;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx + 1);
}

// ---- VFS -> tree derivation -------------------------------------------------

/**
 * Flatten the VFS into the canonical relative file-path list the tree renders
 * from. Folders are implicit (a directory exists iff a file lives under it),
 * so the tree's rows are exactly the file set plus the folders it infers.
 */
function pathsFromFileSystem(fileSystem: Record<string, { path: string }>): string[] {
  return Object.keys(fileSystem)
    .map((p) => toTree(p, false))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// ---- Item operations bridging into the tree --------------------------------

/** Start an inline "new file/folder" flow under `dir` (a tree directory path,
 *  '' at root). Creates a placeholder, then focuses + renames it so the user
 *  types the real name immediately; `removeIfCanceled` cleans up if aborted. */
function newItem(model: import('@pierre/trees').FileTree, dir: string, folder: boolean) {
  const mk = (base: string, exists: (treePath: string) => boolean) => {
    let candidate = `${dir}${base}`;
    let i = 1;
    while (exists(candidate)) candidate = `${dir}${base.replace(/(\.[^.]+)?$/, `-${i++}$1`)}`;
    return candidate;
  };
  const exists = (treePath: string) => fs.fileExists(toVfs(treePath));
  if (folder) {
    // Folders are implicit in the VFS, so materialize via a placeholder file.
    const dirPath = mk('new-folder', (p) => fs.dirHasFiles(toVfs(p)) || exists(p));
    const placeholder = `${dirPath}/.gitkeep`;
    fs.createFile(toVfs(placeholder));
    requestAnimationFrame(() => {
      model.getItem(treeParentDir(placeholder))?.focus();
      model.startRenaming(placeholder, { removeIfCanceled: true });
    });
    return;
  }
  const file = mk('new-file.tsx', exists);
  fs.createFile(toVfs(file));
  requestAnimationFrame(() => {
    model.getItem(file)?.focus();
    model.startRenaming(file, { removeIfCanceled: true });
  });
}

// ---- Explorer root ----------------------------------------------------------

export function Explorer() {
  const fileSystem = useEditorStore((s) => s.fileSystem);
  const modifiedFiles = useEditorStore((s) => s.modifiedFiles);

  // Structural identity: only re-derive the path list when the SET of paths
  // changes (add / remove / rename / move), not on every content keystroke.
  const paths = useMemo(() => pathsFromFileSystem(fileSystem), [fileSystem]);
  const pathKey = paths.join('\n');
  const stablePaths = useRef(paths);
  const prevKey = useRef(pathKey);
  if (prevKey.current !== pathKey) {
    prevKey.current = pathKey;
    stablePaths.current = paths;
  }

  // Unsaved-file Git badges, pushed imperatively whenever the modified set
  // changes. Keys are tree-relative paths.
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      Object.keys(modifiedFiles).map((vfsPath) => ({
        path: toTree(vfsPath, false),
        status: 'modified' as const,
      })),
    [modifiedFiles],
  );

  const { model } = useFileTree({
    paths: stablePaths.current,
    // Folders first, then files, each alphabetical — VS Code ordering.
    sort: (a, b) =>
      a.isDirectory !== b.isDirectory
        ? a.isDirectory
          ? -1
          : 1
        : a.basename.localeCompare(b.basename, undefined, { sensitivity: 'base' }),
    initialExpandedPaths: ['src/', 'src/components/'],
    initialSelectedPaths: editorStore.getState().selectedItems.map((p) => toTree(p, false)),
    // VS Code density: 22px rows.
    itemHeight: 22,
    icons: 'standard',
    // Selection is owned by the zustand store; the tree reports user selection
    // changes here and the store derives the active editor file. The "open in
    // editor" side effect happens in the store subscription below (so keyboard,
    // click, and type-ahead selection all open the file exactly once).
    onSelectionChange: (selected) =>
      editorStore.getState().setSelectedItems(selected.map((p) => toVfs(p))),
    renaming: {
      canRename: () => true,
      onRename: ({ sourcePath, destinationPath }) => {
        // The library already validated + reverted on error; persist to the
        // VFS. Path kind comes from the trailing slash, not the row type.
        const isFolder = sourcePath.endsWith('/');
        if (destinationPath === sourcePath) return;
        fs.renamePath(toVfs(sourcePath), toVfs(destinationPath), isFolder);
      },
      onError: (message) => console.warn('[Explorer rename]', message),
    },
    dragAndDrop: {
      // Everything except the implicit root is draggable; `canDrop` below
      // guards the invalid destinations.
      canDrag: () => true,
      canDrop: ({ draggedPaths, target }) => {
        // Resolve the destination as a tree directory path ('' = root).
        const destDir =
          target.kind === 'root'
            ? ''
            : (target.directoryPath ?? treeParentDir(target.hoveredPath ?? ''));
        return draggedPaths.every((p) => {
          const isDir = p.endsWith('/');
          // Can't drop a folder into itself or its own descendant.
          if (isDir && (destDir === p || destDir.startsWith(p))) return false;
          // No-op: dropping onto the directory it already lives in.
          if (destDir === treeParentDir(p)) return false;
          return true;
        });
      },
      onDropComplete: ({ draggedPaths, target }) => {
        const destDir =
          target.kind === 'root'
            ? ''
            : (target.directoryPath ?? treeParentDir(target.hoveredPath ?? ''));
        for (const p of draggedPaths) {
          const isDir = p.endsWith('/');
          const name = (isDir ? p.slice(0, -1) : p).split('/').pop()!;
          const from = toVfs(p);
          const to = toVfs(destDir + name + (isDir ? '/' : ''));
          if (to === from) continue;
          fs.renamePath(from, to, isDir);
        }
      },
      onDropError: (message) => console.warn('[Explorer drop]', message),
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'right-click',
        // Right-click only focuses the row by default; VS Code also selects it
        // before the menu opens, so mirror that here.
        onOpen: (item) => {
          const st = editorStore.getState();
          const vfsPath = toVfs(item.path);
          if (!st.selectedItems.includes(vfsPath)) st.setSelectedItems([vfsPath]);
        },
      },
    },
    gitStatus,
  });

  // Keep the tree's path set in sync with structural VFS changes. This is the
  // ONLY place the model is re-seeded after construction; content edits never
  // reach here (pathKey is stable across keystrokes).
  useEffect(() => {
    model.resetPaths(stablePaths.current);
  }, [model, pathKey]);

  // Push unsaved-file badges whenever the modified set changes.
  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Open the selected file in the editor. Fires on any selection change
  // (click, keyboard, type-ahead) so it works regardless of input modality.
  useEffect(
    () =>
      editorStore.subscribe((s, prev) => {
        if (s.currentFile && s.currentFile !== prev.currentFile && s.currentFile in s.fileSystem) {
          fs.openFileInEditor(s.currentFile);
        }
      }),
    [],
  );

  // Reflect external selection changes (e.g. the editor activating a tab) back
  // into the tree, without echoing the tree's own onSelectionChange write.
  const selectedItems = useEditorStore((s) => s.selectedItems);
  useEffect(() => {
    const current = model.getSelectedPaths().map((p) => toVfs(p));
    const same =
      current.length === selectedItems.length && current.every((p, i) => p === selectedItems[i]);
    if (!same) {
      for (const p of model.getSelectedPaths()) model.getItem(p)?.deselect();
      for (const vfsPath of selectedItems) model.getItem(toTree(vfsPath, false))?.select();
    }
  }, [model, selectedItems]);

  return (
    <div className="vscode-explorer">
      <FileTree
        model={model}
        className="vscode-tree-host"
        renderContextMenu={(item, context) => {
          const isDir = item.path.endsWith('/');
          return (
            <div className="vscode-menu" role="menu" data-file-tree-context-menu-root="true">
              {isDir && (
                <>
                  <button
                    role="menuitem"
                    className="vscode-menu-item"
                    onClick={() => {
                      context.close({ restoreFocus: false });
                      newItem(model, item.path, false);
                    }}
                  >
                    New File…
                  </button>
                  <button
                    role="menuitem"
                    className="vscode-menu-item"
                    onClick={() => {
                      context.close({ restoreFocus: false });
                      newItem(model, item.path, true);
                    }}
                  >
                    New Folder…
                  </button>
                </>
              )}
              <button
                role="menuitem"
                className="vscode-menu-item"
                onClick={() => {
                  context.close({ restoreFocus: false });
                  model.startRenaming(item.path);
                }}
              >
                Rename
              </button>
              <button
                role="menuitem"
                className="vscode-menu-item danger"
                onClick={() => {
                  context.close({ restoreFocus: false });
                  fs.deletePath(toVfs(item.path), isDir);
                }}
              >
                Delete
              </button>
              <button
                role="menuitem"
                className="vscode-menu-item"
                onClick={() => {
                  context.close({ restoreFocus: false });
                  void navigator.clipboard?.writeText(toVfs(item.path));
                }}
              >
                Copy Path
              </button>
            </div>
          );
        }}
      />
    </div>
  );
}
