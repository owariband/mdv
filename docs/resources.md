# 图片与相对资源

MDV 正文仍然是普通 Markdown。图片和链接保持普通相对 URL，但它们的基准不是 ZIP 内部的 `doc_tree/` 或 `ref_tree/`。

## 路径基准

假设目录为：

```text
/notes/example.mdv
/notes/images/cat.png
```

Reference 或 Document 正文都可以写：

```md
![cat](./images/cat.png)
```

该路径解析为 `/notes/images/cat.png`。两份工作副本都是 ZIP 内逻辑条目，不存在如下真实路径：

```text
/notes/example.mdv/doc_tree/current.md
```

因此也不需要使用 `../../images/cat.png` 之类的内部路径补偿。

## Core 如何提供基准

- `openMdv('/notes/example.mdv')` 返回 `baseDirectory = '/notes'`；
- `parseMdv(bytes)` 默认返回 `baseDirectory = null`；
- 内存调用方可以通过 `parseMdv(bytes, { baseDirectory })` 显式提供基准。

Core 把 Markdown bytes/text 和 `baseDirectory` 交给宿主。宿主负责将基准转换成 VS Code URI、Electron URL 或 renderer 所需的资源地址。

## 受管资源约定

未来由 Core 导入的本地图片采用内容寻址 sidecar：

```text
/notes/example.mdv
/notes/.mdv-assets/<documentId>/<sha256>.<extension>
```

Markdown 直接保存相对 hash 路径：

```md
![diagram](./.mdv-assets/d_0123.../9f86d081....png)
```

这里不再维护一份 `path -> hash` manifest 映射。路径本身就是内容引用：

- `<sha256>` 是原始资源 bytes 的 64 位小写十六进制 SHA-256；
- 相同 hash 可以在校验后复用；
- 已存在的 hash 文件不可用不同内容覆盖；
- sidecar 不进入 ZIP，不增加 manifest generation；
- sidecar 不计入 Markdown Version 的 `contentSha256` 或 `contentBytes`。

## Core 与宿主的职责

规划中的 Core 资源 API 负责：

- 计算内容 hash；
- 选择和校验受支持的安全扩展名；
- 原子写入或复用 sidecar；
- 将受管相对路径解析为本地位置；
- 读取资源并验证 hash。

VS Code、MarkText 等宿主负责：

- 接收 paste/drop；
- 把图片 bytes 和媒体信息交给 Core；
- 把 Core 返回的相对路径插入 Markdown；
- 渲染图片和处理用户交互。

Core 不扫描 Markdown AST，不自动下载网络 URL，也不会重写任意用户链接。

## 当前实现状态

M3 已经提供正确的 `baseDirectory` 和工作副本 save，但尚未发布资源 import/resolve/read API。宿主目前可以读取和保存 Markdown 中已有的相对路径，不能把自行实现的 sidecar 写入逻辑当作稳定 Core 契约。

资源写入依赖可靠的文件事务，将在 M3 主事务闭环之后实现。当前规范性约定见 [Format 0.1：Relative resources](../spec/format-0.1.md#12-relative-resources)。

## 可移植性与历史限制

- 移动或分享 `.mdv` 时必须同时移动 `.mdv-assets/` 中对应的 documentId 目录；
- 0.1 不自动垃圾回收孤立资源，避免误删仍被历史版本引用的文件；
- 资源不属于 ZIP 和 Version 完整性范围；sidecar 丢失时 Markdown 字节仍可验证，但历史渲染会缺图；
- 真正的单文件资源打包和资源版本完整性需要后续格式版本，不能在 0.1 Reader 中私自增加 ZIP entry。
