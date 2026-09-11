<p align="right">
  <a href="README.en.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="docs/assets/mdv-readme-mark.svg" alt="MDV cat document mark" width="104" height="104">
</p>

<h1 align="center">MDV</h1>

<p align="center"><strong>Markdown, with memory.</strong></p>

<p align="center">提示词不必重写 · 人的原稿不会丢失 · 每次交付都有来路</p>

<p align="center">
  <a href="https://github.com/owariband/mdv/actions/workflows/ci.yml"><img src="https://github.com/owariband/mdv/actions/workflows/ci.yml/badge.svg" alt="Core verification"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-263340" alt="Apache License 2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-263340" alt="Node.js 20 or newer">
</p>

<p align="center">
  <a href="#mdv-解决什么问题">为什么是 MDV</a> ·
  <a href="#我们提供什么">产品</a> ·
  <a href="#先看-mdv-在做什么">动画</a> ·
  <a href="#一分钟上手">一分钟上手</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="spec/format-0.1.md">格式规范</a>
</p>

AI 越来越好用，我们也越来越愿意让它参与写作和改稿。但今天的大多数文档工作流没有跟上：AI 越能干，散落在对话里的上下文和只剩最新版的文档就越容易成为隐患。

换一个对话、模型或 Agent，人就要重新粘贴提示词、需求、背景和约束；让 AI 直接修改 Markdown，又往往只留下“最新结果”，把人原本写下的文档和中间版本覆盖掉。最后虽然得到了一份成品，却很难回答：**它依据的是哪一版要求，又是从哪一版原稿演进而来的？**

**MDV 就是在这个背景下推出的。** 它把给 AI 的提示词、brief 和背景材料保存为 **Reference**，把人的原始文档以及后续的人机协作稿保存为 **Document**。两者位于同一个 `.mdv` 文件中，却可以独立编辑、独立形成不可变版本；下一次 Agent 可以从同一个文件读回上下文，每个 Document Version 也会精确绑定它实际使用的 Reference Version。

> **MDV 已通过 GitHub 源码公开。** Format 0.1、Core、VS Code Plugin 与 Agent Tool 均已在本仓库开放；MDV Desktop 也以可从源码运行的 Preview 形式提供，但尚无安装包、签名或自动更新。当前公开分发渠道仍为 GitHub 源码。

## MDV 解决什么问题

| AI 文档工作流里的问题 | MDV 的回答 |
| --- | --- |
| 换一个会话就要重新写提示词、重新交代上下文 | 将提示词、brief、规范和背景保存为可复用、可版本化的 Reference，下一次 Agent 可以直接读回 |
| AI 改完只剩最新版，人的原稿和中间版本容易被覆盖 | Document 拥有独立历史；每次显式 commit 都形成不可变版本，原稿与历次修改都能找回 |
| 文档与提示词都在变化，事后说不清某份结果用了哪版要求 | 每个 Document Version 精确 bind 到当时使用的 Reference Version，可以追溯、比较和验证 |

MDV（Markdown Document with Versions）给 Markdown 工作流补上一层可携带的记忆：不必反复重写上下文，也不必拿人的原始文档去交换 AI 的便利。它不要求你更换编辑器——可以继续使用 VS Code，也可以选择仓库中的专注型 Desktop Preview。

## 我们提供什么

MDV 不只是一种文件扩展名。这个仓库提供一套完整的 MDV 文档范式，以及分别面向开发者、人和 Agent 的四个组件；其中 Desktop 当前是源码 Preview：

**一句话概括：Core 负责 `.mdv` 的格式语义，VS Code Plugin 与 MDV Desktop 面向人，Agent Tool 面向 Agent。**

| 组件 | 面向谁 | 提供什么 |
| --- | --- | --- |
| [MDV Core](docs/README.md) — 文档范式解析库 | 开发者与工具作者 | `.mdv` 格式的 TypeScript 参考实现：解析、创建、校验和读写 MDV，并管理 Reference / Document 两棵版本树、精确 bind、Diff、Trace 与受管资源 |
| [MDV for VS Code](adapter/mdv_vscode/README.md) — VS Code Plugin | 人 | 在 VS Code 中直接阅读 `.mdv`：复用原生 Markdown 编辑器和预览器，查看 Reference / Document、双列版本图与精确绑定；也可以编辑、保存、commit 和恢复历史版本 |
| [MDV Desktop](adapter/mdv_desktop/README.md) — Desktop Preview | 人 | 基于 Electron、Vue 3 与 Milkdown 的专注型桌面编辑器：同屏编辑 Ref / Doc，查看已有版本、分支与精确 bind；普通 `.md` 保持单栏。Reference 每次保存都需原生确认；当前仅支持源码构建，尚不支持 commit / checkout |
| [MDV Agent Tool](adapter/mdv_agent_tool/README.md) — Agent Tool | AI Agent | 让 Agent 通过权限感知的 CLI 安全操作 `.mdv`：读取成对上下文，查询状态、版本、Trace、Diff 和诊断，并在明确边界内保存、commit 或 checkout |

```text
Human  ⇄  MDV for VS Code ────┐
Human  ⇄  MDV Desktop Preview ├─⇄ MDV Core ⇄ .mdv
Agent  ⇄  MDV Agent Tool ─────┘
```

三个 adapter 都建立在同一套 Core 与 Format 0.1 上：人看到的、Agent 读取的和磁盘中保存的是同一种 MDV 语义，不需要在多套模型之间转换。

## 先看 MDV 在做什么

### 01 / The Living Graph

<p align="center">
  <img src="docs/assets/promo/a-living-graph.gif" alt="MDV animation showing two independent histories and one exact bind" width="720">
</p>

Reference 与 Document 各自拥有一棵历史。Document D02 精确绑定 Reference R02；即使 Reference HEAD 继续走到 R03，已经存在的 bind 也不会漂移。

### 02 / The Editorial Memory

<p align="center">
  <img src="docs/assets/promo/b-editorial-memory.gif" alt="MDV animation showing what was asked beside what was delivered" width="720">
</p>

“当时要求了什么”和“最终交付了什么”可以独立变化。MDV 保存的不是一个模糊的最新来源，而是这份结果真正使用过的那一版上下文。

### 03 / Native Proof

<p align="center">
  <img src="docs/assets/promo/c-native-proof.gif" alt="MDV animation showing native Markdown editing and a visible version graph in VS Code" width="720">
</p>

正文仍然是原生 Markdown：继续使用 VS Code 的编辑器、预览器和扩展生态；MDV 只补上双工作副本、可见历史与精确 bind。画面来自 VS Code adapter 的真实集成测试，不是重新画出的概念 UI。

## 一个简单、明确的模型

```text
Reference buffer ── save ──> ref_tree/current.md ── commit ──> R01 ──> R02 ──> R03
Document buffer  ── save ──> doc_tree/current.md ── commit ──> D01 ──> D02
                                                                         │
                                                                         └── bind ──> R02
```

- **Save 不是 commit。** Save 只持久化可覆盖的 `current.md`；只有显式 commit 才创建不可变 Version。
- **Bind 属于版本。** 每个 Document Version 绑定一个精确的 Reference Version，或明确绑定 `null`；它不会跟随 HEAD 自动更新。
- **Markdown 是保真边界。** Core 返回原始 UTF-8 Markdown bytes/text，不生成 AST、不渲染 HTML，也不擅自格式化正文。
- **容器保持透明。** `.mdv` 是普通 ZIP，物理结构由独立的 Format 0.1、JSON Schema 与一致性 fixtures 约束。
- **并发不会静默覆盖。** 写操作使用 generation CAS；宿主收到 `CONFLICT` 后决定重载、比较或合并。

这套模型适合需要保留“输入依据 → 交付结果”关系的写作、评审和 Agent 工作流；它不是仓库级 Git、Markdown renderer 或协同编辑协议。

## 一分钟上手

### 1. 从 GitHub 获取并构建

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

运行时要求 Node.js 20+ 与 ESM `import`。当前公开发行版以本 GitHub 仓库中的源码、格式规范和验证结果为准。

### 2. 运行 Desktop Preview（可选）

```bash
cd adapter/mdv_desktop
npm run prepare:core
npm ci
npm run build
npm run start
```

Desktop 要求 Node.js 22.12+。它可以打开文件或目录、同屏编辑并安全保存 Ref / Doc 工作副本，以及查看已有版本、分支与 bind；版本图当前只读，尚不能在 Desktop 内 commit 或 checkout。普通 `.md` 使用单栏编辑，当前也还没有 installer、签名或自动更新。`prepare:core` 会把当前本地 Core 打成固定 tarball，Desktop 仍是独立 npm package。

### 3. 保存两份工作副本，并提交一次精确绑定

```ts
import { createMdv } from '@owariband/mdv'

let mdv = await createMdv('./launch-plan.mdv')

mdv = await mdv.saveReference({
  markdown: '# Brief\n\nKeep the interface native.\n',
  expectedGeneration: mdv.manifest.generation,
})

const reference = await mdv.commitReference({
  actor: { type: 'human', name: 'Hypnos' },
  summary: 'Approve the launch brief',
  expectedGeneration: mdv.manifest.generation,
})
if (!reference.created) throw new Error('Expected a new Reference Version')
mdv = reference.document

mdv = await mdv.saveDocument({
  markdown: '# Launch plan\n\nShip native Markdown with visible history.\n',
  expectedGeneration: mdv.manifest.generation,
})

const document = await mdv.commitDocument({
  referenceVersion: reference.version,
  actor: { type: 'agent', id: 'writer-agent' },
  summary: 'Deliver the launch plan',
  expectedGeneration: mdv.manifest.generation,
})
if (!document.created) throw new Error('Expected a new Document Version')

console.log(document.document.traceDocument(document.version).reference?.id)
```

继续阅读[快速开始](docs/getting-started.md)，可以完成 open、checkout、trace、Diff、诊断以及受管图片闭环。

## 文档地图

- [快速开始](docs/getting-started.md) — 创建、保存、commit、checkout 与读取。
- [核心概念](docs/concepts.md) — 工作副本、Version、HEAD、bind 与 generation。
- [API 参考](docs/api-reference.md) — 当前公开方法、类型与错误码。
- [图片与相对资源](docs/resources.md) — 普通路径与 hash sidecar。
- [兼容性与平台边界](docs/compatibility.md) — 运行环境、文件系统语义与默认预算。
- [Container Format 0.1](spec/format-0.1.md) — 兼容 Reader / Writer 的规范性基线。
- [MDV Desktop Preview](adapter/mdv_desktop/README.md) — 桌面端能力边界、本地运行方式与架构。

<details>
<summary>维护者与发布资料</summary>

- [验证与发布检查](docs/releasing.md)
- [性能基线](docs/performance.md)
- [维护者设计索引](docs/design/index.md)
- [开发路线图](docs/design/roadmap.md)

</details>

## 开发与验证

```bash
npm run fixtures:check
npm run check
npm run test:package
npm run bench -- --quick
```

Desktop 是独立 package，需要单独验证：

```bash
cd adapter/mdv_desktop
npm run typecheck
npm test
npm run test:e2e
```

Core CI 在 Ubuntu、macOS 与 Windows 上覆盖 Node.js 22 / 24 / 26，并额外验证 Ubuntu / Node.js 20。`npm run test:package` 会从干净源码构建真实 tarball，再交给独立 runtime 与 TypeScript consumer 安装验证。根目录的 `npm test` 与当前 Core CI 尚不会自动运行 Desktop 的 Electron E2E。

MDV 源码已通过 GitHub 公开。后续每次进行版本化分发时，维护者仍会在目标提交上完成[发布检查](docs/releasing.md)，确认包内容、跨平台验证、许可证与第三方声明保持一致。

## License

MDV 使用 [Apache License 2.0](LICENSE)。在遵守许可证条款的前提下，可以使用、修改和分发本项目，包括商业使用；分发修改版本时需要保留适用的许可证与版权声明，并说明所作修改。Apache-2.0 还包含明确的贡献者专利授权。

仓库根目录与各 adapter 使用完全相同的 Apache-2.0 标准正文。现有 adapter 单文件产物中第三方组件及其许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)；Desktop 尚无分发包，首次打包前仍需完成 Electron、Vue 与 Milkdown 等依赖的许可清单复核。本节只是便于阅读的说明，不替代许可证正文，也不构成法律意见；发生差异时以 `LICENSE` 与第三方许可原文为准。
