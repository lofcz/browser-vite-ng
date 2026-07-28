/**
 * Browser-Vite Live Editor Example
 *
 * Features:
 * - Virtual file system with multiple files
 * - Browsable file tree
 * - Monaco editor (modern-monaco) for editing code
 * - Live preview in iframe with HMR
 * - Module resolution between files
 */

// Install Node globals (process, Buffer) BEFORE any browser-vite/dep code runs.
import 'browser-vite/shims/globals';

import './index.css';
import './vscode-explorer.css';

// react-scan: render-performance inspector. Localhost/dev only — never shipped
// in the production (GitHub Pages) build.
if (import.meta.env.DEV) {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/react-scan/dist/auto.global.js';
  s.async = true;
  document.head.appendChild(s);
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { init, Workspace } from 'modern-monaco';
import { editorStore, useEditorStore, isDependencyPath, type VirtualFile } from './store';
import { VFSFileSystem } from './monaco-fs';
import { bindBrowserVite, bindMonacoHooks } from './fs-ops';
import { App } from './App';
import {
  shellRefs,
  bindShellActions,
  setShellReady,
  setStatusBar,
  shellReady,
  onDevtoolsOpen,
  onPreviewOpen,
  previewMounted,
  devtoolsMounted,
} from './shell-bridge';
// Vendored tsconfig JSON schema (json.schemastore.org/tsconfig) so the JSON LSP
// validates tsconfig.json without a network fetch (works offline / GitHub Pages).
import tsconfigSchema from './vendor/tsconfig.schema.json';

type MonacoNS = Awaited<ReturnType<typeof init>>;
import { BrowserVite } from './browser-vite-wrapper';
import {
  createViteHmrIframeHtml,
  prepareError,
  sendHotPayload,
  type HotPayload,
} from './hmr-bridge';
import { readVirtualFile } from 'browser-vite';
import { installDependencies } from './installer';
import { bundleDeps, defaultEntrySpecifiers } from './dep-bundler';
import { depCacheKey, loadDepCache, saveDepCache } from './dep-cache';
// es-module-lexer@2.3.1 ESM source (incl. base64 WASM) served to the iframe so
// it can tokenize import specifiers with exact indices instead of regex.
import esModuleLexerSrc from './vendor/es-module-lexer.js?raw';
// Precompiled iframe runtime + /@vite/client module (built by the
// iframe-runtime Vite plugin at build/dev time — no runtime Oxc needed).
import {
  iframeRuntimeJs,
  iframeClientJs,
  reactRefreshJs,
} from 'virtual:iframe-runtime';

// =============================================================================
// Virtual File System
// =============================================================================

// Initial file system with a multi-file React app
const initialFiles: VirtualFile[] = [
  {
    path: '/tsconfig.json',
    type: 'json',
    content: JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          allowJs: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          // Lenient like a playground: don't flag implicit-any from untyped
          // local modules (TS7016) — the editor should resolve, not nag.
          strict: false,
          noImplicitAny: false,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          isolatedModules: true,
        },
      },
      null,
      2,
    ),
  },
  {
    path: '/index.html',
    type: 'html',
    content: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Browser-Vite Demo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  },
  {
    path: '/src/main.tsx',
    type: 'tsx',
    content: `// Entry module — renders the app into #root (real Vite scaffold shape).
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
  },
  {
    path: '/src/App.tsx',
    type: 'tsx',
    content: `// Main App Component
import React from 'react';
import { Counter } from './Counter.tsx';
import { Header } from './components/Header.tsx';
import { greeting } from './utils.ts';

export default function App() {
  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      padding: '40px',
      textAlign: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      minHeight: '100vh',
      color: 'white'
    }}>
      <Header title="Browser-Vite Demo" />
      <p>{greeting('Developer')}</p>
      <Counter initialCount={0} />
    </div>
  );
}
`,
  },
  {
    path: '/src/Counter.tsx',
    type: 'tsx',
    content: `// Counter Component
import React, { useState } from 'react';
import { Plus, Minus, RotateCcw } from 'lucide-react';
import { Button } from './components/Button.tsx';

interface CounterProps {
  initialCount: number;
}

const iconStyle: React.CSSProperties = {
  display: 'inline-block',
  verticalAlign: 'middle',
  marginRight: '6px',
};

export function Counter({ initialCount }: CounterProps) {
  const [count, setCount] = useState(initialCount);

  return (
    <div style={{ margin: '20px 0' }}>
      <div style={{ fontSize: '48px', marginBottom: '20px' }}>
        {count}
      </div>
      <Button onClick={() => setCount(c => c + 1)} primary>
        <Plus size={16} style={iconStyle} />
        Increment
      </Button>
      <Button onClick={() => setCount(c => c - 1)}>
        <Minus size={16} style={iconStyle} />
        Decrement
      </Button>
      <Button onClick={() => setCount(initialCount)}>
        <RotateCcw size={16} style={iconStyle} />
        Reset
      </Button>
    </div>
  );
}
`,
  },
  {
    path: '/src/components/Header.tsx',
    type: 'tsx',
    content: `// Header Component
import React from 'react';

interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  return (
    <header>
      <h1 style={{
        fontSize: '2.5rem',
        marginBottom: '10px',
        textShadow: '2px 2px 4px rgba(0,0,0,0.2)'
      }}>
        {title}
      </h1>
    </header>
  );
}
`,
  },
  {
    path: '/src/components/Button.tsx',
    type: 'tsx',
    content: `// Button Component
import React from 'react';

interface ButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}

export function Button({ children, onClick, primary }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 24px',
        fontSize: '16px',
        background: primary ? 'white' : 'transparent',
        color: primary ? '#667eea' : 'white',
        border: primary ? 'none' : '2px solid white',
        borderRadius: '8px',
        cursor: 'pointer',
        fontWeight: 'bold',
        marginRight: '10px',
        transition: 'transform 0.1s',
      }}
      onMouseOver={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
      onMouseOut={(e) => e.currentTarget.style.transform = 'scale(1)'}
    >
      {children}
    </button>
  );
}
`,
  },
  {
    path: '/src/NumberDemo.tsx',
    type: 'tsx',
    content: `import React, { useState } from 'react';
import { NumberFlowInput } from '@daformat/react-number-flow-input';

export function NumberDemo() {
  const [value, setValue] = useState(1000);
  return <NumberFlowInput value={value} onChange={setValue} />;
}
`,
  },
  {
    path: '/src/utils.ts',
    type: 'ts',
    content: `// Utility functions

export function greeting(name: string): string {
  return \`Welcome, \${name}! Edit the files to see live updates.\`;
}

export function formatNumber(num: number): string {
  return num.toLocaleString();
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}
`,
  },
  {
    path: '/src/styles.css',
    type: 'css',
    content: `/* Global Styles */

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  font-family: system-ui, -apple-system, sans-serif;
}

/* Animation keyframes */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

.fade-in {
  animation: fadeIn 0.3s ease-out;
}

/* Button hover effects */
button:hover {
  filter: brightness(1.1);
}

button:active {
  transform: scale(0.98);
}
`,
  },
  {
    path: '/package.json',
    type: 'json',
    content: `{
  "name": "browser-vite-demo",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "lucide-react": "^1.27.0"
  },
  "devDependencies": {
    "@types/react": "^19",
    "@types/react-dom": "^19"
  }
}
`,
  },
];

// Initialize file system
function initFileSystem() {
  editorStore.getState().setFiles(initialFiles);
}

// Convenience accessors over the store (imperative HMR paths).
const fs = () => editorStore.getState().fileSystem;
/** Project file, or a dependency source opened from /node_modules. */
const getFile = (path: string) =>
  fs()[path] ?? editorStore.getState().dependencyFiles[path];
const currentFile = () => editorStore.getState().currentFile;

// =============================================================================
// UI Elements
// =============================================================================

// DOM hosts are rendered by the React shell's dock panels and exposed through
// shellRefs. The Preview/DevTools panels mount ASYNCHRONOUSLY (dockview
// renders their content after addPanel), so engine code paths that touch them
// must first `await previewMounted.promise` / `devtoolsMounted.promise`.
const previewFrame = () => shellRefs.previewFrame!;
// Nullable on purpose: a restored dock layout may not contain the Preview
// panel, and install must still run (and log) without its console host.
const installConsoleEl = () => shellRefs.installConsole;
const autoRunCheckbox = () => shellRefs.autoRunCheckbox!;
const devtoolsFrame = () => shellRefs.devtoolsFrame;

let browserVite: BrowserVite | null = null;
let monaco: MonacoNS | null = null;
type IEditor = ReturnType<MonacoNS['editor']['create']>;
let workspace: Workspace | null = null;
let debounceTimer: number | null = null;
let updateCounter = 0;
let iframeReady = false;

// =============================================================================
// Logging
// =============================================================================

function log(message: string, type: 'info' | 'success' | 'error' | 'warn' | 'hmr' = 'info') {
  const prefix = type === 'hmr' ? '[HMR]' : `[${type.toUpperCase()}]`;
  console.log(prefix, message);
}

function setStatus(message: string, type: 'success' | 'error' | 'pending') {
  setStatusBar({ status: message, statusType: type });
}

// =============================================================================
// Install Console (preview-pane progress during dependency install)
// =============================================================================

const installConsoleStyles: Record<string, string> = {
  info: 'text-[#c9d1d9]',
  success: 'text-[#3fb950]',
  error: 'text-[#f85149]',
  warn: 'text-[#d29922]',
  dim: 'text-[#8b949e]',
};

/** Show the console overlay in the preview pane, optionally clearing it. */
function showInstallConsole(clear = true) {
  const el = installConsoleEl();
  if (!el) return;
  if (clear) el.innerHTML = '';
  installProgressLine = null;
  el.classList.remove('hidden');
}

/** Hide the console overlay, revealing the preview iframe again. */
function hideInstallConsole() {
  installConsoleEl()?.classList.add('hidden');
}

/** Append a line to the install console (ANSI-style colored, autoscrolls). */
function installLog(message: string, kind: keyof typeof installConsoleStyles = 'info') {
  flushInstallProgress();
  // Finalize any in-place progress line: overwrite it with the completed
  // message instead of appending a new line (progress → result on one line).
  const el = installConsoleEl();
  if (!el) return;
  if (installProgressLine) {
    installProgressLine.className = installConsoleStyles[kind];
    installProgressLine.textContent = message;
    installProgressLine = null;
    el.scrollTop = el.scrollHeight;
    return;
  }
  const line = document.createElement('div');
  line.className = installConsoleStyles[kind];
  line.textContent = message;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

let installProgressLine: HTMLDivElement | null = null;
let pendingProgress: string | null = null;
let progressRaf = 0;

/**
 * Update the in-place progress line (like a package-manager spinner). DOM
 * writes are coalesced to one per animation frame so thousands of install /
 * bundle events per second never force layout — this keeps install fast.
 */
function installProgress(message: string) {
  pendingProgress = message;
  if (progressRaf) return;
  progressRaf = requestAnimationFrame(() => {
    progressRaf = 0;
    if (pendingProgress === null) return;
    const text = pendingProgress;
    pendingProgress = null;
    const el = installConsoleEl();
    if (!el) return;
    if (!installProgressLine) {
      installProgressLine = document.createElement('div');
      installProgressLine.className = installConsoleStyles.dim;
      el.appendChild(installProgressLine);
    }
    installProgressLine.textContent = text;
    el.scrollTop = el.scrollHeight;
  });
}

/** Flush any queued progress synchronously (before finalizing a line). */
function flushInstallProgress() {
  if (progressRaf) {
    cancelAnimationFrame(progressRaf);
    progressRaf = 0;
  }
  pendingProgress = null;
}

// =============================================================================
// File Explorer (@pierre/trees, React) — see Explorer.tsx
// =============================================================================

function updateCurrentFileName(path: string | null) {
  // The shell renders the current file itself from the store; mirror it into
  // status-bar state for any consumers that read it from the bridge.
  setStatusBar({ currentFile: path });
}

useEditorStore.subscribe((state, prev) => {
  if (state.currentFile !== prev.currentFile) updateCurrentFileName(state.currentFile);
});

// =============================================================================
// Editor
// =============================================================================

function getFileType(path: string): 'tsx' | 'ts' | 'css' | 'json' | 'html' {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.html')) return 'html';
  return 'ts';
}

/** Map a file path to a Monaco language id (Shiki grammar names). */
function getMonacoLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'tsx': return 'tsx';
    case 'ts':
    case 'mts':
    case 'cts': return 'typescript';
    case 'jsx': return 'jsx';
    case 'js':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'css': return 'css';
    case 'html': return 'html';
    case 'json': return 'json';
    case 'md': return 'markdown';
    default: return 'plaintext';
  }
}

// =============================================================================
// Editors — ONE PER OPEN FILE (dockable).
//
// Every open file gets its own Monaco editor instance, created into the
// dockview panel's DOM host (`data-file-path`). All editors for a file share
// the file's single Monaco model, so undo stack, cursor, and scroll are
// preserved per file, and the TS worker keeps one document per file.
//
// modern-monaco never attaches models on its own: its TS worker resolves
// imports and calls `openModel(uri)`, which routes through
// `workspace._openTextDocument`. Our override (in initialize) creates +
// registers the dependency model but NEVER attaches it to any editor, so
// background resolution can't hijack a visible editor.
// =============================================================================

// Models we've wired to the store (content → VFS sync). WeakSet so re-opening
// never stacks duplicate listeners, and disposed models are GC'd freely.
const wiredModels = new WeakSet<object>();

type MonacoModel = ReturnType<MonacoNS['editor']['createModel']>;

/** Live editors, keyed by the file path their panel shows. */
const editorsByPath = new Map<string, IEditor>();

/** Wire a model's edits back into the VFS store + schedule HMR. Idempotent. */
function wireModelContentSync(model: MonacoModel) {
  if (wiredModels.has(model)) return;
  wiredModels.add(model);
  // Read the path from the model's OWN uri — not a captured variable — so a
  // model can never write its content to the wrong file.
  model.onDidChangeContent(() => {
    const p = model.uri.path;
    editorStore.getState().setFileContent(p, model.getValue());
    editorStore.getState().markModified(p);
    scheduleUpdate();
  });
}

/** Get (or create) the model for a VFS path with the correct language. */
function getOrCreateModel(path: string, content: string) {
  const m = monaco!;
  const uri = m.Uri.file(path);
  const lang = getMonacoLanguage(path);
  let model = m.editor.getModel(uri);
  if (!model) {
    model = m.editor.createModel(content, lang, uri);
  } else if (model.getLanguageId() !== lang) {
    m.editor.setModelLanguage(model, lang);
  }
  return model;
}

const EDITOR_OPTIONS = {
  theme: 'dark-plus',
  automaticLayout: true,
  fontSize: 13,
  minimap: { enabled: false },
  padding: { top: 8, bottom: 8 },
  scrollBeyondLastLine: false,
  tabSize: 2,
  // Paste: modern-monaco defaults editContext:false + pasteAs.enabled:false.
  // Keep pasteAs off here too — CopyPasteController otherwise claims the paste
  // event and hangs on navigator.clipboard.read() while clipboard-read is
  // "prompt", so Ctrl+V / context-menu Paste insert nothing.
  pasteAs: { enabled: false },
  // Avoid "monospace assumptions have been violated" when web fonts / DPR
  // shift measured glyph width away from the assumed monospace advance.
  disableMonospaceOptimizations: true,
  // Render hover/suggest/parameter-hint popovers in a position:fixed layer
  // appended to <body> instead of inside the editor's overflow container, so
  // they aren't clipped by the `overflow-hidden` editor/flex ancestors.
  fixedOverflowWidgets: true,
} as const;

/** Find the dockview panel host for a file (rendered by the shell). With
 *  renderer="always" each file has exactly one live host; pick the connected
 *  one defensively in case of a transient duplicate during grid teardown. */
function fileHost(path: string): HTMLElement | null {
  const hosts = document.querySelectorAll<HTMLElement>(`.editor-host[data-file-path="${path}"]`);
  for (const h of hosts) if (h.isConnected) return h;
  return hosts[0] ?? null;
}

/** Create (or return) the Monaco editor for a file's dock panel. */
function ensureEditor(path: string): IEditor | null {
  if (!monaco) return null;
  const existing = editorsByPath.get(path);
  if (existing) return existing;
  const host = fileHost(path);
  const file = getFile(path);
  if (!host || !file) return null;
  const model = getOrCreateModel(path, file.content);
  const readOnly = isDependencyPath(path);
  const ed = monaco.editor.create(host, { ...EDITOR_OPTIONS, readOnly });
  ed.setModel(model);
  // Dependency sources are installed artifacts: never sync their edits back
  // into the VFS, or a stray keystroke would rewrite an installed package.
  if (!readOnly) wireModelContentSync(model);
  editorsByPath.set(path, ed);
  return ed;
}

/** Dispose a file's editor (panel closed / file deleted). The model survives
 *  so undo state is kept if the file re-opens. */
function disposeEditor(path: string) {
  const ed = editorsByPath.get(path);
  if (ed) {
    editorsByPath.delete(path);
    ed.dispose();
  }
}

/** Rename/move every editor under a path (file or directory subtree). Each is
 *  disposed; the store's openFiles sync re-creates it under the new path. */
function renameEditors(from: string, _to: string) {
  for (const [path, ed] of [...editorsByPath]) {
    if (path === from || path.startsWith(from + '/')) {
      editorsByPath.delete(path);
      ed.dispose();
    }
  }
}

/** Open a VFS file: store-driven. The shell adds the dock panel; our observer
 *  (below) creates the editor into it. */
function openFile(path: string) {
  const file = getFile(path);
  if (!file) {
    log(`File not found: ${path}`, 'error');
    return;
  }
  if (!monaco) {
    log(`Editor not ready — cannot open ${path}`, 'warn');
    return;
  }
  editorStore.getState().openTab(path);
  editorStore.getState().setSelectedItems([path]);
  log(`Opened file: ${path}`, 'info');
}

type SelectionOrPosition =
  | { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  | { lineNumber: number; column: number };

/**
 * Open a path in a tab and return its model, reading dependency sources
 * straight from the VFS. Used by every "navigate the user here" path
 * (go-to-definition, peek, editor history).
 */
async function revealPath(path: string, readonlyContent?: string): Promise<MonacoModel | null> {
  if (!monaco) return null;
  if (getFile(path)) {
    openFile(path);
    return getOrCreateModel(path, getFile(path)!.content);
  }
  if (!isDependencyPath(path)) {
    log(`File not found: ${path}`, 'error');
    return null;
  }
  let content = readonlyContent;
  if (content === undefined) {
    try {
      content = await workspace!.fs.readTextFile(new URL(path, 'file:///').href);
    } catch {
      log(`Dependency source not found: ${path}`, 'warn');
      return null;
    }
  }
  editorStore.getState().openDependencyFile({
    path,
    content,
    type: getFileType(path),
  });
  log(`Opened dependency: ${path}`, 'info');
  return getOrCreateModel(path, content);
}

/**
 * Move the cursor to a definition target once its editor exists. The dock
 * mounts panel content asynchronously, so the editor for a just-opened tab
 * usually isn't there yet on this tick.
 */
function revealSelection(path: string, sel: SelectionOrPosition, attempt = 0) {
  const ed = editorsByPath.get(path) ?? ensureEditor(path);
  if (!ed) {
    if (attempt < 40) setTimeout(() => revealSelection(path, sel, attempt + 1), 25);
    return;
  }
  if ('startLineNumber' in sel) {
    ed.setSelection(sel);
    ed.revealRangeInCenterIfOutsideViewport(sel);
  } else {
    ed.setPosition(sel);
    ed.revealPositionInCenterIfOutsideViewport(sel);
  }
  ed.focus();
}

/**
 * Lazily attach Monaco to the *visible* file tab only. Inactive restored tabs
 * keep their dock panel/host but stay unhydrated until activated — hosts for
 * hidden panels often aren't in the DOM yet, so creating into them fails.
 */
function hydrateVisibleEditor(path: string | null | undefined) {
  if (!monaco || !path || path === 'preview') return;
  let tries = 0;
  const tryCreate = () => {
    if (editorsByPath.has(path)) return;
    if (getFile(path) && fileHost(path)) {
      ensureEditor(path);
      return;
    }
    if (++tries < 40) setTimeout(tryCreate, 25);
  };
  tryCreate();
}

// Store → editor lifecycle. Only the active file tab is hydrated; closed tabs
// dispose their editor. Panel hosts mount asynchronously relative to the store
// write, so hydrateVisibleEditor retries briefly.
useEditorStore.subscribe((state, prev) => {
  if (!monaco) return;
  for (const path of prev.openFiles) {
    if (!state.openFiles.includes(path)) disposeEditor(path);
  }
  if (
    state.activeTab !== prev.activeTab
    || (typeof state.activeTab === 'string'
      && state.activeTab !== 'preview'
      && !editorsByPath.has(state.activeTab))
  ) {
    hydrateVisibleEditor(state.activeTab);
  }
});

// Shell-driven dock closes (× on a dock tab) → dispose the editor.
useEditorStore.subscribe((state, prev) => {
  if (state.editorCloseRequest && state.editorCloseRequest !== prev.editorCloseRequest) {
    disposeEditor(state.editorCloseRequest.path);
  }
});

// Renames: dispose editors under the old subtree; re-created on next open.
useEditorStore.subscribe((state, prev) => {
  if (state.fileSystem === prev.fileSystem) return;
  for (const path of [...editorsByPath.keys()]) {
    if (!state.fileSystem[path]) disposeEditor(path);
  }
});

// =============================================================================
// Module serving (real ESM via BrowserServer; no regex bundling / eval)
// =============================================================================

/**
 * Transform the entry and all VFS files through the real dev pipeline
 * (oxc → import-analysis → ModuleGraph) so the preview can import them as
 * native ESM. Returns the entry URL to hand to the iframe bootstrap.
 */
/** Vite's `transformRequest` error for a module that isn't on disk. */
function missingEntryError(entry: string): Error & { code: string } {
  const err = new Error(
    `Failed to load url ${entry} (resolved id: ${entry}). Does the file exist?`,
  ) as Error & { code: string };
  err.code = 'ERR_LOAD_URL';
  // The stack would be the host's own call frames — inside the IDE's
  // `main.tsx`, which reads like the project file the message is about. Nothing
  // in it points at the user's code, so don't put it in front of them.
  err.stack = '';
  return err;
}

/**
 * Surface a failed bootstrap as Vite's `error` HotPayload, which raises the
 * iframe's overlay. A missing entry never reaches `transformRequest`, so the
 * server never broadcasts for it — the host has to.
 */
function reportPreviewError(entryPath: string, err: unknown) {
  // prepareError keeps any `loc`/`frame` the transform attached, so a failing
  // entry shows its real position instead of just a message.
  const payload = prepareError(err, entryPath);
  sendHotPayload(previewFrame(), { type: 'error', err: payload });
  log(`Preview failed: ${payload.message}`, 'error');
}

async function prepareModules(entry: string): Promise<string> {
  if (!browserVite) throw new Error('BrowserVite not initialized');
  await syncFilesToBrowserVite();
  // Never synthesize missing entries as empty content: BrowserVite.transform
  // would setFile(entry, '') and resurrect a deleted/moved path, then the
  // iframe would import a no-op module and clear the error overlay — dark
  // preview with no HMR error. Match Vite's ERR_LOAD_URL wording instead.
  const file = getFile(entry);
  if (!file) throw missingEntryError(entry);
  // Warm the graph so import-analysis has rewritten every import specifier to
  // a servable URL before the iframe starts importing.
  await browserVite.transform(file.content, entry);
  return entry;
}

// =============================================================================
// HMR Runtime (real Vite 8 client semantics, blob-URL ESM serving)
// =============================================================================

/**
 * Preview iframe with Vite HotPayload client (full HMRClient semantics).
 * Host sends { type: 'vite-hmr', payload } — same shapes as Vite 8 WebSocket.
 *
 * The document is built from the project's REAL /index.html (its <title>,
 * <meta>, and <body> content are honored), with the HMR runtime module +
 * error-overlay styles injected — the analogue of Vite injecting /@vite/client
 * into your HTML at dev time.
 */
function createHMRRuntime(): string {
  // Precompiled modules (plain JS). Blob-serve client + lexer, expose their
  // URLs on window, then run the precompiled runtime module.
  const clientBootstrap = `
    window.__VITE_CLIENT_URL = URL.createObjectURL(new Blob([${JSON.stringify(iframeClientJs)}], { type: 'text/javascript' }));
    window.__ES_MODULE_LEXER_URL = URL.createObjectURL(new Blob([${JSON.stringify(esModuleLexerSrc)}], { type: 'text/javascript' }));
    window.__REACT_REFRESH_URL = URL.createObjectURL(new Blob([${JSON.stringify(reactRefreshJs)}], { type: 'text/javascript' }));
${iframeRuntimeJs}
  `;

  const indexHtml =
    getFile('/index.html')?.content ??
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div></body></html>';
  return createViteHmrIframeHtml(indexHtml, clientBootstrap);
}

// =============================================================================
// Preview Update
// =============================================================================

/** Sync VFS → browserVite and ensure graph entries exist for all files.
 *
 *  Files are addressed by their MAP KEY, never by `file.path`: the key is the
 *  store's identity for a file, so a record whose own `path` has drifted can't
 *  resurrect a deleted module here (which would look like a spurious change to
 *  browser-vite and trigger a page reload). */
async function syncFilesToBrowserVite() {
  if (!browserVite) return;
  for (const [path, file] of Object.entries(fs())) {
    browserVite.setFile(path, file.content);
  }
  // Transform entry + deps so ModuleGraph edges / accept boundaries exist.
  // Tolerate per-file transform errors: BrowserServer already broadcasts an
  // `error` HotPayload for a failed transform, and a file currently in an
  // error state must not abort the whole sync (that would prevent recovery
  // when the file is later fixed).
  for (const [path, file] of Object.entries(fs())) {
    if (file.type === 'css' || file.type === 'ts' || file.type === 'tsx') {
      try {
        await browserVite.transform(file.content, path);
      } catch {
        // error payload already sent by the server; continue syncing others
      }
    }
  }
}

/**
 * Read the entry module from the project's real /index.html — the
 * `<script type="module" src="...">` a real Vite project uses. Falls back to
 * /src/main.tsx when absent. Parsed via DOMParser (no regex on HTML).
 */
function getEntryFromIndexHtml(): string {
  const html = getFile('/index.html')?.content;
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const src = doc.querySelector('script[type="module"]')?.getAttribute('src');
    if (src) return src.startsWith('/') ? src : '/' + src;
  }
  log('No <script type="module"> in /index.html — falling back to /src/main.tsx', 'warn');
  return '/src/main.tsx';
}

/** Initial / full bootstrap: serve the entry as real ESM into the iframe. */
async function bootstrapPreview() {
  if (!browserVite || !iframeReady) return;
  const entryPath = getEntryFromIndexHtml();
  try {
    const entry = await prepareModules(entryPath);
    previewFrame().contentWindow?.postMessage(
      { type: 'hmr-update', entry, fileType: getFileType(entry) },
      '*',
    );
    log(`Bootstrap entry sent to iframe (real ESM serving): ${entry}`, 'hmr');
  } catch (err) {
    // Report the failure instead of posting an `hmr-update`, which the iframe
    // would treat as a clean render and use to clear the overlay.
    reportPreviewError(entryPath, err);
  }
}

/**
 * Full-fidelity HMR path: Vite updateModules / propagateUpdate → HotPayload.
 */
async function updatePreview() {
  if (!browserVite) {
    log('Cannot update: browserVite not ready', 'warn');
    return;
  }

  const cur = currentFile();
  const curEditor = cur ? editorsByPath.get(cur) : undefined;
  if (cur && curEditor) {
    const content = curEditor.getValue();
    editorStore.getState().setFileContent(cur, content);
    browserVite.setFile(cur, content);
  }

  // Non-code files (package.json etc.) aren't modules — skip the HMR pipeline.
  // Dependency changes take effect via the Install button, which rebundles.
  const currentType = getFileType(cur ?? '');
  if (currentType === 'json') {
    log('package.json changed — click Install to apply dependency changes', 'warn');
    return;
  }
  // index.html is not an HMR module — like real Vite, a change triggers a
  // full reload. The browser-vite server sends `full-reload`; the host honors
  // it by rebuilding the iframe document from the LATEST VFS index.html (the
  // analogue of the dev server re-serving the page) and re-bootstrapping.
  if (currentType === 'html') {
    // Import-map-only edits are editor/TS concerns (stripped from the preview
    // document). A real markup change still needs a full iframe rebuild.
    log('index.html changed — full reload (rebuild document + re-bootstrap)', 'hmr');
    void initIframe();
    return;
  }

  updateCounter++;
  const updateId = updateCounter;
  log(`Starting HMR update #${updateId} for ${cur}`, 'hmr');

  try {
    if (!iframeReady) {
      log('Iframe not ready, queuing update...', 'warn');
      return;
    }

    const content = getFile(cur!)?.content ?? '';
    // Ensure graph is warm, then run full Vite HMR pipeline
    await syncFilesToBrowserVite();
    const ok = await browserVite.handleHMRUpdate(cur!, content);
    if (ok) {
      log(`handleHMRUpdate #${updateId} dispatched HotPayload(s)`, 'hmr');
    } else {
      log(`handleHMRUpdate #${updateId} failed`, 'error');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`HMR error: ${message}`, 'error');
  }
}

// =============================================================================
// CDP (Chrome DevTools Protocol) via Chobitsu
// =============================================================================

let cdpReady = false;
let cdpMessageId = 0;
const cdpCallbacks: Map<number, (result: any) => void> = new Map();
const cdpEventListeners: Map<string, Set<(params: any) => void>> = new Map();

// Send a CDP command to the iframe
function sendCDPCommand(method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!cdpReady) {
      reject(new Error('CDP not ready'));
      return;
    }

    const id = ++cdpMessageId;
    cdpCallbacks.set(id, resolve);

    const message = JSON.stringify({ id, method, params });
    previewFrame().contentWindow?.postMessage({ type: 'cdp-command', message }, '*');

    // Timeout after 10 seconds
    setTimeout(() => {
      if (cdpCallbacks.has(id)) {
        cdpCallbacks.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }
    }, 10000);
  });
}

// Subscribe to CDP events
function onCDPEvent(eventName: string, callback: (params: any) => void) {
  if (!cdpEventListeners.has(eventName)) {
    cdpEventListeners.set(eventName, new Set());
  }
  cdpEventListeners.get(eventName)!.add(callback);

  // Return unsubscribe function
  return () => {
    cdpEventListeners.get(eventName)?.delete(callback);
  };
}

// Handle CDP response from iframe
function handleCDPResponse(message: string) {
  try {
    const parsed = JSON.parse(message);

    // Handle response to a command
    if (parsed.id !== undefined) {
      const callback = cdpCallbacks.get(parsed.id);
      if (callback) {
        cdpCallbacks.delete(parsed.id);
        callback(parsed.result || parsed.error);
      }
    }

    // Handle event
    if (parsed.method) {
      const listeners = cdpEventListeners.get(parsed.method);
      if (listeners) {
        listeners.forEach((cb) => cb(parsed.params));
      }
    }
  } catch (e) {
    log(`CDP parse error: ${e}`, 'error');
  }
}

// =============================================================================
// Event Handlers
// =============================================================================

window.addEventListener('message', async (event) => {
  if (event.data?.type === 'hmr-ready') {
    iframeReady = true;
    log('Iframe HMR runtime ready', 'hmr');
    // Initial paint via bootstrap bundle; subsequent edits use HotPayload HMR
    await bootstrapPreview();
  } else if (event.data?.type === 'hmr-log') {
    log(`iframe: ${event.data.message}`, 'hmr');
  } else if (event.data?.type === 'runtime-error') {
    // Already source-mapped by the iframe runtime, so this names real project
    // files at original positions.
    const { kind, message, stack, file, line, column } = event.data;
    const where = file ? ` at ${file}:${line}:${column}` : '';
    log(`${kind}: ${message}${where}`, 'error');
    if (stack) log(stack, 'error');
  } else if (event.data?.type === 'hmr-fetch-module') {
    // Iframe asked for a fresh transformed module (real dev-server fetchModule).
    try {
      if (!browserVite) throw new Error('BrowserVite not ready');
      const path = event.data.path as string;
      // Well-known public paths served from precompiled bundles, not the VFS.
      if (path === '/@react-refresh') {
        previewFrame().contentWindow?.postMessage(
          { type: 'hmr-module', id: event.data.id, code: reactRefreshJs },
          '*',
        );
        return;
      }
      if (path === '/@vite/client') {
        previewFrame().contentWindow?.postMessage(
          { type: 'hmr-module', id: event.data.id, code: iframeClientJs },
          '*',
        );
        return;
      }
      // Optimized deps: /@deps/<file>.js -> /node_modules/.deps/<file>.js (VFS).
      if (path.startsWith('/@deps/')) {
        const vfsPath = `/node_modules/.deps/${path.slice('/@deps/'.length)}`;
        const code = readVirtualFile(vfsPath);
        if (code === undefined) throw new Error(`Optimized dep not found: ${path}`);
        previewFrame().contentWindow?.postMessage(
          { type: 'hmr-module', id: event.data.id, code },
          '*',
        );
        return;
      }
      const served = await browserVite.fetchModule(path);
      if (!served) throw new Error(`No module for ${path}`);
      if (event.data.css || path.endsWith('.css')) {
        // CSS dev module self-injects via updateStyle; send raw css for the
        // iframe's stylesheet swap as well.
        previewFrame().contentWindow?.postMessage(
          {
            type: 'hmr-module',
            id: event.data.id,
            code: getFile(path)?.content ?? '',
            css: true,
          },
          '*',
        );
      } else {
        // The map rides along with the code: the iframe re-bases it after
        // rewriting specifiers to blob URLs, then inlines it so DevTools and
        // stack traces resolve to real files.
        previewFrame().contentWindow?.postMessage(
          { type: 'hmr-module', id: event.data.id, code: served.code, map: served.map },
          '*',
        );
      }
    } catch (err) {
      // The message alone would strand the transform's file/line/frame on this
      // side; forward the full payload so the overlay can point at real source.
      const detail = prepareError(err, event.data.path as string);
      previewFrame().contentWindow?.postMessage(
        { type: 'hmr-module', id: event.data.id, error: detail.message, errorDetail: detail },
        '*',
      );
    }
  } else if (event.data?.type === 'hmr-full-reload-ack') {
    log('Client acknowledged full-reload', 'hmr');
  } else if (event.data?.type === 'hmr-request-reload') {
    // Real Vite reload → dev server re-serves the CURRENT page. Here the host
    // rebuilds the iframe document from the latest VFS index.html and
    // re-bootstraps the entry it declares.
    const entry = getEntryFromIndexHtml();
    if (!getFile(entry)) {
      // With the entry gone the rebuild can only end on the same "Failed to
      // load url" overlay, so swapping the document would blank the preview and
      // re-raise that overlay for every edit that reloads (the entry module is
      // a dead end for HMR, so most of them do). Keep the document and restate
      // the error — the overlay is already showing it, so nothing moves.
      log(`Full reload skipped — entry ${entry} does not exist`, 'warn');
      reportPreviewError(entry, missingEntryError(entry));
      return;
    }
    log('Full reload — rebuilding iframe from latest index.html', 'hmr');
    void initIframe();
  } else if (event.data?.type === 'cdp-ready') {
    cdpReady = true;
    log('CDP (Chobitsu) ready - Click DevTools to open Chrome DevTools', 'success');
  } else if (event.data?.type === 'cdp-response') {
    handleCDPResponse(event.data.message);
    forwardCDPToDevtools(event.data.message);
  }
});

window.addEventListener('vite-hmr-payload', ((event: CustomEvent<HotPayload>) => {
  const payload = event.detail;
  log(`HotPayload → ${payload.type}`, 'hmr');
}) as EventListener);

// The shell pushes preview open state; when the preview dock panel is
// re-opened, its iframe is a fresh element — rebuild the HMR runtime into it.
// (No setPreviewOpen here — the shell already set the bridge state; re-setting
// it from inside the listener re-fires this same handler and overflows.)
onPreviewOpen((open) => {
  if (open && browserVite) void initIframe();
});

let pendingIframeBuild: Promise<void> | null = null;

/**
 * Rebuild the preview document, coalescing requests that arrive while a build
 * is already scheduled.
 *
 * One user action routinely produces several `full-reload` payloads — deleting
 * a folder unlinks every file under it, and each unlink whose module has no HMR
 * boundary is a page reload. Swapping the document once per payload would blank
 * the preview and re-create the error overlay over and over (the "flashing"),
 * while a single swap shows the same end state: the document is built from the
 * latest VFS index.html, and the entry is read when the new iframe reports
 * ready, so a coalesced request loses nothing.
 */
function initIframe(): Promise<void> {
  pendingIframeBuild ??= Promise.resolve()
    .then(buildPreviewDocument)
    .finally(() => {
      pendingIframeBuild = null;
    });
  return pendingIframeBuild;
}

async function buildPreviewDocument() {
  // The preview iframe mounts asynchronously (dockview renders panel content
  // after addPanel). Wait for it before touching `.src` — but bounded, since a
  // restored layout may have no Preview panel at all.
  await Promise.race([previewMounted.promise, new Promise((r) => setTimeout(r, 2000))]);
  if (!shellRefs.previewFrame) {
    log('Preview panel is closed — skipping iframe bootstrap', 'warn');
    return;
  }
  log('Initializing iframe with HMR runtime...', 'hmr');
  iframeReady = false;
  const html = createHMRRuntime();
  const blob = new Blob([html], { type: 'text/html' });
  previewFrame().src = URL.createObjectURL(blob);
  browserVite?.setPreviewIframe(previewFrame());
}

function scheduleUpdate() {
  if (!autoRunCheckbox().checked) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    updatePreview();
    debounceTimer = null;
  }, 500);
}

// =============================================================================
// Dependency Installation (npm registry -> VFS -> esbuild-wasm optimize)
// =============================================================================

let depsInstalled = false;
let installing = false;

/** Install deps from /package.json, bundle them, push manifest, reload preview. */
async function runInstall(): Promise<boolean> {
  if (!browserVite || installing) return depsInstalled;
  installing = true;
  setStatusBar({ deps: 'installing…' });
  // Give the preview panel's install-console host a chance to mount (dockview
  // renders panel content after addPanel), but never wait on it: a restored
  // layout without a Preview panel would otherwise block install — and with it
  // the rest of initialization — forever.
  await Promise.race([previewMounted.promise, new Promise((r) => setTimeout(r, 2000))]);
  showInstallConsole(true);
  installLog('$ browser-vite install', 'dim');
  try {
    const pkgJson = getFile('/package.json')?.content;
    if (!pkgJson) throw new Error('No /package.json in the project');
    const { installed, direct } = await installDependencies(
      pkgJson,
      (m) => {
        installLog(m, 'info');
        log(`[install] ${m}`);
      },
      (m) => installProgress(m),
    );
    const specifiers = defaultEntrySpecifiers(direct);
    // Skip the expensive esbuild-wasm bundle when we've already bundled this
    // exact resolved-version set (persisted in IndexedDB). The install above
    // is still needed to know the resolved versions that key the cache.
    const cacheKey = await depCacheKey(installed);
    let manifest = await loadDepCache(cacheKey);
    if (manifest) {
      installLog('✓ using cached optimized deps (IndexedDB)', 'success');
      log('[bundle] cache hit — skipped bundling', 'success');
    } else {
      const bundled = await bundleDeps(
        specifiers,
        (m) => {
          installLog(m, 'dim');
          log(`[bundle] ${m}`);
        },
        (m) => installProgress(m),
      );
      manifest = bundled.manifest;
      // Record the resolved versions in the cache's version index so future
      // resolutions can offer them to semver as candidates.
      void saveDepCache(cacheKey, bundled.manifest, bundled.files, installed);
    }
    browserVite.setOptimizedDeps(manifest);
    browserVite.clearModuleGraph();
    depsInstalled = true;
    setStatusBar({ deps: `${installed.length} deps` });
    installLog(`✓ installed ${installed.length} package(s), ${specifiers.length} optimized entrie(s)`, 'success');
    log(`[install] Done — ${installed.length} package(s), ${specifiers.length} optimized entrie(s)`, 'success');
    // Brief pause so the success line is visible before the preview takes over.
    await new Promise((r) => setTimeout(r, 400));
    hideInstallConsole();
    // Announcing the install to the TS worker rebuilds its program against the
    // freshly unpacked declarations. Never block Install/Ready on it —
    // IntelliSense catches up in the background.
    void announceInstalledPackages(installed);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatusBar({ deps: 'install failed' });
    installLog(`✗ install failed: ${message}`, 'error');
    installLog('Fix /package.json and click Install to retry.', 'warn');
    log(`[install] Failed: ${message}`, 'error');
    // Always reveal the preview again — a stuck install console covers the
    // iframe and hides the HMR error overlay.
    hideInstallConsole();
    return false;
  } finally {
    installing = false;
  }
}

type TsWorkerHandle = {
  getProxy: () => Promise<{
    fsNotify?: (kind: 'create' | 'remove' | 'modify', path: string, type?: number) => Promise<void>;
  }>;
};

/** Resolve the TypeScript LSP worker (not HTML/CSS/JSON — those also register
 *  language features and used to claim `__monacoLanguageWorker`). */
function getTsLanguageWorker(): TsWorkerHandle | undefined {
  const g = globalThis as {
    __monacoTsWorker?: TsWorkerHandle;
    __monacoLanguageWorker?: TsWorkerHandle;
  };
  return g.__monacoTsWorker ?? g.__monacoLanguageWorker;
}

/**
 * Tell the TypeScript worker that packages appeared under `/node_modules`.
 *
 * The installer writes thousands of files inside `withVirtualFileBatch`, which
 * suppresses per-file VFS events on purpose (node_modules are not app modules,
 * and one HMR event per file made installs crawl). The worker therefore never
 * hears about them through the normal watcher, and any negative type-resolution
 * result it cached before the install — "this package has no types" — would
 * stick forever. One notification per package clears those and re-indexes.
 *
 * If no TS worker exists yet there is nothing stale to invalidate: the worker
 * reads declarations straight from the VFS when it starts, so a later boot
 * picks the new packages up on its own.
 */
async function announceInstalledPackages(installed: Array<{ name: string }>) {
  const worker = getTsLanguageWorker();
  if (!worker) return;
  try {
    const proxy = await worker.getProxy();
    if (typeof proxy.fsNotify !== 'function') return;
    for (const { name } of installed) {
      await proxy.fsNotify('create', `/node_modules/${name}/package.json`, 1);
    }
    // Re-validate every open buffer: any of them may import a new package.
    for (const model of monaco?.editor.getModels() ?? []) {
      Reflect.get(model, 'refreshDiagnostics')?.();
    }
    log(`[types] ${installed.length} package(s) announced to the TS worker`, 'success');
  } catch (err) {
    log(`[types] failed to announce install: ${err instanceof Error ? err.message : err}`, 'warn');
  }
}

// =============================================================================
// Initialization
// =============================================================================

async function initialize() {
  try {
    log('Initializing browser-vite...');
    setStatus('Initializing...', 'pending');

    // Initialize file system (subscription renders the tree)
    initFileSystem();

    // Initialize Monaco (modern-monaco): pre-highlights with Shiki while the
    // editor core loads in the background, then returns the monaco namespace.
    // The fork's TS worker bundles its own TypeScript (self-contained, no CDN).
    log('Loading Monaco editor...', 'info');

    // Workspace backed by our VFS (customFS) so the TS language service can
    // resolve cross-file imports (props/types from sibling modules). A
    // tsconfig.json gives the worker real compiler options (JSX, resolution).
    workspace = new Workspace({
      name: 'browser-vite-example',
      customFS: new VFSFileSystem(),
    });

    // SINGLE-OWNER GUARD. `_openTextDocument` is monaco's "reveal this resource
    // to the user" path (go-to-definition, peek, history). modern-monaco's stock
    // implementation ends with `editor.setModel(model)`, which would swap the
    // model under whichever editor happened to have focus instead of opening a
    // tab — we own the dock, so we route the navigation through the store and
    // then apply the requested selection to the editor that lands there.
    //
    // Background model creation for the language service does NOT come through
    // here: the TS worker's `openModel` host calls `_openBackgroundDocument`,
    // which never touches an editor.
    (workspace as unknown as {
      _openTextDocument: (
        m: MonacoNS,
        ed: IEditor | null,
        uri: string | URL,
        sel?: unknown,
        readonlyContent?: string,
      ) => Promise<unknown>;
    })._openTextDocument = async (_m, _ed, uri, sel, readonlyContent) => {
      const url = new URL(String(uri), 'file:///');
      const path = decodeURIComponent(url.pathname);
      const model = await revealPath(path, readonlyContent);
      if (!model) throw new Error(`Cannot open ${path}`);
      if (sel) revealSelection(path, sel as SelectionOrPosition);
      return model;
    };

    monaco = await init({
      defaultTheme: 'dark-plus', // VS Code Dark+ — closest to VS Dark
      // Preload every grammar this project uses so each language's Shiki
      // tokenizer is registered BEFORE any file opens. Otherwise modern-monaco
      // lazily `await`s a CDN grammar fetch on a language's first open and the
      // editor paints untokenized (blank) for a frame — the "blinking content".
      langs: ['tsx', 'typescript', 'javascript', 'jsx', 'css', 'html', 'json', 'markdown'],
      workspace,
      lsp: {
        typescript: {
          // Types come from the project's real `/node_modules` in the VFS — the
          // same files tsc would read — so IntelliSense tracks whatever the
          // installer actually put on disk. No CDN, no import map to keep in
          // sync, and a package's own `.d.ts` always wins over a guess.
          resolution: 'node_modules',
          importMap: { imports: {}, scopes: {} },
          compilerOptions: {
            jsx: 4 /* JsxEmit.ReactJSX */,
            allowJs: true,
            allowImportingTsExtensions: true,
            noEmit: true,
            esModuleInterop: true,
            resolveJsonModule: true,
            isolatedModules: true,
          },
        },
        json: {
          // Register the vendored tsconfig schema so validation/completion works
          // without fetching json.schemastore.org (which fails in this sandbox).
          schemas: [
            {
              uri: 'https://json.schemastore.org/tsconfig',
              fileMatch: ['tsconfig.json', 'tsconfig.*.json'],
              schema: tsconfigSchema as never,
            },
          ],
        },
      },
    });

    // Editors are created per open file (into each dockview panel's host) by
    // the store subscriptions above. Content→VFS sync is wired per model in
    // ensureEditor, so every visible buffer writes back regardless of which
    // dock group it lives in.

    // Initialize browser-vite (Oxc WASM + full Vite 8 HMR)
    browserVite = new BrowserVite();
    await browserVite.init();
    browserVite.setPreviewIframe(previewFrame());

    // Seed VFS into browser-vite
    for (const [path, file] of Object.entries(fs())) {
      browserVite.setFile(path, file.content);
    }

    // Mount the React Explorer into #fileTree and bind structural-ops hooks so
    // rename/delete/move in the tree keep Monaco models + the module graph in
    // sync with the VFS.
    bindBrowserVite(browserVite);
    bindMonacoHooks({
      deleteModel: (path) => {
        if (!monaco) return;
        disposeEditor(path);
        const uri = monaco.Uri.file(path);
        monaco.editor.getModel(uri)?.dispose();
      },
      renameModel: (from, to) => {
        if (!monaco) return;
        renameEditors(from, to);
        const model = monaco.editor.getModel(monaco.Uri.file(from));
        // The new path's model is (re)created on next open with the right
        // language; just drop the stale one keyed to the old URI.
        model?.dispose();
      },
      openFile,
    });

    // The Explorer is rendered by the React shell; toolbar actions are bound
    // through the bridge. Buttons enable when the engine is ready.
    bindShellActions({
      run: () => void runManual(),
      install: () => {
        void runInstall().then((ok) => {
          if (ok) void initIframe();
        });
      },
      toggleDevtools: () => toggleDevtools(),
    });
    autoRunCheckbox().disabled = false;
    setShellReady(true);

    // Hydrate whatever tab is already active (dock restore → store), or open
    // the project entry when nothing was restored.
    const restored = useEditorStore.getState();
    if (restored.activeTab && restored.activeTab !== 'preview' && restored.openFiles.length > 0) {
      // Re-apply after VFS seed so replaceOpenTabs can filter to real files,
      // then attach Monaco into the visible panel host.
      restored.replaceOpenTabs(restored.openFiles, restored.activeTab);
      hydrateVisibleEditor(useEditorStore.getState().activeTab);
      const active = useEditorStore.getState().activeTab;
      if (active && active !== 'preview') {
        useEditorStore.getState().setSelectedItems([active]);
      }
    } else {
      openFile('/index.html');
    }

    // Install dependencies (real npm registry -> VFS -> esbuild-wasm), then
    // bring up the preview once the optimized deps manifest is available.
    setStatus('Installing deps...', 'pending');
    const installed = await runInstall();
    if (!installed) {
      setStatus('Install failed', 'error');
      log('Dependency install failed — fix /package.json and click Install', 'error');
      return;
    }

    setStatus('Ready!', 'success');
    log('Browser-vite ready!', 'success');

    // Initialize iframe with Vite HotPayload HMR client
    await initIframe();

    // Expose for debugging and external use
    (window as any).browserVite = browserVite;
    (window as any).fileSystem = fs();
    (window as any).store = useEditorStore;
    (window as any).getEditor = (path?: string) =>
      path ? editorsByPath.get(path) ?? null : editorsByPath.get(currentFile() ?? '') ?? null;
    (window as any).editors = editorsByPath;
    (window as any).monaco = monaco;
    (window as any).workspace = workspace;

    // Expose CDP API
    (window as any).cdp = {
      send: sendCDPCommand,
      on: onCDPEvent,
      get ready() {
        return cdpReady;
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Error: ${message}`, 'error');
    log(`Initialization failed: ${message}`, 'error');
    console.error('[init] full stack:\n' + (error instanceof Error ? error.stack : String(error)));
  }
}

// =============================================================================
// DevTools - Embedded Chrome DevTools Frontend via Chii
//
// The shell (App.tsx) owns the DevTools dock panel — it adds/removes the
// dockview panel and pushes open state through `onDevtoolsOpen`. The engine
// tracks that state, lazy-loads chii on first open, and owns the CDP message
// forwarding.
// =============================================================================

let devtoolsOpen = false;
let devtoolsInitialized = false;

// Chii DevTools URL with embedded mode pointing to our origin
const CHII_DEVTOOLS_URL = `https://chii.liriliri.io/front_end/chii_app.html#?embedded=${encodeURIComponent(window.location.origin)}`;

onDevtoolsOpen((open) => {
  devtoolsOpen = open;
  if (open && !devtoolsInitialized && cdpReady) void initDevtoolsFrame();
});

function toggleDevtools() {
  // The shell has already added/removed the dock panel and pushed the new open
  // state through onDevtoolsOpen (handled above). Here we only lazy-load chii.
  if (!devtoolsOpen) return;
  if (!cdpReady) {
    log('DevTools unavailable: CDP not ready', 'warn');
    return;
  }
  if (!devtoolsInitialized) void initDevtoolsFrame();
}

async function initDevtoolsFrame() {
  log('Initializing embedded DevTools...', 'info');
  // The DevTools iframe mounts asynchronously (dockview panel content). Wait
  // for it rather than assuming same-tick attachment.
  await devtoolsMounted.promise;
  const frame = devtoolsFrame();
  if (!frame) return;
  // Load chii directly from its CDN - no intermediate iframe needed
  frame.src = CHII_DEVTOOLS_URL;
  devtoolsInitialized = true;
}

// Handle messages from chii DevTools (CDP commands)
function handleDevtoolsMessage(event: MessageEvent) {
  // Only accept messages from chii's origin
  if (event.origin !== 'https://chii.liriliri.io') return;

  // Chii sends CDP commands as JSON strings
  if (event.data && typeof event.data === 'string') {
    try {
      const parsed = JSON.parse(event.data);
      if (parsed.method || parsed.id !== undefined) {
        // Forward CDP command to preview iframe (chobitsu)
        previewFrame().contentWindow?.postMessage(
          { type: 'cdp-command', message: event.data },
          '*'
        );
      }
    } catch {
      // Not JSON, ignore
    }
  }
}

// Forward CDP responses to chii DevTools iframe
function forwardCDPToDevtools(message: string) {
  const frame = devtoolsFrame();
  if (devtoolsOpen && devtoolsInitialized && frame?.contentWindow) {
    frame.contentWindow.postMessage(message, 'https://chii.liriliri.io');
  }
}

// Listen for messages from chii DevTools
window.addEventListener('message', handleDevtoolsMessage);

// =============================================================================
// Manual Run
// =============================================================================

async function runManual() {
  log('Manual run triggered', 'info');
  // Persist the current editor buffer, then do a clean re-bootstrap. A manual
  // Run is the user's explicit "render the current code now" — re-bootstrapping
  // guarantees recovery from any prior HMR error state (stale overlay, poisoned
  // module graph), where an incremental HMR update might silently no-op.
  const cur = currentFile();
  const curEditor = cur ? editorsByPath.get(cur) : undefined;
  if (cur && curEditor) {
    editorStore.getState().setFileContent(cur, curEditor.getValue());
    browserVite?.setFile(cur, curEditor.getValue());
  }
  browserVite?.clearModuleGraph();
  await bootstrapPreview();
}

// =============================================================================
// Bootstrap
// =============================================================================

// Mount the React shell (toolbar + dockview panes). This renders synchronously,
// filling shellRefs with the DOM hosts the engine attaches to, then the engine
// initializes against those hosts.
function mountShell() {
  const container = document.getElementById('root')!;
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Start. Mount the shell, then initialize the engine once the shell's DOM
// hosts (editor/preview/etc.) are rendered — createRoot().render() is async,
// so we gate on the shell's onReady signal rather than assuming same-tick refs.
mountShell();
void shellReady.then(() => initialize());
