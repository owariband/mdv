# MDV 设计决策

本页只记录已经确认且会持续影响格式或 Core 边界的决定。详细机制见[架构](./architecture.md)与[技术方案](./mechanisms.md)。

## D001：ZIP 单文件，不增加 `mimetype`

- 日期：2026-09-07
- 状态：Accepted
- 决定：`.mdv` 使用 ZIP 容器；根 `manifest.json` 负责格式识别，不增加独立 `mimetype` entry。
- 理由：减少重复事实来源，文件扩展名只负责关联，Reader 仍验证 manifest。
- 影响：Reader 必须把 ZIP 当作不可信输入；格式识别不能只看扩展名。
- 证据：[Format 0.1](../../spec/format-0.1.md)、[架构 §4](./architecture.md#4-物理格式)

## D002：Reference 与 Document 使用两棵版本树

- 日期：2026-09-07
- 状态：Accepted
- 决定：维护 `ref_tree` 和 `doc_tree` 两份工作副本、Head 与历史；不建立 `seed`、`requirements`、`approved`、`published` 等命名 refs。
- 理由：真正需要追踪的是摘要演化、成品演化以及二者的精确关系，不是预设业务状态机。
- 影响：工作流标签属于上游产品，不进入 Format 0.1。

## D003：普通保存与 commit 分离

- 日期：2026-09-07
- 状态：Accepted
- 决定：`current.md` 沿用普通 Markdown 的可覆盖编辑语义；save 只持久化工作副本并执行 generation CAS，显式 commit 才创建不可变 Version。新建文档从零版本、零 Head 开始，不增加 `DraftVersion`、`workspace` 或 pending bind。
- 理由：编辑器内存 buffer、撤销栈和冲突交互本来就由宿主管理，Core 不应为了版本能力复制普通 Markdown 已有的编辑模型；自动保存也不应制造大量无意义历史。
- 影响：generation 记录包变更次数但不等同于版本数量；save 不移动 Head。多进程冲突由 Core 返回 `CONFLICT`，宿主决定重载、比较、合并或另存为。

## D004：Bind 只存于 Document Version

- 日期：2026-09-07
- 状态：Accepted
- 决定：Document Version 保存精确 `referenceVersion` 或 `null`；Reference Version 不维护反向 bind，工作副本也不保存 pending bind。
- 理由：版本不可变，双向持久化会产生两份需要同步的事实来源。
- 影响：Core 打开时构建可重建的 `documentsByReference` 反向索引；宿主在 commit 时显式提交 bind，尚未 commit 的选择只属于宿主上下文。

## D005：Core 返回 Markdown bytes/text，不返回 AST 或内部 path

- 日期：2026-09-07
- 状态：Accepted
- 决定：Core 的正文边界是原始 bytes 和严格 UTF-8 text，并附带 `baseDirectory`；Markdown parser/renderer model 留给 adapter。
- 理由：ZIP 内 logical entry 没有真实文件系统 path，不同渲染器也没有共同 AST。
- 影响：VS Code、MarkText 和 CLI 只依赖 package root，不把自身模型带入 Core。

## D006：CLI 与编辑器插件是独立上游

- 日期：2026-09-07
- 状态：Accepted
- 决定：`@mdv/core` 是进程内 Library，不启动服务，也不包含 CLI 层。VS Code extension 是 Core 0.1 闭环后的首个图形客户端。
- 理由：argv、UI、Agent tool 协议与格式语义有不同发布周期。
- 影响：上游只能调用 public API，不能直接修改 ZIP entry。

## D007：受管资源使用内容寻址 sidecar

- 日期：2026-09-07
- 状态：Accepted
- 决定：资源路径为 `.mdv-assets/<documentId>/<sha256>.<extension>`；Markdown 直接保存该相对路径，不在 manifest 维护可变映射。
- 理由：路径本身可以作为不可变内容引用，并允许旧 Markdown 继续定位资源。
- 影响：sidecar 不进入 ZIP或 Version hash；移动文档时必须一并移动资源目录，0.1 不自动 GC。
- 证据：[资源文档](../resources.md)、[Format 0.1 §12](../../spec/format-0.1.md#12-relative-resources)

## D008：接口稳定，泛型克制

- 日期：2026-09-07
- 状态：Accepted
- 决定：public `interface` 描述真实调用契约；联合类型表达状态；泛型只保留实际类型关系。不为单一 ZIP 后端预建 Repository、Provider 或 Factory。
- 理由：库需要明确的类型边界，但不需要没有第二实现的框架层。
- 影响：树相关返回类型优先使用少量 overload；真正出现第二后端后再从现有 I/O seam 提取最小接口。

## D009：M4 Commit 与 Checkout 边界

- 日期：2026-09-07
- 状态：Accepted
- 决定：commit 不接收 Markdown，只固化已保存的 `current.md`；第一次显式空 commit 创建根 Version；已有 Head 后 no-changes 不创建 Version，但成功事务仍让 generation 增加 1。checkout 默认拒绝覆盖 dirty 工作副本，只有显式 `discardChanges: true` 才能替换 `current.md`。
- 理由：版本操作必须建立在已经持久化、可进行 CAS 的工作副本上；显式 commit 表达用户保存版本的意图，而 checkout 不能静默丢弃已经保存的普通 Markdown。
- 影响：宿主在 commit 前负责 save 内存 buffer；`CommitResult.created` 只说明是否创建 Version，不说明事务是否成功；宿主处理 dirty checkout 冲突时必须让用户选择先 commit 或明确丢弃。

## D010：M5 提供 Agent-friendly 的通用只读原语

- 日期：2026-09-07
- 状态：Accepted
- 决定：M5 在现有只读快照上增加异步 status、统一 `ContentSpec` 内容选择、源码级 diff 和顶层 `verifyMdv`。这些能力主要由 Agent/自动化调用需求驱动，但保持为与具体 Agent 协议无关的通用 Core API；不修改 Format 0.1，不增加新的写事务，也不解析或渲染 Markdown。
- 状态语义：Document 与 Reference 的当前关系使用 `no-document-head`、`unbound`、`aligned`、`drifted` 四态联合类型表达，不用 `null` 同时承载多种含义；两棵树各自的 dirty 由 `current.md` 的 byte length / SHA-256 与对应 HEAD metadata 比较，不提前读取历史正文。
- 读取与比较语义：`readContent(ContentSpec)` 和 `diff(from, to)` 共享同一种来源选择器，可明确选择任一树的工作副本或历史 Version；diff 面向原始 Markdown 行，保留正文语义，不经过 AST round-trip。
- 诊断语义：`verifyMdv(source)` 是无需先成功 `openMdv` 的 package-root 入口，可以在安全边界内聚合报告损坏归档的问题，并用 `complete` 区分完整扫描与提前停止；普通 `openMdv` / `parseMdv` 继续 fail-fast。
- 人类宿主边界：Reference/Document 左右对照依赖 Document Version 的精确 bind、trace 与内容读取，这些属于 Core；双栏布局、同步滚动、高亮、Markdown 渲染和 Review 交互属于 VS Code/MarkText。M5 对普通人的直接价值较小，也不代表 Core 提供 Review UI。
- 理由：Agent/CLI 需要无歧义地回答“当前改了什么、成品依赖哪个摘要、任意两份正文差什么、包为何打不开”。由 Core 统一这些确定性计算，可以复用 bind、hash、错误码和 Archive 安全边界，避免每个 Agent tool 产生不同实现；但 Core 不增加 Agent 专属 DTO、prompt 或 token 裁剪策略。
- 影响：M5 主要修改 public types、facade、纯 Core 计算和 Archive 诊断读取；`mutation.ts`、`writer.ts` 与 `transaction.ts` 不改，`commands.ts` 只允许为 dirty 规则一致性做机械修正。最终 checkout 补上 `contentBytes` 比较，与 status 的长度 + SHA-256 规则一致，没有新增 command 或改变公开事务语义。基础人类读写和 bind 左右对照不以 M5 为前置；受管图片 sidecar 独立在 M5.5 实现，发布兼容性在 M6 收口。
