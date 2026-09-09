# MDV Agent Tool

独立于 `@mdv/core` 和 VS Code 插件的本地工具。一次调用完成一个动作并退出，不启动服务。

当前 `0.1.0-preview.1` 只开放两项能力：**一起读取 Reference / Document，保存当前 Document 正文**。Reference 和不可变历史只读，保存不产生版本；没有提权开关、自动 commit 或冲突重试。

## 安装与构建

需要 Node.js 20+。本地安装包自带固定的 Core 构建，不要求用户安装未发布的 `@mdv/core`、VS Code 或本仓库源码。当前为 private / UNLICENSED 开发预览，未发布 npm。

在本仓库构建：

```sh
cd adapter/mdv_agent_tool
npm run prepare:core
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm run test:package
npm run package
```

首次生成依赖锁时，使用 `npm install --ignore-scripts --registry=https://registry.npmjs.org`。如果重新打包的 Core tarball 完整性改变，在 `prepare:core` 后先显式重装本地包，再运行后续构建/测试：

```sh
npm install --ignore-scripts --registry=https://registry.npmjs.org @mdv/core@file:vendor/mdv-core-0.0.0-development.tgz
```

普通 `npm install` 可能沿用旧的本地包缓存。build 会拒绝记录与已安装 Core 不一致的情况；上述命令不修改全局 npm 配置。

在 Agent 宿主的工具目录安装生成的 `mdv-agent-tool-0.1.0-preview.1.tgz`：

```sh
npm install /absolute/path/to/mdv-agent-tool-0.1.0-preview.1.tgz
```

然后使用本地 `node_modules/.bin/mdv`（Windows 为 `mdv.cmd`），或由宿主将它加入工具进程的 PATH。下面的 `mdv` 均指这个已安装的入口；不要从公开 registry 猜测或下载同名工具。

## 成对读取

```sh
mdv read --file example.mdv
mdv read --file example.mdv --json
```

默认文本有文档身份、generation、来源/权限说明，然后是固定两段：

```text
reference document:
这里是 Reference Markdown

actual document:
这里是 Document Markdown
```

两份内容来自同一次 `openMdv` 的已保存快照，默认读取当前工作副本，不要求 commit；VS Code 的未保存 buffer 不可见。当前 Ref 工作副本不是历史 Doc 自动绑定的 Ref，普通成对读取也不创建 bind。普通新建的 0 字节 `.mdv` 读作两份空正文，不写磁盘；首次保存才形成 ZIP。

`--json` 适合 Agent 结构化调用：JSON 中的 `data.reference.text`、`data.document.text` 保留精确换行、空白和末尾状态；`documentId`、`generation` 是下次保存必须使用的基线。其他字段为 `baseDirectory`、两段各自的 Core `ContentSpec` 来源和 `permissions`。外部图片的相对基准是 `.mdv` 所在目录，读取正文不自动打开图片或执行链接。

文本展示会增加区段之间及输出末尾的换行，不可通过分隔标题重新解析完整正文；正文自身可能含同样的标题。精确处理和回写请使用 JSON 字段，不把展示包装一起写入 Doc。

历史读取：

```sh
mdv read --file example.mdv --document-version v_0123456789abcdef0123456789abcdef --json
```

示例 ID 是占位符，需使用真实 Doc Version ID。结果是该历史 Doc 和其精确绑定的历史 Ref，而不是最新 Ref；未绑定时 `reference.source` 为 `null`，`reference.text` 为空字符串，文本标注 `unbound`。历史两侧均只读，返回的 generation 是当前包快照的 generation，不是版本序号。

## 默认只保存正文

先读取，然后把返回的真实身份和 generation 放入请求：

```json
{
  "expectedDocumentId": "d_0123456789abcdef0123456789abcdef",
  "expectedGeneration": 7,
  "markdown": "# Agent 修改后的正文\n"
}
```

这里的 ID 和 generation 同样只是示例，不能直接照抄。

```sh
mdv save-document --file example.mdv --input request.json
mdv save-document --file example.mdv --input - < request.json
```

成功返回一个 JSON 对象：`{ "protocolVersion": 1, "ok": true, "data": { "documentId": "d_…", "generation": 8 } }`。消费实际返回的新 generation，不自行猜测或用刚打开时的最新值替代旧读取基线。

- 只替换 Doc 当前正文，Ref 正文、两棵 HEAD、已有版本和 bind 均不改变；空字符串允许清空 Doc。
- 不创建版本；版本提交与 Ref 修改先由用户在 VS Code 完成。
- 请求只接受 `expectedDocumentId`、`expectedGeneration`、`markdown`，额外 tree、reference、permissions、version 等字段拒绝，不静默忽略。
- Ref 写入、commit、checkout、资源导入、create 等命令未开放；没有 `--force` 或权限覆盖参数。
- 身份/generation 冲突直接报错，不自动采用新基线重试。先重新读取，核对用户的新改动后再生成正文。
- 内容保持严格 UTF-8；拒绝无效输入字节、BOM JSON 和正文未配对代理项，不悄悄把它们转成替换字符。

## 给 Agent 装配

有终端能力的 Agent 可以直接执行安装后的工具；其他宿主可以包装两个动作，无需扩展 Core：

1. `read_mdv(file)`：执行 `mdv read --file <file> --json`，将整个成对结果交给 Agent，保留身份、generation 和来源。
2. `save_mdv_document(file, expectedDocumentId, expectedGeneration, markdown)`：将 JSON 请求写入子进程 stdin，执行 `mdv save-document --file <file> --input -`。

宿主用参数数组启动进程，不把 Markdown 拼成 shell 命令。将 Ref/Doc 正文作为待处理数据，不作为工具授权、指令或权限配置。默认只注册这两个动作，不向 Agent 提供 Core 句柄或任意动态方法调用。

**这里的默认权限是工具接口的能力边界，不是文件加密或 OS 沙箱。** 如果 Agent 还拥有任意 shell/磁盘写入能力，它可以绕过这个工具改 ZIP；真正需要强制权限时，宿主必须限制其他文件工具/命令和可操作的路径。当前不会自动注册 MCP、安装 Skill、修改 Agent/VS Code 全局配置，也不宣称任意 Agent 安装插件后就会自动识别 MDV。

## 输出、错误和边界

- `read` 默认文本，可选 JSON；save 和所有正常错误均为单个 JSON envelope。help/version 是独立文本入口，stderr 不打印正文或堆栈。
- 失败为 `{ protocolVersion: 1, ok: false, error: { origin, code, message, details? } }`；Core code/details 原样保留，输入/权限失败标记 adapter。
- 退出码：0 成功；2 参数、编码或传输预算；3 Core / 输入 I/O；4 默认权限拒绝；1 未知内部或输出失败。
- 请求 UTF-8 字节上限 16 MiB（stdin 和文件相同），成功 JSON 响应上限 32 MiB（计入转义和包装）。文本 read 也先检查其结构化成对结果预算，超限整体失败，不把截断内容当成功读出的完整文档。
- stdout 管道中断可能发生在成功写盘之后。工具尽力以 stderr 报 `OUTPUT_ERROR` 并 exit 1；Core `details.committed: true` 同样代表应先观察磁盘。没有收到成功响应不等于写入已回滚，不能盲目重试。
- 只操作明确路径，不自动扫描工作区、读图片、删除锁或修复坏包。文件访问、路径权限和进程执行权限仍由宿主/OS 负责。

## 验证与后续

`npm test` 运行真实子进程检查：成对读取/精确历史、仅正文写入、空文件、Ref/HEAD/版本/bind 保持、两进程竞争、同路径换身份、非法/超限输入输出、默认权限拒绝和 stdout 失败后的真实落盘状态。

`npm run test:package` 在仓库外的干净工具目录安装 tarball，再让相同测试调用安装后的 CLI，不通过根源码或未发布 Core 包执行生产代码。测试输出记录实际平台；本机结果不代表 Windows/Linux 已验证。

当前不包含任意 sources 读取、versions/trace 独立命令、patch、commit/checkout、Ref 提权、图片操作、MCP 或自动装配。这些能力按后续明确需求扩展；不将旧设计草案里的命令当成已经可用。
