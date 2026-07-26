# browser-vite architecture (Vite 8.1.5)

This document defines the **full-fidelity** browser architecture. It is the
contract for all browser code. If a change would reduce fidelity below what is
described here, it is a bug, not an optimization.

## The non-negotiable rule

**No HMR / transform / module-graph simplifications.** Where upstream Vite runs
an algorithm (import analysis, hot-context injection, boundary propagation,
circular-import detection, prune, partial accept, sourcemap chains), browser-vite
runs the **same algorithm with the same semantics**. Only the *transport*
(WebSocket → HotChannel) and the *IO* (node:fs → virtual FS) may differ.

## What "the same algorithm" means

Vite's dev pipeline is a set of plugins over `createPluginContainer`, driven by
`transformRequest`, writing into an `EnvironmentModuleGraph`, with HMR computed
by `handleHMRUpdate`/`updateModules`/`propagateUpdate` and applied in the
client by `HMRClient`.

browser-vite reproduces **each stage**:

| Stage (upstream) | File (upstream) | browser-vite |
|---|---|---|
| Oxc transform | `src/node/plugins/oxc.ts` | `src/browser/plugins/oxc.ts` → Oxc **WASM** |
| Resolve | `src/node/plugins/resolve.ts` | `src/browser/plugins/resolve.ts` (virtual FS) |
| Import analysis + hot-context injection | `src/node/plugins/importAnalysis.ts` | `src/browser/plugins/importAnalysis.ts` |
| CSS transform | `src/node/plugins/css.ts` | `src/browser/plugins/css.ts` |
| Plugin container | `src/node/server/pluginContainer.ts` | `src/browser/pluginContainer.ts` (full hook loop) |
| Module graph | `src/node/server/moduleGraph.ts` | `src/browser/moduleGraph.ts` (full fields) |
| HMR server | `src/node/server/hmr.ts` | `src/browser/hmr.ts` (full `updateModules`/`propagateUpdate`) |
| HMR client | `src/client/client.ts` + `src/shared/hmr.ts` | `src/client/browser.ts` (`HMRClient`, `createHotContext`) |
| Transport | WebSocket (`ws.ts`) | `src/browser/hotChannel.ts` (`HotPayload` shapes) |
| File IO | `node:fs` | Virtual FS (`setBrowserVirtualFileContent`) |

### Import analysis contract

For every JS module, `importAnalysis` MUST:

1. Parse imports with **es-module-lexer** (`init` + `parse`) — not regex.
2. Rewrite each import specifier to a normalized URL with the dep's
   `lastHMRTimestamp` (`?t=`) so clients re-fetch after invalidation.
3. Detect `import.meta.hot`:
   - `.accept(...)` → `lexAcceptedHmrDeps` (self-accept / dep accept)
   - `.acceptExports(...)` → `lexAcceptedHmrExports` (partial accept)
   - record `importedBindings` for partial-accept propagation
4. Inject `import.meta.hot = createHotContext("<url>")` import-prepended.
5. Call `moduleGraph.updateModuleInfo(...)` with `importedUrls`,
   `importedBindings`, `normalizedAcceptedUrls`, `acceptedExports`,
   `isSelfAccepting`, `staticImportedUrls`.
6. Return `handlePrunedModules` results so the client prunes.

### HMR server contract

`updateModules` MUST replicate upstream: invalidate → propagate boundaries →
circular-import detection → full-reload fallback (no boundary, dead end,
circular invalidate) → send `{ type: 'update', updates[] }` with
`isWithinCircularImport`, `firstInvalidatedBy`, `explicitImportRequired`.

`propagateUpdate` MUST replicate upstream: self-accept, partial accept
(`acceptedHmrExports` + `importedBindings` via `areAllImportsAccepted`),
`acceptedHmrDeps`, CSS importer chains, no-importer dead end, and
`isNodeWithinCircularImports` loop recovery.

### HMR client contract

`HMRClient` (shared) MUST be used with `queueUpdate` ordering,
dispose-before-reimport, `importUpdatedModule` fetching `?t=<timestamp>`,
`prunePaths`, `vite:beforeUpdate/afterUpdate/beforeFullReload/beforePrune`
events, error overlay, CSS `<link>` href timestamp swap for `css-update`.

`createHotContext` MUST implement `accept`/`acceptExports`/`dispose`/`prune`/
`invalidate`/`on`/`off`/`send` with the same semantics as `src/shared/hmr.ts`.

## Where fidelity is legitimately reduced (and why)

- **No production `build()`** in-browser (Rolldown native). Out of scope by design.
- **No native dep pre-bundling optimizer** (Rolldown). Browser uses a virtual
  module registry; bare imports are served through the same resolution layer.
- **No WebSocket** — `HotChannel` carries identical `HotPayload` over postMessage.
- **No node:fs** — virtual FS supplies identical `read()` content to HMR.

Everything else — transforms, analysis, graph, HMR math, client runtime — is
byte-for-byte behavior-equivalent with upstream Vite 8.1.5.

## Error modes that were bugs (removed)

- Regex-based HMR accept analysis → replaced by es-module-lexer + `lexAcceptedHmrDeps`.
- `eval`/`new Function` module execution → replaced by native ESM module loading.
- "Simulated" module graph (Map of {path,content}) → replaced by full ModuleGraph.
- CSS "concatenate all css and inject" → replaced by Vite CSS plugin semantics.
- Oxc `typescript.declaration: false` guess → corrected against upstream oxc.ts options.
