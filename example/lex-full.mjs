import { init, parse } from './src/vendor/es-module-lexer.js'
import { transformSync } from 'oxc-transform'
await init
const src = `import React, { useState } from 'react';
import { Button } from './components/Button';
export function Counter({ initialCount }) {
  const [count, setCount] = useState(initialCount);
  return <div>{count}</div>;
}`
const oxc = transformSync('/src/Counter.tsx', src, {
  sourcemap: true, lang: 'tsx',
  jsx: { runtime: 'automatic', importSource: 'react', refresh: true },
  typescript: { onlyRemoveTypeImports: false },
})
let code = oxc.code
// append refresh wrapper
code += `
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
// prepend hot context (import-analysis)
code = `import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/Counter.tsx");` + code
try {
  const [i] = parse(code)
  console.log('FULL OK', i.length, 'imports')
} catch (e) {
  console.log('FULL FAIL', e.message, 'idx', e.idx)
  console.log('region:', JSON.stringify(code.slice(e.idx - 60, e.idx + 60)))
  console.log('--- line containing idx ---')
  const upto = code.slice(0, e.idx).split('\n')
  console.log('line', upto.length, ':', JSON.stringify(upto[upto.length - 1]))
}
