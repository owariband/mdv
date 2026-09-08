# MDV 设计维护日志

本文件只追加简短索引；具体结论写入对应设计页面。

## 2026-09-08

- 完成 M5：从 package root 提供 `getStatus()`、`readContent(ContentSpec)`、通用 `diff()` 与顶层 `verifyMdv()`，并导出全部 readonly public types。
- status 以原始 bytes 长度/SHA-256 判断两棵工作副本 dirty，用四态联合精确区分无 Document Head、unbound、aligned 与 drifted；新增 Reference Head 为 `null` 的合法 drift fixture。
- Diff 采用无第三方依赖的 bounded Myers，支持任意两份工作副本/Version 的同树或跨树比较，保留 CRLF/LF/CR、Unicode 和 EOF newline，并对输入、行数、编辑距离、hunk 和输出实施硬上限。
- `verifyMdv` 默认检查 metadata，full 模式通过单次 ZIP 扫描验证全部历史正文并聚合独立 UTF-8、长度与哈希问题；阻断结构、资源限制和 issue budget 截断通过 `complete: false` 表达。
- M5 没有修改 Format 0.1、Writer、mutation、transaction 或 runtime dependencies；人类左右对照仍由 bind/trace/read + 上游 UI 组合。下一阶段进入 M5.5 受管图片 sidecar。
- 完成 M5.5：四个 `ManagedResource` API、带基准的只读 snapshot、PNG/JPEG/GIF/WebP 内容寻址、不覆盖原子发布与限量 hash 校验；保留普通 Markdown 路径自由，不改 ZIP/版本/Markdown。
- 新增 D011，关闭 O002，明确 resolve 返回本地绝对路径但不计算 hash；read/verify 消费已校验 bytes。资源和 `.mdv` 是独立事务，无 GC，`verifyMdv(full)` 不检查外部 sidecar。
- 本轮全量 147 项测试与 typecheck 通过，覆盖真实跨进程导入、发布/清理故障、读取中变化、路径安全和历史图片回读；同步官方文档与设计状态，下一阶段为 M6 发布硬化，不启动上游客户端。

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
