# MDV 设计决策

本页只记录已经确认且会持续影响格式或 Core 边界的决定。详细机制见[架构](./architecture.md)与[技术方案](./mechanisms.md)。

## D001：ZIP 单文件，不增加 `mimetype`

- 日期：2026-09-07
- 状态：Accepted
- 决定：`.mdv` 使用 ZIP 容器；根 `manifest.json` 负责格式识别，不增加独立 `mimetype` entry。
- 理由：减少重复事实来源，文件扩展名只负责关联，Reader 仍验证 manifest。
- 影响：Reader 必须把 ZIP 当作不可信输入；格式识别不能只看扩展名。
- 证据：[Format 0.1](../../spec/format-0.1.md)、[架构 §4](./architecture.md#4-mdv-物理格式)
- 2026-09-09 再确认：讨论纯文本 Ref/Doc 分段和历史外置后，用户选择保留当前容器思路；没有执行格式迁移。Agent-friendly 通过独立适配工具提供，不要求普通 `cat` 自动解析 ZIP。

## D002：Reference 与 Document 使用两棵版本树

- 日期：2026-09-07
- 状态：Accepted
- 决定：维护 `ref_tree` 和 `doc_tree` 两份工作副本、Head 与历史；不建立 `seed`、`requirements`、`approved`、`published` 等命名 refs。
- 理由：真正需要追踪的是摘要演化、成品演化以及二者的精确关系，不是预设业务状态机。
- 影响：工作流标签属于上游产品，不进入 Format 0.1。

## D003：普通保存与 commit 分离

- 日期：2026-09-07
- 状态：Accepted
- 决定：`current.md` 沿用普通 Markdown 的可覆盖编辑语义；save 只持久化工作副本并执行 generation CAS，显式 commit 才创建不可变 Version。新建文档从零版本、零 Head 开始，不增加 `DraftVersion`、`workspace` 或 pending bind。
- 理由：编辑器内存 buffer、撤销栈和冲突交互本来就由宿主管理，Core 不应为了版本能力复制普通 Markdown 已有的编辑模型；自动保存也不应制造大量无意义历史。
- 影响：generation 记录包变更次数但不等同于版本数量；save 不移动 Head。多进程冲突由 Core 返回 `CONFLICT`，宿主决定重载、比较、合并或另存为。

## D004：Bind 只存于 Document Version

- 日期：2026-09-07
- 状态：Accepted
- 决定：Document Version 保存精确 `referenceVersion` 或 `null`；Reference Version 不维护反向 bind，工作副本也不保存 pending bind。
- 理由：版本不可变，双向持久化会产生两份需要同步的事实来源。
- 影响：Core 打开时构建可重建的 `documentsByReference` 反向索引；宿主在 commit 时显式提交 bind，尚未 commit 的选择只属于宿主上下文。

## D005：Core 返回 Markdown bytes/text，不返回 AST 或内部 path

- 日期：2026-09-07
- 状态：Accepted
- 决定：Core 的正文边界是原始 bytes 和严格 UTF-8 text，并附带 `baseDirectory`；Markdown parser/renderer model 留给 adapter。
- 理由：ZIP 内 logical entry 没有真实文件系统 path，不同渲染器也没有共同 AST。
- 影响：VS Code、MarkText 和 CLI 只依赖 package root，不把自身模型带入 Core。

## D006：CLI 与编辑器插件是独立上游

- 日期：2026-09-07
- 状态：Accepted
- 决定：`@mdv/core` 是进程内 Library，不启动服务，也不包含 CLI 层。VS Code extension 是 Core 0.1 闭环后的首个图形客户端。
- 理由：argv、UI、Agent tool 协议与格式语义有不同发布周期。
- 影响：上游只能调用 public API，不能直接修改 ZIP entry。
- 后续更新：2026-09-08 的 [D013](#d013adapter-同仓独立包与本地接入优先) 调整本地接入排期和计划存放位置；“独立上游”边界继续有效，不再要求独立 Git 仓库或等待 npm 正式发布。

## D007：受管资源使用内容寻址 sidecar

- 日期：2026-09-07
- 状态：Accepted
- 决定：资源路径为 `.mdv-assets/<documentId>/<sha256>.<extension>`；Markdown 直接保存该相对路径，不在 manifest 维护可变映射。
- 理由：路径本身可以作为不可变内容引用，并允许旧 Markdown 继续定位资源。
- 影响：sidecar 不进入 ZIP或 Version hash；移动文档时必须一并移动资源目录，0.1 不自动 GC。
- 证据：[资源文档](../resources.md)、[Format 0.1 §12](../../spec/format-0.1.md#12-relative-resources)

## D008：接口稳定，泛型克制

- 日期：2026-09-07
- 状态：Accepted
- 决定：public `interface` 描述真实调用契约；联合类型表达状态；泛型只保留实际类型关系。不为单一 ZIP 后端预建 Repository、Provider 或 Factory。
- 理由：库需要明确的类型边界，但不需要没有第二实现的框架层。
- 影响：树相关返回类型优先使用少量 overload；真正出现第二后端后再从现有 I/O seam 提取最小接口。

## D009：M4 Commit 与 Checkout 边界

- 日期：2026-09-07
- 状态：Accepted
- 决定：commit 不接收 Markdown，只固化已保存的 `current.md`；第一次显式空 commit 创建根 Version；已有 Head 后 no-changes 不创建 Version，但成功事务仍让 generation 增加 1。checkout 默认拒绝覆盖 dirty 工作副本，只有显式 `discardChanges: true` 才能替换 `current.md`。
- 理由：版本操作必须建立在已经持久化、可进行 CAS 的工作副本上；显式 commit 表达用户保存版本的意图，而 checkout 不能静默丢弃已经保存的普通 Markdown。
- 影响：宿主在 commit 前负责 save 内存 buffer；`CommitResult.created` 只说明是否创建 Version，不说明事务是否成功；宿主处理 dirty checkout 冲突时必须让用户选择先 commit 或明确丢弃。

## D010：M5 提供 Agent-friendly 的通用只读原语

- 日期：2026-09-07
- 状态：Accepted
- 决定：M5 在现有只读快照上增加异步 status、统一 `ContentSpec` 内容选择、源码级 diff 和顶层 `verifyMdv`。这些能力主要由 Agent/自动化调用需求驱动，但保持为与具体 Agent 协议无关的通用 Core API；不修改 Format 0.1，不增加新的写事务，也不解析或渲染 Markdown。
- 状态语义：Document 与 Reference 的当前关系使用 `no-document-head`、`unbound`、`aligned`、`drifted` 四态联合类型表达，不用 `null` 同时承载多种含义；两棵树各自的 dirty 由 `current.md` 的 byte length / SHA-256 与对应 HEAD metadata 比较，不提前读取历史正文。
- 读取与比较语义：`readContent(ContentSpec)` 和 `diff(from, to)` 共享同一种来源选择器，可明确选择任一树的工作副本或历史 Version；diff 面向原始 Markdown 行，保留正文语义，不经过 AST round-trip。
- 诊断语义：`verifyMdv(source)` 是无需先成功 `openMdv` 的 package-root 入口，可以在安全边界内聚合报告损坏归档的问题，并用 `complete` 区分完整扫描与提前停止；普通 `openMdv` / `parseMdv` 继续 fail-fast。
- 人类宿主边界：Reference/Document 左右对照依赖 Document Version 的精确 bind、trace 与内容读取，这些属于 Core；双栏布局、同步滚动、高亮、Markdown 渲染和 Review 交互属于 VS Code/MarkText。M5 对普通人的直接价值较小，也不代表 Core 提供 Review UI。
- 理由：Agent/CLI 需要无歧义地回答“当前改了什么、成品依赖哪个摘要、任意两份正文差什么、包为何打不开”。由 Core 统一这些确定性计算，可以复用 bind、hash、错误码和 Archive 安全边界，避免每个 Agent tool 产生不同实现；但 Core 不增加 Agent 专属 DTO、prompt 或 token 裁剪策略。
- 影响：M5 主要修改 public types、facade、纯 Core 计算和 Archive 诊断读取；`mutation.ts`、`writer.ts` 与 `transaction.ts` 不改，`commands.ts` 只允许为 dirty 规则一致性做机械修正。最终 checkout 补上 `contentBytes` 比较，与 status 的长度 + SHA-256 规则一致，没有新增 command 或改变公开事务语义。基础人类读写和 bind 左右对照不以 M5 为前置；受管图片 sidecar 独立在 M5.5 实现，发布兼容性在 M6 收口。

## D011：M5.5 区分普通链接与可选受管图片

- 日期：2026-09-08
- 状态：Accepted / Implemented
- 决定：普通 Markdown 路径不受 Core 的命名或目录限制，相对基准统一为 `.mdv` 所在目录。只有主动调用 `importManagedResource` 才使用固定 `.mdv-assets/<documentId>/<sha256>.<extension>`；不增加 path/hash manifest，也不让 managed allowlist 限制普通链接。
- 媒体：从 bytes 文件头识别 PNG/JPEG/GIF/WebP，扩展名固定 png/jpg/gif/webp；可选 MIME 为断言。默认单资源 32 MiB，可逐次覆盖；不做完整图片解码或像素安全认证。
- 定位：`resolveManagedResource` 校验路径/存在性并返回本地绝对路径；`readManagedResource` / `verifyManagedResource` 限量读取并验证 hash/类型。宿主负责把路径转成渲染 URI，Core 不扫描 AST 或重写 Markdown。
- 能力边界：纯 `DocumentSnapshot` 无资源方法；显式 baseDirectory 的 `LocatedDocumentSnapshot` 有三个只读方法；`MdvDocument` 再增加 import。类型和运行时一致，不为内存 snapshot 偷偷赋予文件写能力。
- 持久化：资源用私有临时文件、回读校验、fsync 与 hard-link 不覆盖发布；竞争时重新校验已有 bytes 并幂等复用，不覆盖坏文件。不按 nlink 大于 1 拒绝资源，因为发布本身会临时产生第二个 link。
- 一致性：import 不修改 `.mdv`/generation/Head/版本，不需要 CAS；Markdown save 继续 CAS。先 import 再 save，失败可留安全孤立资源，0.1 不 GC。发布后错误携带 `committed: true`；`verifyMdv(full)` 不扫描外部资源。
- 安全与平台：拒绝受管内部 symlink，允许规范化可信基准 alias；目录身份检查不是对同权限恶意进程的沙箱，返回路径也不是永久资源句柄。macOS 本地路径已测试，其他平台 CI 与 crash durability 在 M6 收口。
- 理由：保持普通 Markdown 编辑底座，同时集中实现 host 不应各自复制的内容寻址、受限读取与原子发布规则；不用渲染器或泛化存储接口扩大库边界。
- 证据：[资源文档](../resources.md)、[公开 API](../api-reference.md#受管图片)、[`src/resource/`](../../src/resource/)、[`test/resource-api.test.mjs`](../../test/resource-api.test.mjs)。

## D012：M6 工程硬化与正式发布分开验收

- 日期：2026-09-08
- 状态：Implemented；发布身份仍见 Open O003
- 决定：延续现有 API/Format/三层结构，仅增加可执行工程检查、测试、基准和文档。CI/bench/scripts 不属于运行时 CLI，不进入 package exports，不新增运行依赖或存储接口。
- 验证：fixtures 使用独立确定性 ZIP 构造与 expected 结果；tarball consumer 不依赖仓库 dist 或源码链接；fuzz 使用固定 seed、输入预算、worker 内存与父线程时间预算。性能先记录本机数据，不凭猜测优化。
- 完成口径：本地检查通过、CI 配置存在、远端矩阵通过、正式发布是不同事实。未跑到的系统或断电边界不提前宣称支持；`UNLICENSED` / 开发版本 / 缺 LICENSE 阻止严格发布 gate，但不阻止日常检查。
- 影响：本轮不选择许可证、不更改 npm/Git 全局配置、不发布 npm、不启动上游插件。正式版本、scope 权限由 owner 决定。
- 证据：[M6 实际交付](./roadmap.md#m6一致性性能与发布收口)、[发布检查](../releasing.md)、[性能数据](../performance.md)。

## D013：adapter 同仓独立包与本地接入优先

- 日期：2026-09-08
- 状态：Accepted；VS Code 本地预览版已实现，Agent tool 仍为待实现方案。
- 方案：在仓库根规划 `adapter/mdv_vscode/` 和 `adapter/mdv_agent_tool/`，两个独立 package 分别承载 VS Code 与一次性 Agent CLI；根 package 继续是 `@mdv/core`。
- 依赖：两个 adapter 都只消费 Core public API，互不依赖；同仓只是联调和版本管理方式，不允许 Core 反向引用 adapter，也不把它们的依赖、bin 或构建产物混入 Core 发布包。
- 范围：先各包独立安装/构建/测试，不迁移 Core 目录、不先引入 workspace 或共享 adapter 框架；实装时以真实 Core tarball 和 VSIX/CLI 独立安装验证边界。
- 排期：基于已验证的 Core 构建开始本地客户端和 Agent 工具接入，不等待 npm / Marketplace 正式发布；取代 D006 中先完成正式发布的排期假设，不改变 D012 的发布验收标准或 O003 的 owner 决策。
- 交付目标：原生 Markdown 编辑与图片、Doc/Ref 精确 bind 对照、显式版本操作、外部保存后可见、未保存 buffer 不被外部改动覆盖。插件已完成本机独立安装验证；真实 Agent CLI 联合使用不在本轮完成口径中。
- 依据：用户 2026-09-08 关于急需实际使用、维护两份方案以及 `adapter/` 目录的本轮要求；[插件方案](./vscode_plugin.md)、[Agent Tool 方案](./agent_tool.md)与[当前 Core 接口](../../src/types.ts)。

## D014：VS Code 复用原生 Markdown 编辑与渲染

- 日期：2026-09-08
- 状态：Accepted / Implemented（本机预览版验收）
- 后续修正：其中“自有包概览作为默认入口”已被 [D016](#d016doc-默认打开与侧栏控制-ref) 取代，`preview.3` 已移除概览页；原生 Markdown 与渲染复用原则继续有效。
- 决定：Ref/Doc 通过可写 `mdv:` FileSystemProvider 暴露为原生 `markdown` 文档；默认直接使用内置 Markdown preview，保留现有 Markdown 设置、语法扩展、样式和脚本贡献。自有 CustomReadonlyEditorProvider 只展示二进制包的概览与导航，不建立正文 renderer 或另一套 dirty buffer。
- 取代：插件初稿 §4.2 中另建 Markdown 预览 Webview 的方向，以及 §6 中另设 MDV 远程图片策略的假设；正文安全交给所选 renderer，概览自己的 CSP/命令白名单仍严格限制。旧方案被本次明确用户要求取代，不影响 Core 的资源或格式规则。
- 资源：虚拟 Markdown 保持真实 `.mdv` 的父目录；最小 markdown-it image 扩展将本地图片转成只读代理 URI，FSP 实施目录权限与受管图片 Core hash 校验，不重写保存的 Markdown。
- 兼容：保留 `mdv.previewCommand` 供独立 renderer 接入，但 `file:` 专属或直接读取 OS 路径的扩展不自动兼容；不为此引入可写临时镜像。历史 bind 始终读取两份精确版本，用两个内置固定预览呈现。
- 验证：真实 macOS Extension Host、安装版 VSIX、原生预览 DOM 的图片/表格、额外 markdown-it/CSS 贡献、Markdown All in One 3.6.3 的定向编辑检查；最低 VS Code、Windows/Linux 和其他 renderer 仍单独验收。
- 理由：满足用户“保留现有 md plugin 显示功能并复用现有渲染能力”的明确要求，让 UI、快捷键和渲染生态继续由宿主负责。没有修改 Core 生产代码、公开类型、存储格式或全量 ZIP 保存策略。
- 证据：[插件实现与验收](./vscode_plugin.md)、[使用和构建说明](../../adapter/mdv_vscode/README.md)、[集成测试](../../adapter/mdv_vscode/test/index.ts)。

## D015：普通空文件是正常的新建入口

- 日期：2026-09-08
- 状态：Accepted / Implemented；用户明确否定“必须使用专用命令创建”的设计，要求对标普通 `.md` 使用体验。
- 决定：文件系统/资源管理器新建的零字节 `.mdv` 是受支持的新文档入口；无需初始化命令或确认。`openMdv` 只读返回两份空正文、generation 0、零 Head/Version，首次 save 才原子写出完整 ZIP。插件打开时直接进入 Doc 的原生 Markdown 编辑区；专用 New Document 仅保留为可选快捷方式。
- 边界：Core 在现有 Archive 读取接口上提供空文件视图，事务重开也使用同一规则；不复制另一套正文 buffer、不在插件拼 ZIP、不新增公开 API 或 DTO。非空损坏文件仍严格失败，不按空文档覆盖。`parseMdv` / `verifyMdv` 仍检查已序列化容器，插件将空文件的 verify 解释为“尚无已保存归档”，不阻断正常编辑。
- 身份：空文件没有持久 manifest。用规范路径、dev/ino、birthtime/mtime/ctime 的 SHA-256 截断摘要生成不透明 Document ID，使同一个未变化空文件跨打开/进程/窗口恢复具有同一身份；首次写入保留该 ID。此为零字节入口的特例，Format §4 补记该派生方式；`createMdv` 与 Version ID 的随机生成不变。保存前移动/复制占位文件不保证保留身份，ID 也不是认证凭证。
- 安全：首次保存继续锁内核对 documentId/generation，发布前核对文件身份并原子替换；空文件被替换、已保存包被截断、外部 writer 获胜时不能继承旧基线。打开和取消编辑不写磁盘；图片导入仍只写 sidecar，首次正文保存后引用继续有效。
- 取代：撤回上一轮排查中“空 `.mdv` 属于错误新建方式、需要初始化确认”的建议；这是产品入口缺陷，不是用户使用错误。已保存容器的条目布局、bind、版本和普通 save/commit 分离语义不变。
- 证据：[新建空文件与首次保存回归](../../test/write-api.test.mjs)、[事务并发/发布保护](../../test/transaction.test.mjs)、[真实插件入口测试](../../adapter/mdv_vscode/test/index.ts)、[容器规范 §1.1](../../spec/format-0.1.md#11-new-empty-files)。

## D016：Doc 默认打开与侧栏控制 Ref

- 日期：2026-09-08
- 状态：Accepted / Implemented（`0.1.0-preview.3`，本机独立 VSIX 验收）。
- 来源：用户先否定 `test.mdv` 包概览页，要求类似 Git Diff 的成对编辑布局；随后明确不要红绿差异，因为 Ref/Doc 差异本来就很大，并要求像 Git 一样的左侧树导航、很小的显示/隐藏按钮、Doc 默认必须打开。
- 最新澄清：用户以 Git 提交图截图明确“tree”指版本演进图，不是 Doc/Ref 文件导航列表；侧栏需要 Ref/Doc 双列版本图，并展示当前或选定 Ref 版本被哪些 Doc 版本使用。正文双栏与侧栏双列版本图是两个独立概念。
- 决定：普通新建与已有 `.mdv` 都默认直接打开 Doc 原生 Markdown 正文；Ref 从侧栏的小型显隐按钮按需显示为左栏，与右侧 Doc 并排。移除概览页，不调用原生 Diff 来承担日常写作，不通过更改全局颜色或 Markdown/Diff 设置掩盖差异效果。保留原生编辑、预览与兼容扩展。
- 侧栏版本图：同一 `.mdv` 内左列 Reference Versions、右列 Document Versions；各列按真实 `parent` 画演进/分叉，跨列以独立线型表示 Doc → Ref bind。分别标记两棵树的 HEAD；版本短 ID、摘要和选中状态用于定位，不把 Ref/Doc 同一行视为一一对应。支持一个 Ref 被多个 Doc 版本引用，unbound Doc 不连虚假的 Ref。
- 关联交互：选 Ref 后高亮其全部使用方及绑定连线，显示 Doc 版本数；选 Doc 后定位它绑定的精确 Ref。图默认选择 Ref HEAD，无 Ref HEAD 时选择 Doc HEAD；“Doc HEAD 实际绑定的 Ref”在页脚单独标注，不能混同。Ref 工作副本若有未提交修改，其 HEAD 使用方也不等于已采用新草稿的 Doc；无 Ref HEAD 时不能伪造可绑定版本。
- 数据复用：`listVersions({ tree })` / `parent` / `getChildren` 提供完整版本与分支；不能只用 `getHistory(HEAD)`，否则遗漏其他分支。`listDocumentsUsingReference(refVersion)` 与 `traceReference(...).usedByDocuments` 已提供反查。磁盘仍只存 Doc Version 的 `referenceVersion`，Ref 不新增冗余 bind 字段，也不扩展成跨 `.mdv` 的全局引用索引。
- 展示实现：上一轮建议的普通 Tree View 文件列表被本次澄清取代。双列节点/跨列连线采用侧栏 `WebviewView + SVG`，沿用 VS Code 主题；它只绘制版本关系和必要小操作，不渲染/编辑 Markdown、不替代正文 buffer、不恢复包概览页。消息限定到当前包 URI/documentId 和已验证版本，使用严格 CSP、文本 DOM 与命令白名单。图按快照缓存 metadata/状态，目前不做图虚拟化，大型历史 UI 性能单独验收。
- 显隐实现：默认 Doc 单栏，展开 Ref 后允许临时隐藏任意一侧，至少保留一侧，另一侧仍可从侧栏恢复。隐藏将原生标签移到另一侧编辑组后台，不关闭模型，不调用 save、commit、checkout 或丢弃；原生未保存 buffer、撤销、选区与旧保存基线保留。用户启用的 VS Code auto-save 仍按宿主规则生效，不由插件更改。
- 布局边界：正文使用原生 Markdown 编辑组，由侧栏和稳定来源 URI 管理同一 `.mdv` 的配对。此前“必须合成为同一个标签、共同关闭”是助手的推断，非实现契约；版本图的两列不等于正文使用一个合成标签。不得为了整理 MDV 布局关闭其他文件、全局重排用户编辑区或额外复制正文模型。
- 数据边界：可编辑两侧均为当前工作副本，并排不产生永久 bind；历史 Version 仍不可变，历史 bind 仍指向精确 Ref Version。Core 的保存、冲突、图片和容器规则不改，侧栏显隐属于宿主状态，不写入 MDV manifest。
- 本机验收：19 项安装版集成检查通过，覆盖双列版本/分叉/独立 HEAD、反查全部 Doc、精确 Ref、多对一/unbound、草稿状态、只读历史、普通新建/已有包直接打开、显隐不丢正文/选区/undo/基线、多包图切换与无关标签保留。隐藏旧草稿在外部写入后仍拒绝保存；真实窗口 reload 后 Doc 和隐藏 Ref 均恢复，无外部变化可保存，外部 writer 获胜则阻止旧基线覆盖；Restricted Mode 只读检查通过。平台与大型图未验证范围见插件方案 §8.2。
- 证据：[公开版本/反向引用 API](../../src/types.ts)、[public 查询实现](../../src/mdv-document.ts)、[侧栏实现](../../adapter/mdv_vscode/src/version-view.ts)、[版本拓扑与分支](../../adapter/mdv_vscode/src/version-graph.ts)、[原生编辑命令](../../adapter/mdv_vscode/src/commands.ts)、[安装回归](../../adapter/mdv_vscode/test/index.ts)、[侧栏 Webview 官方能力](https://code.visualstudio.com/api/extension-guides/webview)、[原生移动编辑器命令](https://code.visualstudio.com/api/references/commands)。本次展示开发没有修改 Core 生产代码或格式。

## D017：Agent 默认成对读取、仅正文可写

- 日期：2026-09-09
- 状态：Accepted / Implemented（A0/A1 开发预览）。
- 来源：用户确认保留容器格式，要求先推送现有插件成果，再开发“同时返回 Ref 和正文、默认只允许修改正文”的 Agent 工具。
- 决定：独立 `adapter/mdv_agent_tool/` 默认只开放成对 `read` 与 `save-document`。读取当前已保存工作副本，或根据历史 Doc 的精确 bind 读取历史配对；未绑定明确表达，不把新 Ref 混入旧 Doc。
- 权限：Ref 与历史只读；不开放 Ref 写、commit/checkout、资源导入或提权开关。额外字段与历史写目标明确拒绝。权限由实际动作入口实施，不以 Skill 提示词代替校验。
- 写入：请求携带原文档身份、原 generation 和完整 Doc Markdown；只调用 Core `saveDocument`，保留 Ref/HEAD/历史/bind，普通保存不创建版本，遇冲突不自动重试。
- 边界：这是 adapter 能力约束，不修改 Core 的通用两树写 API、文件格式或宿主的人类权限。具有任意 shell/文件写能力的 Agent 仍需宿主级沙箱约束；工具本身不是 OS 权限系统。
- 取代：原 Agent 草案 A1 的“两树 save”和默认一律 JSON 输出；改为默认可读两段文本、可选精确 JSON。其他命令仍是待另行授权的后续设计。
- 证据：[实现与安装](../../adapter/mdv_agent_tool/README.md)、[真实子进程回归](../../adapter/mdv_agent_tool/test/cli.test.mjs)、[方案](./agent_tool.md)。19 项 Node 20/26 及独立安装检查通过；CLI → VS Code 新增用例通过，完整 UI 剩余失败单独记 O006。
