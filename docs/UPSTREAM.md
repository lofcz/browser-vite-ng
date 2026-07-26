# Upstream Vite sync

Pinned upstream: **Vite 8.1.5** (`v8.1.5`)  
Package version: `8.1.5-browser.1`  
Declared in [`packages/vite/package.json`](../packages/vite/package.json) as `// UPSTREAM_VITE_VERSION=8.1.5`.

## Hard requirements

1. **Full HMR fidelity — no simplifications.**  
   Browser transport may replace WebSocket with HotChannel / `postMessage`, and FS reads may use `setBrowserVirtualFileContent`, but the algorithm must remain Vite’s:
   - `handleHMRUpdate` / `updateModules` / `propagateUpdate` in `src/node/server/hmr.ts`
   - `HMRClient` / `HMRContext` in `src/shared/hmr.ts`
   - Real `import.meta.hot` accept / dispose / prune / invalidate
   - Same `HotPayload` shapes (`update`, `full-reload`, `prune`, `error`, …)

2. **Thin, marked patches.** Every edit inside upstream `src/node/**` must be wrapped in:
   ```ts
   // BROWSER VITE patch: <why>
   ...
   // BROWSER VITE patch end
   ```

3. Prefer new browser behavior under `src/browser/` and `src/client/browser.ts` over editing `src/node/`.

## Bump checklist (e.g. 8.1.5 → 8.1.x / 8.2)

1. `git fetch` / sparse-clone `vitejs/vite` at the new tag into `.vite-upstream-<ver>/`.
2. Copy upstream trees into `packages/vite` (`src/node`, `src/client` except `browser.ts`, `src/module-runner`, `src/shared`, `src/types`, `types/`, build configs).
3. Restore `src/browser/**` and `src/client/browser.ts`.
4. Re-apply marked `BROWSER VITE patch` sites (search the repo for `BROWSER VITE`).
5. Bump `version` to `<ver>-browser.1` and `UPSTREAM_VITE_VERSION`.
6. `pnpm build` / `pnpm build-browser` in `packages/vite`.
7. Upgrade `example` host `vite` to the same version.
8. Run Playwright: `cd example && npm test` — including HMR boundary / full-reload cases.
9. Update this file’s pin and [README.md](../README.md) version table.

## Helper

```bash
node scripts/sync-upstream-vite.mjs --tag v8.1.5
```

(Staging only; does not overwrite until you confirm.)

## Related

- OXC WASM example work: [PR #3](https://github.com/BLamy/browser-vite-6/pull/3) (`oxc-pr3` branch)
- HotChannel: `packages/vite/src/browser/hotChannel.ts`
- HMR adapter: `packages/vite/src/browser/server/hmr.ts`
- HMR client: `packages/vite/src/client/browser.ts`
