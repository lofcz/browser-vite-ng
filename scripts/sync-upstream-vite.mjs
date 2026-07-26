#!/usr/bin/env node
/**
 * Stage an upstream Vite tag for syncing into packages/vite.
 * Does not overwrite the working tree — prints a checklist instead.
 *
 * Usage: node scripts/sync-upstream-vite.mjs --tag v8.1.5
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const tagArg = process.argv.find((a) => a.startsWith('--tag='))
const tag = tagArg ? tagArg.slice('--tag='.length) : process.argv[process.argv.indexOf('--tag') + 1]

if (!tag) {
  console.error('Usage: node scripts/sync-upstream-vite.mjs --tag v8.1.5')
  process.exit(1)
}

const ver = tag.replace(/^v/, '')
const staging = path.join(root, `.vite-upstream-${ver}`)
const srcDir = path.join(staging, 'src', 'vite')

console.log(`Staging upstream Vite ${tag} → ${staging}`)

fs.rmSync(staging, { recursive: true, force: true })
fs.mkdirSync(staging, { recursive: true })

const clone = spawnSync(
  'git',
  [
    'clone',
    '--depth',
    '1',
    '--branch',
    tag,
    '--filter=blob:none',
    '--sparse',
    'https://github.com/vitejs/vite.git',
    srcDir,
  ],
  { stdio: 'inherit' },
)
if (clone.status !== 0) process.exit(clone.status ?? 1)

spawnSync('git', ['sparse-checkout', 'set', 'packages/vite'], {
  cwd: srcDir,
  stdio: 'inherit',
})

const pkgPath = path.join(srcDir, 'packages', 'vite', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
console.log(`\nUpstream package version: ${pkg.version}`)
console.log(`Engines: ${JSON.stringify(pkg.engines)}`)

console.log(`
Next steps (see docs/UPSTREAM.md):
  1. Copy src/node, src/client (keep browser.ts), src/module-runner, src/shared, src/types, types/
  2. Re-apply // BROWSER VITE patch markers (rg "BROWSER VITE")
  3. Keep src/browser/** and full HMR (no simplifications)
  4. Bump packages/vite version to ${pkg.version}-browser.1
  5. Build + run example Playwright e2e
`)
