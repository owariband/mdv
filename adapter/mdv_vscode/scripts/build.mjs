import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'

const provenance = JSON.parse(await readFile('vendor/core-build.json', 'utf8'))
const installed = JSON.parse(await readFile('node_modules/.package-lock.json', 'utf8'))
const tarball = await readFile('vendor/mdv-core-0.0.0-development.tgz')
assert.equal('sha512-' + createHash('sha512').update(tarball).digest('base64'), provenance.integrity,
  'Core tarball does not match its build record; run npm run prepare:core')
assert.equal(installed.packages['node_modules/@mdv/core']?.integrity, provenance.integrity,
  'Installed Core is stale; reinstall the local Core tarball before building')

await mkdir('dist', { recursive: true })
await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], legalComments: 'linked',
})
await copyFile('vendor/core-build.json', 'dist/core-build.json')
await build({
  entryPoints: ['test/index.ts'], outfile: 'dist/test.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode', 'playwright-core'],
})
