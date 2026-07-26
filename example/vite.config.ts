import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { builtinModules } from 'node:module';
import { iframeRuntimePlugin } from './vite-plugin-iframe-runtime';

/**
 * Exposes the authoritative list of Node builtin modules (from
 * `node:module`.builtinModules, evaluated at config time in Node) to the
 * browser dep-bundler, so NODE_BUILTINS can never drift from the real set.
 * Internal `_`-prefixed modules are excluded (not user-importable); both the
 * canonical name and every public subpath export (fs/promises, etc.) are kept.
 */
function nodeBuiltinsPlugin(): Plugin {
  const ID = 'virtual:node-builtins';
  const list = [
    ...new Set(
      builtinModules
        .map((m) => m.replace(/^node:/, ''))
        .filter((m) => !m.split('/')[0].startsWith('_')),
    ),
  ].sort();
  return {
    name: 'node-builtins',
    resolveId(id) {
      if (id === ID) return '\0' + ID;
    },
    load(id) {
      if (id === '\0' + ID) {
        return `export const NODE_BUILTINS = ${JSON.stringify(list)};`;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), iframeRuntimePlugin(), nodeBuiltinsPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workspace browser-vite (Vite 8.1.5 fork)
      'browser-vite': path.resolve(__dirname, '../packages/vite/src/browser/index.ts'),
      'browser-vite/client/browser': path.resolve(
        __dirname,
        '../packages/vite/src/client/browser.ts',
      ),
      // Local patched WASM entry (asyncWorkPoolSize: 0 for Vite/Playwright)
      'oxc-transform/browser.js': path.resolve(
        __dirname,
        'src/vendor/oxc-transform-browser.js',
      ),
      'oxc-transform': path.resolve(__dirname, 'src/vendor/oxc-transform-browser.js'),
      '@oxc-transform/binding-wasm32-wasi': path.resolve(
        __dirname,
        'src/vendor/oxc-transform-browser.js',
      ),
    },
  },
  // Base path for GitHub Pages deploy (repo: lofcz/browser-vite-ng).
  // Locally (dev/preview) we serve from '/'.
  base: process.env.GITHUB_PAGES ? '/browser-vite-ng/' : '/',
  server: {
    port: 5173,
    // Required headers for SharedArrayBuffer (used by OXC WASM workers)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',  // Required for top-level await in OXC WASM
    outDir: 'dist',
  },
  optimizeDeps: {
    exclude: [
      '@oxc-transform/binding-wasm32-wasi',
      'browser-vite',
      'rolldown',
    ],
  },
  worker: {
    format: 'es',
  },
});
