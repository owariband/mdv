# 当前 API 参考

本页只记录当前从 `@mdv/core` package root 导出的公开 API。M5 已提供创建、读取、工作副本保存、commit、checkout、结构化 status、统一内容选择、通用源码 Diff 和完整性诊断；受管资源与正式发布能力仍属于后续阶段。

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
  verifyMdv,
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

`DocumentSnapshot` 是 `parseMdv` 返回的纯只读快照。`MdvDocument` 来自路径，因而 `packagePath` 和 `baseDirectory` 一定是字符串，并额外提供 save、commit 和 checkout 写方法。

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

## 状态与统一内容选择

### `getStatus()`

```ts
const status = await document.getStatus()
```

该方法一次返回两棵工作副本相对各自 Head 的 dirty 状态，以及当前 Document Head 与 Reference Head 的精确关系：

```ts
interface TreeWorkingCopyStatus {
  readonly head: VersionId | null
  readonly dirty: boolean
}

type ReferenceRelation =
  | { readonly kind: 'no-document-head' }
  | { readonly kind: 'unbound' }
  | { readonly kind: 'aligned'; readonly referenceVersion: VersionId }
  | {
      readonly kind: 'drifted'
      readonly boundReference: VersionId
      readonly currentReference: VersionId | null
    }

interface DocumentStatus {
  readonly reference: TreeWorkingCopyStatus
  readonly document: TreeWorkingCopyStatus
  readonly referenceRelation: ReferenceRelation
}
```

有 Head 时，dirty 由 `current.md` 原始字节的长度和 SHA-256 与 Head metadata 同时比较；无 Head 时，空工作副本为 clean，非空为 dirty。该查询只反映当前 snapshot 已保存的工作副本，不包含编辑器尚未 save 的内存 buffer，也不读取 Head 历史正文。

`unbound` 表示 Document Head 明确绑定 `null`，不是错误；`drifted` 表示 Document 仍精确绑定一个历史 Reference，而当前 Reference Head 已经不同或为 `null`。查询只报告事实，不自动修改 bind。

### `readContent(source)`

```ts
type ContentSpec =
  | { readonly tree: 'reference' | 'document'; readonly kind: 'working-copy' }
  | {
      readonly tree: 'reference' | 'document'
      readonly kind: 'version'
      readonly version: VersionId
    }

const source = await document.readContent({
  tree: 'document',
  kind: 'version',
  version: documentVersion,
})
```

`readContent` 是工作副本和历史版本共用的 `MarkdownSource` 读取入口。它不会猜测 Version 属于哪棵树；声明的 `tree` 与实际版本不一致时返回 `NOT_FOUND`，`details.reason` 为 `wrong-tree`。原有 `readReference*`、`readDocument*` 和 `readVersion*` 继续保留为便利接口。

## 通用 Markdown 源码 Diff

```ts
const result = await document.diff(
  { tree: 'document', kind: 'version', version: oldDocument },
  { tree: 'document', kind: 'version', version: newDocument },
  { contextLines: 3 },
)
```

Diff 两端使用同一种 `ContentSpec`，所以支持 Document ↔ Document、Reference ↔ Reference、Reference ↔ Document，以及任意工作副本 ↔ 历史版本。它比较 Markdown 原始文本行，不解析 AST、不渲染 HTML，也不推断需求是否满足。

```ts
interface DiffResult {
  readonly hunks: readonly DiffHunk[]
  readonly unifiedText: string
}

interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

type DiffLine =
  | { readonly kind: 'context'; readonly oldLine: number; readonly newLine: number; readonly text: string }
  | { readonly kind: 'deletion'; readonly oldLine: number; readonly newLine: null; readonly text: string }
  | { readonly kind: 'addition'; readonly oldLine: null; readonly newLine: number; readonly text: string }
```

`text` 保留 CRLF、LF、CR、空白、Unicode 表达和末尾换行；相同输入返回空 hunks 和空 `unifiedText`。有差异时，unified header 使用稳定的 `<tree>:working-copy` 或 `<tree>:<version-id>` 标签，缺少末尾换行会生成标准 marker。返回值只用于描述差异，不包含 patch/apply 能力。

默认 `contextLines` 为 3。Diff 使用有编辑距离上限的逐行 Myers 算法，不依赖第三方运行时包；以下限制可通过 `options.limits` 局部覆盖：

| 字段 | 默认值 | 计量方式 |
| --- | ---: | --- |
| `maxInputBytes` | 8 MiB | 两端 UTF-8 bytes 总和 |
| `maxInputLines` | 200,000 | 两端行数总和 |
| `maxEditLength` | 2,048 | 最大编辑距离 |
| `maxHunks` | 10,000 | 输出 hunk 数 |
| `maxOutputBytes` | 16 MiB | `unifiedText` UTF-8 bytes |

任何限制超出都会整体抛出 `MdvError` 的 `LIMIT_EXCEEDED`，不返回截断结果；`details` 包含 `limit`、`maximum` 和 `observed`。

## 完整性诊断

`verifyMdv` 是 package-root 顶层函数，不要求先成功 `openMdv`：

```ts
const report = await verifyMdv('/documents/example.mdv', {
  mode: 'full',
  maxIssues: 100,
})
```

```ts
type VerifyMode = 'metadata' | 'full'

interface VerifyReport {
  readonly mode: VerifyMode
  readonly valid: boolean
  readonly complete: boolean
  readonly issues: readonly VerifyIssue[]
  readonly warnings: readonly MdvWarning[]
}

interface VerifyIssue {
  readonly code: MdvErrorCode
  readonly message: string
  readonly entry?: string
  readonly path?: string
  readonly details: MdvErrorDetails
}
```

- `metadata` 是默认模式，检查 ZIP 安全边界、固定布局、manifest、工作副本、Head、全部版本 metadata 和 parent/bind 图，但不读取历史正文；
- `full` 在此基础上用一次归档扫描检查所有历史正文，包括不在当前 Head ancestry 中的分支，并验证 UTF-8、字节长度和 SHA-256；
- `complete` 只表示请求范围是否完整检查，不代表内容有效；`valid` 仅在 `complete === true` 且没有 issue 时为 `true`；
- `maxIssues` 默认为 100，必须是正安全整数。达到上限且仍有内容未检查时，报告以 `complete: false` 明确标记；
- warning 不影响 `valid`；报告、issue、warning 和 details 都是冻结快照；
- 路径不存在或无法读取时仍分别抛 `NOT_FOUND` / `IO_ERROR`。一旦输入 bytes 可读，其余格式、图和正文问题进入报告；普通 open/read 继续保持 fail-fast；
- 诊断是纯只读操作，不获取 writer lock、不改变 generation/Head/工作副本，也不提供自动修复或忽略哈希选项。

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
- 两个 `current.md` 的编辑语义就是普通 Markdown 工作副本。编辑器内存 buffer 由宿主管理，Core 不保存未传入 save 的内容，也不建立额外 Draft model。
- 成功结果是新的路径绑定 `MdvDocument`。原对象仍代表打开时刻的不可变快照，后续写入应使用返回对象。
- `string` 按 UTF-8 编码；`Uint8Array` 会先复制。两者都必须是无 BOM 的合法 UTF-8，并受 `maxEntryBytes` 限制。
- `expectedGeneration` 必须是非负安全整数。Core 在取得跨进程锁并重开最新归档后执行 CAS；不匹配时返回 `CONFLICT`，不自动重试。
- 保存还校验打开时的 `documentId` 与规范目标路径，避免文件被另一个同 generation 文档替换或父目录 alias 被重定向后误写。
- `CONFLICT` 与普通编辑器发现文件被外部进程修改含义相同：Core 阻止静默覆盖，重新加载、比较、合并或另存为由宿主决定。

```ts
let document = await openMdv(path)

document = await document.saveDocument({
  markdown: '# New working copy\n',
  expectedGeneration: document.manifest.generation,
})
```

### 文件事务与支持边界

Writer 在目标同目录创建 mode `0600` 的唯一临时 ZIP，逐条复制并校验历史内容，使用完整 Reader 验证新包，刷新临时文件后再发布。保存以同目录原子 replace 为 commit point；POSIX 本地文件系统随后同步父目录。commit point 前失败时旧包保持 byte-for-byte 不变；commit point 后若目录同步失败，错误 details 会包含 `committed: true` 和已发布的 generation，调用方必须重新 `openMdv` 确认状态。

当前写入保证限定在提供可靠目录创建、同目录 rename/link 与 fsync 语义的本地文件系统。所有路径绑定写操作都拒绝最终 symlink、hard link 数大于 1 的目标和其他非普通文件。网络文件系统、FUSE、同步盘以及 ACL/xattr/owner/group 等额外文件元数据不在保持承诺内；POSIX mode 会在重写时保留，新建文件当前为 `0600`。本轮在 macOS 上实测；Linux 使用同一 POSIX 事务路径，但正式 CI 矩阵留到发布收口阶段。

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
| `CONFLICT` | generation/document/path 身份冲突、目标已存在、已被其他 writer 锁定，或 checkout 遇到 dirty 工作副本 |

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

## Commit 与 Checkout

M4 在同一个 `MdvDocument` facade 上提供以下 API，相关类型均从 `@mdv/core` package root 导出：

```ts
interface CommitInput {
  readonly expectedGeneration: number
  readonly actor: Actor
  readonly summary: string
}

interface CommitDocumentInput extends CommitInput {
  readonly referenceVersion: VersionId | null
}

type CommitResult =
  | {
      readonly created: true
      readonly version: VersionId
      readonly document: MdvDocument
    }
  | {
      readonly created: false
      readonly reason: 'no-changes'
      readonly document: MdvDocument
    }

interface CheckoutInput {
  readonly version: VersionId
  readonly expectedGeneration: number
  readonly discardChanges?: boolean
}

interface MdvDocument {
  commitReference(input: CommitInput): Promise<CommitResult>
  commitDocument(input: CommitDocumentInput): Promise<CommitResult>
  checkoutReference(input: CheckoutInput): Promise<MdvDocument>
  checkoutDocument(input: CheckoutInput): Promise<MdvDocument>
}
```

commit 示例：

```ts
const result = await document.commitDocument({
  referenceVersion: null,
  actor: { type: 'human', name: 'Hypnos' },
  summary: 'Create the first version',
  expectedGeneration: document.manifest.generation,
})

document = result.document
if (result.created) {
  console.log(result.version)
}
```

行为契约：

- commit 不接收 `markdown`，只固化已经通过 save 持久化的目标 `current.md`；宿主若还有未保存的内存 buffer，应先 save；
- 第一次显式 commit 即使正文为空，也创建 parent 为 `null` 的根 Version；初始化本身仍不自动创建空版本；
- 已有 Head 时，Reference 正文未变化，或 Document 正文与 bind 都未变化，返回 `created: false`；这次成功事务仍让 generation 精确增加 1；
- Document 正文相同但显式 bind 改变时仍创建 Version；bind 只写入新 Document Version，不写工作副本；
- checkout 默认检测 `current.md` 相对 Head 是否 dirty；dirty 时返回 `CONFLICT`，只有显式 `discardChanges: true` 才覆盖工作副本；
- checkout 将历史正文复制到对应 `current.md` 并移动 Head，不创建 Version、不删除后代，成功时 generation 增加 1。

`actor.type` 只接受 `human` 或 `agent`；可选 `actor.id`/`actor.name` 必须是长度不超过 256 的非空字符串；`summary` trim 后必须非空且最多 4096 个字符。`commitDocument.referenceVersion` 必须显式提供：`null` 表示不依赖 Reference，非空值必须是当前包中已存在的 Reference Version。不存在或属于错误树的 Version 选择返回 `NOT_FOUND`；dirty checkout 的 `MdvError.details` 包含 `reason: 'working-copy-dirty'` 和目标 tree。

## 当前未提供

- 受管资源 import/resolve/read API；
- Markdown parser、AST 或 renderer。

这些能力的开发状态见[路线图](./design/roadmap.md)。
