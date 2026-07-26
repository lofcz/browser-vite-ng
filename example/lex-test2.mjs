import { init, parse } from 'es-module-lexer'
await init
// Approximate Oxc refresh:true output for a TSX component with the appended wrapper.
const code = `import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/Counter.tsx");
import React, { useState } from "https://esm.sh/react@18?dev";
import { Button } from "/src/components/Button.tsx";
import { jsx as _jsx, jsxs as _jsxs } from "https://esm.sh/react@18/jsx-runtime?dev";
export function Counter({ initialCount }) {
\tconst [count, setCount] = useState(initialCount);
\treturn /* @__PURE__ */ _jsxs("div", { children: count });
}
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
  const [i, e] = parse(code)
  console.log('OK imports:', i.map((x) => x.n))
} catch (err) {
  console.log('PARSE FAIL:', err.message, 'idx', err.idx)
  const idx = err.idx
  console.log('context:', JSON.stringify(code.slice(idx - 60, idx + 60)))
}
