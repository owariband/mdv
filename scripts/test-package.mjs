import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const npm = process.env.npm_execpath
assert.ok(npm, 'Run this check through npm run test:package')
const temporary = await mkdtemp(join(tmpdir(), 'mdv package check '))
const env = {
  ...process.env, npm_config_cache: join(temporary, 'cache'),
  npm_config_registry: 'https://registry.npmjs.org',
  npm_config_audit: 'false', npm_config_fund: 'false',
}
let hasLicense = false
try {
  // Build a source copy with no dist; only the build toolchain is shared with the repo.
  // The installed consumer below never links to the source or repository node_modules.
  const source = join(temporary, 'source')
  await mkdir(source)
  for (const path of ['package.json', 'tsconfig.json', 'src', 'README.md', 'docs', 'schemas', 'spec']) {
    await cp(join(root, path), join(source, path), { recursive: true })
  }
  try {
    await cp(join(root, 'LICENSE'), join(source, 'LICENSE'))
    hasLicense = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await symlink(join(root, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await command([npm, 'run', 'prepare'], source)
  const packed = await command([npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], source)
  const [archive] = JSON.parse(packed)
  const files = new Set(archive.files.map((file) => file.path))
  for (const required of ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'spec/format-0.1.md']) {
    assert.ok(files.has(required), `Missing packaged file: ${required}`)
  }
  if (hasLicense) assert.ok(files.has('LICENSE'), 'The reviewed LICENSE must be included in the tarball')
  assert.ok([...files].some((path) => path.startsWith('schemas/') && path.endsWith('.json')))
  for (const path of files) {
    assert.ok(!/^(src|test|scripts|bench|node_modules|\.git|\.github)\//.test(path), `Unexpected packaged file: ${path}`)
    assert.ok(!/\.(mdv|tgz)$/.test(path), `Unexpected archive: ${path}`)
  }
  const consumer = join(temporary, 'consumer')
  await cp(join(root, 'test/package-consumer'), consumer, { recursive: true })
  await command([npm, 'install', '--ignore-scripts', '--omit=dev', '--no-package-lock', join(temporary, archive.filename)], consumer)
  const installed = join(consumer, 'node_modules/@owariband/mdv')
  assert.equal(await realpath(installed), join(await realpath(consumer), 'node_modules/@owariband/mdv'))
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.exports), ['.'])
  // Runtime must work before installing a compiler or development dependencies.
  await command(['runtime.mjs'], consumer)
  await command([npm, 'install', '--ignore-scripts', '--no-package-lock', '--no-save', 'typescript@5.9.3'], consumer)
  await command([join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumer)
  // Also test the compiler used to build the library, without changing consumer resolution.
  await command([join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer)
  console.log(`Package smoke passed: ${archive.filename}, ${files.size} files, TypeScript 5.9.3 + repository compiler.`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function command(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, args, {
      cwd, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    })
    if (args[1] !== 'pack') process.stdout.write(stdout)
    process.stderr.write(stderr)
    return stdout
  } catch (error) {
    process.stderr.write(error.stdout ?? '')
    process.stderr.write(error.stderr ?? '')
    throw error
  }
}
