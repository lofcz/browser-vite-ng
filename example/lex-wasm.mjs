import { init, parse } from './src/vendor/es-module-lexer.js'
await init // this compiles+instantiates the embedded WASM
const full = `import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/Counter.tsx");
import React, { useState } from "https://esm.sh/react@18?dev";
import { Button } from "/src/components/Button.tsx";
import { jsx as _jsx, jsxs as _jsxs } from "https://esm.sh/react@18/jsx-runtime?dev";
var _s = $RefreshSig$();
export function Counter({ initialCount }) {
	_s();
	const [count, setCount] = useState(initialCount);
	return /* @__PURE__ */ _jsxs("div", { children: count });
}
_s(Counter, "Wx3FONZm5HiCy6oZC/sfWdOGImo=");
_c = Counter;
var _c;
$RefreshReg$(_c, "Counter");

import * as RefreshRuntime from "/@react-refresh";
if (import.meta.hot) {
  RefreshRuntime.__hmr_import("/src/Counter.tsx").then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh("/src/Counter.tsx", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("/src/Counter.tsx", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}
function $RefreshReg$(type, id) { return RefreshRuntime.register(type, "/src/Counter.tsx" + " " + id); }
function $RefreshSig$() { return RefreshRuntime.createSignatureFunctionForTransform(); }
`
try {
  const [i] = parse(full)
  console.log('WASM FULL OK', i.length)
} catch (e) {
  console.log('WASM FULL FAIL', e.message, 'idx', e.idx)
  console.log('region:', JSON.stringify(full.slice(e.idx - 40, e.idx + 40)))
}
