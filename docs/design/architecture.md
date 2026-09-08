# MDV Core 架构与产品设计（Draft 0.7）

> 状态：设计草案
>
> 范围：`.mdv` 开放格式及其 TypeScript 解析/写入库
>
> 不在范围：VS Code / MarkText 的具体 UI，以及 Markdown 解析与渲染实现
>
> 文档属性：维护者设计，包含未来能力；当前可用接口见 [`api-reference.md`](../api-reference.md)
>
> 实现进度：M5.5 产品能力与 M6 工程硬化已落地；公开 API 和 Format 0.1 未改变，三系统 CI 的 10 组检查已通过，证据见[兼容性文档](../compatibility.md)。发布身份/License 和正式发布仍待 M6 验收。

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
- 不做版本操作时，两个 `current.md` 的编辑语义就是普通 Markdown；编辑器内存 buffer 与撤销栈由宿主管理。
- 只有显式 `commit` 才创建不可变版本。
- 每个 Document Version 可以绑定一个精确的 Reference Version；不使用摘要能力时也可以显式不绑定。
- 摘要更新后产生 R2，不会修改仍绑定 R1 的旧成品版本。
- 不额外维护 `seed`、`requirements`、`approved`、`published` 等命名指针。
- 不增加 `DraftVersion`、`workspace` 或 pending bind 来重复表达普通 Markdown 的编辑状态。

### 1.2 设计目标

1. **开放可读**：不依赖 MarkText、数据库或在线服务即可读取当前内容和历史。
2. **正文保真**：Core 原样保存 UTF-8 Markdown 字节，不解析、格式化或重新序列化正文。
3. **保存与版本分离**：普通保存只更新工作副本；显式 commit 才增加历史节点。
4. **历史可追踪**：版本不可变，父版本、绑定的 Reference Version、作者和变化摘要可追溯。
5. **Agent 友好**：先读取轻量索引，按需读取正文；Agent 可以多次保存草稿后再 commit。
6. **并发安全**：MDV 整包写入使用比较后交换语义和原子替换，不静默覆盖其他写入者；独立 hash 图片使用不覆盖原子发布与校验后复用。
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

编辑状态只有三个清楚的边界：

```text
编辑器内存 buffer             # 宿主负责，可能尚未 save
        ↓ save
ref_tree/current.md / doc_tree/current.md
                               # Core 持久化的普通 Markdown 工作副本
        ↓ explicit commit
versions/<id>/content.md       # Core 创建的不可变历史快照
```

Core 不持久化编辑器撤销栈、光标或未传给 save 的 buffer，也不建立 `DraftVersion`、`workspace`、pending bind 等平行状态。对 `current.md` 的多进程保存冲突按照普通文档的外部修改处理：Core 用 generation CAS 返回 `CONFLICT`，宿主决定重载、比较、合并或另存为。

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
- 有 `ref_tree/HEAD`，且 `ref_tree/current.md` 原始 bytes 的 `byteLength` 或 SHA-256 与该 Head metadata 的 `contentBytes` / `contentSha256` 不同。

Document Working Copy 为 dirty，当且仅当：

- 没有 `doc_tree/HEAD` 且 `doc_tree/current.md` 非空；
- 或有 `doc_tree/HEAD`，且 `doc_tree/current.md` 原始 bytes 的 `byteLength` 或 SHA-256 与该 Head metadata 的 `contentBytes` / `contentSha256` 不同。

工作副本本身不保存 bind。即使成品文字没有变化，只要 `commitDocument` 传入了新的 Reference Version，仍然创建一个具有新版本语义的 Document Version。

Document HEAD 与当前 Reference HEAD 的关系必须穷举为四种状态：

- `no-document-head`：当前没有 Document HEAD。即使包中保留了不可达的历史 Document Version，也不能把它当作当前成品版本；
- `unbound`：Document HEAD 对应版本的 `referenceVersion = null`；
- `aligned`：Document HEAD 绑定的 Reference Version 等于当前 Reference HEAD；
- `drifted`：Document HEAD 绑定了 Reference Version，但它不等于当前 Reference HEAD。合法历史中 Reference HEAD 也可能缺失，因此漂移结果中的当前 Reference 可以为 `null`。

已提交且绑定了 Reference 的成品发生 Reference 漂移，当：

```text
doc_tree/versions/<doc_tree/HEAD>/meta.json.referenceVersion
  != ref_tree/HEAD
```

漂移只产生状态提示，不自动修改 `doc_tree/current.md`，也不自动创建新版本。

`referenceVersion = null` 是合法的 unbound 状态，不算格式错误，也不算漂移。没有 Document HEAD 与 Document HEAD 明确 unbound 也不是同一种状态；宿主会据此分别展示“尚未提交”和“此版本不依赖 Reference”。没有使用 Reference 的文档可以一直只提交 Document Version，从而退化为普通的带版本 Markdown 文档。

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

0.1 不将附件写入包内。Markdown 中的相对链接和图片地址以 `.mdv` 文件所在目录作为基准，而不是以 ZIP 内路径为基准。通过 `readContent(...).bytes` 取得 Markdown 时不隐式复制外部附件。

官方 Core 已在 M5.5 提供可选的外部受管资源能力。普通 Markdown 路径仍可自由命名、引用父目录、绝对位置或网络 URL，由宿主按基准处理；主动导入的 PNG/JPEG/GIF/WebP 图片使用内容寻址 sidecar：

```text
example.mdv
.mdv-assets/<documentId>/<sha256>.<extension>
```

Markdown 直接记录相对路径 `./.mdv-assets/<documentId>/<sha256>.<extension>`。路径本身就是不可变内容引用，不在 manifest 中重复维护可变的 `path -> hash` 映射。Core 负责资源导入、相对路径解析、读取与 SHA-256 校验；宿主负责 paste/drop、把返回的相对路径插入 Markdown，以及最终渲染。Core 不扫描或解释 Markdown AST。

四个公开方法为 `importManagedResource`、`resolveManagedResource`、`readManagedResource`、`verifyManagedResource`。resolve 检查严格路径、存在性和文件类型，返回本地绝对路径，不计算内容 hash；read/verify 对同一打开句柄限量读取并校验 hash/媒体。import/read/verify 默认单资源 32 MiB。文件头识别不是完整图片解码，渲染 URI 和像素安全仍由宿主负责。详见[资源契约](../resources.md)与 [D011](./decisions.md#d011m55-区分普通链接与可选受管图片)。

sidecar 用私有临时文件、回读验证、fsync 和 hard-link 不覆盖发布；目标已存在必须验证 bytes 完全相同才可复用。它不获取 MDV writer lock 或执行 generation CAS；Markdown save 仍执行原 CAS。先导入再 save，save 失败可以留下安全孤立资源，不伪装成跨文件事务。

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
-> 返回只包含元数据索引的 DocumentSnapshot
```

`open` 会按既有 Reader 安全规则读取并校验两个固定的 `current.md`，但不默认解压任何历史 `content.md`。`getStatus()` 通过异步 Reader contract 取得两份工作副本，将原始 bytes 的 `byteLength` 和 SHA-256 与已有 Head metadata 比较并计算 Reference 关系；读取某版本正文时验证长度和 SHA-256；顶层 `verifyMdv(..., { mode: 'full' })` 才遍历全部历史正文。

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

`createMdv` 创建 generation 为 0 的空容器；目标路径已存在时以 `CONFLICT` 失败，不能覆盖。创建成功后返回路径绑定的 `MdvDocument`，可以直接读取或保存。

无基准的 `DocumentSnapshot` 不提供资源方法；显式可信 `baseDirectory` 的 `LocatedDocumentSnapshot` 扩展只读 resolve/read/verify，`MdvDocument` 再扩展 import 与已有包写方法。资源能力不引入泛化 provider 或渲染器模型，完整签名以[公开 API 文档](../api-reference.md#受管图片)为准。

### 6.1 M5 Agent-friendly 只读能力与公开契约

M2-M4 的 open/read/trace/save/commit/checkout 是实现 `.mdv` 格式语义所必需的基础能力。相比之下，M5 新增的结构化状态、确定性 Diff 与聚合诊断主要服务 Agent Runtime、自动化工具和无 UI 调用方：它们让调用者无需自行解包、计算哈希、拼接文本输出或猜测绑定状态。对普通人而言，这些 API 的直接价值较小；人类使用者真正需要的 Reference/Document 左右对照，只要求 Core 根据 Document Version 的 bind 精确定位并读取两份 Markdown，具体布局、渲染、同步滚动和交互均由 VS Code、MarkText 等上游实现。

这些能力仍放在 Core，是因为工作副本状态、源码 Diff 和归档诊断都需要共享格式不变量、字节保真与资源上限。由 Core 提供一套可复用且确定的语义，可以避免每个 Agent tool 重写出互不一致的实现；Core 不因此增加 Agent 专属 DTO、面向模型的 token 裁剪策略或任何 Review UI。

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

interface TreeWorkingCopyStatus {
  readonly head: VersionId | null
  readonly dirty: boolean
}

type ReferenceRelation =
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

interface DocumentStatus {
  readonly reference: TreeWorkingCopyStatus
  readonly document: TreeWorkingCopyStatus
  readonly referenceRelation: ReferenceRelation
}

type ContentSpec =
  | {
      readonly tree: TreeKind
      readonly kind: 'working-copy'
    }
  | {
      readonly tree: TreeKind
      readonly kind: 'version'
      readonly version: VersionId
    }

type DiffLine =
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

interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

interface DiffLimits {
  readonly maxInputBytes: number
  readonly maxInputLines: number
  readonly maxEditLength: number
  readonly maxHunks: number
  readonly maxOutputBytes: number
}

interface DiffOptions {
  readonly contextLines?: number
  readonly limits?: Partial<DiffLimits>
}

interface DiffResult {
  readonly hunks: readonly DiffHunk[]
  readonly unifiedText: string
}

type VerifyMode = 'metadata' | 'full'

interface VerifyOptions extends OpenOptions {
  readonly mode?: VerifyMode
  readonly maxIssues?: number
}

interface VerifyIssue {
  readonly code: MdvErrorCode
  readonly message: string
  readonly entry?: string
  readonly path?: string
  readonly details: MdvErrorDetails
}

interface VerifyReport {
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
  getStatus(): Promise<DocumentStatus>
  readContent(source: ContentSpec): Promise<MarkdownSource>
  diff(from: ContentSpec, to: ContentSpec, options?: DiffOptions): Promise<DiffResult>
}
```

约定：

- `listVersions` 只返回轻量元数据，不返回正文。
- `listVersions`、`getChildren` 和反向 bind 结果按 RFC 3339 实际时刻升序排列，以 Version ID 打破平局；`getHistory` 从指定版本或 Head 沿 parent 返回到根。
- `getHistory`、`traceDocument` 和 `traceReference` 只遍历打开时建立的 parent/bind 索引；历史正文仍按需读取。
- `listDocumentsUsingReference` 从 Document Version 的单向 bind 建立反向内存索引，不向 Reference Version 写回数据。
- `readReference` 和 `readDocument` 分别读取 `ref_tree/current.md` 与 `doc_tree/current.md`，同时返回 profile、资源基准目录和来源描述。
- `readVersionBytes` 是正文保真的基础 API；`*Text` 是严格 UTF-8 解码的便利 API，不执行 Markdown 解析。
- `getStatus()` 是异步方法，因为它沿用异步 Reader contract 取得工作副本；它将工作副本原始 bytes 的 `byteLength` 和 SHA-256 与已有 Head metadata 的 `contentBytes` / `contentSha256` 比较，不需要额外读取 Head 正文，也不改变 `openMdv` 已有的工作副本校验策略。
- `TreeWorkingCopyStatus` 只保留调用方当前需要的 `head + dirty`；clean/dirty 没有不同 payload，不为它们制造形式化判别联合。
- `ReferenceRelation` 描述当前 Document HEAD 与 Reference HEAD 的关系。`no-document-head`、`unbound`、`aligned`、`drifted` 是互斥且完备的调用方分支；Document HEAD 已由 `DocumentStatus.document.head` 给出，不在每个 relation 分支重复。`drifted.currentReference` 允许为 `null`。
- `readContent` 是工作副本和历史版本的统一选择入口。`ContentSpec.tree` 与 Version 所属树不一致时返回 `NOT_FOUND`；已有的 `readReference`、`readDocument` 和 `readVersionBytes/Text` 保留为便利 API。
- `diff` 的两端都使用同一个 `ContentSpec`，因此可以比较任意合法的工作副本/版本组合。`DiffLine.oldLine/newLine` 用 `null` 明确表示该侧不存在这一行；`text` 保留原始行结束符，默认不隐藏 CRLF、空白、Unicode 或末尾换行差异。
- `diff` 默认保留 3 行上下文，输入合计限制为 8 MiB / 200,000 行，最大编辑距离 2,048，最多 10,000 个 hunk，unified text 最多 16 MiB；任一超限整体返回 `LIMIT_EXCEEDED`，不返回部分结果。
- `readContent(source).bytes` 已完整覆盖“导出当前或历史 Markdown”的需求；M5 不再增加含糊且重复的独立 export API。
- `verifyMdv` 是 package-root 顶层诊断入口，不挂在已经成功构造的 snapshot 上。这样即使源文件损坏到无法构造 snapshot，调用方仍可请求诊断；普通 `openMdv`/`parseMdv` 继续在首个阻断错误处失败。
- `verifyMdv` 的 `metadata` 模式检查容器、manifest、两个工作副本、Head、版本 metadata、parent/bind 和图；`full` 在此基础上流式遍历所有历史正文，检查 UTF-8、长度与 SHA-256。它在安全可继续的范围内聚合相互独立的问题，不为聚合而绕过资源上限；阻断错误、资源上限或 `maxIssues` 使检查无法走完时，报告以 `complete: false` 明确表示结果不完整。
- 路径 source 不存在或根本无法读取时，没有可供聚合的归档诊断，`verifyMdv` 仍分别抛出 `NOT_FOUND` 或 `IO_ERROR`；无效 option 继续抛 `TypeError` / `RangeError`。
- `verifyMdv.maxIssues` 默认 100。metadata 阶段若无法建立可信索引，以阻断 issue 和 `complete: false` 停止；索引建立后，图校验和 full 历史正文校验会在剩余预算内聚合独立问题。
- 所有返回集合和元数据都是只读快照，调用方修改它们不能改变包内容。

M5 的以上能力全部是只读查询：facade 复用现有 Archive Reader 按需取得原始字节，由 `core/` 计算 status、关系和 Diff；`verifyMdv` 复用现有容器校验与流式正文校验。它们是建立在 M2-M4 格式能力之上的 Agent-friendly 便利层，不改变 Reference/Document 左右对照仍由 bind + 精确读取组成的事实。M5 不修改 Format 0.1，不进入 Writer、锁、generation CAS 或原子替换链，也不新增第二种存储抽象。

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
interface SaveInput {
  readonly markdown: string | Uint8Array
  readonly expectedGeneration: number
}

interface MdvDocument extends LocatedDocumentSnapshot {
  saveReference(input: SaveInput): Promise<MdvDocument>
  saveDocument(input: SaveInput): Promise<MdvDocument>
}
```

- `saveReference` 只更新 `ref_tree/current.md`。
- `saveDocument` 只更新 `doc_tree/current.md`。
- 两种 save 都把 generation 精确增加 1，但都不创建 Version。
- 成功结果本身就是重新绑定目标文件的新 `MdvDocument`；新的 generation 位于 `result.manifest.generation`，不再套一层只重复 generation 和 snapshot 的结果对象。
- 原 `MdvDocument` 仍是打开时刻的不可变快照。调用方必须接住成功返回的新对象，后续写入使用它的 generation。
- `string` 按 UTF-8 写入；`Uint8Array` 是 byte-for-byte 保真的基础输入。写入值仍须满足 Format 0.1 的严格 UTF-8、无 BOM 约束。
- `expectedGeneration` 必须是非负安全整数，并在取得文件锁、重开最新包之后比较；不匹配时返回 `CONFLICT`，不产生临时提交。

### 6.4 Commit

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

commit 不接收 `markdown`。它只读取已经通过 save 持久化的目标 `current.md`；尚在编辑器内存里的内容不是 Core 状态，宿主必须先 save 再 commit。

没有 Head 时，第一次显式 commit 总是创建 parent 为 `null` 的根 Version，即使 `current.md` 为空。初始化仍然只产生零版本、零 Head，只有用户或 Agent 的显式 commit 才表达“保存这个空状态”。

已有 Head 时，如果 Reference 工作副本相对 `ref_tree/HEAD` 没有变化，`commitReference` 返回 `created: false, reason: 'no-changes'`。Document 的正文未变化且传入的 Reference Version（包括 `null`）与 `doc_tree/HEAD` 对应版本相同时，`commitDocument` 同样不创建版本；如果正文相同但 bind 发生变化，仍然创建新 Document Version。no-changes 仍是一笔成功事务并让 generation 精确增加 1，`created` 只表示是否创建了 Version。

### 6.5 查看与恢复

```ts
interface CheckoutInput {
  readonly version: VersionId
  readonly expectedGeneration: number
  readonly discardChanges?: boolean
}

interface MdvDocument {
  checkoutReference(input: CheckoutInput): Promise<MdvDocument>
  checkoutDocument(input: CheckoutInput): Promise<MdvDocument>
}
```

- 查看旧版本只调用 `readContent` 或 `readVersionBytes/Text`，不会改变工作状态。
- checkout 才把历史正文恢复到工作副本，并把相应 Head 设置为该版本。
- checkout 默认比较目标树的 `current.md` 与当前 Head；工作副本 dirty 时返回 `CONFLICT`，避免静默丢失已经 save 的普通 Markdown。只有调用方显式传入 `discardChanges: true` 才允许覆盖。
- checkout Document Version 不额外写入 bind；该历史版本原来的 bind 始终保存在它自己的 `meta.json.referenceVersion` 中。
- checkout 不创建版本；成功事务让 generation 精确增加 1。用户继续修改并 commit 后才形成新历史节点。

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
| 按需读取旧版本 | `readVersionBytes` / `readVersionText` |
| 恢复旧版本到工作副本 | `checkoutReference` / `checkoutDocument` |
| 读取任意工作副本或版本 | `readContent` |
| 查看 dirty 与 Reference 关系 | `getStatus` |
| 比较工作副本或版本 | `diff` |
| 诊断 metadata 或全部历史正文 | `verifyMdv` |
| 取得可导出的原始 Markdown | `readContent(...).bytes` |

## 7. 写入与并发模型

save、commit 和 checkout 都是完整文档写事务：

```text
按文件系统最终路径获取跨进程独占锁
-> 重新打开磁盘上的最新包
-> 检查 documentId 与 expectedGeneration
-> 校验本次操作的目标版本与类型
-> 更新工作副本，或增加不可变版本并更新 Head
-> 在同目录的私有临时文件中写出完整新 ZIP
-> 对临时包执行结构与完整性校验
-> fsync 临时文件
-> 原子替换原 .mdv（事务 commit point）
-> 同步目录元数据
-> 在锁内打开结果
-> 释放锁并返回新 snapshot
```

M3 为 `createMdv`、`saveReference` 和 `saveDocument` 落地了这套事务；M4 的 commit 与 checkout 已复用同一路径，没有建立第二套 Writer。generation 或 document identity 不匹配时返回 `CONFLICT`，不自动重试或覆盖。这等价于普通 Markdown 被其他进程修改：调用方应重新打开文档，再决定重载、比较、合并或另存为；Core 不替宿主处理编辑器内存 buffer。

原子替换成功是事务的 commit point。它之前的写 ZIP、校验或 fsync 失败都必须保持旧包 byte-for-byte 不变；它之后若目录同步失败，新 generation 可能已经提交，错误 details 必须包含 `stage: 'sync-directory'`、`committed: true` 和已写入的 generation。此时调用方不能用旧快照盲目重试，而应重新 `openMdv` 确认磁盘状态。

0.1 的写入保证限定在 Core 明确支持的本地文件系统上：目标必须是只有一个文件名链接的普通文件，且文件系统必须提供可靠的目录创建、同目录原子替换与 fsync 语义。写入入口拒绝最终 symlink、hard-link alias 及其他非普通文件；网络文件系统、FUSE 或同步盘若不能提供这些语义，不在相同保证范围内。只读入口仍按 Reader 的既有安全规则处理输入。

锁是规范目标路径旁的 `<target>.lock` 目录。M3 有意不按年龄自动回收已有锁：进程遭遇 `SIGKILL`、机器崩溃或清理失败后，只有确认没有活跃 writer 时才可人工删除锁目录和同目录遗留的 `.mdv-*.tmp`。常规失败会尽力清理；如果清理本身失败，错误 details 明确携带 `cleanupIncomplete` 与 `cleanupFailures`。

临时包从创建起限制为 POSIX mode `0600`；save 只保留原目标的 POSIX mode，不承诺保留 owner/group、ACL、xattr、Finder tags 或 Windows DACL/attributes。macOS/Linux 路径会同步临时文件和父目录；Windows 会刷新临时文件，但由于 Node 没有可移植的目录 fsync/write-through 接口，断电后的目录项持久性弱于 POSIX。M6 的 Windows 三组 CI 已通过，但不等于真实断电实验，不能据此提高持久性承诺。

0.1 接受整包重写成本。M3 Writer 使用 STORE 与固定 ZIP metadata 生成确定性 ZIP32；manifest 只原位替换 generation token，历史 version metadata 原始字节透传，历史正文以单次 ZIP 扫描逐版本校验并送入 Writer，避免把全部历史正文同时驻留内存。Writer 不能就地改写旧包。大文档的内容去重、分块和增量容器属于后续格式版本。

## 8. Agent 工作流

Agent 一次成品编辑任务的标准流程：

1. 打开 `.mdv`，调用 `getStatus()` 并按需读取 `ref_tree/HEAD` 和 `doc_tree/HEAD`。
2. 如果任务依赖摘要，选择一个已经 commit 的 Reference Version 并固定其精确 ID；否则固定为 `null`。
3. 按需读取选中的 Reference Version、当前成品和少量相关历史，不加载全部正文；选择 `null` 时跳过 Reference 正文。
4. 调用 `saveDocument({ markdown, expectedGeneration })` 保存普通 Markdown 工作副本，并用返回的新 `MdvDocument` 继续操作；可以重复多次，不产生版本。
5. 用户或 Agent 明确决定保留版本时，在确认编辑器 buffer 已 save 后调用 `commitDocument({ referenceVersion, actor, summary, expectedGeneration })`；commit 本身不接收正文。
6. 新 Document Version 把这次 commit 传入的 ID 或 `null` 写入自己的 `meta.json.referenceVersion`，因此后续可以确定它基于哪个摘要版本，或确定它没有摘要依赖。

如果摘要工作副本有未提交修改，Agent 有两种明确选择：

- 继续使用已有 `ref_tree/HEAD`；或
- 先 `commitReference` 产生新 Reference Version，再把它传给 `commitDocument.referenceVersion`；或
- 仅当这次成品确实不依赖摘要时，显式传入 `null`。

Core 不允许 Document Version 绑定一份尚未 commit、未来还会变化的摘要工作副本。

## 9. M5 Agent-friendly 状态、Diff 与完整性诊断

M5 不是新的图形 Review 产品层，也不是人类查看 `.mdv` 的前置条件。其主要增量是把 Agent 和自动化工具经常重复实现的状态判断、原始文本比较与损坏诊断收敛成稳定、结构化、确定且受资源上限保护的 Core API。人类客户端可以选择使用这些结果提供提示或诊断，但最重要的左右对照模式仍由 `traceDocument` / bind 与 `readContent` 提供内容配对，上游负责展示。

### 9.1 工作副本状态与 Reference 关系

`getStatus()` 通过 Reader 取得打开时已经安全校验的两份工作副本，将其原始 bytes 的 `byteLength` 和 SHA-256 与已有 Head metadata 的 `contentBytes` / `contentSha256` 比较，返回 Reference/Document 各自的 clean/dirty 状态，以及当前 Document HEAD 的 `ReferenceRelation`。它不读取历史正文，也不改变 `openMdv` 的读取范围。

Reference 关系只报告事实：

- `no-document-head` 表示当前成品尚未 commit；
- `unbound` 表示当前 Document Version 明确不依赖 Reference；
- `aligned` 表示绑定版本等于 Reference HEAD；
- `drifted` 同时返回 Document 实际绑定的 Reference 和当前 Reference HEAD，后者允许为 `null`。

Reference commit 不自动修改成品工作副本、Document HEAD、bind 或历史版本。上层看到 drift 后自行决定只提示、比较，还是编辑并提交新的 Document Version。

### 9.2 Diff

0.1 使用 Markdown 源文本逐行 Diff，支持：

- Document Version 与 Document Version；
- Reference Version 与 Reference Version；
- Reference Version 与 Document Version；
- 工作副本与其 Head；
- 任意工作副本与指定版本。

默认不忽略空白、换行符或 Unicode 差异。结果同时提供结构化 hunks 和 unified diff 文本；输入 bytes、输入行数、算法编辑长度、输出 bytes 和 hunk 数均受上限约束，任一超限都整体返回 `LIMIT_EXCEEDED`，不返回可能被误认成完整结果的截断 Diff。Reference → Document 的“标题覆盖率、要求是否落实”等语义 Diff 留到后续，不能替代原始文本 Diff。

当前默认值是 3 行上下文、8 MiB 合计输入、200,000 合计行、2,048 最大编辑距离、10,000 个 hunk 和 16 MiB unified text。实现采用 bounded Myers，并用共同前后缀裁剪减少搜索范围，不引入第三方 Diff runtime。

### 9.3 统一内容选择

`readContent(ContentSpec)` 与 `diff(from, to)` 共用一套选择器，不再分别发明“working 导出参数”“version 导出参数”或 tree 推断规则：

```ts
await snapshot.readContent({ tree: 'document', kind: 'working-copy' })
await snapshot.readContent({ tree: 'document', kind: 'version', version: d1 })
await snapshot.diff(
  { tree: 'reference', kind: 'version', version: r1 },
  { tree: 'reference', kind: 'working-copy' },
)
```

`readContent` 返回现有 `MarkdownSource`。需要写文件、传给渲染器或实现“导出”的调用方直接使用其 `bytes`；Core 不增加只给相同原始字节换名字的独立 export 方法。

### 9.4 顶层完整性诊断

`verifyMdv(pathOrBytes, options)` 直接接受 `.mdv` 文件路径或包字节。它不能依赖先成功调用 `openMdv`，否则最需要诊断的损坏包反而没有入口。

- `metadata` 是默认模式，检查安全 ZIP 索引、manifest、两个工作副本、Head、version metadata、parent/bind 与图，但不遍历历史 `content.md`；
- `full` 在 metadata 基础上遍历每个历史 `content.md`，验证严格 UTF-8、字节数和 SHA-256；
- 诊断在不突破资源限制、不基于损坏状态继续猜测的前提下聚合独立问题；阻断错误、资源上限或达到 `maxIssues` 使目标 mode 无法完整执行时返回 `complete: false`；
- `valid` 只在本次要求的 mode 完整执行且没有 issue 时为 `true`；warning 不影响 `valid`；
- 路径 source 不存在或无法读取时分别抛出 `NOT_FOUND` / `IO_ERROR`，因为此时没有归档内容可生成诊断报告；
- 普通 open/read 仍然 fail-fast，不能为了诊断能力改变日常读取的错误边界。

当前 `maxIssues` 默认 100。metadata 的阻断性容器/格式错误不会在不可信结构上继续猜测；建立索引后，Core 图校验可以给出多个关系问题，full 正文阶段通过单次 ZIP 扫描按稳定顺序聚合独立 UTF-8、长度与哈希错误，包括不在当前 Head ancestry 上的分支。

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
  | 'INVALID_RESOURCE'
  | 'INTEGRITY_MISMATCH'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'IO_ERROR'
```

- 格式错误、完整性错误、并发冲突和 I/O 错误不得互相伪装。
- details 可包含条目路径、Version ID、预期值和实际值，不包含完整正文。
- `verifyMdv` 尽量收集多个独立问题；普通读取遇到阻断性问题立即失败。
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
│   ├── archive/
│   └── resource/
│       ├── model.ts
│       └── store.ts
└── test/
```

职责保持克制：

- `index.ts`、`mdv-document.ts`、`types.ts` 和 `errors.ts`：公开 facade、输入/输出 DTO 与错误码；不暴露 ZIP DTO 或内部可变状态。
- `core/`：版本图、trace、dirty/漂移、commit/checkout 规则和源文本 Diff；不解析 Markdown，也不执行 ZIP I/O。
- `archive/`：ZIP/JSON 编解码、格式 DTO、资源限制、锁、generation CAS、临时包校验和原子替换。
- `resource/model.ts`：受管路径 grammar、媒体头识别、单资源上限和 hash；`resource/store.ts`：本地 sidecar 安全读取与不覆盖发布。它是持久化职责的独立模块，不是新的业务层，也不依赖版本图或 ZIP transaction。
- `index.ts` 只重导出 public API；调用方不能越层导入 `core/`、`archive/` 或 `resource/`。

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

面向人的 Reference/Document 左右对照由宿主组合现有 bind/trace 与读取接口：Core 保证某个 Document Version 精确对应其绑定的 Reference Version（或明确未绑定），宿主再决定双栏布局、Markdown 渲染、同步滚动以及是否调用编辑器原生 Diff。M5 的结构化 Diff 更偏向 Agent/自动化消费，不要求图形客户端用它替代自身的显示能力。

## 14. 一致性测试与验证

### 14.1 Fixtures

至少覆盖：

- generation 为 0、两棵树中工作副本为空且没有 Head 的初始化包；
- Reference 始终为空，只有 `D1(referenceVersion=null) -> D2(referenceVersion=null)` 的普通版本文档；
- `ref_tree/current.md` 已保存但尚未 commit；
- R1 已 commit，成品工作副本固定使用 R1，但尚无 D1；
- `R1 -> R2` 与 `D1(referenceVersion=R1) -> D2(referenceVersion=R2)`；
- Reference 历史仍包含 R1 但 Reference Head 为 `null`，Document Head 继续绑定 R1；
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
6. 首次显式 commit 即使工作副本为空也创建根版本；已有 Head 后正文与绑定 Reference（包括 `null`）都未变化时不创建版本但 generation 增加 1。
7. 正文未变化但绑定 Reference 改变时，document commit 创建新版本。
8. checkout 只恢复工作状态；dirty 工作副本默认冲突，显式 discard 后才能覆盖；后续 commit 才形成分叉。
9. `getHistory`、`traceDocument`、`traceReference` 在直线历史与分叉历史中返回正确关系。
10. 原子写入故障注入：在写 ZIP、校验、fsync、替换各阶段失败，旧包仍可读。
11. 两个 writer 使用相同 generation 时，最多一个成功，另一个得到 `CONFLICT`；宿主可以按普通文档外部修改流程重载或合并。
12. `getStatus` 覆盖无 Head 的空/非空工作副本、clean/dirty，以及 `no-document-head`、`unbound`、`aligned`、`drifted(currentReference=null)` 全部分支。
13. `readContent` 覆盖两棵树的工作副本和版本；tree 与 Version 不匹配时稳定返回 `NOT_FOUND`。
14. Diff 覆盖所有合法 `ContentSpec` 组合、相同内容、CRLF/LF、末尾换行，以及输入 bytes/行数、编辑长度、输出 bytes、hunk 上限。
15. `verifyMdv(metadata)` 与 `verifyMdv(full)` 覆盖无法 open 的结构错误、可聚合的独立错误、`maxIssues` 截断、`complete: false`，以及未被普通读取访问的损坏分支正文；不存在和不可读路径继续验证抛错语义。
16. `save -> commit -> reopen -> getStatus -> diff -> verifyMdv(full) -> readContent` 端到端测试。
17. 资源测试覆盖媒体、严格路径、限量读取、symlink/目录变化、重复/同进程/跨进程导入、发布前后故障、清理失败、损坏目标不覆盖，以及 `import -> save -> commit -> checkout -> read/verify old image`；sidecar 操作不修改 ZIP/Head/generation/历史。
18. 后续 Python 只读实现运行同一套 fixtures，证明格式未绑定 TypeScript。

宿主编辑器的 `Markdown -> editor state -> Markdown` 稳定性属于对应 adapter 的集成测试。Core 只保证交给它的 Markdown 字节不会被自己改写。

## 15. 最小闭环验收

第一版完成时，以下流程必须通过 Core API 执行：

1. 新建包中两个工作副本为空、没有 R1/D1，也没有 Head。
2. 用户不使用 Reference，编辑并多次保存 `doc_tree/current.md`；版本历史仍为空。
3. 用户执行 `commitDocument(referenceVersion: null)` 生成 D1；重新打开后可以 trace，并通过 `readContent` 原样读取 D1。
4. 在另一份文档中，用户编辑 `ref_tree/current.md` 并多次保存；Reference 历史仍为空。
5. 用户显式 commit，生成 Reference Version R1，`ref_tree/HEAD = R1`。
6. Agent 固定 R1，编辑并多次保存成品，然后执行 `commitDocument(referenceVersion: R1)` 生成 D1。
7. 用户修改摘要并显式 commit 生成 R2；旧 D1 仍绑定 R1，Core 报告漂移。
8. Agent 比较 R1 → R2，修改当前成品并显式 commit 生成 D2；`D2.parent = D1`、`D2.referenceVersion = R2`。
9. `traceDocument(D2)` 能返回 D2 的 Document ancestry 与 R2；`traceReference(R1)` 能返回 Reference ancestry 与绑定 R1 的 Document Versions。
10. 用户可以查看旧版本、checkout 到工作副本、从旧版本继续形成分叉，并通过 `readContent` 取得当前或任意历史 Markdown。
11. 并发 writer 使用旧 generation 保存或 commit 时得到冲突，不覆盖另一方的工作副本或版本。

## 16. 实施顺序

1. 评审并冻结 ZIP、最小 manifest、`ref_tree` / `doc_tree`、nullable Document Version bind、Version ID 和附件边界。
2. 写 `spec/format-0.1.md`、三个 JSON Schema 和第一批合法/非法 fixtures。
3. 实现 M1 内部 Reader、版本图校验与查询。
4. 实现 M2 公开只读 API：`parse/open`、工作副本读取、版本索引、trace 与 `readVersionBytes/Text`。
5. 实现 M3 工作副本 Writer：`createMdv`、`saveReference`、`saveDocument`、generation CAS 和原子替换。
6. 已实现 M4 `commitReference`、`commitDocument` 和 checkout。
7. 已实现 M5 `getStatus`、`readContent`、源文本 Diff 与顶层 `verifyMdv`；只复用现有 Reader/Core，不改格式或写事务。
8. 已实现 M5.5 内容寻址外部资源的导入、解析、读取与校验，不把 paste/drop 或渲染逻辑带入 Core。
9. 完成 M6 fixtures、fuzz、安全、复杂 Markdown 往返、性能、CI、包发布与兼容承诺收口。
10. Core 0.1 收口后启动独立 VS Code extension；首个宿主验证稳定后再接入 MarkText adapter，CLI/Agent tool 保持独立上游立项。

第一步不是在任何编辑器的扩展名白名单中加入 `.mdv`。只有格式、fixtures 和 Core 先形成独立边界，MDV 才不会变成只能由单一编辑器理解的私有文件。

## 17. Format 0.1 冻结项

首份语言无关规范见 [`format-0.1.md`](../../spec/format-0.1.md)。实现基线固定为：

1. 0.1 Writer 不生成 ZIP64，Reader 拒绝 ZIP64、多磁盘和加密 ZIP；实现可设置更低的可配置资源上限。
2. 同一 minor 中的未知 JSON 字段允许读取并产生 warning；Writer 重写对应对象时必须保留未知字段和值。`gfm` 是 0.1 唯一登记的 `markdownProfile`，其他合法 token 产生 warning 而不是读取失败。
3. 普通 `.md` 转换默认只填充 Document Working Copy，不隐式 commit。是否立即生成 D1 必须由上游产品显式选择。
4. 何时进入 0.2 的内容去重或增量容器不属于文件格式语义，在真实历史规模基准测试后单独决策。
