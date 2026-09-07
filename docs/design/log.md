# MDV 设计维护日志

本文件只追加简短索引；具体结论写入对应设计页面。

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
