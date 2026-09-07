# 快速开始

本页介绍如何从源码构建当前开发版，并通过 `@mdv/core` 的 M3 API 创建、打开和保存一个 `.mdv` 文件。

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

save 不等于 commit。上面的两次保存不会创建历史 Version；commit 与 checkout 将在 M4 提供。

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
- 阅读[API 参考](./api-reference.md)查看完整的 M3 契约；
- 阅读[图片与相对资源](./resources.md)处理图片路径；
- 需要 commit、checkout 或 review 能力时关注[开发路线图](./design/roadmap.md)，不要直接修改 ZIP entry。
