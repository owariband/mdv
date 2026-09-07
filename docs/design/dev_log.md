# MDV 开发提交日志

> 最后更新：2026-09-08
>
> 本页是 Git commit message 的详细版本，按最新提交在前排列。它补充已经推送但正文过于简略的历史提交，不改写 Git 历史。

## 定位与维护方式

- 每一条记录对应一个已经落地的 commit 或独立交付批次，记录代码实际完成了什么、如何验证，以及当时明确没有完成什么。
- Git 中继续使用 Conventional Commit 风格的简短标题；标题后保留一个空行，再用逐项 bullet 写正文，并把同样的信息同步到本页。
- 本页不是格式或 API 的规范来源。容器格式以 [`spec/format-0.1.md`](../../spec/format-0.1.md) 为准，公开接口以 [`src/index.ts`](../../src/index.ts) 和测试为准，当前进度以 [`roadmap.md`](./roadmap.md) 为准。
- 未来提交在本页顶部追加；已经发布的历史记录只补充事实，不为了美化叙述而改写代码边界或验收结果。

## 待提交 — `feat: complete M5 agent-friendly review primitives`

- 日期：2026-09-08
- 里程碑：M5 Agent-friendly 审阅与诊断能力
- 状态：实现与验收已完成，等待用户确认后创建并推送 commit；提交后将本节替换为真实短 SHA / 完整 SHA，不改写既有历史。

### 详细提交说明

- 从 package root 在 `DocumentSnapshot` 上提供异步 `getStatus()`、统一 `readContent(ContentSpec)` 和通用 `diff(from, to, options)`，并增加无需先成功 open 的顶层 `verifyMdv(path | bytes, options)`；所有相关 readonly 类型均由唯一 package root 导出。
- status 分别返回 Reference/Document 的 `{ head, dirty }`，使用工作副本原始 `byteLength + SHA-256` 与 Head metadata 比较，不读取历史 Head 正文、不创建 Draft Version，也不改变 generation 或文件。
- 将 M4 checkout 的既有 dirty 判断机械补齐为同样的 `byteLength + SHA-256` 双条件；这只修正 metadata 长度异常但哈希相同的防御性边界，不改变 checkout API、事务、正常文档行为或错误码。
- 当前 Document Head 与 Reference Head 使用 `no-document-head | unbound | aligned | drifted` 四态联合表达；`drifted.currentReference` 允许为 `null`，且状态只报告事实，不自动更新 bind。
- `ContentSpec` 明确选择树、工作副本或历史 Version；tree 与 Version 不匹配时稳定返回 `NOT_FOUND` 与 `reason: wrong-tree`。旧的 `readReference*`、`readDocument*` 和 `readVersion*` 作为便利 API 保持不变。
- Diff 两侧使用同一种 `ContentSpec`，因此 Document ↔ Document、Reference ↔ Reference、跨树和 working-copy ↔ version 都成立；实现比较 Markdown 源文本行，不包含 AST、渲染、语义 Review 或 patch/apply。
- 新增无第三方依赖的 bounded Myers：保留 CRLF、LF、CR、空白、Unicode 表达和 EOF newline，返回冻结的结构化 hunks 与 deterministic unified text，并为无末尾换行输出标准 marker。
- 固定 Diff 默认边界：3 行上下文、8 MiB 合计输入、200,000 合计行、2,048 最大编辑距离、10,000 个 hunk 和 16 MiB unified text；任何输入、行数、算法、hunk 或输出超限都整体返回 `LIMIT_EXCEEDED`，不泄露部分结果。
- `verifyMdv` 默认使用 metadata 模式检查 ZIP 安全边界、manifest、两份工作副本、Head、版本 metadata 与 parent/bind 图；full 模式在此基础上用一次 ZIP 扫描检查所有历史正文，包括当前 Head 不可达的分支，并聚合独立 UTF-8、长度与 SHA-256 问题。
- 诊断默认最多 100 个 issue；`complete` 明确区分完整扫描与结构阻断、资源限制或 issue budget 截断，`valid` 只在完整且零 issue 时为 true。不存在/不可读路径继续抛 `NOT_FOUND`/`IO_ERROR`，已经读到的坏归档进入冻结报告。
- 路径版 full verify 在 metadata 阶段保留首次打开的 ZIP 文件描述符，并让历史正文校验复用同一份扫描快照；即使 pathname 在两阶段之间被另一个进程原子替换，也不会把旧 metadata 与新正文混合成伪完整性错误。
- Reader 的普通版本读取与 full verify 共用同一个正文 inspector；没有复制 ZIP 安全规则。普通 open/read 继续 fail-fast，诊断入口不获取 writer lock、不自动修复，也不提供忽略哈希开关。
- 新增 Reference 历史存在但 Reference Head 为 `null` 的合法 fixture，从 package root 固定 `drifted.currentReference = null`；补齐 status、Diff、verify 和 M5 facade 专项测试。
- 同步根 README、快速开始、API 参考、核心概念与维护者设计文档，将 M5 标记为完成，并把下一阶段更新为 M5.5 受管图片 sidecar。

### 验证与边界

- 当前完整测试在 Node.js 26.3.0 通过，共 117 项；独立 `npm run typecheck` 同样通过。新增的确定性并发回归会在 metadata 读取后原子替换 pathname，确认 full verify 仍校验首次打开的文件快照。
- Diff 专项包含 56,000 个随机小序列与 LCS 基准对照，最短编辑数以及 old/new 双侧重建均通过。
- 实际 `npm pack` 后在仓库外临时项目安装 tarball，仅从 `@mdv/core` package root 完成 create/save/commit/status/readContent/Document-to-Document diff/full verify；外部 TypeScript NodeNext consumer 的类型检查通过。
- M5 没有修改 Format 0.1、Schema、commit/checkout 语义、Writer、mutation、transaction 或 runtime dependencies。
- 本阶段仍不包含受管图片 sidecar、Markdown parser/renderer、人类 Review UI、CLI/Agent 专属 DTO、CI matrix、正式许可证或 npm 稳定发布；这些边界分别属于 M5.5、上游项目或 M6。

## `6a2b616` — `feat: complete M4 commit and checkout workflows`

- 完整 SHA：`6a2b616b84e369cc7e2fa3df6da1f8f457cfe5e2`
- 日期：2026-09-07
- 里程碑：M4 Commit 与 Checkout

### 详细提交说明

- 从 package root 的 `MdvDocument` facade 提供 `commitReference`、`commitDocument`、`checkoutReference` 和 `checkoutDocument`，并导出对应的 input、result 与 Version ID 类型。
- 冻结普通 Markdown 编辑底座：`current.md` 是可反复覆盖保存的工作副本，编辑器内存 buffer 归宿主管理，只有显式 commit 才创建不可变 Version。
- Reference commit 保存完整正文快照以及 parent、actor、summary、RFC 3339 时间、SHA-256 和原始字节长度；Version ID 使用密码学安全随机源生成。
- Document commit 显式接收已经存在的精确 Reference Version 或 `null`。bind 只写入 Document Version，不写 Reference、不写工作副本，也不维护冗余反向 bind。
- 第一次显式空 commit 会创建 parent 为 `null` 的根 Version；已有 Head 后完全无变化返回 `created: false, reason: 'no-changes'`，但成功事务仍让 generation 精确增加 1；正文相同而 bind 改变仍创建新版本。
- Checkout 将选定历史版本的原始正文复制到对应 `current.md` 并移动该树的 Head，不创建或删除 Version；从旧版本继续 commit 可以形成保留全部后代的可追踪分叉。
- Checkout 默认拒绝覆盖相对 Head 已 dirty 的工作副本并返回 `CONFLICT`，只有调用方显式传入 `discardChanges: true` 才允许丢弃当前内容。
- 增加有限 Archive mutation 和 Version metadata encoder，继续复用 M3 的跨进程锁、document identity、generation CAS、临时包全量校验、fsync 与原子替换，没有建立第二套 Writer、Repository 或 Provider。
- 所有既有 Version 的 metadata/content 都按原始 bytes 保留；新增 maxVersions 失败不改包、输入在首个异步边界前快照、主写入错误不被资源关闭错误覆盖等回归保护。
- 同步 README、快速开始、API 参考、架构、机制、决策和路线图，将 M4 标记为完成，并把当时称为“M5 Review 与完整性能力”的工作设为下一阶段；后续设计已在 D010 将其准确定位为主要由 Agent-friendly 需求驱动的通用只读检查与诊断能力。

### 验证与边界

- 对应提交包含 85 项测试，覆盖 Core command、package-root API、首次空提交、no-changes、bind-only commit、dirty checkout、分叉、历史原始字节不变、资源上限以及真实跨进程提交竞争。
- 完整测试在 Node.js 20.20.2 和 Node.js 26.3.0 通过。
- 实际打包并安装到临时外部项目后，仅通过 package root 完成 `create -> save -> commit -> checkout -> open`。
- 本阶段不包含公开 dirty/drift 查询、Diff、`verify`、export、受管资源 API 或正式 npm 稳定发布；这些仍属于 M5/M6。

## `5adf7c8` — `feat: complete M3 create and save transactions`

- 完整 SHA：`5adf7c8a167f5653e91f20608b332505fb7294da`
- 日期：2026-09-07
- 里程碑：M3 创建、保存与原子文件事务

### 详细提交说明

- 从 package root 提供 `createMdv`、`saveReference` 和 `saveDocument`；创建得到 generation 0、两份空 `current.md`、零 Version 和零 Head 的合法包。
- 普通 save 只替换目标树的工作副本并让 generation 增加 1，不创建 Version、不移动 Head、不引入自动 commit。
- 新增确定性 ZIP32 Writer：使用 STORE、固定 DOS 时间、稳定 UTF-8 entry-name 顺序，并拒绝 ZIP64、过多条目、超大 entry 和不安全路径。
- 新增统一文件事务：在目标同目录创建 mode `0600` 的唯一临时包，写完后用完整 Reader 校验全部结构和历史正文，随后 fsync 并原子发布。
- 写入锁内重新打开最新归档，同时比较 documentId 和 expected generation；路径使用文件系统最终目标统一锁身份，避免陈旧对象、路径替换和同 generation 的另一份文档被误写。
- 把原子 replace 定义为 commit point。发布前失败保持旧包 byte-for-byte 不变；发布后目录同步失败通过 `committed: true`、stage 和新 generation 明确报告。
- 整包重写时只替换 manifest 中原始 generation token，保留 manifest 未知字段及 JSON 表示；历史 metadata 原始透传，历史正文通过单次 ZIP 扫描逐版本验证和复制。
- 拒绝最终 symlink、hard-link alias 和非普通文件目标，保留已有 POSIX mode，并显式报告临时文件、锁或目录同步的清理失败。
- 扩充 ZIP Reader 对 ZIP64、multi-disk EOCD、跨盘 entry、解压上限和流式完整性验证的防护；补充真实跨进程 create/save 竞争、故障注入、权限和路径身份测试。
- 建立 `prepare` 构建生命周期与 tarball consumer smoke，保证 Git 或本地目录安装能够生成并消费 `dist/`；同步所有调用方和维护者文档。

### 验证与边界

- 对应提交包含 61 项测试；覆盖并发 CAS、临时包损坏、历史 hash、commit point 前后故障、锁清理、路径 alias、symlink/hard link、权限、确定性 ZIP 和 package-root 写 API。
- 完整测试在 Node.js 20.19.5 和当时的 Node.js 26.3.0 通过，并完成独立 tarball consumer 验证。
- POSIX 本地文件系统执行文件和目录 fsync；Windows 尚未经过 CI，目录项断电持久性不承诺与 POSIX 同级。
- 本阶段只有 create/save 和原子事务，没有 commit、checkout 或 Version 创建能力。

## `d87ed3e` — `feat: complete M2 read API and documentation`

- 完整 SHA：`d87ed3e31ef378d304a792d2a502784d4df67fbd`
- 日期：2026-09-07
- 里程碑：M2 公开只读 API

### 详细提交说明

- 从 `@mdv/core` package root 提供 `openMdv(path)` 和 `parseMdv(bytes)`，把内部 Archive/DTO/领域对象收敛为稳定的调用方 facade。
- 区分路径绑定的 `MdvDocument` 与内存解析的只读 `DocumentSnapshot`，明确 `packagePath`、`baseDirectory` 和相对资源解析语义。
- 暴露 manifest 摘要、两棵树的 Head、warnings、Version 列表，以及按 Reference/Document tree 过滤后的强类型返回值。
- 提供 `getHistory`、`getChildren`、`getDocumentReference`、`listDocumentsUsingReference`、`traceDocument` 和 `traceReference`，让调用方无需理解内部索引即可追踪 parent 与 bind。
- 提供工作副本和历史 Version 的 bytes/text 读取；历史正文按需解压并校验 `contentBytes` 与 SHA-256，返回数组、对象和 bytes 不允许反向污染 snapshot。
- 将 Archive、格式、图和 I/O 异常映射为稳定 `MdvError` code/details，并把未知 manifest/version 字段与未知 Markdown profile 暴露为非阻断 warning。
- 扩充合法 bound history 和损坏 hash、错误格式版本、BOM、畸形 metadata 等 fixtures，补齐公开 API 黑盒测试和 Reader 负向测试。
- 整理文档结构：调用方文档进入 `docs/`，维护者架构、技术方案、路线图、决策、开放问题和简短维护日志进入 `docs/design/`。
- 新增根 README、快速开始、核心概念、API 参考和相对资源说明，明确 Core 返回 Markdown 原始内容而不负责 AST、HTML 或渲染。
- 完善 package metadata、唯一 package-root export 和构建入口，为外部 MarkText、VS Code 或其他上游项目消费做准备。

### 验证与边界

- 对应提交包含 22 项测试，覆盖 `open -> read -> query -> trace`、内存解析、错误映射、不可变返回值、惰性历史校验和扩展字段 warning。
- 本阶段是公开只读能力；尚不能创建、save、commit 或 checkout `.mdv`。
- Markdown parser、renderer 和宿主编辑器 model 明确不进入 Core。

## `313a56d` — `feat: initialize mdv core`

- 完整 SHA：`313a56d098850808789d2621ed79949ccecc3e73`
- 日期：2026-09-07
- 里程碑：项目初始化与 M1 内部只读基础

### 详细提交说明

- 初始化 Node.js 20+、TypeScript strict、ESM 单包工程，建立 `package.json`、锁文件、编译配置和基础源码/测试目录。
- 冻结 MDV Container Format 0.1：使用 ZIP 单文件、根 `manifest.json`、`ref_tree`/`doc_tree` 两棵树、两份 `current.md`、可选 Head 和不可变 Version 目录，不增加冗余 `mimetype`。
- 建立 manifest、Reference Version 和 Document Version JSON Schema，定义 document/version ID、generation、actor、summary、content hash/length 与精确 `referenceVersion | null` bind。
- 实现 Archive DTO、严格 JSON parser、codec、RFC 3339 校验、UTF-8/路径/资源限制和基础 ZIP Reader，把物理容器视为不可信输入。
- 建立 Core 领域模型、品牌化 ID、hydrate、父子图 invariant、Reference bind 校验、反向索引和基础历史查询。
- 确认 Reference 与 Document 独立演化，bind 只存于 Document Version；Reference 不维护反向引用，业务状态不使用 seed/requirements/approved/published 等命名 refs。
- 新增 fixture 构建脚本、generation-zero 空包、无 Reference 的 Document 历史、悬空 bind 和非法 manifest 等首批合法/非法样本。
- 增加 codec、Core graph 和 Reader 测试，覆盖格式字段、parent/bind 关系、cycle/悬空引用和基本容器读取。
- 建立最初的产品设计与技术方案，并加入简约猫头 MDV icon 的 SVG 和概念图资产。

### 验证与边界

- 对应提交包含 14 项基础测试，覆盖 codec、领域图和内部 Reader。
- 此时以内部只读基础和格式基线为主，尚未完成 M2 的稳定公开 facade，也没有任何写事务。
