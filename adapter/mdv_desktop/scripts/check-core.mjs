import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const provenance = JSON.parse(await readFile(new URL('../vendor/core-build.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const installed = JSON.parse(await readFile(new URL('../node_modules/.package-lock.json', import.meta.url), 'utf8'))
const coreDependency = manifest.dependencies[provenance.package]

assert.match(coreDependency ?? '', /^file:vendor\/[0-9A-Za-z._-]+\.tgz$/, 'Core must use a vendored tarball')
const tarball = await readFile(new URL(`../${coreDependency.slice('file:'.length)}`, import.meta.url))
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
assert.equal(integrity, provenance.integrity, 'Core tarball differs from its provenance record; run npm run prepare:core')
assert.equal(
  installed.packages[`node_modules/${provenance.package}`]?.integrity,
  provenance.integrity,
  'Installed Core differs from the vendored tarball; run npm install',
)
