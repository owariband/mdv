# M3 API 参考

本页只记录当前从 `@mdv/core` package root 导出的公开 API。M3 已提供创建、读取和工作副本保存；设计文档中尚未实现的 commit、checkout、diff、verify 和 export 不属于本页契约。

## 运行环境与入口

- Node.js 20+；
- ESM；
- 唯一公开入口：`@mdv/core`；
- 不支持从 `@mdv/core/archive/*` 或 `@mdv/core/core/*` 导入内部模块。

```ts
import {
  MDV_FORMAT,
  MDV_FORMAT_VERSION,
  MdvError,
  createMdv,
  openMdv,
  parseMdv,
} from '@mdv/core'
```

## 打开与创建函数

### `openMdv(path, options?)`

```ts
function openMdv(path: string, options?: OpenOptions): Promise<MdvDocument>
```

从文件系统路径打开 MDV。返回值的 `packagePath` 是绝对路径，`baseDirectory` 是其父目录。

### `createMdv(path, options?)`

```ts
function createMdv(path: string, options?: CreateOptions): Promise<MdvDocument>
```

创建 generation 0、Reference/Document 两份空工作副本、零 Version 和零 Head 的 MDV。目标已经存在时以 `CONFLICT` 失败，不覆盖文件或跟随最终 symlink。默认 `markdownProfile` 是 `gfm`。

### `parseMdv(bytes, options?)`

```ts
function parseMdv(
  bytes: Uint8Array,
  options?: ParseOptions,
): Promise<DocumentSnapshot>
```

从内存字节解析只读快照。输入会被复制；后续修改原始数组不会改变快照。`packagePath` 为 `null`，`baseDirectory` 来自可选参数并被解析为绝对路径，未提供时为 `null`。

```ts
interface OpenOptions {
  readonly limits?: Partial<ReadLimits>
}

interface ParseOptions extends OpenOptions {
  readonly baseDirectory?: string
}

interface CreateOptions extends OpenOptions {
  readonly markdownProfile?: string
}
```

## Snapshot 属性

`DocumentSnapshot` 是 `parseMdv` 返回的纯只读快照。`MdvDocument` 来自路径，因而 `packagePath` 和 `baseDirectory` 一定是字符串，并额外提供两种 save 方法。

| 属性 | 类型 | 含义 |
| --- | --- | --- |
| `manifest` | `ManifestSummary` | format、formatVersion、documentId、generation、markdownProfile |
| `packagePath` | `string \| null` | 原始 `.mdv` 路径；内存解析为 `null` |
| `baseDirectory` | `string \| null` | 相对链接和资源的基准目录 |
| `referenceTree.head` | `VersionId \| null` | 当前 Reference Head |
| `documentTree.head` | `VersionId \| null` | 当前 Document Head |
| `warnings` | `readonly MdvWarning[]` | 非阻断兼容性提示 |

公开 DTO 和结果数组都是冻结的只读快照，不暴露内部 `Map`、ZIP entry 或可变状态。

## 查询方法

### `listVersions(query?)`

列出轻量版本摘要，不读取历史正文。

```ts
document.listVersions()
document.listVersions({ tree: 'reference' })
document.listVersions({ tree: 'document' })
```

结果按 RFC 3339 实际时刻升序排列，时间相同时按 Version ID 排列。传入 literal tree 时，TypeScript overload 会保留对应的 `ReferenceVersionSummary[]` 或 `DocumentVersionSummary[]` 类型。

版本摘要的公共字段为：

```ts
interface ReferenceVersionSummary {
  readonly tree: 'reference'
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
}

interface DocumentVersionSummary {
  readonly tree: 'document'
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
  readonly referenceVersion: VersionId | null
}

interface Actor {
  readonly type: 'human' | 'agent'
  readonly id?: string
  readonly name?: string
}
```

`DocumentId` 和 `VersionId` 在 TypeScript 中分别带有 `d_`、`v_` 模板字面量前缀；Reader 在运行时进一步校验完整的 Format 0.1 ID 形状。

### `getHistory(tree, from?)`

从 `from` 或该树 Head 开始，沿 parent 返回到根，顺序为起点到更旧版本。没有 Head 时返回空数组。

### `getChildren(tree, version)`

返回指定版本的直接 children，按时间升序、Version ID 打破平局。

### Bind 与 trace

```ts
getDocumentReference(document: VersionId): VersionId | null
listDocumentsUsingReference(reference: VersionId): readonly DocumentVersionSummary[]
traceDocument(document: VersionId): DocumentTrace
traceReference(reference: VersionId): ReferenceTrace
```

- Bind 的真实方向始终是 Document Version → Reference Version。
- 反向查询来自打开时构建的内存索引，不会写回 Reference。
- `traceDocument` 返回目标 Document、Document ancestry 和绑定的 Reference。
- `traceReference` 返回目标 Reference、Reference ancestry 和直接使用它的 Document Versions。

```ts
interface DocumentTrace {
  readonly document: DocumentVersionSummary
  readonly ancestry: readonly DocumentVersionSummary[]
  readonly reference: ReferenceVersionSummary | null
}

interface ReferenceTrace {
  readonly reference: ReferenceVersionSummary
  readonly ancestry: readonly ReferenceVersionSummary[]
  readonly usedByDocuments: readonly DocumentVersionSummary[]
}
```

## 正文读取

```ts
readReference(): Promise<MarkdownSource>
readDocument(): Promise<MarkdownSource>
readReferenceText(): Promise<string>
readDocumentText(): Promise<string>
readVersionBytes(id: VersionId): Promise<Uint8Array>
readVersionText(id: VersionId): Promise<string>
```

`MarkdownSource` 包含：

```ts
interface MarkdownSource {
  readonly bytes: Uint8Array
  readonly markdownProfile: string
  readonly baseDirectory: string | null
  readonly origin: {
    readonly tree: 'reference' | 'document'
    readonly kind: 'working-copy' | 'version'
    readonly version: VersionId | null
  }
}
```

- bytes 是正文保真的基础接口；
- text 方法执行严格 UTF-8 解码，不替换非法字节；
- Core 不做换行、Unicode 或 Markdown 格式化；
- 工作副本在打开时读取；历史正文在首次读取时按需解压，并校验 `contentBytes` 与 SHA-256；
- 每次返回的 bytes 都是独立副本，调用方可以安全交给其他库。

`readReference()` 和 `readDocument()` 的 `origin.kind` 为 `working-copy`。历史接口当前直接返回 bytes/text。

## 保存工作副本

```ts
interface SaveInput {
  readonly markdown: string | Uint8Array
  readonly expectedGeneration: number
}

interface MdvDocument extends DocumentSnapshot {
  saveReference(input: SaveInput): Promise<MdvDocument>
  saveDocument(input: SaveInput): Promise<MdvDocument>
}
```

- `saveReference` 只更新 `ref_tree/current.md`；`saveDocument` 只更新 `doc_tree/current.md`。
- 两者都把 generation 精确增加 1，但不创建 Version、不移动 Head，也不改变任何既有历史正文或 metadata。
- 成功结果是新的路径绑定 `MdvDocument`。原对象仍代表打开时刻的不可变快照，后续写入应使用返回对象。
- `string` 按 UTF-8 编码；`Uint8Array` 会先复制。两者都必须是无 BOM 的合法 UTF-8，并受 `maxEntryBytes` 限制。
- `expectedGeneration` 必须是非负安全整数。Core 在取得跨进程锁并重开最新归档后执行 CAS；不匹配时返回 `CONFLICT`，不自动重试。
- 保存还校验打开时的 `documentId` 与规范目标路径，避免文件被另一个同 generation 文档替换或父目录 alias 被重定向后误写。

```ts
let document = await openMdv(path)

document = await document.saveDocument({
  markdown: '# New working copy\n',
  expectedGeneration: document.manifest.generation,
})
```

### 文件事务与支持边界

Writer 在目标同目录创建 mode `0600` 的唯一临时 ZIP，逐条复制并校验历史内容，使用完整 Reader 验证新包，刷新临时文件后再发布。保存以同目录原子 replace 为 commit point；POSIX 本地文件系统随后同步父目录。commit point 前失败时旧包保持 byte-for-byte 不变；commit point 后若目录同步失败，错误 details 会包含 `committed: true` 和已发布的 generation，调用方必须重新 `openMdv` 确认状态。

当前写入保证限定在提供可靠目录创建、同目录 rename/link 与 fsync 语义的本地文件系统。save 拒绝最终 symlink、hard link 数大于 1 的目标和其他非普通文件。网络文件系统、FUSE、同步盘以及 ACL/xattr/owner/group 等额外文件元数据不在 M3 保持承诺内；POSIX mode 会在 save 时保留，新建文件当前为 `0600`。本轮在 macOS 上实测；Linux 使用同一 POSIX 事务路径，但正式 CI 矩阵留到发布收口阶段。

Windows 使用可写句柄刷新临时文件，并依赖 Node 的同目录 rename/link 提供可见性；Node 没有可移植的 Windows 目录 fsync/write-through 接口，因此断电后的目录项持久性尚未达到 POSIX 路径的同等级保证，也尚未经过 Windows CI 实测。Windows 目标名末尾的点或空格会被拒绝，以免路径规范化产生第二把锁。

互斥锁是规范目标旁的 `<target>.lock` 目录。正常成功和失败路径都会释放；M3 不按时间自动回收已有锁，因为错误回收一个仍活跃 writer 的 lease 会破坏互斥。进程被 `SIGKILL`、机器崩溃或清理失败后可能留下该目录；只有在确认没有 writer 仍在运行时才能人工删除。若任何清理步骤失败，错误 details 会包含 `cleanupIncomplete: true` 和 `cleanupFailures`，而不是静默声称已经清理。

## Warnings

```ts
interface MdvWarning {
  readonly code: 'UNKNOWN_FIELD' | 'UNKNOWN_MARKDOWN_PROFILE'
  readonly entry: string
  readonly path: string
  readonly message: string
}
```

Warning 不阻止打开。`entry` 定位 ZIP 条目，`path` 定位其中的 JSON path。调用方可以展示或记录它，但不能把未知字段当作已经理解的语义。

## Errors

所有预期的打开、格式、校验和读取失败都映射为 `MdvError`：

```ts
try {
  await openMdv(path)
} catch (error) {
  if (error instanceof MdvError) {
    console.error(error.code, error.details)
  }
}
```

| `code` | 含义 |
| --- | --- |
| `NOT_MDV` | ZIP 不含 MDV manifest，或明确属于其他格式 |
| `UNSUPPORTED_FORMAT` | manifest 声明了当前 Reader 不支持的 MDV 版本 |
| `INVALID_ARCHIVE` | ZIP 损坏或违反归档安全规则 |
| `INVALID_MANIFEST` | manifest JSON 或字段不合法 |
| `INVALID_TREE` | 必需条目、HEAD 或版本目录结构不合法 |
| `INVALID_VERSION` | 版本 metadata 不合法 |
| `INVALID_GRAPH` | parent、bind、Head、循环或跨树关系不合法 |
| `INVALID_UTF8` | Markdown 不是无 BOM 的合法 UTF-8 |
| `INTEGRITY_MISMATCH` | 历史正文长度或 SHA-256 与 metadata 不一致 |
| `NOT_FOUND` | 文件路径或 Version ID 不存在 |
| `LIMIT_EXCEEDED` | ZIP、JSON、版本数或自定义读取上限被超过 |
| `IO_ERROR` | 其他文件系统读写、刷新、替换或清理失败 |
| `CONFLICT` | generation/document/path 身份冲突、目标已存在或已被其他 writer 锁定 |

`details` 可能包含 entry、Version ID、I/O code、预期/实际 generation、`committed`、事务 stage 或清理状态，但不会包含完整 Markdown 正文。

## 默认读取上限

| 字段 | 默认值 |
| --- | ---: |
| `maxEntries` | 30,010 |
| `maxEntryBytes` | 64 MiB |
| `maxTotalUncompressedBytes` | 512 MiB |
| `maxCompressionRatio` | 100 |
| `maxVersions` | 10,000 |
| `maxJsonBytes` | 1 MiB |
| `maxJsonDepth` | 32 |

调用方可以通过 `options.limits` 覆盖其中一部分。上调限制意味着接受更高的 CPU 和内存风险；对不可信文件应保持保守值。

这些数值限制之外，Reader 还会拒绝 ZIP64、多磁盘、加密条目、危险或冲突路径以及非普通 ZIP entry；完整容器约束以 [Format 0.1](../spec/format-0.1.md) 为准。

## 当前未提供

- `commitReference` / `commitDocument`；
- checkout、dirty/drift、diff、verify、export；
- 受管资源 import/resolve/read API；
- Markdown parser、AST 或 renderer。

这些能力的开发状态见[路线图](./design/roadmap.md)。
