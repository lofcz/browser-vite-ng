/**
 * `node:zlib` browser stub.
 *
 * The browser-vite fork only references zlib types (ZlibOptions) — compression
 * middleware is not part of the browser dev server. Provide an inert surface
 * so any import resolves; compression functions throw a clear error since
 * there is no native deflate in this shim (and the fork doesn't use them).
 */

function unsupported(name: string): Error {
  return new Error(`[browser-vite] zlib.${name} is unavailable in the browser fork`);
}

export interface ZlibOptions {
  flush?: number;
  finishFlush?: number;
  chunkSize?: number;
  windowBits?: number;
  level?: number;
  memLevel?: number;
  strategy?: number;
  dictionary?: unknown;
}

export const constants = {
  Z_NO_FLUSH: 0,
  Z_FINISH: 4,
  Z_OK: 0,
  Z_DEFAULT_COMPRESSION: -1,
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
};

export function gzipSync(): never {
  throw unsupported('gzipSync');
}
export function gunzipSync(): never {
  throw unsupported('gunzipSync');
}
export function deflateSync(): never {
  throw unsupported('deflateSync');
}
export function inflateSync(): never {
  throw unsupported('inflateSync');
}
export function brotliCompressSync(): never {
  throw unsupported('brotliCompressSync');
}
export function brotliDecompressSync(): never {
  throw unsupported('brotliDecompressSync');
}
export function gzip(_b: unknown, cb?: (e: Error | null, r: unknown) => void): void {
  if (cb) queueMicrotask(() => cb(unsupported('gzip'), undefined));
}
export function gunzip(_b: unknown, cb?: (e: Error | null, r: unknown) => void): void {
  if (cb) queueMicrotask(() => cb(unsupported('gunzip'), undefined));
}

export default {
  constants,
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  brotliCompressSync,
  brotliDecompressSync,
  gzip,
  gunzip,
};
