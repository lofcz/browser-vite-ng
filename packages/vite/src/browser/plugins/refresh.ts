/**
 * React Fast Refresh wiring for the browser dev pipeline — a faithful port of
 * @vitejs/plugin-react's `refresh-utils` (addRefreshWrapper), adapted to the
 * Oxc WASM transformer (which performs the $RefreshReg$/$RefreshSig$
 * injection natively via `jsx.refresh`, conforming to facebook/react-refresh).
 *
 * No regex boundary detection: whether a module is a refresh boundary is
 * determined by the presence of Oxc-emitted `$RefreshReg$(` calls, exactly
 * like plugin-react (`refreshContentRE`). The boundary *validation* at update
 * time is done by the real react-refresh runtime
 * (validateRefreshBoundaryAndEnqueueUpdate) served from /@react-refresh.
 */

export const REACT_REFRESH_PUBLIC_PATH = '/@react-refresh'

// Matches Oxc-emitted registration calls (same signal plugin-react keys on).
const refreshContentRE = /\$RefreshReg\$\(/

/**
 * Append the Fast Refresh footer to a module that contains refresh
 * registrations. Ported from plugin-react's addRefreshWrapper. Returns the
 * original code untouched when the module has no refresh boundary.
 */
export function addRefreshWrapper(code: string, id: string): string {
  if (!refreshContentRE.test(code)) return code
  return (
    code +
    `
import * as RefreshRuntime from ${JSON.stringify(REACT_REFRESH_PUBLIC_PATH)};
if (import.meta.hot) {
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh(${JSON.stringify(id)}, currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate(${JSON.stringify(id)}, currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}
function $RefreshReg$(type, id) { return RefreshRuntime.register(type, ${JSON.stringify(id)} + " " + id); }
function $RefreshSig$() { return RefreshRuntime.createSignatureFunctionForTransform(); }
`
  )
}
