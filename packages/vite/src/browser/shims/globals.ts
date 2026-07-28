/**
 * Node global installation for the browser-vite fork.
 *
 * Node-side Vite code (and CJS deps) reference Node GLOBALS like `process`
 * and `Buffer` directly (not via imports). Those don't exist in a browser, so
 * before the fork's engine boots we install the shim implementations onto
 * globalThis — exactly like a bundler's `define`/polyfill injection would.
 *
 * Import this module for its side effect at the app entry point, before any
 * browser-vite code runs.
 */
import { process as processShim } from './process';
import { Buffer as BufferShim } from './buffer';

const g = globalThis as Record<string, unknown>;

if (typeof g.process === 'undefined') {
  g.process = processShim;
}
if (typeof g.Buffer === 'undefined') {
  g.Buffer = BufferShim;
}
// Node's `global` is an alias for globalThis; some deps reference it directly.
if (typeof g.global === 'undefined') {
  g.global = globalThis;
}
