import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const adapter = dirname(dirname(fileURLToPath(import.meta.url)))
const root = join(adapter, '../..')
const vendor = join(adapter, 'vendor')
const npm = process.env.npm_execpath
assert.ok(npm, 'Use npm run prepare:core')
await mkdir(vendor, { recursive: true })
await run(process.execPath, [npm, 'run', 'build'], { cwd: root })
const { stdout } = await run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', vendor], { cwd: root })
const [packed] = JSON.parse(stdout)
assert.ok(packed.files.every(({ path }) => !path.startsWith('adapter/')), 'Core tarball must exclude adapters')
const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], { cwd: root })
const { stdout: sourceChanges } = await run('git', ['status', '--porcelain', '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'], { cwd: root })
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(join(vendor, 'core-build.json'), JSON.stringify({
  package: manifest.name, version: manifest.version, sourceCommit: sha.trim(),
  sourceDirty: sourceChanges.trim() !== '', integrity: packed.integrity, shasum: packed.shasum,
}, null, 2) + '\n')
console.log('Prepared ' + packed.filename + '; Core source ' + sha.trim())
