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
- 验证：测试在 Node 20.19.5 实跑通过，覆盖 ZIP64、multi-disk EOCD 与跨盘 entry 拒绝、写 ZIP、临时包全验、fsync、replace、目录同步故障注入、真实跨进程竞争、路径身份、清理失败与权限边界；独立 tarball consumer smoke 验证 package-root 安装和 create/save/open。滚动测试总数以 `npm test` 输出为准。

## O002：受管资源的媒体类型与扩展名策略

- 状态：Resolved for M5.5
- 所属阶段：M5.5
- Owner：Core maintainer
- 结论：从 bytes 文件头识别 PNG/JPEG/GIF/WebP，固定 png/jpg/gif/webp 扩展名；可选 MIME 只作断言，无需文件名。默认单资源 32 MiB，每次可通过正安全整数 `maxBytes` 覆盖；不作完整解码或像素安全认证。
- 公开能力：`importManagedResource`、`resolveManagedResource`、`readManagedResource`、`verifyManagedResource`。带基准的 `LocatedDocumentSnapshot` 只提供后三者，路径绑定 `MdvDocument` 才允许导入。
- 边界：受管路径内容寻址、不覆盖、不跟随内部 symlink；resolve 检查路径并返回本地绝对路径，read/verify 才检查 hash。普通 Markdown 链接仍由宿主自由命名和定位，SVG/AVIF 等普通引用不受 managed allowlist 限制。
- 错误：非法路径/导入类型为 `INVALID_RESOURCE`，已存内容损坏为 `INTEGRITY_MISMATCH`，超限为 `LIMIT_EXCEEDED`。发布后失败携带 `committed: true`；没有资源 GC 或跨 ZIP/sidecar 事务。
- 证据：[资源文档](../resources.md)、[D011](./decisions.md#d011m55-区分普通链接与可选受管图片)、`test/resource-*.test.mjs` 与真实跨进程导入测试。跨平台/发布兼容性仍在 M6 验证。

## O003：稳定发布身份

- 状态：Open
- 所属阶段：M6
- Owner：Repository owner
- 问题：最终 npm scope、0.1 版本策略、发布权限和开源许可证。
- 当前阻塞：`package.json` 仍为 `0.0.0-development` 与 `UNLICENSED`，没有 owner 审阅后的 LICENSE。M6 已实现开发态/严格 release gate，严格模式按预期拒绝通过。
- 已有证据：干净源码 tarball runtime 与双 TypeScript consumer 已通过，CI 三平台矩阵已配置但尚待远端结果；见[发布检查](../releasing.md)。
- 下一检查：推送并确认 CI 后、首次正式发布前由 owner 决定；技术检查不替代 scope 权限或 License 审阅。

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
