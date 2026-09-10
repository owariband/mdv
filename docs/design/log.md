# MDV 设计维护日志

本文件只追加简短索引；具体结论写入对应设计页面。

## 2026-09-10

- 按用户确认将 Agent Tool 升级为 `0.1.0-preview.2` / 协议 v2：开放除 VS Code 专属 UI 外的完整 Core 命令面，以每棵树正文身份和 HEAD 隔离逻辑冲突，保留整包锁/CAS/原子替换。Reference 写入与 dirty checkout 丢弃均在 CLI 入口 fail closed；commit 只接受 agent actor，Document 必须显式精确 bind 或 unbound。源码构建与仓库外 tarball 安装均重复 22 项真实子进程回归并通过；个人 Skill/runtime 已升级并以真实文档只读核对，安装版 VSIX + v2 CLI 完整联调 22/22。本批纳入当日整体 Agent Tool 交付，npm/Marketplace 仍未发布。

## 2026-09-09

- 已将 U1 成果 `2d68ef6` 和详细日志 `416c666` 推送至 `origin/main`；后者对应 [CI](https://github.com/owariband/mdv/actions/runs/34306309915) 10/10 成功。未改写历史，个人测试文档、telemetry ignore 和全局 Git 配置未动。
- 随后按用户要求将 Agent A0/A1 提交为 `6e41aaa` 并推送；CLI 19 项再次通过。用户要求跨项目使用，新增可选 `mdv` 个人 Skill 与独立 runtime 安装说明，不增加 MCP 服务或默认 Ref 权限；此前未提交记录由本条更新。
- Skill 提交 `07ab810` 已推送，并从该固定版本完成本机个人安装；实际 CLI 在仓库外 19/19，通过 Codex `skills/list` 确认项目内/外均为 enabled user skill。只新增 `~/.agents/skills/mdv/` 及其 runtime，不修改全局配置；不启动新的业务阶段，O006 和发布/跨平台待验收项保留。
- 按用户新要求在独立 `adapter/mdv_agent_tool/` 实现 A0/A1：同时返回 Ref/Doc，默认仅 Doc 工作副本可写；历史读取按精确 bind，严格身份/generation、参数/预算/错误输出，不改 ZIP 或 Core。19 项真实子进程在 Node 20/26 通过，仓库外安装后 19 项通过。新增实际 CLI → VS Code 刷新/dirty 保护通过；完整 UI 回归剩 1 项撤销失败，记录 O006，不宣称全套通过。本批 Agent 代码尚未提交或推送，未给宿主自动安装/注册。

- 汇总 U1 到 `preview.6`：侧栏自适应且不抢焦点、Webview ready 后切换原生编辑器以修复销毁竞态、猫头活动栏图标。推送前 Core 188 通过/1 平台 skip，最新 VSIX 基础安装回归 20 项通过且 renderer 日志无销毁错误；此前可选 Markdown 扩展和 reload/Restricted Mode 结果分别记录。同步插件方案和索引，保留未验证的平台边界。

## 2026-09-08

- 按用户确认实现 `preview.3`：移除概览页，普通打开直接进入 Doc；新增原生 Ref/Doc 显隐和侧栏双列 parent/bind 版本图。复用 Core 查询、FSP、保存基线与 Markdown renderer，隐藏通过后台原生标签保留文本/undo/选区，不创建反向 bind 或新正文模型。19 项本机独立 VSIX 集成检查通过；隐藏 Ref + Doc 的真实 reload、首次保存/外部 writer 冲突，以及 Restricted Mode 另行通过。同步 D016、插件方案、路线图、技术机制、索引和使用说明；未提交、push、发布或安装到日常 VS Code。

- 用户用 Git 提交图截图澄清侧栏“tree”是 Ref/Doc 双列版本演进与 bind 图，不是文件目录。修正 D016、插件方案 §4.0、索引与路线图；区分 parent/bind、Ref HEAD/Doc 实际绑定 Ref、工作副本/历史，记录 `listDocumentsUsingReference` 等既有 API 复用与侧栏 WebviewView 绘图建议。只读 fixture 检查通过；未修改 Core/插件代码、未构建新版 VSIX。

- 用户进一步确认不需要 Diff 红绿差异，要求左侧类似 Git 的树导航、小型显示/隐藏按钮与 Doc 默认打开。更新 D016 和插件方案 §4.0：Doc 为主、Ref 按需、隐藏保留原生草稿/撤销/基线；标明“合成单标签”是此前助手推断，推荐原生编辑组配对。仅维护设计，插件实现与验收待执行。

- 记录用户否定包概览页、要求默认 Ref/Doc 可编辑双栏的反馈，新增 D016，并在 D014、插件方案和索引标明旧入口被取代。核对原生 Diff 双边可写及 Split in Group 边界；同标签生命周期和差异高亮待确认。本次仅更新设计记录，未更改插件实现、Core 或 VSIX，不宣称双栏修正已交付。

- 根据用户实际新建空 `test.mdv` 被拒绝的反馈，确认 D015：普通新建 0 字节文件是正式支持的写作入口，不要求专用命令或初始化确认。Core 只读打开为空白视图，首次 save 复用原事务写 ZIP；插件自动进入 Doc 原生编辑区，非空坏文件仍受保护。产物升级为 `preview.2`；新增跨进程身份、首次保存/图片/空 commit、并发/替换/发布前变化和真实默认打开回归；本机 Core 188 通过/1 平台 skip、插件安装回归 16 项通过，空文件 Restricted Mode、真实 reload 后首次保存及外部冲突保护另行通过。恢复逻辑补齐激活前已还原的正文和持久化保存基线；尚未推送或跑远端矩阵。

- 落地 M6 工程硬化：15 组可重复 fixtures、conformance/安全/复杂 Markdown/有界 fuzz、干净源码 tarball 与 TS consumer、六场景基准、三系统 CI 配置和 release gate。未修改生产代码或 Format 0.1。
- 新增兼容性、性能与发布检查文档，记录 D012，并保持 O003 开放；区分本地已验证、CI 待实跑与 owner 发布决策，M6 不冒进标记为正式发布完成。
- 完成 M5：从 package root 提供 `getStatus()`、`readContent(ContentSpec)`、通用 `diff()` 与顶层 `verifyMdv()`，并导出全部 readonly public types。
- status 以原始 bytes 长度/SHA-256 判断两棵工作副本 dirty，用四态联合精确区分无 Document Head、unbound、aligned 与 drifted；新增 Reference Head 为 `null` 的合法 drift fixture。
- Diff 采用无第三方依赖的 bounded Myers，支持任意两份工作副本/Version 的同树或跨树比较，保留 CRLF/LF/CR、Unicode 和 EOF newline，并对输入、行数、编辑距离、hunk 和输出实施硬上限。
- `verifyMdv` 默认检查 metadata，full 模式通过单次 ZIP 扫描验证全部历史正文并聚合独立 UTF-8、长度与哈希问题；阻断结构、资源限制和 issue budget 截断通过 `complete: false` 表达。
- M5 没有修改 Format 0.1、Writer、mutation、transaction 或 runtime dependencies；人类左右对照仍由 bind/trace/read + 上游 UI 组合。下一阶段进入 M5.5 受管图片 sidecar。
- 完成 M5.5：四个 `ManagedResource` API、带基准的只读 snapshot、PNG/JPEG/GIF/WebP 内容寻址、不覆盖原子发布与限量 hash 校验；保留普通 Markdown 路径自由，不改 ZIP/版本/Markdown。
- 新增 D011，关闭 O002，明确 resolve 返回本地绝对路径但不计算 hash；read/verify 消费已校验 bytes。资源和 `.mdv` 是独立事务，无 GC，`verifyMdv(full)` 不检查外部 sidecar。
- 本轮全量 147 项测试与 typecheck 通过，覆盖真实跨进程导入、发布/清理故障、读取中变化、路径安全和历史图片回读；同步官方文档与设计状态，下一阶段为 M6 发布硬化，不启动上游客户端。
- 将 M5.5 开发日志关联到真实功能提交 `c8c30b6d7991f2fe3f6abafea6378acc132c2316`，保留详细交付、验证与平台边界；以独立文档提交补记身份，不重写任何历史提交。
- 将 M6 工程日志关联到已推送的真实提交 `a05b4d047fe48f983fa65303a67b7510a1bb03b4`，记录首次 GitHub Actions 运行入口；本地验证与远端结果分开记录，保留 owner 发布身份未决项。
- 首次远端 CI 7 组 Linux/macOS 通过、3 组 Windows 失败；按实际日志修复 Reader 的目录输入分类和两项文件打开期间替换测试，不跳过 Windows 测试或修改原子发布机制，修复后重新跑矩阵。
- 修复提交 `52f1d3383b0797a6348df5007f2696a7aa0b9ced` 已推送；[远端矩阵](https://github.com/owariband/mdv/actions/runs/34193879318) 10/10 成功，Windows 三组各 179 通过、0 失败、4 项既有平台限定 skip，所有平台的真实 tarball consumer 均通过。同步兼容性、官方文档和路线图，保留首次失败历史与 Windows 断电限制；O003 发布身份仍开放。
- 按用户要求维护 [VS Code 插件](./vscode_plugin.md)与 [Agent Tool](./agent_tool.md)开发草案，规划仓库根 `adapter/mdv_vscode/`、`adapter/mdv_agent_tool/` 两个独立上游包；记录 D013 并同步旧排期与目录表述。本地接入不等待正式 npm 发布，但 Core 发布身份仍未决；本轮仅维护文档，没有创建 adapter 代码、安装包或新发布。
- 随后按用户要求实现 U1 本地预览版 `adapter/mdv_vscode/`：原生 Markdown 虚拟编辑、复用内置预览/兼容扩展、图片资源代理、显式 commit/受保护 checkout、精确 bind 双栏、外部冲突与恢复基线。记录 D014，取代旧草稿中独立正文 renderer 的方向；不优化 Core 存储、不开发 Agent CLI、不提交或发布。
- 产出 `0.1.0-preview.1` VSIX；macOS VS Code 1.136.1 / Extension Host Node 24.18.1 中 14 项安装版集成检查通过，包括实际图片/表格/CSS、Markdown All in One 3.6.3 定向编辑、自动保存与版本对话框；独立 Restricted Mode 与真实 reload 保护另行通过。最低 VS Code 1.100 下载失败，Windows/Linux、完整剪贴板和其他 renderer 仍待验收；详见[插件方案 §8](./vscode_plugin.md#8-开发阶段与验收)。

## 2026-09-07

- 将维护者资料整理到 `docs/design/`，建立架构、机制、路线图、决策和开放问题导航。
- 将 M2 标记为完成，记录公开只读 API、错误边界、确定性 fixtures 和对应测试结果。
- 新建面向调用方的 README、快速开始、核心概念、API 与资源文档。
- 确认受管图片使用内容寻址 sidecar，资源 I/O 在 M3 主事务闭环后实现。
- 启动 M3 创建、工作副本保存与文件事务实现；统一 `SaveInput`，save 直接返回新的 `MdvDocument`，不增加冗余结果包装。
- 冻结本地事务边界：原子 replace 是 commit point；replace 后目录同步失败报告 `committed: true`；写目标必须是支持语义的本地普通文件，拒绝 symlink 和其他非普通文件。
- 完成 M3：公开 `createMdv`、`saveReference`、`saveDocument`；save 返回新的不可变 `MdvDocument`，锁内比较 documentId + generation，并以文件系统最终路径统一锁身份。
- Writer 确定性输出 ZIP32，单次扫描并逐版本复制历史；manifest 仅替换 generation 原始 token，version metadata 原样透传，未知 JSON 值不发生有损回写。
- 增加真实跨进程竞争、事务故障注入、路径替换、symlink/hardlink、清理失败、权限、历史哈希、动态时区和独立 package consumer 验证；补齐容器级 ZIP64、multi-disk EOCD 与跨盘 entry 拒绝，并在 Node 20.19.5 实跑通过。滚动测试总数以 `npm test` 输出为准。
- 明确 M3 平台边界：POSIX 本地文件系统执行 file/directory fsync；Windows 写入尚未通过 CI，目录项 crash durability 弱于 POSIX；已有 lock 不自动按时间回收。
- 启动 M4 commit/checkout 开发；冻结“普通 Markdown 是编辑底座”：编辑器内存 buffer 归宿主，Core save 只持久化 `current.md` 并执行 generation CAS，不增加 `DraftVersion`、`workspace` 或 pending bind。
- 冻结 M4 边界：commit 只固化已保存的 `current.md` 且不接收正文；首次显式空 commit 创建根 Version；no-changes 不创建 Version 但 generation 增加 1；dirty checkout 默认 `CONFLICT`，仅显式 `discardChanges: true` 才覆盖。
- 明确多进程保存冲突沿用普通文档外部修改模型：Core 阻止静默覆盖，重载、比较、合并或另存为由宿主决定。
- 完成 M4：从 package root 公开 `commitReference`、`commitDocument`、`checkoutReference` 和 `checkoutDocument`，并导出对应 input/result 类型。
- commit 在事务锁内读取已保存工作副本，创建不可变完整快照并更新 Head；Document commit 显式保存精确 Reference bind 或 `null`，no-changes 仍递增 generation。
- checkout 默认保护 dirty 工作副本，显式 discard 后可恢复历史正文并移动 Head；分叉、错误树/缺失版本、同 generation 并发提交和跨进程冲突已有测试覆盖。当前完整测试数量以 `npm test` 输出为准。
- 新增 [`dev_log.md`](./dev_log.md)，按真实 commit 沉淀 M1–M4 的详细交付正文、验证结果和阶段边界；本文件继续只维护设计知识根的简短变更索引，不重写已经推送的 Git 历史。
- 冻结 M5 为主要由 Agent-friendly 需求驱动的通用只读能力：异步 status、四态 Reference 关系、统一 `ContentSpec`、受限源码 Diff 与无需先成功 open 的顶层 `verifyMdv`；人类左右对照继续由 bind/read + 上游 UI 实现，并移除重复且含糊的 `exportMarkdown` 草案。
- 补齐剩余阶段边界：M5.5 落实内容寻址图片 sidecar，M6 负责 fixtures、fuzz、性能、CI、发布身份与兼容性；M6 完成后才达到 Core 0.1 稳定发布口径。
