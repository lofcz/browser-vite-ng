/**
 * `node:timers` browser shim — delegates to the browser's global timer APIs.
 * `node:timers/promises` maps here too via the resolver (promise variants).
 */

export function setTimeout<TArgs extends unknown[]>(
  cb: (...args: TArgs) => void,
  ms?: number,
  ...args: TArgs
): ReturnType<typeof globalThis.setTimeout> {
  return globalThis.setTimeout(cb, ms, ...args);
}
export function clearTimeout(id: unknown): void {
  globalThis.clearTimeout(id as number);
}
export function setInterval<TArgs extends unknown[]>(
  cb: (...args: TArgs) => void,
  ms?: number,
  ...args: TArgs
): ReturnType<typeof globalThis.setInterval> {
  return globalThis.setInterval(cb, ms, ...args);
}
export function clearInterval(id: unknown): void {
  globalThis.clearInterval(id as number);
}
export function setImmediate(cb: (...args: unknown[]) => void, ...args: unknown[]): number {
  return globalThis.setTimeout(cb, 0, ...args) as unknown as number;
}
export function clearImmediate(id: unknown): void {
  globalThis.clearTimeout(id as number);
}

// node:timers/promises
export const promises = {
  setTimeout(ms?: number, value?: unknown): Promise<unknown> {
    return new Promise((resolve) => globalThis.setTimeout(() => resolve(value), ms));
  },
  setImmediate(value?: unknown): Promise<unknown> {
    return new Promise((resolve) => globalThis.setTimeout(() => resolve(value), 0));
  },
  async *setInterval(ms: number, value?: unknown): AsyncGenerator<unknown> {
    while (true) {
      await new Promise((r) => globalThis.setTimeout(r, ms));
      yield value;
    }
  },
};

export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises };
