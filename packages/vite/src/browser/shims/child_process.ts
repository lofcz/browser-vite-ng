/**
 * `node:child_process` browser stub.
 *
 * Processes cannot be spawned in a browser. Vite's Node code imports this for
 * editor launching (`launch-editor`), git helpers, and shell-outs — all
 * no-ops in the fork. exec/execSync/spawn return harmless inert results so
 * importing modules initialize and any guarded call degrades gracefully.
 */

function unsupported(name: string): Error {
  return new Error(`[browser-vite] child_process.${name} is unavailable in the browser fork`);
}

export interface ChildProcess {
  pid: number;
  killed: boolean;
  kill(): void;
  on(): ChildProcess;
  stdout: null;
  stderr: null;
  stdin: null;
}

const inert = (): ChildProcess => ({
  pid: -1,
  killed: true,
  kill() {},
  on() {
    return this;
  },
  stdout: null,
  stderr: null,
  stdin: null,
});

export function spawn(): ChildProcess {
  return inert();
}
export function exec(cmd: string, cb?: (err: Error | null, stdout: string, stderr: string) => void): ChildProcess {
  if (cb) queueMicrotask(() => cb(unsupported('exec'), '', ''));
  return inert();
}
export function execFile(_file: string, _args?: unknown, cb?: (err: Error | null) => void): ChildProcess {
  if (typeof _args === 'function') cb = _args;
  if (cb) queueMicrotask(() => cb!(unsupported('execFile')));
  return inert();
}
export function fork(): ChildProcess {
  return inert();
}
export function execSync(): never {
  throw unsupported('execSync');
}
export function spawnSync(): { status: number; stdout: string; stderr: string; error?: Error } {
  return { status: 1, stdout: '', stderr: '', error: unsupported('spawnSync') };
}
export function execFileSync(): never {
  throw unsupported('execFileSync');
}

export default { spawn, exec, execFile, fork, execSync, spawnSync, execFileSync };
