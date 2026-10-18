# BetterMe 本机岗位服务

`@better-me/job-service` 提供独立的 TypeScript 本机服务：把受控来源的公开岗位记录保存到 SQLite，以同一套应用工具服务 HTTP 查询和后续 Agent 适配。它不读取浏览器简历、Fact、投递材料、联系人、API Key 或浏览器 profile。

这是岗位地图的本机服务底座，包含 M1 HTTP / 采集能力及 M2 repository 层的人工归并与撤销。归并 API 尚未接入应用工具或 HTTP；三维地图、私人机会工作台联动、LangChain / LangGraph Agent、定时刷新及真实用户迁移需分别验收。原有四平台单岗读取不等于本服务已经实现这些平台的全站搜索。

## 环境与启动

需要 **Node.js 24.15.0 或更新的 24.x，或 Node.js 26+**，以及仓库指定的 pnpm。SQLite 使用 Node 内置的 `node:sqlite`，无需另外安装数据库服务。

在仓库根目录启动，并选择 Git 仓库外的专用数据目录：

```powershell
pnpm install --frozen-lockfile
$jobDataDirectory = Join-Path $env:LOCALAPPDATA "BetterMe/job-atlas"
pnpm --filter @better-me/job-service start --data-dir $jobDataDirectory --origin http://localhost:5173
```

`--origin` 可重复，值必须是完整且精确的 HTTP(S) origin，例如 `http://localhost:5173`；不能带路径、通配符或末尾 `/`。浏览器中的 `http://127.0.0.1:5173` 是另一个 origin，若使用它需单独列出。CLI 不会自动开启 Web 工作台，也不会自动导入或启用示例来源。

| 参数 | 行为 |
| --- | --- |
| `--data-dir <绝对路径>` | 必填。专用的本机持久数据目录。 |
| `--origin <origin>` | 必填，可重复。允许访问 API 的精确网页 origin。 |
| `--host 127.0.0.1\|::1` | 默认 `127.0.0.1`，仅允许本机回环地址。 |
| `--port <1–65535>` | 默认 `5178`。不会停止占用端口的其他程序。 |
| `--dns system\|google-doh` | 默认系统 DNS；仅改变本服务的解析方式。 |
| `--help` | 显示帮助，不创建文件、不启动监听。 |

`google-doh` 是可选的显式设置，适用于系统返回 Fake-IP 的环境。它通过固定的 Google DNS HTTPS 端点解析来源主机名，并继续验证返回的是公网地址；不会修改操作系统 DNS 或把保留地址加入允许列表。DNS HTTPS 流量与来源 HTTP 流量共同消耗调用预算，且来源主机名会发送给所选 DNS 服务。Google 端点自身不可达时仍会失败。

运行目录包含 `jobs.sqlite`、SQLite 的 WAL / SHM 辅助文件、私有的 `service.token` 和独占所有权锁 `.job-service.lock/`。日志只显示 token 文件路径。Windows 下应使用仅本人可访问的 NTFS 目录；这些运行文件不应提交到 Git。相同目录已有活跃或不能核实的所有者时，新进程拒绝启动，不会杀进程。确认原进程已退出的旧锁会保留在隔离目录中。取得独占锁后，服务将上次中断的 `running` 任务标为失败，不会暗中恢复采集。

按 `Ctrl+C` 停止服务：停止接受新请求、取消进行中的读取、等候应用任务结束，再关闭 SQLite 和释放本进程的锁。清理未成功完成时会保留数据库与锁，便于核对。

## 使用 HTTP API

默认 API 地址为 `http://127.0.0.1:5178`。实际地址以启动日志为准；`localhost` 不属于 API 的 Host 允许项。除合法 CORS 预检外，**包括 `/healthz` 在内的请求都需要 Bearer token**。

下面的 PowerShell 例子只把 token 保存在当前进程变量，不把它写入示例配置：

```powershell
$jobApi = "http://127.0.0.1:5178"
$jobServiceToken = (Get-Content -LiteralPath (Join-Path $jobDataDirectory "service.token") -Raw).Trim()
$jobHeaders = @{ Authorization = "Bearer $jobServiceToken" }
Invoke-RestMethod -Uri "$jobApi/healthz" -Headers $jobHeaders

$jobQuery = @{
  search = @{ text = "TypeScript"; mode = "fuzzy" }
  market = "global"
  sort = @{ field = "updated"; direction = "desc" }
  page = @{ limit = 30 }
} | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Post -Uri "$jobApi/api/v1/jobs/search" -Headers $jobHeaders -ContentType "application/json" -Body $jobQuery
```

业务接口返回工具执行结果：成功为 `{ "ok": true, "requestId": "…", "value": … }`，失败为 `{ "ok": false, "requestId": "…", "error": { "code": "…", "message": "…" } }`。HTTP 层的认证、origin、内容类型和路由错误另返回 `{ "error": "…" }`。所有响应禁用缓存；POST 只接受 JSON 对象，默认请求体上限为 8 MiB。URL query 参数不支持。

所有 `local-write` 接口都要提供 `Idempotency-Key`。同一身份、同一工具下，同键同内容重放结果，同键不同内容返回冲突；开始新一轮刷新应使用新键。可选 `X-Request-Id` 仅用于请求标识，不能注入执行身份、权限、预算、文件路径或家庭坐标。

| HTTP | 路径 | 应用工具 / 输入 |
| --- | --- | --- |
| GET | `/healthz` | 认证后的进程存活检查。 |
| POST | `/api/v1/jobs/search` | `jobs.search`；直接传共享 `JobQuery`。 |
| GET | `/api/v1/jobs/:jobId` | `jobs.read-detail`；旧 ID 按本次快照解析到规范岗位，返回公司、全部来源、观察与 JD 快照。 |
| GET | `/api/v1/sources` | `sources.list`；已保存来源及当前安装的适配器能力。 |
| POST | `/api/v1/sources` | `sources.register`；`{ source, expectedRevision? }`，修改既有配置需版本号。 |
| POST | `/api/v1/sources/:sourceId/preview` | `sources.preview`；`{ scope?, maxRecords? }`，读取一页，不写岗位索引。 |
| POST | `/api/v1/sources/:sourceId/sync` | `sources.sync`；`{ scope?, maxRecords?, maxPages? }`，受限手动刷新。 |
| POST | `/api/v1/sources/discover` | `sources.discover`；`{ sourceId, request }`，发现待审核来源候选。 |
| POST | `/api/v1/sources/inspect` | `sources.inspect`；`{ sourceId, request }`，有限抽样检查。 |
| POST | `/api/v1/sources/propose` | `sources.propose`；直接传提案输入，只生成禁用配置。 |
| GET | `/api/v1/runs` | `runs.list`；持久刷新任务。 |
| GET | `/api/v1/runs/:runId` | `runs.read`；任务状态与数字摘要。 |
| POST | `/api/v1/runs/:runId/cancel` | `runs.cancel`；JSON `{}`，取消当前身份的任务。 |
| POST | `/api/v1/dataset/import` | `jobs.import-public`；`{ dataset, expectedRevision? }`，严格公共快照。 |
| GET | `/api/v1/dataset/export` | `jobs.export-public`；仅公共领域快照。 |
| GET | `/api/v1/leads` | `leads.list`；线索与招聘批次，独立于正式岗位计数。 |

`scope` 为 `{ "roles": [], "regions": [], "companyNames": [] }`；省略时使用空数组。上游是否支持这些过滤条件由适配器能力和返回的 `coverage.appliedFilters` / `ignoredFilters` 说明。应用另做本地包含匹配，因此“关注范围内刷新”不代表上游已经提供全站搜索或只下载匹配记录。

例如，审核并注册某个来源后可调用：

```powershell
$jobHeaders["Idempotency-Key"] = "my-reviewed-source-refresh-001"
$refreshBody = @{
  scope = @{ roles = @("TypeScript"); regions = @(); companyNames = @() }
  maxRecords = 100
  maxPages = 1
} | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Post -Uri "$jobApi/api/v1/sources/my-reviewed-source/sync" -Headers $jobHeaders -ContentType "application/json" -Body $refreshBody
```

`my-reviewed-source` 是用户自己保存的来源 ID，示例不会自动创建它。[来源配置示例](../../config/sources/examples.json)全部默认禁用、待审核；必须先核对原站、许可、稳定身份、字段映射和请求范围，再显式注册 / 启用。配置修改使同源正在进行的旧任务失效。

## 查询与数据边界

查询契约来自 [`@better-me/opportunities`](../../packages/opportunities/README.md)，支持模糊 / 精确关键词、国内 / 全球 / 海外范围、企业与有证据的控股来源分类、来源、地区、工作方式、状态、人民币税前年薪和距离筛选，以及稳定分页和全量地图桶。

家庭坐标、汇率快照、配色与别名覆盖是可信 host 注入的 `QueryOptions`。当前 CLI 不提供保存家庭住址、自动获取汇率或用户配色面板；未注入坐标时不能完成距离查询，未具备薪资比较证据时保留原文 / 原币和未知状态，不自行补工资、汇率、税制、奖金或控股国别。

SQLite 持久保存来源、公司、岗位、位置、薪资、来源 listing、观察、JD 快照、线索、任务与事务回执。刷新使用增量合并，不清空既有库；同源稳定记录保持 ID，内容变化追加不可变观察与按内容去重的快照；缺失字段不会无依据删除旧信息，未在列表出现也不会被当成已关闭。相同 listing 突然更换雇主会拒绝写入，等待人工核对。当前不会自动把不同来源的同名岗位合并。

来源列表拉取时间、岗位原始发布时间 / 更新时间、记录再次出现时间、明确在招核验时间保持分离。HTTP 200、列表出现、GitHub 最近更新和活动线索均不是独立的当前在招核验。招聘活动、缺雇主记录及目录线索存入独立 leads，不计入规范岗位数量。

数据库已建立 FTS5 和 RTree，但 **当前业务查询仍读取完整一致性快照并执行共享查询逻辑**。`candidateIds()` 的 `indexedHits` 仅为诊断，真实候选返回全部岗位的 `safe-superset`，避免漏掉模糊词、中文、未知位置或远程岗位。写入当前会重建辅助索引；还未完成查询下推或大规模性能验收，不能把“已有索引表”表述为已完成高性能搜索。

## 人工跨源归并：repository 接口

数据库 schema v2 增加原始岗位投影 `base_jobs`、不可变决策、当前 / 历史岗位别名及岗位版本高水位。已有 schema v1 SQLite 文件会在事务中升级，保留岗位 ID、来源、观察和 JD。以下接口可由可信应用代码调用，**当前 HTTP 路由表尚未提供归并入口**。

| repository 方法 | 行为 |
| --- | --- |
| `listMergeCandidates({ limit?, requisitionLinks? })` | 可解释的待确认候选；排除尚未撤销的拒绝决策。相同标题和企业名不会触发自动写入。 |
| `mergeJobs({ targetJobId, sourceJobId, reason, companyIdentityConfirmed?, requisitionLinks? }, writeOptions)` | 显式合并，采用目标岗位的摘要；不同企业实体且缺共同已核实法人时，必须人工确认企业身份。 |
| `rejectMerge({ leftJobId, rightJobId, reason }, writeOptions)` | 保存拒绝提案的理由；来源刷新不会清掉该决策。 |
| `revokeMerge({ decisionId, reason }, writeOptions)` | 原决策身份撤销合并或拒绝；每条合并边可独立拆回，撤销本身也保留为不可变事件。 |
| `listMergeDecisions()` | 按 revision 返回完整决策审计记录。 |
| `resolveJobId(jobId, { atRevision? })` | 将旧 ID 解析到当前或指定 revision 的规范 ID，并返回完整别名历史；未知 ID 返回 `undefined`。 |
| `readReconciliationConflicts(jobId)` | 返回当前规范 ID、选定摘要来源、冲突预览及有效决策 ID；完整原文仍从各来源观察 / 快照读取。 |
| `readSnapshot()` | 当前去重后的公共快照，供搜索、地图计数和公共导出使用。 |
| `readProjectionSnapshot()` | 各来源的原始岗位 / listing 归属，供 `projectSourcePage()` 和来源导入使用；保留当前全局 revision。 |

`writeOptions` 必须包含 `{ expectedRevision, actorScope, idempotencyKey }`。人工决策、规范投影、索引、别名历史、受影响来源任务失效和耐久回执在同一事务提交；陈旧 revision 拒绝写入，同键同输入可以在重启后重放。已有 `jobId` 和 `snapshotId` 保留，私人收藏 / 投递无需被归并代码改写。

合并保留所有 listing、不可变观察和 JD、薪资、位置及字段冲突。规范岗位按最近一次有效合并所选目标来源提供标量摘要；来源刷新仍更新各自原始投影，未选中来源的新标题或 JD 不静默取代人工摘要来源。撤销合并恢复各自最新投影。多源地点和薪资保留为集合，查询继续按共享规则报告歧义；不会默认采用最高工资或把冲突状态当已核实。

现有 application 已接通归并兼容：**来源刷新从 `readProjectionSnapshot()` 调用 `projectSourcePage()`**，查询与公共导出继续使用 `readSnapshot()`。详情先捕获公共快照，再以其 revision 调用 `resolveJobId()`，避免合并 / 撤销发生在异步读取间时混用不同版本。现有 HTTP 路由复用这些应用工具，无须增加路由；人工归并写入仍只由可信 repository API 提供，尚无归并 UI 或 HTTP 写入入口。候选发现与投影尚未做规模优化，测试通过不代表大量来源下的吞吐结论。

## 一致性、备份与部署

写入、版本号和耐久幂等回执在同一个 SQLite 事务内提交。取消、同源新任务和来源配置变更使用代次校验，迟到结果不能覆盖新任务。进程内工具结果缓存不等于这些耐久回执；涉及外部网络的读取本身也不具备事务回滚。

`GET /api/v1/dataset/export` 是公共领域交换格式，不包含任务、回执、leads、归并原始投影或决策历史，不能当作完整仓库备份。已合并的公共投影也不能重新覆盖原始岗位，必须使用完整备份保留拆分能力。

仓库层提供 `repository.backup()` / `repository.restore(backup, { expectedRevision, actorScope, idempotencyKey })`：schema v2 完整备份包含公共数据、任务、回执、线索、原始岗位、决策、别名历史及岗位版本计数；仍接受 v1 仓库备份并将其作为未归并数据恢复。恢复先校验内容哈希、领域引用、决策引用 / 身份 / 先后关系、当前别名与投影一致性，再原子替换，运行中任务恢复为已取消。当前没有 HTTP 恢复路由或 CLI 备份 / 恢复命令；集成方应通过可信应用代码调用，不应在服务运行时只复制主 SQLite 文件而遗漏 WAL。

GitHub Pages 与现有 nginx Docker 镜像仍然只发布静态网页。本包参与工作区检查 / 编译，不会自动运行在静态容器或 Pages 上。当前 HTTP 只允许本机回环并使用单一 `local-owner` 身份；服务器部署需另行实现服务器身份认证、授权与部署运行配置，不能直接把监听地址改为公网使用。

## 开发验证

从仓库根目录执行：

```powershell
pnpm --filter @better-me/job-service typecheck
pnpm --filter @better-me/job-service test
```

仓库根 `pnpm test` 和 `pnpm lint` 已包含本包。自动化覆盖临时目录中的真实 SQLite 事务、重开、回执、来源范围、取消 / 迟到、备份恢复、投影历史、受控 HTTP 以及生命周期。`tests/reconciliation.test.ts` 还覆盖同名不自动归并、人工身份确认、嵌套合并 / 独立撤销、源刷新后拆回最新 JD / 地点 / 薪资、旧 ID 历史解析、实际 SQL 写入故障整笔回滚、v2 完整备份及持久 v1 SQLite 升级。`tests/application-reconciliation.test.ts` 进一步通过实际 HTTP 验证合并后刷新、旧 ID 详情、规范搜索 / 导出和撤销最新来源，并覆盖 v1 升级后应用兼容及读取期间并发合并 / 撤销的快照一致性。证据见 [M2 归并报告](../../docs/reports/job-atlas-m2-reconciliation-2026-10-18.md)。这些合成检查不代表所有真实来源长期可用、生产服务器部署、私人迁移或三维地图已验收。
