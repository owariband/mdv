# MDV VS Code 插件开发方案

> 最后更新：2026-09-09
>
> 状态：U1 本地预览版已实现，当前产物为 `0.1.0-preview.7`；包含原生 Doc 默认入口、Ref/Doc 显隐、双列版本图、自适应侧栏、入口生命周期修复、猫头活动栏图标和按工作副本判定的外部写入冲突保护。实际验收与待验证范围见 §8，不代表 Marketplace 发布或全平台兼容承诺。
>
> 最新交付：[D016](./decisions.md#d016doc-默认打开与侧栏控制-ref) 已取代概览页默认入口：Doc 默认打开、Ref 按需显示，不使用 Diff 高亮；左侧是 Ref/Doc 双列版本演进图，展示精确 bind 与使用方，不是文件导航树。交互实现见 §4.0，旧版验收保留在 §8.1，新版单独记录。
>
> 实现位置：[`adapter/mdv_vscode/`](../../adapter/mdv_vscode/README.md)，独立于根目录的 `@owariband/mdv` package。
>
> 配套方案：[Agent tool](./agent_tool.md)；进度来源：[路线图](./roadmap.md)；当前 API：[公开接口](../api-reference.md)。

## 1. 目标与当前依据

首版目标是让用户真正使用 `.mdv`：在 VS Code 中新建文档、编辑 Ref/Doc、插入图片、查看精确 bind 对照、显式提交与恢复历史，并看到 Agent 保存到磁盘的结果。

Core 已具备这些底层能力，依据是 [`src/types.ts`](../../src/types.ts)、[`src/mdv-document.ts`](../../src/mdv-document.ts) 及[跨平台验收记录](../compatibility.md)。插件已在本机真实 Extension Host 和隔离安装的 VSIX 中验证，Core CI 与插件验收仍分别记录。

2026-09-08 用户提出尽快实际使用，并将两个上游项目放在 `adapter/`。据此调整原先“正式发布后才启动插件”的排期：可以先锁定已验证的 Core 构建，开发本地预览版；当时尚未确定 npm scope、License 和商店发布。2026-09-10 Core 包名与 Apache-2.0 已收口，Marketplace publisher 和实际发布仍需单独确认。

随后用户明确要求保留现有 Markdown plugin 的编辑/显示能力，并复用已有插件渲染。因此首版直接接入 VS Code 原生 Markdown 编辑与预览链路，取代原草案中“另建 Markdown 预览 Webview”的方向。首版自有 Webview 曾展示包概览，现已移除；Core 不增加 Markdown parser 或存储优化。见 [D014](./decisions.md#d014vs-code-复用原生-markdown-编辑与渲染)。

用户实测 `preview.2` 后进一步否定包概览 UI，并澄清不需要 Diff 红绿差异；Doc 默认直接打开，Ref 的显示/隐藏由类似 Git 的左侧树控制，展开后两侧可编辑。此要求覆盖空文件与已保存容器；版本、诊断等操作保留为侧栏导航/命令，不用概览页承载日常写作。`preview.3` 只调整 adapter 入口、侧栏和布局，复用现有虚拟文档/保存链路；详见 [D016](./decisions.md#d016doc-默认打开与侧栏控制-ref)。

最新截图进一步澄清“Git tree”是提交节点与连线组成的版本演进图：左 Ref 历史、右 Doc 历史，能展示当前或选定 Ref 版本被哪些 Doc 版本绑定。不能用两个文件节点加一个“历史”菜单来替代此要求；正文显隐只是版本图旁的小型操作。

## 2. 仓库布局与包边界

沿用用户提出的目录名称：

```text
mdv/
├── package.json                 # @owariband/mdv，继续是根 package
├── src/                         # 仅 Core 源码
├── test/                        # 仅 Core 测试
├── adapter/                     # 独立上游集合，不是 Core 的一层
│   ├── mdv_vscode/
│   │   ├── package.json         # VS Code extension manifest / 自身依赖
│   │   ├── package-lock.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   ├── test/
│   │   └── README.md
│   └── mdv_agent_tool/          # 独立完整 Agent CLI；见配套方案
└── docs/design/
    ├── vscode_plugin.md
    └── agent_tool.md
```

这是同仓库的独立包，不是把 CLI/插件变成 Core 内部层次：

- 两个 adapter 都只从 `@owariband/mdv` package root 导入；不引用 `../../src`、内部 `archive/*`，不复制 ZIP、hash、bind 或锁规则。
- 插件不依赖 Agent CLI，也不通过启动 CLI 完成 UI 保存；两个上游通过同一份 `.mdv` 和 Core 事务协作。
- 根 `tsconfig.json` 继续只编译 `src/`，根测试与发布不要求安装 adapter；根 package 不增加 `vscode`、renderer、CLI 参数解析依赖或 `bin`。
- 根 package 的 `files` 继续使用白名单。`prepare:core` 对真实 tarball 断言 `adapter/**` 未混入 Core 包，不只依赖 `.gitignore`。
- 首轮各包独立安装、构建、测试和打包，不迁移 Core 到 `packages/core`，也不先引入 npm workspaces 或共享 `adapter/common` 包。需要统一调度时再单独评估。
- 初次接入从 Core 的真实 `npm pack` 产物安装；联调可用本地包，交付测试必须用独立安装的固定构建，不能依赖开发机源码链接。依赖版本/完整源码 SHA 与产物校验值在 adapter 的构建记录中可追溯。

文件夹名称不是 npm 包名或 Marketplace publisher。当前 VSIX 使用未发布的本地标识 `mdv-local.mdv-vscode`，不代表已注册 Marketplace publisher；代码与分发包已采用 Apache-2.0，但 Marketplace publisher 仍由 owner 决定。技术隔离不要求立即拆 Git 仓库，将来可以独立迁出。

## 3. 首版用户功能

| 功能 | 插件行为 | Core 出口 |
| --- | --- | --- |
| 新建 / 打开 | 资源管理器普通新建空 `.mdv` 后直接编辑；两份空工作副本、零 Version；专用创建命令可选 | `openMdv` / `createMdv` |
| 编辑 / 保存 | 原生 Markdown 编辑；普通保存不创建版本 | `readContent` / `saveReference` / `saveDocument` |
| 显式 commit | 输入摘要；Doc 必须确认精确 Ref Version 或 `null` | `commitReference` / `commitDocument` |
| 版本图与历史 | 侧栏双列展示完整 parent 分支、独立 HEAD 和 Doc → Ref bind；选 Ref 高亮全部 Doc 使用方；Quick Pick 保留搜索入口，历史正文只读 | `listVersions` / `listDocumentsUsingReference` / `readContent` / `getStatus` |
| bind 左右对照 | 左侧绑定的 Ref Version，右侧选定的 Doc Version | `traceDocument` / `readContent` |
| 历史恢复 | 先确认覆盖范围，再恢复对应树的工作副本和 Head | `checkoutReference` / `checkoutDocument` |
| 图片插入与预览 | paste/drop 或选择图片文件；插入 hash 相对路径 | `importManagedResource` / `resolveManagedResource` |
| 外部变更 | 干净编辑区刷新，有未保存内容时保留并提示冲突 | `openMdv`、generation CAS |
| 状态与诊断 | 区分编辑器未保存、Core dirty、bind 漂移；展示坏包问题 | `getStatus` / `verifyMdv` |

首版以 Markdown 源码编辑加预览为主，不承诺 WYSIWYG。复杂数学、Mermaid 等内容必须保留源码；未支持的渲染能力明确降级展示，不通过重新生成 Markdown 改写正文。双列版本演进与 bind 图已在 `preview.3` 落地。正文 Diff 与同步滚动仍不是目标。

## 4. 编辑器接入方式

### 4.0 原生写作与双列版本图（preview.3）

- 普通打开 `.mdv` 直接进入 Doc，默认不展开 Ref。展开 Ref 时左 Ref、右 Doc，无红绿 Diff、无差异对齐占位，也不默认同步滚动两份并不对应的正文。
- 左侧主要内容是同一 `.mdv` 的 Ref/Doc 双列版本图，不是文件树；各列展示真实版本节点与 parent 分支，跨列展示 bind。图旁仅保留显示/隐藏 Ref/Doc 等小按钮，鼠标悬停给出明确动词提示，也提供键盘入口。选择版本与正文显隐不是同一个动作。
- 允许 `Doc 单栏`（默认）、`Ref + Doc`、`Ref 单栏`（手动临时选择）；至少保留一个正文视图，从树中随时恢复另一侧。Doc 默认打开不等于禁止用户主动聚焦 Ref。
- 隐藏是可见性变化，不是关闭并丢弃。实现将原生标签移动到另一侧编辑组的后台，再激活保留的一侧；不关闭文本模型、不调用 save/commit。未保存文本、撤销、选区与保存基线保留，插件不另存一份正文。用户开启的 VS Code auto-save 仍按其原有规则工作。
- 采用原生 Markdown 编辑组，侧栏按包路径/documentId 和 tree 管理配对。它不是 Git Diff 的单一合成标签；此前同标签的表述是助手推断，并非已确认契约。不得移动/关闭无关文件来整理 MDV 布局。
- 正文使用原生主题、字体和编辑行为；版本图跟随宿主主题/焦点样式，不另做页面皮肤。显隐和图选择状态不进入 Core 或 `.mdv`，不改变 history/bind/save/commit。

版本关系示意（R1/D1 等仅为示意简称，不是新增 ID 格式）：

```text
REF                         DOC
● R2 [HEAD] ◀┬───────────── ● D3 [HEAD]
│            │             │
│            └──────────── ● D2
│                          │
● R1 ◀──────────────────── ● D1
```

列内竖线表示 parent 演进，跨列线表示 Doc → Ref 绑定；示例中 D2/D3 都使用 R2。两列节点不是按相同行号一一配对，真实分叉也不能被时间排序伪装成线性历史。

关系与操作约定：

- 选中 Ref 版本，突出全部使用方 Doc 版本和绑定线，显示计数；选中 Doc 版本，定位其唯一的精确 Ref，`null` 明确显示 unbound，不拿当前 Ref 填空。可让无关连线弱化，但不把这些关系提示当作正文 Diff 高亮。
- 默认定位 Ref HEAD（没有 Ref HEAD 时选 Doc HEAD），并另标 Doc HEAD 所绑定的 Ref；两者可能不同。Ref 工作副本有修改时提示草稿状态，不声称旧 Doc 使用了未提交的新内容；无 HEAD 时只展示工作副本状态，不制造空历史版本。
- 图节点点击用于选择/查看历史，不能自动 checkout、更改 Head 或覆盖工作副本；历史正文保持只读。需要编辑历史内容时，走已有显式恢复流程。正文隐藏也不应把该树的历史节点和绑定信息从图中删除。
- 图只查询 metadata，不要求解析 Markdown 或读取所有历史正文。父子和反向绑定由现有 public API 给出；前端只负责布局、选择与绘制，不存第二套关系。

| 图所需信息 | 现有 Core 出口 |
| --- | --- |
| 全部节点与父子关系，包括非 HEAD 分支 | `listVersions({ tree })` / `VersionSummary.parent` / `getChildren(tree, id)` |
| 当前基准版本 | `referenceTree.head` / `documentTree.head` |
| 一个 Ref 被哪些 Doc 版本使用 | `listDocumentsUsingReference(refId)` / `traceReference(refId).usedByDocuments` |
| 一个 Doc 绑定的精确 Ref | `getDocumentReference(docId)` / `traceDocument(docId).reference` |

这里必须使用全部版本集合，不能只画 `getHistory(HEAD)` 的祖先链。持久化依旧只有 Doc Version 的 `referenceVersion`，Ref 不维护冗余 bind；展示范围是当前 `.mdv`，不是跨文件引用系统。

上一轮原生 Tree View 的目录方案被本次版本图要求取代。侧栏使用 `WebviewView + SVG` 绘制双列节点与跨列连线；该视图只承载版本图与必要操作，不是包概览，更不是 Markdown renderer。VS Code [支持侧栏 Webview View](https://code.visualstudio.com/api/extension-guides/webview)。各列按拓扑顺序画完整 parent 分支，时间只用于可选叶节点排序，不能让异常时间戳颠倒祖先关系。图元跟随主题，单击选择，双击或 Open version 查看只读历史，Doc 的 Open bound pair 读取精确旧 Ref。

消息限定到当前包 URI/documentId、固定命令集合和已验证版本；摘要通过 `textContent` 显示，严格 CSP 不允许任意脚本或 eval，不加载远程代码。图只消费 metadata，工作副本状态缓存到快照改变，事件合并刷新；当前没有图虚拟化，大型历史的 UI 性能仍需单独验收。

代码修改范围限定在插件：替换概览打开路由、实现侧栏版本图、协调原生正文显隐，并增加图关系/选择/历史只读及保存恢复的验收；`openSource`、FSP、Core 查询和保存通道继续复用。Core、Markdown renderer 和图片协议不因这项展示调整而改变。

### 4.1 采用可写虚拟文件，复用原生编辑体验

普通新建空文件是正常入口，不要求用户了解 ZIP 或执行“初始化”。0 字节普通 `.mdv` 由 Core 读取为空白快照，打开不改磁盘；插件首次打开时直接进入 Doc 的原生 Markdown 编辑区，未保存内容仍由 `TextDocument` 管理。第一次 save 复用 Core 原有事务生成容器，不创建 Version；非空非法文件不能走这个回退。专用 New Document 命令仅为快捷入口，见 [D015](./decisions.md#d015普通空文件是正常的新建入口)。

使用 `FileSystemProvider` 提供 `mdv:` 文档，将 Ref/Doc 工作副本交给 VS Code 原生 Markdown 编辑器。正文 buffer、选区、撤销/重做由 `TextDocument` 管理；插件只保留会话身份、磁盘保存基线和必要的协调状态，不再复制一套可编辑正文模型。

`TextDocumentContentProvider` 只提供只读内容，不能承担工作副本保存。历史虚拟文件同时声明只读并在写入口拒绝；不支持的创建、删除、重命名操作明确拒绝，不能变成任意 ZIP entry 编辑器。[VS Code 虚拟文档与文件系统指南](https://code.visualstudio.com/api/extension-guides/virtual-documents)

URI grammar 已固定为 `mdv://<documentId>/<包的真实目录>/<文件名>.mdv.<reference|document>.<working|versionId>.md`。由 `vscode.Uri` 处理编码，可恢复真实包 URI、documentId、tree 与内容选择；包路径参与身份，不只靠 documentId 或内存 session ID。中文、空格、`#`、`%` 已在真实宿主测试，Windows 盘符仍需目标平台验收。

虚拟 Markdown 与真实 `.mdv` 具有相同父路径，使原生 Markdown 的相对路径解析保持正确基准；它仍不是终端可直接 `cat` 的磁盘文件。这里只为指定的 `.mdv` 提供内容视图，不把整个 workspace 替换成虚拟文件系统。

### 4.2 `.mdv` 文件入口与预览

`.mdv` 本身是二进制 ZIP，不能用 `CustomTextEditorProvider` 将原包当作 Markdown 保存。保留 `CustomReadonlyEditorProvider` 作为 `*.mdv` 文件关联路由：激活后直接打开原生 Doc，释放路由标签，不提供概览页或另一套 dirty/Save 生命周期。关联 ID 继续使用 `mdv.overview` 以兼容旧工作区恢复，但显示名称与实现已改为 MDV Markdown。[Custom Editor 官方说明](https://raw.githubusercontent.com/microsoft/vscode-docs/main/api/extension-guides/custom-editors.md)

版本导航使用侧栏图，Quick Pick 保留搜索入口。普通预览直接调用 `markdown.showPreviewToSide`，历史 bind 双栏使用内置 `vscode.markdown.preview.editor` 的两个固定历史 URI，不会随当前活动编辑区切换成另一版本。内置 Markdown 的设置、`markdown.markdownItPlugins`、`markdown.previewStyles`、`markdown.previewScripts` 继续由现有渲染链路消费。[Markdown extension 官方指南](https://code.visualstudio.com/api/extension-guides/markdown-extension)

`mdv.previewCommand` 给独立第三方 renderer 留命令出口：先激活原生源码编辑区，再传入 URI；该命令必须支持虚拟 Markdown 或读取活动编辑区。仅支持 `file:`、直接用 Node `fs.readFile(document.fileName)` 的插件不自动兼容，也不为它们维护第二份可写临时 `.md`。已定向测试 Markdown All in One 3.6.3 的加粗与保存；Markdown Preview Enhanced 和任意其他插件不能据此宣称兼容。

### 4.3 最小代码职责

当前代码按以下真实职责组织：

```text
src/
├── extension.ts        # 注册入口、命令与销毁
├── uri.ts              # 稳定来源身份、图片读取代理 URI
├── document-session.ts # 包身份、保存基线、顺序写入、外部变化
├── file-system.ts      # FileSystemProvider、只读/资源权限与虚拟 mtime
├── commands.ts         # create / commit / checkout / 原生正文配对和显隐
├── package-editor.ts   # ZIP 文件关联路由，直接打开 Doc 后释放
├── version-view.ts     # 侧栏 provider、查询/选中/消息与生命周期
├── version-graph.ts    # metadata 拓扑排序与分支 lane，不读历史正文
├── markdown.ts         # 原生 markdown-it 图片规则的最小扩展
└── resources.ts        # 图片 paste/drop，委托 Core 导入
```

`media/version-graph.js` / `.css` 只负责侧栏 DOM/SVG 与主题适配，随 VSIX 打包；`versions.svg` 是原生风格活动栏标识，不是 Marketplace 位图。VS Code 要求的 provider interface 正常实现；Core 的 `ContentSpec`、Version、错误类型直接复用，不增加泛型 storage provider、Repository 或只包一层转调的 service。

## 5. 保存、版本和并发语义

### 5.1 四个不同的事实

| 事实 | 唯一来源 | 含义 |
| --- | --- | --- |
| 编辑器未保存 | `TextDocument.isDirty` | 内存 buffer 与上次加载/保存的工作副本不同 |
| 工作副本未 commit | Core `getStatus().reference/document.dirty` | 已保存的 `current.md` 与 Head 不同 |
| 基于哪个版本 | 对应树 Head | 保存不移动 Head，commit/checkout 才可能改变它 |
| bind | Document Version 的 `referenceVersion` | 只存在于不可变 Doc Version，不属于未提交的 buffer |

因此，刚按保存后可以是“编辑器干净，但工作副本未 commit”。UI 不能把两种 dirty 合并成一个“未保存”标记，也不新增 DraftVersion、workspace.json 或持久 pending bind。

### 5.2 普通保存

1. 取得该编辑区建立时的文档身份、generation 与该侧工作副本内容指纹基线，使用编辑器提供的待保存正文。
2. 同一包的插件内写操作顺序执行，调用对应 `save*`；跨进程互斥仍交给 Core，不新增磁盘锁。
3. 成功后消费返回的新 `MdvDocument`，更新已保存树的基线和状态；不要继续用旧对象假装代表最新磁盘。
4. 同时打开 Ref/Doc 且两边都有编辑时，本会话成功保存一边后，只有确认另一边的磁盘正文未变化，才推进它的 generation 基线，保留其内存编辑。外部事务也按同一规则处理：包 generation 变化但该侧 `current.md` 的 byte length + SHA-256 未变化时，可以把该侧基线推进到最新 generation；该侧正文变化时必须阻止陈旧保存。这是按工作副本识别冲突，不是正文自动合并，也不改变 Core 的整包 CAS/锁边界。
5. `CONFLICT` 时保留 buffer，提示先用原生编辑器复制/导出，再显式重新加载；首版没有专用合并或比较对话框。禁止为了让保存成功，先重开最新包、拿新 generation 盲目重试旧内容。

虚拟文件的 mtime 根据该正文 bytes 变化推进，不直接使用包 generation；保存 Ref 不能仅因为包 generation 增加，就让未变化的 Doc 被原生编辑器误判为磁盘修改。

“保存全部”会产生两个顺序事务；第一份成功、第二份失败时如实展示，不能宣称两棵工作副本一起原子保存。自动保存若启用，也只能调用普通 save；首次验收覆盖手动保存和自动保存，不在每次按键后整包重写。

### 5.3 Commit 与 Checkout

- 用户发起 commit 时，如目标编辑区尚未保存，先询问是否保存再提交。save 和 commit 是两个操作；commit 失败不回滚已完成的 save。
- Doc commit 的选择框展示具体 Ref Version / `null`。可以提示当前 Head，但不能在确认后悄悄改成另一个最新 Ref；若要绑定尚未提交的 Ref 编辑，应先显式提交 Ref。
- `created: false` 不显示“新建版本成功”，仍消费返回的新 generation；不假设无变化 commit 没有执行事务。
- 工作副本对照可显示“当前 Ref / 当前 Doc”或“Head 的绑定 Ref / 当前 Doc”，但必须注明这是编辑参考，不是工作副本已有永久 bind。
- 历史 bind 模式只读两个精确版本。`referenceVersion: null` 显示“未绑定”，不拿当前 Ref 填空。
- Checkout 先处理内存未保存内容，再处理 Core 的已保存 dirty；仅在用户明确确认时传 `discardChanges: true`。两种放弃不能混为一次无提示覆盖。
- Doc checkout 不顺带移动 Ref Head。预览旧 Doc 对应的 Ref 只需读取历史，不需要 checkout Ref。

### 5.4 Agent 外部修改、窗口关闭与恢复

监听真实包所在目录以覆盖原子替换，并在重新聚焦或显式刷新时重新核对包状态；事件只是提示，不假定文件监听永不丢事件。自身写入事件按返回的身份/generation 核对，不用固定时间窗口屏蔽所有通知。

- 没有未保存编辑：重开包、更新虚拟文件内容和元数据、发出变更事件，刷新预览与版本列表。
- 有未保存编辑：先比较该侧持久化的正文指纹。只有该侧 `current.md` 也变化时才保留旧基线并标记冲突；若变化只发生在另一侧、历史元数据或资源，则推进到新 generation，继续保留且允许保存内存 buffer。不能只因整包 generation 变化就锁住两侧，也不能在该侧正文已变化时盲目换 generation。
- 文件删除、移动或同一路径换成另一 documentId：保留现有 buffer，但停止对旧目标自动保存，要求重新选择目标。
- `details.committed: true`：先重开确认磁盘结果再更新 UI，不将其当作安全重试信号。锁或临时文件不由插件自动强制删除。
- 原生编辑器的关闭提示、undo/redo、reload/hot exit 必须在 Extension Host 中实测。插件恢复保存基线所需的身份/generation 元数据可以放在扩展存储中，不放进 `.mdv`；正文备份交给 VS Code。
- 恢复出的 buffer 若缺少可靠的该侧内容指纹，先保留为待确认内容并阻止覆盖保存，不能用启动时刚读到的 generation 冒充原基线。若指纹证明该侧未变，即使另一侧推进了 generation，也可以在当前包快照上恢复该侧基线。多窗口分别是独立 writer，最终仍由 Core CAS 决定胜者。

## 6. 图片与渲染安全

1. 只在可写 `mdv:` Markdown 编辑区接管支持的图片 paste/drop，或提供“插入图片文件”命令。取得 bytes 后调用 `importManagedResource`，不在插件复制 hash/sidecar 命名算法。
2. 导入成功后将返回的相对路径插入 buffer；不自动 save 或 commit。插入被取消、撤销或后续保存失败时，可以留下可复用孤立图片，不自动 GC。
3. `markdown.ts` 链接已有 image renderer，只将 MDV 本地图片转为带所属包与真实目标的只读代理 URI，再由原生 preview 的 `asWebviewUri` 加载。FSP 对受管引用调用 Core `readManagedResource`，实际消费限量且经过 hash 校验的 bytes，不将 resolve 冒充校验。
4. 普通相对链接按 `MarkdownSource.baseDirectory` 解析，所有 current/history 共用 `.mdv` 所在目录；绝不相对于虚拟 `.md` 或 ZIP 内目录解析。普通图片路径仍可自行命名，Core 不替宿主下载网络资源。
5. 正文的 HTML、脚本、远程图片与链接安全由所选 renderer 的既有策略负责；不关闭原生 CSP、不替用户打开不安全选项，也不另设“远程图片全部默认禁用”的 MDV 策略。自有侧栏 Webview 使用 nonce CSP、仅扩展 media 资源根、文本 DOM 与固定命令 allowlist，不接收文档提供的任意命令或路径。[Webview 资源与安全说明](https://raw.githubusercontent.com/microsoft/vscode-docs/main/api/extension-guides/webview.md)
6. Restricted Mode 仅保留受限只读查看，禁止保存、commit、checkout、图片导入和执行工具；权限检查放在实际入口，不仅隐藏按钮。[Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)

MDV FSP 默认允许本地资源根为当前 `.mdv` 所在目录。普通链接指向父目录或其他绝对位置时，用户可以通过 `mdv.additionalResourceRoots` 明确加入目录；不自动放开整个磁盘或用户目录，Restricted Mode 忽略额外目录。检查 realpath，不能只凭字符串前缀授权；普通资源单次读取上限 32 MiB。Markdown 图片语法支持该重映射；原始 HTML 资源 URL 仍受内置 preview 资源根约束，不声称所有 HTML URL 都已重新路由。

图片粘贴/拖放已使用 VS Code 对应 provider API，但剪贴板能否提供文件 bytes 与系统和来源应用有关，真实 OS 剪贴板格式覆盖仍待手测；不支持的数据回退到普通粘贴或“插入图片文件”，不声称任意剪贴板格式都已兼容。[VS Code API](https://code.visualstudio.com/api/references/vscode-api)

## 7. Agent 协作边界

Agent 工具方案在 [`agent_tool.md`](./agent_tool.md) 中单独维护。2026-09-10 的协议 v2 已开放查询、两棵树版本生命周期与受管资源；Reference 写入由 Agent 宿主显示确认并由 CLI flag fail closed。插件不读取 Agent 的内存，也不把自己的未保存 buffer 伪装成磁盘内容，Agent 只能看到已通过 Core 保存的状态。

首版通过“保存文件 + 外部变化检测 + CAS”协作，无 IPC、HTTP 服务或跨进程共享会话。VS Code 可以展示 CLI 保存后的内容，但安装插件不会自动给每个第三方 Agent 装配工具，也不保证其默认文本编辑器支持 `mdv:` URI。

## 8. 开发阶段与验收

| 阶段 | 交付 | 进入下一阶段的证据 |
| --- | --- | --- |
| P0 接入验证 | 独立 extension package、Core tarball consumer、最小虚拟编辑/保存、URI 与恢复验证、图片输入试验 | 开发宿主中真实打开/保存 `.mdv`；dirty 基线不会被外部刷新覆盖；确定最低 VS Code/内置 Node 版本 |
| P1 可编辑预览 | 新建、Ref/Doc 原生编辑、普通保存、图片插入、预览、外部变化与错误提示 | 实际图片文档可编辑并重新打开；Agent 保存时可刷新或提示冲突 |
| P2 版本闭环 | 两棵历史、显式 commit、精确 bind 对照、受保护 checkout、状态与诊断 | 完成下述真实用户场景；不要求复杂 Diff UI |
| P3 本地交付 | 可安装 VSIX、使用说明、独立安装与 Extension Host 回归 | 在未链接本仓库源码的 VS Code 中使用；记录各平台实际结果 |

P0–P3 的代码与本地 VSIX 已交付，当前定位是可安装的桌面本地预览版；下面的验收证据只覆盖实际运行的环境，不把跨平台、第三方渲染器和真实 Agent 工具联调用计划替代。

完整真实 Agent 联合验收场景仍是：用户创建 `.mdv` 并提交 Ref → Agent 读取该 Ref 和 Doc → Agent 保存新 Doc（不自动 commit）→ 插件展示新内容，用户插入图片并普通保存 → 用户 commit Doc 并绑定刚才的 Ref → Ref 和 Doc 图片后续继续演化 → 查看旧 Doc 时仍显示原绑定 Ref → 恢复旧 Doc 后，原 hash 图片引用仍正确。2026-09-09 已完成真实 CLI 的成对读取、Doc 保存和 clean/dirty 协作子场景；preview.2 协议与完整命令面需要重新跑安装版联合检查，不能用旧 v1 结果代替。

必须覆盖的回归：

- save 不增 Version；首次空 commit、bind-only commit、no-changes commit、空 Ref 和 unbound 正常呈现。
- 同包 Ref/Doc 都有未保存编辑；连续保存、保存全部部分失败、Agent 并发写、多窗口写均不静默丢内容。
- 两种 dirty 的 checkout 保护、关闭提示、reload 后恢复旧 buffer 与旧基线、包被替换或删除。
- 中文、空格、特殊 URI 字符、LF/CRLF、末尾换行和历史只读；仅查看不改 bytes。编辑器若规范化混合换行或单独 CR，明确告知其保存行为，不冒充 Core 原字节往返保证。
- 图片 hash 路径、普通相对/绝对路径、越界/损坏资源拒绝、原生远程资源策略；关闭所有视图后释放 watcher 和会话。
- macOS、Windows、Linux 分别执行插件安装与 Extension Host 测试；仅在有 GUI/系统证据的范围声明剪贴板、快捷键和渲染兼容。

### 8.1 本地验收记录（2026-09-08）

`preview.2` 在首版基线上额外覆盖普通文件系统创建 0 字节文件 → 默认打开关联 → 直接进入 Doc → 首次保存/图片回读，以及非空坏文件保护；本机安装版集成检查由 14 项增加到 16 项并通过。Core 全量测试为 188 通过、0 失败、1 项既有 Windows 专属 skip；首次保存的并发与发布前被修改也有回归。独立安装检查还通过空文件 Restricted Mode、真实 reload 后首次保存和外部修改冲突保护，不把尚未运行的平台算作通过。

- 环境：macOS arm64，VS Code 1.136.1，Extension Host Node 24.18.1。Manifest/API 类型基线为 VS Code 1.100；下载该最低版本连续失败，本轮未验证其运行时，不将类型检查通过等同于最低版本兼容。
- 原生编辑：读取与手动/延时自动保存不增 Version，两侧 dirty 连续保存不误报 mtime 冲突；撤销/重做、精确历史只读、bind 双栏、外部 clean 刷新、dirty 冲突、同路径更换 documentId 保护。
- 安装版完整集成检查 16 项通过，包含普通新建空文件、非空坏文件保护、真实 Save-before-commit、Doc 选择精确 Ref，以及同时存在编辑器 dirty / 已保存未提交 dirty 时的恢复确认；恢复后 Ref Head 不随 Doc 移动。
- 原生渲染：在真实预览 DOM 检查 hash 图片已完成加载且有自然宽度、表格已渲染、另一个测试扩展的 markdown-it 属性与 preview CSS 生效；保留截图。Markdown All in One 3.6.3 的编辑命令和保存通过定向检查，不代表其所有功能或其他扩展已验证。
- 安装生命周期：在独立临时目录安装实际 VSIX，不通过源码链接激活；从空文件开始编辑，真实 reload 后未保存正文恢复，无外部变化时可完成首次保存，外部 writer 获胜时不能被旧基线覆盖。恢复时同时处理激活前已存在的 `TextDocument`，并恢复持久化基线，不能将当前磁盘 generation 当成恢复草稿的新基线。Restricted Mode 允许包括空文件在内的读取、拒绝写入入口。
- 可重复入口：[`scripts/test-extension.mjs`](../../adapter/mdv_vscode/scripts/test-extension.mjs) 支持 `--installed`、`--restricted`、`--recovery`、`--empty-recovery` 与可选 `--markdown-extension`；安装检查会重新打包。workspace/user-data/extensions/shared-data 全部使用隔离临时目录，结果与截图保留在打印的位置，不向日常 VS Code 安装插件。
- 仍待验证：Windows/Linux GUI、最低 VS Code 运行时、多窗口竞争、所有关闭/hot-exit 情形、LF/CRLF 与混合换行宿主行为、真实剪贴板/拖入来源矩阵、第三方独立 renderer，以及 Agent CLI v2 完整生命周期联合流程。

### 8.2 preview.3 交互验收（2026-09-08）

本轮仅修改 adapter 展示与原生编辑布局，Core 生产代码、公开 API、ZIP、资源与事务规则未改变。独立 VSIX 安装回归共 **19 项通过**，环境仍为 macOS arm64、VS Code 1.136.1 / Node 24.18.1，包含 Markdown All in One 3.6.3。

- 普通空文件与已有 ZIP 均直接打开 Doc，路由标签随后释放，没有概览页面或正文 Diff。
- 双侧未保存时收起/展开任意一侧，正文/dirty/选区/undo/redo 保留，原生 TextDocument 没有关闭，磁盘 bytes 和 generation 不变；无关标签保持打开，随后两侧保存不创建版本。
- 隐藏的 Doc 遇到外部 writer 后，展开仍保留原文并拒绝陈旧保存，不用新 generation 重新绑定旧草稿。
- 真实侧栏 DOM 验证完整 parent 分支（包含非 HEAD 分支）、两列 HEAD、多对一绑定、全部反向使用方、高亮、unbound、精确历史打开/绑定来源、Ref 草稿状态与多包切换。图浏览前后包 bytes 一致。摘要 HTML 不执行，越包消息和非白名单命令被拒绝；CSP 没有因测试而放宽。
- 原有图片自然宽度、表格、第三方 markdown-it/CSS、Markdown All in One 编辑、commit/restore 对话框、外部 clean/dirty 和包替换保护继续通过。
- 两种真实窗口 reload 都从空文件开始，包含前台 Doc 与后台隐藏 Ref 的未保存正文。无外部变化时两侧恢复后可以依次保存；外部 writer 已保存 Doc 时，恢复的 Doc 陈旧写入被拒绝，磁盘未变化的 Ref 仍可保存。Restricted Mode 允许只读打开，写入口保持禁止。
- 完整验收必须使用 `--installed`：VS Code 标准 development test runner 禁用 modal 对话框。侧栏 DOM 测试先连接调试器，再恢复侧栏，使测试附着到实际 OOPIF；测试不以截图可见代替点击断言。

测试脚本将 `test-results.json`、`lifecycle-result.json`、`version-graph.png` 与 Markdown 预览截图保留在输出的隔离临时目录。上述结果不是最低版本/Windows/Linux 运行时或大型历史性能结论；当前完整 SVG 图尚未虚拟化。活动栏 SVG 使用宿主主题，Marketplace 位图和发布身份仍未决定。

### 8.3 preview.4–preview.6 交付（2026-09-09）

- `preview.4`：图形按侧栏可用宽高布局，两列与分支轨道随宽度重排，历史区使用剩余高度滚动；普通打开 `.mdv` 不切换或展开侧栏，只有用户显式执行 Show Version Graph 才聚焦它。
- `preview.5`：复现从另一个编辑组重复打开已有 dirty Doc 时的 `OverlayWebview has been disposed`。`resolveCustomEditor` 先返回，由入口 Webview 加载后的 ready 消息触发原生 Doc 打开，再释放入口；取消、关闭、后台与重复消息均受保护。不使用定时延迟掩盖问题，不增加概览 UI 或第二份正文。
- `preview.6`：活动栏直接复用 `docs/assets/mdv-icon.svg` 的猫头图标，未修改业务逻辑。TypeScript、VSIX 打包、XML 与包内资源一致性校验通过。
- 推送前最新 `preview.6` 基础安装回归 **20 项通过**，macOS arm64 / VS Code 1.136.1 / Extension Host Node 24.18.1；覆盖重复/并发打开、后台入口、dirty/undo、版本/图片、侧栏缩放与焦点。renderer 日志扫描未发现销毁错误。本次未装可选 Markdown All in One；此前 `preview.5` 含该扩展的 21 项、Restricted Mode 与两种真实窗口 reload 检查已经通过，不能把不同测试配置混作同一次执行。
- Core 新建空文件链路全量回归 189 项：188 通过、1 项既有 Windows 路径专用 skip。插件仍不声明未执行的其他平台、最低版本和任意第三方扩展兼容。

### 8.4 Agent CLI 联合检查（2026-09-09）

测试 runner 新增可选 `--agent-cli <已安装的 cli.cjs>`，同时传入实际 Node 路径。新增用例启动真实子进程，读取已提交 Ref 和当前 Doc，再保存 Doc；无未保存编辑时原生编辑器刷新，有人的未保存编辑时仍保留文本并拒绝旧基线覆盖，Ref、HEAD、版本均不变。没有修改插件生产代码或 Core。

该新增用例已通过，使用仓库外安装的 `@mdv/agent-tool`，不是直接调用 Core 冒充 CLI。完整运行最新为 **20/21 通过**：原生撤销用例连续复现失败，不能宣称整套通过；另一个缩放断言经截图确认忽略了原生竖滚动条占用，已改为比较实际 viewport 可用宽度，修正后通过。撤销问题及复现路径见 [O006](./open-questions.md#o006原生撤销回归在-agent-联合检查中失败)。旧版通过记录是当时环境的结果，不覆盖本次失败。

### 8.5 preview.7 工作副本级冲突判定（2026-09-10）

`preview.6` 只持久化整包 generation：Agent 保存 Doc 后，即使 Ref 的磁盘正文完全未变，dirty Ref 也会被标成 stale。`preview.7` 在 VS Code 会话层为 Ref/Doc 分别持久化 `contentBytes + contentSha256`，外部 generation 变化时只锁住正文实际变化的那一侧；Core 的整包 generation CAS、跨进程锁和原子替换保持不变。

新增安装版用例双向验证“外部保存 Doc + dirty Ref”和“外部保存 Ref + dirty Doc”均可继续保存，同时既有同侧前台/隐藏 dirty 冲突用例仍通过。真实窗口 `--recovery` 验证外部变化的 Doc 被拒绝、未变化的恢复 Ref 可保存，`--empty-recovery` 与 Restricted Mode 也通过。完整安装套件中的本次冲突用例均通过；套件其余仍有 3 项 CDP 连接返回 403、2 项原生 undo 行为失败，因此不把该次运行记作全套通过。

### 8.6 Agent CLI v2 联调适配（2026-09-10）

可选真实 CLI 用例已从 v1 的 `expectedDocumentId + expectedGeneration` 请求改为复制 `read --json` 返回的 Document `baseline`，与 `@mdv/agent-tool 0.1.0-preview.2` 协议一致。测试仍验证 clean editor 自动刷新、人的 dirty buffer 保留且陈旧保存被插件拒绝、Ref/HEAD/历史不变。

使用已经升级的个人 preview.2 runtime 和重新打包/隔离安装的 `mdv-vscode preview.7` 实跑，macOS arm64 / VS Code 1.136.1 / Extension Host Node 24.18.1 的完整套件 **22/22 通过**，真实 Agent CLI v2 子进程用例明确通过，renderer 日志没有 disposed Webview。证据保存在 `/var/folders/dj/qwyjs5wd0y7ftm7z5fn_27tr0000gn/T/mdv-vscode-test-hCs5z8/workspace/test-results.json`。本次原生 undo 也通过，但此前重复失败的 [O006](./open-questions.md#o006原生撤销回归在-agent-联合检查中失败) 仍作为间歇观察保留，不能由一次成功推断根因已经修复。

## 9. 本地分发与后续范围

第一目标是本地 VSIX，不自动发布 Marketplace。VSIX 应自带固定 Core 构建及运行依赖，不依赖用户全局安装 Core 或开发机上的 Node/源码路径；最低 VS Code 版本根据实际 API 和 Extension Host Node 能力确定。VS Code 官方允许通过 VSIX 安装未上架的扩展。[打包与安装说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions)

首版支持桌面 VS Code 与本机普通文件系统。Remote SSH / WSL / Dev Containers 需要扩展运行位置、远端资源 URI 和 Node 的单独验证，vscode.dev 与任意虚拟文件系统不默认支持。

后续再讨论：VS Code 内置 Agent 工具注册、MCP 自动装配、WYSIWYG、同步滚动、富 Diff、资源打包分享和 MarkText 接入。活动栏已复用项目猫头 SVG；Marketplace 图标仍需另行准备合规位图。本轮不选择许可证或创建发布身份。
