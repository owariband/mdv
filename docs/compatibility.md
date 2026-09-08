# 兼容性与平台边界

当前仍是 `0.0.0-development`，未发布稳定 npm 包。本文记录 M6 已建立的自动检查与拟用于 Core 0.1 的维护规则，不把未运行的 CI 或未确认的发布身份说成已经完成。

## 运行环境

Core 是 Node.js ESM 库，唯一入口为 `@mdv/core`。不提供 CommonJS `require` 入口、浏览器构建、CLI 或 Markdown renderer。`engines.node` 暂时保留 `>=20`，本轮不通过提高门槛制造不必要的兼容破坏。

| 环境 | 验证状态 |
| --- | --- |
| macOS arm64 / Node 26.3.0 | M6 本地全量测试、独立 tarball/类型检查、性能基准已通过 |
| Linux、macOS、Windows / Node 22、24、26 | 已配置 9 个 CI job；首次远端运行结果待验证 |
| Linux / Node 20 | 已配置额外回归 job；不将保留旧运行时兼容等同于其仍受上游维护 |
| TypeScript 5.9.3 和仓库当前编译器 7.x | 独立 tarball consumer 通过 strict NodeNext 类型检查；不需要调用方安装 ZIP 库类型或 `@types/node` 才能使用公开声明 |

CI 定义见 [ci.yml](../.github/workflows/ci.yml)。配置矩阵不是验证结果；正式发布前需查看目标提交在所有 job 的实际结论。Node 版本维护状态以 [Node.js 官方发布计划](https://github.com/nodejs/Release#release-schedule)为准。

## 文件系统与一致性

- 目标是提供可靠目录锁、同目录 rename/link 和 fsync 的本地文件系统；网络、FUSE、云同步盘、浏览器虚拟文件系统不作同级保证。
- 普通 save 只更新工作副本与 generation；commit 才保存 Version。精确 bind、不可变历史和 generation CAS 不随本轮工程改造变化。
- ZIP 替换和 sidecar 导入各自有 commit point，不存在跨两者的原子事务。先导入图片，再保存 Markdown 引用；后续 save 失败允许留下可复用的孤立图片。
- POSIX 同步文件和目录，保存时保留原文件 mode。Windows 实现刷新文件，但跳过目录 fsync；不承诺与 POSIX 同级的断电目录项持久性。故障注入测试不等于真实断电实验。
- 不承诺保留 owner/group、ACL、xattr、Finder tags 或 Windows DACL/attributes。
- 普通并发写由 CAS/目录身份检查保护，不是抵抗同权限恶意进程反复替换祖先目录的沙箱。已有 `.lock` 不会按时间自动删除；恢复前必须确认没有活跃 writer。
- Windows 目录 alias 使用 junction 回归测试。文件 symlink 测试仅在系统明确拒绝创建（`EPERM`）时跳过并报告；POSIX 权限/umask 和动态时区特性有各自平台限定。不会把整个 Windows 写入测试跳过。

失败恢复示例见 [API：文件事务](./api-reference.md#文件事务与支持边界)和[资源发布边界](./resources.md#发布失败与恢复边界)。`committed: true` 意味着发布已经发生，不能当作“没写成功”直接重放旧 generation。

## API 与格式分别演进

`package.json.version` 是库版本；`manifest.formatVersion` 是文件格式版本；metadata 的 `schemaVersion` 是另一项格式字段。M6 不修改 Format `0.1` 或 Schema，也不把 npm 版本写进每份文档。

拟用于正式 `0.1.x` 的兼容规则：

- 保持 package-root 方法、类型区分、已有返回字段及保存/commit/bind 语义；内部 `archive/*`、`core/*`、`resource/*` 不属于公开接口，也不能通过 package subpath 导入。
- 不在补丁版本删除公开字段、重命名既有错误码或降低已声明运行环境；需要破坏性调整时另立版本并提供迁移说明。
- 已有合法 Format 0.1 fixtures 必须继续读取，旧版本完整性与扩展 JSON 原文保留必须继续通过回归；新物理结构不能偷偷写入 0.1 ZIP。
- 安全修复可以拒绝原先误接收的非法输入，但需补充最小复现 fixture 与变更说明。
- 默认资源上限是可观察契约；改变上限需明确记录，不能伪装成纯内部重构。

当前开发预览尚未承担稳定版本承诺。正式版本号、scope 和授权范围仍由 owner 确认，见[发布检查](./releasing.md)。

## 错误与诊断契约

公开 `MdvErrorCode` 的 14 个成员由独立 TypeScript consumer 检查；具体清单和用途见 [Errors](./api-reference.md#errors)。`VerifyIssue.code` 复用相同类型，不另造一套 review 错误码。Warning 当前为 `UNKNOWN_FIELD` 和 `UNKNOWN_MARKDOWN_PROFILE`。

调用方按 `code` 分支，并在存在时处理 `details.committed`、generation 和清理失败信息。`details` 是可扩展的只读记录，新增诊断字段不代表新的业务语义；不要依赖英文 `message`、堆栈或具体绝对路径文字做分支。非法调用参数仍可能抛 `TypeError` / `RangeError`，不能假设所有编程错误都是坏文件。

`openMdv` 只按需校验历史正文；需要完整扫描用 `verifyMdv(..., { mode: 'full' })`，并同时检查 `valid` 与 `complete`。它不扫描外部图片，受管图片应显式 `readManagedResource` / `verifyManagedResource`。图片头识别不等于完整图像解码或安全认证。

## 默认预算

以下是当前实现值，MiB = 1024 × 1024 bytes：

| 范围 | 默认上限 |
| --- | --- |
| ZIP 条目 / 两棵树 Version 合计 | 30,010 / 10,000 |
| 单条目 / 总解压内容 | 64 MiB / 512 MiB |
| 单条目压缩比 | 100 |
| JSON 单文件 / 嵌套深度 | 1 MiB / 32 |
| ZIP entry 名称 | 512 UTF-8 bytes（固定格式限制） |
| Diff 合计输入 / 合计行数 | 8 MiB / 200,000 |
| Diff 编辑距离 / hunk 数 / 输出 | 2,048 / 10,000 / 16 MiB |
| Diff 上下文 | 3 行 |
| verify 诊断 issue | 100 |
| 单个受管图片 | 32 MiB |

ReadLimits、DiffLimits、`maxIssues` 与图片 `maxBytes` 可以按公开 API 调整；显式提高预算也会增加调用方承担的内存/CPU/I/O 风险。这些限制和有界 fuzz 是防御与回归证据，不是对任意恶意输入的形式化安全证明；处理完全不可信内容的宿主仍可使用独立进程与自身资源预算。
