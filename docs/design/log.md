# MDV 设计维护日志

本文件只追加简短索引；具体结论写入对应设计页面。

## 2026-09-07

- 将维护者资料整理到 `docs/design/`，建立架构、机制、路线图、决策和开放问题导航。
- 将 M2 标记为完成，记录公开只读 API、错误边界、确定性 fixtures 和 22 项测试结果。
- 新建面向调用方的 README、快速开始、核心概念、API 与资源文档。
- 确认受管图片使用内容寻址 sidecar，资源 I/O 在 M3 主事务闭环后实现。
- 启动 M3 创建、工作副本保存与文件事务实现；统一 `SaveInput`，save 直接返回新的 `MdvDocument`，不增加冗余结果包装。
- 冻结本地事务边界：原子 replace 是 commit point；replace 后目录同步失败报告 `committed: true`；写目标必须是支持语义的本地普通文件，拒绝 symlink 和其他非普通文件。
- 完成 M3：公开 `createMdv`、`saveReference`、`saveDocument`；save 返回新的不可变 `MdvDocument`，锁内比较 documentId + generation，并以文件系统最终路径统一锁身份。
- Writer 确定性输出 ZIP32，单次扫描并逐版本复制历史；manifest 仅替换 generation 原始 token，version metadata 原样透传，未知 JSON 值不发生有损回写。
- 增加真实跨进程竞争、事务故障注入、路径替换、symlink/hardlink、清理失败、权限、历史哈希、动态时区和独立 package consumer 验证；补齐容器级 ZIP64、multi-disk EOCD 与跨盘 entry 拒绝；`npm test` 达到 61 项，并在 Node 20.19.5 实跑通过。
- 明确 M3 平台边界：POSIX 本地文件系统执行 file/directory fsync；Windows 写入尚未通过 CI，目录项 crash durability 弱于 POSIX；已有 lock 不自动按时间回收。
