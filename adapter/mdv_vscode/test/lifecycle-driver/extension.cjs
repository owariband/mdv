const fs = require('node:fs/promises')
const path = require('node:path')
const vscode = require('vscode')

exports.activate = () => {
  if (!process.env.MDV_LIFECYCLE_TEST_ENTRY || !process.env.MDV_TEST_WORKSPACE) return
  void (async () => {
    let result
    try {
      await require(process.env.MDV_LIFECYCLE_TEST_ENTRY).run()
      result = { ok: true }
    } catch (error) {
      result = { ok: false, error: error.stack ?? String(error) }
    }
    Object.assign(result, { vscode: vscode.version, node: process.version, platform: process.platform })
    const destination = path.join(process.env.MDV_TEST_WORKSPACE, 'lifecycle-result.json')
    await fs.writeFile(destination + '.tmp', JSON.stringify(result))
    await fs.rename(destination + '.tmp', destination)
    await vscode.commands.executeCommand('workbench.action.quit')
  })()
}
