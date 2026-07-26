/**
 * Browser-Vite Live Editor Example
 *
 * Features:
 * - Virtual file system with multiple files
 * - Browsable file tree
 * - CodeMirror editor for editing code
 * - Live preview in iframe with HMR
 * - Module resolution between files
 */

import './index.css';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState } from '@codemirror/state';
import { BrowserVite } from './browser-vite-wrapper';
import { createViteHmrIframeHtml, type HotPayload } from './hmr-bridge';
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

interface VirtualFile {
  path: string;
  content: string;
  type: 'tsx' | 'ts' | 'css' | 'json' | 'html';
}

// Initial file system with a multi-file React app
const initialFiles: VirtualFile[] = [
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
import App from './App';

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
import { Counter } from './Counter';
import { Header } from './components/Header';
import { greeting } from './utils';

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
import { Button } from './components/Button';

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
  }
}
`,
  },
];

// Virtual file system state
let fileSystem: Map<string, VirtualFile> = new Map();
let currentFile: string = '/index.html';
let modifiedFiles: Set<string> = new Set();

// Initialize file system
function initFileSystem() {
  fileSystem.clear();
  modifiedFiles.clear();
  for (const file of initialFiles) {
    fileSystem.set(file.path, { ...file });
  }
}

// =============================================================================
// UI Elements
// =============================================================================

const statusEl = document.getElementById('status')!;
const editorContainer = document.getElementById('editor')!;
const previewFrame = document.getElementById('preview') as HTMLIFrameElement;
const installConsoleEl = document.getElementById('installConsole')!;
const runBtn = document.getElementById('runCode') as HTMLButtonElement;
const installBtn = document.getElementById('installDeps') as HTMLButtonElement;
const depsStatusEl = document.getElementById('depsStatus')!;
const autoRunCheckbox = document.getElementById('autoRun') as HTMLInputElement;
const fileTreeEl = document.getElementById('fileTree')!;
const currentFileNameEl = document.getElementById('currentFileName')!;
const newFileBtn = document.getElementById('newFileBtn')!;
const newFileModal = document.getElementById('newFileModal')!;
const newFileNameInput = document.getElementById('newFileName') as HTMLInputElement;
const createNewFileBtn = document.getElementById('createNewFile')!;
const cancelNewFileBtn = document.getElementById('cancelNewFile')!;

let browserVite: BrowserVite | null = null;
let editor: EditorView | null = null;
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
  statusEl.textContent = message;
  const statusStyles: Record<string, string> = {
    success: 'bg-emerald-900/50 border-emerald-700',
    error: 'bg-red-900/50 border-red-700',
    pending: 'bg-amber-900/50 border-amber-700',
  };
  statusEl.className = `px-3 py-1.5 rounded font-mono text-xs border ${statusStyles[type]}`;
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
  if (clear) installConsoleEl.innerHTML = '';
  installProgressLine = null;
  installConsoleEl.classList.remove('hidden');
}

/** Hide the console overlay, revealing the preview iframe again. */
function hideInstallConsole() {
  installConsoleEl.classList.add('hidden');
}

/** Append a line to the install console (ANSI-style colored, autoscrolls). */
function installLog(message: string, kind: keyof typeof installConsoleStyles = 'info') {
  flushInstallProgress();
  // Finalize any in-place progress line: overwrite it with the completed
  // message instead of appending a new line (progress → result on one line).
  if (installProgressLine) {
    installProgressLine.className = installConsoleStyles[kind];
    installProgressLine.textContent = message;
    installProgressLine = null;
    installConsoleEl.scrollTop = installConsoleEl.scrollHeight;
    return;
  }
  const line = document.createElement('div');
  line.className = installConsoleStyles[kind];
  line.textContent = message;
  installConsoleEl.appendChild(line);
  installConsoleEl.scrollTop = installConsoleEl.scrollHeight;
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
    if (!installProgressLine) {
      installProgressLine = document.createElement('div');
      installProgressLine.className = installConsoleStyles.dim;
      installConsoleEl.appendChild(installProgressLine);
    }
    installProgressLine.textContent = text;
    installConsoleEl.scrollTop = installConsoleEl.scrollHeight;
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
// File Tree
// =============================================================================

interface FileTreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children?: FileTreeNode[];
}

function buildFileTree(): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const paths = Array.from(fileSystem.keys()).sort();

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = '/' + parts.slice(0, i + 1).join('/');

      let node = current.find((n) => n.name === part);

      if (!node) {
        node = {
          name: part,
          path: currentPath,
          isFolder: !isFile,
          children: isFile ? undefined : [],
        };
        current.push(node);
      }

      if (!isFile && node.children) {
        current = node.children;
      }
    }
  }

  return root;
}

function getFileIcon(filename: string): string {
  if (filename.endsWith('.tsx')) return '⚛️';
  if (filename.endsWith('.ts')) return '📘';
  if (filename.endsWith('.css')) return '🎨';
  if (filename.endsWith('.json')) return '📋';
  if (filename.endsWith('.html')) return '🌐';
  return '📄';
}

function renderFileTree() {
  const tree = buildFileTree();
  fileTreeEl.innerHTML = '';

  function renderNode(node: FileTreeNode, container: HTMLElement) {
    if (node.isFolder) {
      const folderEl = document.createElement('div');
      folderEl.className = 'flex items-center px-3 py-1.5 cursor-pointer text-[13px] text-[hsl(var(--muted-foreground))] font-medium hover:bg-[hsl(var(--sidebar-accent))]';
      folderEl.innerHTML = `<span class="mr-2">📁</span>${node.name}`;
      container.appendChild(folderEl);

      const contentsEl = document.createElement('div');
      contentsEl.className = 'pl-3';
      container.appendChild(contentsEl);

      if (node.children) {
        // Sort: folders first, then files
        const sorted = [...node.children].sort((a, b) => {
          if (a.isFolder && !b.isFolder) return -1;
          if (!a.isFolder && b.isFolder) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const child of sorted) {
          renderNode(child, contentsEl);
        }
      }
    } else {
      const fileEl = document.createElement('div');
      const isActive = node.path === currentFile;
      const isModified = modifiedFiles.has(node.path);
      const baseClasses = 'flex items-center px-3 py-1.5 cursor-pointer text-[13px] border-l-2 hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--foreground))]';
      const activeClasses = isActive
        ? 'bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--foreground))] border-l-[hsl(var(--primary))]'
        : 'text-[hsl(var(--sidebar-foreground))] border-l-transparent';
      fileEl.className = `${baseClasses} ${activeClasses}`;
      fileEl.innerHTML = `<span class="w-4 h-4 mr-2 text-sm">${getFileIcon(node.name)}</span>${node.name}${isModified ? '<span class="w-1.5 h-1.5 bg-amber-500 rounded-full ml-auto"></span>' : ''}`;
      fileEl.addEventListener('click', () => openFile(node.path));
      container.appendChild(fileEl);
    }
  }

  // Root level: files first (index.html, package.json), then folders (src/) —
  // real Vite projects keep these at the project root, shown above src/.
  const sortedRoot = [...tree].sort((a, b) => {
    if (!a.isFolder && b.isFolder) return -1;
    if (a.isFolder && !b.isFolder) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of sortedRoot) {
    renderNode(node, fileTreeEl);
  }
}

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

function openFile(path: string) {
  // Save current editor content before switching
  if (editor && currentFile) {
    const content = editor.state.doc.toString();
    const file = fileSystem.get(currentFile);
    if (file && file.content !== content) {
      file.content = content;
      modifiedFiles.add(currentFile);
    }
  }

  currentFile = path;
  currentFileNameEl.textContent = path.split('/').pop() || '';

  const file = fileSystem.get(path);
  if (!file) {
    log(`File not found: ${path}`, 'error');
    return;
  }

  const fileType = getFileType(path);

  if (editor) {
    editor.destroy();
  }

  const languageExtension =
    fileType === 'css'
      ? css()
      : fileType === 'html'
        ? html()
        : javascript({ jsx: fileType === 'tsx', typescript: true });

  editor = new EditorView({
    state: EditorState.create({
      doc: file.content,
      extensions: [
        basicSetup,
        languageExtension,
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            modifiedFiles.add(currentFile);
            renderFileTree();
            scheduleUpdate();
          }
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ],
    }),
    parent: editorContainer,
  });

  renderFileTree();
  log(`Opened file: ${path}`, 'info');
}

// =============================================================================
// Module serving (real ESM via BrowserServer; no regex bundling / eval)
// =============================================================================

/**
 * Transform the entry and all VFS files through the real dev pipeline
 * (oxc → import-analysis → ModuleGraph) so the preview can import them as
 * native ESM. Returns the entry URL to hand to the iframe bootstrap.
 */
async function prepareModules(entry: string): Promise<string> {
  if (!browserVite) throw new Error('BrowserVite not initialized');
  await syncFilesToBrowserVite();
  // Warm the graph so import-analysis has rewritten every import specifier to
  // a servable URL before the iframe starts importing.
  await browserVite.transform(fileSystem.get(entry)?.content ?? '', entry);
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
    fileSystem.get('/index.html')?.content ??
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div></body></html>';
  return createViteHmrIframeHtml(indexHtml, clientBootstrap);
}

// =============================================================================
// Preview Update
// =============================================================================

/** Sync VFS → browserVite and ensure graph entries exist for all files. */
async function syncFilesToBrowserVite() {
  if (!browserVite) return;
  for (const [path, file] of fileSystem) {
    browserVite.setFile(path, file.content);
  }
  // Transform entry + deps so ModuleGraph edges / accept boundaries exist.
  // Tolerate per-file transform errors: BrowserServer already broadcasts an
  // `error` HotPayload for a failed transform, and a file currently in an
  // error state must not abort the whole sync (that would prevent recovery
  // when the file is later fixed).
  for (const [path, file] of fileSystem) {
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
  const html = fileSystem.get('/index.html')?.content;
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
  const entry = await prepareModules(entryPath);
  previewFrame.contentWindow?.postMessage(
    { type: 'hmr-update', entry, fileType: getFileType(entry) },
    '*',
  );
  log(`Bootstrap entry sent to iframe (real ESM serving): ${entry}`, 'hmr');
}

/**
 * Full-fidelity HMR path: Vite updateModules / propagateUpdate → HotPayload.
 */
async function updatePreview() {
  if (!browserVite || !editor) {
    log('Cannot update: browserVite or editor not ready', 'warn');
    return;
  }

  if (currentFile) {
    const content = editor.state.doc.toString();
    const file = fileSystem.get(currentFile);
    if (file) {
      file.content = content;
    }
    browserVite.setFile(currentFile, content);
  }

  // Non-code files (package.json etc.) aren't modules — skip the HMR pipeline.
  // Dependency changes take effect via the Install button, which rebundles.
  const currentType = getFileType(currentFile);
  if (currentType === 'json') {
    log('package.json changed — click Install to apply dependency changes', 'warn');
    return;
  }
  // index.html is not an HMR module — like real Vite, a change triggers a
  // full reload. The browser-vite server sends `full-reload`; the host honors
  // it by rebuilding the iframe document from the LATEST VFS index.html (the
  // analogue of the dev server re-serving the page) and re-bootstrapping.
  if (currentType === 'html') {
    log('index.html changed — full reload (rebuild document + re-bootstrap)', 'hmr');
    return;
  }

  updateCounter++;
  const updateId = updateCounter;
  log(`Starting HMR update #${updateId} for ${currentFile}`, 'hmr');

  try {
    if (!iframeReady) {
      log('Iframe not ready, queuing update...', 'warn');
      return;
    }

    const content = fileSystem.get(currentFile)?.content ?? '';
    // Ensure graph is warm, then run full Vite HMR pipeline
    await syncFilesToBrowserVite();
    const ok = await browserVite.handleHMRUpdate(currentFile, content);
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
    previewFrame.contentWindow?.postMessage({ type: 'cdp-command', message }, '*');

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
  } else if (event.data?.type === 'hmr-fetch-module') {
    // Iframe asked for a fresh transformed module (real dev-server fetchModule).
    try {
      if (!browserVite) throw new Error('BrowserVite not ready');
      const path = event.data.path as string;
      // Well-known public paths served from precompiled bundles, not the VFS.
      if (path === '/@react-refresh') {
        previewFrame.contentWindow?.postMessage(
          { type: 'hmr-module', id: event.data.id, code: reactRefreshJs },
          '*',
        );
        return;
      }
      if (path === '/@vite/client') {
        previewFrame.contentWindow?.postMessage(
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
        previewFrame.contentWindow?.postMessage(
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
        previewFrame.contentWindow?.postMessage(
          {
            type: 'hmr-module',
            id: event.data.id,
            code: fileSystem.get(path)?.content ?? '',
            css: true,
          },
          '*',
        );
      } else {
        previewFrame.contentWindow?.postMessage(
          { type: 'hmr-module', id: event.data.id, code: served.code },
          '*',
        );
      }
    } catch (err) {
      previewFrame.contentWindow?.postMessage(
        {
          type: 'hmr-module',
          id: event.data.id,
          error: err instanceof Error ? err.message : String(err),
        },
        '*',
      );
    }
  } else if (event.data?.type === 'hmr-full-reload-ack') {
    log('Client acknowledged full-reload', 'hmr');
  } else if (event.data?.type === 'hmr-request-reload') {
    // Real Vite reload → dev server re-serves the CURRENT page. Here the host
    // rebuilds the iframe document from the latest VFS index.html and
    // re-bootstraps the entry it declares.
    log('Full reload — rebuilding iframe from latest index.html', 'hmr');
    initIframe();
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

function initIframe() {
  log('Initializing iframe with HMR runtime...', 'hmr');
  iframeReady = false;
  const html = createHMRRuntime();
  const blob = new Blob([html], { type: 'text/html' });
  previewFrame.src = URL.createObjectURL(blob);
  browserVite?.setPreviewIframe(previewFrame);
}

function scheduleUpdate() {
  if (!autoRunCheckbox.checked) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    updatePreview();
    debounceTimer = null;
  }, 500);
}

// New file modal handlers
function showNewFileModal() {
  newFileModal.classList.remove('hidden');
  newFileModal.classList.add('flex');
  newFileNameInput.value = '';
  newFileNameInput.focus();
}

function hideNewFileModal() {
  newFileModal.classList.add('hidden');
  newFileModal.classList.remove('flex');
}

function createNewFile() {
  let filename = newFileNameInput.value.trim();
  if (!filename) return;

  // Add extension if not present
  if (!filename.match(/\.(tsx?|css|json)$/)) {
    filename += '.tsx';
  }

  // Add /src/ prefix if not present
  let path = filename.startsWith('/') ? filename : '/src/' + filename;

  if (fileSystem.has(path)) {
    log(`File already exists: ${path}`, 'error');
    return;
  }

  const type = getFileType(path);
  const content =
    type === 'css'
      ? `/* ${filename} */\n`
      : type === 'tsx'
        ? `import React from 'react';\n\nexport function ${filename.replace(/\\.tsx?$/, '')}() {\n  return <div>New Component</div>;\n}\n`
        : `// ${filename}\n`;

  fileSystem.set(path, { path, content, type });
  log(`Created new file: ${path}`, 'success');

  hideNewFileModal();
  renderFileTree();
  openFile(path);
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
  installBtn.disabled = true;
  depsStatusEl.textContent = 'installing…';
  showInstallConsole(true);
  installLog('$ browser-vite install', 'dim');
  try {
    const pkgJson = fileSystem.get('/package.json')?.content;
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
      void saveDepCache(cacheKey, bundled.manifest, bundled.files);
    }
    browserVite.setOptimizedDeps(manifest);
    browserVite.clearModuleGraph();
    depsInstalled = true;
    depsStatusEl.textContent = `${installed.length} deps`;
    installLog(`✓ installed ${installed.length} package(s), ${specifiers.length} optimized entrie(s)`, 'success');
    log(`[install] Done — ${installed.length} package(s), ${specifiers.length} optimized entrie(s)`, 'success');
    // Brief pause so the success line is visible before the preview takes over.
    await new Promise((r) => setTimeout(r, 400));
    hideInstallConsole();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    depsStatusEl.textContent = 'install failed';
    installLog(`✗ install failed: ${message}`, 'error');
    installLog('Fix /package.json and click Install to retry.', 'warn');
    log(`[install] Failed: ${message}`, 'error');
    return false;
  } finally {
    installing = false;
    installBtn.disabled = false;
  }
}

// =============================================================================
// Initialization
// =============================================================================

async function initialize() {
  try {
    log('Initializing browser-vite...');
    setStatus('Initializing...', 'pending');

    // Initialize file system
    initFileSystem();
    renderFileTree();

    // Initialize browser-vite (Oxc WASM + full Vite 8 HMR)
    browserVite = new BrowserVite();
    await browserVite.init();
    browserVite.setPreviewIframe(previewFrame);

    // Seed VFS into browser-vite
    for (const [path, file] of fileSystem) {
      browserVite.setFile(path, file.content);
    }

    // Enable UI
    runBtn.disabled = false;
    autoRunCheckbox.disabled = false;
    installBtn.disabled = false;
    installBtn.addEventListener('click', () => {
      void runInstall().then((ok) => {
        if (ok) initIframe();
      });
    });

    // Open the project's real entry document
    openFile('/index.html');

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
    initIframe();

    // Expose for debugging and external use
    (window as any).browserVite = browserVite;
    (window as any).fileSystem = fileSystem;
    (window as any).getEditor = () => editor;

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
  }
}

// =============================================================================
// DevTools - Embedded Chrome DevTools Frontend via Chii
// =============================================================================

const devtoolsToggle = document.getElementById('devtoolsToggle')!;
const devtoolsPanel = document.getElementById('devtoolsPanel')!;
const devtoolsFrame = document.getElementById('devtoolsFrame') as HTMLIFrameElement;
const devtoolsResizeHandle = document.getElementById('devtoolsResizeHandle')!;

let devtoolsOpen = false;
let devtoolsInitialized = false;

// Chii DevTools URL with embedded mode pointing to our origin
const CHII_DEVTOOLS_URL = `https://chii.liriliri.io/front_end/chii_app.html#?embedded=${encodeURIComponent(window.location.origin)}`;

function toggleDevtools() {
  if (!cdpReady) {
    log('Cannot open DevTools: CDP not ready', 'error');
    return;
  }

  devtoolsOpen = !devtoolsOpen;
  devtoolsPanel.classList.toggle('hidden', !devtoolsOpen);
  devtoolsPanel.classList.toggle('block', devtoolsOpen);
  devtoolsToggle.classList.toggle('bg-[hsl(var(--primary))]', devtoolsOpen);

  if (devtoolsOpen && !devtoolsInitialized) {
    initDevtoolsFrame();
  }

  log(devtoolsOpen ? 'DevTools panel opened' : 'DevTools panel closed', 'info');
}

function initDevtoolsFrame() {
  log('Initializing embedded DevTools...', 'info');
  // Load chii directly from its CDN - no intermediate iframe needed
  devtoolsFrame.src = CHII_DEVTOOLS_URL;
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
        previewFrame.contentWindow?.postMessage(
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
  if (devtoolsOpen && devtoolsInitialized && devtoolsFrame.contentWindow) {
    devtoolsFrame.contentWindow.postMessage(message, 'https://chii.liriliri.io');
  }
}

// DevTools panel resize functionality
let isResizing = false;
let startY = 0;
let startHeight = 0;

devtoolsResizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  startY = e.clientY;
  startHeight = devtoolsPanel.offsetHeight;
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const deltaY = startY - e.clientY;
  const newHeight = Math.min(Math.max(150, startHeight + deltaY), window.innerHeight - 200);
  devtoolsPanel.style.height = `${newHeight}px`;
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});

// Listen for messages from chii DevTools
window.addEventListener('message', handleDevtoolsMessage);

// DevTools toggle button
devtoolsToggle.addEventListener('click', toggleDevtools);

// Event listeners
runBtn.addEventListener('click', async () => {
  log('Manual run triggered', 'info');
  // Persist the current editor buffer, then do a clean re-bootstrap. A manual
  // Run is the user's explicit "render the current code now" — re-bootstrapping
  // guarantees recovery from any prior HMR error state (stale overlay, poisoned
  // module graph), where an incremental HMR update might silently no-op.
  if (editor && currentFile) {
    const file = fileSystem.get(currentFile);
    if (file) file.content = editor.state.doc.toString();
    browserVite?.setFile(currentFile, editor.state.doc.toString());
  }
  browserVite?.clearModuleGraph();
  await bootstrapPreview();
});

newFileBtn.addEventListener('click', showNewFileModal);
cancelNewFileBtn.addEventListener('click', hideNewFileModal);
createNewFileBtn.addEventListener('click', createNewFile);
newFileNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createNewFile();
  if (e.key === 'Escape') hideNewFileModal();
});
newFileModal.addEventListener('click', (e) => {
  if (e.target === newFileModal) hideNewFileModal();
});

// Start
initialize();
