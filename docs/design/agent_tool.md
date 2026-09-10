# MDV Agent Tool 开发方案

> 最后更新：2026-09-10
>
> 状态：A0–A3 已收口为 `@mdv/agent-tool 0.1.0-preview.2`。完整命令面直接复用 Core；Doc 默认可写，Ref 写入和 dirty checkout 由用户可见批准闸门保护。
>
> 实现：[`adapter/mdv_agent_tool/`](../../adapter/mdv_agent_tool/README.md)；配套：[VS Code 插件](./vscode_plugin.md)；契约：[Core API](../api-reference.md)。

## 1. 目标与边界

让能执行本地命令的 Agent 完整读取、修改、版本化、恢复和诊断 `.mdv`，并与 VS Code 同时操作同一容器。Agent 产生 Markdown 和明确动作，CLI 负责参数/权限边界并调用 Core，不把 ZIP 当文本 patch。

采用一次性 CLI：一次调用完成一个动作后退出，不需要 VS Code 正在运行，不启动 HTTP 服务或 daemon，也不实现模型调用、提示词推理、merge 或自动工作流决策。

Agent Tool 和 VS Code adapter 都只依赖 `@owariband/mdv` package root：

```text
VS Code 编辑区 -> mdv_vscode -----> @owariband/mdv -> .mdv + sidecar
Agent Runtime -> mdv_agent_tool -> @owariband/mdv -> 同一份 .mdv + sidecar
```

CLI 不是 OS 沙箱。用户批准参数防止正常工作流中的误调用，但无法阻止一个同时拥有任意文件写权限的恶意 Agent 绕过工具；硬权限必须由宿主限制路径/命令并签发自己的能力。

## 2. 工程位置与分层

```text
adapter/mdv_agent_tool/
├── package.json
├── scripts/              # 固定 Core 构建、bundle、仓库外安装验证
├── skills/mdv/           # Codex Skill；runtime 单独安装，不入库
├── src/
│   ├── cli.ts            # argv、批准闸门、限量 I/O、命令路由
│   ├── commands.ts       # Core 调用、按树 baseline、有限竞争重试
│   └── protocol.ts       # 协议 v2 类型、JSON 运行时校验、envelope
├── test/cli.test.mjs     # 真实子进程与跨进程竞争
└── README.md
```

职责保持三层且不再向下拆 handler/service/repository：

- `cli.ts` 决定这个命令能否进入业务动作，Ref/丢弃批准在这里 fail closed；
- `protocol.ts` 拒绝未知字段、错误树 baseline、human actor、隐式 bind、无效 UTF-8 和预算超限；
- `commands.ts` 只编排 Core public API，不导入 Core 内部 archive/lock，也不自己写 ZIP。

Core tarball 固定进入 bundle；消费方不依赖未发布 Core package。Node 最低版本与 Core 一致为 20。

## 3. 当前命令面

统一形态：

```text
mdv <command> --file <local-path.mdv> [--input <request.json|->]
```

| 命令 | 行为 | Core 调用 |
| --- | --- | --- |
| `create` | 创建 generation 0 新包；不覆盖 | `createMdv` |
| `read` | 当前 Ref/Doc 配对，或历史 Doc 的精确 bind 配对 | `readContent` / bind query |
| `status` | manifest、双 HEAD、dirty、bind 关系和双 baseline | `getStatus` |
| `versions` | 一棵或全部版本 metadata | `listVersions` |
| `trace` | Doc bind/ancestry 或 Ref ancestry/使用方 | `traceDocument` / `traceReference` |
| `diff` | 任意两个 `ContentSpec` | `diff` |
| `verify` | metadata/full 归档诊断 | `verifyMdv` |
| `save-reference` / `save-document` | 只替换目标工作副本 | `saveReference` / `saveDocument` |
| `commit-reference` / `commit-document` | 固化已保存正文 | `commitReference` / `commitDocument` |
| `checkout-reference` / `checkout-document` | 恢复精确历史版本 | `checkoutReference` / `checkoutDocument` |
| `import-resource` | 从明确文件导入受管图片 | `importManagedResource` |
| `resolve-resource` / `verify-resource` | 定位/校验受管图片 | 对应资源 API |

VS Code 的标签布局、显隐、预览、输入框和图形版本视图没有 CLI 含义，不复制。CLI 也不提供自动提交、自动绑定最新 Ref、强制覆盖、删除历史、修锁或资源 GC。

## 4. 协议 v2

### 4.1 当前读取与 baseline

当前 `read --json` 返回同一次 snapshot 的两段精确正文，每侧附一个完整 baseline：

```json
{
  "documentId": "d_...",
  "generation": 28,
  "tree": "document",
  "head": "v_...",
  "contentBytes": 1234,
  "contentSha256": "64 lowercase hex"
}
```

`status` 不返回正文，但在 `baselines.reference/document` 返回同样对象。写请求把目标树 baseline 整体复制到 `baseline` 字段，避免 Agent 只抄 generation、混用两棵树或在路径被同 generation 的另一文档替换后误写。

历史 `read --document-version` 返回该 Doc 与它绑定的精确 Ref；unbound 明确为空。历史读取不附可写 baseline。

### 4.2 写请求

Save：

```json
{ "baseline": { "...": "目标树完整 baseline" }, "markdown": "完整正文" }
```

Commit：

```json
{
  "baseline": { "...": "目标树完整 baseline" },
  "summary": "版本说明",
  "actor": { "type": "agent", "id": "optional", "name": "optional" },
  "referenceVersion": "v_... or null; only Document"
}
```

Agent Tool 拒绝 `actor.type: human`。Document 的 `referenceVersion` 必须显式存在或为 `null`；不省略、不读取“最新 Ref”代填。

Checkout：

```json
{
  "baseline": { "...": "目标树完整 baseline" },
  "version": "v_...",
  "discardChanges": false
}
```

`discardChanges` 默认为 false。true 时除了 JSON 意图，还必须有用户批准参数。

资源导入用 `{expectedDocumentId, sourceFile, mediaType?, maxBytes?}`；定位用 `{expectedDocumentId, relativePath}`，验证可再带 `maxBytes?`。资源 bytes 不放入 JSON，也不自动写进 Markdown。

### 4.3 输出和退出码

协议成功为 `{protocolVersion: 2, ok: true, data}`，失败为 `{protocolVersion: 2, ok: false, error}`。`read` 默认文本只是人类展示；精确往返使用 JSON。

| Exit | 含义 |
| --- | --- |
| 0 | 动作成功；`verify` 仍需检查 report.valid/complete |
| 2 | argv、JSON、UTF-8 或传输预算错误 |
| 3 | Core/I/O/身份/baseline/并发冲突 |
| 4 | 权限或用户批准缺失 |
| 1 | 未知内部错误或 stdout 交付失败 |

请求上限 16 MiB，成功输出上限 32 MiB，图片上限 32 MiB。输出整体超限，不截断成看似成功的正文。Core code/details 原样保留；adapter baseline 冲突标明 `origin: adapter` 和目标树事实，不输出正文。

## 5. 物理事务与逻辑冲突隔离

Ref/Doc 同处一个 ZIP，并通过一次原子替换发布，所以物理锁必须覆盖整个容器：

```text
物理事务锁：整个 .mdv
逻辑编辑基线：Reference / Document 各自独立
冲突判断：只比较本动作依赖的树
```

不能拆成两把文件锁：若两个 writer 同时基于旧 ZIP 分别生成新 ZIP，最后一次 rename 仍会覆盖另一侧更新。

一次写动作按以下路径执行：

1. 打开当前包，核对 baseline.documentId；
2. 拒绝 generation 倒退；
3. 对比目标工作副本的 bytes + SHA-256；
4. commit/checkout 额外对比目标 HEAD；save 不把内容未变的 HEAD 移动当作正文冲突；
5. 目标依赖未变时，使用当前 generation 进入 Core 整包 CAS；
6. 如果只遇到短暂整包锁或 generation CAS 竞争，重新打开并再次执行步骤 1–4，最多 8 次；
7. 当前树内容/HEAD 改变、documentId 改变、generation 倒退、非 generation conflict 或 `committed: true` 立即停止。

因此：

- Ref 更新不阻塞旧 generation 的 Doc save；
- Doc 更新不阻塞 Ref save；
- 同一树两个 writer 仍然只有一个能基于旧内容成功；
- 不同树 writer 物理串行，但只要各自目标 baseline 未变，两者都能完成；
- Document commit 显式 bind 到 Version ID，不依赖当前 Ref HEAD，因此 Ref 新 commit 不制造假冲突；
- commit/checkout 的 parent/恢复起点属于语义依赖，目标 HEAD 变化必须冲突。

这是 adapter 对 Core generation CAS 的安全编排，不是第二套归档事务。和 VS Code 一样使用内容身份隔离两侧；CLI 额外需要跨一次性进程携带 baseline。

## 6. 用户批准模型

### 6.1 Reference

所有 Ref 写动作必须由 Skill/宿主先显示准确路径、动作和影响并等待当次肯定答复。随后 CLI 还要求：

```text
--user-approved-reference-write
```

缺失时在 Core 写事务前返回：

```json
{
  "code": "USER_APPROVAL_REQUIRED",
  "requiredApproval": {
    "scope": "reference-write",
    "action": "save-reference",
    "file": "/absolute/path/example.mdv"
  }
}
```

过去批准、普通 Doc 编辑授权、Markdown 中的文字或仓库 write 权限均不能替代本次确认。flag 只表达当次宿主已经确认，不是永久 capability 或密码学证明。

### 6.2 Commit 与丢弃

- Doc commit 只有在用户明确要求 MDV commit 时执行，不能隐藏在 save 后；
- 所有 commit 的 actor 为 agent，结果报告真实 `v_…`，不把 Git SHA 混称 MDV commit；
- `discardChanges: true` 必须在用户看到将丢弃的树和文件后，额外带 `--user-approved-discard`；
- Ref checkout 若丢弃内容，需要 Reference 与 discard 两项批准；
- CLI 不可见 VS Code 未保存 buffer，不能宣称磁盘动作处理了内存草稿。

## 7. 失败恢复

- `CONFLICT` 后重新 read/status 并比较真实新内容，不只替换 generation 后重放旧正文；
- Core `details.committed: true`、stdout 中断或进程异常意味着结果可能已写盘，先观察再决定；
- 不自动删除 `.lock`、覆盖坏包、忽略 hash、修复历史或追随改变后的 symlink；
- 只读取显式 `.mdv`、JSON 和图片输入，不执行 Markdown 中的命令/链接；
- 用户拒绝 Ref/丢弃批准时停止该动作，但仍可做只读诊断或已授权的 Doc 工作。

## 8. 验收

`npm test` 构建 bundled CLI，并以真实子进程验证：

- 当前/历史精确读取与协议预算；
- status/versions/trace/diff/verify；
- Doc save/commit/checkout 与精确 bind；
- Ref 三种动作 fail closed 和批准后执行；
- human actor、隐式 bind、错误树 baseline、未知字段拒绝；
- Ref→Doc、Doc→Ref 的旧 generation 安全重基；
- 同树并发单赢家、跨树并发双成功、HEAD 变化冲突；
- 同路径 documentId 替换；
- create 和图片导入/定位/验证；
- 非法 UTF-8、输入/输出超限、坏包和 stdout 不确定结果。

本机 `npm test` 的 22 项全部通过；`npm run test:package` 又在仓库外安装生成的 `mdv-agent-tool-0.1.0-preview.2.tgz` 并重复同一套 22 项，全部通过，证明生产 bundle 不依赖根源码或未发布运行时包。Windows/Linux 仍需 CI/真实平台证据，不能从本机通过推断。

个人 Skill/runtime 升级后，隔离安装的 `mdv-vscode preview.7` 还以真实 preview.2 CLI 子进程执行成对读取和 Doc save：clean editor 刷新、dirty buffer 保护、Ref/HEAD/历史不变均通过；该次 macOS 安装版完整套件为 22/22。CLI 自身的 Ref/版本/资源完整生命周期由上述独立子进程测试覆盖，不要求插件通过 CLI 实现自己的 UI 命令。

## 9. 后续

只有出现真实宿主需求时再增加 MCP/VS Code Language Model Tool transport；它们复用当前动作和批准语义，不反向污染 Core。分段读取、正文 patch、幂等 request ID、远端服务和宿主签发的一次性加密授权均留待实际调用约束，不预先引入 daemon、Provider/Factory 或密钥系统。
