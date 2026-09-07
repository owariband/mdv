# MDV Core 架构与产品设计（Draft 0.5）

> 状态：设计草案
>
> 范围：`.mdv` 开放格式及其 TypeScript 解析/写入库
>
> 不在范围：VS Code / MarkText 的具体 UI，以及 Markdown 解析与渲染实现
>
> 文档属性：维护者设计，包含未来能力；当前可用接口见 [`api-reference.md`](../api-reference.md)

## 1. 背景与目标

MDV（Markdown Document with Versions）是一种带版本语义的 Markdown 文档类型。它以单篇文档为边界，同时保存：

- 一份可持续修改的 Markdown 摘要或参考内容；
- 一份可由人或 Agent 持续修改的 Markdown 成品；
- 摘要与成品各自通过显式 commit 产生的版本历史；
- 每个成品版本实际依据的精确摘要版本，或明确记录该版本没有摘要依赖；
- 随时可打开或导出的当前 Markdown 成品。

本项目首先完成独立的 `@mdv/core`。它是 `.mdv` 的官方 TypeScript 参考实现，但不是格式本身的唯一事实来源。语言无关规范、一致性样例和 Schema 与 Core 同级；Core 0.1 闭环完成后，VS Code extension 作为第一个图形客户端，MarkText adapter 后续接入。

### 1.1 核心语义

MDV 的核心不是 Named Ref，而是“工作副本 + 两类 commit 历史”：

```text
ref_tree/current.md（可变摘要工作副本）
        |
        | commit reference
        v
R1 -> R2 -> R3                 Reference Version 历史
      |     |
      |     +----------------------+
      | document.referenceVersion  | document.referenceVersion
      v                            v
D1 -> D2 -> D3                 Document Version 历史
        ^
        | commit document
        |
doc_tree/current.md（可变成品工作副本）
```

- `ref_tree/current.md` 和 `doc_tree/current.md` 可以反复保存，不产生历史版本。
- 只有显式 `commit` 才创建不可变版本。
- 每个 Document Version 可以绑定一个精确的 Reference Version；不使用摘要能力时也可以显式不绑定。
- 摘要更新后产生 R2，不会修改仍绑定 R1 的旧成品版本。
- 不额外维护 `seed`、`requirements`、`approved`、`published` 等命名指针。

### 1.2 设计目标

1. **开放可读**：不依赖 MarkText、数据库或在线服务即可读取当前内容和历史。
2. **正文保真**：Core 原样保存 UTF-8 Markdown 字节，不解析、格式化或重新序列化正文。
3. **保存与版本分离**：普通保存只更新工作副本；显式 commit 才增加历史节点。
4. **历史可追踪**：版本不可变，父版本、绑定的 Reference Version、作者和变化摘要可追溯。
5. **Agent 友好**：先读取轻量索引，按需读取正文；Agent 可以多次保存草稿后再 commit。
6. **并发安全**：所有写入使用比较后交换语义和原子替换，不静默覆盖其他写入者。
7. **跨实现一致**：文字规范、JSON Schema、合法/非法 fixtures 和参考实现共同约束行为。

### 1.3 非目标

- 不重新定义 Markdown 语法，也不提供 `@mdv/markdown-parser`。
- 不把 Muya AST、`marked` token 或 HTML 当作版本事实来源。
- 0.1 不提供用户自定义 Named Ref、tag、branch name、merge commit、rebase、index 或 stage。
- 0.1 不提供 `approved`、`published` 等工作流状态；需要时由上层产品另行设计。
- 0.1 不提供多用户权限系统、数字签名或恶意作者身份认证。
- Core 不决定编辑器何时自动保存；客户端调用保存 API 时只更新工作副本。

## 2. 0.1 实现基线

需求中尚未冻结的物理格式先采用以下实现基线。在 `spec/format-0.1.md` 冻结前仍可调整，但实现期间不同时维护第二套编码。

| 议题 | 0.1 基线 | 原因 |
| --- | --- | --- |
| 物理编码 | ZIP 单文件，扩展名 `.mdv` | 便于传输、文件关联和跨平台实现 |
| 工作副本 | `ref_tree/current.md` 与 `doc_tree/current.md` | 两棵树各自管理当前内容和版本；保存不等于 commit |
| 版本产生 | 只有显式 commit | 与 Git 的工作区/版本语义一致，避免自动保存制造版本噪声 |
| 历史结构 | 两条单父版本历史；允许从旧版本继续，不支持 merge | 满足回看和恢复，同时控制复杂度 |
| 版本关联 | Document Version 绑定一个精确 Reference Version，或显式为 `null` | 支持可追溯的摘要驱动文档，也允许退化为普通带版本 Markdown |
| 正文存储 | 每个 commit 保存完整 Markdown 快照 | 易恢复、易校验；Diff 按需计算 |
| 受管资源 | 0.1 使用外部内容寻址 sidecar，不打包、不纳入版本哈希 | 保持 Markdown 相对路径可读，同时避免可变映射 |

## 3. 领域模型

### 3.1 工作副本

一个 MDV 文档始终有两份可变工作副本：

- **Reference Working Copy**：当前摘要、需求骨架、约束或调查输入，物理文件为 `ref_tree/current.md`。
- **Document Working Copy**：当前成品或 Agent 草稿，物理文件为 `doc_tree/current.md`。

普通保存只更新工作副本。保存后的内容即使尚未 commit，也必须随 `.mdv` 文件持久化，关闭编辑器后不能丢失。

新建 `.mdv` 时两个工作副本都是零字节 Markdown，两个版本目录为空，两个 Head 均不存在，`generation = 0`。初始化不会伪造“空的 R1/D1”；第一次显式 commit 才产生第一个版本。

工作副本分别记录自己的基准版本：

- `ref_tree/HEAD`：表示摘要工作副本当前基于的 Reference Version；
- `doc_tree/HEAD`：表示成品工作副本当前基于的 Document Version。

这两个 Head 是格式必需的结构字段，作用类似 Git 的 HEAD：用于判断工作副本是否有未提交变化，以及下一次 commit 的 parent。它们不是用户命名的 Ref，也不存在 `refs/**` 目录。

Agent 在需要摘要输入的任务期间固定一个精确 Reference Version ID，并在 Document commit 时提交它；不需要摘要时显式选择 `null`。这个未提交的任务选择不进入 MDV 格式；Reference Tree 不维护 bind。

### 3.2 Version

Document、Version ID 都是路径安全的随机不透明标识：分别使用 `d_`、`v_` 加 32 位小写十六进制字符，由密码学安全随机源产生。调用方不得从 ID 推断时间或顺序。UI 中的 `R1`、`D3` 只是按历史计算出的展示序号。

```ts
type DocumentId = `d_${string}`
type VersionId = `v_${string}`
interface Actor {
  type: 'human' | 'agent'
  id?: string
  name?: string
}

interface VersionMeta {
  schemaVersion: 1
  id: VersionId
  parent: VersionId | null
  createdAt: string
  actor: Actor
  summary: string
  contentSha256: string
  contentBytes: number
}

interface DocumentVersionMeta extends VersionMeta {
  referenceVersion: VersionId | null
}
```

约束：

- `createdAt` 使用带时区的 RFC 3339 时间；排序相同时以 Version ID 稳定排序。
- `summary` 必须非空；它描述本次 commit，不替代正文。
- `ref_tree/versions/*/meta.json` 使用 `VersionMeta`；其 `parent` 只能指向 `ref_tree/versions/` 中的版本。
- `doc_tree/versions/*/meta.json` 使用 `DocumentVersionMeta`；其 `parent` 只能指向 `doc_tree/versions/` 中的版本。
- `DocumentVersionMeta.referenceVersion` 为非空时，必须指向 `ref_tree/versions/` 中一个精确的 Reference Version；为 `null` 表示该成品版本没有摘要依赖。
- 版本类型由所在树决定，不在每个 `meta.json` 中重复保存 `kind`。
- `contentSha256` 对 `content.md` 原始字节计算；Core 不做换行或 Unicode 归一化。
- 版本内容一经写入不得原地修改。修订内容只能修改工作副本并再次 commit。

### 3.3 Head 与分叉

两棵树中的 `HEAD` 表示各自工作副本基于的已提交版本：

```text
ref_tree/HEAD = R2
doc_tree/HEAD = D3
```

查看历史版本不会改变 Head 或工作副本。只有显式 checkout 才会：

- 将目标版本正文复制到对应工作副本；
- 将对应 Head 设置为目标版本；
- checkout Document Version 后，调用方可以从该版本的 `meta.json.referenceVersion` 读取它原来的 Reference 输入。

从旧版本 checkout 后再次 commit 会形成分叉。旧版本和原来的新版本都保留在包内，不需要 branch name 才能读取。0.1 不做自动垃圾回收。

### 3.4 Dirty 与漂移

Reference Working Copy 为 dirty，当且仅当：

- 没有 `ref_tree/HEAD` 且 `ref_tree/current.md` 非空；或
- `ref_tree/current.md` 的 SHA-256 与 `ref_tree/HEAD` 对应版本正文不同。

Document Working Copy 为 dirty，当且仅当：

- 没有 `doc_tree/HEAD` 且 `doc_tree/current.md` 非空；
- 或 `doc_tree/current.md` 的 SHA-256 与 `doc_tree/HEAD` 对应版本正文不同。

工作副本本身不保存 bind。即使成品文字没有变化，只要 `commitDocument` 传入了新的 Reference Version，仍然创建一个具有新版本语义的 Document Version。

已提交且绑定了 Reference 的成品发生 Reference 漂移，当：

```text
doc_tree/versions/<doc_tree/HEAD>/meta.json.referenceVersion
  != ref_tree/HEAD
```

漂移只产生状态提示，不自动修改 `doc_tree/current.md`，也不自动创建新版本。

`referenceVersion = null` 是合法的 unbound 状态，不算格式错误，也不算漂移。没有使用 Reference 的文档可以一直只提交 Document Version，从而退化为普通的带版本 Markdown 文档。

## 4. `.mdv` 物理格式

### 4.1 逻辑结构

```text
example.mdv
├── manifest.json
├── ref_tree/
│   ├── HEAD                         # 首次 reference commit 前可缺省
│   ├── current.md                   # 可变摘要工作副本
│   └── versions/
│       └── <reference-version-id>/
│           ├── meta.json
│           └── content.md
└── doc_tree/
    ├── HEAD                         # 首次 document commit 前可缺省
    ├── current.md                   # 可变成品工作副本
    └── versions/
        └── <document-version-id>/
            ├── meta.json
            └── content.md
```

- `ref_tree` 和 `doc_tree` 各自拥有工作副本、Head 和版本目录，物理结构直接表达两棵历史树。
- 两个 `current.md` 是可变工作副本；两个 `versions/<id>/content.md` 是 commit 产生的完整、不可变 Markdown 快照。
- `meta.json` 保存 parent、作者、摘要和内容哈希；Document Version 额外保存 `referenceVersion`。
- Reference/Document 的历史索引分别扫描本树中的 `meta.json` 重建，不依赖编辑器私有缓存。
- 不存在 `refs/`、Named Ref 文件或指针事件目录。

### 4.2 manifest

```json
{
  "format": "mdv",
  "formatVersion": "0.1",
  "documentId": "d_0123456789abcdef0123456789abcdef",
  "generation": 7,
  "markdownProfile": "gfm"
}
```

- `manifest.json` 是容器的自描述入口：Reader 通过它确认这是 MDV、选择格式解码器，并读取并发控制所需的 generation。
- `formatVersion` 使用 `major.minor`。0.x 阶段 Reader 只接受自己明确支持的 minor；1.0 后未知 major 必须拒绝。
- `generation` 在每次成功保存、commit 或 checkout 后递增，用于阻止并发写入互相覆盖。
- `markdownProfile` 只向外部 Markdown 解析器声明建议语法配置；Core 不据此解析或重写正文。未知值不妨碍读取，但应产生 warning。
- manifest 不重复保存 Head、版本列表或 bind；这些信息均由两棵树的真实条目重建。

### 4.3 初始化状态

`createMdv` 创建一个有效但没有历史版本的包：

```text
generation = 0
ref_tree/current.md = <empty>
doc_tree/current.md = <empty>
ref_tree/HEAD = <absent>
doc_tree/HEAD = <absent>
ref_tree/versions/ = <empty>
doc_tree/versions/ = <empty>
```

Reference 工作副本可以永远为空且不 commit。此时 `commitDocument` 必须显式传入 `referenceVersion: null`；这样不会生成空 Reference Version，也不会丢失 Document 历史能力。

### 4.4 Head 与 bind 的存储位置

`ref_tree/HEAD` 和 `doc_tree/HEAD` 都是只包含一个 Version ID 和结尾 LF 的小型文本指针。新建文档尚无对应版本时允许缺省。

bind 只保存在 Document Version 一侧。调用方执行 `commitDocument` 时传入精确的 Reference Version ID 或 `null`，Core 将其写入新版本的 `meta.json.referenceVersion`。

例如：

```text
ref_tree/HEAD = R3
doc_tree/HEAD = D2

doc_tree/versions/D2/meta.json
  parent = D1
  referenceVersion = R2
```

Reference Tree 不保存“哪些 Document 绑定了我”的反向列表，原因是：

- 关系的真实方向是 Document → Reference；
- 新增 D3 时不能回头修改已经不可变的 R2；
- 双向存储会产生两份需要保持一致的事实来源。

如需回答“R2 影响了哪些 Document Version”，Reader 扫描 `doc_tree/versions/*/meta.json.referenceVersion` 并建立内存反向索引即可。这个索引可重建，不写回格式。

Document Version 的 `referenceVersion` 可以落后于 `ref_tree/HEAD`。这是可报告的漂移，不是格式错误，也不能被 Reader 自动修正。

### 4.5 ZIP 编码规则

0.1 Writer 遵循以下规则：

- 根目录必须存在且只存在一个 `manifest.json` 入口；文件扩展名只用于文件关联，Reader 以 ZIP 结构和 manifest 内容判断格式。
- 所有条目名使用 `/`、UTF-8 和 Unicode NFC，不包含绝对路径、空段、`.`、`..`、反斜杠、NUL 或符号链接。
- 禁止加密条目、重复条目、大小写折叠后冲突和 Unicode 规范化后冲突。
- JSON 和 Markdown 均为 UTF-8；JSON 不允许重复键。
- `HEAD` 指针文件只包含一个 Version ID 和结尾 LF。
- 条目可使用 Store 或 Deflate；ZIP 时间戳不是协议语义，不参与版本排序和哈希。
- Writer 输出确定的条目顺序；Reader 不依赖 ZIP 条目顺序。

### 4.6 相对链接与受管资源

0.1 不将附件写入包内。Markdown 中的相对链接和图片地址以 `.mdv` 文件所在目录作为基准，而不是以 ZIP 内路径为基准。`export` 只导出 Markdown，不隐式复制外部附件。

官方 Core 将提供外部受管资源能力。导入的图片等资源使用内容寻址 sidecar：

```text
example.mdv
.mdv-assets/<documentId>/<sha256>.<extension>
```

Markdown 直接记录相对路径 `./.mdv-assets/<documentId>/<sha256>.<extension>`。路径本身就是不可变内容引用，不在 manifest 中重复维护可变的 `path -> hash` 映射。Core 负责资源导入、相对路径解析、读取与 SHA-256 校验；宿主负责 paste/drop、把返回的相对路径插入 Markdown，以及最终渲染。Core 不扫描或解释 Markdown AST。

资源仍不进入 `.mdv` ZIP，也不计入 Version 的正文哈希。相同 hash 文件只复用、不覆盖，0.1 不自动垃圾回收。只要 sidecar 仍存在，旧版本正文中的 hash 路径即可解析到原资源；单独移动或分享 `.mdv` 仍可能丢失资源。把资源内嵌并纳入版本完整性属于后续格式版本。

## 5. Reader 与 Validator

### 5.1 打开流程

`open` 的主流程保持直接，历史正文按需读取：

```text
检查 ZIP 结构并读取根 manifest
-> 建立安全条目索引并执行资源上限检查
-> 分别解析 ref_tree、doc_tree 的指针和 version meta
-> 校验 ID、Schema、Head、parent 和 referenceVersion
-> 校验两条 parent 图无环
-> 计算 dirty 与 Reference 漂移状态
-> 返回只包含元数据索引的 DocumentSnapshot
```

`open` 不默认解压所有历史 `content.md`。`readVersion` 首次读取某版本正文时验证长度和 SHA-256；`verify({ mode: 'full' })` 才遍历全部正文。

### 5.2 必须校验的语义

1. 根 manifest 存在且 `format`、`formatVersion` 受支持。
2. Version ID 与目录名、`meta.json.id` 一致，并且在整个文档内唯一。
3. `ref_tree/HEAD` 为空或指向本树版本；`doc_tree/HEAD` 为空或指向本树版本。
4. 两棵树中每个版本的 `parent` 为空或指向同一棵树中的版本。
5. 每个 Document Version 的 `referenceVersion` 为 `null`，或指向 `ref_tree/versions/` 中的版本。
6. Reference 和 Document 的 parent 子图分别无环。
7. 两个工作副本以及所有版本正文都是有效 UTF-8；版本正文长度和 SHA-256 与元数据一致。
8. ZIP 路径、条目数量、解压大小、压缩比和 JSON 深度不超过安全上限。

允许存在未被当前 Head 可达的版本。它们可能来自历史分叉，不应在打开时删除。

generation 为 0、工作副本为空、没有任何版本和 Head 的新建包是合法初始化状态。

### 5.3 资源上限

Reader 提供保守默认值，并允许受信任调用方下调或显式上调：

```ts
interface ReadLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalUncompressedBytes: number
  maxCompressionRatio: number
  maxVersions: number
  maxJsonBytes: number
  maxJsonDepth: number
}
```

检查必须尽可能在解压前或流式解压过程中完成，不能先把整个未知归档读入无界内存。

## 6. Core API

0.1 以 Node.js 20+ 和 TypeScript 为首个运行时。API 同时提供内存只读入口和文件读写入口；不提前引入没有实际替换需求的 public factory/interface 层。

```ts
export function parseMdv(
  bytes: Uint8Array,
  options?: ParseOptions,
): Promise<DocumentSnapshot>

export function openMdv(
  path: string,
  options?: OpenOptions,
): Promise<MdvDocument>

export function createMdv(
  path: string,
  options?: CreateOptions,
): Promise<MdvDocument>
```

`createMdv` 创建 generation 为 0 的空容器；目标路径已存在时失败，不能覆盖。

### 6.1 只读能力

```ts
interface MarkdownSource {
  readonly bytes: Uint8Array
  readonly markdownProfile: string
  readonly baseDirectory: string | null
  readonly origin: {
    readonly tree: TreeKind
    readonly kind: 'working-copy' | 'version'
    readonly version: VersionId | null
  }
}

interface MdvWarning {
  readonly code: 'UNKNOWN_FIELD' | 'UNKNOWN_MARKDOWN_PROFILE'
  readonly entry: string
  readonly path: string
  readonly message: string
}

interface DocumentSnapshot {
  readonly manifest: Manifest
  readonly packagePath: string | null
  readonly baseDirectory: string | null
  readonly referenceTree: { readonly head: VersionId | null }
  readonly documentTree: { readonly head: VersionId | null }
  readonly warnings: readonly MdvWarning[]
  readonly status: DocumentStatus

  listVersions(query: { readonly tree: 'reference' }): readonly ReferenceVersionSummary[]
  listVersions(query: { readonly tree: 'document' }): readonly DocumentVersionSummary[]
  listVersions(query?: VersionQuery): readonly VersionSummary[]
  getHistory(tree: 'reference', from?: VersionId): readonly ReferenceVersionSummary[]
  getHistory(tree: 'document', from?: VersionId): readonly DocumentVersionSummary[]
  getHistory(tree: TreeKind, from?: VersionId): readonly VersionSummary[]
  getChildren(tree: 'reference', version: VersionId): readonly ReferenceVersionSummary[]
  getChildren(tree: 'document', version: VersionId): readonly DocumentVersionSummary[]
  getChildren(tree: TreeKind, version: VersionId): readonly VersionSummary[]
  getDocumentReference(document: VersionId): VersionId | null
  listDocumentsUsingReference(reference: VersionId): readonly DocumentVersionSummary[]
  traceDocument(document: VersionId): DocumentTrace
  traceReference(reference: VersionId): ReferenceTrace
  readReference(): Promise<MarkdownSource>
  readDocument(): Promise<MarkdownSource>
  readReferenceText(): Promise<string>
  readDocumentText(): Promise<string>
  readVersion(id: VersionId): Promise<VersionRecord>
  readVersionBytes(id: VersionId): Promise<Uint8Array>
  readVersionText(id: VersionId): Promise<string>
  diff(from: ContentSpec, to: ContentSpec, options?: DiffOptions): Promise<DiffResult>
  getReferenceDrift(document?: VersionId): ReferenceDrift | null
  verify(options?: VerifyOptions): Promise<VerifyReport>
  exportMarkdown(source?: 'working' | VersionId): Promise<Uint8Array>
}
```

约定：

- `listVersions` 只返回轻量元数据，不返回正文。
- `listVersions`、`getChildren` 和反向 bind 结果按 RFC 3339 实际时刻升序排列，以 Version ID 打破平局；`getHistory` 从指定版本或 Head 沿 parent 返回到根。
- `getHistory`、`traceDocument` 和 `traceReference` 只遍历打开时建立的 parent/bind 索引；历史正文仍按需读取。
- `listDocumentsUsingReference` 从 Document Version 的单向 bind 建立反向内存索引，不向 Reference Version 写回数据。
- `readReference` 和 `readDocument` 分别读取 `ref_tree/current.md` 与 `doc_tree/current.md`，同时返回 profile、资源基准目录和来源描述。
- `readVersionBytes` 是正文保真的基础 API；`*Text` 是严格 UTF-8 解码的便利 API，不执行 Markdown 解析。
- `diff` 可以比较任意版本，也可以比较工作副本与其 Head。
- `exportMarkdown()` 默认导出 `doc_tree/current.md` 工作副本，而不是最后一次 commit。
- 所有返回集合和元数据都是只读快照，调用方修改它们不能改变包内容。

### 6.2 Markdown 内容交接边界

Core 只负责从 MDV 容器中定位并读取 Markdown，不负责把 Markdown 解析成 AST、编辑器 State 或 HTML，也不依赖任何渲染器的模型类型。

`openMdv(path)` 中的 path 是 `.mdv` 包路径。`doc_tree/current.md` 和历史 `content.md` 是 ZIP 内逻辑条目，并不存在可直接交给外部库的普通文件系统路径。因此：

- 基础接口返回原始 `Uint8Array`，保证正文可逐字节往返；
- `*Text` 便利接口返回严格解码的 UTF-8 字符串，Muya、remark 等适配器可直接消费；
- `packagePath` 只表示原始 `.mdv` 路径，`baseDirectory` 供上层解析相对图片和链接；
- 只接受文件路径的第三方库，由其 adapter 将内容导出到受控临时文件并管理清理、监听和回写，Core 不把临时路径作为主接口。

Core 的 public model 不兼容也不复用 Muya State、remark AST 或其他 Markdown parser AST。每个上层 adapter 只需完成 `UTF-8 string <-> renderer/editor model` 转换。

### 6.3 保存工作副本

```ts
interface SaveReferenceInput {
  markdown: string | Uint8Array
  expectedGeneration: number
}

interface SaveDocumentInput {
  markdown: string | Uint8Array
  expectedGeneration: number
}

interface MdvDocument extends DocumentSnapshot {
  saveReference(input: SaveReferenceInput): Promise<WriteResult>
  saveDocument(input: SaveDocumentInput): Promise<WriteResult>
}
```

- `saveReference` 只更新 `ref_tree/current.md`。
- `saveDocument` 只更新 `doc_tree/current.md`。
- 两种 save 都递增 generation，但都不创建 Version。

### 6.4 Commit

```ts
interface CommitInput {
  expectedGeneration: number
  actor: Actor
  summary: string
}

interface CommitDocumentInput extends CommitInput {
  referenceVersion: VersionId | null
}

interface MdvDocument {
  commitReference(input: CommitInput): Promise<CommitResult>
  commitDocument(input: CommitDocumentInput): Promise<CommitResult>
}
```

`commitReference`：

1. 读取 `ref_tree/current.md` 原始字节；
2. 以 `ref_tree/HEAD` 为 parent，在 `ref_tree/versions/` 创建新的 Reference Version；
3. 将 `ref_tree/HEAD` 更新为新版本；
4. 不修改任何已有 Document Version，也不替 Agent 选择新的绑定。

`commitDocument`：

1. 要求 `input.referenceVersion` 为 `null`，或指向精确、已提交的 Reference Version；
2. 读取 `doc_tree/current.md` 原始字节；
3. 以 `doc_tree/HEAD` 为 parent，在 `doc_tree/versions/` 创建 Document Version；
4. 把 `input.referenceVersion` 写入新版本的 `meta.json.referenceVersion`；
5. 将 `doc_tree/HEAD` 更新为新版本。

如果 Reference 工作副本相对 `ref_tree/HEAD` 没有变化，`commitReference` 返回 `created: false, reason: 'no-changes'`。Document 的正文未变化且传入的 Reference Version（包括 `null`）与 `doc_tree/HEAD` 对应版本相同时，`commitDocument` 同样不创建版本；如果正文相同但 bind 发生变化，仍然创建新 Document Version。

### 6.5 查看与恢复

```ts
interface CheckoutInput {
  version: VersionId
  expectedGeneration: number
}

interface MdvDocument {
  checkoutReference(input: CheckoutInput): Promise<WriteResult>
  checkoutDocument(input: CheckoutInput): Promise<WriteResult>
}
```

- 查看旧版本只调用 `readVersion`，不会改变工作状态。
- checkout 才把历史正文恢复到工作副本，并把相应 Head 设置为该版本。
- checkout Document Version 不额外写入 bind；该历史版本原来的 bind 始终保存在它自己的 `meta.json.referenceVersion` 中。
- checkout 不创建版本；用户继续修改并 commit 后才形成新历史节点。

### 6.6 能力到 API 的映射

| 产品能力 | Core API |
| --- | --- |
| 创建空容器 | `createMdv` |
| 打开并校验 | `openMdv` / `parseMdv` |
| 保存摘要但不产生版本 | `saveReference` |
| 保存成品但不产生版本 | `saveDocument` |
| 显式保存摘要版本 | `commitReference` |
| 显式保存成品版本 | `commitDocument` |
| 查看轻量历史 | `listVersions` |
| 沿 parent 追踪一棵树的历史 | `getHistory` / `getChildren` |
| 查看成品版本绑定的摘要 | `getDocumentReference` / `traceDocument` |
| 查看摘要的历史与受影响成品 | `traceReference` / `listDocumentsUsingReference` |
| 按需读取旧版本 | `readVersion` / `readVersionBytes` |
| 恢复旧版本到工作副本 | `checkoutReference` / `checkoutDocument` |
| 比较工作副本或版本 | `diff` |
| 检测 Reference 漂移 | `getReferenceDrift` |
| 全量完整性检查 | `verify({ mode: 'full' })` |
| 导出当前或历史 Markdown | `exportMarkdown` |

## 7. 写入与并发模型

save、commit 和 checkout 都是完整文档写事务：

```text
获取跨进程独占锁
-> 重新打开磁盘上的最新包
-> 检查 expectedGeneration
-> 校验本次操作的目标版本与类型
-> 更新工作副本，或增加不可变版本并更新 Head
-> 在同目录临时文件中写出完整新 ZIP
-> 对临时包执行结构与完整性校验
-> fsync 临时文件和必要的目录元数据
-> 原子替换原 .mdv
-> 释放锁并返回新 snapshot
```

generation 不匹配时返回 `CONFLICT` 和实际 generation，不自动重试或覆盖。调用方应重新打开文档，比较工作副本变化，再决定如何合并。

0.1 接受整包重写成本。实现可以直接复制未变化的 ZIP 条目，避免无意义地解压/重压历史正文，但不能就地改写旧包。大文档的内容去重、分块和增量容器属于后续格式版本。

## 8. Agent 工作流

Agent 一次成品编辑任务的标准流程：

1. 打开 `.mdv`，读取 status、`ref_tree/HEAD` 和 `doc_tree/HEAD`。
2. 如果任务依赖摘要，选择一个已经 commit 的 Reference Version 并固定其精确 ID；否则固定为 `null`。
3. 按需读取选中的 Reference Version、当前成品和少量相关历史，不加载全部正文；选择 `null` 时跳过 Reference 正文。
4. 调用 `saveDocument({ markdown })` 保存草稿；可以重复多次，不产生版本。
5. 用户或 Agent 明确决定保留版本时，调用 `commitDocument({ referenceVersion, actor, summary })`。
6. 新 Document Version 把这次 commit 传入的 ID 或 `null` 写入自己的 `meta.json.referenceVersion`，因此后续可以确定它基于哪个摘要版本，或确定它没有摘要依赖。

如果摘要工作副本有未提交修改，Agent 有两种明确选择：

- 继续使用已有 `ref_tree/HEAD`；或
- 先 `commitReference` 产生新 Reference Version，再把它传给 `commitDocument.referenceVersion`；或
- 仅当这次成品确实不依赖摘要时，显式传入 `null`。

Core 不允许 Document Version 绑定一份尚未 commit、未来还会变化的摘要工作副本。

## 9. Diff、漂移与导出

### 9.1 Diff

0.1 使用 Markdown 源文本逐行 Diff，支持：

- Document Version 与 Document Version；
- Reference Version 与 Reference Version；
- Reference Version 与 Document Version；
- 工作副本与其 Head；
- 任意工作副本与指定版本。

默认不忽略空白、换行符或 Unicode 差异。结果同时提供结构化 hunks 和 unified diff 文本。Reference → Document 的“标题覆盖率、要求是否落实”等语义 Diff 留到后续，不能替代原始文本 Diff。

### 9.2 Reference 漂移

Core 报告 `doc_tree/HEAD` 对应版本是否仍绑定当前 `ref_tree/HEAD`。Document Version 未绑定 Reference 时返回 unbound 状态，不伪造成漂移。

漂移结果只包含旧 Reference Version、新 Reference Version 和可用于 Diff 的版本对。Reference commit 不自动修改成品工作副本或历史版本。

### 9.3 导出

`exportMarkdown()` 默认导出当前 `doc_tree/current.md`，也可指定任意 Document 或 Reference Version。输出是原始 Markdown 字节，不添加 front matter、版本注释或重新格式化。

## 10. 错误模型

公共错误使用稳定 code，消息供人阅读，结构化 details 供程序分支：

```ts
type MdvErrorCode =
  | 'NOT_MDV'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_ARCHIVE'
  | 'INVALID_MANIFEST'
  | 'INVALID_TREE'
  | 'INVALID_VERSION'
  | 'INVALID_GRAPH'
  | 'INVALID_UTF8'
  | 'INTEGRITY_MISMATCH'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'IO_ERROR'
```

- 格式错误、完整性错误、并发冲突和 I/O 错误不得互相伪装。
- details 可包含条目路径、Version ID、预期值和实际值，不包含完整正文。
- `verify` 尽量收集多个独立问题；普通读取遇到阻断性问题立即失败。
- 未识别的同版本可选字段和 `markdownProfile` 进入 warnings，不进入 errors。
- 没有变化不是异常；commit 返回 `created: false`，不抛错误。

## 11. 安全边界

Reader 将 `.mdv` 当作不可信归档处理：

- 在分配大块内存前检查条目声明大小、总大小和压缩比；
- 拒绝 Zip Slip、重复/冲突路径、符号链接和加密条目；
- 对实际流式解压字节再次计数，不能只相信 ZIP header；
- 对 JSON 大小、深度、字符串长度和版本数设置上限；
- Diff 也有最大输入和输出上限，避免合法包触发不可控内存使用；
- 日志只记录 document ID、generation、Version ID、条目数、字节数和错误码，不记录正文、凭据或完整自由文本。

哈希用于检测损坏和实现错误，不提供作者真实性或抗恶意篡改证明。需要此能力时应在后续格式加入签名清单，而不是误用 `actor` 字段。

## 12. 包与模块边界

具体模块职责和模型映射见 [`mechanisms.md`](./mechanisms.md)。项目采用单个 `@mdv/core` 包，不使用 monorepo，也不把内部职责拆成多个 npm package：

```text
mdv/
├── package.json
├── tsconfig.json
├── docs/
│   ├── README.md
│   ├── getting-started.md
│   ├── concepts.md
│   ├── api-reference.md
│   ├── resources.md
│   ├── assets/
│   └── design/
│       ├── index.md
│       ├── architecture.md
│       ├── mechanisms.md
│       ├── roadmap.md
│       ├── decisions.md
│       ├── open-questions.md
│       └── log.md
├── spec/
│   └── format-0.1.md
├── schemas/
│   ├── manifest.schema.json
│   ├── reference-version.schema.json
│   └── document-version.schema.json
├── fixtures/
│   ├── valid/
│   ├── invalid/
│   └── expected/
├── src/
│   ├── index.ts
│   ├── mdv-document.ts
│   ├── types.ts
│   ├── errors.ts
│   ├── core/
│   └── archive/
└── test/
```

职责保持克制：

- `index.ts`、`mdv-document.ts`、`types.ts` 和 `errors.ts`：公开 facade、输入/输出 DTO 与错误码；不暴露 ZIP DTO 或内部可变状态。
- `core/`：版本图、trace、dirty/漂移、commit/checkout 规则和源文本 Diff；不解析 Markdown，也不执行 ZIP I/O。
- `archive/`：ZIP/JSON 编解码、格式 DTO、资源限制、锁、generation CAS、临时包校验和原子替换。
- `index.ts` 只重导出 public API；调用方不能越层导入 `core/` 或 `archive/`。

语义一致性由 `core/` 决定，物理包一致性和写入原子性由 `archive/` 保证。两者不能各自维护一套版本规则。

当前只有一个实现时不增加 `Manager`、`Service`、`Repository`、public factory 或只有一层转调的接口。真正需要浏览器存储或第二种后端后，再从已存在的 I/O 边界提取最小接口。

所有图形客户端的依赖方向必须保持：

```text
VS Code / MarkText -> host adapter -> @mdv/core -> .mdv
```

Core 不依赖 VS Code API、Electron、Vue、MarkText store、Muya state 或 Muya AST。宿主 adapter 从 Core 取得 UTF-8 字符串与资源基准，并把编辑后的 Markdown 字符串交回保存 API。

## 13. 宿主与 Agent 接入

`@mdv/core` 是被宿主进程 import 的库，不启动 HTTP 服务、后台 daemon 或 CLI 进程。VS Code、MarkText 等应用通过各自 adapter 调用 public API：

```text
host UI / editor -> host adapter -> @mdv/core -> example.mdv
```

Agent 本身也不直接触碰磁盘。模型发出工具调用，由 Agent Runtime 中注册的工具执行真正的文件操作：

```text
Agent model
  -> Agent Runtime 的 MDV tool
  -> @mdv/core
  -> example.mdv
```

普通 `.md` 是单个 UTF-8 文本文件，Agent Runtime 可以直接调用文件系统 read/write/patch。`.mdv` 是带不变量的 ZIP 文档包，修改时应由工具调用 Core，不能把内部 entry 当作普通路径直接覆盖。

Agent tool 可以是宿主内注册的 TypeScript 函数、一次性 Node.js 脚本或 MCP tool；是否采用哪种包装方式由 Agent 宿主决定，均不属于 MDV 格式或 Core 的内部层次，也不要求常驻服务。第一版不提供官方 CLI；将来出现独立的终端使用需求时，再把 CLI 作为 Core 的外部调用方单独立项。

## 14. 一致性测试与验证

### 14.1 Fixtures

至少覆盖：

- generation 为 0、两棵树中工作副本为空且没有 Head 的初始化包；
- Reference 始终为空，只有 `D1(referenceVersion=null) -> D2(referenceVersion=null)` 的普通版本文档；
- `ref_tree/current.md` 已保存但尚未 commit；
- R1 已 commit，成品工作副本固定使用 R1，但尚无 D1；
- `R1 -> R2` 与 `D1(referenceVersion=R1) -> D2(referenceVersion=R2)`；
- Reference/Document 各自从旧版本分叉；
- 两棵树各自的工作副本 dirty；
- 悬空 Head、parent 或非空 `referenceVersion`；
- parent 跨树、Document 绑定 Document、parent 环和重复 Version ID；
- 版本长度或版本哈希不一致；
- 重复 ZIP 条目、Zip Slip、大小写/NFC 冲突和 ZIP bomb 边界；
- 未知 format version、未知可选字段和未知 `markdownProfile`。

每个 fixture 都附带机器可读的预期结果：是否成功、错误 code、版本索引、dirty 状态和漂移结果。

### 14.2 Core 测试

1. Reader/Validator 的单元与 fixture 测试。
2. 任意输入不崩溃的 archive/JSON fuzz 测试。
3. 工作副本和版本正文 byte-for-byte round-trip，包括 CRLF、中文、front matter、代码块、表格、数学公式和 Mermaid。
4. 连续多次 save 不增加版本数；commit 只增加一个版本。
5. `referenceVersion: null` 可以在零个 Reference Version 的包中连续创建 Document 历史。
6. 正文与绑定 Reference（包括 `null`）都未变化时 commit 不创建版本。
7. 正文未变化但绑定 Reference 改变时，document commit 创建新版本。
8. checkout 只恢复工作状态；后续 commit 才形成分叉。
9. `getHistory`、`traceDocument`、`traceReference` 在直线历史与分叉历史中返回正确关系。
10. 原子写入故障注入：在写 ZIP、校验、fsync、替换各阶段失败，旧包仍可读。
11. 两个 writer 使用相同 generation 时，最多一个成功，另一个得到 `CONFLICT`。
12. `save -> commit -> reopen -> verify(full) -> export` 端到端测试。
13. 后续 Python 只读实现运行同一套 fixtures，证明格式未绑定 TypeScript。

宿主编辑器的 `Markdown -> editor state -> Markdown` 稳定性属于对应 adapter 的集成测试。Core 只保证交给它的 Markdown 字节不会被自己改写。

## 15. 最小闭环验收

第一版完成时，以下流程必须通过 Core API 执行：

1. 新建包中两个工作副本为空、没有 R1/D1，也没有 Head。
2. 用户不使用 Reference，编辑并多次保存 `doc_tree/current.md`；版本历史仍为空。
3. 用户执行 `commitDocument(referenceVersion: null)` 生成 D1；重新打开后可以 trace、读取和导出 D1。
4. 在另一份文档中，用户编辑 `ref_tree/current.md` 并多次保存；Reference 历史仍为空。
5. 用户显式 commit，生成 Reference Version R1，`ref_tree/HEAD = R1`。
6. Agent 固定 R1，编辑并多次保存成品，然后执行 `commitDocument(referenceVersion: R1)` 生成 D1。
7. 用户修改摘要并显式 commit 生成 R2；旧 D1 仍绑定 R1，Core 报告漂移。
8. Agent 比较 R1 → R2，修改当前成品并显式 commit 生成 D2；`D2.parent = D1`、`D2.referenceVersion = R2`。
9. `traceDocument(D2)` 能返回 D2 的 Document ancestry 与 R2；`traceReference(R1)` 能返回 Reference ancestry 与绑定 R1 的 Document Versions。
10. 用户可以查看旧版本、checkout 到工作副本、从旧版本继续形成分叉，并导出当前或任意历史 Markdown。
11. 并发 writer 使用旧 generation 保存或 commit 时得到冲突，不覆盖另一方的工作副本或版本。

## 16. 实施顺序

1. 评审并冻结 ZIP、最小 manifest、`ref_tree` / `doc_tree`、nullable Document Version bind、Version ID 和附件边界。
2. 写 `spec/format-0.1.md`、三个 JSON Schema 和第一批合法/非法 fixtures。
3. 实现只读 Core：`parse/open`、工作副本读取、版本索引、trace、`readVersion`、`verify`、`exportMarkdown`。
4. 实现工作副本 Writer：`saveReference`、`saveDocument`、generation CAS 和原子替换。
5. 实现 `commitReference`、`commitDocument` 和 checkout。
6. 实现 Diff 和 Reference 漂移。
7. 实现内容寻址外部资源的导入、解析、读取与校验，不把 paste/drop 或渲染逻辑带入 Core。
8. 用真实复杂 Markdown 和资源 sidecar 验证 Core 闭环，再启动独立 VS Code extension；MarkText adapter 后续接入。

第一步不是在任何编辑器的扩展名白名单中加入 `.mdv`。只有格式、fixtures 和 Core 先形成独立边界，MDV 才不会变成只能由单一编辑器理解的私有文件。

## 17. Format 0.1 冻结项

首份语言无关规范见 [`format-0.1.md`](../../spec/format-0.1.md)。实现基线固定为：

1. 0.1 Writer 不生成 ZIP64，Reader 拒绝 ZIP64、多磁盘和加密 ZIP；实现可设置更低的可配置资源上限。
2. 同一 minor 中的未知 JSON 字段允许读取并产生 warning；Writer 重写对应对象时必须保留未知字段和值。`gfm` 是 0.1 唯一登记的 `markdownProfile`，其他合法 token 产生 warning 而不是读取失败。
3. 普通 `.md` 转换默认只填充 Document Working Copy，不隐式 commit。是否立即生成 D1 必须由上游产品显式选择。
4. 何时进入 0.2 的内容去重或增量容器不属于文件格式语义，在真实历史规模基准测试后单独决策。
