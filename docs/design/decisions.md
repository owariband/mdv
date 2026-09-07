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
- 决定：save 只持久化工作副本；显式 commit 才创建不可变 Version。新建文档从零版本、零 Head 开始。
- 理由：编辑器自动保存不应制造大量无意义历史。
- 影响：generation 记录包变更次数，但不等同于版本数量。

## D004：Bind 只存于 Document Version

- 日期：2026-09-07
- 状态：Accepted
- 决定：Document Version 保存精确 `referenceVersion` 或 `null`；Reference Version 不维护反向 bind。
- 理由：版本不可变，双向持久化会产生两份需要同步的事实来源。
- 影响：Core 打开时构建可重建的 `documentsByReference` 反向索引。

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
