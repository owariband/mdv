# MDV 开放问题

以下问题尚未冻结。它们不属于当前 public API 承诺。

## O001：M3 原子替换的跨平台细节

- 状态：Open
- 所属阶段：M3
- Owner：Core maintainer
- 问题：macOS、Linux 和 Windows 上锁文件、fsync、目录同步及 replace 失败恢复的精确实现和错误映射。
- 已确认边界：锁内重读 generation；同目录临时文件；完整 Reader 校验后再替换；任一失败不得破坏旧包。
- 下一检查：实现 Writer 前先建立故障注入测试矩阵。

## O002：受管资源的媒体类型与扩展名策略

- 状态：Open
- 所属阶段：M3 事务闭环之后
- Owner：Core maintainer
- 问题：允许哪些 MIME/扩展名、无扩展输入如何处理、扩展名与真实内容不一致时返回什么错误。
- 已确认边界：路径必须内容寻址、不可覆盖、由 Core 校验；宿主只负责 paste/drop 和 Markdown 插入。
- 下一检查：设计最小 `importResource` / `resolveResource` DTO 时冻结。

## O003：稳定发布身份

- 状态：Open
- 所属阶段：M6
- Owner：Repository owner
- 问题：最终 npm scope、0.1 版本策略、发布权限和开源许可证。
- 当前阻塞：`package.json` 仍为 `0.0.0-development` 与 `UNLICENSED`。
- 下一检查：package smoke test 与 CI 完成后、首次正式发布前决定。

## O004：资源随单文件携带

- 状态：Deferred
- 所属阶段：Format 0.2 或更晚
- Owner：Format maintainers
- 问题：是否将资源放进未来容器并纳入历史完整性，以及如何避免破坏 0.1 Reader 的严格 entry grammar。
- 当前结论：0.1 保持外部 sidecar，不在实现中私自增加 ZIP entry。
- 下一检查：基于真实分享、迁移和历史规模数据评估。

## O005：第二存储后端

- 状态：Deferred
- 所属阶段：出现真实调用方后
- Owner：Core maintainer
- 问题：浏览器、远端或虚拟文件系统是否需要从现有 I/O seam 提取 storage interface。
- 当前结论：只有 ZIP + 本地文件一种实现，不增加 Repository/Provider/Factory。
- 下一检查：第二个可运行后端提出具体约束时再设计。
