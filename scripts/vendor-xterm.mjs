#!/usr/bin/env node
// Copies the pinned xterm.js build and the fit addon into public/vendor/ so the
// dashboard works offline with no build step. Re-run after bumping either
// package in package.json: `npm run vendor`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'public', 'vendor')
const files = [
  ['@xterm/xterm', 'lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm', 'css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit', 'lib/addon-fit.js', 'addon-fit.js'],
]

fs.mkdirSync(out, { recursive: true })
const versions = new Map()
for (const [pkg, rel, name] of files) {
  const pkgDir = path.join(root, 'node_modules', pkg)
  fs.copyFileSync(path.join(pkgDir, rel), path.join(out, name))
  versions.set(pkg, JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version)
}
fs.writeFileSync(path.join(out, 'VERSIONS'), [...versions].map(([p, v]) => `${p} ${v}`).join('\n') + '\n')
console.log(`vendored into ${path.relative(root, out)}:`, [...versions].map(([p, v]) => `${p}@${v}`).join(', '))
