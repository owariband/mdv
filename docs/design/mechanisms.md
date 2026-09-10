# MDV Core 技术机制与实现方案（Draft 0.7）

> 状态：项目结构与模型设计草案
>
> 适用范围：`@owariband/mdv` 的 TypeScript 实现、本地文件事务和 Library API
>
> 产品语义与文件格式以 [`architecture.md`](./architecture.md) 为准；本文不重复定义另一套格式
>
> 文档属性：维护者设计，包含尚未落地的机制；当前可用接口见 [`api-reference.md`](../api-reference.md)
>
> 实现进度：M5.5 产品能力与 M6 工程硬化已落地；三系统 CI 的 10 组检查已通过，证据见[兼容性文档](../compatibility.md)，发布身份与正式发布仍待验收。公开 API、Format 0.1 与生产分层未因 M6 改变。

## 1. 已确定的技术结论

1. `@owariband/mdv` 是单个 npm package，内部依赖方向为 `public facade -> core -> archive`。
2. Core 解析的是 MDV 容器、版本图和操作语义，不解析或渲染 Markdown。
3. Markdown 原始 UTF-8 字节是保真边界，字符串是给编辑器和解析器使用的便利接口。
4. 不能只把 path 当作 Markdown 交接接口：`.mdv` 有文件路径，但 ZIP 内的 `current.md` 和 `content.md` 没有独立的文件系统路径。
5. 持久化 DTO、内部领域模型和公开 API DTO 按边界区分；不为了名称形式给每个类型机械复制三份。
6. Core 不兼容或复用 Muya、remark、markdown-it 等库的 AST/model。第三方兼容放在调用方 adapter。
7. 当前只有 ZIP 一种后端，不提前增加 `Repository`、`Manager`、`ServiceFactory` 或可插拔存储接口。
8. `mimetype` 条目不进入 0.1；根 `manifest.json` 是格式识别和并发 generation 的入口。
9. CLI 是独立的上游业务项目，不属于 `@owariband/mdv` 的源码、发布包或内部层次。
10. Core 不依赖 CLI，也不定义 argv、JSON envelope 或退出码；它只提供足够稳定的 public API 供 CLI、VS Code、MarkText 和其他宿主调用。
11. 外部受管资源属于 Core 的文件语义：Core 负责内容寻址、相对路径解析、读取、写入和哈希校验；宿主负责 paste/drop、Markdown 插入与渲染。
12. Public `interface` 只描述调用方实际消费的对象契约；泛型只在能保留真实类型关系或复用同一校验逻辑时使用，不把“库”设计成多层通用框架。
13. 普通编辑沿用 Markdown 的既有模型：宿主拥有内存 buffer，Core 只持久化 `current.md`。不引入 `DraftVersion`、`workspace`、pending bind 或另一套草稿状态机。

2026-09-08 更新：独立上游不要求独立 Git 仓库；`adapter/mdv_vscode/` 已交付本地预览 VSIX，`adapter/mdv_agent_tool/` 仍仅有方案，均只依赖 Core package root。本地接入先于正式发布；插件复用原生 Markdown 编辑/渲染，不增加 Core renderer。见[插件方案](./vscode_plugin.md)、[工具方案](./agent_tool.md)、[D013](./decisions.md#d013adapter-同仓独立包与本地接入优先) 与 [D014](./decisions.md#d014vs-code-复用原生-markdown-编辑与渲染)。

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
@owariband/mdv --读取容器--> Markdown bytes / UTF-8 text + baseDirectory
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
| 本地 `.mdv` | Agent tool 在进程内调用 `@owariband/mdv`，或执行官方 `mdv` CLI | 否 |
| 飞书、Google Docs 等云文档 | 调用远端文档 API | 是，由云平台提供而不是本地文件库启动 |

`exec`/shell 只是另一种工具执行方式：它通常启动一次性子进程，命令结束后进程退出。CLI 不等于服务，也不是 Core 修改文件的内部依赖。独立的 `mdv-cli` 上游项目可以把 Core 包装成可安装的 Agent/Human tool，使不方便直接 import TypeScript 的宿主也能安全操作 `.mdv`。

## 3. 三层架构

```text
VS Code / MarkText adapter / TypeScript 宿主 -+
                                           |
独立 mdv-cli 项目 -------------------------+
                                           |
                                           v
                                  @owariband/mdv public facade
                                    |               |
                                    v               v
                          core（版本用例）     resource/model（图片规则）
                                    |               |
                                    v               v
                          archive（ZIP 事务）  resource/store（资源 I/O）
                                    |               |
                                    v               v
                                .mdv 文件       .mdv-assets/ sidecar
```

依赖只能向下：

- public facade 由根目录下的 `index.ts`、`mdv-document.ts`、`types.ts` 和 `errors.ts` 组成，编排 `core/`、`archive/` 与 `resource/`，但不能暴露内部类型；
- `core/` 可以调用具体的 `archive/` 模块；
- `archive/` 不导入 public facade 或 `core/`，只处理格式 DTO、字节、路径和事务；
- `resource/` 不导入 public facade、`core/` 或 `archive/`，只处理受管路径、图片 bytes 与 sidecar I/O；
- `index.ts` 是唯一 public export 入口。
- 上游 `mdv-cli` 只能依赖 `@owariband/mdv` 的公开 package export，不能导入 `core/` 或 `archive/` 内部路径。

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

M5.5 的 `resource/model.ts` / `resource/store.ts` 分别承载图片的确定性规则与本地持久化，保持三层职责，不另加业务 service/repository。sidecar 是 ZIP 外的独立文件，不能塞入 `archive/transaction.ts` 后宣称与 Markdown 一起原子提交。

### 3.4 独立 CLI 上游项目

计划中的 `adapter/mdv_agent_tool/` 独立包负责（此前统称 `mdv-cli`）：

- 把 argv、stdin 和文件输入转换成 public API 参数；
- 调用从 `index.ts` 导出的 API；
- 把 public result/error 转换为人类文本或稳定 JSON；
- 设置退出码，并保持 stdout/stderr 边界。

CLI 不校验版本图、不拼 ZIP entry、不直接获得锁，也不复制 save/commit/checkout 规则。Core 的构建、测试和发布均不需要 CLI 存在；CLI 可以独立选择参数解析库、发布节奏和 Agent 装配协议。

## 4. 项目目录

当前有根 `@owariband/mdv` 与独立的 `adapter/mdv_vscode/` 本地预览包，`adapter/mdv_agent_tool/` 尚未实现。不把 adapter 放入 Core `src/` 或发布产物；各自安装/构建/测试，不使用 workspace、不迁移到 `packages/`：

```text
mdv/
├── package.json
├── tsconfig.json
├── adapter/                       # 独立上游包
│   ├── mdv_vscode/                 # 已实现，本地 VSIX
│   └── mdv_agent_tool/             # 仅计划，尚未创建
├── .github/workflows/ci.yml
├── scripts/
│   ├── build-fixtures.mjs
│   ├── test-package.mjs
│   └── check-release.mjs
├── bench/
│   ├── history.mjs
│   └── baselines/
├── docs/
│   ├── README.md
│   ├── getting-started.md
│   ├── concepts.md
│   ├── api-reference.md
│   ├── resources.md
│   ├── compatibility.md
│   ├── performance.md
│   ├── releasing.md
│   ├── assets/
│   └── design/
│       ├── index.md
│       ├── architecture.md
│       ├── mechanisms.md
│       ├── roadmap.md
│       ├── decisions.md
│       ├── open-questions.md
│       ├── dev_log.md
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
│   │   ├── status.ts
│   │   └── diff.ts
│   ├── archive/
│   │   ├── format-dto.ts
│   │   ├── codec.ts
│   │   ├── reader.ts
│   │   ├── writer.ts
│   │   ├── limits.ts
│   │   ├── lock.ts
│   │   ├── mutation.ts
│   │   ├── transaction.ts
│   │   └── verify.ts
│   └── resource/
│       ├── model.ts
│       └── store.ts
└── test/
    ├── package-consumer/
    ├── helpers/
    ├── compatibility.test.mjs
    ├── fixtures.test.mjs
    ├── security.test.mjs
    ├── roundtrip.test.mjs
    ├── fuzz.test.mjs
    ├── status.test.mjs
    ├── diff.test.mjs
    ├── verify.test.mjs
    ├── m5-api.test.mjs
    ├── resource-model.test.mjs
    ├── resource-store.test.mjs
    ├── resource-api.test.mjs
    └── cross-process.test.mjs
```

上述主要模块已存在；M5.5 只新增承载真实图片规则/I/O 的两个 resource 文件。M6 主要补工程脚本、测试与文档，首次 Windows CI 后另在 Reader 的同一 descriptor 上补普通文件检查；不改生产分层。scripts 是维护者检查入口，不是供 agent 装配的 CLI，也不进入 package exports。同一文件明显变得难读时再拆分。

`package.json` 只有 Library export，不声明 `bin`：

```json
{
  "name": "@owariband/mdv",
  "exports": {
    ".": "./dist/index.js"
  }
}
```

仓库/产物关系为（Core 与 VSIX 已实现，Agent CLI 仍为计划；公开发布另行验收）：

```text
mdv repository
  根 package @owariband/mdv
    -> Core 独立构建与发布
  adapter/mdv_vscode
    -> 依赖 @owariband/mdv -> VSIX -> VS Code 用户
  adapter/mdv_agent_tool
    -> 依赖 @owariband/mdv -> CLI -> Agent Runtime / 人类终端
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
  options: LocatedParseOptions,
): Promise<LocatedDocumentSnapshot>

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

- `parseMdv` 是只读内存入口；除非调用方在 options 中提供资源基准，否则 `baseDirectory = null` 且没有资源方法。显式基准返回 `LocatedDocumentSnapshot`，只提供受管 resolve/read/verify，不提供 import/save。
- `openMdv` 保存规范化后的 `.mdv` 包路径和所在目录，但不会伪造内部 Markdown path。
- `createMdv` 在目标不存在时创建 generation 0、两个空工作副本、零版本、零 Head 的包；目标已存在时返回 `CONFLICT`，不覆盖也不跟随 symlink。

### 6.2 查询

```ts
export type ContentSpec =
  | {
      readonly tree: TreeKind
      readonly kind: 'working-copy'
    }
  | {
      readonly tree: TreeKind
      readonly kind: 'version'
      readonly version: VersionId
    }

export interface TreeWorkingCopyStatus {
  readonly head: VersionId | null
  readonly dirty: boolean
}

export type ReferenceRelation =
  | { readonly kind: 'no-document-head' }
  | { readonly kind: 'unbound' }
  | {
      readonly kind: 'aligned'
      readonly referenceVersion: VersionId
    }
  | {
      readonly kind: 'drifted'
      readonly boundReference: VersionId
      readonly currentReference: VersionId | null
    }

export interface DocumentStatus {
  readonly reference: TreeWorkingCopyStatus
  readonly document: TreeWorkingCopyStatus
  readonly referenceRelation: ReferenceRelation
}

export interface DiffLimits {
  /** 两个输入原始字节数之和。 */
  readonly maxInputBytes: number
  /** 两个输入拆分后的行数之和。 */
  readonly maxInputLines: number
  /** Diff 算法允许探索的最大编辑距离。 */
  readonly maxEditLength: number
  readonly maxHunks: number
  /** `unifiedText` 的 UTF-8 字节数上限。 */
  readonly maxOutputBytes: number
}

export interface DiffOptions {
  readonly contextLines?: number
  readonly limits?: Partial<DiffLimits>
}

export type DiffLine =
  | {
      readonly kind: 'context'
      readonly oldLine: number
      readonly newLine: number
      readonly text: string
    }
  | {
      readonly kind: 'deletion'
      readonly oldLine: number
      readonly newLine: null
      readonly text: string
    }
  | {
      readonly kind: 'addition'
      readonly oldLine: null
      readonly newLine: number
      readonly text: string
    }

export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

export interface DiffResult {
  readonly hunks: readonly DiffHunk[]
  readonly unifiedText: string
}

interface DocumentSnapshot {
  readonly manifest: ManifestSummary
  readonly packagePath: string | null
  readonly baseDirectory: string | null
  readonly referenceTree: { readonly head: VersionId | null }
  readonly documentTree: { readonly head: VersionId | null }
  readonly warnings: readonly MdvWarning[]

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
  readVersionBytes(id: VersionId): Promise<Uint8Array>
  readVersionText(id: VersionId): Promise<string>

  readContent(source: ContentSpec): Promise<MarkdownSource>
  getStatus(): Promise<DocumentStatus>
  diff(from: ContentSpec, to: ContentSpec, options?: DiffOptions): Promise<DiffResult>
}
```

打开阶段读取 manifest、Head、所有 version meta 和两个固定 working copy，并建立索引；只有历史版本正文由 `read*` 首次访问时按需解压和验哈希。因而：

- 打开时间与版本元数据总量相关，不与全部正文大小线性绑定；
- `listVersions`、`getChildren` 和反向 bind 查询按 RFC 3339 实际时刻升序返回，并以 Version ID 打破平局；`getHistory` 从起点沿 parent 返回到根；
- `getHistory` 是 O(祖先深度)；
- `getChildren` 和 reverse bind 查询在建好索引后是 O(结果数)；
- trace 不要求把正文加载进内存。

M5 的三个查询入口遵守以下边界：

- `readContent` 是统一内容选择器；`kind: 'version'` 时 `tree` 和 Version 所属树必须一致，否则返回 `NOT_FOUND`。既有的 `readReference*`、`readDocument*` 和 `readVersion*` 继续作为便利接口，不做破坏性删除；
- `getStatus` 是异步方法，不是打开后同步填充的 `status` 属性。它通过现有 Archive Reader 读取两个工作副本，再交给 Core 计算状态，不让 public facade 直接实现 dirty/drift 规则；
- `diff` 先通过 `readContent` 取得两端原始字节，再执行严格 UTF-8 的源文本逐行比较。它允许跨树比较，但不解释 Markdown AST 或需求语义。

`DocumentStatus` 已经携带两棵树的 Head，因此 `ReferenceRelation` 不重复保存 Document Version ID。四种 relation 的含义固定为：

- `no-document-head`：Document 尚未形成当前已提交版本；
- `unbound`：Document HEAD 明确绑定 `null`；
- `aligned`：Document HEAD 绑定的非空 Reference Version 等于当前 Reference HEAD；
- `drifted`：Document HEAD 绑定了非空 Reference Version，但它不等于当前 Reference HEAD。合法包可能没有 Reference HEAD，因此 `currentReference` 必须允许为 `null`。

dirty 对原始字节计算，不做换行或 Unicode 归一化：没有 Head 时仅非空工作副本为 dirty；有 Head 时比较工作副本的 `byteLength`/SHA-256 与 Head metadata 中的 `contentBytes`/`contentSha256`。状态查询仍保持历史正文惰性读取；完整性真实性由读取目标版本或 `verifyMdv(..., { mode: 'full' })` 保证。

`DiffLine.text` 保留该行原始行结束符；CRLF、LF、末尾换行缺失和 Unicode 差异都不能被 tokenization 隐式归一化。相同输入返回空 hunks 和空 `unifiedText`。任一 Diff 上限触发时整体返回 `LIMIT_EXCEEDED`，不返回可能被误认为完整结果的截断 Diff。

当前实现默认 `contextLines = 3`，两个输入合计最多 8 MiB / 200,000 行，Myers 最大编辑距离为 2,048，最多生成 10,000 个 hunk，`unifiedText` 最多 16 MiB。调用方可以局部下调或显式上调，但所有值必须是非负安全整数；达到任一上限时不产生部分结果。有差异时 facade 使用 `<tree>:working-copy` 或 `<tree>:<version-id>` 作为稳定 unified header label。

### 6.3 顶层完整性诊断

```ts
export type VerifyMode = 'metadata' | 'full'

export interface VerifyOptions extends OpenOptions {
  readonly mode?: VerifyMode
  readonly maxIssues?: number
}

export interface VerifyIssue {
  readonly code: MdvErrorCode
  readonly message: string
  readonly entry?: string
  readonly path?: string
  readonly details: MdvErrorDetails
}

export interface VerifyReport {
  readonly mode: VerifyMode
  readonly valid: boolean
  readonly complete: boolean
  readonly issues: readonly VerifyIssue[]
  readonly warnings: readonly MdvWarning[]
}

export function verifyMdv(
  source: string | Uint8Array,
  options?: VerifyOptions,
): Promise<VerifyReport>
```

`verifyMdv` 必须是 package-root 顶层入口，而不是只挂在已经成功打开的 `DocumentSnapshot` 上。损坏到 `openMdv`/`parseMdv` 无法返回 snapshot 的文件，正是诊断入口必须处理的对象。

- `mode` 默认 `metadata`；该模式校验 ZIP 布局、manifest、两个工作副本、Head、所有 version meta 和版本图关系，但不遍历历史 `content.md`；
- `full` 在 metadata 检查之外逐个读取所有历史正文，校验严格 UTF-8、`contentBytes` 和 SHA-256，包括不在当前 Head ancestry 上的分支；
- `valid` 仅在本次要求的检查完整执行且没有 issue 时为 `true`；遇到阻断性结构错误、资源上限或 `maxIssues` 而无法继续全部阶段时，`complete` 为 `false`；
- `maxIssues` 必须是有限正整数；达到它时停止继续聚合且保留已经发现的稳定有序 issues；
- 对可读取 source 发现的格式、关系和内容问题进入 `issues`，尽量收集相互独立的问题。source 路径不存在或无法读取时继续抛 `NOT_FOUND`/`IO_ERROR`；无效调用参数直接抛 `TypeError`/`RangeError`；普通 `openMdv`、`parseMdv` 和 `read*` 继续 fail-fast；
- warning 不使 `valid` 变为 `false`，并沿用已有 `MdvWarning` 契约。Report、issue、warning 和 details 都返回冻结副本。

当前 `maxIssues` 默认值为 100。metadata 打开阶段继续复用安全 Reader：遇到无法建立可信结构边界的错误时，以单条阻断 diagnostic 返回 `complete: false`；codec 自身已经收集的字段问题由 facade 展开。只要 metadata 已建立可遍历索引，版本图诊断会聚合全部已发现关系问题，full 模式再用一次 ZIP 扫描遍历全部历史正文并聚合独立 UTF-8、长度与哈希问题。

M5 不再增加单独的 Markdown export API：只传 `'working'` 无法表达选择 Reference 还是 Document，而且它与已有 bytes 读取能力重复。调用方用 `readContent(ContentSpec).bytes` 获得当前或历史 Markdown 原始字节；是否写成一个普通 `.md` 文件属于宿主 I/O，不需要 Core 再造一套 export 语义。

### 6.4 写操作

```ts
interface MdvDocument extends LocatedDocumentSnapshot {
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
-> public facade 生成只读 DocumentSnapshot
```

打开不为了状态面板额外加载历史正文；dirty 和 Reference relation 由调用方显式调用异步 `getStatus()` 时计算。失败时保留错误来源：归档损坏是 `INVALID_ARCHIVE`，单文件字段错误是 `INVALID_MANIFEST`/`INVALID_VERSION`，跨记录关系或环是 `INVALID_GRAPH`，正文验哈希失败是 `INTEGRITY_MISMATCH`。

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

> **M5 的主要驱动力是 Agent-friendly，不是在 Core 内建设面向人的 Review 产品。** Agent 和自动化工具没有可以依赖的可视化上下文，需要用结构化 status 做分支决策、用统一 `ContentSpec` 精确选内容、用 bounded deterministic Diff 取得可控上下文，并用聚合 verify 一次获得可行动的损坏清单。人类直接 import 这些查询的价值相对次要；人类用户通常通过 VS Code、MarkText 或 CLI 间接获得状态提示、左右对照和诊断结果。

这些能力仍是通用 Core primitive，而不是 Agent 专用 DTO：它们表达的是 `.mdv` 自身的 dirty、bind、内容定位、源文本差异和完整性事实，返回值不包含 prompt、token budget、CLI JSON envelope 或 tool schema。Agent 特定的截断、摘要和决策文案继续由独立 `mdv-cli` / Agent tool 组装；Core 只保持这些底层事实稳定、只读且可组合。

### 7.4 M5 状态计算

M5 新增 `core/status.ts`，只接收已验证 `MdvState` 和两份工作副本 bytes，返回内部只读状态值：

```text
DocumentSnapshot.getStatus()
-> facade 并行读取 ref_tree/current.md 与 doc_tree/current.md
-> core/status.ts 对原始 bytes 计算 SHA-256
-> 与各自 Head metadata 的 contentBytes/contentSha256 比较
-> 从 Document HEAD bind 与 Reference HEAD 推导 ReferenceRelation
-> facade 映射并冻结 DocumentStatus
```

`core/status.ts` 集中实现公开 status 的纯计算，M4 checkout 保留语义相同的局部 dirty 检查，以避免为了本阶段改动已经稳定的 command/transaction 路径；两者都比较原始 bytes，专项测试固定其边界。状态查询本身不获取写锁、不读取 Head 正文、不读取 sidecar、不移动 Head，也不创建版本；历史正文真实性由按需读取或 full verify 另行保证。

### 7.5 M5 内容选择与源文本 Diff

`mdv-document.ts` 中的 `readContent` 只编排已有 Reader：working copy 走 `readWorkingCopy`，历史版本先按 `tree + version` 做精确选择，再走 `readVersionContent`。它不创建临时 `.md`，也不增加新的 Archive 抽象。

```text
DocumentSnapshot.diff(from, to)
-> 分别通过 readContent 读取两个 MarkdownSource
-> 合计检查 bytes 与行数上限
-> 严格 UTF-8 解码并按原始行结束符做无损 tokenization
-> core/diff.ts 计算逐行差异并组织 hunks
-> 检查 hunk 数与 unifiedText UTF-8 大小
-> facade 返回冻结 DiffResult
```

`core/diff.ts` 实现一个受 `maxEditLength` 限制的逐行 Myers Diff，行 token 保留结束符，结果转换为 Core 自有 hunk，再由 facade 映射为 public `DiffResult`。算法通过 `maxInputLines` 和 `maxEditLength` 同时限制探索规模，不采用 O(N×M) 的完整动态规划矩阵；达到编辑距离上限时停止并返回 `LIMIT_EXCEEDED`。M5 不增加第三方 Diff 运行时依赖，也不存在可泄露到 `types.ts` 的第三方 change/patch 类型。

默认行为是字节语义对应的源码比较：不忽略空白、不转换 CRLF、不做 Unicode normalization，也不解析 Markdown。`contextLines` 与所有 limit 必须在调用算法前归一化为非负安全整数；算法放弃、输入/行数超限、hunk 超限或输出超限统一映射为带具体 limit details 的 `LIMIT_EXCEEDED`。

### 7.6 M5 Archive 诊断

`archive/verify.ts` 实现只读、best-effort 的诊断扫描，但不导入 Core：

```text
verifyMdv(path | bytes)
-> archive/verify.ts 安全扫描 ZIP 和固定路径
-> 分别诊断 manifest、working copy、HEAD 与每份 version meta
-> full 模式在一次受限扫描中逐版本校验 content.md
-> facade 在可获得 ArchiveIndexDto 时调用 core/invariants.ts 检查关系与图
-> 汇总为冻结 VerifyReport
```

诊断没有包装 public `openMdv()` 或依赖成功构造 snapshot。metadata 阶段直接复用 package-private Reader/codec 的路径、解压和 JSON 限制，把其阻断错误转成 report；full 阶段调用 Reader 上的内部单次扫描能力。普通 open/read 仍在首个错误处失败，verify 没有复制第二套 ZIP 安全规则，也没有把内部 scanner 暴露到 package root。

聚合按阶段推进：结构或 version metadata 不足以建立可信索引时停止依赖阶段并令 `complete = false`；codec 内一份 JSON 的字段问题和 Core 图问题会按各自校验器的聚合结果报告。索引建立后，某个历史 content 损坏不妨碍其他版本独立读取，full 模式按稳定的 Document/Reference 版本索引顺序逐个处理，不同时把全部历史正文留在内存，也不为每个版本重新扫描整个 ZIP，直到全部完成或达到 `maxIssues`。

`verifyMdv` 是纯读取操作，不需要 generation、不获取 writer lock，也不调用 transaction/mutation/writer。诊断过程中源文件若被外部进程替换，Reader 的单次打开快照语义仍适用；它不承诺对正在变化的文件形成事务快照。

### 7.7 M5 修改面与依赖方向

| 文件 | M5 具体修改 | 依赖边界 |
| --- | --- | --- |
| `src/types.ts` | 增加 `ContentSpec`、状态、Diff 和 verify 的 public readonly 类型；在 `DocumentSnapshot` 增加三个异步查询 | 不导入 Archive DTO 或内部算法类型 |
| `src/index.ts` | 从唯一 package root 导出 `verifyMdv` 和新增 public 类型 | 不增加 `core/*`、`archive/*` 子路径 export |
| `src/mdv-document.ts` | 实现 `readContent`、`getStatus`、`diff`，并编排顶层 `verifyMdv` 的 Archive/Core 诊断结果和错误映射 | facade 只做参数校验、调用编排与 public DTO 冻结 |
| `src/core/status.ts` | 实现 dirty 与四态 `ReferenceRelation` 纯计算 | 依赖 Core model；不执行 ZIP I/O |
| `src/core/diff.ts` | 实现无损逐行 tokenization、bounded Myers、hunk 与 unified text 生成 | 不依赖 Archive，不增加第三方 Diff 依赖 |
| `src/archive/verify.ts` | 安全诊断 path/bytes、metadata 和全部历史正文，返回内部 issue/index | 可依赖 codec/reader/limits；绝不导入 Core/public facade |
| `src/errors.ts` | 复用已有错误码，不新增 M5 专属 code | Diff 超限使用 `LIMIT_EXCEEDED`；内容损坏使用 `INTEGRITY_MISMATCH` |
| `test/status.test.mjs` | 覆盖 dirty 和四种 Reference relation | 纯 Core 表驱动测试 |
| `test/diff.test.mjs` | 覆盖跨树、CRLF/LF、EOF、Unicode、空输入和全部限制 | 不测试 HTML 或语义 Diff |
| `test/verify.test.mjs` | 覆盖 metadata/full、独立 issue 聚合、未访问分支损坏与 `complete` | 从合法 fixture 做最小定点损坏 |
| `test/m5-api.test.mjs` | 只从 package root 覆盖 path/bytes、`readContent`、status、diff、verify 与只读结果 | 不导入内部源码路径 |

M5 不改变 Format 0.1、Schema、commit/checkout 公开语义或持久化事务。`core/commands.ts` 只把 checkout 的 dirty 条件机械补齐为 `contentBytes + SHA-256`，与 status 保持一致，没有增加新 command；`archive/transaction.ts`、`archive/mutation.ts` 和 `archive/writer.ts` 未修改。

M5 也不修改 `package.json` 的 runtime dependencies：bounded Myers 保持为 `core/diff.ts` 内的小型纯实现。它不是通用 patch engine；如果后续真实 benchmark 证明需要替换算法，替换仍被该文件和 Core 自有结果类型隔离。

### 7.8 M5、M5.5 与 M6 的完成边界

- **M5 Agent-friendly 审阅与诊断原语**：完成 `readContent`、dirty/Reference relation、受限源码 Diff 和顶层完整性诊断。此时 Agent 和自动化工具已能不依赖 UI 完成结构化审阅，但 Core 不提供人类 Review UI，也不宣称图片导入和正式发布闭环；
- **M5.5 受管资源闭环**：按 [`resources.md`](../resources.md) 实现 `.mdv-assets/<documentId>/<sha256>.<extension>` 的 hash 计算、安全扩展名、原子写入/复用、相对路径返回、resolve/read 和读取时 hash 校验。它不增加 ZIP entry、不修改 manifest generation、不扫描 Markdown AST、不做网络下载或资源 GC；paste/drop、插入 Markdown 和渲染仍由宿主负责；
- **M6 稳定发布闭环**：不再引入主要版本业务语义，集中完成安全 fixtures、fuzz、复杂 Markdown round-trip、性能基准、Node CI matrix、tarball consumer CI、npm 包名/scope、License、0.1 版本策略以及 public API/错误码/Format 兼容承诺。M6 验收后才把 `@owariband/mdv 0.1` 定义为可正式依赖的完整形态。

M5.5 的资源 sidecar 是独立文件事务，不复用 `.mdv` 整包 transaction，也不把资源 bytes 伪装成 Markdown Version。M6 若基准数据证明整包重写不满足目标，再为后续格式版本立项；不能在 M5/M5.5 中提前引入增量容器或 Repository 框架。

### 7.9 M5.5 实际实现与资源事务

公开能力使用 `ManagedResource` 前缀以区分任意普通 Markdown 链接：路径和 MIME 的限制只属于受管 API。`types.ts` 导出 `LocatedDocumentSnapshot`、`LocatedParseOptions`、`ImportResourceInput`、`ResourceOptions`、`ManagedResourcePath`、`ManagedImageMediaType` 与 `ManagedResourceContent`；内部模型不向外泄露，也不依赖宿主 parser 类型。

- `resource/model.ts` 固定严格 grammar、当前 documentId 隔离、SHA-256、PNG/JPEG/GIF/WebP 文件头识别和 png/jpg/gif/webp 扩展名。默认单资源 32 MiB，与 Archive limits 独立；声明 MIME 不一致为 `INVALID_RESOURCE`，已存 bytes 与 hash/扩展名不一致为 `INTEGRITY_MISMATCH`。
- `resource/store.ts` 规范化可信基准目录，拒绝 sidecar 内部 symlink/非普通条目，记录并复查目录 dev/ino。资源以 `O_NOFOLLOW`（平台支持时）打开，lstat/fstat 校验同一文件身份，在同一个 fd 上限量读取并验证 hash；读取中增长也有计数限制。
- resolve 只验证路径、存在性和文件类型，返回规范本地绝对路径。read 返回经验证的 bytes 副本，verify 执行相同读取但成功无数据；路径返回值不是永久句柄，不能提供随后任意外部读取的完整性保证。
- import 首次异步前复制 bytes 并固定 MIME/上限；通过现有路径身份规则确认 handle，重开当前 MDV 校验 documentId。generation 变旧不阻止导入，save 仍独立执行 CAS。
- 新资源在目标目录以 wx/0600 创建私有临时文件，写入、回读校验、fsync 后，以 hard-link 不覆盖发布；遇到 EEXIST 必须回读目标并逐字节一致才复用。新建受管目录 mode 为 0700；正常路径清理临时文件并同步目录。
- 不用普通 rename 覆盖 hash 文件，不根据 nlink 大于 1 拒绝资源：原子发布期间第二个 link 是正常状态。读取中文件 size/mtime 改变为 `CONFLICT`，link count/ctime 的合法变化不制造误报。
- 错误 details 保留 stage/path/relativePath；发布后或已确认复用时失败带 `committed: true`，清理失败带 `cleanupFailures`。目录已被替换时宁可留下本次临时文件，也不跟随新目录执行危险清理。没有自动重试、锁回收或 GC。

这些检查针对受支持本地文件系统的正常并发和可检测替换，不构成对同权限恶意进程持续置换目录的安全沙箱。Windows 目录同步不提供 POSIX 同等级保证，跨平台 CI 和故障恢复仍由 M6 验证。`Archive`、Format 0.1、版本图/commands 和 runtime dependencies 均未修改。

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

save 保留原目标的 POSIX mode，但原子替换会更换 inode，因此 owner/group、ACL、xattr、Finder tags 和 Windows DACL/attributes 不属于保持契约。POSIX 路径会 fsync 父目录；Windows 只保证临时文件刷新与依赖系统 rename/link 的原子可见性，断电目录项持久性尚未达到同等级；M6 已通过 Windows 三组 CI，但未做真实断电实验，不改变这一限制。

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

新建入口按 [D015](./decisions.md#d015普通空文件是正常的新建入口) 支持普通 0 字节文件。`openMdv` 与事务重开的 `openDocumentArchiveFromPath` 共用空白 `OpenedArchive` 视图，不新增 Draft 模型；首次保存仍通过 `createMutationEntryPlan`、Writer、全验、锁内 CAS 和原子替换。严格 archive/byte reader 与 verify 不接受空容器。空文件身份在第一次写入前由文件身份摘要稳定导出，之后读取 manifest；支持首次保存前导入图片及宿主恢复。

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

宿主要展示某个已提交 Document Version 的 Reference/Document 左右对照时，Core 只负责按 bind 返回应该配对的原文：

```ts
const trace = document.traceDocument(documentVersion)

const documentSource = await document.readContent({
  tree: 'document',
  kind: 'version',
  version: trace.document.id,
})

const referenceSource = trace.reference === null
  ? null
  : await document.readContent({
      tree: 'reference',
      kind: 'version',
      version: trace.reference.id,
    })
```

`traceDocument` 确定 Document Version 当时真正绑定的 Reference Version，`readContent` 读取这两份精确原文。Core 不用当前 Reference HEAD 替换历史 bind，也不负责双栏布局、同步滚动、Markdown 渲染或变化高亮。这些是编辑器 adapter 的展示职责；宿主也可以忽略 Core `diff` 并使用自己的 Diff Editor。

当右侧展示的是 `doc_tree/current.md` 而不是已提交 Version 时，该工作副本本身没有永久 bind。宿主可以默认选择 Document HEAD 的 bind，也可让用户或 Agent 显式选择 Reference Version；只有后续 `commitDocument({ referenceVersion })` 才会把选择固化成新 Document Version 的 bind，Core 不额外持久 pending bind。

adapter 另外负责：

- 把 `baseDirectory` 交给图片、链接和导出逻辑；
- 对粘贴图片调用 `importManagedResource` 并插入返回的相对路径，受管预览用 resolve 的本地绝对路径转换渲染 URI，或直接消费 read 的已验证 bytes；普通自定义链接仍由宿主按基准处理；
- 决定何时普通保存、何时显式 commit；
- 在 UI 中展示两棵历史、unbound、drift 和冲突；
- 把 Markdown 字符串传回 Core，而不是把宿主编辑器 State 写进 `.mdv`；
- 用 adapter 集成测试验证 `Markdown -> editor state -> Markdown`，Core 测试不承担渲染正确性。

VS Code extension 已作为首个本地图形客户端实现：可写虚拟 Markdown 文档呈现工作副本、只读历史，以及直接复用内置预览和兼容 Markdown 扩展。`preview.3` 的 ZIP 文件关联只负责打开 Doc，不再显示概览；侧栏双列版本图复用 metadata 和反向引用查询，正文显隐保留原生后台标签，不另存草稿模型。真实安装、恢复基线与渲染证据见[插件方案](./vscode_plugin.md)。MarkText adapter 后续接入。若某个 parser 只支持 path，其 adapter 可另行设计 `materializeMarkdown`；当前 VS Code 插件不为兼容它维护可写临时镜像，Core 也不提供这个接口。

### 9.2 独立 Agent CLI 的上游边界

CLI 的命令名、argv、stdin/stdout、JSON envelope、退出码、安装方式和 Agent tool schema 均属于独立 `adapter/mdv_agent_tool/` 包，在 [Agent Tool 方案](./agent_tool.md)中维护草案，不写入 Core 契约。

Core 只保证它需要的底层能力完整且稳定：

| 上游用例 | Core public API |
| --- | --- |
| 创建和打开 | `createMdv` / `openMdv` |
| 查看工作副本与 bind 状态 | `getStatus` |
| 读取工作副本或版本 | `readContent` / `readReference*` / `readDocument*` / `readVersion*` |
| 保存草稿 | `saveReference` / `saveDocument` |
| 固化版本 | `commitReference` / `commitDocument` |
| 追踪来源和影响 | `traceDocument` / `traceReference` |
| Review 变化 | `diff` |
| 校验文件 | `verifyMdv` |
| 导入与读取受管图片 | `importManagedResource` / `resolveManagedResource` / `readManagedResource` / `verifyManagedResource` |

`mdv-cli` 可以把这些 API 组织成人类命令和 Agent tool，但必须遵守 Core 的 `expectedGeneration`、nullable reference bind、稳定错误码和只读历史约束。CLI 不能通过解包后直接改 entry 来绕过 Core。

Core 不导出 CLI DTO，不关心 stdout/stderr，也不测试具体命令行行为。CLI 项目应基于它锁定的 `@owariband/mdv` 版本独立完成命令 contract 和端到端测试。

## 10. 一致性规则的唯一归属

| 规则 | 唯一负责模块 |
| --- | --- |
| ZIP path、重复条目、压缩上限 | `archive/reader.ts` |
| JSON 单文件形状与 UTF-8 | `archive/codec.ts` |
| Version ID、Head、parent、bind、无环 | `core/invariants.ts` |
| children 与 reverse bind 派生索引 | `core/indexes.ts` |
| save/commit/checkout 是否创建版本 | `core/commands.ts` |
| working-copy dirty 与 Reference relation | `core/status.ts` |
| Markdown 源文本 Diff 与 Diff 资源上限 | `core/diff.ts` |
| ZIP/metadata/content 诊断扫描 | `archive/verify.ts` |
| verify 的版本图诊断 | `core/invariants.ts`，由 public facade 汇总 |
| generation CAS、锁、临时文件、原子替换 | `archive/transaction.ts` |
| 受管路径 grammar、媒体头、hash 和单资源上限 | `resource/model.ts` |
| sidecar 路径安全、限量读取与不覆盖原子发布 | `resource/store.ts` |
| public 参数、结果与稳定错误码 | `mdv-document.ts`、`types.ts`、`errors.ts` |
| Markdown AST 与渲染 | 外部 adapter / renderer |

禁止为了“保险”在多层各复制一套同类判断。上层可以断言下层已经建立的保证，但不能悄悄改变格式语义。

## 11. 测试结构

### 11.1 Core 单元测试

- 零版本初始化和 nullable Reference；
- 两棵 parent 图、分叉和环检测；
- Document → Reference bind 与 reverse index；
- `getHistory`、`getChildren`、`traceDocument`、`traceReference`；
- dirty、`no-document-head`、unbound、aligned、drifted；
- 正文相同但 bind 变化仍创建 Document Version；
- bounded source text Diff，不测试 HTML。

### 11.2 Archive 测试

- 合法/非法 fixtures 与跨实现预期结果；
- ZIP Slip、重复路径、NFC/大小写冲突、ZIP bomb 限制；
- UTF-8、SHA-256、contentBytes；
- metadata/full 诊断、独立 issue 聚合和不可达分支正文损坏；
- 临时写失败、校验失败、fsync 失败时旧包仍可读；
- 两个 writer 使用相同 generation 时只有一个成功。

### 11.3 API 与端到端测试

- public API 不泄露内部 `Map`、ZIP entry 或第三方异常；
- bytes byte-for-byte round-trip，text 严格 UTF-8 解码；
- `create -> save -> commit -> reopen -> trace -> getStatus -> readContent -> diff -> verifyMdv(full)`；
- `referenceVersion: null` 的普通版本 Markdown 闭环；
- 各宿主 adapter 单独验证自身编辑器模型的加载和保存。

### 11.4 M5 专项验收

- package-root 测试覆盖 `ContentSpec` 的全部分支和 wrong-tree `NOT_FOUND`；
- status 表驱动测试覆盖两个 tree 各自有/无 Head、空/非空/同 hash/异 hash，以及四种 Reference relation；
- Diff 覆盖跨树、工作副本/历史任意组合、CRLF/LF、EOF newline、Unicode、冻结结果与每一项资源上限；
- metadata verify 不读取历史正文，full verify 能发现一个从未被普通 read/trace 访问过的旧分支损坏；
- 同一个包中的多个独立坏正文尽量形成多个 issue；达到 `maxIssues` 时 `complete = false`；
- M5 全部操作只读，执行前后 `.mdv` 原始 bytes、generation、Head 和 sidecar 都不变化。

## 12. 实现顺序

1. 初始化单包 `@owariband/mdv`，配置 Library export，只建立当前用得到的文件。
2. 冻结 `spec/format-0.1.md`、三个 Schema 和最小合法/非法 fixtures。
3. 实现 archive 只读入口、格式 DTO 和资源限制。
4. 实现 Core hydrate、invariants、索引与 trace 查询。
5. 接出只读 public API 和 bytes/text 内容接口。
6. 实现 M3 transaction、create/save 和冲突测试。
7. 已实现 M4 commit/checkout，并复用 M3 事务路径。
8. 已实现 M5 `readContent`、异步 status、bounded source Diff 和顶层 `verifyMdv`，完成 Agent-friendly 检查与诊断能力。
9. 已实现 M5.5 内容寻址 sidecar 的 import/resolve/read/hash verify，完成图片资源闭环。
10. 实现 M6 fixtures/fuzz/benchmark/CI/package/API 兼容承诺，完成 Core 0.1 发布收口。
11. M6 工程与跨平台验收已通过，按两份 adapter 方案固定 Core 构建，先完成本地 VSIX + Agent CLI 联合使用；正式发布继续单独验收，MarkText 排在首个客户端之后。

第一阶段不做 Markdown AST 抽象、不做通用 Repository、不做插件系统，也不为了 path-only 工具增加临时文件协议。先完成 Core 的可读、可写、可追踪和并发安全闭环；Agent 可装配 CLI 由独立上游项目基于 public API 实现。
