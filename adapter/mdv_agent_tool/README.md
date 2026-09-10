# MDV Agent Tool

独立于 VS Code 插件的一次性本地 CLI。`0.1.0-preview.2` 直接调用固定构建的 `@owariband/mdv` Core，提供成对读取、两棵版本树、Diff/Trace/诊断、Doc 完整生命周期、经用户显式批准的 Ref 写操作，以及受管图片；不启动服务，也不把 ZIP 当文本修改。

## 能力与权限

| 能力 | 命令 | 权限约束 |
| --- | --- | --- |
| 当前 Ref + Doc / 精确历史配对 | `read` | 只读 |
| 状态、版本、Trace、Diff、完整性 | `status`、`versions`、`trace`、`diff`、`verify` | 只读 |
| Doc 工作副本 | `save-document` | 必须携带 `read/status` 返回的 Doc baseline |
| Doc 版本 | `commit-document` | 必须是用户明确要求的独立动作；显式 bind 或 `null` |
| Doc 恢复 | `checkout-document` | 丢弃 dirty 工作副本时必须显式批准 |
| Ref 工作副本与版本 | `save-reference`、`commit-reference`、`checkout-reference` | 每次执行前必须向用户展示操作并获得批准 |
| 新建与受管图片 | `create`、`import-resource`、`resolve-resource`、`verify-resource` | 明确目标路径/输入文件；不覆盖已有包 |

Agent commit 只允许 `actor.type: "agent"`，不能冒充 human。保存不自动 commit；Document commit 不自动选择最新 Ref。

## 安装与构建

需要 Node.js 20+。本地安装包自带固定 Core，不要求消费方安装未发布的 `@owariband/mdv`、VS Code 或本仓库源码。当前 package 为 private、采用 [Apache-2.0](LICENSE) 的开发预览，尚未发布 npm。

```sh
cd adapter/mdv_agent_tool
npm run prepare:core
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm run test:package
npm run package
```

如果 `prepare:core` 生成了不同完整性的本地 Core tarball，需要显式重装后再构建：

```sh
npm install --ignore-scripts --registry=https://registry.npmjs.org @owariband/mdv@file:vendor/owariband-mdv-0.0.0-development.tgz
```

安装生成的工具包：

```sh
npm install /absolute/path/to/mdv-agent-tool-0.1.0-preview.2.tgz
```

下文的 `mdv` 指安装目录中的 `node_modules/.bin/mdv`（Windows 为 `mdv.cmd`）。不要从公开 registry 猜测或下载同名包。

## 命令概览

```text
mdv create --file <path.mdv> [--markdown-profile gfm]
mdv read --file <path.mdv> [--json] [--document-version <version-id>]
mdv status --file <path.mdv>
mdv versions --file <path.mdv> [--tree reference|document]
mdv trace --file <path.mdv> --tree <reference|document> --version-id <id>
mdv diff --file <path.mdv> --input <request.json|->
mdv verify --file <path.mdv> [--mode metadata|full]

mdv save-document --file <path.mdv> --input <request.json|->
mdv commit-document --file <path.mdv> --input <request.json|->
mdv checkout-document --file <path.mdv> --input <request.json|-> [--user-approved-discard]

mdv save-reference --file <path.mdv> --input <request.json|-> --user-approved-reference-write
mdv commit-reference --file <path.mdv> --input <request.json|-> --user-approved-reference-write
mdv checkout-reference --file <path.mdv> --input <request.json|-> --user-approved-reference-write [--user-approved-discard]

mdv import-resource|resolve-resource|verify-resource --file <path.mdv> --input <request.json|->
```

除 `read` 的默认人类展示和 `--help/--version` 外，成功与失败都是单个 JSON envelope。

## 读取与按树 baseline

```sh
mdv read --file example.mdv --json
```

`data.reference.text` 与 `data.document.text` 是同一次已保存快照中的精确 Markdown。VS Code 尚未保存的 buffer 不可见。当前读取还为两侧分别返回可复制的 baseline：

```json
{
  "documentId": "d_0123456789abcdef0123456789abcdef",
  "generation": 28,
  "tree": "document",
  "head": "v_0123456789abcdef0123456789abcdef",
  "contentBytes": 1234,
  "contentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

真实调用必须复制工具返回的整个 baseline，不能自行构造、只更新 generation 或把 Ref baseline 用于 Doc。`status` 在 `data.baselines.reference/document` 返回相同结构，不返回正文。

历史配对读取：

```sh
mdv read --file example.mdv --document-version v_0123456789abcdef0123456789abcdef --json
```

结果是该 Document Version 和它精确绑定的历史 Ref；unbound 时 `reference.source` 为 `null`、正文为空。历史两侧只读，因此不返回可写 baseline。相对图片/链接以 `baseDirectory`（`.mdv` 所在目录）为基准。

默认文本仍使用固定的 `reference document:` / `actual document:` 标题，但正文自身也可能包含这些字符串。精确处理必须使用 JSON 字段，不能从展示文本切割后回写。

## Doc 保存、提交与恢复

保存当前 Doc 工作副本：

```json
{
  "baseline": { "这里复制": "data.document.baseline 的完整真实对象" },
  "markdown": "# Agent 修改后的完整正文\n"
}
```

```sh
mdv save-document --file example.mdv --input request.json
mdv save-document --file example.mdv --input - < request.json
```

保存只更新 Doc `current.md`，不移动 HEAD、不创建 Version、不改变 Ref 或 bind。成功结果带新 `generation` 和可直接用于后续独立动作的新 Doc `baseline`。

显式提交已经保存的 Doc：

```json
{
  "baseline": { "这里复制": "最新 Doc baseline" },
  "summary": "Add VideoRAG modernization boundary",
  "actor": { "type": "agent", "name": "Codex" },
  "referenceVersion": "v_0123456789abcdef0123456789abcdef"
}
```

`referenceVersion` 必须是实际使用的精确 Ref Version，也可以显式为 `null`；字段不能省略。成功结果明确返回 `created`，创建时返回真正的 MDV `v_…`，不能把 Git SHA 称为 MDV commit。

恢复历史 Doc：

```json
{
  "baseline": { "这里复制": "最新 Doc baseline" },
  "version": "v_0123456789abcdef0123456789abcdef",
  "discardChanges": false
}
```

默认拒绝覆盖 dirty 工作副本。只有用户看见并批准丢弃内容后，才将 `discardChanges` 设为 `true`，同时追加 `--user-approved-discard`；只加参数或只改 JSON 都不够。

## Ref 的可见用户批准

执行任何 Ref 写操作前，Agent 必须在对话中说明准确文件、动作和影响并等待用户肯定答复。例如：

> 是否允许我保存 `/path/example.mdv` 的 Reference 工作副本？这会修改 Ref，但不会自动创建版本。

获得本次操作的批准后，才允许在对应命令上添加：

```text
--user-approved-reference-write
```

缺少该参数时，CLI 在进入 Core 写事务前以 exit 4 失败：

```json
{
  "protocolVersion": 2,
  "ok": false,
  "error": {
    "origin": "adapter",
    "code": "USER_APPROVAL_REQUIRED",
    "message": "...",
    "requiredApproval": {
      "scope": "reference-write",
      "action": "save-reference",
      "file": "/absolute/path/example.mdv"
    }
  }
}
```

此参数是 fail-closed 的误操作防线和明确审计语义，不是密码学用户证明。CLI 无法证明通用 Agent 是否真的展示过问题；需要硬隔离时，宿主还必须限制任意 shell/文件写权限并签发自己的授权能力。批准一次只对应用户刚确认的准确动作，不得推广成后续 Ref 写入的永久许可。

Ref save/commit/checkout 的请求分别与 Doc 同形，只把 baseline 换成 `reference`；Reference commit 不接受 `referenceVersion`。Ref checkout 同样默认保护 dirty 内容；需要丢弃时必须同时具备两个批准参数。

## 查询、Diff 与诊断

```sh
mdv status --file example.mdv
mdv versions --file example.mdv --tree document
mdv trace --file example.mdv --tree document --version-id v_0123456789abcdef0123456789abcdef
mdv verify --file example.mdv --mode full
```

`verify` 即使发现损坏也会以 `ok: true` 返回诊断报告；调用方必须检查 `data.report.valid` 与 `complete`。

任意两个 Core `ContentSpec` 的 Diff：

```json
{
  "from": { "tree": "document", "kind": "version", "version": "v_0123456789abcdef0123456789abcdef" },
  "to": { "tree": "document", "kind": "working-copy" },
  "contextLines": 3
}
```

`trace document` 返回该 Doc 的 ancestry 与精确 Ref；`trace reference` 返回 Ref ancestry 和直接使用它的全部 Doc Versions。

## 受管图片

导入只读取明确指定的本地图片文件，支持 Core 的 PNG/JPEG/GIF/WebP 检查：

```json
{
  "expectedDocumentId": "d_0123456789abcdef0123456789abcdef",
  "sourceFile": "/absolute/path/cat.png",
  "mediaType": "image/png",
  "maxBytes": 33554432
}
```

成功返回可插入 Markdown 的 `relativePath`。导入 sidecar 不改变 `.mdv` generation。`resolve-resource` / `verify-resource` 请求为：

```json
{
  "expectedDocumentId": "d_0123456789abcdef0123456789abcdef",
  "relativePath": "./.mdv-assets/d_.../<sha256>.png"
}
```

## 并发与冲突隔离

`.mdv` 是一个通过原子替换发布的 ZIP，所以物理事务锁始终覆盖整个容器。Ref/Doc 的逻辑 baseline 独立：

```text
物理写盘：整个 .mdv 串行
冲突判断：只检查本次操作依赖的树
```

- generation 未变化时正常进入 Core CAS；
- generation 已前进、但目标树内容未变时，save 可以安全采用当前 generation；
- commit/checkout 还要求目标树 HEAD 未变；
- 另一棵树的保存/提交不制造假冲突；
- 目标树内容或依赖的 HEAD 变化时返回 `CONFLICT`，不覆盖赢家；
- 短暂整包锁竞争和 generation CAS 竞争会在每次重新核对目标树后有限重试，不重放旧正文；
- documentId 改变、generation 倒退或 `details.committed: true` 永不自动重试。

这与 VS Code 插件的按工作副本 content identity 保护一致，不把物理 ZIP 锁错误拆成两把可并发覆盖的文件锁。

## Codex Skill 装配

仓库提供 [`skills/mdv/`](https://github.com/owariband/mdv/tree/main/adapter/mdv_agent_tool/skills/mdv)。先通过 skill-installer 固定审核过的提交安装技能，再把本地 tarball 安装到该技能自己的 `runtime/`：

```sh
npm install --prefix /absolute/path/to/skills/mdv/runtime --ignore-scripts --omit=dev --no-audit --no-fund /absolute/path/to/mdv-agent-tool-0.1.0-preview.2.tgz
node /absolute/path/to/skills/mdv/runtime/node_modules/@mdv/agent-tool/dist/cli.cjs --version
```

Skill 负责选择命令、保持 baseline、在 Ref/丢弃操作前向用户提问，并如实区分 save、MDV commit 与 Git commit。它不扩大 OS 权限、不自动安装 MCP，也不允许通过 Core/unzip/普通文本写入绕过 CLI 授权。

## 输出、错误与验证

- 协议版本为 `2`；失败 envelope 保留 Core code/details，adapter 输入、批准和 baseline 错误有明确来源。
- 退出码：0 成功；2 参数、编码或预算；3 Core、I/O 或冲突；4 权限/用户批准缺失；1 未知内部或输出失败。
- JSON 请求上限 16 MiB，成功输出上限 32 MiB，图片上限 32 MiB；超限整体失败，不返回可误用的截断正文。
- stdout 中断或 Core `details.committed: true` 表示写入结果可能已经发布。先重新 `read/status`，不能盲目重放。
- CLI 不删除锁、不强修坏包、不执行 Markdown 内容、不扫描工作区，也不提供 merge、patch、资源 GC、MCP 或常驻服务。

`npm test` 使用真实子进程覆盖完整命令面、Ref/丢弃批准、精确 bind、按树冲突隔离、同树单赢家、跨树并发、身份替换、预算与输出不确定性。`npm run test:package` 会在仓库外安装 tarball 后重复同一套测试，不通过根源码执行生产 CLI。
