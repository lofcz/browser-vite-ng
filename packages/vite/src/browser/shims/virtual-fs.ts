/**
 * Shared fs-shim types + Node-style error factory, ported from almostnode's
 * virtual-fs.ts. The tree-based `VirtualFS` class is NOT ported: browser-vite
 * already has a lean flat VFS (../vfs.ts) which the fs shim backs onto. Only
 * the pieces the shims actually consume live here.
 */

export interface Stats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  size: number;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  birthtime: Date;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  rdev: number;
  blksize: number;
  blocks: number;
}

export type WatchEventType = 'change' | 'rename';
export type WatchListener = (eventType: WatchEventType, filename: string | null) => void;

export interface FSWatcher {
  close(): void;
  ref(): this;
  unref(): this;
}

export interface NodeError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
}

export function createNodeError(
  code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EEXIST' | 'ENOTEMPTY',
  syscall: string,
  path: string,
  message?: string,
): NodeError {
  const errno: Record<string, number> = {
    ENOENT: -2,
    ENOTDIR: -20,
    EISDIR: -21,
    EEXIST: -17,
    ENOTEMPTY: -39,
  };
  const messages: Record<string, string> = {
    ENOENT: 'no such file or directory',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    EEXIST: 'file already exists',
    ENOTEMPTY: 'directory not empty',
  };
  const err = new Error(
    message || `${code}: ${messages[code]}, ${syscall} '${path}'`,
  ) as NodeError;
  err.code = code;
  err.errno = errno[code];
  err.syscall = syscall;
  err.path = path;
  return err;
}
