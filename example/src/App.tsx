/**
 * The IDE shell, laid out to faithfully emulate the VS Code workbench:
 *
 *   ┌──────────────────────── Title Bar (thin) ────────────────────────┐
 *   │A│ Explorer (Primary Side Bar) │  Editor region (tabs)  │         │
 *   │c│  — fixed region, NOT a tab  │  Editor / Preview      │  Panel  │
 *   │t│                             │  (dockview)            │ (bottom)│
 *   ├──────────────────────── Status Bar (thin) ───────────────────────┤
 *
 * Only the editor region uses dockview (tabs + splits). The Explorer is a
 * fixed, non-draggable, collapsible side region with its own header — exactly
 * like VS Code's Primary Side Bar. The bottom Panel (DevTools) is collapsible
 * and hides when closed. Side-bar width, panel height, and collapsed states
 * persist to localStorage.
 *
 * The imperative engine (main.tsx) attaches the monaco editor and iframes to
 * the plain DOM hosts rendered here via `shellRefs`, and pushes toolbar/status
 * state through the bridge. Neither side imports the other's internals.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import { Explorer } from './Explorer';
import { useEditorStore } from './store';
import { EditorDock } from './EditorDock';
import { PREVIEW_PANEL_ID, DEVTOOLS_PANEL_ID } from './dock';
import {
  shellRefs,
  shellActions,
  onShellReady,
  onDevtoolsOpen,
  setDevtoolsOpen,
  setPreviewOpen,
  setShellReady,
  markShellRendered,
  onStatusBar,
  getStatusBar,
  previewMounted,
  devtoolsMounted,
  type StatusBarState,
} from './shell-bridge';

import 'dockview-core/dist/styles/dockview.css';
import './dockview.css';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const LAYOUT_KEY = 'browser-vite-vscode-layout';
// v3: dockview layout built deterministically from the store's openFiles.
// Older blobs (v1 single-editor, v2 mid-refactor) are discarded so a stale
// serialized grid can't resurrect a broken arrangement.
const LAYOUT_VERSION = 3;

interface PersistedLayout {
  version: number;
  sideBarWidth: number;
  sideBarCollapsed: boolean;
  previewOpen: boolean;
  panelOpen: boolean;
  /** Serialized dockview grid (groups, splits, floating panels). Restored
   *  best-effort; open files are re-opened from the store afterwards. */
  dock?: string;
}

const DEFAULTS: PersistedLayout = {
  version: LAYOUT_VERSION,
  sideBarWidth: 260,
  sideBarCollapsed: false,
  previewOpen: true,
  panelOpen: false,
};

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== LAYOUT_VERSION) return DEFAULTS;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// Editor region: dockview. The whole grid (file tabs | preview | devtools) is
// owned by the `EditorDock` component and built via `dock.ts`. This file keeps
// only the two engine-facing panes (preview + devtools) and the shell chrome.
// ---------------------------------------------------------------------------

/** The preview pane: iframe + install console. Signals the engine once both
 *  hosts are mounted so it never touches a null ref. */
function PreviewPane() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    shellRefs.previewFrame = frameRef.current;
    shellRefs.installConsole = consoleRef.current;
    previewMounted.mark();
    return () => {
      shellRefs.previewFrame = null;
      shellRefs.installConsole = null;
      previewMounted.reset();
    };
  }, []);
  return (
    <div className="preview-host">
      <iframe
        ref={frameRef}
        className="pane-iframe"
        sandbox="allow-scripts allow-same-origin"
        title="preview"
      />
      <div ref={consoleRef} className="install-console hidden" />
    </div>
  );
}

/** The DevTools pane: chii iframe host (src is set lazily by the engine). */
function DevtoolsPane() {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    shellRefs.devtoolsFrame = frameRef.current;
    devtoolsMounted.mark();
    return () => {
      shellRefs.devtoolsFrame = null;
      devtoolsMounted.reset();
    };
  }, []);
  return (
    <div className="preview-host">
      <iframe ref={frameRef} className="pane-iframe" title="devtools" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Title Bar
// ---------------------------------------------------------------------------

function TitleBar({ onToggleDevtools }: { onToggleDevtools: () => void }) {
  const [ready, setReady] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [status, setStatus] = useState<StatusBarState>(getStatusBar());

  useEffect(() => onShellReady(setReady), []);
  useEffect(() => onDevtoolsOpen(setDevtoolsOpen), []);
  useEffect(() => onStatusBar(setStatus), []);

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-app">Browser-Vite Live Editor</span>
      </div>
      <div className="titlebar-right">
        <span
          ref={(el) => { shellRefs.status = el; }}
          className={`status-pill status-${status.statusType}`}
        >
          {status.status}
        </span>
        <button
          className={`tbtn${devtoolsOpen ? ' tbtn-active' : ''}`}
          onClick={onToggleDevtools}
          disabled={!ready}
          title="Toggle DevTools panel"
        >
          DevTools
        </button>
        <button className="tbtn" onClick={() => shellActions.install()} disabled={!ready} title="Install dependencies">
          Install
        </button>
        <label className="tbtn-autorun" title="Re-run on edit">
          <input ref={(el) => { shellRefs.autoRunCheckbox = el; }} type="checkbox" defaultChecked disabled={!ready} />
          Auto-run
        </label>
        <button className="tbtn tbtn-primary" onClick={() => shellActions.run()} disabled={!ready} title="Run now">
          Run
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Side Bar: a horizontal tool rail on top (view icons), then the project
// header (collapsible, named after the project), then the Explorer tree.
// ---------------------------------------------------------------------------

interface SideBarProps {
  projectName: string;
  projectCollapsed: boolean;
  onToggleProject: () => void;
  previewOpen: boolean;
  onTogglePreview: () => void;
}

function ToolIcon({ title, active, onClick, children }: {
  title: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`tool-item${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SideBar({ projectName, projectCollapsed, onToggleProject, previewOpen, onTogglePreview }: SideBarProps) {
  return (
    <>
      <div className="sidebar-toolrail">
        <ToolIcon title="Explorer" active>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </ToolIcon>
        <ToolIcon title="Search (coming soon)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </ToolIcon>
        <ToolIcon title="Run and Debug (coming soon)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 4l14 8-14 8z" />
          </svg>
        </ToolIcon>
        <span className="toolrail-spacer" />
        <ToolIcon title={previewOpen ? 'Hide Preview' : 'Show Preview'} active={previewOpen} onClick={onTogglePreview}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M2 9h20" />
          </svg>
        </ToolIcon>
      </div>
      <button className="sidebar-project" onClick={onToggleProject} aria-expanded={!projectCollapsed}>
        <span className={`project-chevron${projectCollapsed ? ' collapsed' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 4l5 4-5 4z" transform="rotate(90 8 8)" />
          </svg>
        </span>
        <span className="project-name">{projectName}</span>
      </button>
      {!projectCollapsed && (
        <div className="sidebar-content">
          <Explorer />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Status Bar
// ---------------------------------------------------------------------------

function StatusBar() {
  const [status, setStatus] = useState<StatusBarState>(getStatusBar());
  useEffect(() => onStatusBar(setStatus), []);
  const currentFile = useEditorStore((s) => s.currentFile);
  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span className="statusbar-item statusbar-file">
          {currentFile ?? 'No file open'}
        </span>
      </div>
      <div className="statusbar-right">
        <span ref={(el) => { shellRefs.depsStatus = el; }} className="statusbar-item">
          {status.deps}
        </span>
        <span className="statusbar-item statusbar-lang">{currentFile?.split('.').pop() ?? ''}</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Shell root
// ---------------------------------------------------------------------------

export function App() {
  const [layout] = useState<PersistedLayout>(loadLayout);
  const [sideBarWidth, setSideBarWidth] = useState(layout.sideBarWidth);
  const [sideBarCollapsed, setSideBarCollapsed] = useState(layout.sideBarCollapsed);
  const [previewOpen, setPreviewOpenState] = useState(layout.previewOpen);
  const [panelOpen, setPanelOpenState] = useState(layout.panelOpen);
  const [projectCollapsed, setProjectCollapsed] = useState(false);
  const dockRef = useRef<DockviewApi | null>(null);

  // Project name from /package.json (falls back to a generic label).
  const projectName = useEditorStore((s) => {
    try {
      return JSON.parse(s.fileSystem['/package.json']?.content ?? '{}').name ?? 'project';
    } catch {
      return 'project';
    }
  });

  // Persist whenever a layout dimension changes.
  useEffect(() => {
    try {
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({
          version: LAYOUT_VERSION,
          sideBarWidth,
          sideBarCollapsed,
          previewOpen,
          panelOpen,
          dock: dockRef.current?.toJSON() ? JSON.stringify(dockRef.current.toJSON()) : undefined,
        } satisfies PersistedLayout),
      );
    } catch {
      // ignore serialization hiccups
    }
  }, [sideBarWidth, sideBarCollapsed, previewOpen, panelOpen]);

  // The dockview root is mounted in this first render, so the engine can start
  // once its panels exist. Signal readiness.
  useEffect(() => {
    markShellRendered();
    setShellReady(true);
  }, []);

  // The dock owns its grid entirely (built once in onReady, synced from the
  // store). App just holds the live api so the toolbar can toggle panes.
  const handleDockApi = (api: DockviewApi) => {
    dockRef.current = api;
  };

  // Persist the serialized dock grid (called by EditorDock on every change).
  const persistDock = (dock: string) => {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...prev, version: LAYOUT_VERSION, dock }));
  };

  // --- Side bar resize ------------------------------------------------------
  //
  // The sidebar keeps its manual sash (it's outside the dock); dockview owns
  // every other split. During the drag we disable pointer events on iframes so
  // the cursor never crosses into one and loses the mousemove stream.
  const sizeRef = useRef({ sideBarWidth });
  sizeRef.current = { sideBarWidth };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startPos = e.clientX;
    const startSize = sizeRef.current.sideBarWidth;
    const sash = e.currentTarget as HTMLElement;
    document.body.classList.add('is-resizing');
    sash.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const w = Math.min(Math.max(200, startSize + (ev.clientX - startPos)), window.innerWidth * 0.5);
      setSideBarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      document.body.classList.remove('is-resizing');
      sash.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };

  // Ctrl/Cmd+B toggles the Primary Side Bar (VS Code parity).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSideBarCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const togglePreviewPanel = () => {
    const api = dockRef.current;
    if (!api) return;
    const existing = api.getPanel(PREVIEW_PANEL_ID);
    if (existing) {
      existing.api.close(); // onDidRemovePanel flips state + bridge
    } else {
      const codePanel = api.panels.find((p) => p.id.startsWith('file:'));
      api.addPanel({
        id: PREVIEW_PANEL_ID,
        component: 'preview',
        title: 'Preview',
        position: codePanel
          ? { referencePanel: codePanel.id, direction: 'right' }
          : { direction: 'right' },
      });
      setPreviewOpenState(true);
      setPreviewOpen(true);
    }
  };

  const handleToggleDevtools = () => {
    const api = dockRef.current;
    if (!api) return;
    const existing = api.getPanel(DEVTOOLS_PANEL_ID);
    if (existing) {
      existing.api.close(); // onDidRemovePanel flips state + bridge
    } else {
      api.addPanel({
        id: DEVTOOLS_PANEL_ID,
        component: 'devtools',
        title: 'DevTools',
        position: { direction: 'below' },
      });
      setPanelOpenState(true);
      setDevtoolsOpen(true);
      shellActions.toggleDevtools(); // engine lazy-loads chii
    }
  };

  return (
    <div className="workbench">
      <TitleBar onToggleDevtools={handleToggleDevtools} />
      <div className="workbench-body">
        {!sideBarCollapsed && (
          <>
            <aside className="sidebar" style={{ width: sideBarWidth }}>
              <SideBar
                projectName={projectName}
                projectCollapsed={projectCollapsed}
                onToggleProject={() => setProjectCollapsed((c) => !c)}
                previewOpen={previewOpen}
                onTogglePreview={togglePreviewPanel}
              />
            </aside>
            <div className="sash sash-vertical" onMouseDown={startDrag} />
          </>
        )}
        <div className="editor-area">
          <EditorDock
            previewComponent={PreviewPane}
            devtoolsComponent={DevtoolsPane}
            onApi={handleDockApi}
            persistLayout={persistDock}
            persistedDock={layout.dock}
          />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
