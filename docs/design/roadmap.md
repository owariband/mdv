# MDV Core 开发进度与路线图

> 最后更新：2026-09-07
>
> 当前里程碑：M2「公开只读 API」已完成，下一步进入 M3「创建、保存与文件事务」
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
- **下一步**：当前最高优先级，前置条件已经满足；
- **未开始**：可以有设计稿或类型草案，但还没有形成可用实现；
- **上游等待**：不属于本仓库，等待所依赖的 Core 能力稳定后再接入。

内部函数存在不等于公开能力完成。例如 `archive/reader.ts` 能读取包，但在调用方还不能从 `@mdv/core` 包根导入 `openMdv` 时，仍不能把它记作“外部已经可以使用”。

## 2. 当前进度总览

| 里程碑 | 状态 | 已有结果 | 主要缺口 |
| --- | --- | --- | --- |
| M0 格式与工程基线 | 完成 | Format 0.1、Schema、基础 fixtures、单包工程 | 后续仍需扩充一致性 fixtures |
| M1 内部只读基础 | 完成 | ZIP Reader、严格 JSON/UTF-8、hydrate、版本图校验和基础索引查询 | 后续在 M6 扩充安全与 fuzz 矩阵 |
| M2 公开只读 API | 完成 | package root 的 open/parse、只读 facade、查询、trace、bytes/text 和稳定错误映射 | 写能力留在 M3，状态与完整性能力留在 M5 |
| M3 创建、保存与文件事务 | 未开始 | 事务语义已有设计 | ZIP Writer、锁、CAS、临时包校验和原子替换尚未实现 |
| M4 Commit 与 Checkout | 未开始 | commit/bind/branch 规则已有设计 | Core commands 和持久化 mutation 尚未实现 |
| M5 Review 与完整性能力 | 未开始 | Diff、drift、verify、export 契约已有设计 | 实现与覆盖测试尚未开始 |
| M6 稳定发布 | 未开始 | 当前包可本地 build，调用方文档已建立 | 安装产物、完整 fixtures、CI、发布与兼容性验证未完成 |
| U1 VS Code extension | 上游等待 | 已确定为第一个落地客户端，使用 Core 返回的 Markdown 与资源基准 | 按当前策略等待 Core 0.1 闭环完成后启动 |
| U2 MarkText adapter | 上游等待 | MarkText/Muya 可以消费 Markdown string | 排在 VS Code 首个客户端之后 |
| U3 独立 CLI / Agent tool | 上游等待 | 边界已确定为 Core 上游 | 等待 public write API 稳定 |

核心开发依赖顺序为：

```text
M0 格式基线
  -> M1 内部 Reader 与版本图
  -> M2 公开只读 API
  -> M3 create/save 与原子事务
  -> M4 commit/checkout
  -> M5 diff/drift/verify/export
  -> M6 发布与兼容性收口

M2 完成 -> 上游已可只读打开，但暂不启动客户端开发
M3 完成 -> Core 具备工作副本保存
M4/M5 完成 -> Core 具备版本、Review 与 trace 闭环
Core 0.1 闭环完成 -> 启动独立 VS Code extension，MarkText adapter 后续接入
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
- `verify`、`exportMarkdown`、Diff；
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
- `DocumentStatus`、dirty、drift、`verify`、Diff 和 `export` 仍按计划留在 M5；未定义清楚的 `readVersion()` 不提前发布，由明确的 `readVersionBytes/Text()` 覆盖 M2 需求；
- 修正路径不存在、普通 ZIP、损坏 ZIP、畸形 manifest 与未知格式版本的错误分类，并补上规范要求的 BOM 拒绝。
- 新增 `bound-history`、`content-hash-mismatch`、`markdown-bom`、`unsupported-version` 和 `malformed-version` fixtures，并让 fixture 构建时间戳可重复。

截至 2026-09-07，`npm test` 共 22 个测试全部通过。新增的 package-root 黑盒测试覆盖 `open -> read -> query -> trace`，并验证返回数组冻结、正文 bytes 不会反向污染快照、历史正文继续按需验哈希。

### M3：创建、保存与原子文件事务

状态：**未开始**

目标：形成第一个安全写入闭环。普通保存只修改工作副本，不创建历史版本。

实现范围分为三块。

Archive Writer：

- 编码 manifest、HEAD 和 version meta；
- 生成符合 Format 0.1 的 ZIP32 单文件；
- 保留被重写 JSON 对象中的未知字段和值；
- 复制未变化的历史条目，不修改任何已有 version 内容；
- 提供有限的 package mutation，不允许上层任意编辑 ZIP entry。

本地文件事务：

- 获取目标 `.mdv` 对应的跨进程独占锁；
- 在锁内重新打开磁盘上的最新包；
- 比较 `expectedGeneration`，不一致返回 `CONFLICT`；
- 在目标同目录写唯一临时包；
- 使用现有 Reader 对临时包重新执行结构和新增正文完整性校验；
- fsync 临时文件，原子替换目标文件，并同步必要的目录元数据；
- 所有失败路径保留原文件可读，并清理本次创建的临时文件和锁。

Public API：

- 实现 `createMdv(path)`；
- 实现 `saveReference({ markdown, expectedGeneration })`；
- 实现 `saveDocument({ markdown, expectedGeneration })`；
- 两种 save 成功后 generation 精确增加 1，并返回新的只读 snapshot；
- 目标已存在时 `createMdv` 失败，不默认覆盖。

验收条件：

- `create -> reopen` 得到 generation 0、两个空工作副本、零版本、零 Head；
- Reference 可以永远为空，Document 仍可独立保存；
- 连续多次 save 后版本数量仍为零；
- Markdown 字节，包括 CRLF、中文和末尾换行，写入再读取后 byte-for-byte 一致；
- 两个 writer 使用同一 generation 时最多一个成功，另一个稳定返回 `CONFLICT`；
- 在写 ZIP、临时包校验、fsync、replace 等阶段注入失败后，原包仍可正常打开；
- 任意宿主 adapter 都通过 `saveDocument` 保存工作副本，而不是把 Markdown 文本直接覆盖到 `.mdv` ZIP 上。

这是 0.1 实现中风险最高的阶段。锁、CAS、临时文件、校验和 replace 必须作为一个事务闭环实现，不能先提供一个会直接覆盖原包的“简化 Writer”。

### M4：Commit 与 Checkout

状态：**未开始**

目标：完成“保存不产生版本，显式 commit 才固化版本”的核心语义。

实现范围：

- 增加 Core command 层，在事务锁内基于最新 state 计算 mutation；
- 使用密码学安全随机源生成不透明 Version ID；
- `commitReference` 保存完整正文快照，以当前 Reference HEAD 为 parent；
- `commitDocument` 保存完整正文快照，以当前 Document HEAD 为 parent；
- `commitDocument.referenceVersion` 必须显式为一个已存在的 Reference Version 或 `null`；
- commit 写入 actor、summary、RFC 3339 时间、SHA-256 和 content bytes；
- 内容和 bind 都未变化时返回 `created: false, reason: 'no-changes'`；
- Document 正文未变化但 bind 改变时仍创建新版本；
- checkout 只恢复目标版本正文并移动对应 HEAD，不创建版本；
- 从旧版本 checkout 后再次 commit 形成可追踪分叉，旧版本保持不可变。

验收条件：

- 在零个 Reference Version 的包中，`referenceVersion: null` 可以连续创建 Document 历史；
- `R1 -> R2` 与 `D1(bind R1) -> D2(bind R2)` 重新打开后关系不变；
- Reference 侧不存反向 bind，反向关系可完全从 Document meta 重建；
- 查看旧版本不会改变工作副本或 HEAD；
- checkout 后 commit 可以形成分叉，`getChildren` 返回稳定顺序；
- 已有 version 的 meta 和 content 永远不被原地修改；
- commit/checkout 同样遵守 M3 的 generation CAS 和原子事务。

### M5：Review、状态与完整性能力

状态：**未开始**

目标：补齐版本查看、Review、漂移判断和完整性诊断，使 Core 达到“可读、可写、可追踪、可 Review”的 0.1 闭环。

实现范围：

- 计算 Reference/Document working copy dirty 状态；
- 区分 unbound 与 Reference drift，不把 `referenceVersion: null` 当作错误或漂移；
- 实现受资源上限约束的 Markdown 源文本逐行 Diff；
- Diff 同时返回结构化 hunks 与 unified text；
- 实现 `verify({ mode: 'metadata' | 'full' })`；
- metadata 模式验证结构和关系，full 模式遍历并校验全部历史正文；
- `verify` 尽量聚合相互独立的问题，普通读取仍在阻断错误处立即失败；
- 实现当前工作副本和指定历史版本的 `exportMarkdown`；
- 补齐查询过滤、结果排序和大小上限。

验收条件：

- 工作副本与 HEAD 内容相同/不同的 dirty 判断正确；
- 已绑定旧 Reference 的 Document HEAD 在 Reference HEAD 前进后报告 drift；
- unbound Document 明确返回 unbound，不报告虚假 drift；
- 任意合法工作副本/版本组合都能按 API 契约 Diff；
- `verify(full)` 可以发现非首次访问版本中的长度或哈希损坏；
- export 返回原始 Markdown bytes，不增加注释、front matter 或格式化变化。

### M6：一致性、性能与发布收口

状态：**未开始**

目标：把能运行的参考实现收口为其他项目可以稳定安装和升级的包。

实现范围：

- 扩充 [`architecture.md`](./architecture.md) 第 14 节要求的合法/非法 fixture 矩阵；
- 增加 Zip Slip、重复路径、NFC/大小写冲突、资源上限和损坏正文测试；
- 增加 Archive/JSON fuzz 测试，保证任意输入不导致进程崩溃或无界资源使用；
- 增加复杂 Markdown round-trip：CRLF、中文、front matter、代码块、表格、数学公式和 Mermaid；
- 增加 `create -> save -> commit -> reopen -> trace -> verify -> export` 端到端测试；
- 对真实历史规模做打开、按需读、整包重写的基准测试；
- 随 API 演进维护现有 README、快速开始和 API 参考，并补齐最终发布示例；
- 增加适合 npm tarball 与 Git dependency 的构建生命周期；
- 在临时目录安装打包产物，验证 runtime import、类型声明和依赖完整；
- 决定最终 npm 包名、scope 发布权限、License 和 0.1 版本策略；
- 建立 CI，在支持的 Node.js 版本上执行 build、test 和 package smoke test。

验收条件：

- 新环境不依赖仓库中被忽略的本地 `dist/` 也能安装使用；
- 调用方只需 `import ... from '@mdv/core'`，不需要了解源码目录；
- public API、错误码和 Format 0.1 fixtures 有明确兼容承诺；
- 性能测试证明当前整包重写方案满足 0.1 目标，或用数据推动下一格式版本，而不是提前引入增量容器。

## 5. 上游接入阶段

### U1：VS Code extension

状态：**等待 Core 0.1 闭环**

VS Code extension 是计划中的第一个图形客户端，但作为独立上游项目，不进入 `@mdv/core`。当前优先完成 M3 至 M6，不在 Core 尚未闭环时并行维护客户端兼容层。

未来接入遵守三个边界：

1. extension 只依赖 `@mdv/core` package root，不读取或修改 ZIP entry；
2. 当前 Reference/Document 通过虚拟 Markdown 文档接入原生编辑器，两者共享 `.mdv` 所在目录作为资源基准；
3. 保存、commit、checkout、资源导入和冲突处理全部调用 Core，不在 extension 复制规则。

### U2：MarkText adapter

状态：**等待 VS Code 首个客户端验证**

MarkText adapter 位于 `../markText`，不进入 `@mdv/core`。Muya State 不进入 Core public model；adapter 只负责 Markdown string 与编辑器状态之间的转换，并单独测试 `Markdown -> Muya -> Markdown`。

### U3：独立 CLI / Agent tool

状态：**等待 M3/M4**

CLI 是完全独立的上游业务项目：

- 只依赖 `@mdv/core` package root；
- 将 argv、stdin、stdout、JSON envelope 和退出码映射到 Core public API；
- 为 Agent Runtime 提供 create/open/status/read/save/commit/checkout/trace/diff/verify 等工具动作；
- 遵守 `expectedGeneration` 和稳定错误码；
- 不直接解包修改 entry，也不复制 Core 的版本规则；
- 不要求 Core 启动服务或常驻进程。

CLI 的具体命令设计不阻塞 Core，也不在本仓库提前冻结。

## 6. 下一批开发任务

下一批只做 M3，不同时启动 VS Code、MarkText 或 CLI：

1. 定义最小 package mutation，禁止 public 层任意编辑 ZIP entry；
2. 实现确定性 ZIP Writer，保留未知 JSON 字段并复制未变化历史；
3. 实现 `createMdv(path)`，目标存在时拒绝覆盖；
4. 实现跨进程锁、generation CAS、同目录临时包、完整校验、fsync 和原子替换；
5. 实现 `saveReference`、`saveDocument`，保存只更新工作副本并递增 generation，不创建版本；
6. 增加失败注入、并发冲突、byte-for-byte round-trip 和 package-root 写 API 测试；
7. M3 主事务闭环稳定后，再加入 Core 管理的内容寻址外部资源读写；
8. 继续只发布一个 `@mdv/core`，不增加 Repository、Provider、Factory 或第二存储后端。

## 7. 暂不进入 0.1 的工作

以下内容不应混入上述阶段：

- Markdown AST、HTML 渲染或 Muya model 兼容层；
- 通用 Repository、插件式 storage 和浏览器后端；
- Named Ref、tag、branch name、merge commit、rebase、stage；
- 附件打包和版本化；
- 内容分块、去重和增量容器；
- 语义 Diff、自动判断“要求是否落实”；
- 数字签名和作者真实性证明；
- CLI、Electron 或 Agent Runtime 专属 DTO。

这些能力只有在 0.1 闭环完成并出现真实需求或性能数据后，才单独进入后续格式或上游项目设计。

## 8. 进度维护规则

每完成一个阶段，更新本文时必须同时记录：

- 状态从“下一步/未开始”变为“完成”；
- 实际交付的 public API 或内部能力；
- 对应测试和最后一次验证命令；
- 与原计划不同的边界调整及其原因；
- 下一阶段是否仍具备前置条件。

只有文档、类型草案或内部函数存在时，不把能力标记为完成。如果任何宿主或 CLI 只能绕过 package export 调到内部模块，也不算 Core 可用；必须先修正 public API 边界。
