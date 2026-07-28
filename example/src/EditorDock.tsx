/**
 * The dockview editor region — owns the whole dock lifecycle in one component.
 *
 * Architecture (mirrors the reference workspace):
 *   - The dock GRID is built exactly once, synchronously, in `onReady`.
 *   - File tabs are driven by the zustand store. A single store subscription
 *     syncs store → dock, but ONLY after the grid is built (gated on `built`),
 *     so the engine's first `openFile` — which fires before the dock exists —
 *     never mutates a settling grid.
 *   - Dock events (tab close / activation) flow back dock → store.
 *   - There are no retries and no rAF hacks: every `addPanel` runs either
 *     inside the atomic `onReady` build, or afterwards against a laid-out grid.
 */
import { useRef } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';

import { useEditorStore } from './store';
import { FileIcon } from './file-icons';
import {
  buildLayout,
  openFile,
  closeFile,
  revealFileTab,
  filePanelId,
  isFilePanel,
  pathFromPanelId,
  PREVIEW_PANEL_ID,
  DEVTOOLS_PANEL_ID,
} from './dock';
import { setPreviewOpen, setDevtoolsOpen } from './shell-bridge';

export interface FilePanelParams {
  path: string;
}

/** A file editor panel: a pure DOM host the engine attaches a Monaco editor to. */
function EditorPanel(props: IDockviewPanelProps<FilePanelParams>) {
  return <div className="editor-host" data-file-path={props.params.path} />;
}

/** Custom file tab: icon + name + dirty dot / close, VS Code style. */
function FileTab(props: IDockviewPanelProps<FilePanelParams>) {
  const path = props.params.path;
  const name = path.split('/').pop() ?? path;
  const dirty = useEditorStore((s) => path in s.modifiedFiles);
  return (
    <div className="dv-file-tab" title={path}>
      <span className="editor-tab-icon">
        <FileIcon name={name} folder={false} />
      </span>
      <span className="editor-tab-label">{name}</span>
      <button
        className="editor-tab-close"
        aria-label={`Close ${name}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
      >
        {dirty ? <span className="editor-tab-dot" /> : '×'}
      </button>
    </div>
  );
}

export interface EditorDockProps {
  previewComponent: React.ComponentType;
  devtoolsComponent: React.ComponentType;
  onApi: (api: DockviewApi) => void;
  persistLayout: (dock: string) => void;
  persistedDock: string | undefined;
}

export function EditorDock({
  previewComponent: PreviewPane,
  devtoolsComponent: DevtoolsPane,
  onApi,
  persistLayout,
  persistedDock,
}: EditorDockProps) {
  // Which dock instance the store subscription is bound to (StrictMode fires
  // onReady on a thrown-away instance first; we bind to the LIVE one).
  const storeSubApi = useRef<DockviewApi | null>(null);

  const handleReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    onApi(api);
    (window as unknown as { __dockApi?: DockviewApi }).__dockApi = api;

    // Dock events → store. `syncing` suppresses echo while WE mutate the dock
    // from a store change.
    let syncing = false;
    api.onDidRemovePanel((panel) => {
      if (syncing) return;
      if (isFilePanel(panel.id)) {
        const path = pathFromPanelId(panel.id);
        const cur = useEditorStore.getState();
        if (cur.openFiles.includes(path)) {
          cur.closeTab(path);
          cur.requestEditorClose(path);
        }
      } else if (panel.id === PREVIEW_PANEL_ID) {
        setPreviewOpen(false);
      } else if (panel.id === DEVTOOLS_PANEL_ID) {
        setDevtoolsOpen(false);
      }
    });
    api.onDidActivePanelChange((e) => {
      if (syncing) return;
      const id = e.panel?.id;
      if (id && isFilePanel(id)) useEditorStore.getState().activateTab(pathFromPanelId(id));
    });

    // Build the grid, THEN start syncing the store. Sequencing matters:
    // addPanel can throw "invalid location" while the grid is still being
    // constructed, so we must not let any store fire reach the dock until the
    // grid is fully built and laid out. The store→dock subscription is
    // registered on a macrotask after the build completes; the engine's first
    // openFile (which fires before the dock exists) is caught by the reconcile.
    const build = () => {
      if (api.panels.length > 0) return;
      if (persistedDock) {
        try {
          api.fromJSON(JSON.parse(persistedDock));
          // Dock tabs are restored into the UI, but the zustand store starts
          // empty on every reload. Mirror file panels → openFiles/activeTab so
          // the engine can lazily hydrate Monaco into the *visible* host.
          const paths = api.panels
            .filter((p) => isFilePanel(p.id))
            .map((p) => pathFromPanelId(p.id));
          const activeId = api.activePanel?.id;
          const active =
            activeId && isFilePanel(activeId) ? pathFromPanelId(activeId) : paths[0] ?? null;
          useEditorStore.getState().replaceOpenTabs(paths, active);
          return;
        } catch (err) {
          console.error('[dock] failed to restore layout, building default', err);
        }
      }
      const st = useEditorStore.getState();
      const activeFile = st.activeTab && st.activeTab !== 'preview' ? st.activeTab : null;
      buildLayout(api, st.openFiles, activeFile);
    };
    build();

    // Persist the grid on every change (splits, drags, closes).
    api.onDidLayoutChange(() => {
      try {
        persistLayout(JSON.stringify(api.toJSON()));
      } catch {
        // serialization hiccup during teardown — ignore
      }
    });

    // Reflect panel presence into bridge state for the toolbar/engine.
    setPreviewOpen(!!api.getPanel(PREVIEW_PANEL_ID));
    setDevtoolsOpen(!!api.getPanel(DEVTOOLS_PANEL_ID));

    // Store → dock. Defer to a macrotask: the grid is built but not yet laid
    // out at the end of onReady, and the engine's openFile fires on the same
    // tick — a subscription fire then would hit a grid mid-layout and throw
    // "invalid location". Waiting one macrotask lets dockview finish its layout
    // pass, so every addPanel lands on a stable grid. Bound once per live dock.
    if (storeSubApi.current === api) return;
    storeSubApi.current = api;
    // Defer to a macrotask: the grid is built but not yet laid out at the end
    // of onReady, and the engine's openFile fires on the same tick — a grid
    // mutation then would throw "Invalid grid element". Registering the
    // subscription after a macrotask guarantees dockview finished its layout
    // pass, so every addPanel lands on a stable grid. Bound once per live dock.
    setTimeout(() => {
      const syncFromStore = () => {
        syncing = true;
        try {
          const st = useEditorStore.getState();
          for (const path of st.openFiles) {
            if (!api.getPanel(filePanelId(path))) openFile(api, path, st.activeTab === path);
          }
          if (st.activeTab && st.activeTab !== 'preview') {
            api.getPanel(filePanelId(st.activeTab))?.api.setActive();
            revealFileTab(api, st.activeTab);
          }
        } finally {
          syncing = false;
        }
      };
      // Reconcile files the engine opened before this subscription existed.
      syncFromStore();
      useEditorStore.subscribe((state, prev) => {
        syncing = true;
        try {
          let opened: string | null = null;
          for (const path of state.openFiles) {
            if (!prev.openFiles.includes(path)) {
              openFile(api, path, state.activeTab === path);
              opened = path;
            }
          }
          for (const path of prev.openFiles) {
            if (!state.openFiles.includes(path)) closeFile(api, path);
          }
          if (state.activeTab !== prev.activeTab && state.activeTab && state.activeTab !== 'preview') {
            const panel = api.getPanel(filePanelId(state.activeTab));
            if (panel && !panel.api.isActive) panel.api.setActive();
            revealFileTab(api, state.activeTab);
          } else if (opened && state.activeTab === opened) {
            // Newly opened + already marked active: setActive is a no-op inside
            // dockview, so we still need an explicit post-layout scroll.
            revealFileTab(api, opened);
          }
        } finally {
          syncing = false;
        }
      });
    }, 0);
  };

  return (
    <DockviewReact
      theme={themeDark}
      className="editor-dock"
      components={{
        editor: EditorPanel,
        preview: () => <PreviewPane />,
        devtools: () => <DevtoolsPane />,
      }}
      tabComponents={{ fileTab: FileTab }}
      onReady={handleReady}
    />
  );
}
