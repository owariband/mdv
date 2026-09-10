import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'mdv agent package '))
const npm = process.env.npm_execpath
assert.ok(npm, 'Use npm run test:package')
const { stdout } = await run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root })
const [packed] = JSON.parse(stdout)
assert.ok(packed.files.some(({ path }) => path === 'dist/cli.cjs'))
assert.ok(packed.files.some(({ path }) => path === 'LICENSE'), 'Agent tarball must include its license')
assert.ok(
  packed.files.some(({ path }) => path === 'dist/THIRD_PARTY_NOTICES'),
  'Agent tarball must include bundled dependency notices',
)
assert.ok(packed.files.every(({ path }) => !/^(src|test|vendor|node_modules)\//.test(path)))
await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
await run(process.execPath, [npm, 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(temporary, packed.filename)], { cwd: temporary })
const installed = join(temporary, 'node_modules/@mdv/agent-tool')
const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
assert.equal(manifest.license, 'Apache-2.0')
assert.equal(manifest.dependencies, undefined, 'The CLI must bundle its fixed Core; no unpublished Core dependency at runtime')
const notices = await readFile(join(installed, 'dist/THIRD_PARTY_NOTICES'), 'utf8')
for (const dependency of ['yauzl 3.4.0', 'yazl 3.3.1', 'pend 1.2.0', 'buffer-crc32 1.0.0']) {
  assert.match(notices, new RegExp(dependency.replaceAll('.', '\\.')))
}
const cli = join(installed, manifest.bin.mdv)
assert.equal((await run(process.execPath, [cli, '--version'], { cwd: temporary })).stdout.trim(), manifest.version)
const bin = join(temporary, 'node_modules/.bin/mdv' + (process.platform === 'win32' ? '.cmd' : ''))
assert.match(await readFile(bin, 'utf8'), process.platform === 'win32' ? /cli\.cjs/ : /^#!\/usr\/bin\/env node/)
if (process.platform !== 'win32') assert.equal((await run(bin, ['--version'], { cwd: temporary })).stdout.trim(), manifest.version)
const checked = await run(process.execPath, ['--test', join(root, 'test/cli.test.mjs')], {
  cwd: temporary, env: { ...process.env, MDV_AGENT_CLI: cli, MDV_AGENT_TEST_CWD: temporary }, maxBuffer: 2 * 1024 * 1024,
})
console.log(checked.stdout)
console.log('Isolated CLI tarball checks passed: ' + packed.filename + '\nConsumer: ' + temporary)
