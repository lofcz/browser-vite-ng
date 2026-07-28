/**
 * Browser-Vite host wrapper — thin adapter over the full-fidelity
 * `BrowserServer` (transformRequest + import-analysis + ModuleGraph + HMR).
 *
 * No regex HMR analysis, no eval/new Function. All accept/import analysis,
 * hot-context injection, boundary propagation and module serving come from
 * `packages/vite/src/browser/*` (Vite 8 semantics).
 */

import {
  createBrowserHotChannel,
  createBrowserServer,
  resolveConfig,
  setVirtualFile,
  deleteVirtualFile,
  type BrowserServer,
  type HotChannel,
  type HotPayload,
  type ModuleNode,
  type RawSourceMap,
  updateModules,
} from 'browser-vite';
import { sendHotPayload } from './hmr-bridge';

export interface TransformResult {
  code: string;
  map: RawSourceMap | null;
}

export interface VirtualFile {
  path: string;
  content: string;
  lastModified: number;
}

export class BrowserVite {
  private initialized = false;
  private server: BrowserServer | null = null;
  private previewIframe: HTMLIFrameElement | null = null;
  private files = new Map<string, string>();

  get moduleGraph() {
    return this.server?.moduleGraph ?? null;
  }
  hot: (HotChannel & { subscribe: (h: (p: HotPayload) => void) => () => void }) | null =
    null;

  setPreviewIframe(iframe: HTMLIFrameElement | null): void {
    this.previewIframe = iframe;
  }

  /** Push the deps-optimizer manifest (bare specifier -> /@deps/* URL). */
  setOptimizedDeps(manifest: Record<string, string>): void {
    if (this.server) this.server.optimizedDeps = { ...manifest };
  }

  /** Register / update virtual file contents (source of truth for transforms). */
  setFile(path: string, content: string): void {
    this.files.set(path, content);
    setVirtualFile(path, content);
  }

  getFile(path: string): string | undefined {
    return this.files.get(path);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.hot = createBrowserHotChannel((payload: HotPayload) => {
      sendHotPayload(this.previewIframe, payload as HotPayload);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('vite-hmr-payload', { detail: payload }));
      }
    });

    const config = await resolveConfig({ root: '/' }, 'serve');
    this.server = createBrowserServer({ config, hot: this.hot });

    this.initialized = true;
    console.log('[BrowserVite] Initialized (Oxc WASM + full Vite 8 HMR pipeline)');
  }

  /**
   * Full dev transform of a module (oxc → plugins → import-analysis → graph).
   * Writes to the VFS and serves the transformed ESM for the preview.
   */
  async transform(code: string, id: string): Promise<TransformResult> {
    if (!this.server) throw new Error('BrowserVite not initialized. Call init() first.');
    this.setFile(id, code);
    const res = await this.server.transformRequest(id);
    if (!res) throw new Error(`[browser-vite] Failed to transform ${id}`);
    return { code: res.code, map: res.map };
  }

  /**
   * Serve transformed module to the preview iframe / importUpdatedModule.
   * The sourcemap travels with the code — the iframe re-bases it after
   * rewriting import specifiers to blob URLs, then inlines it.
   */
  async fetchModule(url: string): Promise<TransformResult | null> {
    if (!this.server) return null;
    return this.server.fetchModule(url);
  }

  async resolveId(id: string, importer?: string) {
    if (!this.server) throw new Error('Not initialized');
    return this.server.resolveId(id, importer);
  }

  hasPlugin(name: string): boolean {
    return (
      this.initialized &&
      ['vite:oxc', 'vite:css', 'vite:import-analysis', 'vite:resolve'].includes(name)
    );
  }

  getPluginNames(): string[] {
    return ['vite:oxc', 'vite:css', 'vite:import-analysis', 'vite:resolve'];
  }

  /**
   * Full-fidelity HMR: VFS change → moduleGraph invalidation →
   * updateModules / propagateUpdate → HotChannel → preview iframe.
   */
  async handleHMRUpdate(path: string, newCode: string): Promise<boolean> {
    if (!this.server || !this.hot) {
      throw new Error('BrowserVite not initialized. Call init() first.');
    }
    try {
      this.setFile(path, newCode);
      // VFS 'change' event drives handleHMRUpdate via the server listener.
      return true;
    } catch (error) {
      console.error(`[HMR] Failed to update ${path}:`, error);
      this.hot.send?.({
        type: 'error',
        err: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack || '' : '',
        },
      });
      return false;
    }
  }

  sendFullReload(path = '*'): void {
    this.hot?.send?.({ type: 'full-reload', path });
  }

  /** Directly run updateModules for testing / advanced hosts. */
  updateModules(file: string, modules: ModuleNode[], timestamp = Date.now()): void {
    if (!this.server || !this.hot) return;
    updateModules(
      {
        name: 'client',
        moduleGraph: this.server.moduleGraph,
        hot: this.hot,
        logger: { info: (msg: string) => console.log(`[HMR] ${msg}`) },
      },
      file,
      modules,
      timestamp,
    );
  }

  getModule(path: string): VirtualFile | undefined {
    const content = this.files.get(path);
    if (content === undefined) return undefined;
    return { path, content, lastModified: Date.now() };
  }

  getAllModules(): VirtualFile[] {
    return [...this.files.entries()].map(([path, content]) => ({
      path,
      content,
      lastModified: Date.now(),
    }));
  }

  deleteFile(path: string): void {
    this.files.delete(path);
    deleteVirtualFile(path);
  }

  clearModuleGraph(): void {
    this.moduleGraph?.invalidateAll();
  }
}

export const browserVite = new BrowserVite();
