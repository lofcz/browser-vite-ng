// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import alias from '@rollup/plugin-alias'
import replace from '@rollup/plugin-replace'
import license from 'rollup-plugin-license'
import MagicString from 'magic-string'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

/**
 * @type { import('rollup').RollupOptions }
 */
const envConfig = {
  input: path.resolve(__dirname, 'src/client/env.ts'),
  plugins: [
    typescript({
      target: 'es2020',
      include: ['src/client/env.ts'],
      baseUrl: path.resolve(__dirname, 'src/env'),
      paths: {
        'types/*': ['../../types/*']
      }
    })
  ],
  output: {
    file: path.resolve(__dirname, 'dist/client', 'env.mjs'),
    sourcemap: true,
    format: 'es'
  }
}

/**
 * @type { import('rollup').RollupOptions }
 */
const clientConfig = {
  input: path.resolve(__dirname, 'src/client/client.ts'),
  external: ['./env', '@vite/env'],
  plugins: [
    typescript({
      target: 'es2020',
      include: ['src/client/**/*.ts'],
      baseUrl: path.resolve(__dirname, 'src/client'),
      paths: {
        'types/*': ['../../types/*']
      }
    })
  ],
  output: {
    file: path.resolve(__dirname, 'dist/client', 'client.mjs'),
    sourcemap: true,
    format: 'es'
  }
}

/**
 * @type { import('rollup').RollupOptions }
 */
const browserClientConfig = {
  input: path.resolve(__dirname, 'src/client/browser.ts'),
  external: ['./env'],
  plugins: [
    typescript({
      target: 'es2020',
      include: ['src/client/**/*.ts'],
      baseUrl: path.resolve(__dirname, 'src/client'),
      paths: {
        'types/*': ['../../types/*']
      }
    })
  ],
  output: {
    file: path.resolve(__dirname, 'dist/client', 'browser.mjs'),
    sourcemap: true,
    format: 'es'
  }
}

/**
 * @type { import('rollup').RollupOptions }
 */
const sharedNodeOptions = {
  treeshake: {
    moduleSideEffects: 'no-external',
    propertyReadSideEffects: false,
    tryCatchDeoptimization: false
  },
  output: {
    dir: path.resolve(__dirname, 'dist'),
    entryFileNames: `node/[name].js`,
    chunkFileNames: 'node/chunks/dep-[hash].js',
    exports: 'named',
    format: 'es',
    externalLiveBindings: false,
    freeze: false,
    sourcemap: true
  },
  onwarn(warning, warn) {
    if (warning.message.includes('Package subpath')) {
      return
    }
    if (warning.message.includes('Use of eval')) {
      return
    }
    if (warning.message.includes('Circular dependency')) {
      return
    }
    warn(warning)
  }
}

/**
 * @param {boolean} isProduction
 * @returns {import('rollup').RollupOptions}
 */
const createNodeConfig = (isProduction) => {
  /**
   * @type { import('rollup').RollupOptions }
   */
  const nodeConfig = {
    ...sharedNodeOptions,
    input: {
      index: path.resolve(__dirname, 'src/node/index.ts'),
      cli: path.resolve(__dirname, 'src/node/cli.ts')
    },
    external: [
      'fsevents',
      'esbuild',
      'postcss',
      'resolve',
      'rollup',
      'sass',
      ...(isProduction ? [] : Object.keys(pkg.dependencies))
    ],
    plugins: [
      alias({
        entries: {
          '@vue/compiler-dom': require.resolve(
            '@vue/compiler-dom/dist/compiler-dom.cjs.js'
          )
        }
      }),
      nodeResolve({ preferBuiltins: true }),
      typescript({
        target: 'es2022',
        include: ['src/**/*.ts', 'types/**'],
        exclude: ['src/**/__tests__/**'],
        esModuleInterop: true,
        ...(isProduction
          ? {}
          : {
              tsconfig: 'tsconfig.base.json',
              declaration: true,
              declarationDir: path.resolve(__dirname, 'dist/')
            })
      }),
      isProduction &&
        shimDepsPlugin({
          'plugins/terser.ts': {
            src: `require.resolve('terser'`,
            replacement: `require.resolve('browser-vite/dist/node/terser'`
          }
        }),
      commonjs({
        extensions: ['.js'],
        ignore: ['bufferutil', 'utf-8-validate']
      }),
      json(),
      isProduction && licensePlugin()
    ].filter(Boolean)
  }

  return nodeConfig
}

/**
 * Browser build configuration - this is the key output for browser-vite
 * @type { import('rollup').RollupOptions }
 */
const browserConfig = {
  input: path.resolve(__dirname, 'src/browser/index.ts'),
  external: ['fsevents', 'sass', 'fs', 'node:fs', 'node:path', 'node:url'],
  plugins: [
    viteForBrowserPlugin(),
    replace({
      preventAssignment: true,
      values: {
        'process.env.DEBUG': 'false',
        'process.env.VITE_BROWSER': 'true',
        'process.env.NODE_ENV': JSON.stringify('production')
      }
    }),
    alias({
      entries: {}
    }),
    nodeResolve({
      mainFields: ['module', 'jsnext:main', 'browser'],
      preferBuiltins: false,
      exportConditions: ['browser', 'default', 'module', 'import'],
      dedupe: ['postcss']
    }),
    typescript({
      target: 'es2022',
      include: ['src/**/*.ts'],
      esModuleInterop: true
    }),
    shimDepsPlugin({
      'plugins/terser.ts': {
        src: `require.resolve('terser'`,
        replacement: `require.resolve('browser-vite/dist/node/terser'`
      }
    }),
    commonjs({
      transformMixedEsModules: true,
      requireReturnsDefault: 'auto',
      ignore: ['bufferutil', 'utf-8-validate']
    }),
    json()
  ],
  treeshake: {
    moduleSideEffects: 'no-external',
    propertyReadSideEffects: false,
    tryCatchDeoptimization: false
  },
  output: {
    dir: path.resolve(__dirname, 'dist/browser'),
    format: 'es',
    sourcemap: true
  }
}

/**
 * Terser bundle config
 * @type { import('rollup').RollupOptions }
 */
const terserConfig = {
  ...sharedNodeOptions,
  output: {
    ...sharedNodeOptions.output,
    exports: 'default',
    sourcemap: false
  },
  input: {
    terser: require.resolve('terser')
  },
  plugins: [nodeResolve(), commonjs()]
}

/**
 * @type { (deps: Record<string, { src?: string, replacement: string, pattern?: RegExp }>) => import('rollup').Plugin }
 */
function shimDepsPlugin(deps) {
  const transformed = {}

  return {
    name: 'shim-deps',
    transform(code, id) {
      for (const file in deps) {
        if (id.replace(/\\/g, '/').endsWith(file)) {
          const { src, replacement, pattern } = deps[file]

          const magicString = new MagicString(code)
          if (src) {
            const pos = code.indexOf(src)
            if (pos < 0) {
              this.error(
                `Could not find expected src "${src}" in file "${file}"`
              )
            }
            transformed[file] = true
            magicString.overwrite(pos, pos + src.length, replacement)
            console.log(`shimmed: ${file}`)
          }

          if (pattern) {
            let match
            while ((match = pattern.exec(code))) {
              transformed[file] = true
              const start = match.index
              const end = start + match[0].length
              magicString.overwrite(start, end, replacement)
            }
            if (!transformed[file]) {
              this.error(
                `Could not find expected pattern "${pattern}" in file "${file}"`
              )
            }
            console.log(`shimmed: ${file}`)
          }

          return {
            code: magicString.toString(),
            map: magicString.generateMap({ hires: 'boundary' })
          }
        }
      }
    },
    buildEnd(err) {
      if (!err) {
        for (const file in deps) {
          if (!transformed[file]) {
            this.warn(
              `Did not find "${file}" which is supposed to be shimmed, was the file renamed?`
            )
          }
        }
      }
    }
  }
}

function licensePlugin() {
  return license({
    thirdParty(dependencies) {
      const coreLicense = fs.readFileSync(
        path.resolve(__dirname, '../../LICENSE')
      )
      function sortLicenses(licenses) {
        let withParenthesis = []
        let noParenthesis = []
        licenses.forEach((lic) => {
          if (/^\(/.test(lic)) {
            withParenthesis.push(lic)
          } else {
            noParenthesis.push(lic)
          }
        })
        withParenthesis = withParenthesis.sort()
        noParenthesis = noParenthesis.sort()
        return [...noParenthesis, ...withParenthesis]
      }
      const licenses = new Set()
      const dependencyLicenseTexts = dependencies
        .sort(({ name: nameA }, { name: nameB }) =>
          nameA > nameB ? 1 : nameB > nameA ? -1 : 0
        )
        .map(
          ({
            name,
            license: depLicense,
            licenseText,
            author,
            maintainers,
            contributors,
            repository
          }) => {
            let text = `## ${name}\n`
            if (depLicense) {
              text += `License: ${depLicense}\n`
            }
            const names = new Set()
            if (author && author.name) {
              names.add(author.name)
            }
            for (const person of maintainers.concat(contributors)) {
              if (person && person.name) {
                names.add(person.name)
              }
            }
            if (names.size > 0) {
              text += `By: ${Array.from(names).join(', ')}\n`
            }
            if (repository) {
              text += `Repository: ${repository.url || repository}\n`
            }
            if (licenseText) {
              text +=
                '\n' +
                licenseText
                  .trim()
                  .replace(/(\r\n|\r)/gm, '\n')
                  .split('\n')
                  .map((line) => `> ${line}`)
                  .join('\n') +
                '\n'
            }
            licenses.add(depLicense)
            return text
          }
        )
        .join('\n---------------------------------------\n\n')
      const licenseText =
        `# Vite core license\n` +
        `Vite is released under the MIT license:\n\n` +
        coreLicense +
        `\n# Licenses of bundled dependencies\n` +
        `The published Vite artifact additionally contains code with the following licenses:\n` +
        `${sortLicenses(licenses).join(', ')}\n\n` +
        `# Bundled dependencies:\n` +
        dependencyLicenseTexts

      try {
        const existingLicenseText = fs.readFileSync('LICENSE.md', 'utf8')
        if (existingLicenseText !== licenseText) {
          fs.writeFileSync('LICENSE.md', licenseText)
          console.warn('\nLICENSE.md updated. You should commit the updated file.\n')
        }
      } catch {
        fs.writeFileSync('LICENSE.md', licenseText)
      }
    }
  })
}

/**
 * Browser shims plugin - provides browser-compatible replacements for Node.js modules
 * Updated for Vite 6 dependencies
 */
function viteForBrowserPlugin() {
  // Browser shims for Node.js-only dependencies
  const aliases = {
    // Logging - picocolors replaces chalk in Vite 6
    picocolors: `
      const identity = (s) => s;
      const p = {
        red: identity, green: identity, yellow: identity, blue: identity,
        magenta: identity, cyan: identity, white: identity, gray: identity,
        bold: identity, dim: identity, underline: identity, inverse: identity,
        hidden: identity, strikethrough: identity, black: identity,
        bgRed: identity, bgGreen: identity, bgYellow: identity, bgBlue: identity,
        bgMagenta: identity, bgCyan: identity, bgWhite: identity, bgBlack: identity,
        reset: identity, isColorSupported: false,
        createColors: () => p
      };
      export default p;
    `,
    // Legacy chalk support (for any remaining usage)
    chalk: `const p = new Proxy(s=>s, { get() {return p;}});export default p;`,

    // Debug logging - no-op in browser
    debug: `export default function debug() {return () => {}}`,

    // PostCSS config loading - not available in browser
    'postcss-load-config': `export default () => {throw new Error("No PostCSS Config found")}`,

    // Static file serving - not needed in browser
    sirv: `export default function () {}`,

    // File globbing - tinyglobby replaces fast-glob in Vite 6
    tinyglobby: `
      export async function glob() { return []; }
      export function globSync() { return []; }
      export async function expandGlob() { return []; }
      export default { glob, globSync, expandGlob };
    `,
    'fast-glob': `
      export default async function fg() { return []; }
      export const sync = () => [];
      export const async = async () => [];
      export const stream = () => { throw new Error('Not supported in browser'); };
      export const generateTasks = () => [];
      export const isDynamicPattern = () => false;
      export const escapePath = (s) => s;
    `,

    // File watching - stub for browser
    chokidar: `
      export const watch = () => ({
        on: function() { return this; },
        close: () => {},
        add: function() { return this; },
        unwatch: function() { return this; }
      });
      export default { watch };
    `,

    // Process utilities - stub for browser
    execa: `
      export const execa = () => Promise.reject(new Error('Not supported in browser'));
      export const execaSync = () => { throw new Error('Not supported in browser'); };
      export const execaCommand = () => Promise.reject(new Error('Not supported in browser'));
      export default execa;
    `,

    // Terminal utilities
    open: `export default () => Promise.resolve();`,
    'launch-editor-middleware': `export default () => (req, res, next) => next();`,

    // Compression - not needed in browser
    compression: `export default () => (req, res, next) => next();`,

    // HTTP proxy - not needed in browser
    'http-proxy': `
      export function createProxyServer() {
        return { web: () => {}, ws: () => {}, on: () => {} };
      }
      export default { createProxyServer };
    `,

    // Self-signed certs - not needed in browser
    selfsigned: `
      export function generate() { return { private: '', public: '', cert: '' }; }
      export default { generate };
    `,

    // WebSocket server - not needed in browser (we use client WS)
    ws: `
      export class WebSocketServer { constructor() {} on() {} close() {} }
      export class WebSocket { constructor() {} on() {} send() {} close() {} }
      export default WebSocket;
    `,

    // Connect middleware - stub for browser
    connect: `
      export default function createConnect() {
        const app = () => {};
        app.use = () => app;
        return app;
      }
    `,
    cors: `export default () => (req, res, next) => next();`,
    etag: `export default () => '';`,

    // Node.js built-in module shims
    'node:fs': `
      export const readFileSync = () => '';
      export const writeFileSync = () => {};
      export const existsSync = () => false;
      export const mkdirSync = () => {};
      export const readdirSync = () => [];
      export const statSync = () => ({});
      export const promises = {
        readFile: async () => '',
        writeFile: async () => {},
        readdir: async () => [],
        stat: async () => ({}),
        mkdir: async () => {},
        rm: async () => {},
        access: async () => {}
      };
      export default { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, promises };
    `,
    'node:path': `
      export const resolve = (...args) => args.join('/').replace(/\\/+/g, '/');
      export const dirname = (p) => p.split('/').slice(0, -1).join('/');
      export const basename = (p, ext) => { const b = p.split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
      export const extname = (p) => { const m = p.match(/\\.[^./\\\\]+$/); return m ? m[0] : ''; };
      export const join = (...args) => args.join('/').replace(/\\/+/g, '/');
      export const relative = (from, to) => to;
      export const isAbsolute = (p) => p.startsWith('/');
      export const normalize = (p) => p.replace(/\\/+/g, '/');
      export const sep = '/';
      export const posix = { resolve, dirname, basename, extname, join, relative, isAbsolute, normalize, sep };
      export default { resolve, dirname, basename, extname, join, relative, isAbsolute, normalize, sep, posix };
    `,
    'node:url': `
      export const fileURLToPath = (url) => url.replace('file://', '');
      export const pathToFileURL = (path) => new URL('file://' + path);
      export const URL = globalThis.URL;
      export default { fileURLToPath, pathToFileURL, URL };
    `,
    'node:module': `
      export const createRequire = () => () => {};
      export const builtinModules = [];
      export default { createRequire, builtinModules };
    `,

    // Source map support - stub
    'source-map-support': `
      export const install = () => {};
      export default { install };
    `
  }

  return {
    name: 'vite:browser',
    resolveId(id) {
      // Handle node: prefixed modules
      if (id.startsWith('node:')) {
        const modName = id.slice(5)
        if (`node:${modName}` in aliases) {
          return `\0browser_shim:node:${modName}`
        }
      }
      // Handle regular module names
      if (id in aliases) {
        return `\0browser_shim:${id}`
      }
      // Mark dependencies as external
      if (id in pkg.dependencies && !(id in aliases)) {
        return { id, external: true }
      }
      return null
    },
    load(id) {
      if (id.startsWith('\0browser_shim:')) {
        const shimName = id.slice('\0browser_shim:'.length)
        return aliases[shimName] || aliases[`node:${shimName}`]
      }
      return null
    },
    transform(code, id) {
      // Replace platform checks with false for browser
      let transformed = code
        .replace(
          /(os\.platform\(\)|process\.platform)\s*===\s*['"]win32['"]/g,
          'false'
        )
        .replace(/require\(['"]pnpapi['"]\)/g, 'undefined')
        .replace(/process\.versions\.pnp/g, 'undefined')

      // Only generate sourcemap if we made changes
      if (transformed !== code) {
        const ms = new MagicString(code)
        return {
          code: transformed,
          map: ms.generateMap({ hires: 'boundary' })
        }
      }
      return null
    }
  }
}

export default (commandLineArgs) => {
  const isDev = commandLineArgs.watch
  const isProduction = !isDev

  return [
    envConfig,
    clientConfig,
    browserClientConfig,
    browserConfig,
    createNodeConfig(isProduction),
    ...(isProduction ? [terserConfig] : [])
  ]
}
