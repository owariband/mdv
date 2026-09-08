# MDV Core 开发进度与路线图

> 最后更新：2026-09-08
>
> 当前里程碑：M6 工程硬化已实现，本地与远端 10 组 CI 均通过；发布身份/License 与正式发布待验收
>
> 范围：`@mdv/core` 的实现进度、阶段依赖和验收条件
>
> 维护者入口：[`index.md`](./index.md)；调用方文档：[`docs/README.md`](../README.md)

## 1. 文档定位

本文只回答三个问题：

1. 当前代码已经真正完成了什么；
2. 下一阶段应该实现什么，完成标准是什么；
3. VS Code、MarkText 和独立 CLI 应该在 Core 的哪个阶段接入。

它不重复定义产品和格式语义：

- 产品模型与行为以 [`architecture.md`](./architecture.md) 为准；
- 分层、模型和事务方案以 [`mechanisms.md`](./mechanisms.md) 为准；
- `.mdv` 物理格式以 [`format-0.1.md`](../../spec/format-0.1.md) 为准；
- 本文只维护实现状态，不在这里悄悄修改上述约定。

阶段状态的判断标准：

- **完成**：阶段范围内的实现、测试和必要公开出口都已经存在；
- **进行中**：已有可验证交付，但该阶段仍有明确验收项未关闭；
- **下一步**：当前最高优先级，前置条件已经满足；
- **未开始**：可以有设计稿或类型草案，但还没有形成可用实现；
- **上游等待**：不属于本仓库，等待所依赖的 Core 能力稳定后再接入。

内部函数存在不等于公开能力完成。例如 `archive/reader.ts` 能读取包，但在调用方还不能从 `@mdv/core` 包根导入 `openMdv` 时，仍不能把它记作“外部已经可以使用”。

## 2. 当前进度总览

| 里程碑 | 状态 | 已有结果 | 主要缺口 |
| --- | --- | --- | --- |
| M0 格式与工程基线 | 完成 | Format 0.1、Schema、基础 fixtures、单包工程 | 后续仍需扩充一致性 fixtures |
| M1 内部只读基础 | 完成 | ZIP Reader、严格 JSON/UTF-8、hydrate、版本图校验和基础索引查询 | 后续在 M6 扩充安全与 fuzz 矩阵 |
| M2 公开只读 API | 完成 | package root 的 open/parse、只读 facade、查询、trace、bytes/text 和稳定错误映射 | 写能力留在 M3；Agent-friendly 检查与诊断留在 M5 |
| M3 创建、保存与文件事务 | 完成 | create/save、确定性 ZIP Writer、锁内双重 CAS、临时包全验、fsync 与原子替换 | Windows 目录项 crash durability 尚未达到 POSIX 同等级保证 |
| M4 Commit 与 Checkout | 完成 | Core commands、有限 mutation、四个 package-root API、分叉与并发测试 | 后续 Agent-friendly status、Diff 与诊断 verify 留在 M5 |
| M5 Agent-friendly 审阅与诊断 | 完成 | 结构化 status、统一 `ContentSpec`、bounded line Diff、metadata/full `verifyMdv` 与 package-root 测试 | 默认限制与诊断边界已记录；后续稳定兼容承诺留到 M6 |
| M5.5 受管资源 sidecar | 完成 | 四个 `ManagedResource` API、located 只读快照、hash 校验、不覆盖原子发布与资源闭环测试 | POSIX/Windows 支持矩阵与长期兼容承诺留到 M6 |
| M6 稳定发布 | 进行中 | 可重复 fixtures、有界 fuzz、复杂 Markdown 回归、干净源码 tarball/TS consumer、基准、10 组 CI 通过与 release gate | npm scope/License/版本选择和实际发布待完成 |
| U1 VS Code extension | 上游等待 | 已确定为第一个落地客户端；bind + 内容读取与图片 sidecar 已可用，具体 mode 属于 extension | 等待 M6 形成 Core 0.1 稳定发布闭环 |
| U2 MarkText adapter | 上游等待 | MarkText/Muya 可以消费 Markdown string | 排在 VS Code 首个客户端之后 |
| U3 独立 CLI / Agent tool | 上游等待 | 边界已确定为 Core 上游，M4/M5/M5.5 public API 已可用 | 等待 M6 错误码、诊断码兼容承诺稳定 |

核心开发依赖顺序为：

```text
M0 格式基线
  -> M1 内部 Reader 与版本图
  -> M2 公开只读 API
  -> M3 create/save 与原子事务
  -> M4 commit/checkout
  -> M5 status/source diff/diagnostic verify
  -> M5.5 图片 hash sidecar
  -> M6 发布与兼容性收口

M2 完成 -> 上游已可只读打开，但暂不启动客户端开发
M3 完成 -> Core 具备工作副本保存
M4 完成 -> Core 具备显式版本与 trace 闭环
M5 完成 -> Core 具备面向 Agent/自动化的结构化检查与归档诊断能力
M5.5 完成 -> Core 具备 Markdown 图片受管 sidecar 闭环
M6 完成 -> Core 0.1 达到稳定发布口径
Core 0.1 稳定发布 -> 启动独立 VS Code extension，MarkText adapter 后续接入
```

## 3. 已完成阶段

### M0：格式与工程基线

状态：**完成**

已经完成：

- 确定 ZIP 单文件 `.mdv`，不增加 `mimetype` 条目；
- 确定 `ref_tree` 与 `doc_tree` 两棵独立历史；
- 确定工作副本保存与显式 commit 分离；
- 确定 Document Version 单向绑定精确 Reference Version，或显式绑定 `null`；
- 确定新建包为 generation 0、两个空工作副本、零版本、零 Head；
- 冻结 [`format-0.1.md`](../../spec/format-0.1.md) 作为 0.1 参考实现的物理格式基线；
- 建立 manifest、Reference Version、Document Version 三份 JSON Schema；
- 建立 `empty`、`unbound-document`、`invalid-manifest`、`dangling-reference` 四组基础 fixtures 及机器可读预期；
- 建立 Node.js 20+、TypeScript、ESM 单包工程和唯一 package root export；
- 明确依赖方向为 `public facade -> core -> archive`，CLI 保持为独立上游项目。

本阶段完成表示格式和职责边界已经足够支持参考实现继续开发，不表示 Format 0.1 的测试矩阵已经全部覆盖。

### M1：内部只读基础

状态：**完成**

Archive 层已经完成：

- 从文件路径或 `Uint8Array` 打开 `.mdv`；
- 索引固定条目、HEAD 和两棵树的版本目录；
- 拒绝危险路径、意外条目、重复/大小写/NFC 冲突路径；
- 拒绝加密、带 ZIP64 extra field 的条目、非普通文件和不支持的压缩方法；
- 限制条目数、单条目大小、总解压大小、压缩比、版本数、JSON 大小和 JSON 深度；
- 严格校验 UTF-8、JSON 语法、重复 JSON member 和 BOM；
- 解码 manifest 和两类 version meta，保留未知字段并产生 warning；
- 打开时读取并校验两个工作副本；
- 历史正文按需读取，并在读取时校验 `contentBytes` 与 SHA-256。

Core 层已经完成：

- 将不可信的 Archive DTO hydrate 为带品牌 ID 的领域模型；
- 校验 Document ID、generation、Version ID 和目录 ID 一致性；
- 校验 Version ID 跨两棵树唯一；
- 校验 HEAD、parent、Document → Reference bind 的存在性和树类型；
- 分别检测 Reference/Document parent 图中的环；
- 构建 children 和 `documentsByReference` 反向索引；
- 实现内部 `getHistory`、`getChildren`、`getDocumentReference`、`listDocumentsUsingReference` 查询；
- 按 RFC 3339 实际时间和 Version ID 稳定排序分叉子节点。

截至 2026-09-07，执行：

```bash
npm test
```

结果为 14 个测试全部通过，覆盖 codec、基础版本图和 Reader 主路径。

M1 明确不包含：

- `parseMdv`、`openMdv` 等 package root API；
- `DocumentSnapshot` / `MdvDocument` facade；
- `traceDocument`、`traceReference` 的公开组合结果；
- dirty、unbound、Reference drift 状态；
- status、统一内容选择器、Diff、顶层诊断 verify；
- 任何 create、save、commit、checkout 或写事务。

## 4. Core 开发阶段

### M2：公开只读 API

状态：**完成**

目标：让外部项目只依赖 `@mdv/core` 包根，就能安全打开、查询和读取 `.mdv`。

实现范围：

1. 增加 public facade，连接现有 Archive Reader 与 Core state；
2. 实现 `parseMdv(bytes)` 和 `openMdv(path)`；
3. 实现只读 `DocumentSnapshot` / `MdvDocument` 对象；
4. 暴露 manifest、package path、base directory、两棵树的 Head 和 warnings；
5. 实现 `listVersions`、`getHistory`、`getChildren`；
6. 实现 `getDocumentReference`、`listDocumentsUsingReference`；
7. 实现 `traceDocument` 和 `traceReference`；
8. 实现工作副本与历史版本的 bytes/text 读取方法；
9. 所有 text 方法使用严格 UTF-8 解码，不解析或格式化 Markdown；
10. 将 Archive/Core 内部异常统一映射为 public `MdvError`；
11. public 返回值不得泄露内部 `Map`、Archive DTO、ZIP entry 或第三方异常；
12. `src/index.ts` 仍是唯一公开出口，不开放 `core/*` 或 `archive/*` 子路径。

验收条件：

- 新增的 public API 验收测试只从包根导入，不依赖 `dist/archive/*` 或 `dist/core/*`；
- `openMdv` 能打开合法 fixtures，并返回当前 Document Markdown string；
- `parseMdv` 能从内存字节获得等价只读结果；
- 版本内容继续保持按需读取和哈希校验；
- 非 MDV、未知格式、坏 ZIP、坏版本图和非法 UTF-8 都返回对应 `MdvError.code`；
- 返回集合和 DTO 对调用方只读，调用方无法借此改变内部状态；
- 一个最小外部 consumer 可以只通过 package root 完成 `open -> readDocumentText -> trace`。

本阶段暂不实现写操作，也不为了“以后可能支持浏览器”抽象第二套 storage interface。

实际交付与原计划一致，另外收口了以下边界：

- `openMdv` 返回路径绑定的 `MdvDocument`；`parseMdv` 返回允许 `packagePath`、`baseDirectory` 为 `null` 的 `DocumentSnapshot`；
- `listVersions` 按 RFC 3339 实际时刻升序排列，并以 Version ID 打破平局；`getHistory` 从起点沿 parent 返回到根；
- literal tree 参数通过少量 overload 保留 Reference/Document 返回类型，不引入公开条件泛型；
- `MdvWarning` 同时包含 ZIP entry 和 JSON path，能够定位具体版本元数据；
- dirty、Document 与 Reference 的关系状态、Diff 和诊断 verify 仍按计划留在 M5；未定义清楚的 `readVersion()` 不提前发布，由明确的 `readVersionBytes/Text()` 覆盖 M2 需求，M5 再以统一内容选择器收口跨来源读取；
- 修正路径不存在、普通 ZIP、损坏 ZIP、畸形 manifest 与未知格式版本的错误分类，并补上规范要求的 BOM 拒绝。
- 新增 `bound-history`、`content-hash-mismatch`、`markdown-bom`、`unsupported-version` 和 `malformed-version` fixtures，并让 fixture 构建时间戳可重复。

截至 2026-09-07，`npm test` 共 22 个测试全部通过。新增的 package-root 黑盒测试覆盖 `open -> read -> query -> trace`，并验证返回数组冻结、正文 bytes 不会反向污染快照、历史正文继续按需验哈希。

### M3：创建、保存与原子文件事务

状态：**完成**

目标：形成第一个安全写入闭环。普通保存只修改工作副本，不创建历史版本。

实现范围分为三块。

Archive Writer：

- 编码新建 manifest 与工作副本；save 只更新 generation 和目标工作副本，原样保留 HEAD 与 version metadata；
- 生成符合 Format 0.1 的 ZIP32 单文件；
- 保留被重写 JSON 对象中的未知字段和值；
- 复制未变化的历史条目，不修改任何已有 version 内容；
- 提供有限的 package mutation，不允许上层任意编辑 ZIP entry。

新增 version metadata 与 HEAD 的编码由真正创建版本的 M4 commit 实现，M3 不为尚不存在的命令提前保留一套未验证 encoder。

本地文件事务：

- 获取目标 `.mdv` 对应的跨进程独占锁；
- 在锁内重新打开磁盘上的最新包；
- 比较 `expectedGeneration`，不一致返回 `CONFLICT`；
- 在目标同目录写唯一临时包；
- 使用现有 Reader 对临时包重新执行结构和新增正文完整性校验；
- fsync 临时文件，以原子替换作为 commit point，再同步必要的目录元数据；
- commit point 前的失败保留旧文件 byte-for-byte 不变；所有失败路径都保持目标为可读的旧包或新包，并尽力清理本次创建的临时文件和锁，清理失败必须显式上报。

Public API：

- 实现 `createMdv(path)`；
- 实现 `saveReference({ markdown, expectedGeneration })`；
- 实现 `saveDocument({ markdown, expectedGeneration })`；
- 两种 save 成功后 generation 精确增加 1，并直接返回新的路径绑定 `MdvDocument`；调用方从 `result.manifest.generation` 取得新 generation；
- 目标已存在时 `createMdv` 失败，不默认覆盖。

验收条件：

- `create -> reopen` 得到 generation 0、两个空工作副本、零版本、零 Head；
- Reference 可以永远为空，Document 仍可独立保存；
- 连续多次 save 后版本数量仍为零；
- Markdown 字节，包括 CRLF、中文和末尾换行，写入再读取后 byte-for-byte 一致；
- 两个 writer 使用同一 generation 时最多一个成功，另一个稳定返回 `CONFLICT`；
- 在写 ZIP、临时包校验、fsync、replace 等阶段注入失败后，原包仍可正常打开；
- 原子 replace 是 commit point；如果 replace 已成功而目录同步失败，错误明确携带 `committed: true` 和新 generation，调用方可以重新打开确认状态；
- save 拒绝最终 symlink、hard-link alias 和其他非普通文件目标；事务保证限定在支持跨进程锁与同目录原子替换的本地文件系统；
- 任意宿主 adapter 都通过 `saveDocument` 保存工作副本，而不是把 Markdown 文本直接覆盖到 `.mdv` ZIP 上。

这是 0.1 实现中风险最高的阶段。锁、CAS、临时文件、校验和 replace 必须作为一个事务闭环实现，不能先提供一个会直接覆盖原包的“简化 Writer”。

实际交付在原计划基础上进一步收紧了以下边界：

- save 在锁内同时比较 `documentId` 与 generation，避免路径被另一个同 generation 文档复用后误写；路径绑定还保存打开时的文件系统最终路径，并在父目录 alias 改变时拒绝写入；
- save 拒绝最终 symlink、hard-link aliases 和非普通文件；已有 POSIX mode 会保留，所有临时包从 `0600` 开始，避免重写窗口泄露私有正文；
- Writer 以 UTF-8 entry name byte order、固定 DOS 时间与 STORE 模式生成确定性 ZIP32；历史正文通过一次 ZIP 扫描逐版本送给 Writer，内存不随全部历史正文线性驻留；
- manifest 只替换原始 JSON 中的 generation token，版本 metadata 原样复制，因此未知字段中的超大数值、空白和 key 顺序不会经过有损 `JSON.parse -> stringify` 回写；
- 原子 replace 前重新用完整 Reader 校验临时包；源历史和临时历史都逐条验证 UTF-8、长度与 SHA-256；
- 事务成功直接返回锁内读取的新 `MdvDocument`，避免解锁后二次 open 读到另一个 writer 的 generation；
- 锁采用规范目标旁的目录互斥。已有锁不按时间自动回收；异常退出后只有在确认无 writer 存活时才人工删除。清理失败通过 `cleanupIncomplete` 与 `cleanupFailures` 显式上报；
- POSIX 本地文件系统路径会刷新临时文件、发布目录项以及锁删除后的目录元数据。Windows 会刷新临时文件，但 Node 缺少可移植目录 fsync/write-through，当前只承诺较弱的原子可见性；M3 当时未完成 Windows CI，M6 后续矩阵已通过，但不提高断电持久性承诺；
- 提前加入 `prepare` 构建生命周期和独立 tarball consumer smoke，避免干净 checkout 打出的包缺少 `dist/`。

M3 完成时的测试在 Node 20.19.5 与当前开发环境 Node 26.3.0 全部通过。覆盖 ZIP64、multi-disk EOCD 与跨盘 entry 拒绝、真实跨进程 create/save 竞争、generation/document/path 身份冲突、symlink/hardlink 防护、故障注入、commit point 之后的错误语义、清理失败报告、只读权限保持、临时文件及极端 umask 权限、历史完整性、未知 JSON 原样保留、动态时区下确定性以及 package-root 写 API。仓库当前测试总数以后续 `npm test` 输出为准，不在路线图中固化滚动数字。

### M4：Commit 与 Checkout

状态：**完成**

目标：完成“保存不产生版本，显式 commit 才固化版本”的核心语义。

开发原则：MDV 的编辑底子就是普通 Markdown，不为版本能力复杂化普通编辑流程。宿主内存 buffer、包内工作副本和已提交版本严格分开：

```text
宿主编辑器内存 buffer
  -> saveReference/saveDocument
ref_tree/current.md 或 doc_tree/current.md
  -> explicit commit
versions/<version-id>/content.md
```

- 编辑器内存 buffer 的撤销栈、未保存状态和自动保存时机归宿主；
- `current.md` 是可反复覆盖保存的普通 Markdown 工作副本；save 只更新目标工作副本并执行 generation CAS，不创建 Version、不移动 Head；
- 不引入 `DraftVersion`、`workspace`、pending bind 或另一套草稿状态机；
- Document bind 只属于 commit 后的不可变 Document Version，工作副本不保存 bind；
- 多进程冲突等价于普通 Markdown 被外部修改：Core 返回 `CONFLICT` 并阻止覆盖，宿主决定重载、比较、合并或另存为。

已交付 public API（均从 package root 导出）：

```ts
interface CommitInput {
  readonly expectedGeneration: number
  readonly actor: Actor
  readonly summary: string
}

interface CommitDocumentInput extends CommitInput {
  readonly referenceVersion: VersionId | null
}

type CommitResult =
  | { readonly created: true; readonly version: VersionId; readonly document: MdvDocument }
  | { readonly created: false; readonly reason: 'no-changes'; readonly document: MdvDocument }

interface CheckoutInput {
  readonly version: VersionId
  readonly expectedGeneration: number
  readonly discardChanges?: boolean
}

interface MdvDocument {
  commitReference(input: CommitInput): Promise<CommitResult>
  commitDocument(input: CommitDocumentInput): Promise<CommitResult>
  checkoutReference(input: CheckoutInput): Promise<MdvDocument>
  checkoutDocument(input: CheckoutInput): Promise<MdvDocument>
}
```

实际交付：

- 增加 Core command 层，在事务锁内基于最新 state 计算 mutation；
- 使用密码学安全随机源生成不透明 Version ID；
- `commitReference` 保存完整正文快照，以当前 Reference HEAD 为 parent；
- `commitDocument` 保存完整正文快照，以当前 Document HEAD 为 parent；
- `commitDocument.referenceVersion` 必须显式为一个已存在的 Reference Version 或 `null`；
- commit 不接收 Markdown 参数，只读取已经 save 的目标 `current.md`；尚在编辑器内存中的内容必须由宿主先保存；
- commit 写入 actor、summary、RFC 3339 时间、SHA-256 和 content bytes；
- 内容和 bind 都未变化时返回 `created: false, reason: 'no-changes'`；
- no-changes 仍是一笔成功 commit 事务，不创建 Version，但 generation 精确增加 1；
- 没有 Head 时，第一次显式 commit 即使 `current.md` 为空也创建 parent 为 `null` 的根 Version；
- Document 正文未变化但 bind 改变时仍创建新版本；
- checkout 只恢复目标版本正文并移动对应 HEAD，不创建版本；成功时 generation 精确增加 1；
- checkout 默认拒绝覆盖相对 Head 已 dirty 的 `current.md`，返回 `CONFLICT`；只有调用方显式传 `discardChanges: true` 才覆盖；
- 从旧版本 checkout 后再次 commit 形成可追踪分叉，旧版本保持不可变。

验收结果：

- 在零个 Reference Version 的包中，`referenceVersion: null` 可以连续创建 Document 历史；
- `R1 -> R2` 与 `D1(bind R1) -> D2(bind R2)` 重新打开后关系不变；
- Reference 侧不存反向 bind，反向关系可完全从 Document meta 重建；
- 查看旧版本不会改变工作副本或 HEAD；
- commit 读取已保存工作副本，不会把编辑器尚未 save 的内存 buffer 误当成版本正文；
- 第一次显式空 commit 创建根 Version；已有 Head 后 no-changes 不创建 Version，但 generation 增加 1；
- dirty 工作副本在普通 checkout 下得到 `CONFLICT`，显式 `discardChanges: true` 才能被历史正文替换；
- checkout 后 commit 可以形成分叉，`getChildren` 返回稳定顺序；
- 已有 version 的 meta 和 content 永远不被原地修改；
- commit/checkout 同样遵守 M3 的 generation CAS 和原子事务。

以上行为已有 Core command、package-root API、重开、分叉、输入错误、generation CAS 和真实跨进程竞争测试。当前完整测试数量以 `npm test` 输出为准。

### M5：Agent-friendly 审阅与诊断能力

状态：**完成（2026-09-08）**

目标：在不修改 Archive 格式、不引入 Markdown AST 的前提下，为 Agent 与自动化调用方补齐结构化工作副本状态、Document 与 Reference 的关系状态、任意 Markdown 来源之间的受限源码 Diff，以及可用于损坏归档排障的顶层诊断入口。

M5 的主要驱动力是 **Agent-friendly**，不是人类编辑器缺少基础能力。M2–M4 已经提供 bind、trace、精确版本读取和写入操作；人类宿主据此就能把绑定的 Reference 与 Document 放在左右两侧。双栏布局、同步滚动、高亮、Markdown 渲染和 Review 交互属于 VS Code/MarkText 上游，不进入 Core。M5 对人类直接调用的价值有限，主要让 Agent/CLI 不必自行拼接状态、重复实现 Diff 或从首个异常猜测归档问题。

这些能力仍放在 Core，是因为它们是与 UI、模型供应商和 Agent 协议无关的确定性纯操作，且需要复用 Core 的 bind、hash、错误码与 Archive 安全边界。Core 只返回通用结构化结果，不增加 Agent 专属 DTO、prompt、token 截断策略或 Review mode。

M5 全部能力都是只读计算，不移动 HEAD、不增加 generation，也不修改工作副本或历史 Version。实现继续复用 M1 的索引和惰性正文读取、M2 的 facade 与错误映射，不新增 Writer、Repository、Provider 或第二种 storage abstraction。

#### M5.1 工作副本状态

已新增公开 status 结果，一次返回 Reference、Document 两个 working copy 的 dirty 状态：

- 有 HEAD 时，只读取工作副本，计算 `byteLength` 与 SHA-256，并与已经 hydrate 的 HEAD metadata 比较；Markdown 格式、空白、CRLF、Unicode 和末尾换行的变化都属于修改；
- 没有 HEAD 时，空工作副本为 clean，非空工作副本为 dirty；
- status 不把宿主编辑器尚未 save 的内存 buffer 纳入判断；调用方必须先通过现有 save API 更新 `current.md`；
- status 不读取 HEAD `content.md`，因此不破坏历史正文按需读取；HEAD 正文自身是否与 metadata 一致由普通版本读取或 `verifyMdv(source, { mode: 'full' })` 负责；
- status 不为工作副本创建 Draft Version，也不改变 M4 已冻结的普通 Markdown 保存语义。

每棵树返回统一的 `TreeWorkingCopyStatus { head: VersionId | null; dirty: boolean }`；冻结的 `DocumentStatus` 聚合 Reference、Document 两棵树状态和下节的 `referenceRelation`。计算需要读取包内两份工作副本，因此在 `DocumentSnapshot` 上提供异步 `getStatus(): Promise<DocumentStatus>`，不发布一个看似同步却隐含 I/O 的属性。

#### M5.2 Document 与 Reference 的关系状态

Document HEAD 与 Reference HEAD 的关系使用判别联合表达，避免用 `boolean | null` 混合“没有版本”“明确不绑定”和“发生漂移”：

```ts
type ReferenceRelation =
  | { readonly kind: 'no-document-head' }
  | { readonly kind: 'unbound' }
  | {
      readonly kind: 'aligned'
      readonly referenceVersion: VersionId
    }
  | {
      readonly kind: 'drifted'
      readonly boundReference: VersionId
      readonly currentReference: VersionId | null
    }
```

- `no-document-head`：Document 尚无 HEAD；归档中即使存在未被 HEAD 指向的历史 Version，也不改变这个当前状态；
- `unbound`：当前 Document Version 明确保存了 `referenceVersion: null`，这是合法状态；
- `aligned`：Document 绑定的精确 Reference Version 等于 Reference HEAD；
- `drifted`：Document 仍绑定某个合法历史 Reference Version，但 Reference HEAD 已经是另一个版本或 `null`。

该状态只报告事实，不自动 checkout、commit 或重新绑定。Document 只有在调用方下一次显式 `commitDocument({ referenceVersion })` 时才产生新的 bind。

`DocumentStatus.document.head` 已经给出当前 Document Version，因此 `ReferenceRelation` 不重复携带 `documentVersion`。这样每个分支只表达关系本身，同时仍能通过同一个 status 结果定位参与判断的 Document HEAD。

#### M5.3 统一内容选择器与源码 Diff

现有 `readReference*`、`readDocument*` 和 `readVersion*` 已经能取得原始 Markdown，不再增加含义重叠且无法表明树类型的 `exportMarkdown()`。M5 用一个明确的 `ContentSpec` 统一表示 Diff 两侧以及跨来源读取的目标：

```ts
type ContentSpec =
  | {
      readonly tree: TreeKind
      readonly kind: 'working-copy'
    }
  | {
      readonly tree: TreeKind
      readonly kind: 'version'
      readonly version: VersionId
    }
```

已增加：

- `readContent(ContentSpec)`：返回现有 `MarkdownSource`，作为统一 bytes 读取出口；
- `diff(from: ContentSpec, to: ContentSpec, options?)`：比较任意合法工作副本或历史 Version；
- 版本选择器必须同时校验 Version 存在且属于声明的 tree，不能依赖调用方猜测 Version 类型；
- 保留 M2 已发布的 read 方法作为清晰的便捷入口，不做破坏式改名。

Diff 是 Markdown **源码逐行 Diff**，不解析 AST、不渲染 HTML，也不推断“需求是否落实”。结果同时返回结构化 hunks 和 deterministic unified text；hunk 携带 old/new 起点与行数，其中的行区分 context、addition、deletion，以 `oldLine/newLine: number | null` 标明两侧行号，并保留原始行结束符。默认不忽略空白、CRLF/LF、Unicode 或末尾换行差异，也不自动格式化正文。

结构化 Diff 主要用于 Agent 在没有可视化界面时获得有限、可定位的变化上下文。VS Code/MarkText 可以完全忽略它，直接把 bind 对应的两份 Markdown 交给自身的左右对照或原生 Diff UI；Core 的 Diff 不是人类展示协议。

`DiffLimits` 明确包含 `maxInputBytes`、`maxInputLines`、`maxEditLength`、`maxHunks` 与 `maxOutputBytes`。其中 `maxInputLines` 限制两侧输入总行数，`maxEditLength` 限制差异算法允许探索的编辑距离，避免完全不同的大文本触发失控的时间或内存开销。任一上限超出都统一返回 `LIMIT_EXCEEDED`，不静默截断成看似完整的结果；`contextLines` 等选项必须校验为有限非负整数。

最终实现默认 `contextLines = 3`、合计输入 8 MiB / 200,000 行、最大编辑距离 2,048、最多 10,000 个 hunk、unified text 最多 16 MiB。算法采用共同前后缀裁剪后的 bounded Myers；没有增加 runtime dependency，并通过随机小序列与 LCS 对照检查最短编辑数及双侧重建。

#### M5.4 顶层完整性诊断

已增加 package-root 顶层入口 `verifyMdv(pathOrBytes, { mode: 'metadata' | 'full' })`，而不是只在已经成功打开的 `DocumentSnapshot` 上增加 `verify()`。原因是待诊断的包可能损坏到 `openMdv()`/`parseMdv()` 无法构造 snapshot。

- `metadata`（默认）：检查 ZIP 容器、固定条目、manifest、HEAD、Version metadata、ID、parent 图、Document bind、工作副本 UTF-8 以及现有资源上限；
- `full`：包含 metadata 的全部检查，并遍历两棵树的每一个历史 `content.md`，验证严格 UTF-8、`contentBytes` 和 SHA-256；
- 返回冻结的结构化报告，包含 `valid`、`mode`、`complete`、按稳定顺序排列的 issues 和 warnings；每个 issue 携带稳定 code、可选 entry/path、结构化 details 与消息，供 CLI、VS Code 和 Agent 定位；
- `mode` 明确报告实际请求的检查深度；`complete: true` 只表示该模式要求的范围已经完整扫描，不表示归档合法，最终合法性仍由 `valid` 表达；
- `valid` 只在请求 mode 完整执行且没有 issue 时为 `true`；warning 不影响 `valid`，因此不会出现 `complete: false, valid: true`；
- `VerifyOptions.maxIssues` 是有限正整数硬上限；达到上限、资源限制阻断或上游结构错误导致剩余范围无法安全遍历时停止继续聚合并返回 `complete: false`，不能把部分报告伪装成完整报告；
- 文件路径不存在、不可读或底层读取失败时，没有可供诊断的输入，顶层调用仍分别抛出 `NOT_FOUND` / `IO_ERROR`；只要输入 bytes 已可读取，其余容器、格式、metadata、图和正文诊断错误都进入 `VerifyReport.issues`，不再以首个诊断错误 reject Promise；
- 在容器仍可安全遍历时，尽量聚合互不依赖的问题；遇到无法建立安全 entry 边界、资源上限超限等阻断错误时立即停止该分支，绝不为了“多报几个问题”绕过安全限制；
- 普通 open/read 继续 fail-fast，诊断 API 不改变已有成功路径或 `MdvError` 契约；
- verify 是纯只读操作，不提供自动修复，也不接受“忽略哈希”等降低完整性的开关。

最终实现的 `maxIssues` 默认值为 100。metadata 阶段复用现有 Reader 的安全 fail-fast 边界；无法建立可信索引时返回阻断 issue 和 `complete: false`。成功建立索引后，图校验聚合关系问题，full 阶段通过一次 ZIP 扫描检查所有历史正文并聚合独立 UTF-8、长度与哈希问题。

#### 实际代码落点

M5 最终只增加以下职责，没有重排现有稳定模块：

```text
src/
├── core/
│   ├── status.ts       # dirty 与 ReferenceRelation 纯计算
│   └── diff.ts         # 有上限的源码逐行 Diff
├── archive/
│   └── verify.ts       # 面向可疑归档的诊断扫描
├── mdv-document.ts     # DocumentSnapshot facade 装配
├── types.ts            # ContentSpec、status、Diff、verification public types
└── index.ts            # 唯一 package-root export

test/
├── status.test.mjs
├── diff.test.mjs
├── verify.test.mjs
└── m5-api.test.mjs
```

具体文件可以在实现审计时合并，但职责边界不变：纯状态与 Diff 规则属于 Core；不可信 ZIP 的尽力诊断属于 Archive；调用方只从 package root 使用。

验收条件：

- 两棵树分别覆盖有 HEAD/无 HEAD、空/非空、bytes 相同/不同的 dirty 组合；status 不修改 generation 或任何文件；
- `getStatus()` 保持异步且返回冻结结果；`no-document-head`、`unbound`、`aligned`、`drifted` 四个关系分支均有 package-root 黑盒测试，`null` bind 不被误报为 drift；
- 任意合法 working-copy/version 同树或跨树组合都能通过 `ContentSpec` 读取和 Diff；missing/wrong-tree Version 有稳定错误；
- Diff 覆盖空文本、中文、CRLF/LF、末尾换行、长行和二进制式非法 UTF-8，结构化 hunks 与 unified text 对同一变化保持一致；
- Diff 输入 bytes、总行数、edit length、hunk 和输出上限都有边界测试，超限不返回部分结果；
- `verifyMdv(source, { mode: 'metadata' })` 能报告结构/关系错误；`verifyMdv(source, { mode: 'full' })` 能发现一个从未被普通读取触发过的旧分支正文长度或哈希损坏；
- verify issue 顺序和路径稳定，同一输入多次执行产生等价报告；`mode`、`valid` 和 `complete` 的组合有明确测试，`maxIssues` 达限返回不完整报告，诊断过程不会修改源文件；
- 不存在或不可读 path 分别抛出 `NOT_FOUND` / `IO_ERROR`；已经读到 bytes 的坏 ZIP、坏 metadata、坏图和坏正文进入 report 而不是抛出首个诊断错误；
- 外部 tarball consumer 只从 package root 完成 `open -> status -> readContent -> diff`，并可对无法 open 的包直接调用 `verifyMdv`。

M5 完成只表示 Agent/自动化所需的通用审阅与诊断原语已经齐备；它不是人类 Review UI，也不是 Reference/Document 左右对照成立的前置条件。图片粘贴所需的受管资源和正式发布质量分别由 M5.5、M6 完成。

### M5.5：受管图片 hash sidecar

状态：**完成**

目标：落实已经冻结的外部内容寻址资源约定，让 VS Code、MarkText 等宿主无需各自复制图片存储规则。资源仍是普通 Markdown 相对路径，不进入 `.mdv` ZIP、不增加 manifest generation，也不纳入 Markdown Version 的正文哈希。

实际交付：

- 提供路径绑定 `MdvDocument.importManagedResource()`：接收原始 bytes 与可选 MIME 断言，从文件头识别 PNG/JPEG/GIF/WebP，使用 png/jpg/gif/webp 规范扩展名，计算小写十六进制 SHA-256；
- 将资源原子创建或安全复用到 `.mdv-assets/<documentId>/<sha256>.<extension>`，返回可直接插入 Markdown 的 `./.mdv-assets/...` 相对路径；
- 冻结每次 import/read/verify 默认 32 MiB 的独立 `ResourceOptions.maxBytes`；文件头识别不承诺完整解码或像素安全，SVG/AVIF 仍可作为普通 Markdown 链接；
- 同 hash 同扩展名且 bytes 一致时幂等复用；已存在路径内容不一致时报告完整性错误，绝不覆盖；
- 提供 `resolveManagedResource`、`readManagedResource`、`verifyManagedResource`；只接受当前 documentId 下符合 grammar 的内容寻址路径，普通 Markdown 链接仍可自由命名、跨目录和使用绝对路径，由宿主按 `baseDirectory` 处理；
- 读取和复用时重新计算 hash，拒绝被替换、截断、symlink 绕过或超出资源大小上限的 sidecar；
- 并发 import 使用私有临时文件、回读校验、fsync 与 hard-link 不覆盖发布；目标已存在必须重新验证且 bytes 完全一致；发布后失败报告 `committed: true`，清理失败报告 `cleanupFailures`；
- `parseMdv(bytes)` 的普通 `DocumentSnapshot` 没有资源方法；显式可信 `baseDirectory` 返回 `LocatedDocumentSnapshot`，只提供 resolve/read/verify。`MdvDocument` 扩展它并增加 import；
- Core 不监听 paste/drop、不修改 Markdown、不扫描历史引用、不下载网络 URL、不渲染图片，0.1 也不自动垃圾回收孤立资源。

资源文件和 `.mdv` ZIP 无法组成一个跨文件原子事务。宿主 paste 流程应先 import sidecar，再把返回路径插入 buffer 并调用 save；后续 save 失败最多留下可安全复用的孤立 hash 文件，不会产生正文引用一个半写资源的状态。

验收条件：

- 相同 bytes 重复或并发导入得到同一相对路径，目标内容 byte-for-byte 一致；
- 不同 bytes 不会覆盖已有 hash path，伪造 hash、错误扩展名、路径穿越、绝对路径、symlink 与超限资源均被拒绝；
- resolve/read 只在当前 documentId 的受管目录内工作：resolve 返回经过路径/存在性检查的本地绝对路径，不计算 hash；read/verify 在同一打开句柄上限量读取并校验 hash，返回内容前完成校验；
- sidecar import/read/verify 不修改 `.mdv` bytes、generation、HEAD 或版本历史；
- 移动 `.mdv` 但遗漏 `.mdv-assets` 时得到明确 NOT_FOUND/diagnostic，而不是影响 Markdown 自身的读取和校验；
- package-root 黑盒测试覆盖 `import -> Markdown save -> commit -> checkout old version -> resolve/read same hash resource`；
- 宿主只负责 paste/drop 和插入 Core 返回的相对路径，不需要知道 sidecar 目录拼接或哈希算法。

验证结果：`npm test` 在 macOS / Node.js 26.3.0 下通过 147 项（比 M5 增加 30 项），`npm run typecheck` 通过。覆盖四种媒体、路径与大小边界、并发幂等、真实双进程导入、读取中替换/增长、symlink、损坏目标不覆盖、发布前后故障、清理失败、旧 generation 与 save CAS、移动包和历史 bind/图片回读。

实现不修改 Format 0.1、Schema、Archive writer/transaction、版本规则或 runtime dependencies；新增 `src/resource/model.ts` 与 `store.ts`，通过现有 facade 编排。路径检查只提供操作时刻的本地安全边界，不承诺抵抗同权限恶意进程持续替换目录；跨平台 CI 与 crash durability 继续由 M6 收口。

### M6：一致性、性能与发布收口

状态：**进行中：工程检查已实现，本地与远端矩阵验收通过；发布身份与正式发布待收口**

目标：把已经完成版本语义、Agent-friendly 检查与受管资源闭环的参考实现，收口为其他项目可以稳定安装、持续验证和安全升级的 Core 0.1 包。M6 原则上不再增加新的主要业务语义。

本轮实际交付（2026-09-08）：

1. **M6.1 安装与 CI**：`test:package` 从不含 dist 的源码副本运行 prepare/build，真实打包、独立安装仅运行依赖，然后执行 runtime 闭环及 TypeScript 5.9.3 / 仓库 7.x consumer。唯一 ESM root 和负向类型边界均检查；三系统 × Node 22/24/26，加 Linux Node 20 的远端 CI 共 10 组已通过。
2. **M6.2 一致性与安全**：fixtures 从 10 增至 15，生成器去除系统 zip 依赖并提供只读字节一致性检查；加入全部 fixture 的路径/bytes conformance、恶意 ZIP/严格 JSON/预算、LF/CRLF/CR 复杂 Markdown 端到端、有界 seeded fuzz。跨平台测试区分 POSIX mode、Windows junction 与有权限要求的文件 symlink，继续使用现有跨进程与故障注入测试。
3. **M6.3 性能**：10/100/1000 版本 × 2/64 KiB 场景，独立进程测 open、最旧历史正文、trace、full verify、save、commit 和峰值 RSS；三轮样本与本机基线已入库。最大场景约 63.3 MiB，save/commit 中位数约 0.65 秒；不把默认上限当作性能保证，也不提前改增量容器。
4. **M6.4 兼容与发布**：公开能力/错误码/默认预算由测试与文档共同约束；新增开发态检查、严格 release gate 和 prepublishOnly。开发版本、UNLICENSED、缺失 LICENSE 会明确阻止发布检查通过，最终授权和 scope 权限仍归 owner。

本地证据：macOS / Node 26.3.0 下 `npm run check` 共 183 项，182 通过，1 项 Windows 专用路径测试按平台跳过；`test:package` 运行与双编译器检查通过；额外 seed=1 的 10,000 输入 fuzz 通过；两种时区的 fixture 字节一致性通过；完整六场景 benchmark 通过。严格 release gate 按预期非零退出，临时合成数据覆盖 gate 放行/拒绝与 lock/registry 检查。初始工程提交 `a05b4d0` 未修改生产代码；后续 `52f1d33` 只在 Reader 的同一 descriptor 上补普通文件检查，并修正两项测试的平台假设。公开 API、Format 0.1、Schema、runtime dependencies 与生产分层均未改变。

远端证据：2026-09-08，[`52f1d33` 的矩阵](https://github.com/owariband/mdv/actions/runs/34193879318) 10/10 成功，所有 job 的安装、完整检查与 tarball consumer 均通过，Linux Node 24 benchmark smoke 通过。Windows 三组各 179 通过、0 失败、4 项既有平台限定 skip；首次失败与具体修复见[开发日志](./dev_log.md)。

调用方入口：[兼容性](../compatibility.md)、[性能](../performance.md)、[验证/发布检查](../releasing.md)。这些技术结果不等于正式发布完成；跨平台测试不是真实断电实验，不扩大平台持久性承诺。

实现范围：

- 扩充 [`architecture.md`](./architecture.md) 第 14 节要求的合法/非法 fixture 矩阵；
- 增加 Zip Slip、重复路径、NFC/大小写冲突、资源上限和损坏正文测试；
- 增加有输入/解压/内存和时间预算的 Archive/JSON fuzz 回归，检查结果分类与异常退出；有限随机集不等于任意输入安全的形式化证明；
- 增加复杂 Markdown round-trip：CRLF、中文、front matter、代码块、表格、数学公式和 Mermaid；
- 增加 `create -> save -> commit -> reopen -> status -> trace -> diff -> verify` 端到端测试；
- 将 M5.5 已有的 `import asset -> save Markdown path -> commit -> checkout -> resolve/read/verify asset` 端到端测试纳入支持平台 CI，继续扩充故障矩阵；
- 对真实历史规模做打开、按需读、整包重写的基准测试；
- 随 API 演进维护现有 README、快速开始和 API 参考，并补齐最终发布示例；
- 维护已经建立的 npm tarball/Git dependency `prepare` 构建生命周期；
- 把已经通过的临时目录 tarball consumer smoke 固化进 CI matrix，持续验证 runtime import、类型声明和依赖完整；
- 决定最终 npm 包名、scope 发布权限、License 和 0.1 版本策略；
- 建立 CI，在支持的 Node.js 版本上执行 lint/typecheck、build、test 和 package smoke test；
- 审计并冻结 package-root public API、错误码、资源限制默认值和诊断 issue code，补齐 0.1 升级/兼容策略；
- 明确 POSIX 与 Windows 支持矩阵；Windows 目录 durability 若仍弱于 POSIX，必须有 CI 证据和公开限制，不以模糊的“跨平台”承诺代替。

验收条件：

- 新环境不依赖仓库中被忽略的本地 `dist/` 也能安装使用；
- 调用方只需 `import ... from '@mdv/core'`，不需要了解源码目录；
- public API、错误码和 Format 0.1 fixtures 有明确兼容承诺；
- M5 status/diff/verify 与 M5.5 sidecar 在受支持平台上通过 package-root 端到端和 tarball consumer 测试；
- CI 覆盖声明支持的 Node.js/操作系统矩阵，发布产物包含可用 ESM、类型声明、README、LICENSE 与必要 Schema/fixture 契约；
- 性能测试证明当前整包重写方案满足 0.1 目标，或用数据推动下一格式版本，而不是提前引入增量容器。

M6 完成后，可以称 `@mdv/core 0.1` 为本轮设计范围内的完整形态：普通 Markdown 双工作副本、两棵可追踪版本树、精确 bind、Agent-friendly 检查与诊断、外部图片 sidecar 都有稳定 package-root 能力。它不表示未来不再演进，也不把 VS Code extension、MarkText adapter、独立 CLI、浏览器后端或资源内嵌纳入 Core。

## 5. 上游接入阶段

### U1：VS Code extension

状态：**等待 Core 0.1 闭环**

VS Code extension 是计划中的第一个图形客户端，但作为独立上游项目，不进入 `@mdv/core`。M5.5 已完成，当前优先完成 M6，不在 Core 发布承诺尚未闭环时并行维护客户端兼容层。

未来接入遵守三个边界：

1. extension 只依赖 `@mdv/core` package root，不读取或修改 ZIP entry；
2. extension 根据 Document Version 的精确 bind 分别读取 Reference/Document，并通过虚拟 Markdown 文档实现左右对照；两者共享 `.mdv` 所在目录作为资源基准；
3. 左右布局、同步滚动、高亮与 Markdown 渲染属于 extension；保存、commit、checkout、资源导入和冲突处理调用 Core。extension 可以按需消费 Core status/Diff，也可以使用编辑器原生 Diff，但不能复制 bind、hash 或版本规则。

### U2：MarkText adapter

状态：**等待 VS Code 首个客户端验证**

MarkText adapter 位于 `../markText`，不进入 `@mdv/core`。Muya State 不进入 Core public model；adapter 只负责 Markdown string 与编辑器状态之间的转换，并单独测试 `Markdown -> Muya -> Markdown`。

### U3：独立 CLI / Agent tool

状态：**等待 Core 0.1 闭环**

CLI 是完全独立的上游业务项目：

- 只依赖 `@mdv/core` package root；
- 将 argv、stdin、stdout、JSON envelope 和退出码映射到 Core public API；
- 为 Agent Runtime 提供 create/open/status/read/save/commit/checkout/trace/diff/verify 等工具动作；
- 遵守 `expectedGeneration` 和稳定错误码；
- 不直接解包修改 entry，也不复制 Core 的版本规则；
- 不要求 Core 启动服务或常驻进程。

CLI 的具体命令设计不阻塞 Core，也不在本仓库提前冻结。

## 6. 下一批开发任务

M6 的工程交付与跨平台 CI 验收已完成；首次 Windows 失败已修复并在 `52f1d33` 的 10 组矩阵中通过，证据及 skip 原因已记录。仍不同时启动 VS Code、MarkText 或 CLI，剩余验收按顺序执行：

1. 结合目标宿主确认可接受的保存频率与历史规模；已有本机基线，不宣称验证了 10,000 Version / 512 MiB 上限或断电持久性。
2. owner 确认 npm scope、发布权限、License 和版本策略；补 LICENSE 和 package/lock 身份，然后运行严格 release gate、最终 tarball 检查并确认待发布提交的 CI，再执行正式发布流程。
3. 记录真实提交和发布版本，再将 M6 标记完成、进入独立 VS Code 客户端阶段。

资源 sidecar 与 `.mdv` 整包替换继续保持独立事务；M6 不改变“先导入可复用 hash 资源，再 save Markdown 引用”的顺序，也不新增增量容器或存储框架。

## 7. Core 0.1 完成口径

M5 与 M5.5 已关闭 Agent-friendly 检查和产品资源能力；剩余 M6 关闭稳定发布问题：

- **M5 完成**：Agent-friendly 检查能力闭环。Agent/CLI 能读取结构化状态、识别 bind 关系、比较任意 Markdown 来源并诊断完整性；基础的人类读写和 bind 左右对照并不依赖 M5，但图片受管写入和发布承诺还未完成；
- **M5.5 完成**：本轮产品能力闭环。Core 能安全导入、解析、读取和验证图片 hash sidecar，但仍是待硬化的预发布实现；
- **M6 完成**：Core 0.1 稳定发布闭环。受支持平台、性能边界、错误/诊断码、package 产物和兼容策略都有自动化证据，此时才称本轮 `@mdv/core` 为完整形态。

U1/U2/U3 不属于 Core 完成口径。M6 完成后它们可以只依赖 package root 开发，不需要等待 Core 仓库再增加 VS Code、Muya、CLI 或 Agent Runtime 类型。

## 8. 暂不进入 0.1 的工作

以下内容不应混入上述阶段：

- Markdown AST、HTML 渲染或 Muya model 兼容层；
- 通用 Repository、插件式 storage 和浏览器后端；
- Named Ref、tag、branch name、merge commit、rebase、stage；
- 把附件/资源打进 ZIP、纳入 Version 哈希或自动垃圾回收；
- 内容分块、去重和增量容器；
- 语义 Diff、自动判断“要求是否落实”；
- 数字签名和作者真实性证明；
- CLI、Electron 或 Agent Runtime 专属 DTO。

这些能力只有在 0.1 闭环完成并出现真实需求或性能数据后，才单独进入后续格式或上游项目设计。

## 9. 进度维护规则

每完成一个阶段，更新本文时必须同时记录：

- 状态从“下一步/未开始”变为“完成”；
- 实际交付的 public API 或内部能力；
- 对应测试和最后一次验证命令；
- 与原计划不同的边界调整及其原因；
- 下一阶段是否仍具备前置条件。

只有文档、类型草案或内部函数存在时，不把能力标记为完成。如果任何宿主或 CLI 只能绕过 package export 调到内部模块，也不算 Core 可用；必须先修正 public API 边界。
