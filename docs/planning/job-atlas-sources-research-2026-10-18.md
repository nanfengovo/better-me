# 岗位地图：信息源核验与通用接入设计

调研日期：2026-10-18。本文为方案输入，不代表已经接入新来源、建立全国岗位库或实现地图。只读请求公开 GitHub API / Raw、官方文档及少量公开岗位接口；未执行外部仓库脚本、未使用私人 Cookie、未绕过验证、未批量爬取招聘平台。

整体目标、已确认范围与实施验收见 [架构方案](job-atlas-architecture-2026-10-18.md)；渲染与地理服务证据见 [地图研究](../research/job-atlas-map-references-2026-10-18.md)。

## 结论

应当把「发现信息源」「搜索本地岗位索引」「从某个来源获取列表」「读取原始单岗」「核验当前在招」「补充企业和地址资料」分成独立能力。地图、机会库、简历匹配和未来 Agent 共享同一个岗位与证据层，而不是各自维护爬虫和岗位副本。

不能依赖某个旧爬虫项目直接实现全球搜索。公开 ATS 适合按已知公司 board 获取当前发布岗位；GitHub 清单适合发现线索；51job / Boss / 猎聘 / LinkedIn 等平台继续复用现有单岗读取和人工接续能力，搜索能力逐源声明。列表中存在一个链接，不等于该岗位已被原页核验，也不等于具备薪资、精确坐标或公司最终控制方信息。

## 用户提供的项目

下列 GitHub 元数据和树均在调研时实际读取。`pushed_at` 指仓库代码推送时间；`updated_at` 会随仓库其他活动变化，不能作为数据新鲜度。

| 项目 | 实际定位与时效 | 可用字段 / 缺项 | 建议用途 |
| --- | --- | --- | --- |
| [Hopetree/Jobs-search](https://github.com/Hopetree/Jobs-search) | Python / Scrapy 的 51job、智联、拉勾旧爬虫合集；最后 `pushed_at=2017-07-31`；固定快照 `818eadfe519a83afda03629f098e8615f51b9097` | 旧 Item 有岗位 URL、名称、薪资文本、公司、城市、地址、学历、经验、描述、发布日期等；不包含现代平台稳定接口、跨源去重或企业最终控制国。根目录未发现 LICENSE，API `license=null` | 研究字段和采集分层思路。当前没有执行它，也没有证据证明旧选择器或接口今天可用；不直接复制集成 |
| [xixicc186/xixicc2027](https://github.com/xixicc186/xixicc2027) | 国内校招信息聚合，提供 `jobs.json` 和网页；固定快照 `c0ae9cd36c37c129d8cf21b65ef81ff6ce78466e` | JSON 402 条，字段为 `company/cohort/batch/program/industry/positions/locations/apply_url/official_wechat/qr_image/deadline/campus_only/first_seen/last_seen/confirmed_by`。204 条有地点、121 条有投递 URL，缺薪资、坐标、企业注册及控制国证据。`positions` 经常是方向集合，不能当一条独立精确岗位 | 作为校招活动 / 项目 / 岗位方向的线索源；先建 `recruitmentCampaign`，取得单岗原页后再建 `jobPosting`，避免把活动拆成虚构岗位 |
| [SimplifyJobs](https://github.com/SimplifyJobs) | 组织下有不同年级、年份和季节仓库；不能把组织名称当单一数据接口 | 实际核验 [New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions) 和 [Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships)，默认分支均为 `dev`。New-Grad 固定快照 `7c5c5b5c216f4d3abfe8f1ccd4702c440f9dab55` 的 `.github/scripts/listings.json` 有 19,363 条历史记录、3,020 条 `active=true`，而 README 展示 538 条；两处展示口径或更新时间存在差异，原因及更新器规则待进一步核实 | 优先解析结构化文件，保留原始状态与记录 ID；不能把所有历史记录或 active 标记直接宣称为当前有效岗位。主要面向实习 / 应届科技岗位，不是全行业全球数据库 |
| [CyC2018/Job-Recommend](https://github.com/CyC2018/Job-Recommend) | 公司内推和求职材料目录；最后 `pushed_at=2024-08-19`；固定快照 `c48d713da869bc33b08d4cc03254f70e58f8bc63` | `infos/*.md` 是内推方式、面试流程、岗位介绍、复习指南、公司简介、Q&A，非统一岗位 feed；既有内容中可能含个人联系方式 | 发现公司招聘官网与参考资料，进入候选目录并核验原页；不默认复制联系方式，不当作实时在招岗位源 |

时效差异尤其需要单独建模：xixicc 同一快照 README 写「2026-10-18 00:00 / 共 401 条」，但 `jobs.json` 实际 402 条，记录中最大的 `last_seen` 为 `2026-07-16`。这只证明该快照的文件内容，不能证明源作者真实最近核验时间，也不能把 README 的更新时间自动填入每条岗位的 `lastVerifiedAt`。

Simplify 的结构化字段包括 `source/category/company_name/company_url/id/title/active/date_posted/date_updated/url/locations/is_visible/sponsorship/degrees`；没有通用薪资和公司国籍字段。`sponsorship` 是签证支持信息，不是企业国别。

上述四个用户指定项目的根目录树均未发现 LICENSE，GitHub API 均返回 `license=null`。可研究和引用链接；若要直接复用代码或打包再分发内容，需先核实作者许可和第三方数据规则。GitHub 官方说明：[Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。文档或代码的许可证也不自动覆盖它链接到的企业招聘内容。

## 更多实际来源：按接入方式归类

### 公司 ATS 公开职位接口

| 来源 | 官方依据与实际探测 | 适合的能力 / 限制 |
| --- | --- | --- |
| Greenhouse | [Job Board API](https://docs.greenhouse.io/job-board.html) 明确所有 GET 不需认证；有限 GET [Duolingo board](https://boards-api.greenhouse.io/v1/boards/duolingo/jobs?content=false) 返回 HTTP 200 / 63 条。样本有 `id/title/company_name/location/updated_at/first_published/application_deadline/absolute_url` | 按 board 拉列表、读取单岗；正文需 `content=true`，薪资透明信息按官方单岗参数取得且并非必有。地点经常是文本；不是所有公司跨 board 的全球全文搜索接口 |
| Lever | [官方 Postings API](https://github.com/lever/postings-api)；有限 GET [leverdemo](https://api.lever.co/v0/postings/leverdemo?mode=json&limit=1) 返回 HTTP 200 / 1 条，实际含 `salaryRange={min:85000,max:175000,currency:USD,interval:per-year-salary}`、`country=US`、`workplaceType=hybrid` 和多地点类别 | 列表 / 单岗、部分结构化薪资与地点。官方明确不提供全文检索；不能假设任意前端域可 CORS 直连。`country` 是岗位地点国家 / 地区，不是公司控制方国籍 |
| Ashby | [Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)；有限 GET [Linear board](https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true) 返回 HTTP 200 / 29 条 | `jobUrl/applyUrl/publishedAt/primary+secondaryLocations/address/workplaceType/descriptionPlain/compensation`；可请求薪酬，仍可能为空。实际样本地点为 `Europe` / `European Union` 且远程，不能伪造某城市坐标或当地通勤距离 |
| SmartRecruiters | [官方 Posting API](https://developers.smartrecruiters.com/docs/posting-api) 描述自定义搜索、过滤和地图；[Markdown 文档](https://developers.smartrecruiters.com/docs/posting-api.md) 更新时间 2026-08-24，涉及 API Key / OAuth 与 scope | 保留为需逐租户核验的可配置适配器候选。匿名示例 endpoint 虽 HTTP 200 但返回空列表，因此本轮不承诺「无 Key 可用且已有岗位」，也未读取内部岗位 |

获取公开 board 不等于取得全公司名录。公司 board slug、官网与别名应来自独立公司目录、用户添加和经审核的发现结果。现有 BetterMe 已有 Greenhouse / Lever / 腾讯来源，可提炼为这层能力，避免新建一套重复采集代码。

### 授权聚合 API、远程岗位与政府源

| 来源 | 官方依据 / 已核实能力 | 配置和使用要点 |
| --- | --- | --- |
| Remotive | [公开 Remote Jobs API 文档](https://github.com/remotive-com/remote-jobs-api)；描述当前 active 岗位、关键词 / 类别等过滤、`candidate_required_location`、可选薪资文本 | 数据延迟 24 小时；要求显著标注 Remotive 并链接回它给出的 URL；建议最多 4 次 / 天，超过 2 次 / 分钟会被阻止；明确限制向其他第三方招聘站转发以及通过岗位收集注册。是否适用于未来公开聚合服务需按最终用途核实，不能写成无限制免费镜像 |
| Arbeitnow | [官方 API 说明](https://www.arbeitnow.com/blog/job-board-api)；有限 GET [德国岗位 API](https://www.arbeitnow.com/api/job-board-api) 返回 HTTP 200，当前响应 `data` 300 条，另有 `links/meta`；官方还列 [英国 API](https://www.arbeitnow.co.uk/api/job-board-api) | 字段 `slug/company_name/title/description/remote/url/tags/job_types/location/created_at`，实际响应无薪资字段。适合德国 / 英国与远程、签证线索，不能把薪资未知当 0，也不能据德国招聘站推断企业都是德国外企。分页应读返回链接，英国入口本轮仅文档核实，未逐岗探测 |
| USAJobs | [Search API](https://developer.usajobs.gov/api-reference/get-api-search)、[认证说明](https://developer.usajobs.gov/guides/authentication)；官方响应文档包含 `PositionLocation` 经纬度、`PositionRemuneration` 最低 / 最高 / 周期、组织、发布日期、截止时间和申请资格 | 需申请 API Key 并按官方要求提供请求头；未使用真实 Key 发查询。适合美国公共部门岗位，不代表都对海外申请人开放；国籍 / 资格限制应独立可筛选。当前试探 terms-of-service URL 返回错误页，因此条款待复核，不能宣称已审核通过 |
| Adzuna | [官方 API overview](https://developer.adzuna.com/overview) 描述岗位搜索、地区与薪资趋势，需注册 `app_id/app_key` | 作为多市场搜索的可选付费 / 配额适配器候选；本轮没有 Key、没有完成真实岗位查询，也不承诺当前免费额度、覆盖国家或长期可用 |

### 招聘官网的结构化数据、RSS 与 Sitemap

新增通用 `jobposting-jsonld`、`rss-atom`、`sitemap-discovery` 等适配器族。不是从任意 HTML 一把梭提取：先识别站点、允许的路径和抓取规则，再从 JSON-LD / RSS 获取明确字段，复杂动态页面使用站点适配器或现有人工浏览器读取。

[Google JobPosting 官方结构化数据说明](https://developers.google.com/search/docs/appearance/structured-data/job-posting) 已核实包含 `title/description/hiringOrganization/datePosted/validThrough/jobLocation/baseSalary/jobLocationType/applicantLocationRequirements`。它是企业网页常见的结构化约定，不是 Google Jobs 对外批量搜索 API；字段由网站发布者提供，还需保留来源和解析证据。远程资格地区与办公室地址分别保存。

### 可发现的 GitHub 清单与数据目录

不应把用户给出的仓库数组写死在应用组件中。可通过 [GitHub Repository Search API](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-repositories) 按语言、主题、更新时间、年份 / 招聘方向和文件线索发现候选源，再读取仓库 metadata / tree，判断是否有 JSON / CSV / Markdown、LICENSE、更新程序和来源说明。未认证搜索配额有限，官方当前说明为 10 次 / 分钟；认证 code search 另需身份，不能假设前端匿名通用全文代码搜索可用。

本轮实际以 `2027 internships in:name,description pushed:>=2026-09-01` 等查询发现额外候选：

- [ApplyGuy/2027-Internships](https://github.com/ApplyGuy/2027-Internships)：API 元数据标记 MIT，README 链接 `data/internships.json`，声称美国 SWE / 产品实习、15 分钟刷新，并链接 [New Grad 仓库](https://github.com/ApplyGuy/2027-New-Grad-Jobs)。本轮仅核实 README 与元数据，未验证其所有岗位的真实性或第三方内容使用权。
- [DereC4/internships-and-newgrad](https://github.com/DereC4/internships-and-newgrad)：API 元数据标记 MIT，README 是多来源聚合、公司 / 职位 / 地点 / Age 表，存在中转链接与原始 ATS 链接。表内统计和「去重」是上游自述，不直接作为本项目验收。
- [liangok/JobFind-data](https://github.com/liangok/JobFind-data)：README 声明仅保留当前招聘快照、无个人档案和应用源码，API 未识别许可证。适合下一步审核数据结构和来源，不能仅凭仓库说明自动启用。

这些只是本次动态发现的种子，并非最终白名单。自动发现产物先进入 `candidate / needs-review`；不自动运行陌生仓库脚本、Skill 或浏览器安装命令，不把外部岗位正文里的指令交给 Agent 执行。

## 推荐的可配置 Source Registry

Registry 保存数据；复杂协议和解析器由经过测试的 TypeScript adapter 实现。新增同协议公司、ATS board、JSON feed 或 GitHub 文件，主要增加登记配置；新增认证协议 / 数据结构才增加 adapter。不能承诺只配一份任意 JSON 就能适配所有招聘网站。

建议登记字段：

| 领域 | 建议字段 |
| --- | --- |
| 身份和版本 | `sourceId/schemaVersion/displayName/adapterId/adapterVersion/kind/status`；`kind=platform/ats/company/feed/github/aggregator/government/manual` |
| 能力 | `capabilities={discoverSources,searchRemote,listJobs,readDetail,verifyStatus,deltaSync}`；标明 query 的关键词 / 地区 / 薪资等远程过滤能力及 unsupported 项 |
| 端点与安全边界 | 允许的域、端口和路径模板，board 参数 schema、分页模式、重定向策略、最大响应大小；不要任由模型提供 URL 后服务器全权请求 |
| 运行方式 | `runtime=browser/local-service/server`、认证类型与 secret reference、登录 / 人工验证能力；Key 不进公开配置和静态镜像 |
| 字段与质量 | `entityType=jobPosting/recruitmentCampaign/companyDirectory`、mapping profile、语言、币种 / 时间单位、record ID 规则、必需字段、样本 fixture 和缺项策略 |
| 刷新与费用 | TTL、最小刷新间隔、并发 / 请求 / 字节预算、增量 cursor、ETag / Last-Modified、429 / Retry-After、已知配额和费用模式 |
| 范围与完整性 | 请求 / 实际完成的公司、国家 / 地区、关键词、页数、条数，剩余 cursor、`truncated/partial/failedSources` 与停止原因；达到预算时必须显示部分结果，未出现在部分结果中的旧岗位不能直接改成关闭 |
| 来源与使用 | `publisherName/discoveryName/attributionLabel/attributionUrl/termsUrl/licenseStatus/usePolicy/reviewedAt`；例如 Remotive 回链不能在去重中丢失 |
| 健康状态 | 最后尝试 / 成功 / 模式变更时间、连续失败、部分结果、解析漂移、需要登录 / 验证 / 授权原因；不要用失败抓取覆盖上次成功结果 |

任务按来源能力路由。全球模糊检索主要查统一索引；只支持 `listJobs` 的 ATS 在预算内刷新索引，不假装接受全文搜索。对尚无稳定远程搜索能力的平台，提供「去原站搜索 → 读取所选岗位」路径，并在来源面板如实显示。

## 共享规范化模型和联动

建议域模型至少有 `Company`、`JobPosting`、`RecruitmentCampaign`、`SourceRecord`、`Evidence`、`SourceDefinition`、`SyncRun`。不要把来源 URL、地点、公司类型、工资和描述塞进一个不可比较的字符串。

- `JobPosting` 是归并后的岗位实体；`SourceRecord` 是某来源所观察到的版本。一个岗位可有公司官网、Boss、GitHub 清单等多个来源，去重后仍保存全部来源链。优先由同一官方岗位 ID / 规范化原始 URL 确认，同名公司和相似标题只产生待核对候选，不能直接合并不同城市、级别或班次。
- 每次记录 `feedFetchedAt`、`recordLastSeenAt`、`sourcePublishedAt`、`sourceUpdatedAt`、`detailFetchedAt`、`availabilityVerifiedAt` 及核验方法。HTTP 200、列表出现、详情明确在招属于不同证据，关闭 / 过期 / 待核验状态独立存在。
- 薪资保留原文、币种、周期、税前 / 税后、最低 / 最高、明确薪数 / 工时及提取证据。排序单位和汇率日期可配置；缺少薪数时不擅自补成 13 薪，跨币种转换显示估算和假设。未知薪资在正反排序中均单独放置，不等于 0。
- `locations[]` 区分实体办公室、可选城市、远程可申请范围；保存原始地址、标准国家 / 地区 / 行政区、坐标与坐标系、地理编码来源、精度和置信度。城市质心只能标成城市级，不能显示成精确办公点。无法定位的岗位仍留在列表 / 未定位计数，不填虚构坐标。
- `Company` 分开法人、品牌、母公司、总部、注册地、最终控制方和性质证据。Greenhouse / Lever 的岗位 `country`、ATS 域名、公司英文名或招聘所在地都不能自动证明「美国外企 / 德国外企」。母公司可多方控制、合资或不明；香港应作为国家 / 地区字段和用户的展示分组策略处理，不能以颜色规则改写事实。
- 来源标签、原链接、观察日期应在地图 tooltip、列表卡、详情与导出中始终可见。去重显示「公司官网 · 另有 2 个来源」并可展开，不以企业颜色替代来源标识。
- 收藏或选择地图岗位时，关联同一个机会 ID；岗位核验 / 状态变化回到机会库和材料快照。简历匹配沿用现有 Fact 防编造边界；企业 / 岗位证据不能自动写成用户经历。

## Agent 工具边界

先定义 TypeScript + Zod 的独立领域服务和 JSON 可序列化输入 / 输出；LangChain `tool()` 或 LangGraph 节点随后只包装这些服务，避免把主要业务逻辑写在 prompt、Graph 节点或 React 组件里。

候选工具：`sources.list`、`sources.discoverCandidates`、`sources.previewBatch`、`sources.sync`、`jobs.search`、`jobs.readDetail`、`jobs.verifyAvailability`、`companies.resolve`、`locations.geocode`、`opportunities.save`、`resumes.matchJob`。每项声明只读 / 外部请求 / 本地写入、预算、超时、取消、幂等 key、分页、证据输出和 typed error；来源正文只当不可信数据。

例如 LangGraph 可以编排「发现 → 拉取 → 规范化 → 归并候选 → 企业 / 地点补充 → 用户确认收藏 → 匹配」，但不绕过字段证据、来源速率限制和既有投递人工边界。`jobs.search` 必须返回本轮检索范围、索引更新时间与不支持的过滤条件，不能以地图视觉暗示覆盖全市场。

## 与已确认范围衔接

本轮随后已确认运行口径为「本机自用、用户手动选择范围刷新」，不建立持续全球汇聚的共享服务。Registry 与同步工具仍需要请求预算、范围和分页完整性；不创建定时采集。GitHub Pages 保留展示 / 本地数据能力，依赖 Node 或持久浏览器的采集由本地服务承担，避免把服务端 Key 和平台会话打入静态构建。

首批来源、社招 / 校招优先级、企业分组与岗位状态展示口径，以主方案记录的最新用户决议为准，本页不重复提问。无论采用哪种分组，来源层应保留法人 / 母公司 / 最终控制方等独立字段和证据；来源数、已核验数、可定位数分别统计，未核验线索和招聘活动不伪装成已确认在招的精确岗位。

本文仅提供已核验来源事实与设计建议，没有创建采集任务、授权接口凭证或实现新产品代码。
