# 核心概念

MDV 在 Markdown 之上增加版本与来源追踪，但不改变 Markdown 语法。理解它只需要区分工作副本、版本和两棵历史树。

## 普通 Markdown 是编辑底座

不执行版本操作时，`current.md` 本质上就是普通 Markdown 工作副本，MDV 不为编辑过程增加另一套文档模型：

```text
编辑器内存 buffer -> save -> current.md -> explicit commit -> Version
     宿主管理                 Core 持久化             不可变快照
```

- 编辑器内存中的未保存内容由 VS Code、MarkText 等宿主管理；
- Core 的 save 只保存目标 `current.md`、执行 generation CAS，不创建 Version、不移动 Head；
- 不存在 `DraftVersion`、`workspace` 或 pending bind；
- Document bind 只记录在 commit 后的 Document Version 中。

因此多个进程同时保存时，冲突语义也和普通 Markdown 被外部修改相同：Core 返回 `CONFLICT` 并阻止静默覆盖，宿主决定重载、比较、合并或另存为。

## 一个容器，两份工作副本

每个已经写出容器的 `.mdv` 包含：

```text
ref_tree/current.md    当前 Reference 工作副本
doc_tree/current.md    当前 Document 工作副本
```

- **Reference** 可以是需求、摘要、约束或调查输入。
- **Document** 是最终文档或仍在编辑的成品草稿。

Reference 可以一直为空。此时 MDV 就退化为带显式版本能力的普通 Markdown 文档。

## 保存不等于 commit

工作副本是可变内容；Version 是不可变快照。

```text
编辑工作副本 -> save -> 工作副本持久化，历史不变
编辑工作副本 -> commit -> 创建新 Version，并移动对应 Head
```

新建文档从 generation 0、两份空工作副本、零版本和零 Head 开始，不会预先制造空的 R1/D1。

普通文件管理器新建的 0 字节 `.mdv` 也是正常写作入口：打开时视为空白文档、磁盘不变，首次保存才建立 ZIP 容器。无需手动“初始化”，也无需先创建某个历史版本。原始非空文件不会被当成空白文档覆盖。

当前 API 已提供 `createMdv`、`saveReference`、`saveDocument`、两种 commit 和两种 checkout。commit 读取已经 save 的 `current.md`，而不是接收另一份 Markdown；checkout 用历史正文替换工作副本并移动对应 Head，但不创建或删除 Version。

## 两棵独立历史

Reference 和 Document 分别使用单父版本历史：

```text
R1 -> R2 -> R3

D1 -> D2 -> D3
```

从旧版本继续 commit 时可以形成分叉；旧版本不会被覆盖。Version ID 是不透明随机标识，`R1`、`D2` 只是 UI 可以计算出的展示名称。

## Bind 只写在 Document Version

每个 Document Version 保存：

```text
referenceVersion = 某个精确的 Reference Version ID
```

或者：

```text
referenceVersion = null
```

Reference Version 不保存反向列表。Core 在打开文档时扫描 Document 元数据，构建可重建的反向索引。这样新增 D3 不需要修改已经不可变的 R1。

`referenceVersion = null` 表示该 Document Version 没有 Reference 依赖，不是错误。

工作副本不保存“准备绑定哪个 Reference”之类的 pending 状态。宿主可以在自己的 UI 或任务上下文中暂存选择，但只有显式 `commitDocument()` 时传入并写入不可变版本的 bind 才是 MDV 的持久事实。

## Head、历史与 Trace

每棵树各有一个可选 Head，指向当前工作副本所基于的版本。公开 API 提供三类查看方式：

- `getHistory()`：从指定版本或 Head 沿 parent 返回到根；
- `getChildren()`：查看某个版本直接产生的分叉；
- `traceDocument()` / `traceReference()`：组合 ancestry 与 bind 信息。

Document 绑定的 Reference 可以落后于 Reference Head。`getStatus()` 会把它报告为 `drifted`，但 Reader 不会擅自更新旧 Document 的 bind。

## Markdown 是保真边界

Core 保存和返回原始 UTF-8 Markdown 字节，不生成 AST 或 HTML，也不重新格式化正文：

```text
.mdv -> @mdv/core -> Markdown bytes/text + baseDirectory -> 宿主 renderer
```

因此 VS Code、MarkText、remark 等工具只需要 adapter，不需要让 Core 兼容它们各自的内部 model。

## generation 不是 Version

`manifest.generation` 用于写事务的并发比较后交换。save、commit 和 checkout 都要求调用方传入 `expectedGeneration`；成功时返回新快照并把 generation 精确增加 1，冲突时不会覆盖磁盘。Version 只在显式 commit 时创建。两者不能混为一谈。

## 下一步阅读

- [快速开始](./getting-started.md)
- [当前 API 参考](./api-reference.md)
- [图片与相对资源](./resources.md)
- [Format 0.1](../spec/format-0.1.md)
