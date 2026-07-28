/**
 * Browser `node:fs` shim — a REAL working filesystem backed by browser-vite's
 * VFS (the same in-memory store the dev server serves), modeled on
 * almostnode's `createFsShim`. Unlike Vite's default browser externalization
 * (an EMPTY object that crashes `fs.promises.readFile` destructuring at module
 * init), this is structurally complete AND functional: reads hit the live VFS,
 * so Node-side plugins (postcss-load-config → lilconfig, etc.) can actually
 * read project files (package.json, configs) exactly as they would on disk.
 *
 * One module exposes the full surface — sync, callback-style, `promises`,
 * `constants`, and `Dirent`. `node:fs/promises` is served as `fs.promises`
 * (see fs-promises.ts), mirroring almostnode's
 * `require('fs/promises') === fsShim.promises`.
 */

import {
  readVirtualFile,
  listVirtualFiles,
  hasVirtualFile,
  setVirtualFile,
} from '../vfs';
import { createNodeError } from './virtual-fs';
import type { Stats, FSWatcher, WatchListener } from './virtual-fs';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type PathLike = string | URL;

function toPath(p: unknown): string {
  let s: string;
  if (typeof p === 'string') s = p;
  else if (p instanceof URL) s = decodeURIComponent(p.pathname);
  else s = String(p);
  s = s.replace(/\\/g, '/');
  // Strip Windows drive letters & file:// prefixes so VFS paths line up.
  s = s.replace(/^file:\/\//, '').replace(/^[A-Za-z]:\//, '/');
  return s;
}

// ---- Directory emulation over the flat VFS path list ------------------------

function isDir(path: string): boolean {
  const prefix = path === '/' ? '/' : path.replace(/\/$/, '') + '/';
  return listVirtualFiles().some((f) => f.startsWith(prefix));
}

function dirEntries(path: string): string[] {
  const norm = path === '/' ? '/' : path.replace(/\/$/, '') + '/';
  const out = new Set<string>();
  for (const f of listVirtualFiles()) {
    if (!f.startsWith(norm)) continue;
    const rest = f.slice(norm.length);
    if (!rest) continue;
    out.add(rest.split('/')[0]);
  }
  return [...out];
}

function makeStats(path: string, directory: boolean, size: number) {
  const now = Date.now();
  return {
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size,
    mode: directory ? 0o40755 : 0o100644,
    mtime: new Date(now),
    atime: new Date(now),
    ctime: new Date(now),
    birthtime: new Date(now),
    mtimeMs: now,
    atimeMs: now,
    ctimeMs: now,
    birthtimeMs: now,
    nlink: 1,
    uid: 0,
    gid: 0,
    dev: 0,
    ino: 0,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
  };
}

function statPath(path: string) {
  if (hasVirtualFile(path)) {
    const content = readVirtualFile(path) ?? '';
    return makeStats(path, false, encoder.encode(content).byteLength);
  }
  if (path === '/' || isDir(path)) return makeStats(path, true, 0);
  throw createNodeError('ENOENT', 'stat', path);
}

class Dirent {
  constructor(
    public name: string,
    private _dir: boolean,
    private _file: boolean,
  ) {}
  isDirectory() { return this._dir; }
  isFile() { return this._file; }
  isBlockDevice() { return false; }
  isCharacterDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
  isSymbolicLink() { return false; }
}

function makeBuffer(data: Uint8Array): Uint8Array & { toString(enc?: string): string } {
  const buf = data as Uint8Array & { toString(enc?: string): string };
  Object.defineProperty(buf, 'toString', {
    value(enc?: string) {
      if (!enc || enc === 'utf8' || enc === 'utf-8') return decoder.decode(this);
      if (enc === 'base64') return btoa(String.fromCharCode(...this));
      if (enc === 'hex') return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
      return decoder.decode(this);
    },
    writable: true,
    configurable: true,
  });
  return buf;
}

// ---- Sync API ---------------------------------------------------------------

export function readFileSync(p: PathLike, opt?: string | { encoding?: string | null }): unknown {
  const path = toPath(p);
  const content = readVirtualFile(path);
  if (content === undefined) throw createNodeError('ENOENT', 'open', path);
  const enc = typeof opt === 'string' ? opt : opt?.encoding;
  if (enc === 'utf8' || enc === 'utf-8') return content;
  return makeBuffer(encoder.encode(content));
}

export function writeFileSync(p: PathLike, data: string | Uint8Array): void {
  const path = toPath(p);
  setVirtualFile(path, typeof data === 'string' ? data : decoder.decode(data));
}

export function existsSync(p: PathLike): boolean {
  const path = toPath(p);
  return hasVirtualFile(path) || path === '/' || isDir(path);
}

export function statSync(p: PathLike, opt?: { throwIfNoEntry?: boolean }) {
  const path = toPath(p);
  try {
    return statPath(path);
  } catch (e) {
    if (opt?.throwIfNoEntry === false) return undefined;
    throw e;
  }
}

export const lstatSync = statSync;

export function readdirSync(p: PathLike, opt?: { withFileTypes?: boolean } | string): unknown {
  const path = toPath(p);
  const names = dirEntries(path);
  const withTypes = typeof opt === 'object' && opt?.withFileTypes;
  if (!withTypes) return names;
  return names.map((name) => {
    const child = (path === '/' ? '/' : path.replace(/\/$/, '') + '/') + name;
    const dir = isDir(child) && !hasVirtualFile(child);
    return new Dirent(name, dir, !dir);
  });
}

export function mkdirSync(): void {
  // Directories are implicit in the flat VFS — nothing to create.
}
export function realpathSync(p: PathLike): string {
  return toPath(p);
}
(realpathSync as { native?: (p: PathLike) => string }).native = (p) => toPath(p);
export function accessSync(p: PathLike): void {
  if (!existsSync(p)) throw createNodeError('ENOENT', 'access', toPath(p));
}
export function copyFileSync(src: PathLike, dest: PathLike): void {
  const content = readVirtualFile(toPath(src));
  if (content === undefined) throw createNodeError('ENOENT', 'open', toPath(src));
  setVirtualFile(toPath(dest), content);
}
export function unlinkSync(p: PathLike): void {
  /* VFS deletion is handled elsewhere; no-op for plugin scratch files. */
}
export function rmSync(): void {}
export function rmdirSync(): void {}
export function renameSync(a: PathLike, b: PathLike): void {
  const content = readVirtualFile(toPath(a));
  if (content !== undefined) setVirtualFile(toPath(b), content);
}
export function watch(): { close(): void } {
  return { close() {} };
}
export function watchFile(): void {
  /* No persistent watching in the browser VFS shim; HMR is event-driven. */
}
export function unwatchFile(): void {
  /* Paired no-op for watchFile. */
}
export function createReadStream(p: PathLike) {
  const content = readVirtualFile(toPath(p)) ?? '';
  const { Readable } = { Readable: undefined as never };
  void Readable;
  return content; // Callers in the fork only need the path read; streams unused.
}
export function createWriteStream() {
  return undefined;
}

// ---- Callback-style async API ----------------------------------------------

type Cb<T> = (err: Error | null, result?: T) => void;
function asyncify<T>(fn: () => T, cb?: Cb<T>): void {
  try {
    const r = fn();
    if (cb) queueMicrotask(() => cb(null, r));
  } catch (e) {
    if (cb) queueMicrotask(() => cb(e as Error));
  }
}

export function readFile(p: PathLike, optOrCb?: unknown, cb?: Cb<unknown>): void {
  const callback = (typeof optOrCb === 'function' ? optOrCb : cb) as Cb<unknown> | undefined;
  asyncify(() => readFileSync(p, typeof optOrCb === 'object' ? (optOrCb as never) : undefined), callback);
}
export function stat(p: PathLike, cb?: Cb<unknown>): void {
  asyncify(() => statSync(p), cb);
}
export const lstat = stat;
export function readdir(p: PathLike, optOrCb?: unknown, cb?: Cb<unknown>): void {
  const callback = (typeof optOrCb === 'function' ? optOrCb : cb) as Cb<unknown> | undefined;
  asyncify(() => readdirSync(p, typeof optOrCb === 'object' ? (optOrCb as never) : undefined), callback);
}
export function realpath(p: PathLike, cb?: Cb<string>): void {
  asyncify(() => realpathSync(p), cb);
}
export function access(p: PathLike, modeOrCb?: unknown, cb?: Cb<void>): void {
  const callback = (typeof modeOrCb === 'function' ? modeOrCb : cb) as Cb<void> | undefined;
  asyncify(() => accessSync(p), callback);
}

// ---- promises API ------------------------------------------------------------

async function pReadFile(p: PathLike, opt?: string | { encoding?: string | null }): Promise<unknown> {
  return readFileSync(p, opt as never);
}

export const promises = {
  readFile: pReadFile,
  async writeFile(p: PathLike, data: string | Uint8Array) {
    writeFileSync(p, data);
  },
  async stat(p: PathLike) {
    return statPath(toPath(p));
  },
  async lstat(p: PathLike) {
    return statPath(toPath(p));
  },
  async readdir(p: PathLike, opt?: { withFileTypes?: boolean }) {
    return readdirSync(p, opt) as unknown;
  },
  async mkdir() {},
  async access(p: PathLike) {
    accessSync(p);
  },
  async realpath(p: PathLike) {
    return realpathSync(p);
  },
  async copyFile(src: PathLike, dest: PathLike) {
    copyFileSync(src, dest);
  },
  async unlink() {},
  async rm() {},
  async rmdir() {},
  async rename(a: PathLike, b: PathLike) {
    renameSync(a, b);
  },
  async open(p: PathLike) {
    // Minimal FileHandle for read flows.
    return {
      fd: 0,
      async readFile(opt?: string | { encoding?: string | null }) {
        return readFileSync(p, opt as never);
      },
      async stat() {
        return statPath(toPath(p));
      },
      async close() {},
    };
  },
};

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export class Stats {}
export class Dir {}
export class DirentClass {}
export { Dirent };
export const ReadStream = class {};
export const WriteStream = class {};
export const FileReadStream = class {};
export const FileWriteStream = class {};

export default {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  accessSync,
  copyFileSync,
  unlinkSync,
  rmSync,
  rmdirSync,
  renameSync,
  watch,
  watchFile,
  unwatchFile,
  createReadStream,
  createWriteStream,
  readFile,
  stat,
  lstat,
  readdir,
  realpath,
  access,
  promises,
  constants,
  Stats,
  Dir,
  Dirent,
  ReadStream,
  WriteStream,
};
