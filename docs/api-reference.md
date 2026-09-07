# M2 API 参考

本页只记录当前从 `@mdv/core` package root 导出的 M2 只读 API。设计文档中尚未实现的 create/save/commit/diff/verify/export 不属于本页契约。

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
  openMdv,
  parseMdv,
} from '@mdv/core'
```

## 打开函数

### `openMdv(path, options?)`

```ts
function openMdv(path: string, options?: OpenOptions): Promise<MdvDocument>
```

从文件系统路径打开 MDV。返回值的 `packagePath` 是绝对路径，`baseDirectory` 是其父目录。

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
```

## Snapshot 属性

`MdvDocument` 与 `DocumentSnapshot` 提供相同的只读方法。区别是前者来自路径，因而 `packagePath` 和 `baseDirectory` 一定是字符串。

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

M2 中 `readReference()` 和 `readDocument()` 的 `origin.kind` 为 `working-copy`。历史接口当前直接返回 bytes/text。

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
| `IO_ERROR` | 其他文件系统读取失败 |
| `CONFLICT` | 为后续写事务保留；M2 只读操作不会产生 |

`details` 可能包含 entry、Version ID、I/O code、预期值或实际值，但不会包含完整 Markdown 正文。

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

## 当前未提供

- `createMdv`；
- `saveReference` / `saveDocument`；
- `commitReference` / `commitDocument`；
- checkout、dirty/drift、diff、verify、export；
- 受管资源 import/resolve/read API；
- Markdown parser、AST 或 renderer。

这些能力的开发状态见[路线图](./design/roadmap.md)。
