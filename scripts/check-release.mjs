import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const release = process.argv.includes('--release')
assert.ok(process.argv.slice(2).every((arg) => arg === '--release'), 'usage: node scripts/check-release.mjs [--release]')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
assert.equal(manifest.name, lock.packages[''].name, 'Lockfile package name is stale')
assert.equal(manifest.version, lock.packages[''].version, 'Lockfile version is stale')
assert.equal(manifest.license, lock.packages[''].license, 'Lockfile license is stale')
assert.equal(manifest.type, 'module')
assert.deepEqual(manifest.exports, { '.': { types: './dist/index.d.ts', import: './dist/index.js' } })
assert.equal(manifest.scripts.prepare, 'npm run build')
for (const [name, pkg] of Object.entries(lock.packages)) {
  if (pkg.resolved) assert.ok(pkg.resolved.startsWith('https://registry.npmjs.org/'), `Non-public lockfile URL: ${name}`)
}
for (const path of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'spec/format-0.1.md',
  'docs/compatibility.md', 'docs/releasing.md', 'THIRD_PARTY_NOTICES']) await access(join(root, path))

const blockers = []
if (manifest.version === '0.0.0-development' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  blockers.push('Owner must select a release version and update the lockfile.')
}
if (!manifest.license || manifest.license === 'UNLICENSED') blockers.push('Owner must choose the distribution license.')
try {
  const license = await readFile(join(root, 'LICENSE'), 'utf8')
  if (!license.trim()) blockers.push('LICENSE must not be empty.')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  blockers.push('A reviewed LICENSE file is required before release.')
}
if (release && blockers.length) {
  process.stderr.write(`Release blocked:\n${blockers.map((item) => `- ${item}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  console.log('Package contract checks passed. No registry write was performed.')
  if (blockers.length) console.log(`Development snapshot; release gates still open:\n${blockers.map((item) => `- ${item}`).join('\n')}`)
  if (release) console.log('Local gates only: owner must also confirm package ownership, CI results and release notes (docs/releasing.md).')
}
