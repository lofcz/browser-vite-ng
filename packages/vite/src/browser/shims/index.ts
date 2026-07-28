/**
 * Node.js builtin shims for the browser-vite fork.
 * Modeled on almostnode's shims/ directory: each builtin is a self-contained
 * module that provides a functional browser implementation.
 *
 * Currently wired:
 *   - node:fs          → ./fs.ts (VFS-backed, full sync+async+promises surface)
 *   - node:fs/promises → ./fs-promises.ts (fs.promises)
 *
 * The remaining almostnode shims (path, os, url, etc.) are present for future
 * use; they are not yet wired into the dev server.
 */
export { default as fs } from './fs';
export { default as fsPromises } from './fs-promises';
