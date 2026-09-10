import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'

assert.deepEqual(
  await readFile(new URL('../LICENSE', import.meta.url)),
  await readFile(new URL('../../../LICENSE', import.meta.url)),
  'Adapter LICENSE must match the repository license',
)
const provenance = JSON.parse(await readFile('vendor/core-build.json', 'utf8'))
const installed = JSON.parse(await readFile('node_modules/.package-lock.json', 'utf8'))
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const coreDependency = manifest.devDependencies[provenance.package]
assert.match(coreDependency ?? '', /^file:vendor\/[0-9A-Za-z._-]+\.tgz$/,
  'Core dependency must point to a vendored package tarball')
const tarball = await readFile(coreDependency.slice('file:'.length))
assert.equal('sha512-' + createHash('sha512').update(tarball).digest('base64'), provenance.integrity,
  'Core tarball does not match its build record; run npm run prepare:core')
assert.equal(installed.packages[`node_modules/${provenance.package}`]?.integrity, provenance.integrity,
  'Installed Core is stale; reinstall the local Core tarball before building')
await mkdir('dist', { recursive: true })
await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/cli.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', legalComments: 'linked',
  define: { MDV_AGENT_TOOL_VERSION: JSON.stringify(manifest.version) },
})
await chmod('dist/cli.cjs', 0o755)
await copyFile('vendor/core-build.json', 'dist/core-build.json')
