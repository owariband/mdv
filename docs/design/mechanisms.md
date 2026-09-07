# MDV Core 技术机制与实现方案（Draft 0.6）

> 状态：项目结构与模型设计草案
>
> 适用范围：`@mdv/core` 的 TypeScript 实现、本地文件事务和 Library API
>
> 产品语义与文件格式以 [`architecture.md`](./architecture.md) 为准；本文不重复定义另一套格式
>
> 文档属性：维护者设计，包含尚未落地的机制；当前可用接口见 [`api-reference.md`](../api-reference.md)
>
> 实现进度：M4 已完成；save、commit 和 checkout 已从 package root 提供，并复用同一文件事务。

## 1. 已确定的技术结论

1. `@mdv/core` 是单个 npm package，内部依赖方向为 `public facade -> core -> archive`。
2. Core 解析的是 MDV 容器、版本图和操作语义，不解析或渲染 Markdown。
3. Markdown 原始 UTF-8 字节是保真边界，字符串是给编辑器和解析器使用的便利接口。
4. 不能只把 path 当作 Markdown 交接接口：`.mdv` 有文件路径，但 ZIP 内的 `current.md` 和 `content.md` 没有独立的文件系统路径。
5. 持久化 DTO、内部领域模型和公开 API DTO 按边界区分；不为了名称形式给每个类型机械复制三份。
6. Core 不兼容或复用 Muya、remark、markdown-it 等库的 AST/model。第三方兼容放在调用方 adapter。
7. 当前只有 ZIP 一种后端，不提前增加 `Repository`、`Manager`、`ServiceFactory` 或可插拔存储接口。
8. `mimetype` 条目不进入 0.1；根 `manifest.json` 是格式识别和并发 generation 的入口。
9. CLI 是独立的上游业务项目，不属于 `@mdv/core` 的源码、发布包或内部层次。
10. Core 不依赖 CLI，也不定义 argv、JSON envelope 或退出码；它只提供足够稳定的 public API 供 CLI、VS Code、MarkText 和其他宿主调用。
11. 外部受管资源属于 Core 的文件语义：Core 负责内容寻址、相对路径解析、读取、写入和哈希校验；宿主负责 paste/drop、Markdown 插入与渲染。
12. Public `interface` 只描述调用方实际消费的对象契约；泛型只在能保留真实类型关系或复用同一校验逻辑时使用，不把“库”设计成多层通用框架。
13. 普通编辑沿用 Markdown 的既有模型：宿主拥有内存 buffer，Core 只持久化 `current.md`。不引入 `DraftVersion`、`workspace`、pending bind 或另一套草稿状态机。

## 2. 责任边界

### 2.1 Core 负责

- 创建、打开和校验 `.mdv`；
- 读取 Reference/Document 工作副本和历史版本正文；
- 构建两棵 parent 图、children 索引和 Document → Reference bind 索引；
- 查询历史、分叉、Document trace、Reference trace 和漂移；
- 保存工作副本，显式 commit，checkout 和源文本 Diff；
- generation CAS、跨进程锁、完整新包校验和原子替换；
- 管理 `.mdv` 同级内容寻址 sidecar 中的受管资源；
- 对外返回稳定错误码和只读结果。

### 2.2 Core 不负责

- Markdown token、AST、编辑器 State 或 HTML 的生成；
- GFM、数学公式、Mermaid 等具体语法的解释；
- Electron/Vue UI、自动保存时机、Agent 任务调度和审批发布流程；
- 编辑器内存 buffer、撤销栈、光标状态，以及冲突后的 UI 重载、比较或合并决策；
- 把不同 Markdown 解析器的模型统一成一种“万能 AST”；
- 扫描或改写 Markdown 中的任意链接、下载网络资源、处理宿主 paste/drop、渲染图片；
- 自动删除受管资源，或保证未随 `.mdv` 一同移动的 sidecar 仍然可用。

### 2.3 Markdown 为什么不能只返回 path

```text
/documents/example.mdv                 # 真实文件系统路径
  └── doc_tree/current.md              # ZIP 内逻辑条目，不是真实文件路径
```

把 `/documents/example.mdv` 传给普通 Markdown renderer，它只能读到 ZIP 字节，读不到内部 Markdown；把 `doc_tree/current.md` 传给它，则对应路径在操作系统上根本不存在。

Core 的主交接方式因此是：

```text
.mdv path / bytes
        |
        v
@mdv/core --读取容器--> Markdown bytes / UTF-8 text + baseDirectory
                                      |
                                      v
                         VS Code / MarkText adapter / 其他 parser
                                      |
                                      v
                           editor state / AST / HTML
```

主流 Markdown 编辑器和 parser 都可以直接接收 Markdown 字符串，因此 adapter 不需要先落一个临时 `.md`。如果将来某个外部工具只接受 path，由那个 adapter 显式导出临时文件，并负责临时文件的清理、监听、冲突和回写；这不是 Core 的默认数据模型。

### 2.4 Agent 实际如何修改文件

LLM 只产生工具调用意图，真正读写文件的是 Agent Runtime。以当前这类 coding agent 为例：

```text
模型生成 tool call
-> Agent Runtime 校验权限并调用文件工具
-> 文件工具直接调用本地文件系统或格式库
-> 将结果返回模型
```

不同文件类型只是在最后一步使用的执行器不同：

| 目标 | 实际执行方式 | 是否需要常驻服务 |
| --- | --- | --- |
| 本地 `.md` | 文件系统 read/write/patch | 否 |
| 本地 `.docx` | DOCX 库或脚本修改 ZIP/XML，并进行渲染校验 | 否 |
| 本地 `.mdv` | Agent tool 在进程内调用 `@mdv/core`，或执行官方 `mdv` CLI | 否 |
| 飞书、Google Docs 等云文档 | 调用远端文档 API | 是，由云平台提供而不是本地文件库启动 |

`exec`/shell 只是另一种工具执行方式：它通常启动一次性子进程，命令结束后进程退出。CLI 不等于服务，也不是 Core 修改文件的内部依赖。独立的 `mdv-cli` 上游项目可以把 Core 包装成可安装的 Agent/Human tool，使不方便直接 import TypeScript 的宿主也能安全操作 `.mdv`。

## 3. 三层架构

```text
VS Code / MarkText adapter / TypeScript 宿主 -+
                                           |
独立 mdv-cli 项目 -------------------------+
                                           |
                                           v
                                  @mdv/core public facade
                                           |
                                           v
                                  core（模型与用例规则）
                                           |
                                           v
                                  archive（ZIP 与本地事务）
                                           |
                                           v
                                        .mdv 文件
```

依赖只能向下：

- public facade 由根目录下的 `index.ts`、`mdv-document.ts`、`types.ts` 和 `errors.ts` 组成，可以导入 `core/`，但不能暴露 `archive/` 类型；
- `core/` 可以调用具体的 `archive/` 模块；
- `archive/` 不导入 public facade 或 `core/`，只处理格式 DTO、字节、路径和事务；
- `index.ts` 是唯一 public export 入口。
- 上游 `mdv-cli` 只能依赖 `@mdv/core` 的公开 package export，不能导入 `core/` 或 `archive/` 内部路径。

这是一套务实的三层实现，不是为了“分层”增加空转接口。等真正出现浏览器存储或远端存储的第二个实现，再从已经稳定的读写边界提取最小 port。

### 3.1 Public facade

职责：

- 定义并导出 `openMdv`、`parseMdv`、`createMdv` 和 `MdvDocument`；
- 校验调用参数并把 public input 转成内部 command；
- 把内部查询结果转成稳定、只读的 public DTO；
- 把 ZIP 库、Schema 库和 Node.js 原始异常映射为 `MdvError`；
- 提供 bytes 基础接口与 UTF-8 text 便利接口。

Public facade 不判断 parent/bind 规则，也不直接操作 ZIP entry。第一版文件数量很少，不为它单独创建 `api/` 目录。

### 3.2 Core 层

职责：

- 将已解码的格式 DTO hydrate 为已校验的内部模型；
- 校验 Head、parent、跨树关系、nullable bind、无环和 ID 唯一性；
- 构建 ancestry、children、reverse bind 等派生索引；
- 计算 dirty、unbound 和 Reference drift；
- 执行 save、commit、checkout 的语义变换；
- 生成 archive 可执行的包修改计划；
- 实现源文本 Diff，不接触 Markdown AST。

“解析层”如果指这一层，解析对象是 MDV 的版本语义，而不是 Markdown 正文。

### 3.3 Archive 层

职责：

- 识别 ZIP，安全索引条目并执行解压资源限制；
- 解码/编码 `manifest.json`、`HEAD` 和版本 `meta.json`；
- 按需读取工作副本或历史正文；
- 校验内容长度、SHA-256 和物理路径规则；
- 在锁内重新读取最新 generation，并执行 CAS；
- 写同目录临时 ZIP，校验、fsync 后原子替换原文件。

Archive 保证物理包和本地写入事务的一致性；Core 保证版本语义的一致性。两层不能分别实现一套 Head、parent 或 bind 规则。这里的 archive 不是数据库或服务端“持久层”，只是 `.mdv` ZIP 和文件系统 I/O。

### 3.4 独立 CLI 上游项目

独立的 `mdv-cli` 项目负责：

- 把 argv、stdin 和文件输入转换成 public API 参数；
- 调用从 `index.ts` 导出的 API；
- 把 public result/error 转换为人类文本或稳定 JSON；
- 设置退出码，并保持 stdout/stderr 边界。

CLI 不校验版本图、不拼 ZIP entry、不直接获得锁，也不复制 save/commit/checkout 规则。Core 的构建、测试和发布均不需要 CLI 存在；CLI 可以独立选择参数解析库、发布节奏和 Agent 装配协议。

## 4. 项目目录

当前仓库只有一个发布单元 `@mdv/core`，不使用 workspace 或 `packages/` 多包结构，只暴露 Library API。CLI 位于独立上游项目，不进入本仓库目录。

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
│   │   ├── ids.ts
│   │   ├── model.ts
│   │   ├── hydrate.ts
│   │   ├── invariants.ts
│   │   ├── indexes.ts
│   │   ├── queries.ts
│   │   ├── commands.ts
│   │   └── diff.ts
│   └── archive/
│       ├── format-dto.ts
│       ├── codec.ts
│       ├── reader.ts
│       ├── writer.ts
│       ├── limits.ts
│       ├── lock.ts
│       └── transaction.ts
└── test/
    ├── fixtures.test.ts
    └── roundtrip.test.ts
```

这些是目标职责，不要求第一天创建所有空文件。实现一个用例时才增加承载真实逻辑的模块；同一文件明显变得难读时再拆分。

`package.json` 只有 Library export，不声明 `bin`：

```json
{
  "name": "@mdv/core",
  "exports": {
    ".": "./dist/index.js"
  }
}
```

仓库/发布物关系为：

```text
mdv-core repository（当前项目）
  -> 发布 @mdv/core

mdv-cli repository（独立上游项目）
  -> 依赖 @mdv/core
  -> 发布 mdv CLI
  -> 面向 Agent Runtime 与人类终端用户
```

## 5. 模型边界：DTO、领域模型与第三方模型

### 5.1 不按 VO/DTO 名字机械分层

模型是否分开取决于是否跨越了一个可信边界：

| 模型 | 所在目录 | 是否公开 | 用途 |
| --- | --- | --- | --- |
| Format DTO | `archive/format-dto.ts` | 否 | 镜像磁盘 JSON；来源不可信，字段尚未具有领域保证 |
| Domain model / VO | `core/model.ts`、`core/ids.ts` | 否 | 已通过格式与关系校验，供版本规则和索引使用 |
| Public input/output DTO | `types.ts` | 是 | 给调用方的稳定命令参数、摘要、trace 和状态结果 |
| Renderer/parser model | 外部 adapter | 否 | Muya State、remark AST 等第三方专属结构 |

不需要出现 `VersionDto -> VersionVo -> VersionResponseDto` 的固定三连。如果一个不可变类型在边界两侧语义完全相同，可以复用内部 value type；只要它不泄露磁盘布局、可变集合或第三方依赖。

### 5.2 Format DTO

Format DTO 精确反映 0.1 磁盘结构，但只在 Schema/codec 校验后才能进入 Core：

```ts
interface ManifestFileDto {
  format: 'mdv'
  formatVersion: '0.1'
  documentId: string
  generation: number
  markdownProfile: string
}

interface VersionMetaFileDto {
  schemaVersion: 1
  id: string
  parent: string | null
  createdAt: string
  actor: {
    type: 'human' | 'agent'
    id?: string
    name?: string
  }
  summary: string
  contentSha256: string
  contentBytes: number
}

interface DocumentVersionMetaFileDto extends VersionMetaFileDto {
  referenceVersion: string | null
}
```

Format DTO 不带 `Map`、文件句柄、方法、AST 或 UI 字段，也不直接作为 public API 返回值。

### 5.3 内部领域模型

领域模型只表示已经验证成立的事实：

```ts
type DocumentId = string & { readonly __brand: 'DocumentId' }
type VersionId = string & { readonly __brand: 'VersionId' }
type Generation = number & { readonly __brand: 'Generation' }
type TreeKind = 'reference' | 'document'

interface VersionRecordBase {
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
  readonly contentSha256: string
  readonly contentBytes: number
}

interface ReferenceVersion extends VersionRecordBase {
  readonly kind: 'reference'
}

interface DocumentVersion extends VersionRecordBase {
  readonly kind: 'document'
  readonly referenceVersion: VersionId | null
}

interface MdvState {
  readonly manifest: Manifest
  readonly referenceHead: VersionId | null
  readonly documentHead: VersionId | null
  readonly references: ReadonlyMap<VersionId, ReferenceVersion>
  readonly documents: ReadonlyMap<VersionId, DocumentVersion>
  readonly referenceChildren: ReadonlyMap<VersionId, readonly VersionId[]>
  readonly documentChildren: ReadonlyMap<VersionId, readonly VersionId[]>
  readonly documentsByReference: ReadonlyMap<VersionId, readonly VersionId[]>
}
```

ID 使用轻量 branded primitive 和集中解析函数，不用只有 getter 的 class 包装。版本记录和公开结果保持只读；写操作产生新状态或明确的 mutation plan，不原地改历史版本。

### 5.4 Public DTO

公开 DTO 表达调用方真正需要的视图，不暴露 ZIP entry 或内部 `Map`：

```ts
interface VersionSummaryBase {
  readonly id: VersionId
  readonly parent: VersionId | null
  readonly createdAt: string
  readonly actor: Actor
  readonly summary: string
}

interface ReferenceVersionSummary extends VersionSummaryBase {
  readonly tree: 'reference'
}

interface DocumentVersionSummary extends VersionSummaryBase {
  readonly tree: 'document'
  readonly referenceVersion: VersionId | null
}

type VersionSummary = ReferenceVersionSummary | DocumentVersionSummary

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

`MarkdownSource.bytes` 是保真结果。API 另外提供 `readDocumentText` 等严格 UTF-8 解码的便利方法，避免每个 adapter 重复实现解码；这仍然不是 Markdown parsing。

### 5.5 不兼容第三方 Markdown model

Core 不把 public DTO 设计成 Muya State、MDAST 或 markdown-it token 的并集，也不接受这些结构作为 save 输入，原因是：

- 各解析器 AST 的节点、扩展和 source position 不同，无法稳定一一映射；
- AST 再序列化可能改写空白、换行、HTML 和扩展语法，破坏 MDV 的正文保真；
- 一旦公开依赖某个 AST，Core 的格式生命周期会被该库的 breaking change 绑定；
- 大多数库都能以 Markdown string 作为最小公共边界。

可以借鉴外部库的输入习惯，例如 `text + options/profile + resource base`，但不借用其内部模型。兼容关系应是：

```text
read*Text() -> Muya adapter -> Muya State
read*Text() -> remark adapter -> MDAST
read*Text() -> markdown-it adapter -> token / HTML
```

## 6. Public API 草案

### 6.1 创建与打开

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

interface CreateOptions extends OpenOptions {
  readonly markdownProfile?: string
}
```

- `parseMdv` 是只读内存入口；除非调用方在 options 中提供资源基准，否则 `baseDirectory = null`。
- `openMdv` 保存规范化后的 `.mdv` 包路径和所在目录，但不会伪造内部 Markdown path。
- `createMdv` 在目标不存在时创建 generation 0、两个空工作副本、零版本、零 Head 的包；目标已存在时返回 `CONFLICT`，不覆盖也不跟随 symlink。

### 6.2 查询

```ts
interface DocumentSnapshot {
  readonly manifest: ManifestSummary
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

打开阶段只读取 manifest、Head 和所有 version meta，并建立索引；正文由 `read*` 首次访问时按需解压和验哈希。因而：

- 打开时间与版本元数据总量相关，不与全部正文大小线性绑定；
- `listVersions`、`getChildren` 和反向 bind 查询按 RFC 3339 实际时刻升序返回，并以 Version ID 打破平局；`getHistory` 从起点沿 parent 返回到根；
- `getHistory` 是 O(祖先深度)；
- `getChildren` 和 reverse bind 查询在建好索引后是 O(结果数)；
- trace 不要求把正文加载进内存。

### 6.3 写操作

```ts
interface MdvDocument extends DocumentSnapshot {
  saveReference(input: SaveInput): Promise<MdvDocument>
  saveDocument(input: SaveInput): Promise<MdvDocument>
  commitReference(input: CommitInput): Promise<CommitResult>
  commitDocument(input: CommitDocumentInput): Promise<CommitResult>
  checkoutReference(input: CheckoutInput): Promise<MdvDocument>
  checkoutDocument(input: CheckoutInput): Promise<MdvDocument>
}

interface SaveInput {
  readonly markdown: string | Uint8Array
  readonly expectedGeneration: number
}

interface CommitInput {
  readonly expectedGeneration: number
  readonly actor: Actor
  readonly summary: string
}

interface CommitDocumentInput extends CommitInput {
  readonly referenceVersion: VersionId | null
}

type CommitResult =
  | { readonly created: true; readonly version: VersionId; readonly document: MdvDocument }
  | { readonly created: false; readonly reason: 'no-changes'; readonly document: MdvDocument }

interface CheckoutInput {
  readonly version: VersionId
  readonly expectedGeneration: number
  readonly discardChanges?: boolean
}
```

`referenceVersion` 必须显式传值。`null` 表示无摘要依赖，不能把“未传”偷偷解释成当前 `ref_tree/HEAD`，否则并发更新摘要时会生成调用方没有明确选择的 bind。

save 和 checkout 成功后直接返回新的路径绑定 `MdvDocument`，新的 generation 位于 `result.manifest.generation`；不增加只把 generation 与 snapshot 再包装一次的结果对象。调用方后续写入必须使用返回对象，而不能继续沿用旧快照。commit 使用判别联合 `CommitResult`：创建版本时返回 Version ID；no-changes 时返回稳定 reason。两种结果都携带新 `MdvDocument`。

commit 不接收 `markdown`，只固化已经 save 到目标 `current.md` 的原始字节。这样宿主内存 buffer、普通 Markdown 工作副本和不可变 Version 不会混成一层。没有 Head 时，第一次显式 commit 即使正文为空也创建根 Version；已有 Head 后正文（以及 Document bind）都未变化时不创建 Version，但成功事务仍让 generation 增加 1。

checkout 默认在锁内检查目标 `current.md` 相对 Head 是否 dirty。dirty 时返回 `CONFLICT`；只有 `discardChanges: true` 才允许历史正文覆盖已经保存的工作副本。成功 checkout 不创建 Version，但移动对应 Head 并让 generation 增加 1。

`expectedGeneration` 是非负安全整数。public facade 先拒绝无效参数，但真实的 CAS 比较必须在 archive 取得锁并重开最新包之后执行；不匹配时返回 `CONFLICT`，不能先写临时提交再判断。

## 7. Core 处理流程

### 7.1 打开与 hydrate

```text
archive 读取 manifest/Head/meta
-> codec/Schema 校验单文件形状
-> core 解析并品牌化 ID、时间、哈希、generation
-> 校验 Head/parent/referenceVersion 的跨记录关系
-> 分别检查两棵 parent 图无环
-> 构建 children 与 documentsByReference 索引
-> 计算 dirty、unbound、drift
-> public facade 生成只读 DocumentSnapshot
```

失败时保留错误来源：归档损坏是 `INVALID_ARCHIVE`，单文件字段错误是 `INVALID_MANIFEST`/`INVALID_VERSION`，跨记录关系或环是 `INVALID_GRAPH`，正文验哈希失败是 `INTEGRITY_MISMATCH`。

### 7.2 Trace

`traceDocument(Dn)`：

1. 从 Dn 沿 `parent` 追到根，得到 Document ancestry；
2. 读取 Dn 自身的 `referenceVersion`；
3. 为 `null` 时返回 `reference: null`；
4. 非空时从 reference map O(1) 取得绑定的精确 Reference Version。

`traceReference(Rn)`：

1. 从 Rn 沿 `parent` 追到根，得到 Reference ancestry；
2. 从 `documentsByReference` 取得所有直接绑定 Rn 的 Document Version；
3. 不把绑定 Rn 子孙版本的成品算作“直接使用 Rn”，调用方如需影响范围可再显式遍历 Reference children。

Reference 不存反向 bind，reverse index 每次打开都可由 Document meta 重建，因此没有双写一致性问题。

### 7.3 写命令

Core 的命令在 archive 文件事务锁内基于最新状态执行，而不是先在锁外算好结果：

```text
public API command
-> archive 获取锁并重开最新包
-> 检查 expectedGeneration
-> core hydrate 最新状态并执行语义命令
-> core 返回 package mutation
-> archive 写临时包并完整校验
-> fsync 临时文件
-> atomic replace（commit point）
-> 同步目录元数据
-> 返回新 snapshot
```

这样可以避免两个 writer 都基于旧 Head 生成看似合法、实际覆盖对方的包。Core 可以调用一个具体的 `runPackageTransaction` 函数并传入变换回调；当前不需要抽象通用 Repository。

对普通 save 而言，这个冲突模型和编辑 Markdown 文件时发现外部修改一致：Core 只负责返回 `CONFLICT`、保持磁盘内容不被静默覆盖；宿主负责重载、比较、合并或另存为，不把这些交互策略塞进格式库。

## 8. Archive 与本地文件事务

### 8.1 Reader

`archive/reader.ts` 返回一个具体的惰性 `OpenedArchive`，而不是公开存储接口：

```ts
interface OpenedArchive {
  readonly manifest: ManifestFileDto
  readonly referenceHead: string | null
  readonly documentHead: string | null
  readonly referenceVersions: readonly VersionMetaFileDto[]
  readonly documentVersions: readonly DocumentVersionMetaFileDto[]

  readWorkingCopy(tree: 'reference' | 'document'): Promise<Uint8Array>
  readVersionContent(
    tree: 'reference' | 'document',
    versionId: string,
  ): Promise<Uint8Array>
  close(): Promise<void>
}
```

Reader 在读取正文前已经拒绝绝对路径、`..`、反斜杠、重复/规范化冲突路径、符号链接、加密条目和超限声明。实际解压时继续计算流式字节数，不能只相信 ZIP header。

### 8.2 Writer 与事务

M3 为 create 和两种 working-copy save 实现了整包事务；M4 commit/checkout 已复用该事务边界：

1. 解析文件系统最终路径，并获取相邻 `<target>.lock` 目录锁；
2. 在锁内重新打开原包；
3. 同时比较打开快照的 `documentId` 与 `expectedGeneration`，不一致立即返回 `CONFLICT`；
4. 由 Core 在最新状态上计算修改；
5. 在同目录以不宽于 POSIX mode `0600` 创建唯一临时文件；
6. 逐版本复制并校验未变化历史，写入变化条目，并只替换 manifest 的 generation token；
7. 用完整 Reader 重新校验临时包及全部历史正文；
8. fsync 临时文件；
9. 原子替换目标；这一步成功即越过事务 commit point；
10. 同步目录元数据，在锁内打开并验证结果；
11. 释放锁，再同步锁删除所在目录并返回新 snapshot。

Writer 使用稳定的 UTF-8 entry-name byte order、STORE、固定 DOS 时间和 ZIP32，不就地修改 ZIP，也不覆盖历史版本条目。历史 version metadata 按原始 bytes 透传；manifest 未知字段、未知大整数、空白和 key 顺序不会因 save 经过有损的整体 JSON 重编码。目标路径已存在时 `createMdv` 失败，不默认覆盖。

commit point 之前的错误必须保持旧目标 byte-for-byte 不变，并尽力清理本次临时文件和锁。清理自身失败时通过 `cleanupIncomplete` 与 `cleanupFailures` 上报。commit point 之后如果目录同步失败，目标可能已经是新 generation；公开 `IO_ERROR.details` 必须包含 `stage: 'sync-directory'`、`committed: true` 和 generation，调用方随后重新 `openMdv` 判断结果，不能用旧 generation 自动重试。

文件事务只对实现明确支持的本地文件系统承诺跨进程互斥、CAS 和同目录原子替换。所有路径绑定写操作都拒绝最终 symlink、hard-link alias 和其他非普通文件目标；网络文件系统、FUSE、同步盘或破坏锁/原子替换语义的挂载不在同等级保证范围内。`createMdv` 同样不会跟随一个已存在的 symlink 并覆盖其指向目标。

已有锁永不按时间自动回收，以免把缓慢但仍活跃的 writer 误判为 stale。进程崩溃后，维护者必须先确认没有活跃 writer，再人工删除 `<target>.lock` 和遗留的 `.mdv-*.tmp`。这是保守恢复契约，不是自动 crash recovery。

save 保留原目标的 POSIX mode，但原子替换会更换 inode，因此 owner/group、ACL、xattr、Finder tags 和 Windows DACL/attributes 不属于保持契约。POSIX 路径会 fsync 父目录；Windows 只保证临时文件刷新与依赖系统 rename/link 的原子可见性，断电目录项持久性尚未达到同等级，也尚未经过 Windows CI 实测。

### 8.3 Mutation plan

Core 向 archive 返回的是有限操作集合，而不是任意 ZIP 编辑权限，例如：

```ts
type PackageMutation =
  | { type: 'replace-working-copy'; tree: 'reference' | 'document'; bytes: Uint8Array }
  | { type: 'append-reference-version'; version: NewReferenceVersionFileDto }
  | { type: 'append-document-version'; version: NewDocumentVersionFileDto }
  | { type: 'checkout'; tree: 'reference' | 'document'; versionId: string }
```

`PackageMutation` 由 archive 定义，Core 向下依赖并把已经验证的领域值编码成其中的格式 DTO；archive 不需要反向导入 Core 类型。Archive 根据 mutation 更新固定格式路径，调用方不能通过 public API 写任意 entry，也不能修改已有 `versions/<id>/`。

## 9. 宿主接入

### 9.1 VS Code、MarkText 与其他 Markdown 宿主

任意宿主 adapter 的最小 Core 调用流程：

```ts
let document = await openMdv(filePath)
let generation = document.manifest.generation

editor.setContent(await document.readDocumentText())

document = await document.saveDocument({
  markdown: editor.getMarkdown(),
  expectedGeneration: generation,
})

generation = document.manifest.generation
```

这里的 editor state 不是 Core model。宿主可以像编辑普通 `.md` 一样维护内存 buffer、撤销栈和 dirty UI；只有调用 `saveDocument` 时才把当前 Markdown 交给 Core。generation 冲突时宿主执行普通的“文件已被外部修改”流程，Core 不自动合并或覆盖。

adapter 另外负责：

- 把 `baseDirectory` 交给图片、链接和导出逻辑；
- 决定何时普通保存、何时显式 commit；
- 在 UI 中展示两棵历史、unbound、drift 和冲突；
- 把 Markdown 字符串传回 Core，而不是把宿主编辑器 State 写进 `.mdv`；
- 用 adapter 集成测试验证 `Markdown -> editor state -> Markdown`，Core 测试不承担渲染正确性。

VS Code extension 是 Core 0.1 闭环后的第一个计划客户端，使用虚拟 Markdown 文档呈现 Reference/Document；MarkText adapter 后续接入。若某个 parser 只支持 path，可以在独立 adapter 包中增加 `materializeMarkdown`；第一版 Core 不提供它，因为临时文件会引入额外的生命周期和写回语义。

### 9.2 独立 `mdv-cli` 的上游边界

CLI 的命令名、argv、stdin/stdout、JSON envelope、退出码、安装方式和 Agent tool schema 均属于独立 `mdv-cli` 项目，不在 Core 技术方案中冻结。

Core 只保证它需要的底层能力完整且稳定：

| 上游用例 | Core public API |
| --- | --- |
| 创建和查看状态 | `createMdv` / `openMdv` / `status` |
| 读取工作副本或版本 | `readReference*` / `readDocument*` / `readVersion*` |
| 保存草稿 | `saveReference` / `saveDocument` |
| 固化版本 | `commitReference` / `commitDocument` |
| 追踪来源和影响 | `traceDocument` / `traceReference` |
| Review 变化 | `diff` |
| 校验文件 | `verify` |

`mdv-cli` 可以把这些 API 组织成人类命令和 Agent tool，但必须遵守 Core 的 `expectedGeneration`、nullable reference bind、稳定错误码和只读历史约束。CLI 不能通过解包后直接改 entry 来绕过 Core。

Core 不导出 CLI DTO，不关心 stdout/stderr，也不测试具体命令行行为。CLI 项目应基于它锁定的 `@mdv/core` 版本独立完成命令 contract 和端到端测试。

## 10. 一致性规则的唯一归属

| 规则 | 唯一负责模块 |
| --- | --- |
| ZIP path、重复条目、压缩上限 | `archive/reader.ts` |
| JSON 单文件形状与 UTF-8 | `archive/codec.ts` |
| Version ID、Head、parent、bind、无环 | `core/invariants.ts` |
| children 与 reverse bind 派生索引 | `core/indexes.ts` |
| save/commit/checkout 是否创建版本 | `core/commands.ts` |
| generation CAS、锁、临时文件、原子替换 | `archive/transaction.ts` |
| public 参数、结果与稳定错误码 | `mdv-document.ts`、`types.ts`、`errors.ts` |
| Markdown AST 与渲染 | 外部 adapter / renderer |

禁止为了“保险”在多层各复制一套同类判断。上层可以断言下层已经建立的保证，但不能悄悄改变格式语义。

## 11. 测试结构

### 11.1 Core 单元测试

- 零版本初始化和 nullable Reference；
- 两棵 parent 图、分叉和环检测；
- Document → Reference bind 与 reverse index；
- `getHistory`、`getChildren`、`traceDocument`、`traceReference`；
- dirty、unbound、drift；
- 正文相同但 bind 变化仍创建 Document Version；
- source text Diff，不测试 HTML。

### 11.2 Archive 测试

- 合法/非法 fixtures 与跨实现预期结果；
- ZIP Slip、重复路径、NFC/大小写冲突、ZIP bomb 限制；
- UTF-8、SHA-256、contentBytes；
- 临时写失败、校验失败、fsync 失败时旧包仍可读；
- 两个 writer 使用相同 generation 时只有一个成功。

### 11.3 API 与端到端测试

- public API 不泄露内部 `Map`、ZIP entry 或第三方异常；
- bytes byte-for-byte round-trip，text 严格 UTF-8 解码；
- `create -> save -> commit -> reopen -> trace -> export`；
- `referenceVersion: null` 的普通版本 Markdown 闭环；
- 各宿主 adapter 单独验证自身编辑器模型的加载和保存。

## 12. 实现顺序

1. 初始化单包 `@mdv/core`，配置 Library export，只建立当前用得到的文件。
2. 冻结 `spec/format-0.1.md`、三个 Schema 和最小合法/非法 fixtures。
3. 实现 archive 只读入口、格式 DTO 和资源限制。
4. 实现 Core hydrate、invariants、索引与 trace 查询。
5. 接出只读 public API 和 bytes/text 内容接口。
6. 实现 M3 transaction、create/save 和冲突测试。
7. 已实现 M4 commit/checkout，并复用 M3 事务路径。
8. 实现 M5 源文本 Diff、漂移、verify/export，再完成内容寻址外部资源闭环。
9. 完成 Core 的发布与兼容性验收后再启动 VS Code extension。

第一阶段不做 Markdown AST 抽象、不做通用 Repository、不做插件系统，也不为了 path-only 工具增加临时文件协议。先完成 Core 的可读、可写、可追踪和并发安全闭环；Agent 可装配 CLI 由独立上游项目基于 public API 实现。
