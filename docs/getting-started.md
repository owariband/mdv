# 快速开始

本页介绍如何从源码构建当前开发版，并通过 `@mdv/core` 的当前 API 创建、打开、保存、commit、checkout、比较和诊断一个 `.mdv` 文件，以及导入图片。

## 环境要求

- Node.js 20 或更高版本；
- ESM 项目，或能够加载 ESM package 的构建工具；
- npm。

`@mdv/core` 尚未发布到 npm registry，因此现在不能依赖一个正式版本号安装。

## 构建 Core

```bash
git clone https://github.com/owariband/mdv.git
cd mdv
npm ci
npm test
npm run build
```

构建产物位于 `dist/`。在另一个本地项目中，可以安装这份已经构建的目录：

```bash
npm install /absolute/path/to/mdv
```

仓库通过 `prepare` 在安装或打包时生成 `dist/`；调用方不依赖仓库里预先存在或提交的构建产物。修改 Core 源码后，重新安装本地依赖即可更新调用方副本。

## 创建并保存

```ts
import { createMdv } from '@mdv/core'

let mdv = await createMdv('/documents/example.mdv')

mdv = await mdv.saveReference({
  markdown: '# Reference\n\n这里可以为空，也可以保存需求或摘要。\n',
  expectedGeneration: mdv.manifest.generation,
})

mdv = await mdv.saveDocument({
  markdown: '# Document\r\n\r\n正文。\r\n',
  expectedGeneration: mdv.manifest.generation,
})

console.log(mdv.manifest.generation) // 2
```

`createMdv()` 创建 generation 0、两份空工作副本、零 Version 和零 Head；目标已存在时返回 `CONFLICT`，不会覆盖。每次 save 只修改一份工作副本、把 generation 精确增加 1，并返回一个新的 `MdvDocument`。旧对象仍代表旧快照，因此应始终接住返回值。

save 不等于 commit。上面的两次保存不会创建历史 Version；只有下面的显式 commit 才会固化版本。

## 像普通 Markdown 一样编辑

不做版本操作时，MDV 没有额外的草稿状态机：

```text
宿主编辑器内存 buffer     尚未保存，由 VS Code / MarkText 等宿主管理
        ↓ save
doc_tree/current.md       已保存、可反复覆盖的普通 Markdown 工作副本
        ↓ explicit commit
versions/<id>/content.md  不可变历史快照
```

Core 不引入 `DraftVersion`、`workspace`、pending bind 或自动 commit。`saveDocument()` 只把宿主传来的 Markdown 持久化到 `doc_tree/current.md`，执行 generation CAS，并返回新快照；它不创建 Version、不移动 HEAD。Reference 工作副本遵循同一规则。

因此宿主关闭前尚未 save 的内存内容不属于 Core；已经 save 的 `current.md` 会跟随 `.mdv` 持久化。Document 对 Reference 的 bind 也不会写入工作副本，只有 `commitDocument()` 创建新 Document Version 时才永久记录。

## 创建不可变版本

commit 不接收 `markdown`，它只固化已保存的目标 `current.md`。下面先提交 Reference，再让 Document Version 精确绑定它：

```ts
const referenceCommit = await mdv.commitReference({
  actor: { type: 'human', name: 'Hypnos' },
  summary: 'Freeze the first Reference',
  expectedGeneration: mdv.manifest.generation,
})
mdv = referenceCommit.document

if (!referenceCommit.created) {
  throw new Error('Expected the first Reference Version to be created')
}

const documentCommit = await mdv.commitDocument({
  referenceVersion: referenceCommit.version,
  actor: { type: 'agent', id: 'writer-agent' },
  summary: 'Create the first Document version',
  expectedGeneration: mdv.manifest.generation,
})
mdv = documentCommit.document
```

第一次显式 commit 即使工作副本为空也会创建根 Version。已有 Head 后，如果 Reference 正文没有变化，或 Document 正文与 bind 都没有变化，结果为 `created: false, reason: 'no-changes'`；成功事务仍然返回新文档并把 generation 增加 1。Document 正文相同但 bind 改变时仍会创建 Version。

不使用 Reference 时，`commitDocument()` 必须显式传 `referenceVersion: null`。

## Checkout 历史版本

```ts
if (documentCommit.created) {
  mdv = await mdv.checkoutDocument({
    version: documentCommit.version,
    expectedGeneration: mdv.manifest.generation,
  })
}
```

checkout 把目标版本正文复制到对应 `current.md`、移动对应 Head 并让 generation 增加 1；它不创建 Version，也不删除后代。从旧版本继续编辑并 commit 会形成可追踪分叉。

如果 `current.md` 相对当前 Head 已经 dirty，默认 checkout 返回 `CONFLICT` 且不覆盖内容。只有调用方明确确认丢弃时才传：

```ts
mdv = await mdv.checkoutDocument({
  version: targetVersion,
  expectedGeneration: mdv.manifest.generation,
  discardChanges: true,
})
```

## 打开文件

```ts
import { MdvError, openMdv } from '@mdv/core'

try {
  const mdv = await openMdv('/documents/example.mdv')

  console.log(mdv.manifest.documentId)
  console.log(mdv.manifest.generation)
  console.log(await mdv.readDocumentText())
} catch (error) {
  if (error instanceof MdvError) {
    console.error(error.code, error.message, error.details)
  } else {
    throw error
  }
}
```

`openMdv()` 返回绝对 `packagePath`，并把 `.mdv` 所在目录作为 `baseDirectory`。内部的 `doc_tree/current.md` 不是文件系统路径，因此 Core 返回 Markdown bytes/text，而不是伪造一个 `.md` 路径。

## 从内存解析

```ts
import { readFile } from 'node:fs/promises'
import { parseMdv } from '@mdv/core'

const bytes = await readFile('/documents/example.mdv')
const snapshot = await parseMdv(bytes, {
  baseDirectory: '/documents',
})

console.log(await snapshot.readReferenceText())
console.log(await snapshot.readDocumentText())
```

`parseMdv()` 不知道字节原来的文件路径，所以：

- `packagePath` 始终为 `null`；
- 未传 `baseDirectory` 时，`baseDirectory` 也为 `null`；
- 如果 Markdown 包含相对图片或链接，由调用方提供可信的资源基准目录。

显式传入 `baseDirectory` 时返回 `LocatedDocumentSnapshot`，可调用 `resolveManagedResource`、`readManagedResource` 和 `verifyManagedResource`；它仍不能 import/save/commit。无基准的普通 `DocumentSnapshot` 在类型和运行时都不提供资源方法。

## 插入图片

```ts
import { readFile } from 'node:fs/promises'

const imagePath = await mdv.importManagedResource({
  bytes: await readFile('/downloads/cat.png'),
})
const markdown = await mdv.readDocumentText()
mdv = await mdv.saveDocument({
  markdown: `${markdown}\n![cat](${imagePath})\n`,
  expectedGeneration: mdv.manifest.generation,
})

const localImagePath = await mdv.resolveManagedResource(imagePath)
// 宿主将 localImagePath 转换成自己的渲染 URI。
```

PNG/JPEG/GIF/WebP 会按 hash 保存到 `.mdv-assets/<documentId>/`，默认上限 32 MiB；重复导入同一图片可复用。导入本身不修改 Markdown 或 generation，只有后面的 save 才保存路径，commit 才固化版本。普通自定义路径仍保持原样，相对路径统一基于 `.mdv` 所在目录。详见[图片与相对资源](./resources.md)。

## 查询历史和绑定

```ts
const versions = mdv.listVersions({ tree: 'document' })

for (const version of versions) {
  console.log(version.id, version.referenceVersion)
}

const head = mdv.documentTree.head
if (head !== null) {
  const trace = mdv.traceDocument(head)
  console.log(trace.ancestry)
  console.log(trace.reference)
}
```

版本列表只包含轻量元数据。调用 `readVersionBytes(id)` 或 `readVersionText(id)` 时，Core 才按需读取并校验该历史正文。

## 查看状态并比较任意两份内容

```ts
const status = await mdv.getStatus()
console.log(status.document.dirty, status.referenceRelation)

const documentHead = mdv.documentTree.head
if (documentHead !== null) {
  const current = await mdv.readContent({
    tree: 'document',
    kind: 'working-copy',
  })
  const changes = await mdv.diff(
    { tree: 'document', kind: 'version', version: documentHead },
    { tree: 'document', kind: 'working-copy' },
  )
  console.log(current.origin, changes.unifiedText)
}
```

`diff()` 并不限定为 Reference ↔ Document；两端都是同一个 `ContentSpec`，所以 Document ↔ Document、Reference ↔ Reference、跨树以及工作副本 ↔ Version 都成立。它保留 Markdown 源码的行结束符和空白，并用资源上限避免无界计算。

如果文件无法正常打开，或者需要检查所有未被访问的历史分支，直接使用顶层诊断入口：

```ts
import { verifyMdv } from '@mdv/core'

const report = await verifyMdv('/documents/example.mdv', { mode: 'full' })
console.log(report.valid, report.complete, report.issues)
```

`metadata` 是默认模式；`full` 额外遍历全部历史正文并检查 UTF-8、长度与 SHA-256。诊断只读，不会自动修复文件。

## 处理并发冲突

`expectedGeneration` 是显式的比较后交换条件。两个 writer 从同一 generation 保存时，最多一个提交；另一个得到 `MdvError` 的 `CONFLICT`：

```ts
try {
  mdv = await mdv.saveDocument({
    markdown: nextMarkdown,
    expectedGeneration: mdv.manifest.generation,
  })
} catch (error) {
  if (error instanceof MdvError && error.code === 'CONFLICT') {
    mdv = await openMdv(mdv.packagePath)
    // 交给宿主比较/合并，而不是无条件覆盖。
  } else {
    throw error
  }
}
```

这等价于普通 Markdown 编辑器发现文件已被另一个进程修改：Core 负责拒绝静默覆盖，不负责决定如何处理用户的内存 buffer。宿主可以提示重载、展示比较、手动合并或另存为；Core 不自动合并正文，也不自动重试旧 generation。

## 交给 Markdown 工具

Core 不解析或渲染 Markdown。把返回的字符串交给上层 parser/editor，并把 `baseDirectory` 交给其资源解析层：

```ts
const source = await mdv.readDocument()

editor.setMarkdown(new TextDecoder().decode(source.bytes), {
  baseDirectory: source.baseDirectory,
})
```

`editor` 只是示意；Core 不依赖 VS Code、Muya、remark 或其他 Markdown 模型。

## 下一步

- 阅读[核心概念](./concepts.md)理解 Reference、Document 和 bind；
- 阅读[API 参考](./api-reference.md)查看当前可用契约；
- 阅读[图片与相对资源](./resources.md)处理图片路径；
- 后续 M6 发布硬化计划见[开发路线图](./design/roadmap.md)；调用方始终通过 package-root API 操作，不直接修改 ZIP entry。
