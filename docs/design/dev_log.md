# MDV 开发提交日志

> 最后更新：2026-09-09
>
> 本页是 Git commit message 的详细版本，按最新提交在前排列。它补充已经推送但正文过于简略的历史提交，不改写 Git 历史。
>
> 2026-09-10 根 Core 的后续发布名已确定为 `@owariband/mdv` 并采用 Apache-2.0；下列旧提交中的 `@mdv/core`、`UNLICENSED` 和“License 待定”保留为当时事实，当前结论见 [D018](./decisions.md#d018发布包使用-owaribandmdv-与-apache-20)。

## 定位与维护方式

- 每一条记录对应一个已经落地的 commit 或独立交付批次，记录代码实际完成了什么、如何验证，以及当时明确没有完成什么。
- Git 中继续使用 Conventional Commit 风格的简短标题；标题后保留一个空行，再用逐项 bullet 写正文，并把同样的信息同步到本页。
- 本页不是格式或 API 的规范来源。容器格式以 [`spec/format-0.1.md`](../../spec/format-0.1.md) 为准，公开接口以 [`src/index.ts`](../../src/index.ts) 和测试为准，当前进度以 [`roadmap.md`](./roadmap.md) 为准。
- 未来提交在本页顶部追加；已经发布的历史记录只补充事实，不为了美化叙述而改写代码边界或验收结果。

## `07ab810` — `feat: add a discoverable Codex skill for the MDV CLI`

- 完整 SHA：`07ab81073410aeba42c490b43a9b95f3b8ce6b33`；已推送到 `origin/main`。
- 2026-09-09 按用户授权，通过 skill-installer 从此固定提交安装到本机个人 `~/.agents/skills/mdv/`，再将本地 `0.1.0-preview.1` tarball 安装到该技能的 `runtime/`。不是全局 npm 安装，不修改其他技能或 Git/npm/Codex 配置文件。
- 安装实测：技能校验通过，安装文件与固定源码一致；Codex 0.153.4 的 `skills/list` 在本项目和仓库外临时工作目录均返回 `mdv`、`scope: user`、`enabled: true`，没有该技能的加载错误；没有启动模型任务或常驻服务。
- 实际个人运行时 CLI 返回 `0.1.0-preview.1`，从仓库外调用它重复 19 项真实子进程回归全部通过。下一轮对话可使用；当前 GUI 是否已刷新技能列表不由独立进程列表检查证明，未刷新时可重启宿主。

- 新增 `adapter/mdv_agent_tool/skills/mdv/SKILL.md` 与发现元数据，按 `.mdv` 读写请求自动选择，也可显式调用；不触发普通 Markdown 或 Core 开发任务。
- 技能从自身 `runtime/` 定位独立安装的 CLI，不依赖当前项目、仓库源码或全局 npm bin；不新增业务包装层、MCP 服务或写命令。
- 明确当前/历史配对、只读请求无写入、严格旧基线、仅正文保存与冲突/不确定落盘的处理；权限继续由 CLI 执行，Skill 不替代校验。
- 增加个人安装说明与隔离依赖路径；运行时不入库。安装和发现的实际证据与技能源码提交分开记录，不把源码存在等同于宿主已安装。

## `6e41aaa` — `feat: add paired MDV reads and document-only Agent writes`

- 完整 SHA：`6e41aaa262f819e18d035948eb3fc460ab4b24c7`
- 已推送到 `origin/main`；本次 push 前再次运行 CLI 19 项全部通过。[该提交 Core CI](https://github.com/owariband/mdv/actions/runs/34357613545) 成功；该 workflow 不运行 Agent/VS Code 测试，adapter 证据仍是上述本地检查。以下为 A0/A1 的交付明细，后续 Skill 装配单独记录。

- 在 `adapter/mdv_agent_tool/` 新增独立 Node 20+ package，提供已捆绑固定 Core 的本地 CLI tarball；不向根 Core 增加 bin、运行依赖或新公开类型，不启动服务。
- `read` 一次返回当前已保存 Ref/Doc，默认带固定标题的文本，可用 JSON 精确保留字符、换行、来源和保存基线；历史 Doc 读取精确绑定的 Ref，unbound 不拿当前 Ref 顶替。
- 只开放 `save-document`：请求必须携带原 `expectedDocumentId`、`expectedGeneration` 和 Markdown；Core 事务锁内继续核对身份/generation，拒绝陈旧或同路径换文档的覆盖，不自动重试。
- Ref、HEAD、既有版本和 bind 不变；保存不创建版本。Ref/版本/图片/create 写命令、历史写目标、额外权限和 tree 字段均拒绝，不提供提权开关。
- 输入限量 16 MiB，响应计入 JSON 转义/包装限量 32 MiB；拒绝非法 UTF-8、JSON BOM 和未配对代理项，不以截断正文冒充完整成功响应。保留 Core code/details，并区分 stdout 失败与已经写盘的结果。
- 19 项真实子进程回归在 macOS Node 20.20.2 与 26.3.0 通过，包含两进程竞争、身份替换、默认权限、空文件、精确历史和管道中断；仓库外独立安装 CLI 后重复 19 项通过。不声明未跑的 Windows/Linux 运行时。
- 增加可选真实 CLI → VS Code 联合用例：成对读取、保存正文后的 clean 刷新、保留人的 dirty 文本并拒绝旧写入，检查 Ref/历史不变；该用例通过。完整插件回归最新 20/21，剩既有原生撤销用例失败；原生滚动条宽度测试已纠正，未改插件生产代码。详细失败证据保留在 O006，不把整套记为通过。
- 使用说明包含宿主两个动作的装配方式与权限边界：工具不是 OS 沙箱，有任意 shell/文件写能力的 Agent 仍可能绕过它。未创建 MCP/Skill、自动注册宿主、全局安装或发布 npm。
- 同步 Agent 方案、默认权限决策、路线图、索引、维护日志和调用方入口；此前完整命令面仍保留为后续草案，不把 Ref 修改或版本权限默认为已交付。

## `2d68ef6` — `feat: deliver VS Code adapter and ordinary MDV editing`

- 完整 SHA：`2d68ef62d902b48b0bfc7f7e950f80a427642f46`
- 推送状态：功能与日志提交 `416c666` 已推送至 `origin/main`；[该批次 Core CI](https://github.com/owariband/mdv/actions/runs/34306309915) 三系统 10 组全部成功。此 CI 不包含后续本地 Agent adapter。
- 日期：2026-09-09
- 交付批次：U1 VS Code 本地预览版，包含历次试用修正，产物升级至 `0.1.0-preview.6`。
- 新增独立 `adapter/mdv_vscode/`，只消费 Core package root；本地构建、tarball 校验、VSIX 安装和隔离 Extension Host 回归可重复，不发布 Marketplace 或 npm。
- 支持文件系统普通新建的 0 字节 `.mdv`：打开不写磁盘，首次保存复用既有身份/generation 校验与原子 ZIP 发布；非空坏包、路径替换和旧保存基线继续受保护。
- 复用原生 Markdown 编辑、预览和兼容扩展，提供图片资源代理、普通保存、显式 commit、受保护恢复和历史 Doc 精确绑定的 Ref 对照，不把渲染器或 CLI 加入 Core。
- 取消包概览默认页面和正文 Diff，Doc 默认打开；Ref/Doc 可按需显隐，原生后台标签保留未保存文本、撤销和选区，不关闭用户其他文档。
- 侧栏双列版本图展示完整 parent 分支、各树 HEAD、跨列 bind 和 Ref 的全部 Doc 使用方；随侧栏可用宽高重排，普通打开不抢占侧栏选择。
- 复现并修复跨编辑组重复打开引起的 `OverlayWebview has been disposed`：resolve 先返回，Webview ready 后才跳转并释放入口，覆盖取消、后台和并发打开。
- 活动栏换成项目已有猫头 SVG；构建包内资源和 manifest 一致，不修改正文/版本业务。
- 本轮验证：Core 共 189 项（188 通过、1 项 Windows 专用 skip）；干净目录 tarball runtime 与 TypeScript 5.9.3/仓库编译器 consumer 通过；最新 VSIX 基础安装回归 20 项通过，renderer 日志无销毁错误。
- 历史验证独立保留：`preview.5` 包含可选 Markdown All in One 的 21 项、Restricted Mode、无外部变化/外部冲突两种真实窗口 reload 已通过；本轮未重复所有配置。Windows/Linux GUI、最低 VS Code 和真实剪贴板完整矩阵仍待验证。
- 未包含个人 `docs/test_mdv/test.mdv`、用户 `.gitignore` telemetry 改动或构建产物；未修改 Git 全局身份，不重写历史。独立 Agent tool 在此提交中仍只有设计，下一批按用户新要求实现成对读取和默认仅正文可写。

## `52f1d33` — `fix: align archive inputs and snapshot tests on Windows`

- 完整 SHA：`52f1d3383b0797a6348df5007f2696a7aa0b9ced`
- 日期：2026-09-08
- 状态：已推送至 `origin/main`；[修复后的 CI](https://github.com/owariband/mdv/actions/runs/34193879318) 已完成，10/10 成功。
- 原始证据：[首次 CI](https://github.com/owariband/mdv/actions/runs/34193052019) 的 Linux/macOS 共 7 组通过，Windows Node 22/24/26 共 3 组失败；各 Windows 组均为同样 3 项失败、176 通过、4 项既有 POSIX 专用测试跳过，tarball 步骤未执行。
- Reader 在已打开的 descriptor 上复用 fstat，同时检查普通文件类型。目录输入不再依赖平台目录 size/读取行为，而是从 open / metadata verify / full verify 稳定抛 `IO_ERROR`；不新增路径预检查或第二个文件句柄。
- 两个同句柄读取测试不再假设目标打开时总能被 rename 覆盖；Windows 仅接受实际 `EPERM` 分支，检查失败替换不改变两份文件、原内容仍正确读取/校验，并确认句柄关闭后替换成功。POSIX 继续验证读取期间原子替换；没有 skip 这两项或放宽 hash/CAS。
- 生产修改仅在 `archive/reader.ts`，不改公开签名、Format 0.1、Writer、资源发布、运行依赖或版本语义。
- 本地针对性 37 项通过；完整 `npm run check` 为 183 项（182 通过、1 项 Windows 专用跳过），真实 tarball runtime 与双 TypeScript consumer 通过。
- 远端 Windows Node 22/24/26 每组均为 179 通过、0 失败、4 项既有平台限定测试跳过；skip 为 POSIX mode、私有权限、动态修改进程时区和极端 umask，本次没有新增 skip。Linux/macOS Node 22/24/26 和额外 Linux Node 20 也全部通过。
- 全部 10 组均完成安装、`npm run check` 与真实 tarball runtime/双 TypeScript consumer；Linux Node 24 的 benchmark smoke 通过。首次失败记录保留，Windows 目录项断电持久性仍弱于 POSIX；没有实际 npm 发布，scope/License/版本选择继续留给 owner。

## `a05b4d0` — `test: harden core packaging, conformance and release checks`

- 完整 SHA：`a05b4d047fe48f983fa65303a67b7510a1bb03b4`
- 日期：2026-09-08
- 状态：M6 工程实现与本地验收完成，已推送至 `origin/main`；远端 [Core verification](https://github.com/owariband/mdv/actions/runs/34193052019) 已完成，7 组通过、3 组 Windows 失败；修复单独记录，不改写本提交历史。

### 详细交付说明

- 新增三系统 × Node 22/24/26、额外 Linux Node 20 的 CI matrix；固定官方 Actions SHA、只读权限，不保存 checkout 凭据，不包含发布步骤。
- 固化独立安装验证：无 dist 的源码副本执行 prepare/build，检查真实 tarball 内容，在独立 consumer 仅安装运行依赖后验证公开读写、版本、CAS、trace/Diff/full verify 和图片闭环。
- 增加 TypeScript 5.9.3 与仓库当前 7.x 的 strict NodeNext consumer；检查树 overload、CommitResult 收窄、只读/located/可写能力、必填 bind/generation、全部错误码和内部子路径封闭。不要求消费者引入 ZIP 类型或 renderer model。
- fixture 生成不再依赖 macOS `/usr/bin/zip`；固定条目、mode、DOS 时间，提供不写入的 `fixtures:check`，从 10 增加至 15 组 expected/归档。既有归档内容不变，ZIP header 改为跨平台确定性编码。
- 新增路径与 bytes 双入口 conformance、Zip Slip/绝对路径/反斜杠/空段/NUL、重复/大小写/NFC 冲突、ZIP symlink、严格 JSON/UTF-8/重复转义 key/原型字段、各类预算回归。
- 新增复杂 Markdown LF/CRLF/CR 原字节往返，覆盖中文/组合 Unicode/front matter/表格/公式/Mermaid/HTML/资源路径/末尾空白和无末尾换行；验证 save 不增 Version、commit bind、dirty/diff、checkout 恢复。
- 增加固定 seed ZIP/JSON fuzz，worker 内存/输入与父线程终止预算确保测试有界；合法及畸形输入同时走 parse/read/full verify，比较分类并检查输入未被修改。
- 修正测试中的 POSIX 分隔符/mode 假设，目录 alias 用 Windows junction；文件 symlink 仅遇明确权限限制时 skip，新增 Windows 尾点/空格目标保护测试，保留既有跨进程竞争与故障注入。
- 增加 10/100/1000 Version × 2/64 KiB 基准，独立进程记录 open/history read/trace/full verify/save/commit 的三轮样本、中位数和峰值 RSS；入库原始本机基线，不设脱离环境的耗时 CI 门槛。
- 增加开发态与严格发布检查、prepublishOnly，检查 package/lock 身份、唯一 ESM export、产物与公开下载地址；开发版本、UNLICENSED、缺 LICENSE 明确阻挡发布 gate。
- 同步官方文档与设计知识根，新增兼容性/性能/发布指南，保持 owner 发布身份问题开放；没有新建业务 CLI、Markdown renderer、存储抽象或 Agent DTO。

### 验证与未决项

- macOS arm64 / Node 26.3.0：`npm run check` 共 183 项，182 通过、1 项 Windows 专用路径用例按平台跳过；独立 tarball runtime 和双 TypeScript consumer 通过。发布 gate 的放行/阻止/lock 身份与私有 registry 拒绝均有临时合成数据回归。
- 默认 fuzz 256 输入通过，额外 `MDV_FUZZ_SEED=1 MDV_FUZZ_CASES=10000` 通过（3,087 可完整读取、6,913 被分类拒绝）；有限随机证据不等于任意输入安全证明。
- fixture 在 America/Los_Angeles 和 Asia/Shanghai 两种时区字节检查通过。完整六场景基准通过；最大 1000 × 64 KiB 场景 open/full verify/save/commit 中位数约 69/125/648/671 ms，进程峰值约 222.5 MiB，见原始基线。
- 严格 release gate 因当前开发版本、UNLICENSED 与缺少 LICENSE 按预期非零退出；没有实际 npm 发布。首次远端 CI 的 Linux/macOS 检查通过，Windows 问题见上方修复记录。
- `src/`、Format 0.1、Schema 和 runtime dependencies 未改变；既有 `.gitignore` 用户改动未触碰，未修改任何 Git 全局配置。
- M6 整体仍待远端矩阵、scope/License/版本和实际发布验收；不将工程检查完成等同于稳定发布完成。

## `c8c30b6` — `feat: complete M5.5 managed image sidecars`

- 完整 SHA：`c8c30b6d7991f2fe3f6abafea6378acc132c2316`
- 日期：2026-09-08
- 里程碑：M5.5 受管图片 hash sidecar

详细交付：

- 从唯一 `@mdv/core` package root 提供 `MdvDocument.importManagedResource()` 与 `resolveManagedResource()`、`readManagedResource()`、`verifyManagedResource()`；返回可直接插入 Markdown 的相对 hash 路径、本地绝对路径或经校验的资源 bytes。
- 新增 `LocatedDocumentSnapshot` / `LocatedParseOptions`：显式基准的内存解析只获得 resolve/read/verify，普通 `DocumentSnapshot` 在类型和运行时均无资源方法；资源 import 和 Markdown 写能力仍只属于路径绑定的 `MdvDocument`。
- 新增 `src/resource/model.ts`，集中实现严格 managed path grammar、当前 documentId 隔离、SHA-256、PNG/JPEG/GIF/WebP 文件头识别与 png/jpg/gif/webp 扩展名。默认单资源上限 32 MiB，逐次 `maxBytes` 可覆盖；可选 MIME 是断言，不依赖文件名，也不做完整图片解码。
- 新增 `src/resource/store.ts`，使用私有同目录临时文件、回读校验、fsync 与 hard-link 不覆盖发布。相同图片可以同进程或跨进程并发幂等导入；既有 hash 文件必须验证且 bytes 一致才能复用，损坏目标不覆盖。
- 受管 I/O 拒绝内部 symlink/非普通目标，检查目录身份，使用同一文件句柄限量读取并检测读取中变化；基准目录本身的合法 alias 可规范化。nlink 大于 1 不直接拒绝，因为原子发布会临时产生第二个 link。
- 新增 `INVALID_RESOURCE`，其余失败沿用 NOT_FOUND、LIMIT_EXCEEDED、INTEGRITY_MISMATCH、CONFLICT 和 IO_ERROR。发布后或确认复用后的失败携带 `committed: true`，清理失败保留 `cleanupFailures`；检测到目录替换时不沿新路径做危险清理。
- import 不修改 `.mdv`、generation、Head、版本或 Markdown，不获取包 writer lock。旧 generation 的同文档 handle 可导入，后续 Markdown save 仍执行 CAS；文档被替换或父目录 alias 被重定向时拒绝旧 handle 的导入。
- 普通 Markdown 路径可以任意命名、引用父目录、绝对位置和网络 URL；所有 Ref/Doc/current/history 共用 `.mdv` 所在目录作相对基准。只有可选 managed API 受 hash grammar 限制，Core 不生成渲染 URI、不扫描 AST、不重写链接。
- 同步 README、快速开始、公开 API、资源指南、架构、机制和路线图；新增 D011、关闭 O002，M5.5 标记完成，下一阶段设为 M6 稳定发布硬化。

验证与边界：

- `npm test` 在 macOS / Node.js 26.3.0 下通过 147 项，比 M5 增加 30 项；`npm run typecheck` 通过。
- 推送前再次执行 `npm run typecheck && npm test`，147 项全部通过；提交只包含本轮 M5.5 的代码、测试和文档，不包含既有 `.gitignore` 改动。
- 新增模型、存储、package-root 黑盒测试，并扩充真实双进程测试；覆盖格式与大小边界、并发复用、目标损坏不覆盖、symlink、读取中原子替换/原地写入/增长、发布前后故障、清理失败、旧 generation、移动包和历史图片回读。
- 独立临时目录运行实际 `npm pack`（包含 prepare/build）、安装 tarball 并通过 runtime smoke；外部 TypeScript consumer 验证所有资源类型、parse overload 和禁止只读快照写入的负向类型用例。内部 `resource/*`、`archive/*`、`core/*` 子路径仍被 package exports 拒绝。
- 未修改 Format 0.1、Schema、Archive writer/transaction、Core 版本规则或 runtime dependencies。没有新增 CLI、插件、Markdown parser/renderer、存储 provider、网络下载或 GC。
- 资源与 ZIP 是独立事务，先 import 再 save；save 失败可以留下可复用孤立图片。`verifyMdv(full)` 不扫描外部 sidecar，分享时仍需同时携带 `.mdv-assets/<documentId>/`。
- resolve 只检查解析时刻的路径/存在性，不验证内容 hash 或保证后续外部读取；需要校验后的内容应消费 read 返回 bytes。目录检查不是对同权限恶意进程持续替换目录的沙箱；Windows/跨平台 CI、性能与发布兼容承诺留在 M6。

## `43b4bef` — `feat: complete M5 agent-friendly review primitives`

- 完整 SHA：`43b4befebc140f91482fe455f4fdca9615c52879`
- 日期：2026-09-08
- 里程碑：M5 Agent-friendly 审阅与诊断能力

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
