# 验证与发布检查

当前没有 npm 自动发布 workflow，也没有上传发布凭据。Core 包名已确定为 `@owariband/mdv`，仓库采用 Apache-2.0；M6 工程检查可运行，但 `@owariband` scope 的实际发布权限和首次版本仍待 owner 确认。

## 本地验证入口

```bash
npm ci
npm run check
npm run test:package
npm run bench -- --quick
```

`check` 依次执行 typecheck、fixture 字节一致性、build + 全量测试、开发态发布契约检查。项目沿用 TypeScript strict 和 Node 内置测试，没有为 M6 引入新测试框架或 linter 依赖。

`test:package` 的流程：

1. 在临时目录复制源码，不复制仓库 `dist/`；仅构建工具链链接到现有 `node_modules`。
2. 显式运行 `prepare` 生成产物，再 `npm pack --ignore-scripts --json`，避免重复构建并检查真实打包文件清单。
3. 确认 tarball 同时包含 Apache-2.0 `LICENSE` 与 `THIRD_PARTY_NOTICES`，再将 `.tgz` 安装进另一个独立 consumer，禁用安装脚本并只安装运行依赖，验证 package-root 读写、版本、CAS、Diff、校验和图片闭环。
4. 安装固定 TypeScript 5.9.3，再分别使用它和仓库当前编译器检查 strict NodeNext consumer，含只读能力、必填 bind/generation、内部路径拒绝等负向类型断言。
5. 清理此次创建的临时目录。不会修改全局 npm/Git 配置，不发布到 registry。

这个命令需要 npm 公共源网络访问，缓存也在本次临时目录内。无网络时可以运行其余本地检查，但不能把跳过安装验证称为 tarball 已通过。构建用的 `prepare`/发布用的 `prepublishOnly` 生命周期依据 [npm 官方 scripts 文档](https://docs.npmjs.com/cli/v11/using-npm/scripts/)；不要用 `--ignore-scripts` 绕过正式发布检查。

## fixtures 与 fuzz

```bash
npm run fixtures
npm run fixtures:check
npm run test:fuzz
```

生成器直接使用已锁定的 ZIP 依赖，不需要系统 `zip`。条目、mode 和 DOS wall-clock 时间固定；`--check` 只比较，不重写 fixture。每个 `.mdv` 都有 `fixtures/expected/*.json` 对应结果，conformance 测试覆盖路径与内存两种入口以及 full verify。恶意路径/压缩头等额外用例在测试中独立构造，不由 Core writer 生成。

fuzz 默认 seed `1296324144`、256 个输入，覆盖随机 bytes、截断/位翻转、JSON 变异及合法对照。可设置 `MDV_FUZZ_SEED`（uint32）和 `MDV_FUZZ_CASES`（1–10,000）复现；例如 POSIX shell：

```bash
MDV_FUZZ_SEED=1 MDV_FUZZ_CASES=10000 npm run test:fuzz
```

Windows PowerShell 可以先设置 `$env:MDV_FUZZ_SEED='1'` 和 `$env:MDV_FUZZ_CASES='10000'`。worker 使用 128 MiB V8 old-generation 限制、小输入/解压预算与父线程 60 秒终止预算；V8 限制不是整个进程的 RSS 上限。失败会记录 seed、case 和变异类型；时间超限应先缩小 cases 复现，再判断是性能退化还是环境过慢，不无限放宽保护。CI 默认使用小规模固定集，不作无界随机压力测试。

## 正式发布前

```bash
npm run check:release -- --release
```

当前该命令仍应非零退出，但只因版本为 `0.0.0-development`；Apache-2.0 与 `LICENSE` 已完成。普通开发态 `check:release` 仍通过并展示版本未决项。检查会确认 package/lock 身份一致、唯一 ESM export、声明/规范文件存在，以及 lockfile 不包含私有 registry 下载地址。

首次发布前由 owner 完成：

- 确认 `@owariband` npm scope 的实际发布权限；包名已经确定为 `@owariband/mdv`，授权方式已经确定为 Apache-2.0，最终发布前仍应由权利人确认授权范围。
- 选择正式或预发布版本，同步 package/lock，并检查最终 tarball 包含 LICENSE、THIRD_PARTY_NOTICES、运行代码、声明和规范；依赖版本变化时同步复核第三方声明，不能把 `0.0.0-development` 当作正式版本。
- 在待发布提交上确认 [CI](../.github/workflows/ci.yml) 全部结果、平台 skip 原因、安装验证和性能基线；本地脚本不冒充远端 CI 审批。
- 审阅[兼容策略](./compatibility.md)、[性能边界](./performance.md)和[开发日志](./design/dev_log.md)，记录发布说明及适用平台。
- 通过 owner 授权的流程发布并记录 tag/版本；本仓库不会因为合并、push 或运行测试自动发布。

`prepublishOnly` 先运行严格发布 gate，再执行本地检查与真实 tarball 验证。CI Actions 已固定官方提交 SHA、使用只读仓库权限、不保存 checkout 凭据；它只验证，不持有 npm 发布权限。
