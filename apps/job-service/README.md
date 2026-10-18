# BetterMe 本机岗位服务

`@better-me/job-service` 提供独立的 TypeScript 本机服务：把受控来源的公开岗位记录保存到 SQLite，以同一套应用工具服务 HTTP 查询和后续 Agent 适配。它不读取浏览器简历、Fact、投递材料、联系人、API Key 或浏览器 profile。

这是岗位地图的 M1 服务底座。当前尚未提供国内 / 全球三维地图界面、地图与既有机会库的界面联动、自动跨源同岗归并、LangChain / LangGraph Agent、定时刷新或真实用户私人数据迁移。原有四平台单岗读取不等于本服务已经实现这些平台的全站搜索。

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
| GET | `/api/v1/jobs/:jobId` | `jobs.read-detail`；岗位、公司、全部来源、观察与 JD 快照。 |
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

## 一致性、备份与部署

写入、版本号和耐久幂等回执在同一个 SQLite 事务内提交。取消、同源新任务和来源配置变更使用代次校验，迟到结果不能覆盖新任务。进程内工具结果缓存不等于这些耐久回执；涉及外部网络的读取本身也不具备事务回滚。

`GET /api/v1/dataset/export` 是公共领域交换格式，不包含任务、回执和 leads，不能当作完整仓库备份。仓库层提供 `repository.backup()` / `repository.restore(backup, { expectedRevision, actorScope, idempotencyKey })`：版本化完整备份包含公共数据、任务、回执和线索，恢复是显式原子替换，运行中任务恢复为已取消。当前没有 HTTP 恢复路由或 CLI 备份 / 恢复命令；集成方应通过可信应用代码调用，不应在服务运行时只复制主 SQLite 文件而遗漏 WAL。

GitHub Pages 与现有 nginx Docker 镜像仍然只发布静态网页。本包参与工作区检查 / 编译，不会自动运行在静态容器或 Pages 上。当前 HTTP 只允许本机回环并使用单一 `local-owner` 身份；服务器部署需另行实现服务器身份认证、授权与部署运行配置，不能直接把监听地址改为公网使用。

## 开发验证

从仓库根目录执行：

```powershell
pnpm --filter @better-me/job-service typecheck
pnpm --filter @better-me/job-service test
```

仓库根 `pnpm test` 和 `pnpm lint` 已包含本包。自动化覆盖临时目录中的真实 SQLite 事务、重开、回执、来源范围、取消 / 迟到、备份恢复、投影历史、受控 HTTP 以及生命周期；这些合成检查不代表所有真实来源长期可用、生产服务器部署、私人迁移或三维地图已验收。
