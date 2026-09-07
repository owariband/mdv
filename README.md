<p align="center">
  <img src="docs/assets/mdv-icon.svg" alt="MDV cat icon" width="112" height="112">
</p>

# MDV

MDV（Markdown Document with Versions）是一种为 Markdown 增加双工作副本、显式版本和可追溯绑定关系的文档容器。`@mdv/core` 是它的 TypeScript 参考实现。

> 当前状态：开发预览。M3 创建、读取与工作副本保存 API 已完成；commit、checkout 和正式 npm 发布尚未完成。

## 为什么使用 MDV

- Reference 与 Document 各自拥有工作副本和版本历史。
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

const reopened = await openMdv('/documents/example.mdv')
console.log(await reopened.readDocumentText())

if (reopened.documentTree.head !== null) {
  const trace = reopened.traceDocument(reopened.documentTree.head)
  console.log(trace.reference)
}
```

M3 已支持创建空 MDV、从文件或内存打开、保存两份工作副本、读取历史正文、查询两棵版本树并追踪 bind。普通 save 只更新工作副本并递增 generation，不创建 Version；显式 commit 仍属于下一阶段。

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
- [M3 API 参考](docs/api-reference.md)
- [图片与相对资源](docs/resources.md)
- [MDV Container Format 0.1](spec/format-0.1.md)
- [维护者设计资料](docs/design/index.md)

## 开发

```bash
npm run fixtures
npm test
npm run typecheck
```

开发路线见[内部路线图](docs/design/roadmap.md)。VS Code extension、MarkText adapter 和 CLI 都是 Core 的上游项目，不属于本包的内部层次。

## 发布与许可证状态

仓库当前版本为 `0.0.0-development`，`package.json` 仍为 `UNLICENSED`。正式包名、许可证、发布生命周期和兼容性承诺将在稳定发布阶段确定；在此之前不要把当前 API 当作 0.1 稳定承诺。
