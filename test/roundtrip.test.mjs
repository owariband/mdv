import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMdv, openMdv, parseMdv, verifyMdv } from '../dist/index.js'

const lines = [
  '---', 'title: "中文 🐱 e\u0301 é"', 'tags: [mdv, test]', '---', '',
  '# 标题', '', '| left | right |', '| --- | --- |', '| 空白  | `a\\b` |', '',
  '> 引用', '', '- [x] item', '- [ ] pending', '',
  '```typescript', 'const literal = "![not an image](../somewhere.png)"', '```', '',
  '$E = mc^2$', '$$\\int_0^1 x\\,dx$$', '',
  '```mermaid', 'graph LR', '  Ref --> Doc', '```', '',
  '![相对资源](../自由目录/图.png) ![绝对路径](/custom/image.png)', '',
  '<div data-value="&amp;">HTML is just text</div>', '', 'trailing spaces  ',
]

for (const newline of ['\n', '\r\n', '\r']) {
  test(`complex Markdown round-trip preserves raw bytes (${JSON.stringify(newline)})`, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'mdv 往返 space ')))
    t.after(() => rm(base, { recursive: true, force: true }))
    const path = join(base, '文档.mdv')
    const markdown = Buffer.from(lines.join(newline)) // Deliberately no final newline.
    let document = await createMdv(path)
    document = await document.saveReference({ markdown, expectedGeneration: 0 })
    const ref = await document.commitReference({ expectedGeneration: 1, actor: { type: 'human' }, summary: 'Ref' })
    document = await ref.document.saveDocument({ markdown, expectedGeneration: 2 })
    const doc = await document.commitDocument({
      expectedGeneration: 3, actor: { type: 'agent' }, summary: 'Doc', referenceVersion: ref.version,
    })
    document = await openMdv(path)
    for (const version of [ref.version, doc.version]) {
      assert.deepEqual(Buffer.from(await document.readVersionBytes(version)), markdown)
    }
    assert.deepEqual(Buffer.from((await document.readDocument()).bytes), markdown)
    assert.deepEqual(Buffer.from((await document.readReference()).bytes), markdown)
    assert.equal((await document.readDocument()).baseDirectory, base)
    assert.equal((await document.readReference()).baseDirectory, base)
    assert.equal(document.traceDocument(doc.version).reference.id, ref.version)
    document = await document.saveDocument({ markdown: Buffer.concat([markdown, Buffer.from(`${newline}changed`)]), expectedGeneration: 4 })
    assert.equal(document.documentTree.head, doc.version)
    assert.equal(document.listVersions().length, 2)
    assert.equal((await document.getStatus()).document.dirty, true)
    const diff = await document.diff({ tree: 'document', kind: 'version', version: doc.version },
      { tree: 'document', kind: 'working-copy' })
    assert.ok(diff.hunks.length > 0)
    document = await document.checkoutDocument({ version: doc.version, expectedGeneration: 5, discardChanges: true })
    assert.deepEqual(Buffer.from((await document.readDocument()).bytes), markdown)
    const snapshot = await parseMdv(await readFile(path))
    assert.deepEqual(Buffer.from(await snapshot.readVersionBytes(doc.version)), markdown)
    assert.equal((await snapshot.getStatus()).document.dirty, false)
    assert.equal((await verifyMdv(path, { mode: 'full' })).valid, true)
  })
}
