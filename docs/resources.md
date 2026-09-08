# 图片与相对资源

MDV 正文仍然是普通 Markdown。普通图片路径由宿主自由管理；需要 Core 帮忙保存粘贴图片时，使用可选的受管资源 API。两者都以 `.mdv` 所在目录为相对路径基准，不以 ZIP 内部的 `doc_tree/` 或 `ref_tree/` 为基准。

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

这个规则同时适用于 Reference、Document、工作副本和所有历史版本。`../shared/cat.png`、绝对路径、网络 URL、任意目录名和文件名都仍可写入 Markdown；Core 原样保存，不自动导入、下载或改写它们。能否访问这些位置由宿主的资源策略决定。普通文件被外部覆盖后，旧 Markdown 可能显示新图片；需要稳定内容引用时再选择下面的 hash 受管导入。

## Core 如何提供基准

- `openMdv('/notes/example.mdv')` 返回 `baseDirectory = '/notes'`；
- `parseMdv(bytes)` 默认返回 `baseDirectory = null`；
- 内存调用方可以通过 `parseMdv(bytes, { baseDirectory })` 显式提供可信基准，获得 `LocatedDocumentSnapshot` 的受管只读能力，但没有资源导入或 Markdown 写方法。

Core 把 Markdown bytes/text 和 `baseDirectory` 交给宿主。普通相对路径由宿主根据该基准解析；受管图片可直接调用 `resolveManagedResource()` 取得本地绝对路径。宿主最后将文件路径转换成 VS Code URI、Electron URL 或 renderer 所需的资源地址。Core 不生成 HTML，也不把绝对路径写回 Markdown。

## 受管资源约定

`importManagedResource()` 导入的本地图片采用内容寻址 sidecar：

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

受管目录与文件名由 Core 固定生成，不接受自定义 output directory 或 filename。这只是受管导入的契约，不限制普通 Markdown 链接。

当前支持 PNG、JPEG、GIF、WebP，分别生成 `.png`、`.jpg`、`.gif`、`.webp`。类型从原始 bytes 的文件头识别，不信任外部文件名；可选的 `mediaType` 仅用于断言，不一致时拒绝导入。识别并不等于完整图片解码、像素大小检查或安全认证，宿主仍需自己的渲染限制。SVG/AVIF 不在当前受管导入范围内，但普通 Markdown 仍可以引用它们。

## 导入并插入 Markdown

```ts
import { readFile } from 'node:fs/promises'
import { openMdv } from '@mdv/core'

let mdv = await openMdv('/notes/example.mdv')
const relativePath = await mdv.importManagedResource({
  bytes: await readFile('/downloads/cat.png'),
  mediaType: 'image/png', // 可省略；Core 会识别文件头
})

// 导入只保存图片，未修改 Markdown、generation 或任何版本。
const markdown = await mdv.readDocumentText()
mdv = await mdv.saveDocument({
  markdown: `${markdown}\n![cat](${relativePath})\n`,
  expectedGeneration: mdv.manifest.generation,
})

// 交给宿主转换为渲染 URI，而不是写回 Markdown。
const absolutePath = await mdv.resolveManagedResource(relativePath)
console.log(absolutePath)
```

编辑器已有尚未保存的 buffer 时，把相对路径插入那个 buffer；不要用示例中的磁盘读取替代用户的内存内容。是否 save、何时 commit 都由宿主决定。Reference 图片使用同一导入方法，然后调用 `saveReference()`。

导入无需 `expectedGeneration`，也不获取 `.mdv` writer lock：重复或并发导入相同 bytes 得到相同路径，不改动包。原 handle 的 generation 变旧不阻止导入；但是后续 Markdown save 仍按既有 CAS 规则返回 `CONFLICT`。如果原路径已变成另一个 documentId 或父目录 alias 被重定向，旧 handle 的导入会拒绝。

## 解析、读取与校验

| 方法 | 返回 | 检查范围 |
| --- | --- | --- |
| `resolveManagedResource(path)` | 本地绝对路径 `string` | 当前 documentId、严格受管路径、目录/普通文件与 symlink 边界；不计算内容 hash |
| `readManagedResource(path, options?)` | `{ relativePath, mediaType, bytes }` | 上述边界，加大小、SHA-256 与类型/扩展名一致性 |
| `verifyManagedResource(path, options?)` | `void` | 与 read 相同；成功无返回数据，失败抛出 `MdvError` |

```ts
const resource = await mdv.readManagedResource(relativePath, {
  maxBytes: 8 * 1024 * 1024,
})
console.log(resource.mediaType, resource.bytes.byteLength)
await mdv.verifyManagedResource(relativePath)
```

import/read/verify 默认单资源上限为 32 MiB，每次可以用 `options.maxBytes` 覆盖，必须是正安全整数；不复用 ZIP 的 `ReadLimits`。读取会检查已打开文件的大小，并对实际读取再次计数以限制读取中增长的文件。结果对象被冻结，bytes 每次返回独立副本。

这些方法只接受当前 documentId 下的 `.mdv-assets/<documentId>/<64 位小写 hash>.<受支持扩展名>`，可带开头 `./`；返回的相对路径统一带 `./`。绝对路径、`..`、反斜杠、查询/片段、其他 documentId 和任意普通链接不是这些方法的输入。受管目录和最终文件不能是 symlink；调用方基准目录本身的合法 alias（例如 macOS 的 `/tmp`）可以规范化。

`resolveManagedResource()` 返回的是解析当时确认的路径，不承诺外部进程之后不会改动它。sidecar 也不是随 `DocumentSnapshot` 冻结的磁盘快照。需要读取时验证内容的宿主应使用 `readManagedResource()` 并消费返回 bytes，而不是先 verify 再假定稍后按路径读取仍是同一内容。

## Core 与宿主的职责

Core 资源 API 负责：

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

## 发布、失败与恢复边界

Core 使用同目录私有临时文件（`0600`），写入后回读校验并 fsync，再用不覆盖目标的 hard-link 发布；冲突目标必须重新校验并逐字节一致才能复用。新建受管目录为 `0700`。正常成功/失败会清理本次临时文件，POSIX 本地目录随后同步；不使用会覆盖既有 hash 文件的普通 rename，也不会把半写文件作为最终路径暴露。

资源文件与 `.mdv` 不是一个跨文件原子事务。正确顺序是先导入图片，再插入 Markdown 并 save。save 失败最多留下可复用的孤立图片，不回滚删除资源。发布后目录同步或清理失败时，错误 `details.committed === true` 表示目标已发布或已验证复用；可先 read/verify 确认，再以同样 bytes 安全重试导入。清理失败另外提供 `details.cleanupFailures`。异常退出可能留下 `.mdv-resource-*.tmp`，Core 不自动回收。

错误分类：非法受管路径、symlink 或不支持/不匹配的导入类型为 `INVALID_RESOURCE`；缺失为 `NOT_FOUND`；超限为 `LIMIT_EXCEEDED`；已有文件 hash/内容类型不一致为 `INTEGRITY_MISMATCH`；检测到目录身份或读取中文件变化为 `CONFLICT`；其余文件系统失败为 `IO_ERROR`。错误类型参数使用 `TypeError`，非法 `maxBytes` 使用 `RangeError`。

保证范围是具有可靠 link/fsync 语义的本地文件系统。目录身份检查和不跟随最终 symlink 是尽力防护，不是抵抗同权限恶意进程持续替换祖先目录的沙箱。不能只根据 hard-link 数大于 1 拒绝资源，因为原子发布本身会短暂产生第二个 link；读取始终校验 bytes。Windows 目录同步未提供与 POSIX 相同的保证，跨平台 CI、网络/FUSE/同步盘支持仍留在 M6 评估。规范约定见 [Format 0.1：Relative resources](../spec/format-0.1.md#12-relative-resources)。

## 可移植性与历史限制

- 移动或分享 `.mdv` 时必须同时移动 `.mdv-assets/` 中对应的 documentId 目录；
- 0.1 不自动垃圾回收孤立资源，避免误删仍被历史版本引用的文件；
- 资源不属于 ZIP 和 Version 完整性范围；`verifyMdv(pathOrBytes, { mode: 'full' })` 的范围仍是容器及全部历史正文，不扫描 Markdown 图片引用。sidecar 丢失时 Markdown 字节仍可验证，但历史渲染会缺图，显式 resolve/read/verify 会报告 `NOT_FOUND`；
- 真正的单文件资源打包和资源版本完整性需要后续格式版本，不能在 0.1 Reader 中私自增加 ZIP entry。
