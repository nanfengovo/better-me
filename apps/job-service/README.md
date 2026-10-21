# BetterMe 本机岗位服务

`@better-me/job-service` 提供独立的 TypeScript 本机服务：把受控来源的公开岗位记录保存到 SQLite，以同一套应用工具服务 HTTP 查询和后续 Agent 适配。它不读取浏览器简历、Fact、投递材料、联系人、API Key 或浏览器 profile。

这是岗位地图的本机服务底座，包含 M1 HTTP / 采集能力、M2 repository 层的人工归并与撤销，以及 V3 可撤销地区确认。地区确认已通过共享工具与认证 HTTP 接入 Web；归并已通过七项受审工具、认证HTTP和Web面板接入，包含撤销影响预览与耐久回执恢复。地图、私人机会工作台联动、LangChain / LangGraph Agent、定时刷新及数据迁移需分别验收。原有四平台单岗读取不等于本服务已经实现这些平台的全站搜索。

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
| `--career-search duckduckgo-html\|searxng` | 可选的企业招聘入口搜索，默认关闭；DDG 为实验 HTML 提供方。 |
| `--career-search-endpoint <https-url>` | 仅 SearXNG，填写自己管理的公开 HTTPS JSON 搜索路径，不含凭据／查询参数。 |
| `--help` | 显示帮助，不创建文件、不启动监听。 |

`google-doh` 是可选的显式设置，适用于系统返回 Fake-IP 的环境。它通过固定的 Google DNS HTTPS 端点解析来源主机名，并继续验证返回的是公网地址；不会修改操作系统 DNS 或把保留地址加入允许列表。DNS HTTPS 流量与来源 HTTP 流量共同消耗调用预算，且来源主机名会发送给所选 DNS 服务。Google 端点自身不可达时仍会失败。

运行目录包含 `jobs.sqlite`、SQLite 的 WAL / SHM 辅助文件、私有的 `service.token` 和独占所有权锁 `.job-service.lock/`。日志只显示 token 文件路径。Windows 下应使用仅本人可访问的 NTFS 目录；这些运行文件不应提交到 Git。相同目录已有活跃或不能核实的所有者时，新进程拒绝启动，不会杀进程。确认原进程已退出的旧锁会保留在隔离目录中。取得独占锁后，服务将上次中断的 `running` 任务标为失败，不会暗中恢复采集。

按 `Ctrl+C` 停止服务：停止接受新请求、取消进行中的读取、等候应用任务结束，再关闭 SQLite 和释放本进程的锁。清理未成功完成时会保留数据库与锁，便于核对。

## 网页默认后端

先按上方命令启动服务，再运行 `pnpm --filter @better-me/web dev`。本机网页首次进入岗位地图自动经同源 `/api/atlas` 读取索引，宿主读取默认数据目录的 `service.token`，无需网页输入令牌。顶端显示后端状态，手动直连在高级设置；失败保留真实索引视图并提供重试。读取快照不会自动采集。

网关默认连接 `http://127.0.0.1:5178`，固定以 `http://localhost:5173` 为上游 Origin，所以服务启动参数应包含该 Origin。其他端口或私有数据目录可在**启动 Vite 的终端**设置 `BETTERME_JOB_SERVICE_URL` 与 `BETTERME_JOB_SERVICE_TOKEN_FILE`（绝对路径），再重启 Vite。也可在 Git 忽略的 `apps/web/.env.local` 保存这两项宿主设置，终端变量优先，修改后重启 Vite；不能改用前端 `VITE_*` 或存令牌正文。默认路径不需要配置，Windows 应用隔离路径与普通终端不同时，请采用岗位服务日志中的真实数据目录。

当前 5173 可能由另一个需求的开发终端管理，继续保留该进程。需要重启网页以加载宿主配置时，由原管理终端按 `Ctrl+C`，确认它已退出，再在仓库根目录执行：

```powershell
pnpm --filter @better-me/web dev --host localhost --port 5173 --strictPort
```

`--strictPort` 会在端口仍被占用时直接报错，不会悄悄改到另一个端口。已在运行的岗位服务可继续保留；不要另起同一数据目录或改用空数据目录。私有的 `apps/web/.env.local` 会由网关读取，无需把令牌填进网页。

GitHub Pages／现有 Nginx Docker 镜像是静态版，没有该网关；可显式高级直连本机服务，远程常驻后端仍待部署。`vite preview` 可提供此索引网关，但不提供四平台招聘浏览器 API。详见[默认后端报告](../../docs/reports/job-atlas-default-backend-2026-10-21.md)。

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
| POST | `/api/v1/compensations/review` | `compensations.read-review`；单条薪资来源、当前值及核对历史，只读。 |
| POST | `/api/v1/compensations/preview` | `compensations.preview-review`；逐字段原文依据、版本及预览指纹，不写库。 |
| POST | `/api/v1/compensations/confirm` | `compensations.confirm-review`；明确reviewed及幂等键，追加本人核对。 |
| POST | `/api/v1/compensations/revoke` | `compensations.revoke-review`；明确撤销本人核对，保留历史及回执。 |
| POST | `/api/v1/companies/control-review/read` | `companies.read-control-review`；读取指定岗位／公司的来源、当前值与核对历史。 |
| POST | `/api/v1/companies/control-review/preview` | `companies.preview-control-review`；逐字段原文引用与版本预览，不联网、不写库。 |
| POST | `/api/v1/companies/control-review/confirm` | `companies.confirm-control-review`；明确本人审核、预览指纹及幂等键，追加控股核对。 |
| POST | `/api/v1/companies/control-review/revoke` | `companies.revoke-control-review`；明确撤销本人的指定核对，保留历史和回执。 |
| POST | `/api/v1/jobs/search` | `jobs.search`；直接传共享 `JobQuery`。 |
| GET | `/api/v1/jobs/:jobId` | `jobs.read-detail`；旧 ID 按本次快照解析到规范岗位，返回公司、全部来源、观察与 JD 快照。 |
| POST | `/api/v1/jobs/reviewed-cards/preview` | `jobs.preview-reviewed-cards`；校验本人核对的四平台卡片、索引版本和字段证据，返回预览指纹，不联网、不写库。 |
| POST | `/api/v1/jobs/reviewed-cards/import` | `jobs.import-reviewed-cards`；完整预览输入加 `previewFingerprint`、`reviewed: true`，并提供 `Idempotency-Key`，原子写入卡片摘录。 |
| POST | `/api/v1/locations/geocode-candidates` | `locations.geocode-candidates`；离线城市参考点候选，仅查询，需本人明确选择。 |
| POST | `/api/v1/locations/map-references` | `locations.map-references`；`expectedRevision`、可选 `locationIds`／`limit`，只读独立城市分布参考，最多 1,000 地点。 |
| POST | `/api/v1/locations/confirmations/preview` | `locations.preview-confirmation`；本人结构化地区选择的只读预览，返回原始 / 当前 / 拟保存地点及指纹。 |
| POST | `/api/v1/locations/confirmations` | `locations.confirm`；完整预览输入加 `previewFingerprint`、`reviewed: true` 和 `Idempotency-Key`，追加地区确认并保存有效投影。 |
| POST | `/api/v1/locations/confirmations/revoke` | `locations.revoke-confirmation`；`{ jobId, locationId, decisionId, expectedRevision, reason, reviewed: true }`，追加撤销并恢复上一有效选择或来源地点。 |
| GET | `/api/v1/sources` | `sources.list`；已保存来源及当前安装的适配器能力。 |
| POST | `/api/v1/sources` | `sources.register`；`{ source, expectedRevision? }`，修改既有配置需版本号。 |
| POST | `/api/v1/sources/:sourceId/preview` | `sources.preview`；`{ scope?, maxRecords? }`，读取一页，不写岗位索引。 |
| POST | `/api/v1/sources/:sourceId/sync` | `sources.sync`；`{ scope?, maxRecords?, maxPages? }`，受限手动刷新。 |
| POST | `/api/v1/sources/:sourceId/scan-progress` | `sources.read-scan-progress`；`{ runId? }`，只读当前身份保存的扫描进度，不联网，不需幂等键。 |
| POST | `/api/v1/sources/:sourceId/continue-sync` | `sources.continue-sync`；`{ fromRunId, expectedProgressVersion, maxRecords?, maxPages? }`，显式继续原范围，需要幂等键。 |
| GET | `/api/v1/companies/discovery-capabilities` | `companies.discovery-capabilities`；仅读取配置投影，不联网探测或返回端点。 |
| POST | `/api/v1/companies/discover-careers` | `companies.discover-careers`；`{ sourceId?, request }`，仅企业名可省略 sourceId，明确官网／seed 必须指定已审核策略。 |
| POST | `/api/v1/sources/discover` | `sources.discover`；`{ sourceId, request }`，发现待审核来源候选。 |
| POST | `/api/v1/sources/inspect` | `sources.inspect`；`{ sourceId, request }`，有限抽样检查。 |
| POST | `/api/v1/sources/propose` | `sources.propose`；直接传提案输入，只生成禁用配置。 |
| GET | `/api/v1/runs` | `runs.list`；持久刷新任务。 |
| GET | `/api/v1/runs/:runId` | `runs.read`；任务状态与数字摘要。 |
| POST | `/api/v1/runs/:runId/cancel` | `runs.cancel`；JSON `{}`，取消当前身份的任务。 |
| POST | `/api/v1/dataset/import` | `jobs.import-public`；`{ dataset, expectedRevision? }`，严格公共快照。 |
| GET | `/api/v1/dataset/export` | `jobs.export-public`；仅公共领域快照。 |
| GET | `/api/v1/leads` | `leads.list`；线索与招聘批次，独立于正式岗位计数。 |

`scope` 为 `{ "roles": [], "regions": [], "companyNames": [], "countryCodes": ["CN"] }`；`countryCodes` 可省略；整个 `scope` 省略时，roles／regions／companyNames 均为空数组。上游是否支持这些过滤条件由适配器能力和返回的 `coverage.appliedFilters` / `ignoredFilters` 说明。应用另做本地包含匹配，因此“关注范围内刷新”不代表上游已经提供全站搜索或只下载匹配记录。

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

## 分批扫描与显式续读

`sources.sync` 保持从头刷新的语义，每个新请求建立新的扫描并永久失效该来源之前的扫描位置。有限预算用完后，要读取清单后面的候选，使用 `sources.continue-sync`；反复执行新 sync 仍会从清单前部开始。继续扫描继承原扫描的关键词、地区、企业与明确国家条件，仅可调整本批 `maxRecords`／`maxPages`，不能提供新的 `scope`、上游 cursor、执行身份或访问端点。

工具输入包含 `sourceId`；HTTP 已由路径提供，因此 body 中不重复此字段。`sources.read-scan-progress` 返回 `{ sourceId, progress }`，没有当前进度时 `progress` 为 null。进度包含 `scanId`、当前拥有位置的 `runId`、版本 `version`、原 `scope`、`state`、`running`、`canContinue`、累计 `attemptedRecords`／`pages`、`hadErrors` 和更新时间，不暴露私有 cursor。累计尝试包含失败及明确重读，不等于唯一岗位数或关键词命中数。可选 `runId` 是精确查询：位置已由后续 run 接管时返回 null，不返回另一个 run 的进度。

| 进度状态 | 含义与后续操作 |
| --- | --- |
| `ready` | 保存了下一页位置；任务结束后可显式继续。 |
| `retry-page` | 上一页未完整读取，保存该页起点；任务结束后可显式重读并按既有身份去重。 |
| `exhausted` | 适配器明确报告该次受审清单完整且无下一页，不表示覆盖全市场。 |
| `truncated` | 部分覆盖且没有可继续的位置；不能当作已读完，需核对来源／适配器后另行从头刷新。 |
| `invalidated` | 原位置已永久失效，需另行从头刷新；原因包括配置变化、新扫描或来源清单变化。 |

`canContinue` 仅在任务已结束且状态为 `ready`／`retry-page` 时为 true。继续请求对来源、原 run、身份、进度版本及配置执行原子核对，陈旧版本或并发重复认领被拒绝。每批仍受来源最小刷新间隔、记录／页数上限、每分钟请求数、可信宿主请求／字节／时间预算及取消控制；不会因继续而自动放宽或循环读取全部页面。

以下沿用前面示例的本机 API 与已审核来源。先只读进度，再明确提交一批；同一批重试保留相同 body 和 `Idempotency-Key`，新的批次另用新键：

```powershell
$progressResponse = Invoke-RestMethod -Method Post -Uri "$jobApi/api/v1/sources/my-reviewed-source/scan-progress" -Headers $jobHeaders -ContentType "application/json" -Body '{}'
$scan = $progressResponse.value.progress
if ($null -eq $scan -or -not $scan.canContinue) { throw "当前没有可以继续的扫描，请先核对进度。" }
$continueBody = @{
  fromRunId = $scan.runId
  expectedProgressVersion = $scan.version
  maxRecords = 6
  maxPages = 1
} | ConvertTo-Json -Depth 20
$continueHeaders = @{ Authorization = "Bearer $jobServiceToken"; "Idempotency-Key" = "my-reviewed-source-continue-001" }
Invoke-RestMethod -Method Post -Uri "$jobApi/api/v1/sources/my-reviewed-source/continue-sync" -Headers $continueHeaders -ContentType "application/json" -Body $continueBody
```

JSON-LD 详情超时会保留已读取记录，并明确标记 `retryCurrentPage: true`，不推进到下一页；从第一页超时也保留该页起点。显式继续会重读原页，重复观察沿用既有去重规则。其他适配器返回 partial 且无下一页、又没有明确重读标记时，进度为 `truncated`，不能假定可恢复或已扫描完。JSON-LD 后续读取会重新核对清单队列指纹；次序或内容变化使旧位置永久失效，不能把旧偏移应用到新队列。来源配置 A→B→A 也不会复活旧扫描。

每页的岗位投影、发现线索、扫描 checkpoint、任务统计和耐久页面回执在同一 SQLite 事务提交。取消等待不撤回已提交页面。响应未知时使用原请求／幂等键核对原 run，不换键自动重写；同键恢复不再次请求来源，运行中的原任务仍报告 running。可信终态回执已收到后，索引或进度读取失败只重读。工具缓存的旧成功回执可包含当时进度，当前位置应另读 `scan-progress`。实现及有限验证见[来源续读报告](../../docs/reports/job-atlas-scan-continuation-2026-10-22.md)。

## SmartRecruiters 企业官网来源

服务默认安装 `smartrecruiters@1`，`GET /api/v1/sources` 返回其 `list-jobs` 与 `remoteFilters: ["roles"]`。它是可配置的企业招聘系统适配器，每个来源固定一个已审核的 `companyIdentifier`，全部列表与详情继续经过既有受控GET transport、DNS／端点策略、请求／字节／超时预算、取消和来源刷新间隔：

```text
GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings
GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings/{postingId}
```

配置Schema位于 [smartrecruiters-contracts.ts](../../packages/source-adapters/src/smartrecruiters-contracts.ts)。`companyIdentifier` 必填；`companyName` 为可选后备名称，优先保留来源实际名称；`countryCode` 为可选的显式固定国家范围。`pageSize` 为1—100，默认20；`fetchDetails` 默认false；`maxDetailRequestsPerPage` 为1—10，默认2。来源JSON不能指定其他API主机、执行代码或任意请求方法。

关键词以 `q` 发送，多项关注词分别查询，游标绑定来源、配置和本地查询条件；结果可能重复，不能把多词总量相加当唯一岗位数。**上游q只取候选，本地实际文本才决定关键词命中**。请求的地区／公司条件未送上游，仍按共享匹配器核对；配置的 `countryCode` 不代替逐岗国家证据。未读要求且正文尚未命中的候选保持unknown，不当确定不匹配，也不写入本次关注范围的统一索引。

显式开启详情后，只访问同租户、同岗位ID的详情；在满足地区／公司条件的候选中，先为关键词已命中但缺链接的记录获取原链，再补读关键词仍未确认的候选，返回保持列表顺序。职责／资格不截断，缺少章节或包含未支持正文章节时保留摘录；每页详情额度不等于整页已读全。详情超时保留已有且有有效原链的记录，并停止后续详情／分页；429、认证失败、取消和预算错误保持明确。返回的coverage和warning说明分页、额度及未读取范围。

真实列表可能没有原站`postingUrl`。合法租户／岗位ID但缺链接的记录先在内存保留，允许在有界详情中取得同租户、同ID详情提供的真实原链；链接须通过原站主机和岗位身份校验，保留准确slug。最终仍无有效原链的候选排除、覆盖标为partial，不从ID或标题合成URL；列表或详情明确给出非法链接时拒绝相应数据。详情省略URL时可以沿用已经验证的列表原链。

源`releasedDate`保存为发布时间原文和可解析的带时区时间，可能是重新发布，不称首次发布。读取时间、`active`标记不能代替独立在招核验。API经纬度常为城市中心，本适配器不写为办公坐标；不推断控股方、薪资或远程资格。

[来源目录](../../config/sources/catalog.json)含默认禁用／待审核的Bosch中国预设 `reviewed-bosch-china-official`，固定`BoschGroup`／CN，每页20条、开启详情且每页最多2次。使用前核对原站和条款，再明确添加／启用；添加只保存配置，仍须手动预览或刷新。`companies.discover-careers`可以识别careers／jobs两种SmartRecruiters入口，保留静态官网锚点证据并给出禁用提案；提案同样建议`fetchDetails: true`及每页最多2次详情，Schema默认值仍为false。共享ATS主机不证明企业归属，提案不自动注册或抓岗。

2026-10-19原主界面有限验收：Bosch`.NET`／CN预览首次超时、手动重试后fetched4，返回2条有链候选、确认匹配1条、完整详情2/4；明确sync为partial并新增1条。总库从50岗／revision27，经添加配置revision28，变为51岗／revision29；12项配置中10项可抓取。国内`.NET`全国为3条文本命中／3家企业，江苏→苏州市仅Bosch1条，保留`Suzhou, Jiangsu, China`且无办公室坐标；[原岗位](https://jobs.smartrecruiters.com/BoschGroup/744000140377569--net-bci)新标签的标题／ID／JD实际核对成功。最终恢复全球`C#`14条文本命中／9企业；**本批没有增加C#命中，不能把.NET与C#混算**。

有限实站、隔离检查和发布状态见[本批报告](../../docs/reports/job-atlas-smartrecruiters-2026-10-19.md)。这次成功不保证每次网络读取或所有租户均可用。该协议不提供全市场搜索，也不增加51JOB／BOSS／猎聘／LinkedIn的访问权限；静态Pages和Docker仍需连接独立运行的本机服务。

## 用户核对的四平台卡片

`jobs.preview-reviewed-cards` 和 `jobs.import-reviewed-cards` 为 51JOB、BOSS 直聘、猎聘、LinkedIn 共用的独立应用工具，Web 审核面板和 HTTP 复用同一实现。它们接受用户提供并明确核对的证据，不认证受管浏览器捕获，不访问原站，也不证明岗位仍在招；四个平台的契约支持不等于四站真实列表均已通过验收。

预览输入为 `{ provider, pageUrl, capturedAt, cards, expectedRevision }`，`provider` 为 `51job | boss | liepin | linkedin`。每次 1–50 张卡片，单张必须有 `platform`、官方 HTTPS 单岗 `url`、`title`、`company`、`cardText` 和 `evidence`；`locationText`、`salaryText`、`publicationText` 可省略。`evidence` 必须含同一搜索页的 `pageUrl`、卡片 `cardSelector` 和逐字段 `{ field, selector, text }`。所有提交字段都必须有相同可见值的证据，非链接字段还必须实际出现在卡片原文中。严格契约定义见 [reviewed-cards.ts](../../packages/source-adapters/src/reviewed-cards.ts)。

校验只接受匹配平台的官方搜索页 / 稳定单岗 ID 和明确字段；不接受任意数据集、坐标、企业控股结论、核实状态、来源端点策略或额外 CSS / 执行代码。抓取时间不能比服务时间超前超过 5 分钟，旧于该 listing 最近观察的卡片会被拒绝。预览基于当前 `expectedRevision`，返回 `previewFingerprint`、保留的岗位 / listing ID、新旧标志、`completeness: "excerpt"`、`availability: "unknown"` 和警告。

导入必须重交同一份预览输入，并增加返回的 `previewFingerprint` 和 `reviewed: true`；`Idempotency-Key` 必填。当前 revision 或内容变化时需要重新预览，不能把旧指纹应用于新内容。导入通过主机计算的完整命令指纹和 SQLite 耐久回执恢复丢失响应：同键同内容可在索引已前进或服务重启后重放原回执，同键不同内容返回冲突，不重新投影新版本。关闭客户端或取消等待不能回滚已提交事务。

每个平台使用保留来源 `reviewed-platform-<provider>`，标明原平台和“人工核对卡片”，配置禁用、无同步能力和网络访问权限；已有同 ID 来源定义不一致时拒绝写入。稳定身份由平台和原单岗 ID 确定，跟踪 URL 或 LinkedIn 标题 slug 不产生新岗位。同一捕获的所选子集或顺序不改变已有卡片观察身份；变化的原文追加新观察。标题标为 parser / unverified，真正的人工覆盖继续受保护；摘要快照单独保留，不替换已选完整 JD。

地点保留原文且 `kind: "unknown"`，不从平台、搜索地区或地名推断国家 / 行政区 / 办公室或地图坐标。因此这类记录可通过全球关键词和地点原文检索，但在有结构化国家 / 国内省市区条件时可能被排除。薪资不推断原币、数值、周期或税制；发布时间仅在原文已是显式带时区的合法时间戳时映射为时间，相对时间和无时区原文保留，活跃 / 更新时间不当发布时间。缺失字段、在招状态、企业控股和完整职责要求均保持未知。

Web 使用步骤见[本机岗位地图说明](../../docs/job-atlas.md#核对卡片并加入统一搜索)，实现与验证范围见[审核入库报告](../../docs/reports/job-atlas-reviewed-cards-2026-10-19.md)。本机服务提供审核入库 API；原站卡片读取仍属于本机 Vite 浏览器宿主，静态 Pages / Docker 不会因此获得浏览器控制能力。

## 本人确认的国家与省市区

`locations.preview-confirmation`、`locations.confirm` 和 `locations.revoke-confirmation` 使用 [location-confirmation.ts](../../packages/opportunities/src/location-confirmation.ts) 的共同 Schema，Web 与未来 Agent 执行器调用同一组工具。预览输入示例：

```json
{
  "jobId": "existing-job-id",
  "locationId": "existing-source-location-id",
  "expectedRevision": 24,
  "proposal": {
    "locationKind": "unknown",
    "countryCode": "CN",
    "area": {
      "kind": "china-catalog",
      "provinceCode": "31",
      "cityCode": "3101",
      "districtCode": "310115"
    }
  },
  "reason": "本人对照岗位原文核对工作地区"
}
```

示例 ID 和 revision 必须替换为当前索引实际值；选择地区不等于确认办公性质，`locationKind` 可为 `office | remote-region | unknown`。`china-catalog` 的名称、父子关系、版本和省域标识由服务从固定目录解析，不接受客户端自带的可信名称或坐标。目录为2023年统计快照；直辖市使用实际名称，镇街 / 功能区不冒充法定区县。海外或仅国家的选择可使用 `{ "kind": "manual-area", "region": "…", "city": "…", "district": "…" }`，各文本字段可省略，国家须属于项目目录。

预览返回 `{ expectedRevision, previewFingerprint, jobId, locationId, original, current, proposed, activeDecisionId?, warnings }`。提交确认须重交完整原预览输入，并增加 `previewFingerprint`、`reviewed: true`。预览指纹绑定输入、原始地点及服务解析的范围；陈旧 revision、错误归属或无效目录路径拒绝写入。写入成功返回 `{ ok: true, revision, jobId, locationId, decisionId, activeDecisionId?, location }`。客户端应保留原请求和幂等键恢复丢失回执，不能自行改变旧请求的 revision。

地区决议只修改有效地区投影，原地点 `raw` 和来源 `evidence` 完整保留；`userResolution` 标明本人确认的决议、时间和目录 / 手动依据，`verification` 保持 `unverified`。国内和地区筛选使用有效结构化字段，避免旧原文同时匹配已纠正地区；岗位文本检索仍能查原文。地区确认不生成办公室坐标，且清除有效投影中的原坐标；全部撤销后恢复来源地点，包括原坐标。精度最多为城市，选择区县也不升级为街道 / 地址精度。城市候选查询继续只用于临时浏览，尚未保存为地区决议。

同一来源地点刷新保持确认，地点内容变更生成新 ID 后不迁移旧确认。决议绑定单一来源地点贡献，岗位归并 / 撤销归并后不转给其他来源。没有来源观察证据或旧数据共享同一地点、归属不能唯一确定时拒绝写入。撤销要求目标执行身份和明确核对，历史保持不可变；可恢复上一未撤销选择。实际有限验证和 UI 操作见[地区确认报告](../../docs/reports/job-atlas-location-confirmation-2026-10-19.md)。

## 查询与数据边界

查询契约来自 [`@better-me/opportunities`](../../packages/opportunities/README.md)，支持模糊 / 精确关键词、国内 / 全球 / 海外范围、企业与有证据的控股来源分类、来源、地区、工作方式、状态、人民币税前年薪和距离筛选，以及稳定分页和全量地图桶。

国内省市筛选的英文文本别名由共用 [text-aliases.json](../../config/geography/china-administrative/text-aliases.json)配置：现有31个大陆省级节点与有限10个城市，绑定固定行政目录及父省。它只扩展文本核对，保留原地点且不生成坐标；`Suzhou`须结合江苏／安徽等父省证据消歧，单独同名英文不归到苏州或宿州。国家和各级地区仍须匹配同一地点，不把有限别名表描述为完整地名解析服务。

家庭坐标、配色与别名覆盖可由可信 host 注入 `QueryOptions`；生产 `jobs.search` 的汇率和计算日期固定使用仓库同事务捕获的选择，宿主提供的其他FX／日期会被覆盖。参考汇率可经工具显式读取并核对后保存，默认不自动启用。CLI不保存家庭住址；未注入坐标时不能完成距离查询，未具备薪资比较证据时保留原文／原币和未知状态，不补造工资、税制、奖金或控股国别。

SQLite 持久保存来源、公司、岗位、位置、薪资、来源 listing、观察、JD 快照、线索、任务与事务回执。刷新使用增量合并，不清空既有库；同源稳定记录保持 ID，内容变化追加不可变观察与按内容去重的快照；缺失字段不会无依据删除旧信息，未在列表出现也不会被当成已关闭。相同 listing 突然更换雇主会拒绝写入，等待人工核对。当前不会自动把不同来源的同名岗位合并。

来源列表拉取时间、岗位原始发布时间 / 更新时间、记录再次出现时间、明确在招核验时间保持分离。HTTP 200、列表出现、GitHub 最近更新和活动线索均不是独立的当前在招核验。招聘活动、缺雇主记录及目录线索存入独立 leads，不计入规范岗位数量。

数据库已建立 FTS5 和 RTree，但 **当前业务查询仍读取完整一致性快照并执行共享查询逻辑**。`candidateIds()` 的 `indexedHits` 仅为诊断，真实候选返回全部岗位的 `safe-superset`，避免漏掉模糊词、中文、未知位置或远程岗位。写入当前会重建辅助索引；还未完成查询下推或大规模性能验收，不能把“已有索引表”表述为已完成高性能搜索。

## 人工跨源归并：repository 接口

数据库 schema v2 增加原始岗位投影 `base_jobs`、不可变决策、当前 / 历史岗位别名及岗位版本高水位。已有 schema v1 SQLite 文件会在事务中升级，保留岗位 ID、来源、观察和 JD。以下接口可由可信应用代码调用，下节列出当前受审工具／HTTP；底层接口由可信应用代码调用。

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
| `readProjectionSnapshot()` | 各来源的原始岗位、地点与 listing 归属，供 `projectSourcePage()` 和来源导入使用；保留当前全局 revision，不混入本地地区确认。 |

`writeOptions` 必须包含 `{ expectedRevision, actorScope, idempotencyKey }`。人工决策、规范投影、索引、别名历史、受影响来源任务失效和耐久回执在同一事务提交；陈旧 revision 拒绝写入，同键同输入可以在重启后重放。已有 `jobId` 和 `snapshotId` 保留，私人收藏 / 投递无需被归并代码改写。

合并保留所有 listing、不可变观察和 JD、薪资、位置及字段冲突。规范岗位按最近一次有效合并所选目标来源提供标量摘要；来源刷新仍更新各自原始投影，未选中来源的新标题或 JD 不静默取代人工摘要来源。撤销合并恢复各自最新投影。多源地点和薪资保留为集合，查询继续按共享规则报告歧义；不会默认采用最高工资或把冲突状态当已核实。

现有 application 已接通归并兼容：**来源刷新从 `readProjectionSnapshot()` 调用 `projectSourcePage()`**，查询与公共导出继续使用 `readSnapshot()`。详情先捕获公共快照，再以其 revision 调用 `resolveJobId()`，避免合并 / 撤销发生在异步读取间时混用不同版本。归并操作已通过受审工具、认证HTTP及Web显式预览确认接入，repository继续保持一致投影。候选发现与投影尚未做规模优化，测试通过不代表大量来源下的吞吐结论。

## 来源薪资核对

四项 `compensations.*-review` 工具共用严格Schema和认证HTTP，网页同源网关仅代理固定端点。逐字段引用同一原岗位已存观察／正文，不以平台惯例代替原文依据；确认需明确审核及原版本／指纹，撤销保留历史。SQLite V5以来源底账和仅追加决议生成有效薪资，先于跨源归并应用；相关岗位版本随变化更新。来源变化永久失效旧核对，A→B→A不复活。

本人核对保持待核实，不改JD／来源原文／地点适用范围，不自动取得雇主认证。耐久回执支持原body／key恢复；保存成功后的读取失败只重读。外币保留原币，带出处的FX快照可独立管理，详见下节；网页默认不估算缺失保证月份。详见 [薪资核对报告](../../docs/reports/job-atlas-compensation-review-2026-10-21.md)。

## 一致性、备份与部署

写入、版本号和耐久幂等回执在同一个 SQLite 事务内提交。取消、同源新任务和来源配置变更使用代次校验，迟到结果不能覆盖新任务。进程内工具结果缓存不等于这些耐久回执；涉及外部网络的读取本身也不具备事务回滚。

`GET /api/v1/dataset/export` 是公共领域交换格式，包含当前有效地区及其本人确认标记，以及当前有效企业核对实际引用的独立企业目录材料；不包含任务、回执、leads、归并／地点／公司原始投影或完整决策历史，不能当作完整仓库备份。已合并的公共投影不能重新覆盖原始岗位，普通公共导入也不能伪造 `userResolution`、企业 `controlReview` 或专用补证记录；必须使用完整备份保留拆分、地区及企业核对的撤销能力。

仓库层提供 `repository.backup()` / `repository.restore(backup, { expectedRevision, actorScope, idempotencyKey })`：当前源码 schema V8 的完整备份包含公共数据、任务、回执、线索、原始岗位、归并决策、别名历史、岗位版本计数，以及 `baseLocations`、`locationDecisions`、办公确认历史、`baseCompensations` 与 `compensationDecisions`、`fxSnapshots` 原文与 `fxActivations` 选择历史、`baseCompanies` 和全部 `companyControlDecisions` 原文／决议，新增私有 `sourceScans` 扫描事件及关联页面回执。仍接受符合各自规则且不删除目标已有历史的 V1–V7 备份；V7→V8 增加 `source_scan_events`、索引及不可变触发器，空扫描历史的升级本身不应改变原有数据或全局 revision。实际服务须完成完整备份与隔离迁移验证后才能使用新版接口，不能只刷新页面。

`/healthz` 仅报告进程状态与 `apiVersion: 1`；公共 dataset 的 `schemaVersion: 1` 也不是 SQLite 版本。只读检查数据库版本应使用 Node `DatabaseSync` 的 `{ readOnly: true }` 打开明确选定文件，查询 `PRAGMA user_version` 后关闭；不能使用 `openJobRepository()` 做只读健康检查，它会自动执行 schema 迁移。已经升级的 V8 数据库拒绝由 V7 及以前代码打开；需要回滚时先保留新库及完整历史，再在原管理终端安排恢复升级前完整备份，不能直接覆盖正在运行的数据库或丢弃升级后的写入。

恢复先校验内容哈希、领域引用、决策引用 / 身份 / 先后关系、可信目录解析、当前别名及有效投影，再重放地区与归并历史；地点回执还需与其当时版本和岗位归属一致。V8 另核对扫描事件版本链、原范围／来源指纹、run／身份绑定、累计统计与原子页面回执；不能通过旧备份删除目标已有扫描事件、相关 run 和精确命令回执，或消除失效记录、复活已消费的位置。伪造或冲突会被拒绝，现库保留。通过后原子替换，运行中任务恢复为已取消并保留已提交统计。完整备份含私有 cursor，应保存在专用私有目录。当前没有 HTTP 恢复路由或 CLI 备份 / 恢复命令；集成方应通过可信应用代码调用，不应在服务运行时只复制主 SQLite 文件而遗漏 WAL。

GitHub Pages 与现有 nginx Docker 镜像仍然只发布静态网页。本包参与工作区检查 / 编译，不会自动运行在静态容器或 Pages 上。当前 HTTP 只允许本机回环并使用单一 `local-owner` 身份；服务器部署需另行实现服务器身份认证、授权与部署运行配置，不能直接把监听地址改为公网使用。

## 开发验证

从仓库根目录执行：

```powershell
pnpm --filter @better-me/job-service typecheck
pnpm --filter @better-me/job-service test
```

审核卡片专项见 `tests/reviewed-cards.test.ts` 和 `tests/reviewed-cards-http.test.ts`：覆盖预览零写入、未知字段、旧捕获 / 来源冲突拒绝、重开后的幂等回执、同键不同内容冲突、卡片子集顺序去重，以及实际认证 HTTP 的预览 → 导入 → 重放 → 搜索 / 详情 / 导出。`tests/projection-repository.test.ts` 进一步验证 parser 标题可按新核对更新、真正人工覆盖受保护、卡片摘录不取代完整 JD。对应 Web 审核流程和固定等待宽限测试属于独立前端 / 浏览器宿主验收。

地区确认专项见 `tests/location-confirmation.test.ts`：预览不写入、国家 / 省市区实际过滤、原文证据不变、同源刷新 / 新地址、归并 / 拆分、服务重开耐久回执、撤销恢复坐标、追加表 UPDATE / DELETE 保护、SQL 故障整笔回滚、V2→V3迁移与V3备份重放，及篡改目录、投影或其他现存岗位回执的拒绝。Web 单独覆盖明确确认、级联选择、重试与迟到响应隔离；本机真实地点另做有限验证，不由合成测试外推。

SmartRecruiters专项见`packages/source-adapters/tests/smartrecruiters.test.ts`和本包`tests/smartrecruiters-integration.test.ts`：定向协议检查及临时SQLite上的默认注册→预览→同步→搜索／详情，覆盖全列表缺`postingUrl`后同ID详情补链、有界读取、正文命中、无关／无链／未读候选不入索引、准确slug及来源时间保留，不写API城市坐标。官网发现、目录和Web接线另有独立回归；国内英文地名与工作台专项分别12项和29项通过。本批20文件隔离产品源码树完整1965/1965、types10/10、lint及build6/6通过，随后Docker两行新增JSON复制／白名单的最终22文件树容器复验275次HTTP已通过，产品三批已正常推送，远端CI与部署按报告另核；最终状态以[本批报告](../../docs/reports/job-atlas-smartrecruiters-2026-10-19.md)为准。

仓库根 `pnpm test` 和 `pnpm lint` 已包含本包。自动化覆盖临时目录中的真实 SQLite 事务、重开、回执、来源范围、取消 / 迟到、备份恢复、投影历史、受控 HTTP 以及生命周期。`tests/reconciliation.test.ts` 还覆盖同名不自动归并、人工身份确认、嵌套合并 / 独立撤销、源刷新后拆回最新 JD / 地点 / 薪资、旧 ID 历史解析、实际 SQL 写入故障整笔回滚、完整备份及持久 v1 SQLite 升级。`tests/application-reconciliation.test.ts` 进一步通过实际 HTTP 验证合并后刷新、旧 ID 详情、规范搜索 / 导出和撤销最新来源，并覆盖 v1 升级后应用兼容及读取期间并发合并 / 撤销的快照一致性。历史 M2 范围见[归并报告](../../docs/reports/job-atlas-m2-reconciliation-2026-10-18.md)，V3 地区范围见[地区确认报告](../../docs/reports/job-atlas-location-confirmation-2026-10-19.md)。这些合成检查不代表所有真实来源长期可用、生产服务器部署、私人迁移或三维地图已验收。

本批后续全局C#手动刷新已到61岗／revision33、24个文本命中／13企业：Arbeitnow新增3、Temporal新增7，仍有400条要求未读全和间隔／超时边界。最终产品`32186f7`远端四任务已success；测试就绪等待修复`1209042`另有独立1965项回归，最新运行按[本批报告](../../docs/reports/job-atlas-smartrecruiters-2026-10-19.md)核对。公共程序发布不上传本机数据。

## Ashby 结构化字段与真实范围

`ashby@1`继续访问配置的公共Posting API，读取明确嵌套／扁平postal address，主次地点分别保留；纯Remote的结构化地区通过既有投影成为remote-region，不产生办公室坐标。国家只规范化明确国家字段，复用有限别名并补India，不从城市或币种猜国家。Salary／Bonus／Commission／EquityCashValue分开映射，百分比和未知类型不进入货币金额，税制保持unknown；多tier不重复summary envelope、不猜locationIds。

本批仅6文件冻结树`a3c7c6d9509b4710a3ba7908195f3140c21a0f6a`，1975/1975、types10/10、lint和build6/6；功能`8c8d347`远端质量／Linux／Docker／Pages均success。独立服务真实读取Temporal70条并按C#入库7条，原61岗／revision33服务未更新（自动审批拒绝重启）；新增字段需获准更新后按原来源间隔读取，不缩短3600秒、不清空刷新记录。完整证据及局限见[Ashby字段报告](../../docs/reports/job-atlas-ashby-fields-2026-10-19.md)。

## 完整岗位详情与国内采集停点

`jobs.read-detail`／`GET /api/v1/jobs/:jobId`返回`snapshotRevision`、`job`、`company`、`locations`、`compensations`、`listings`、`observations`、`snapshots`、`sources`。单次读取快照，并按其版本解析旧岗位ID；地点和薪资仅包含当前岗位引用，不混入其他岗位或旧记录。缺字段为空数组，沿用严格公共Schema和read-index权限，没有新采集或私人材料读取。

功能`3a56bc6`的3文件冻结树86f43dc4经离线冻结安装、独立job-service135/135、仓库types10/10及lint通过，远端四任务success。原服务已实际返回新增字段；85岗／revision59、dataset及token哈希在本轮受控更新前后一致。严格国内C#26／22企业、全球48／33企业；平台卡片与逐项地区确认仍不等于完整JD、核实在招或办公定位。详见[本轮报告](../../docs/reports/job-atlas-domestic-source-expansion-2026-10-19.md)。

## 已接入的归并工具与 HTTP

岗位地图的“重复岗位核对”复用以下严格工具，执行身份／effect／预算由可信宿主提供。`candidates`和`history`输入默认limit50、最多100；`preview`绑定目标／来源、expectedRevision、reason和companyIdentityConfirmed，返回同版本双边公开详情、冲突及指纹。`merge`／`reject`必须提交同一input、previewFingerprint、reviewed:true及Idempotency-Key。

| 工具 | POST /api/v1/jobs/reconciliation/ 路径 |
| --- | --- |
| jobs.list-merge-candidates | candidates |
| jobs.preview-merge | preview |
| jobs.merge | merge |
| jobs.reject-merge | reject |
| jobs.list-merge-decisions | history |
| jobs.preview-revoke-merge | preview-revoke |
| jobs.revoke-merge | revoke |

撤销先用decisionId／expectedRevision／reason预览实际before／after相关组，再提交同一输入、指纹与reviewed。只允许原执行身份撤销。完整命令哈希进入SQLite耐久签名；原键回执查找早于当前revision和预览验证，服务重启也能取回旧请求。工具运行时的可信只读恢复回调解决提交后超时／取消／输出失败的旧错误缓存，不重新执行写入；没有回执保留原错误。

有限候选内部最多枚举10000对、生成1000候选，返回不超过100；false或空列表不能证明全库无重复。共享协议不开放客户端自封verified的requisitionLinks。见[实施与验收](../../docs/reports/job-atlas-reconciliation-2026-10-19.md)。

## 可选企业招聘入口网页搜索

服务默认不配置网页搜索。需要时在原启动命令追加 `--career-search searxng --career-search-endpoint https://search.your-domain.com/search`，使用自己管理且允许 JSON 查询的公开 HTTPS 实例；当前不支持本机 HTTP、IP、私网、API Key 或自动补路径。也可显式使用 `--career-search duckduckgo-html` 试用实验 HTML 适配；它不是官方搜索 API，需核对提供方条款，可能遇验证、限流或结构变化。启动不联网，服务不轮换公共实例或自动切提供方。

Web 展开“来源工具 → 企业官网招聘”后才读配置，点击发现才搜索。仅名先匹配已登记来源，无匹配时使用已配置提供方；搜索结果不自动访问、登记或启用。每次一页、最多20条、2 MiB解析上限，受既有transport／DNS／请求预算，始终partial；搜索线索数与实际官网读取页数分开。具体岗位仍须核对ATS配置后另行预览／同步。普通HTML入口无通用岗位解析器，不能直接启用抓岗。

显式官网／seed使用独立的`discovery-policy@1`访问策略，只声明`discover-sources`，无岗位读取能力。[默认禁用示例](../../config/sources/company-career-discovery.example.json)需先替换精确官网主机／路径，再明确设enabled:true和status:active，通过来源JSON检查、勾选核对、显式保存；更新既有配置还需expectedRevision。它可以用于企业官网／GitHub来源发现，不能用于sources.preview或sources.sync，也不计作可搜索岗位来源。策略自身不会命中为企业招聘源，同名／同域仍执行实际官网读取；其他来源的既有匹配语义保留。

本轮当前代码真实Grafana查询收到DDG202挑战，正确needs-auth并停止；已保存Siemens真实HTML重放10条仅证明解析，不称实时成功。配置／接口／测试和实证见[通用搜索报告](../../docs/reports/job-atlas-career-web-search-2026-10-19.md)。

## 独立城市分布参考

`locations.map-references` 从同版本地点的明确国家与完整城市名，在已分发的离线地名数据内唯一匹配；返回城市估算、出处、完整地点指纹与实际处理范围，不写库、不核实办公地址、不计算离家距离。`jobs.search` 可传 `mapCityReferences: true` 使用同一工具，结果另含城市参考与地图可见并集统计，既有 `mappedJobs` 仍只计来源坐标。每批最多 1,000 地点，超出明确 `truncated`；未知、冲突与远程资格不填造坐标。Web 的双击城市定位、版本／取消隔离及验证边界见[城市参考报告](../../docs/reports/job-atlas-city-references-2026-10-19.md)。


## 通用 JobPosting JSON-LD 来源

已安装 `jobposting-jsonld@1`，复用 `sources.register`、`sources.preview`、`sources.sync`、`jobs.search` 和 `jobs.read-detail`。读取 [JSON 示例](../../config/sources/jobposting-jsonld.example.json)，先核对官网、条款、域名／路径和清单，再显式启用；分发示例与目录均默认禁用待审，不覆盖已登记来源。`options.companyName` 仅供企业招聘入口关联，不会填入缺失的真实雇主。

`enumerationKind` 为 `sitemap-urlset` 或 `html-list`；`enumerationUrls` 为同源1–20个受审地址，`entryUrl` 必须等于第一项；`postingPathPrefixes` 限定岗位路径，`pageSize` 为1–20。可选 `priorityPostingUrls` 仅调整本次真实清单中已有地址的队列次序，不直接造岗位。所有请求仍经过已登记 endpointPolicy、公开DNS、HTTPS、禁止跳转及请求／字节／超时预算；不递归 sitemap index、不猜分页、不执行网站脚本或远程 JSON-LD context。

静态HTML以 parse5 的WHATWG解析读取真实锚点，XML以saxes拒绝DTD／实体／畸形结构；每页2MiB、最多10,000候选URL，节点／深度／JSON脚本另有限额。候选URL数、实际详情请求数、返回记录数和本地匹配数分别计量。游标绑定来源配置、完整关注范围及本次队列；队列变化拒绝旧游标。404或不可用结构标partial，timeout保留成功结果并停止后续详情／续页，401／403／429及安全／预算错误不当空岗位。

角色／地区／国家／企业条件按已读字段本地筛选，无上游搜索承诺。每次新 sync 从有限队首开始；V8 可通过上文的显式续读工具继续保存的位置，不能反复新建 sync 期待自动翻到后部。ABB示例每页3详情、最多2页6个尝试，两个优先样本不等于搜遍ABB。缺雇主只保留线索，FULL_TIME不推定社招；date-only保留raw而不补午夜，薪资仅原文不进入可比税前年薪，城市geo不成为办公室或距离。国家只从明确country字段匹配共享249项ISO白名单及Node/ICU英中名称、有限既有别名，未知保留原文。

企业搜索可关联已登记同名源；陌生企业仍需官网线索／已配置宿主搜索与另行审核，不能据零命中认定官网无岗位。源码编译后仍需保留根目录 `config/geography/countries.json`；现有仓库与Docker构建布局已包含它。静态Pages／Docker网页需连接独立本机服务，并不内置这个采集后台。实测与限制见[官网结构化来源报告](../../docs/reports/job-atlas-jsonld-sources-2026-10-19.md)。

## 办公地址核对与可选地址提供方

默认关闭外部地址查询；需要时在原启动命令末尾增加`--office-geocoder nominatim`，保留原data-dir／port／Origin／DNS配置。它只安装提供方，不启动批量请求；网页必须输入具体query并点击查询。固定Nominatim HTTPS、最多5候选、至少1.1秒门控、15分钟有限进程缓存，尊重Retry-After，不自动重试、自动补全或扫描索引。署名／OSM记录随候选返回。国内覆盖由地图数据决定。后续按宿主已配置Google DoH完成一次公开地标请求，Nominatim HTTP200；真实响应的place/house门牌漏召回已修。但3个候选属于其他城镇，未准确命中目标地标，也没有证明岗位办公关联；必须核对完整地址后再明确保存。旧system探针失败原因仍未知。实证与验证见[本批报告](../../docs/reports/job-atlas-office-provider-real-2026-10-19.md)。

四项共享工具与认证POST路径如下，执行身份由宿主提供；客户端不能传provider端点、actorScope或任意代码。

| 工具 | /api/v1/locations/office-address/ 路径 |
| --- | --- |
| locations.office-address-candidates | candidates |
| locations.preview-office-confirmation | preview |
| locations.confirm-office-address | confirmations |
| locations.revoke-office-address | revoke |

候选输入为`{jobId,locationId,expectedRevision,query?}`；没有query只返回来源／配置、不外发请求。query只发送明确文本和已知国家过滤，不附带来源正文、家庭位置或owner。`proposal`固定为`basis:manual-user-confirmation`、countryCode、formattedAddress、streetAddress、可选postalCode、WGS84 coordinates、evidenceUrl和`coordinateMeaning:building|entrance|site`。预览与确认共用job／location／版本／proposal／reason；确认还需previewFingerprint、reviewed:true及Idempotency-Key。撤销提交原decisionId、expectedRevision、reason、reviewed:true及Idempotency-Key。

SQLite V4保留base地点、行政决议、办公确认／撤销／source失效事件和耐久回执。来源地点或证据一度变化后旧办公点不会在A→B→A时自动激活。公共快照导入拒绝本地overlay；完整备份恢复包含历史。保存仍待核实，不把GCJ02当WGS84、城市／道路候选当门牌、地图候选当雇主认证。超时使用原body／key核对回执，已保存后读快照失败只重读。详见[本批报告](../../docs/reports/job-atlas-desktop-office-address-2026-10-19.md)。

`locations.office-address-candidates`可显式传`locality`（≤200字符）和`postalCode`（≤100字符），二者必须与`query`同传；无query仍只读配置。宿主不会隐式发送来源城市或邮编。有约束时Nominatim使用structured查询并严格核对实际市级字段及邮编；州县不当市、未知或不符拒绝，缓存按全部约束隔离。不猜翻译、门牌或办公关联。详见[桌面与精度报告](../../docs/reports/job-atlas-desktop-precision-2026-10-19.md)。

## 逐岗地址规划与来源地点补充

`jobs.plan-address-enrichment` / `POST /api/v1/jobs/address-enrichment/plan` 是认证只读工具，输入 `{ "jobIds": ["当前规范岗位ID"], "expectedRevision": 67 }`。示例ID和版本须替换为真实值；最多50个唯一ID，空数组明确处理0岗，无幂等写入key、不联网、不写索引。响应绑定相同版本与岗位集合，逐岗包含currentOffice、pendingLocationIds、sourceStreetTargets、exactPlatformTargets、ownedOfficialTargets和弱companyLookup。宿主使用实际已安装Registry确认官网协议能力，不能根据source版本猜可执行能力。

四平台原岗详情的受审地点使用 `jobs.preview-detail-locations` / `jobs.import-detail-locations`，HTTP对应 `/api/v1/jobs/detail-locations/preview` 与 `/api/v1/jobs/detail-locations/import`。要求同provider/岗位ID/URL和可重解析原JSON-LD证据，绑定当前listing、版本与预览指纹；导入需明确reviewed和幂等键，仅更新该listing地点贡献，保留正文、薪资和其他来源，不自动生成坐标。同捕获重放no-op，旧捕获不复活旧地点；位置变化按V4规则失效旧确认。

Web逐岗外读、官网发现、地址候选、来源保存与办公坐标确认分别调用现有工具；官网同岗位线索仅供核对，候选需本人确认。只读计划不是爬取/补全回执，单个办公点不代表所有地点已覆盖。详见[办公地点与性能报告](../../docs/reports/job-atlas-detail-address-review-2026-10-19.md)。

### 可见地址V2与来源搬迁

原JSON-LD `PlatformDetailLocations.version:1`保持兼容，新增`version:2` Liepin可见地址证据。`selector:liepin-work-address[n]`与quote中的`{selector:"liepin-work-address",label:"工作地址"|"工作地点",text}`必须逐项规范重放；V1拒绝此分支，V2不混合JSON-LD与可见数组，坐标字段禁止。native projector/caller才开启可见sidecar，不把普通`requireVisibleDescription`视为证明；URL/provider/同岗/时间/预览版本检查保持。

工具层只将selector/quote映射到领域evidence，完整capture保存在观察rawText，避免wire-only kind污染严格domain。来源原文无行政字段时不会自动继承，地点精度保持unknown。只补来源的street字段不代表已取得办公坐标；明确远程或非本岗位地址的可见披露拒绝。源刷新在同label明确街道/邮编冲突时换新location身份，搬迁后稀疏刷新跟随当前贡献，不拼旧值；V4在同revision持久失效旧office。验证及限制见[可见地址与换址报告](../../docs/reports/job-atlas-visible-office-evidence-2026-10-19.md)。


## 官网原岗地点工具

`jobs.read-owned-detail-locations`、`jobs.preview-owned-detail-locations`、`jobs.import-owned-detail-locations` 对应认证 POST `/api/v1/jobs/owned-detail-locations/read|preview|import`。按索引原岗位／listing／版本定位目标；JSON-LD 与 SmartRecruiters 具备实际精确 reader，其他协议保持线索能力。保存必须审核并提供幂等键，只替换原 listing 地点贡献，不改变 JD／薪资／企业或生成坐标。签名 capture、版本和来源指纹、读取顺序及耐久回执防止陈旧覆盖，详见[精确读取报告](../../docs/reports/job-atlas-owned-detail-locations-2026-10-21.md)。

## 参考汇率与查询上下文

参考汇率管理使用 `fx.fetch-reference`／`fx.read-state`／`fx.preview-import`／`fx.confirm-import`／`fx.activate` 五项共享工具，分别对应 `/api/v1/fx/reference`、`state`、`preview`、`import`、`activate` 的认证 POST。默认公开参考源由宿主安装，只有明确点击读取才请求网络；保存与启用仍须另外核对。SQLite V6 完整备份保留原文快照、选择历史及回执，旧版本代码不能直接打开 V6 数据库。使用与换算边界见[汇率说明](../../docs/reports/job-atlas-fx-context-2026-10-21.md)。

## 企业最终控股证据核对

四项 `companies.*-control-review` 工具使用上表的认证 POST 路径；网页同源网关只开放固定路由，由宿主管理令牌。读取／预览是 `read-index`，确认／撤销是 `local-write`；均不联网，不自动访问填写的出处 URL 或抓取企业信息。

读取输入为 `{ jobId, companyId, expectedRevision }`。预览增加 `proposal`、`reason`；确认重交相同输入并增加 `previewFingerprint`、`reviewed: true` 和 `Idempotency-Key`。撤销输入为 `{ jobId, companyId, decisionId, expectedRevision, reason, reviewed: true }`，同样需要幂等键。执行身份与预算来自可信宿主，不能在请求中自封。

`proposal.basis` 固定为 `manual-evidence-review`；`documents` 保留实际 `sourceUrl`、`retrievedAt` 和 `rawText`。`supports` 以 `field`、`documentIndex`、`quote` 及可选 `controllerIndex` 引用原句。实际雇主法定名称、可选母公司关系、状态与控制模式均有字段引用；每个控制方另需名称、性质、`controllerControl` 实际最终控制关系，以及填写时的来源国别引用。最多10份材料、20个控制方，原文单份256 KiB／合计1 MiB UTF-8字节；确认和恢复从原文计算SHA-256并拒绝未来读取／决议。

`resolved` 配合 `single`／`joint`／`dispersed` 区分单一、共同及无实际控制人；后者不创建控制方名称或控股来源国家。`unknown`／`conflicting` 可以保存核对历史，但保持未分类。有效公司附 `controlReview` 本人核对标记，手工 `verified` 不代表发布机构认证；原句存在也不表示系统自动验证了法律含义。不能用品牌、注册地或母公司名称猜控制国别。

核对绑定现有岗位与确切公司，作用同 `companyId` 岗位，不按同名合并企业；决议归档当时的 `affectedJobIds`，新岗位不会改变旧回执。普通标题／JD／薪资更新、新增别名或同公司岗位保留有效核对；实际雇主身份、原控制字段、相关覆盖及绑定证据变化追加永久失效事件，A→B→A不复活。有效核对优先于旧控制方覆盖，原覆盖正文保留。

V7的确认／撤销／失效决议与有效公司投影、相关岗位版本及回执原子提交。完整备份保留全部原文；公开数据集仅追加每公司最新有效核对实际引用的禁用 `company-directory` 来源／listing／observation，不挂入任何岗位的 `listingIds`、不创建JD或增加岗位数。撤销或失效的材料继续由历史读取／完整备份保留，避免每次地图查询复制全部旧原文。专用命名空间、来源证据、历史回执和有效投影须能严格重建；恢复不得丢弃目标库已有企业核对历史。

提交后响应未知时使用原body／幂等键恢复耐久回执；可信回执已收到而索引读取失败时只重读。网页内存恢复屏障覆盖关闭面板、切换视图与工作区重挂，整页刷新／浏览器关闭不保证保留前端请求。后端回执持续保存，但恢复原命令仍需原输入和键。

2026-10-22 本切片32文件独立树已通过2742/2742、types10／Lint／build6；合成浏览器940px中文浅色保存1→2、390px英文深色撤销2→3及认证HTTP通过。完整备份及隔离克隆后，真实5178已升级V7，原40表、dataset、token与五组查询保持，89岗rev85／0控股核对。产品b67463d及文档1b22e47的Windows质量、Linux构建、Docker与Pages四项均成功，远端2742/2742，公开6资源200；后续发布状态以[main工作流](https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml?query=branch%3Amain)为准。原5173进程保留，宿主重启沿用上方“网页默认后端”的严格端口命令。完整范围与后续结果见[企业控股核对报告](../../docs/reports/job-atlas-company-control-review-2026-10-22.md)。
