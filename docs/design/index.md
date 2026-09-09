# MDV 维护者设计索引

> 设计知识根：`docs/design/`
>
> 最后更新：2026-09-09

这里记录产品语义、实现机制、阶段计划和设计决策，面向 Core 维护者。调用方应优先阅读 [`docs/`](../README.md) 中的官方使用文档；本目录可能描述尚未实现的目标 API。

## 当前综合结论

MDV 0.1 使用 ZIP 单文件保存 Reference/Document 两份工作副本和两棵不可变版本历史。Document Version 单向绑定精确 Reference Version 或 `null`。`@mdv/core` 已完成 M5.5 产品能力；M6 已补充 conformance/安全/复杂 Markdown/fuzz、干净源码 tarball consumer、性能基线、CI 与发布 gate，未修改公开 API 或生产分层。修复提交 `52f1d33` 已通过远端 10 组矩阵，证据见[兼容性文档](../compatibility.md)；当前仍为开发预览，owner 发布身份决策和正式发布待验收。

M4 没有增加另一套 Draft 模型：编辑器内存 buffer 归宿主，Core 只持久化 `current.md`，显式 commit 才创建 Version。多进程写冲突由 Core 报告 `CONFLICT`，重载或合并策略仍由宿主决定。

M5 主要由 Agent/自动化需求驱动，没有修改 Format 0.1 或写事务。人类侧 Reference/Document 左右对照的核心仍是 bind + 精确读取，具体 mode 和渲染属于上游插件。M5.5 已补齐可选图片 hash sidecar：普通路径仍由宿主自由管理，受管图片由 Core 导入并返回相对路径，resolve 返回真实本地绝对路径。M6 本地与远端检查通过不等于已经发布；scope/License/版本与发布验收完成后才达到本轮 `@mdv/core 0.1` 稳定发布口径。

2026-09-08 按用户要求进入 U1：[`adapter/mdv_vscode/`](../../adapter/mdv_vscode/README.md) 已实现并产出本地预览 VSIX，复用原生 Markdown 编辑/渲染和兼容扩展，提供 Ref/Doc、图片、显式版本与精确 bind 对照。本机安装版 Extension Host 验证通过，Windows/Linux、最低版本和任意第三方 renderer 仍待验证；详细证据见[插件方案 §8](./vscode_plugin.md#8-开发阶段与验收)。`adapter/mdv_agent_tool/` 仍仅有设计，尚未实现。Core 仍在根 package，adapter 只消费 package root；见 [D013](./decisions.md#d013adapter-同仓独立包与本地接入优先) 与 [D014](./decisions.md#d014vs-code-复用原生-markdown-编辑与渲染)。

最新入口修正：[D015](./decisions.md#d015普通空文件是正常的新建入口) 明确普通新建空 `.mdv` 必须能直接编辑。`openMdv` 打开空文件不写磁盘，首次保存才建立 ZIP；VS Code `preview.2` 自动进入 Doc 编辑区。非空坏包、历史和冲突保护仍保持严格；这不是要求用户手动初始化文件。

最新交互交付：[D016](./decisions.md#d016doc-默认打开与侧栏控制-ref) 已在 `preview.3` 实现：移除概览页与正文 Diff，Doc 默认打开，Ref 按需显示。侧栏双列版本图展示 parent 分支、独立 HEAD 和跨列 bind，可选 Ref 高亮全部 Doc 使用方。原生标签后台保留隐藏草稿/撤销/基线，不新增正文模型或 Ref 反向 bind。19 项安装回归、隐藏草稿真实 reload/冲突保护及 Restricted Mode 检查通过；详细证据与边界见[插件方案 §8.2](./vscode_plugin.md#82-preview3-交互验收2026-09-08)。

2026-09-09 本地交付更新至 `preview.6`：侧栏适配可用宽高，打开文档不抢占用户的侧栏选择；包入口在 Webview 加载确认后才切换到原生 Doc，修复重复打开的销毁竞态；活动栏复用项目猫头 SVG。最新安装版基础回归 20 项通过，此前含 Markdown All in One 的 21 项及两种 reload/Restricted Mode 验证单独保留；详见[插件方案 §8.3](./vscode_plugin.md#83-preview4preview6-交付2026-09-09)。

2026-09-09 U3 A0/A1 已实现：[`adapter/mdv_agent_tool/`](../../adapter/mdv_agent_tool/README.md) 提供成对读取（默认文本/可选 JSON）、历史 Doc 精确 bind 读取和仅正文保存。默认不开放 Ref/历史修改，写入必须携带旧文档身份/generation；ZIP 与 Core public API 不变。19 项 Node 20/26 子进程回归及独立安装包验证通过，CLI 不自动给宿主注册工具；此前“仅有设计”的记录被此状态更新取代。

2026-09-09 Agent 成果已通过 `6e41aaa` 推送；按用户“给当前 Codex 装上工具”的要求提供可选 [`mdv` 个人 Skill](../../adapter/mdv_agent_tool/skills/mdv/SKILL.md)，从技能位置调用独立安装的 CLI。它仅负责跨项目发现和调用，不改变默认权限，也不扩展为 MCP 服务；安装实测状态见[开发日志](./dev_log.md)。

## 页面

- [架构与产品设计](./architecture.md)：格式语义、领域模型、最终行为和安全边界。
- [技术机制与实现方案](./mechanisms.md)：分层、DTO/领域/public 类型边界、事务与宿主接入。
- [开发路线图](./roadmap.md)：已完成阶段、下一批工作和验收条件。
- [VS Code 插件方案](./vscode_plugin.md)：原生 Markdown 编辑、侧栏双列版本图、精确 bind、图片、外部冲突与本地 VSIX 验收。
- [Agent Tool 方案](./agent_tool.md)：独立 CLI、JSON 协议、跨调用身份/generation 保护与插件联合使用。
- [开发提交日志](./dev_log.md)：每个已落地 commit 的详细交付、验证结果与阶段边界。
- [设计决策](./decisions.md)：已经确认的长期决策、理由和影响。
- [开放问题](./open-questions.md)：尚未冻结的契约、阻塞项和下一次检查点。
- [设计维护日志](./log.md)：对本设计知识根的简要变更记录。
- [兼容性与平台](../compatibility.md)、[性能基线](../performance.md)、[验证与发布](../releasing.md)：M6 的调用方边界、实测证据与可执行检查入口。

## 事实优先级

1. 物理格式以 [`spec/format-0.1.md`](../../spec/format-0.1.md) 为规范性基线。
2. 已实现的 public API 以 [`src/index.ts`](../../src/index.ts) 和测试为准。
3. 本目录中的 Decision 记录已确认选择；Architecture/Mechanisms 中的未来接口仍需按 Roadmap 落地。
4. Open question 不应被调用方视为兼容承诺。

## 维护规则

- 更新结论时同步修正文档间链接和用户文档中的能力状态；
- 已验证代码事实与计划目标分开书写；
- 新决策记录日期、状态、理由、影响和证据；
- 不删除被取代的决定，在原条目标记 superseded 并指向新决定；
- 设计结论或文档结构变化时，在 [`log.md`](./log.md) 增加一条简短记录；
- 完成代码交付并提交后，在 [`dev_log.md`](./dev_log.md) 增加对应的详细提交说明、验证结果和阶段边界。
