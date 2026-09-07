# MDV 开放问题

这里记录尚未冻结的问题，以及已经给出阶段性结论的边界。标记为 Open/Deferred 的内容不属于当前 public API 承诺。

## O001：M3 原子替换的跨平台细节

- 状态：Resolved for M3（带平台限定）
- 所属阶段：M3
- Owner：Core maintainer
- 结论：按文件系统最终路径加锁；锁内重读并比较 documentId + generation；同目录写私有临时文件；完整 Reader 校验并 fsync 后，以原子 replace 作为 commit point；replace 后同步目录元数据，并在锁内打开结果。
- 失败语义：commit point 前失败时旧文件必须 byte-for-byte 不变；commit point 后目录同步失败时返回 `IO_ERROR`，details 包含 `stage: 'sync-directory'`、`committed: true` 和新 generation，调用方重新打开目标确认结果。
- 文件边界：写事务拒绝最终 symlink、hard-link alias 和其他非普通文件；一致性保证限于实现支持、能提供可靠目录锁、同目录原子替换与 fsync 语义的本地文件系统。网络文件系统、FUSE 和同步盘不作同等级承诺。
- 恢复边界：锁永不按时间自动回收。异常退出后，只有在确认没有活跃 writer 时才人工删除 `<target>.lock` 与遗留的 `.mdv-*.tmp`；清理失败由结构化错误显式上报。
- 元数据边界：save 保留 POSIX mode，不承诺 owner/group、ACL、xattr、Finder tags 或 Windows DACL/attributes。
- 平台结论：macOS 本地文件系统已实测文件与目录同步；Windows 会刷新临时文件，但目录项 crash durability 弱于 POSIX，且尚未通过 Windows CI。因此 M3 不宣称两者具有同等级的断电持久性。
- 验证：61 项测试在 Node 20.19.5 实跑通过，覆盖 ZIP64、multi-disk EOCD 与跨盘 entry 拒绝、写 ZIP、临时包全验、fsync、replace、目录同步故障注入、真实跨进程竞争、路径身份、清理失败与权限边界；独立 tarball consumer smoke 验证 package-root 安装和 create/save/open。

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
