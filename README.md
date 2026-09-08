<p align="center">
  <img src="docs/assets/mdv-icon.svg" alt="MDV cat icon" width="112" height="112">
</p>

# MDV

MDV（Markdown Document with Versions）是一种为 Markdown 增加双工作副本、显式版本和可追溯绑定关系的文档容器。`@mdv/core` 是它的 TypeScript 参考实现。

> 当前状态：开发预览。M5.5 产品能力已完成，包含双树读写、显式版本/bind、trace、Diff/诊断与受管图片。M6 已补充安装验证、安全回归和性能基线，三系统 CI 的 10 组检查已通过；发布身份/License 与正式 npm 发布仍待收口。平台证据与限制见[兼容性文档](docs/compatibility.md)。

## 为什么使用 MDV

- Reference 与 Document 各自拥有工作副本和版本历史。
- 不做版本操作时，`current.md` 就是一份普通、可覆盖保存的 Markdown；编辑器内存状态仍由宿主管理。
- 普通保存与 commit 分离，只有显式 commit 才固化版本。
- 每个 Document Version 精确绑定一个 Reference Version，或明确绑定 `null`。
- Markdown 原始字节保持不变，渲染继续交给 VS Code、MarkText、remark 等上层工具。
- `.mdv` 是普通 ZIP 容器，格式由独立规范、Schema 和一致性 fixtures 约束。

## 当前可用能力

```ts
import { createMdv, openMdv } from '@mdv/core'

let document = await createMdv('/documents/example.mdv')
document = await document.saveDocument({
  markdown: '# Hello MDV\n',
  expectedGeneration: document.manifest.generation,
})

const committed = await document.commitDocument({
  referenceVersion: null,
  actor: { type: 'human', name: 'Hypnos' },
  summary: 'Create the first Document version',
  expectedGeneration: document.manifest.generation,
})
document = committed.document

const reopened = await openMdv('/documents/example.mdv')
console.log(await reopened.readDocumentText())

const documentHead = reopened.documentTree.head
if (documentHead !== null) {
  const trace = reopened.traceDocument(documentHead)
  console.log(trace.reference)

  const review = await reopened.diff(
    { tree: 'document', kind: 'version', version: documentHead },
    { tree: 'document', kind: 'working-copy' },
  )
  console.log(review.unifiedText)
}

console.log(await reopened.getStatus())
```

当前已支持创建空 MDV、从文件或内存打开、保存两份工作副本、显式提交不可变版本、checkout 历史版本、读取历史正文、查询两棵版本树并追踪 bind。普通 save 只更新目标 `current.md` 并递增 generation，不创建 Version、也不移动 HEAD。多个进程同时编辑时，Core 通过 generation CAS 报告 `CONFLICT`，由 VS Code、MarkText 或其他宿主决定重载、比较或合并，就像处理普通 Markdown 被外部修改一样。

M4 沿用普通 Markdown 编辑底座，没有引入 `DraftVersion`、`workspace` 或 pending bind。commit 只固化已经 save 的 `current.md`；Document bind 只属于 commit 后的不可变 Document Version。checkout 默认拒绝覆盖 dirty 工作副本，只有显式 `discardChanges: true` 才允许丢弃它。

M5 增加的是通用、只读、Agent-friendly 原语：`getStatus()` 报告两棵工作副本与 bind 漂移，`readContent()` 精确选择任意工作副本或历史 Version，`diff()` 可以比较包括 Document ↔ Document 在内的任意两份来源，顶层 `verifyMdv()` 可诊断无法正常 open 的损坏包。它们不包含 Markdown AST、渲染、Review UI 或 Agent 专属协议。

M5.5 已补齐受管图片：`importManagedResource()` 导入 PNG/JPEG/GIF/WebP 并返回可插入 Markdown 的 hash 相对路径；`resolveManagedResource()` 返回本地绝对路径，`readManagedResource()` / `verifyManagedResource()` 读取并校验内容。图片位于 `.mdv-assets/` 外部目录，不改动 ZIP 或 generation；普通 Markdown 图片路径仍可以自行命名和放置。完整用法见[图片与相对资源](docs/resources.md)。

## 从源码使用

项目尚未发布到 npm。当前可以从源码构建并作为本地依赖使用：

```bash
git clone https://github.com/owariband/mdv.git
cd mdv
npm ci
npm test
npm run build
```

随后在调用方项目中安装本地目录：

```bash
npm install /absolute/path/to/mdv
```

仓库的 `prepare` 生命周期会生成 `dist/`，因此干净 checkout、本地目录、Git dependency 和 `npm pack` 不依赖预先提交构建产物。

运行时要求 Node.js 20 或更高版本，并使用 ESM `import`。

## 文档

- [官方使用文档](docs/README.md)
- [快速开始](docs/getting-started.md)
- [核心概念](docs/concepts.md)
- [当前 API 参考](docs/api-reference.md)
- [图片与相对资源](docs/resources.md)
- [兼容性与平台边界](docs/compatibility.md)
- [性能基线](docs/performance.md)
- [验证与发布检查](docs/releasing.md)
- [MDV Container Format 0.1](spec/format-0.1.md)
- [维护者设计资料](docs/design/index.md)

## 开发

```bash
npm run fixtures
npm run check
npm run test:package
npm run bench -- --quick
```

开发路线见[内部路线图](docs/design/roadmap.md)。VS Code extension、MarkText adapter 和 CLI 都是 Core 的上游项目，不属于本包的内部层次。

## 发布与许可证状态

仓库当前版本为 `0.0.0-development`，`package.json` 仍为 `UNLICENSED`。构建/发布检查生命周期已经建立；正式包名/scope、许可证与发布版本仍需 owner 决定。`npm run check:release -- --release` 在这些条件未满足时会失败，不会自动发布；在此之前不要把当前 API 当作 0.1 稳定承诺。
