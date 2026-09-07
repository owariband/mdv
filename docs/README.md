# MDV 官方文档

这里是 `@mdv/core` 调用方文档，只描述当前代码已经提供的能力。未来设计、尚未实现的 API 和开发排期统一放在[维护者设计区](./design/index.md)，避免设计草案被误认为可用功能。

> 当前实现阶段：M5 已完成。当前 package export 可以创建、打开、读取、trace、save、commit、checkout，并提供结构化 status、统一内容选择、通用源码 Diff 与完整性诊断；受管资源属于 M5.5，发布硬化属于 M6。

## 从哪里开始

| 目标 | 文档 |
| --- | --- |
| 构建项目并完成第一次读取 | [快速开始](./getting-started.md) |
| 理解双工作副本、版本和 bind | [核心概念](./concepts.md) |
| 查询、保存、类型与错误码 | [当前 API 参考](./api-reference.md) |
| 正确处理图片和相对路径 | [图片与相对资源](./resources.md) |
| 实现其他语言的兼容 Reader/Writer | [Container Format 0.1](../spec/format-0.1.md) |
| 参与 Core 设计和后续开发 | [维护者设计索引](./design/index.md) |

## 当前能力边界

| 能力 | 状态 |
| --- | --- |
| 从文件路径或内存字节打开 MDV | 可用 |
| 读取 Reference / Document 工作副本 | 可用 |
| 列出版本、历史、children 和 bind | 可用 |
| 读取历史正文并校验 SHA-256 | 可用 |
| 返回 bytes 或严格 UTF-8 text | 可用 |
| 创建 generation 0 的空 MDV | 可用 |
| 保存 Reference / Document 工作副本 | 可用；generation CAS，不创建版本 |
| Markdown AST、HTML 和渲染 | 不属于 Core |
| commit Reference / Document Version | 可用；只固化已保存的 `current.md` |
| checkout Reference / Document Version | 可用；dirty 工作副本默认受保护 |
| 查询两棵工作副本 dirty 与 bind 关系 | 可用；`getStatus()` 返回四态 `ReferenceRelation` |
| 统一读取任意工作副本或历史版本 | 可用；`readContent(ContentSpec)` |
| 比较任意两份 Markdown 源码 | 可用；bounded line Diff，返回 hunks 与 unified text |
| 诊断容器、版本图和全部历史正文 | 可用；顶层 `verifyMdv()` 提供 metadata/full 模式 |
| 受管资源导入与校验 API | 尚未实现 |
| npm 正式发布与稳定兼容承诺 | 尚未完成 |

## 事实来源

不同文档承担不同职责：

1. [`spec/format-0.1.md`](../spec/format-0.1.md) 是 `.mdv` 物理格式的规范性基线。
2. 当前导出的 API 以 [`src/index.ts`](../src/index.ts) 和本目录 API 文档为准。
3. [`fixtures/`](../fixtures/) 与测试定义参考实现当前接受和拒绝的输入。
4. [维护者设计区](./design/index.md)记录产品设计、未来技术方案和路线图，其中未落地部分不是公开能力。

发现文档与代码不一致时，以可验证的代码和规范为依据修正文档，不在用户文档中提前发布设计中的方法。
