/**
 * Browser bundle for browser-vite.
 * Self-contained entry (src/browser) — no Node server / Rolldown runtime.
 */
import { defineConfig } from 'rolldown'

export default defineConfig({
  input: {
    index: './src/browser/index.ts',
  },
  platform: 'browser',
  output: {
    dir: 'dist/browser',
    format: 'esm',
    sourcemap: true,
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
  external: [
    'oxc-transform',
    '@oxc-transform/binding-wasm32-wasi',
  ],
  define: {
    'process.env.VITE_BROWSER': JSON.stringify('true'),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})
