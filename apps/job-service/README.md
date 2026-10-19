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

家庭坐标、汇率快照、配色与别名覆盖是可信 host 注入的 `QueryOptions`。当前 CLI 不提供保存家庭住址、自动获取汇率或用户配色面板；未注入坐标时不能完成距离查询，未具备薪资比较证据时保留原文 / 原币和未知状态，不自行补工资、汇率、税制、奖金或控股国别。

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

## 一致性、备份与部署

写入、版本号和耐久幂等回执在同一个 SQLite 事务内提交。取消、同源新任务和来源配置变更使用代次校验，迟到结果不能覆盖新任务。进程内工具结果缓存不等于这些耐久回执；涉及外部网络的读取本身也不具备事务回滚。

`GET /api/v1/dataset/export` 是公共领域交换格式，包含当前有效地区及其本人确认标记，但不包含任务、回执、leads、归并 / 地点原始投影或完整决策历史，不能当作完整仓库备份。已合并的公共投影不能重新覆盖原始岗位，普通公共导入也不能伪造 `userResolution`；必须使用完整备份保留拆分和地区撤销能力。

仓库层提供 `repository.backup()` / `repository.restore(backup, { expectedRevision, actorScope, idempotencyKey })`：当前 schema v3 完整备份包含公共数据、任务、回执、线索、原始岗位、归并决策、别名历史、岗位版本计数，以及 `baseLocations` 与 `locationDecisions`。仍接受符合各自规则的 v1 / v2 仓库备份；已有 SQLite v1 / v2 文件在事务中升级，V2 地点初始化来源基线，不改变现有行或全局 revision。

恢复先校验内容哈希、领域引用、决策引用 / 身份 / 先后关系、可信目录解析、当前别名及有效投影，再重放地区与归并历史；地点回执还需与其当时版本和岗位归属一致。伪造来源地点、目录名称、投影或回执会被拒绝，现库保留。通过后原子替换，运行中任务恢复为已取消。当前没有 HTTP 恢复路由或 CLI 备份 / 恢复命令；集成方应通过可信应用代码调用，不应在服务运行时只复制主 SQLite 文件而遗漏 WAL。

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

角色／地区／国家／企业条件按已读字段本地筛选，无上游搜索承诺。每次新sync从有限队首开始，不提供跨次采集进度；ABB示例每页3详情、最多2页6个尝试，两个优先样本不等于搜遍ABB。缺雇主只保留线索，FULL_TIME不推定社招；date-only保留raw而不补午夜，薪资仅原文不进入可比税前年薪，城市geo不成为办公室或距离。国家只从明确country字段匹配共享249项ISO白名单及Node/ICU英中名称、有限既有别名，未知保留原文。

企业搜索可关联已登记同名源；陌生企业仍需官网线索／已配置宿主搜索与另行审核，不能据零命中认定官网无岗位。源码编译后仍需保留根目录 `config/geography/countries.json`；现有仓库与Docker构建布局已包含它。静态Pages／Docker网页需连接独立本机服务，并不内置这个采集后台。实测与限制见[官网结构化来源报告](../../docs/reports/job-atlas-jsonld-sources-2026-10-19.md)。

## 办公地址核对与可选地址提供方

默认关闭外部地址查询；需要时在原启动命令末尾增加`--office-geocoder nominatim`，保留原data-dir／port／Origin／DNS配置。它只安装提供方，不启动批量请求；网页必须输入具体query并点击查询。固定Nominatim HTTPS、最多5候选、至少1.1秒门控、15分钟有限进程缓存，尊重Retry-After，不自动重试、自动补全或扫描索引。署名／OSM记录随候选返回。国内覆盖由地图数据决定；本轮单次公开地标联网探针未成功，不能将合成端到端验收等同实时地理编码可用。

四项共享工具与认证POST路径如下，执行身份由宿主提供；客户端不能传provider端点、actorScope或任意代码。

| 工具 | /api/v1/locations/office-address/ 路径 |
| --- | --- |
| locations.office-address-candidates | candidates |
| locations.preview-office-confirmation | preview |
| locations.confirm-office-address | confirmations |
| locations.revoke-office-address | revoke |

候选输入为`{jobId,locationId,expectedRevision,query?}`；没有query只返回来源／配置、不外发请求。query只发送明确文本和已知国家过滤，不附带来源正文、家庭位置或owner。`proposal`固定为`basis:manual-user-confirmation`、countryCode、formattedAddress、streetAddress、可选postalCode、WGS84 coordinates、evidenceUrl和`coordinateMeaning:building|entrance|site`。预览与确认共用job／location／版本／proposal／reason；确认还需previewFingerprint、reviewed:true及Idempotency-Key。撤销提交原decisionId、expectedRevision、reason、reviewed:true及Idempotency-Key。

SQLite V4保留base地点、行政决议、办公确认／撤销／source失效事件和耐久回执。来源地点或证据一度变化后旧办公点不会在A→B→A时自动激活。公共快照导入拒绝本地overlay；完整备份恢复包含历史。保存仍待核实，不把GCJ02当WGS84、城市／道路候选当门牌、地图候选当雇主认证。超时使用原body／key核对回执，已保存后读快照失败只重读。详见[本批报告](../../docs/reports/job-atlas-desktop-office-address-2026-10-19.md)。
