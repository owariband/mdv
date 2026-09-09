import { runTests, downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron'
import { cp, mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'mdv-vscode-test-'))
const workspace = join(temporary, 'workspace')
const userData = join(temporary, 'user-data')
await mkdir(join(userData, 'User'), { recursive: true })
await mkdir(workspace)
await mkdir(join(temporary, 'extensions'))
const restricted = process.argv.includes('--restricted')
const recovery = process.argv.includes('--empty-recovery') ? 'empty' : process.argv.includes('--recovery') ? '1' : '0'
await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': restricted,
  'security.workspace.trust.startupPrompt': 'never',
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
  'window.dialogStyle': 'custom',
  'files.autoSave': 'off', 'telemetry.telemetryLevel': 'off',
  'update.mode': 'none', 'extensions.autoUpdate': false,
  'chat.disableAIFeatures': true,
  'markdown.extension.toc.updateOnSave': false,
}))
const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const executable = argument('--vscode') ?? process.env.VSCODE_EXECUTABLE_PATH
const markdownExtension = argument('--markdown-extension')
const server = createServer()
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
await new Promise((done) => server.close(done))
console.log(`Isolated test profile and diagnostics: ${temporary}`)
const options = {
  ...(executable ? { vscodeExecutablePath: executable } : { version: argument('--version') ?? '1.100.0' }),
  extensionDevelopmentPath: [root, join(root, 'test/markdown-contribution'), ...(markdownExtension ? [resolve(markdownExtension)] : [])],
  extensionTestsPath: join(root, 'dist/test.cjs'),
  extensionTestsEnv: { MDV_TEST_WORKSPACE: workspace, MDV_TEST_RESTRICTED: restricted ? '1' : '0',
    MDV_TEST_MARKDOWN_EXTENSION: markdownExtension ? '1' : '0', MDV_TEST_CDP_PORT: String(port),
    ...(argument('--agent-cli') ? { MDV_TEST_AGENT_CLI: resolve(argument('--agent-cli')), MDV_TEST_AGENT_NODE: process.execPath } : {}),
    MDV_TEST_RECOVERY: recovery },
  launchArgs: [workspace, '--user-data-dir', userData, '--shared-data-dir', join(temporary, 'shared-data'), '--extensions-dir', join(temporary, 'extensions'),
    '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry',
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
}
if (restricted || recovery !== '0' || process.argv.includes('--installed')) {
  // The standard test runner disables Workspace Trust and exits on Extension Host reload.
  // Always test a freshly packaged extension, not a stale VSIX left by another build.
  if (!process.env.npm_execpath) throw new Error('Use npm test to run the installed-extension checks')
  const packaged = await promisify(execFile)(process.execPath, [process.env.npm_execpath, 'run', 'package'], { cwd: root })
  console.log(packaged.stdout)
  const binary = executable ?? await downloadAndUnzipVSCode(options.version)
  const cli = resolveCliPathFromVSCodeExecutablePath(binary)
  const installed = join(temporary, 'extensions')
  await cp(join(root, 'test/lifecycle-driver'), join(installed, 'mdv-test.mdv-lifecycle-test-0.0.1'), { recursive: true })
  await cp(join(root, 'test/markdown-contribution'), join(installed, 'mdv-test.mdv-markdown-contribution-test-0.0.1'), { recursive: true })
  if (markdownExtension) await cp(markdownExtension, join(installed, 'yzhang.markdown-all-in-one'), { recursive: true })
  const installation = await promisify(execFile)(cli, ['--user-data-dir', userData, '--extensions-dir', installed,
    '--shared-data-dir', join(temporary, 'shared-data'), '--install-extension', join(root, 'dist/mdv-vscode-0.1.0-preview.6.vsix')])
  console.log(installation.stdout)
  const child = spawn(binary, options.launchArgs, {
    env: { ...process.env, ...options.extensionTestsEnv, MDV_LIFECYCLE_TEST_ENTRY: options.extensionTestsPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  let spawnError
  let exited = false
  const exit = new Promise((done) => child.once('exit', () => { exited = true; done() }))
  child.on('error', (error) => { spawnError = error })
  try {
    const deadline = Date.now() + 90_000
    let result
    while (!result && Date.now() < deadline) {
      if (spawnError) throw spawnError
      try { result = JSON.parse(await readFile(join(workspace, 'lifecycle-result.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!result) await new Promise((done) => setTimeout(done, 200))
    }
    if (!result) throw new Error(`Lifecycle check timed out; inspect ${temporary}`)
    if (!result.ok) throw new Error(result.error)
    console.log(`PASS installed VSIX ${restricted ? 'Restricted Mode' : recovery !== '0' ? `real window reload (${recovery})` : 'full integration'} check`)
  } finally {
    await Promise.race([exit, new Promise((done) => setTimeout(done, 2000))])
    if (!exited) child.kill('SIGTERM')
  }
  for (const entry of await readdir(join(userData, 'logs'), { recursive: true })) {
    if (!entry.endsWith('renderer.log')) continue
    const log = await readFile(join(userData, 'logs', entry), 'utf8')
    if (/OverlayWebview (?:has been|is) disposed/.test(log)) {
      throw new Error(`Disposed Webview detected in renderer log: ${join(userData, 'logs', entry)}`)
    }
  }
  console.log('PASS renderer logs contain no disposed Webview errors')
} else {
  await runTests(options)
}
