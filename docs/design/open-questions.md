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
- 平台结论：M3 当时已实测 macOS 文件与目录同步，尚未运行 Windows CI。M6 后续已通过三系统矩阵，见[兼容性文档](../compatibility.md)；Windows 仍只刷新临时文件，目录项 crash durability 弱于 POSIX，不宣称两者具有同等级的断电持久性。
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

## O003：稳定发布版本与权限

- 状态：Partially resolved
- 所属阶段：M6
- Owner：Repository owner
- 已决定：Core npm 包名为 `@owariband/mdv`；仓库、VSIX 与 Agent Tool 采用 Apache-2.0，并包含 Apache 官方许可证正文。该变更不修改 Format 0.1、public API 或运行时语义。
- 当前阻塞：`package.json` 仍为 `0.0.0-development`，尚未确认 `@owariband` scope 的实际发布权限，也未选择 `0.1.0-rc.1` 或正式 `0.1.0`。严格 release gate 仍按预期拒绝开发版本。
- 已有证据：干净源码 tarball runtime 与双 TypeScript consumer 已通过，修复提交 `52f1d33` 的三系统矩阵 10/10 成功；见[兼容性证据](../compatibility.md)与[发布检查](../releasing.md)。
- 下一检查：重新生成两个 Adapter 的固定 Core 产物并完成全量检查；首次正式发布前由 owner 确认 scope 权限和版本。技术检查不替代发布账户授权或代码权利确认。

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

## O006：原生撤销回归在 Agent 联合检查中失败

- 状态：Open / 最新一次未复现（2026-09-09 新观察，2026-09-10 跟进）
- 所属阶段：U1 插件回归，不是 Core 或 Agent 读写权限
- Owner：VS Code adapter maintainer
- 现象：macOS / VS Code 1.136.1 / Extension Host Node 24.18.1，在已有两侧保存用例后给原生 Doc 插入 `prefix `，执行 `undo` 后文本仍保留前缀；增加显式编辑组聚焦和最长 10 秒状态等待后仍可复现。没有证据将其直接归因于 Core、CLI 或用户操作。
- 对照：本轮推送前基础 20 项曾通过；新增真实 CLI 联动后的两次完整运行均有撤销/宽度断言失败。截图确认宽度断言未扣除原生竖滚动条，按实际 viewport 修正后通过，最新完整结果为 20/21；真实 CLI 成对读取、仅 Doc 保存和 clean/dirty 协作均通过。
- 范围：这轮没有修改 Core 或插件生产逻辑；其他新建/隐藏原生文档的 undo 检查仍通过。不能把这一条当作已修复，也不回写旧记录为从未失败。
- 本机证据：runner 打印的隔离目录尾名 `mdv-vscode-test-7PfAFS`、`mdv-vscode-test-ejnsd1`、`mdv-vscode-test-16q77Q` 内保存 `workspace/test-results.json`；最新撤销超时，新增 Agent CLI 用例通过。
- 2026-09-10 跟进：将真实 Agent 用例升级为协议 v2 baseline 后，以安装版 VSIX + 已安装 Agent preview.2 runtime 运行完整套件，`mdv-vscode-test-hCs5z8` 为 22/22，原生 undo 和 Agent 子进程均通过，renderer 日志无销毁错误。这证明当前组合本次成功，不足以解释或抹去此前连续失败，故暂不关闭。
- 可重复命令：在 `adapter/mdv_vscode/` 执行 `npm test -- --vscode <VS Code executable> --installed --agent-cli <installed cli.cjs>`。
- 下一检查：隔离跨用例焦点/全局 undo 路由与已保存文本模型的撤销栈变化，确认是测试上下文还是可复现的产品缺陷；保留真实断言，不通过删除用例或扩大等待冒充修复。
