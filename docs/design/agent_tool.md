# MDV Agent Tool 开发方案

> 最后更新：2026-09-09
>
> 状态：A0/A1 最小默认权限版已在本地实现，产物为 `@mdv/agent-tool 0.1.0-preview.1`；当前只开放 `read` 和 `save-document`。原来的完整命令面保留为远期草案，不是当前能力。
>
> 实现位置：当前仓库的 [`adapter/mdv_agent_tool/`](../../adapter/mdv_agent_tool/README.md)，独立 package；第一版采用一次性 CLI。
>
> 配套方案：[VS Code 插件](./vscode_plugin.md)；当前契约：[Core API](../api-reference.md)；排期：[路线图](./roadmap.md)。

## 1. 目标与非目标

让能执行本地命令的 Agent 安全读取、修改和追踪 `.mdv`，同时让人能在 VS Code 中查看这些结果。Agent 输出 Markdown 内容，工具负责调用 Core，不能把 ZIP 当作 UTF-8 文件直接 patch。

第一版是本地 CLI：一次调用处理一个动作，输出结果后退出。它不需要 VS Code 正在运行，不启动 HTTP 服务或后台 daemon，也不实现 Agent Runtime、模型调用、提示词推理或自动工作流决策。

Core 已经提供 read/save/commit/checkout/trace/status/diff/verify 和图片 API；Agent 专用的 argv、JSON envelope、退出码和工具说明属于本 adapter。代码依据是 [`src/index.ts`](../../src/index.ts)、[`src/types.ts`](../../src/types.ts) 和 [`src/mdv-document.ts`](../../src/mdv-document.ts)。

### 1.1 当前交付与默认权限（2026-09-09）

用户明确要求保留 ZIP 容器，Agent 读取时同时获得 Ref 和正文，默认只能修改正文。该要求收窄原 A1 的“两树 save”，也覆盖原先 stdout 一律 JSON 的草案：

- `mdv read --file <path.mdv>` 默认文本，固定 `reference document:` / `actual document:` 两段，另附身份、generation、来源与权限说明；`--json` 返回精确字符串和结构化字段。
- 当前读取来自同一次 Core 打开的两份已保存工作副本；不创建 bind，不读取 VS Code 未保存 buffer。`--document-version <id>` 读取历史 Doc 及其精确绑定的历史 Ref，unbound 明确为 `source: null`，不使用最新 Ref 顶替。
- `mdv save-document --file <path.mdv> --input <request.json|->` 只接受 `expectedDocumentId`、`expectedGeneration`、`markdown`；只保存 Doc 工作副本。Ref、两棵 HEAD、版本和 bind 均不改变，不自动 commit。
- Ref 写入、commit/checkout、资源导入、create 均不开放；禁止历史写目标、额外 tree/permissions 字段和提权开关。权限校验发生在实际 CLI 入口，不只是工具描述或提示词。
- 这是工具能力限制，不是 OS 沙箱；若 Agent 还有任意 shell/文件写权限，宿主仍须限制绕过工具的途径和路径范围。MCP、Skill 安装和宿主自动注册均未实现。
- `src/cli.ts` 管参数、限量 I/O 与退出码；`commands.ts` 只调用 Core public API 并核对跨调用身份；`protocol.ts` 管必要的 JSON 类型与格式。没有修改 Core、引入服务或再造版本/锁协议。

后文完整动作的 actor、commit 和图片等契约只供未来扩展参考，不能解释为默认授予 Agent 这些权限。可执行说明以 [adapter README](../../adapter/mdv_agent_tool/README.md) 为准。

## 2. 工程位置与依赖

按用户 2026-09-08 提议，与插件同放于仓库根 `adapter/`；完整仓库布局和产物隔离规则见[插件方案 §2](./vscode_plugin.md#2-仓库布局与包边界)。

```text
adapter/mdv_agent_tool/
├── package.json          # 独立依赖和 bin；命令名暂定 mdv
├── package-lock.json
├── tsconfig.json
├── scripts/              # 独立 Core tarball、构建与安装验证
├── vendor/               # 本地 Core 产物；忽略入库
├── src/
│   ├── cli.ts            # argv、输入读取、输出和退出码
│   ├── commands.ts       # 输入校验、Core 调用、有限结果投影
│   └── protocol.ts       # JSON 请求/响应类型及边界检查
├── test/
│   └── cli.test.mjs      # 启动真实子进程验证
└── README.md             # 安装、调用、权限与 Agent 装配说明
```

只依赖 `@mdv/core` 的 public API，不导入插件，不引用根源码，不自己解包写 entry；不建立第二套 lock、CAS、hash 或版本图校验。代码量增长后按真实动作拆文件，不先建立 handler/service/repository 多层转调。

初始可从 Core tarball 独立安装并固定构建，Node 要求不低于 Core 当前的 `>=20`；正式 npm 身份和版本仍需 owner 确认。根 Core 的构建、测试、发布与 `bin` 保持不变；没有 adapter 时 Core 仍能独立交付。

## 3. 完整命令面草案（远期，非当前权限）

当前 `read` 不需要 `sources` 请求；它始终返回两段。当前唯一写命令为 `save-document`，其余表中动作尚未开放。

统一调用形态暂定为：

```text
mdv <command> --file <mdv-path> [--input <request.json|->]
```

`--input -` 从 stdin 读一个 JSON 请求；不需要输入的命令省略它。`--file` 相对路径以进程 cwd 为基准，入口规范化为绝对路径；不能把 VS Code 的 `mdv:` 虚拟 URI 当作本地文件路径。命令行不携带大段 Markdown，不拼接 shell 字符串执行文档中的内容。

| 命令 | 输入与结果要点 | Core 调用 |
| --- | --- | --- |
| `create` | 创建新包；已有目标不覆盖；返回身份和初始状态 | `createMdv` |
| `open` / `status` | 返回 manifest、两棵 Head、warnings / dirty 与 bind 关系；不返回进程内句柄 | `openMdv` / `getStatus` |
| `read` | `sources: ContentSpec[]`，一次可读取 Ref/Doc 或精确历史正文 | `readContent` |
| `versions` | 指定 tree，返回该树版本 metadata；指定版本的 ancestry 由 trace 返回 | `listVersions` |
| `trace` | 指定 tree + Version ID，返回 bind 或引用关系 | `traceDocument` / `traceReference` |
| `save-reference` / `save-document` | 保存提供的 Markdown，只改工作副本 | `saveReference` / `saveDocument` |
| `commit-reference` / `commit-document` | 固化已保存正文；返回 `created`、Version 和新状态 | `commitReference` / `commitDocument` |
| `checkout-reference` / `checkout-document` | 显式选择历史版本；默认拒绝覆盖已保存 dirty | `checkoutReference` / `checkoutDocument` |
| `import-resource` | 从显式图片文件读取 bytes；返回 managed 相对路径及文档身份 | `importManagedResource` |
| `resolve-resource` / `verify-resource` | 定位或验证受管图片；不扫描全部 Markdown 图片 | `resolveManagedResource` / `verifyManagedResource` |
| `diff` | 两个 `ContentSpec`，返回通用源文本 Diff | `diff` |
| `verify` | metadata/full 诊断；坏包也应能得到报告 | 顶层 `verifyMdv` |

命令只是对已有能力的映射；图形 Diff、人类 Review UI、merge、自动提交、自动绑定最新 Ref 和资源 GC 不在首版。

`open` 不建立跨 CLI 调用的会话。需要看到 Ref/Doc 同一个打开快照时用一次 `read` 的多个 `sources`；每个后续命令仍必须重新验证磁盘身份，不能假定刚刚的 `open` 锁住了文件。

## 4. 请求、结果与类型边界

### 4.1 复用 Core 的语义类型

输入中的 tree、`ContentSpec`、Version ID、commit actor/summary、`referenceVersion` 和 `expectedGeneration` 与 Core 对齐。JSON 边界必须运行时校验，不能只把 `JSON.parse` 的结果断言成 TypeScript 类型。

差异只发生在传输确实需要的位置：

- Markdown 输入/输出使用 UTF-8 字符串，不交换 AST；图片从明确的输入文件读 bytes，不在普通 JSON 结果重复输出整张图片。
- Core `MdvDocument` 含方法，不能直接 JSON 序列化。返回 manifest/Head/status、正文、版本或诊断等调用方实际使用的字段。
- 每次 open/read/status 和成功写入返回 `documentId` 与 `generation`，让下一次写入拥有可核对的基线。
- 写请求增加 `expectedDocumentId`，用于跨 CLI 调用确认读取对象，原因见 §5。它属于 adapter 协议，不新增到 Core `SaveInput`。
- 不把所有 public model 重新改名成一套 VO/DTO，也不兼容 renderer 类型；`protocol.ts` 只声明真正跨进程的请求/响应差异。

### 4.2 JSON 输出与退出码

当前 `read` 默认输出带来源/基线的成对文本，`--json` 读取、保存和失败输出一个 JSON 对象及末尾换行；日志与操作说明写 stderr，`--help` / `--version` 单独作为人类入口。协议版本与 Core 库版本、MDV Format 版本分开。文本展示会增加分隔换行，不能解析标题来回写正文；精确读写使用 JSON。

当前读取的成功 envelope（ID 为占位符）：

```json
{
  "protocolVersion": 1,
  "ok": true,
  "data": {
    "documentId": "d_...",
    "generation": 7,
    "baseDirectory": "/workspace",
    "reference": { "source": { "tree": "reference", "kind": "working-copy" }, "text": "# Reference\n" },
    "document": { "source": { "tree": "document", "kind": "working-copy" }, "text": "# Draft\n" },
    "permissions": { "reference": "read-only", "document": "read-write" }
  }
}
```

具体值必须取工具实际输出。当前 save 的 `data` 只返回新 `documentId` / `generation`，不重复整份正文；未来 commit 才需要保留 Core `created` 联合结果的语义。

失败 envelope 为 `{ protocolVersion: 1, ok: false, error: { origin, code, message, details? } }`：

| 情况 | 退出码草案 | 表达 |
| --- | --- | --- |
| 操作正常返回 | `0` | `ok: true`，读取 `data` |
| argv、JSON 或输入类型错误 | `2` | `origin: adapter`，如 `INVALID_ARGUMENT` |
| 预期文件/版本/并发失败 | `3` | Core 失败保留原 code/details；跨调用身份冲突标明来自 adapter |
| adapter 传输超限 | `2` | `origin: adapter`，`LIMIT_EXCEEDED`，不伪装成坏 MDV |
| 默认权限拒绝 | `4` | `origin: adapter`，`PERMISSION_DENIED`，不进入写事务 |
| 意外实现或输出失败 | `1` | `origin: adapter`，`INTERNAL_ERROR` / `OUTPUT_ERROR`，不泄露堆栈或正文 |

所有 Core 错误码原样透传，不靠英文 message 分支；adapter 自身错误不增加 Core `MdvErrorCode`。`verify` 成功获得报告时为 `ok: true` / exit 0，即使 `valid: false`；调用方必须检查 `valid` 与 `complete`，不能把进程成功等同于归档完整。

### 4.3 输入输出预算

当前传输预算为 JSON 请求 16 MiB、JSON 响应 32 MiB；stdin 和文件同样限量，计入 JSON 转义与包装，默认文本读取也检查对应结构化结果预算。多来源按需读取和图片输入尚未开放，原 `read.sources` 1–16 个与图片 32 MiB 仅保留为后续草案。它们是 adapter 的传输限制，不改变 Core 的[内容预算](../compatibility.md#默认预算)。

入口限量读取 stdin/输入文件；未知字段和不合法参数明确拒绝。超大正文/诊断整体报超限，不默默截断后让 Agent 当作完整文件回写；扩展流式或分段传输应另立协议方案。写操作的正常响应只包含有界状态，预先校验可知的参数和预算；stdout 管道中断或进程被终止仍不代表写入已回滚。

多来源读取逐项累计输出预算，计入 JSON 转义后的大小，超限即停止；不能先把多份最大正文全部堆在内存里再判断。预算校验完成后才输出成功 JSON，超限时输出完整错误响应；stdout 自身中断时无法保证交付完整 JSON，按 §6 处理结果不确定性。

## 5. 写入基线与并发保护

### 5.1 保存必须绑定先前读取的对象

save、commit、checkout 请求必须携带：

- `expectedDocumentId`：Agent 当时读取的文档身份；
- `expectedGeneration`：Agent 决定本次操作时的 generation；
- 此动作的具体参数，例如 Markdown 或选定 Version。

执行顺序：校验传输输入 → `openMdv` → 比较 `expectedDocumentId` → 把调用方原样提供的 `expectedGeneration` 和动作参数交给该对象 → 输出 Core 返回的新状态。

这是复用现有身份保护，不是重写事务：Core 的路径绑定对象将其 documentId 传给内部事务，事务在锁内再次核对 documentId + generation，见 [`mdv-document.ts`](../../src/mdv-document.ts) 与 [`archive/transaction.ts`](../../src/archive/transaction.ts)。额外的协议字段只是把上一次 CLI 调用的读取身份带到本次调用。

如果工具每次 open 后直接采用最新 generation，就会把 Agent 基于旧正文生成的内容覆盖到新状态。如果只传 generation，不传先前的 documentId，则路径换成另一份恰好同 generation 的文档时也可能误写。因此禁止默认填最新基线，身份不符明确报 `CONFLICT`，不自动重试。

`create` 没有旧基线，仍不覆盖已有文件；`import-resource` 要核对 `expectedDocumentId`，但不要求 generation CAS，因为图片导入不修改包 generation。其结果中的 generation 是本次打开快照的值，不保证导入期间没有其他 writer；后续 Markdown save 继续遵守自己的基线。

### 5.2 普通 save、版本与 Agent 决策

- Agent 改写正文默认只 save；commit 必须是调用方明确授权的独立动作，不提供隐藏的 save-and-commit。
- Commit 只固化磁盘已保存正文，不读取 VS Code 内存 buffer。`actor` 明确填写，Agent 操作不得自动冒充 human；actor 是声明，不是签名认证。
- `commit-document` 必须显式提供一个存在的精确 `referenceVersion` 或 `null`。应使用生成正文时实际参考的版本，不偷偷取提交时的最新 Ref Head；若只读了未提交 Ref 工作副本，则先由有权限的一方明确提交 Ref，再决定绑定关系。
- Core 返回 `created: false` 时仍返回新 generation；不能把它解释成“命令没有发生”。
- Checkout 默认不丢弃已保存的未提交变化；`discardChanges: true` 必须显式传入并由 Agent 宿主确认该权限，工具不擅自开启。
- 插件未保存的 buffer 对 CLI 不可见。工具最多改变磁盘，不能宣称顺便处理了人的未保存编辑；插件负责保留与提示冲突。

## 6. 失败恢复与权限

- Core `details.committed: true`、stage、generation 和清理失败信息应保留。遇到这类失败，先重新 read/status/verify 确认结果，不能盲目重放同一写命令。
- 写入已返回成功但 stdout 失败、Agent 超时或进程异常退出时，结果可能不确定；stderr 尽力说明，调用方重新观察磁盘，不把“没收到 JSON”当作“没有写入”。首版不提供 exactly-once 或自动恢复事务。
- 不实现自动删除 `.lock`、强制覆盖坏包、忽略 hash、破坏性修复和资源 GC。保留 Core 的原子发布与平台限制。
- 只操作明确传入的 `.mdv` 和图片输入路径，不自动扫描整个工作区或执行 Markdown 中的命令。外部路径读写权限由 Agent Runtime/OS 的授权边界决定；CLI 不是沙箱。
- Agent 装配说明区分只读动作、普通保存、commit、checkout/丢弃等权限。非交互 CLI 不靠终端提问代替宿主审批，也不主动修改用户全局配置、自动安装技能或注册服务。
- stdout 可以包含用户明确请求的正文；诊断日志不另行记录正文、图片内容、提示词、密钥或完整错误堆栈。

## 7. 与 VS Code 的联合使用

两个 adapter 都直接调用 Core，互不依赖，不共享内存 buffer：

```text
VS Code 编辑区 -> mdv_vscode -----> @mdv/core -> .mdv + sidecar
Agent Runtime -> mdv_agent_tool -> @mdv/core -> 同一份 .mdv + sidecar
```

推荐流程：

1. 用户在 VS Code 保存并提交 Ref，得到明确的 Reference Version。
2. Agent 通过当前 `read` 读取已保存 Ref 与 Doc 工作副本，取得 documentId/generation；如果要基于步骤 1 的已提交 Ref，用户应确保 Ref 当前正文仍与它一致，不能把未提交 Ref 草稿当成那个历史版本。历史成对读取可显式选 Doc Version；独立 trace 命令尚未开放。
3. Agent 根据读取结果生成 Markdown，通过 `save-document` 携带原基线写入；成功后消费新 generation，不创建 Version。
4. 插件检测磁盘变更：无未保存编辑时刷新，有未保存编辑时保留并提示冲突。
5. 用户 review 后显式 commit Doc，绑定步骤 1 的 Ref；以后 trace 仍能读取这对历史正文。

工具 README 提供上述流程和 JSON 示例，并告诉 Agent 不要用普通文本 patch 改 `.mdv`。安装插件不等于已经给 Agent 配置了 CLI；第一版验收需要在一个真实、能执行本地命令的 Agent 宿主中完成装配，不承诺所有宿主自动识别。

## 8. 实现阶段与测试

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| A0 包与协议（本地完成） | 独立包、真实 Core tarball 安装、help、文本/JSON 输出、输入预算和错误码 | 真实子进程及仓库外安装包验证；不依赖插件或根源码 |
| A1 最小默认权限（本地完成） | 成对 read、历史精确成对 read、仅 save-document | Ref/HEAD/历史/bind 不变；身份/generation 冲突拒绝；不自动 commit |
| A2 版本与图片（未实现） | 需要用户重新确认权限后才设计 commit/checkout/资源动作 | 不因 Core 已有方法就默认授予 Agent |
| A3 诊断与交付 | diff/full verify、预算回归、可安装 CLI、Agent 使用说明 | 独立安装及三系统子进程回归，真实 Agent 与 VSIX 联合验收 |

A0/A1 已满足本轮“成对读取 + 默认只改正文”的首版交付，用户在插件负责 Ref 和 commit；不再以原先完整 A2/A3 命令面作为本轮门槛，不把未实现命令放进“当前可用”清单。19 项子进程测试在 macOS Node 20.20.2 和 26.3.0 通过；真实 tarball 在仓库外安装后重复 19 项通过。VS Code 联合测试与 UI 回归结果另行记录，不以 Core 直接外部写入替代真实 CLI。

重点测试：

- 真实子进程在 Windows/macOS/Linux 执行；带空格/中文的路径、stdin EOF、UTF-8、JSON 转义、参数缺失、输入超限和输出管道失败。
- 多来源读取使用一次打开的快照；结果携带基线，错误/诊断不混入正文，JSON 往返不丢空白或 EOF newline。
- 两个进程携带同一基线竞争 save，只能一个成功；另一方保持 `CONFLICT`，不会自动重开重试。
- 两次调用之间同路径被另一 documentId、同 generation 的包替换；工具必须拒绝写入新文档。
- 首次空 commit、bind-only commit、no-changes、新 generation、错误树 Version、显式 null bind、dirty checkout 与 discard 权限。
- commit-point 后失败、stdout 失败及进程中断后的重新读取，不测试或宣称虚构的自动回滚。
- 图片 import 不改变包 generation；save 失败留下的孤立资源可复用；`verify(full)` 与资源校验范围分开。
- 损坏归档可通过顶层 verify 返回 `valid/complete/issues`；所有 Core 错误码、details 与预算错误的来源可区分。
- 装配文档中的命令在独立安装产物上运行，而不是只在源码内部调用函数。

## 9. 后续扩展

如果目标 Agent 需要 MCP，再在本 adapter 中增加独立 transport 入口；如果需要 VS Code 内置 Agent 工作流，在插件中增加工具注册。它们复用动作语义，不反向影响 Core，也不在首版同时维护多套协议。VS Code 官方将扩展工具与 MCP 工具区分，跨宿主复用需要明确装配，而不是仅显示文档即可。[Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)

后续才评估分段读取、大正文流式传输、patch 协议、幂等请求标识或远端工具服务；没有真实调用方约束时，不先加入通用 transport interface、Provider/Factory 或会话服务器。
