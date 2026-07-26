/**
 * Precompiles the preview-iframe runtime modules to plain JS at build/dev time.
 *
 * The example deploys as a static page (e.g. GitHub Pages), so the iframe's
 * bootstrap can't rely on a dev server or runtime Oxc. This plugin esbuilds
 * `src/iframe/runtime.ts` and `src/iframe/client.ts` once and exposes the
 * resulting JS as a virtual module that `main.ts` inlines into the iframe HTML.
 */
import type { Plugin } from 'vite';
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VIRTUAL_ID = 'virtual:iframe-runtime';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [path.resolve(__dirname, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    external: ['es-module-lexer'],
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/**
 * Bundle the /@react-refresh module. The vendored react-refresh CJS runtime
 * is loaded as raw text (esbuild `text` loader) and evaluated inside the
 * iframe at runtime — the bundle stays small and the vendored source is never
 * re-parsed by esbuild as TS.
 */
async function bundleRefresh(): Promise<string> {
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'src/iframe/react-refresh.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    plugins: [
      {
        name: 'refresh-runtime-as-text',
        setup(b) {
          b.onLoad({ filter: /react-refresh-runtime\.js$/ }, async (args) => ({
            contents: await fs.promises.readFile(args.path, 'utf-8'),
            loader: 'text',
          }));
        },
      },
    ],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

export function iframeRuntimePlugin(): Plugin {
  return {
    name: 'iframe-runtime',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      const [runtime, client, refresh] = await Promise.all([
        bundle('src/iframe/runtime.ts'),
        bundle('src/iframe/client.ts'),
        bundleRefresh(),
      ]);
      return [
        `export const iframeRuntimeJs = ${JSON.stringify(runtime)};`,
        `export const iframeClientJs = ${JSON.stringify(client)};`,
        `export const reactRefreshJs = ${JSON.stringify(refresh)};`,
      ].join('\n');
    },
    // Rebuild the virtual module when the iframe sources change in dev.
    configureServer(server) {
      const watch = [
        'src/iframe/runtime.ts',
        'src/iframe/client.ts',
        'src/iframe/react-refresh.ts',
        'src/vendor/react-refresh-runtime.js',
      ].map((f) => path.resolve(__dirname, f));
      server.watcher.add(watch);
      server.watcher.on('change', (file) => {
        if (watch.includes(file)) {
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
      });
    },
  };
}
