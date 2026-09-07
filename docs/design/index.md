# MDV 维护者设计索引

> 设计知识根：`docs/design/`
>
> 最后更新：2026-09-07

这里记录产品语义、实现机制、阶段计划和设计决策，面向 Core 维护者。调用方应优先阅读 [`docs/`](../README.md) 中的官方使用文档；本目录可能描述尚未实现的目标 API。

## 当前综合结论

MDV 0.1 使用 ZIP 单文件保存 Reference/Document 两份工作副本和两棵不可变版本历史。Document Version 单向绑定精确 Reference Version 或 `null`。`@mdv/core` 已完成 M4：创建、读取、普通 Markdown 工作副本保存、commit、checkout、trace 和 POSIX 本地原子文件事务均已从 package root 提供；下一阶段是 M5 Review 与完整性能力。

M4 没有增加另一套 Draft 模型：编辑器内存 buffer 归宿主，Core 只持久化 `current.md`，显式 commit 才创建 Version。多进程写冲突由 Core 报告 `CONFLICT`，重载或合并策略仍由宿主决定。

## 页面

- [架构与产品设计](./architecture.md)：格式语义、领域模型、最终行为和安全边界。
- [技术机制与实现方案](./mechanisms.md)：分层、DTO/领域/public 类型边界、事务与宿主接入。
- [开发路线图](./roadmap.md)：已完成阶段、下一批工作和验收条件。
- [设计决策](./decisions.md)：已经确认的长期决策、理由和影响。
- [开放问题](./open-questions.md)：尚未冻结的契约、阻塞项和下一次检查点。
- [维护日志](./log.md)：对本设计知识根的简要变更记录。

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
- 每次维护在 [`log.md`](./log.md) 增加一条简短记录。
