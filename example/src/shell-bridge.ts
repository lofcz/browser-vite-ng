/**
 * Bridge between the React shell (App.tsx — header toolbar + dockview panes)
 * and the imperative engine in main.ts. The shell renders plain DOM hosts and
 * toolbar buttons; main.ts attaches the editor / iframes to those hosts and
 * registers the actions the buttons trigger. Neither side imports the other's
 * internals — they meet only at this narrow, typed surface.
 */

/** Mutable handles to the DOM hosts the engine needs. Filled by the shell via
 *  ref callbacks, consumed by main.ts during initialize(). */
export interface ShellRefs {
  fileTreeHost: HTMLElement | null;
  previewFrame: HTMLIFrameElement | null;
  installConsole: HTMLElement | null;
  devtoolsFrame: HTMLIFrameElement | null;
  currentFileName: HTMLElement | null;
  status: HTMLElement | null;
  depsStatus: HTMLElement | null;
  previewStatus: HTMLElement | null;
  autoRunCheckbox: HTMLInputElement | null;
}

export const shellRefs: ShellRefs = {
  fileTreeHost: null,
  previewFrame: null,
  installConsole: null,
  devtoolsFrame: null,
  currentFileName: null,
  status: null,
  depsStatus: null,
  previewStatus: null,
  autoRunCheckbox: null,
};

/** Actions the toolbar buttons invoke. Registered by main.ts once the engine
 *  is up. All optional so the shell can render before init completes. */
export interface ShellActions {
  run: () => void;
  install: () => void;
  toggleDevtools: () => void;
}

export const shellActions: ShellActions = {
  run: () => {},
  install: () => {},
  toggleDevtools: () => {},
};

export function bindShellActions(actions: Partial<ShellActions>) {
  Object.assign(shellActions, actions);
}

/** Toolbar buttons are disabled until the engine is ready. The shell subscribes
 *  to this to flip its controls enabled. */
type ReadyListener = (ready: boolean) => void;
const readyListeners = new Set<ReadyListener>();
let shellReadyState = false;

export function setShellReady(ready: boolean) {
  shellReadyState = ready;
  for (const l of readyListeners) l(ready);
}

export function isShellReady() {
  return shellReadyState;
}

export function onShellReady(l: ReadyListener): () => void {
  readyListeners.add(l);
  return () => readyListeners.delete(l);
}

/** One-shot ready signals for engine-consumed DOM hosts. The Preview and
 *  DevTools panels mount asynchronously (dockview renders their content after
 *  addPanel), so the engine must WAIT for these instead of reading refs
 *  synchronously. `markXMounted` resolves the promise; re-created panels
 *  (close/reopen) reset it via `resetXMounted`. */
function makeMountSignal() {
  let resolve!: () => void;
  let promise: Promise<void> = new Promise((r) => { resolve = r; });
  return {
    get promise() { return promise; },
    mark() { resolve(); },
    reset() { promise = new Promise((r) => { resolve = r; }); },
  };
}
export const previewMounted = makeMountSignal();
export const devtoolsMounted = makeMountSignal();

/** Preview open state, pushed by the shell (dock panel added/removed). */
type PreviewListener = (open: boolean) => void;
const previewListeners = new Set<PreviewListener>();
let previewOpenState = true;

export function setPreviewOpen(open: boolean) {
  if (open === previewOpenState) return; // avoid redundant fan-out / re-entrancy
  previewOpenState = open;
  for (const l of previewListeners) l(open);
}
export function isPreviewOpen() {
  return previewOpenState;
}
export function onPreviewOpen(l: PreviewListener): () => void {
  previewListeners.add(l);
  return () => previewListeners.delete(l);
}

/** Resolves once the shell has rendered its DOM hosts (editor/preview/etc.).
 *  main.ts awaits this before attaching the engine to those hosts, because
 *  createRoot().render() is asynchronous — refs aren't set on the same tick. */
let resolveShellReady!: () => void;
export const shellReady: Promise<void> = new Promise((resolve) => {
  resolveShellReady = resolve;
});
export function markShellRendered() {
  resolveShellReady();
}

/** Devtools open state, mirrored so the shell can highlight its toggle. */
type DevtoolsListener = (open: boolean) => void;
const devtoolsListeners = new Set<DevtoolsListener>();
let devtoolsOpenState = false;

export function setDevtoolsOpen(open: boolean) {
  if (open === devtoolsOpenState) return; // avoid redundant fan-out / re-entrancy
  devtoolsOpenState = open;
  for (const l of devtoolsListeners) l(open);
}

export function isDevtoolsOpen() {
  return devtoolsOpenState;
}

export function onDevtoolsOpen(l: DevtoolsListener): () => void {
  devtoolsListeners.add(l);
  return () => devtoolsListeners.delete(l);
}

/** Status-bar state pushed by the engine (current file, deps, run status). The
 *  shell subscribes and renders it — the engine never touches status-bar DOM. */
export interface StatusBarState {
  currentFile: string | null;
  deps: string;
  status: string;
  statusType: 'success' | 'error' | 'pending';
}
const statusBarListeners = new Set<(s: StatusBarState) => void>();
let statusBarState: StatusBarState = { currentFile: null, deps: '', status: 'Initializing...', statusType: 'pending' };

export function setStatusBar(patch: Partial<StatusBarState>) {
  statusBarState = { ...statusBarState, ...patch };
  for (const l of statusBarListeners) l(statusBarState);
}
export function getStatusBar() {
  return statusBarState;
}
export function onStatusBar(l: (s: StatusBarState) => void): () => void {
  statusBarListeners.add(l);
  return () => statusBarListeners.delete(l);
}
