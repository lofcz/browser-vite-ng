/**
 * /@react-refresh module served to preview-iframe modules.
 *
 * Full-fidelity analogue of @vitejs/plugin-react's virtual react-refresh
 * module: the vendored `react-refresh` runtime plus the small HMR helpers the
 * refresh wrapper expects (__hmr_import, registerExportsForReactRefresh,
 * validateRefreshBoundaryAndEnqueueUpdate). The boundary logic is the real
 * Fast Refresh algorithm (isReactRefreshBoundary / getRefreshBoundarySignature
 * from the react-refresh Babel plugin).
 *
 * The vendored CJS runtime is loaded as raw text (esbuild `text` loader) and
 * evaluated once here to populate `exports` — the bundle stays small and the
 * vendored source is never re-parsed by esbuild as TS.
 */

// Instrumented: the vendored runtime records mountedRoots/pending/signature
// diagnostics onto window (window.__rr_*) so we can trace state loss.
import runtimeSrc from '../vendor/react-refresh-runtime.js';

// Evaluate the vendored react-refresh CJS runtime into `exports`. The source
// guards on process.env.NODE_ENV !== 'production', so provide a dev env.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exports: any = {};
const process = { env: { NODE_ENV: 'development' } };
// eslint-disable-next-line @typescript-eslint/no-implied-eval
new Function('exports', 'process', runtimeSrc)(exports, process);

// ---- HMR helpers expected by the refresh wrapper ----

function isReactRefreshBoundary(exports: Record<string, unknown>): boolean {
  if (exports == null || typeof exports !== 'object') return false;
  let hasExports = false;
  let areAllReactComponents = true;
  for (const key of Object.keys(exports)) {
    hasExports = true;
    if (key === '__esModule') continue;
    const desc = Object.getOwnPropertyDescriptor(exports, key);
    if (desc && desc.get) return false;
    const exportValue = exports[key];
    if (typeof exportValue !== 'function') {
      areAllReactComponents = false;
    } else if (!(exportValue.name.length > 0 && exportValue.name[0] >= 'A' && exportValue.name[0] <= 'Z')) {
      areAllReactComponents = false;
    }
  }
  return hasExports && areAllReactComponents;
}

function getRefreshBoundarySignature(
  exports: Record<string, unknown>,
): Array<{ type: unknown; key: string }> {
  const signature: Array<{ type: unknown; key: string }> = [];
  for (const key of Object.keys(exports)) {
    if (key === '__esModule') continue;
    const desc = Object.getOwnPropertyDescriptor(exports, key);
    if (desc && desc.get) continue;
    const exportValue = exports[key];
    if (typeof exportValue !== 'function') continue;
    signature.push({ type: exportValue, key });
  }
  return signature;
}

function isEqualSignature(
  a: Array<{ type: unknown; key: string }>,
  b: Array<{ type: unknown; key: string }>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
    const familyA = exports.getFamilyByType(a[i].type);
    const familyB = exports.getFamilyByType(b[i].type);
    if (familyA !== familyB) return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __hmr_import(module: string): Promise<any> {
  // `module` is the module's servable path (e.g. /src/Counter.tsx), which a
  // blob-URL module can't resolve natively. Delegate to the iframe runtime's
  // module loader, which maps the path to its live blob URL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loader = (window as any).__vite_hmr_import as
    | ((m: string) => Promise<unknown>)
    | undefined;
  if (loader) return loader(module) as Promise<unknown>;
  return import(/* @vite-ignore */ module);
}

export function registerExportsForReactRefresh(
  id: string,
  currentExports: Record<string, unknown>,
): void {
  if (isReactRefreshBoundary(currentExports)) {
    for (const { type, key } of getRefreshBoundarySignature(currentExports)) {
      exports.register(type, id + ' ' + key);
    }
  }
}

export function validateRefreshBoundaryAndEnqueueUpdate(
  _id: string,
  currentExports: Record<string, unknown>,
  nextExports: Record<string, unknown>,
): string | undefined {
  const currentIsBoundary = isReactRefreshBoundary(currentExports);
  const nextIsBoundary = isReactRefreshBoundary(nextExports);
  if (currentIsBoundary !== nextIsBoundary) {
    return 'export boundary changed';
  }
  if (!currentIsBoundary) return undefined;
  const currentSig = getRefreshBoundarySignature(currentExports);
  const nextSig = getRefreshBoundarySignature(nextExports);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = (window as any).__vite_refresh_log as ((m: string) => void) | undefined;
  const equal = isEqualSignature(currentSig, nextSig);
  log?.(
    `[refresh] validate ${_id}: curBoundary=${currentIsBoundary} nextBoundary=${nextIsBoundary} curSig=${currentSig
      .map((s) => s.key)
      .join(',')} nextSig=${nextSig.map((s) => s.key).join(',')} equal=${equal}`,
  );
  if (!equal) {
    return 'export signature changed';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (!w.__vite_plugin_react_timeout) {
    w.__vite_plugin_react_timeout = setTimeout(() => {
      w.__vite_plugin_react_timeout = 0;
      const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      const renderers = hook?.renderers ? hook.renderers.size : 'n/a';
      log?.(`[refresh] performReactRefresh() for ${_id}; renderers=${renderers} mountedRoots=${w.__rr_mountedRoots ?? '?'} pending=${w.__rr_pending ?? '?'} sig cur=${w.__rr_sigCur ?? '?'} next=${w.__rr_sigNext ?? '?'}`);
      const result = exports.performReactRefresh();
      log?.(
        `[refresh] performReactRefresh() -> ${
          result === null
            ? 'null (no refresh enqueued)'
            : `update: updated=${result.updatedFamilies?.size} stale=${result.staleFamilies?.size}`
        }`,
      );
    }, 30);
  }
  return undefined;
}

// ---- Re-export the vendored runtime's public API ----
export const injectIntoGlobalHook = exports.injectIntoGlobalHook;
export const register = exports.register;
export const setSignature = exports.setSignature;
export const collectCustomHooksForSignature = exports.collectCustomHooksForSignature;
export const createSignatureFunctionForTransform = exports.createSignatureFunctionForTransform;
export const performReactRefresh = exports.performReactRefresh;
export const getFamilyByID = exports.getFamilyByID;
export const getFamilyByType = exports.getFamilyByType;
