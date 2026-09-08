import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

test('release gates distinguish development, missing decisions and a prepared package contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mdv-release-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await cp('scripts/check-release.mjs', join(root, 'scripts/check-release.mjs'))
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  const lock = { packages: { '': { name: manifest.name, version: manifest.version, license: manifest.license } } }
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'spec/format-0.1.md',
    'docs/compatibility.md', 'docs/releasing.md']) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), '// synthetic gate fixture; not a release artifact\n')
  }
  await saveMetadata()
  assert.equal(run().status, 0)
  const blocked = run('--release')
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /Owner must select a release version/)
  assert.match(blocked.stderr, /Owner must choose the distribution license/)
  assert.match(blocked.stderr, /LICENSE file is required/)

  // Only synthetic data inside this temporary fixture; no repository license/version choice.
  manifest.version = '0.1.0-test'
  manifest.license = 'SEE LICENSE IN LICENSE'
  Object.assign(lock.packages[''], { version: manifest.version, license: manifest.license })
  await writeFile(join(root, 'LICENSE'), 'Synthetic test marker, not a distribution license.\n')
  await saveMetadata()
  assert.equal(run('--release').status, 0)
  lock.packages[''].version = '0.0.0-stale'
  await saveMetadata()
  assert.notEqual(run().status, 0, 'stale lock metadata must fail even in development mode')
  lock.packages[''].version = manifest.version
  lock.packages['node_modules/private-fixture'] = { resolved: 'https://private.invalid/dependency.tgz' }
  await saveMetadata()
  assert.notEqual(run().status, 0, 'private download URLs must fail without network access')

  function run(...args) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/check-release.mjs'), ...args], {
      encoding: 'utf8', timeout: 10_000,
    })
    if (result.error) throw result.error
    return result
  }
  async function saveMetadata() {
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  }
})
