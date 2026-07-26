import { init, parse } from 'es-module-lexer'
import { transformSync } from 'oxc-transform'
await init
const src = `import React, { useState } from 'react';
import { Button } from './components/Button';
export function Counter({ initialCount }) {
  const [count, setCount] = useState(initialCount);
  return <div>{count}<Button onClick={() => setCount(c=>c+1)}>x</Button></div>;
}`
const out = transformSync('/src/Counter.tsx', src, {
  sourcemap: true, lang: 'tsx',
  jsx: { runtime: 'automatic', importSource: 'react', refresh: true },
  typescript: { onlyRemoveTypeImports: false },
})
const code = out.code
console.log('=== OXC OUTPUT ===')
console.log(code)
try {
  const [i] = parse(code)
  console.log('PARSE OK', i.map((x) => x.n))
} catch (err) {
  console.log('PARSE FAIL:', err.message, 'idx', err.idx)
  console.log('context:', JSON.stringify(code.slice(err.idx - 80, err.idx + 80)))
}
