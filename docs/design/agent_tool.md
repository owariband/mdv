# MDV Agent Tool 开发方案

> 最后更新：2026-09-08
>
> 状态：开发设计草案，命令、协议和目录尚未实现；示例不能视为当前可执行命令。
>
> 计划位置：当前仓库的 `adapter/mdv_agent_tool/`，独立 package；第一版采用一次性 CLI。
>
> 配套方案：[VS Code 插件](./vscode_plugin.md)；当前契约：[Core API](../api-reference.md)；排期：[路线图](./roadmap.md)。

## 1. 目标与非目标

让能执行本地命令的 Agent 安全读取、修改和追踪 `.mdv`，同时让人能在 VS Code 中查看这些结果。Agent 输出 Markdown 内容，工具负责调用 Core，不能把 ZIP 当作 UTF-8 文件直接 patch。

第一版是本地 CLI：一次调用处理一个动作，输出结果后退出。它不需要 VS Code 正在运行，不启动 HTTP 服务或后台 daemon，也不实现 Agent Runtime、模型调用、提示词推理或自动工作流决策。

Core 已经提供 read/save/commit/checkout/trace/status/diff/verify 和图片 API；Agent 专用的 argv、JSON envelope、退出码和工具说明属于本 adapter。代码依据是 [`src/index.ts`](../../src/index.ts)、[`src/types.ts`](../../src/types.ts) 和 [`src/mdv-document.ts`](../../src/mdv-document.ts)。

## 2. 工程位置与依赖

按用户 2026-09-08 提议，与插件同放于仓库根 `adapter/`；完整仓库布局和产物隔离规则见[插件方案 §2](./vscode_plugin.md#2-仓库布局与包边界)。

```text
adapter/mdv_agent_tool/
├── package.json          # 独立依赖和 bin；命令名暂定 mdv
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── cli.ts            # argv、输入读取、输出和退出码
│   ├── commands.ts       # 输入校验、Core 调用、有限结果投影
│   └── protocol.ts       # JSON 请求/响应类型及边界检查
├── test/
│   ├── protocol.test.mjs
│   └── cli.test.mjs      # 启动真实子进程验证
└── README.md             # 安装、调用、权限与 Agent 装配说明
```

只依赖 `@mdv/core` 的 public API，不导入插件，不引用根源码，不自己解包写 entry；不建立第二套 lock、CAS、hash 或版本图校验。代码量增长后按真实动作拆文件，不先建立 handler/service/repository 多层转调。

初始可从 Core tarball 独立安装并固定构建，Node 要求不低于 Core 当前的 `>=20`；正式 npm 身份和版本仍需 owner 确认。根 Core 的构建、测试、发布与 `bin` 保持不变；没有 adapter 时 Core 仍能独立交付。

## 3. 命令面草案

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

正常命令 stdout 只输出一个 JSON 对象及末尾换行；日志与操作说明写 stderr，`--help` / `--version` 单独作为人类入口。协议版本与 Core 库版本、MDV Format 版本分开。

建议的成功 envelope：

```json
{
  "protocolVersion": 1,
  "ok": true,
  "data": {
    "documentId": "d_...",
    "generation": 7,
    "contents": [
      {
        "source": { "tree": "document", "kind": "working-copy" },
        "text": "# Draft\n"
      }
    ]
  }
}
```

这里只展示 `read` 的结果形态，ID 为占位符；具体值必须取工具实际输出。save/commit 的 `data` 返回精简的新状态，不重复整份正文；commit 保留 Core `created` 联合结果的语义。

失败 envelope 为 `{ protocolVersion: 1, ok: false, error: { origin, code, message, details? } }`：

| 情况 | 退出码草案 | 表达 |
| --- | --- | --- |
| 操作正常返回 | `0` | `ok: true`，读取 `data` |
| argv、JSON 或输入类型错误 | `2` | `origin: adapter`，如 `INVALID_ARGUMENT` |
| 预期文件/版本/并发失败 | `3` | Core 失败保留原 code/details；跨调用身份冲突标明来自 adapter |
| adapter 传输超限 | `2` | `origin: adapter`，`LIMIT_EXCEEDED`，不伪装成坏 MDV |
| 意外实现或输出失败 | `1` | `origin: adapter`，`INTERNAL_ERROR` / `OUTPUT_ERROR`，不泄露堆栈或正文 |

所有 Core 错误码原样透传，不靠英文 message 分支；adapter 自身错误不增加 Core `MdvErrorCode`。`verify` 成功获得报告时为 `ok: true` / exit 0，即使 `valid: false`；调用方必须检查 `valid` 与 `complete`，不能把进程成功等同于归档完整。

### 4.3 输入输出预算

初版传输预算建议为 JSON 请求 16 MiB、JSON 响应 32 MiB，`read.sources` 限 1–16 个；在 contract test 中冻结并写入 help。它们是 adapter 的传输限制，不改变 Core 的[内容预算](../compatibility.md#默认预算)。图片文件单独按 Core 默认 32 MiB 限量读取。

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
2. Agent 通过 `read` 读取该 Ref Version 与 Doc 工作副本，取得 documentId/generation；需要 bind 背景时调用 trace。
3. Agent 根据读取结果生成 Markdown，通过 `save-document` 携带原基线写入；成功后消费新 generation，不创建 Version。
4. 插件检测磁盘变更：无未保存编辑时刷新，有未保存编辑时保留并提示冲突。
5. 用户 review 后显式 commit Doc，绑定步骤 1 的 Ref；以后 trace 仍能读取这对历史正文。

工具 README 提供上述流程和 JSON 示例，并告诉 Agent 不要用普通文本 patch 改 `.mdv`。安装插件不等于已经给 Agent 配置了 CLI；第一版验收需要在一个真实、能执行本地命令的 Agent 宿主中完成装配，不承诺所有宿主自动识别。

## 8. 实现阶段与测试

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| A0 包与协议 | 独立包、真实 Core tarball 安装、help、JSON envelope、参数校验和错误码 | 干净目录构建；子进程 stdout 只有一个协议结果；不依赖插件或根源码 |
| A1 最小读写 | create/open/status/read、versions/trace、两树 save | Agent 读 Ref/Doc 后 save，插件观察到变化；save 不增 Version |
| A2 版本与图片 | 显式 commit、受保护 checkout、import/resolve/verify-resource | 精确 bind、身份+generation 冲突、图片历史回读与失败恢复 |
| A3 诊断与交付 | diff/full verify、预算回归、可安装 CLI、Agent 使用说明 | 独立安装及三系统子进程回归，真实 Agent 与 VSIX 联合验收 |

A1 可以先用于 Agent 保存正文、由插件负责用户 commit 的联调；完整首版要完成 A2/A3，不把尚未实现的命令放进“当前可用”清单。

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
