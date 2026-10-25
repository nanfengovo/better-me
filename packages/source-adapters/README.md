# BetterMe 可配置岗位来源

`@better-me/source-adapters` 把显式安装的来源适配器、版本化 JSON 来源配置、受控网络传输和候选发现分开。适配器输出未核实的公开来源记录，由 [`job-service`](../../apps/job-service/README.md) 统一投影到 [`opportunities`](../opportunities/README.md) 领域；它不访问个人简历、Fact、投递材料或 API Key。

本包使用 Node.js 网络 API，供 Node **24.15.0+ 的 24.x 或 Node 26+** 本机服务使用。现有静态网页不会直接执行这些网络适配器，也不能因为接口存在就声称已实现所有招聘平台的聚合搜索。

## 已安装适配器

| `adapterId` / 版本 | 输入与覆盖 | 输出边界 |
| --- | --- | --- |
| `greenhouse` / `1` | 具体公司的官方公开 board；`options.boardToken`，可配 `companyName`。 | 保留岗位 ID、原链接、正文、地点原文和源时间；受数量限制，不提供 Greenhouse 全站搜索。 |
| `lever` / `1` | 具体公司的 Postings API board；支持 board 内 offset 分页。 | 保留原始地点、工作方式、正文和可用的薪资声明；未披露税制、固定工资组成时不自行补全。演示 board 不是市场数据。 |
| `ashby` / `1` | 具体公司的公开 job-board API。 | 远程资格区域单独保存，不制造办公室坐标；保留薪资原文与源时间。 |
| `remotive` / `1` | Remotive 公共远程岗位 API；最多一次有限 feed 读取，无历史分页。支持单个关键词、单个公司和类别上游过滤，其余本地匹配。 | 要显著标 Remotive 并链接原岗位；feed 延迟 24 小时；禁止转交第三方招聘站或用于收集注册/邮箱线索。保留候选人资格范围，不制造办公室；薪资只留原文。来源配置强制每 UTC 日最多 4 次、每 6 小时最多一次、每分钟最多 2 次。默认待审核、关闭。 |
| `rss-atom` / `1` | 用户审核过的 HTTPS RSS 2.0、RSS 1.0 或 Atom feed；只读取当前有限窗口，不跟随岗位链接。可选 `options.companyName` 和人工核对后的 `options.enumerationComplete: true`。 | 保留 feed 中的稳定 ID、原岗位链接、标题、正文和带明确时区的源时间；不从描述猜地点、坐标、在招状态或控股方。默认按部分覆盖显示，适合接入明确提供公开岗位 feed 的官网。 |
| `tencent` / `1` | 腾讯招聘官网固定 HTTPS Query 端点；`roles` 逐词远程查询、按 OR 分页。 | 默认职责摘录，可显式启用受限 ByPostId 详情补全；保留 `PostId`、原始国家/地点和更新时间，上游关键词仍需本地筛选。 |
| `workday-cxs` / `1` | 已安装 Workday CXS JSON POST 协议；来源配置固定一个经审核的租户和站点，`roles` 逐词检索并按偏移分页。 | 搜索只发匿名 JSON 到租户固定的 CXS 列表端点；最多尝试每页 10 条同 ID 详情。保留原招聘 URL、地点/日期原文和详情字段证据；无薪资、街址或坐标时不推算。列表截短、详情失败、服务限额或不一致分页会明确标 partial 并保留已有岗位；超时停止续页。JLL China 目录默认禁用／待审核，使用许可需人工核对。 |
| `jobposting-jsonld` / `1` | 经审核的静态岗位清单：叶子 sitemap、有限 sitemap index 或静态 HTML 链接；只读取同源岗位页面中的 JobPosting JSON-LD。 | sitemap index 只读取一个审核过的根索引，最多读取配置上限的同源 HTTPS 叶子 sitemap；跨源链接、嵌套 sitemap index、动态脚本和缺少 JSON-LD 的页面会被跳过并保持 partial。sitemap `loc` 只是候选页面，不是已核实岗位或市场总数。 |
| `mapped-json` / `1` | `entryUrl` 指定的 JSON 列表及有限字段路径映射；可显式配置来源返回的数字页码续读。 | 默认 `discoveryOnly: true`；人工审核后才可配置为岗位记录。不能运行源仓库代码或自定义 JS。 |
| `github-json` / `1` | `raw.githubusercontent.com` 的具体 JSON 文件，使用相同有限映射。 | 强制 `discovery-lead`；不能用配置将目录、多个方向或招聘批次变成已核实单岗。 |
| `github-markdown` / `1` | 一个经过人工审核的 `raw.githubusercontent.com` Markdown/HTML 文件；只解析有限的表格列（公司、岗位、地点、原岗位链接、源日期）。 | 强制 `discovery-lead`；保留 Raw 文件字段证据和稳定原岗位链接，跳过无链接行并合并重复链接。不能把清单当作当前在招、精确办公室、薪资、控股方或全网覆盖；不会读取仓库代码、执行 HTML/JavaScript 或跟随表格中的岗位链接。默认应关闭并保持 `needs-review`。 |

腾讯适配器声明 `remoteFilters: ["roles"]`，将关注关键词分别传给官网；多个词各自分页，保留 OR，不合计可能重叠的上游总数。`regions` 和 `companyNames` 不发给该端点，明确报告为上游未执行，再由应用层匹配。Remotive 对单个岗位关键词与单个公司名使用官方查询参数；多个兴趣不会被拼接成改变 OR 语义的单个字符串，改由本地匹配。`rss-atom` 也不声明上游筛选，feed 中没有明确字段的条件继续由本地匹配。其余来源按具体 board / feed 列举。51JOB、BOSS、猎聘和 LinkedIn 仍保留既有单岗读取，同时 Web 本机宿主已提供受控的当前搜索页卡片读取；平台列表捕获不属于这些来源适配器本身，也不等于平台全量覆盖。

Remotive 仅提供有限、延迟的 active remote feed，没有可承诺全市场或完整历史覆盖的分页。官方要求醒目标注 Remotive 并保留原岗位链接，禁止转交第三方招聘网站或利用岗位列表收集 signup / email 线索；catalog 配置默认关闭待审核。候选资格字段 `candidate_required_location` 单独保存，绝不成为工作地址、办公室坐标或距离筛选依据。薪资与无时区的发布时间保留原文，不推断币种、周期、税前税后或 UTC 时刻。官方建议每日最多读取4次、每分钟不超过2次；来源配置分别硬限制 UTC 日4次、6小时最短间隔和每分钟2次。SQLite 任务启动事务负责原子计数，同一任务幂等回放不重复计数，已经启动的失败／取消请求仍占一次额度。

腾讯配置只允许固定 `careers.tencent.com` 主机、语言枚举和受限 `pageSize`，不能指定任意请求 URL。搜索参数通过 `URLSearchParams` 编码，例如 `C#` 为 `keyword=C%23`；游标绑定来源、配置与查询词，跨页保持相同 pageSize，并受 host 的请求/字节/时间/页数/记录预算约束。官网可能将带符号的技术关键词作宽泛匹配；`Count` 只表示该端点返回的总数，不能直接作为准确的 C# 等技术岗位数量。

Workday 的公开岗位 URL 使用 `/{site}`，而 API 路由使用 `/wday/cxs/{tenant}/{site}`，这两个固定路径分别核对；来源 JSON 不能提供任意请求地址、请求方法或公司名覆盖。POST 仅接受有界 JSON 对象，由受控传输继续执行 HTTPS、已审核主机／路径、公网 DNS pinning、速率／字节／请求预算和取消；POST 绝不跟随重定向。详情必须同时核对来源岗位 ID、tenant site、同一个原始岗位 URL 与响应 URL。多个关注词逐词发送，OR 关系及可能的重复岗位由稳定来源身份去重；超过一页时只输出请求额度内的记录。

分页游标绑定来源、站点、搜索条件及除宿主临时记录额度外的刷新策略，因而可在服务逐页消耗同一总记录预算时继续；配置或关注范围改变会使旧游标失效。雇主／地区原文缺失的列表行可以进入每页受限的详情核对候选，若已有字段明确冲突则跳过；最终岗位仍按共享严格匹配器判断，未读详情保留为未知。401／403等认证或访问限制会停止当前来源读取并报告错误，不伪装成普通详情缺失。来源目录的 JLL China 只做有限只读核验，不代表所有 Workday 租户可访问；工作地点、发布日期、在招状态只按官方披露保存，仍须核对具体使用条款。

腾讯记录采用 `PostId`，不会把可能分组复用的 `RecruitPostId` 当单岗 ID。仅接受匹配该 ID 的官网详情链接，或明确允许的腾讯官方 Workday HTTPS 详情链接。`CountryName` 明确为“中国”才写入 `CN`，海外国家保留原文，不猜国家代码、城市坐标、薪资或控股方。`LastUpdateTime` 作为更新时间原文；`DateCreated` 语义尚未核实，只保留证据，不写发布时间。`IsValid` 也不等于独立在招核验，availability 保持 `unknown`。

腾讯 `options.fetchDetails` 默认 `false`，`maxDetailRequestsPerPage` 默认 2、允许 1–10。启用后，端点策略还必须明确允许精确 `/tencentcareer/api/post/ByPostId` 路径；适配器按列表 `PostId` 串行读取受限数量的详情，核对返回身份后合并职责、要求、团队/部门介绍，并分别记录详情 URL 与字段证据。全部请求共享同一个预算、速率窗口、取消和超时；不跟随 Workday 或其他页面链接。只有同时读取有效职责与要求才标 `detail`，失败或未覆盖候选保持摘录与 partial。尤其当关键词只在任职要求中出现时，未补全的摘录不能作为完整无命中的结论。

## 配置与注册

来源配置由 `@better-me/opportunities` 的 `SourceDefinitionSchema` 校验，包含稳定 `sourceId`、适配器 ID / 版本、实际能力、运行环境、实体类型、状态、端点策略、归属说明和刷新限制。没有可执行模块路径、shell 命令、CSS 或任意解析代码。

[`config/sources/examples.json`](../../config/sources/examples.json)提供多个结构不同的示例，全部默认 `enabled: false`、`status: "needs-review"`。示例不会在启动时自动下载；应核对当前来源条款、授权范围、链接、稳定岗位身份与请求范围后，由用户显式注册和启用。GitHub 等目录配置的领域类型为 `company-directory`，注册器将它匹配到适配器的 `discovery-lead` 输出。

有限 JSON 映射示意：

```json
{
  "recordsPath": "data.jobs",
  "idPath": "id",
  "titlePath": "title",
  "urlPath": "url",
  "companyPath": "company.name",
  "descriptionPath": "description",
  "locationsPath": "locations",
  "salaryTextPath": "salary",
  "publishedPath": "published_at",
  "updatedPath": "updated_at",
  "discoveryOnly": true
}
```

GitHub Markdown 清单使用独立的固定列适配器，不接受 CSS selector、正则或执行代码。一个待审核的配置形状如下：

```json
{
  "sourceId": "reviewed-github-job-list",
  "name": "Reviewed GitHub job list",
  "adapterId": "github-markdown",
  "adapterVersion": "1",
  "capabilities": ["list-jobs"],
  "runtime": ["local-service"],
  "entityType": "company-directory",
  "enabled": false,
  "status": "needs-review",
  "entryUrl": "https://raw.githubusercontent.com/OWNER/REPOSITORY/REF/README.md",
  "options": {
    "tableIndex": 0,
    "titleHeader": "Title",
    "urlHeader": "Application",
    "enumerationComplete": false
  },
  "remoteFilters": [],
  "endpointPolicy": {
    "allowedHosts": ["raw.githubusercontent.com"],
    "allowedPathPrefixes": ["/OWNER/REPOSITORY/REF/README.md"],
    "requireHttps": true,
    "allowRedirects": false,
    "maxRedirects": 0
  }
}
```

该适配器只读取一个人工审核的 Raw 文件，输出 `discovery-lead`，并保留 Raw 文件作为字段证据。它不会克隆仓库、执行 README 中的 HTML/JavaScript、自动访问表格里的岗位链接或把清单条目提升为当前在招岗位。没有稳定 HTTPS 原岗位链接的行会被跳过并报告 partial；重复链接会合并。仓库许可证、清单完整性、岗位当前状态、办公室地址、薪资和控股方都必须在后续人工审核或独立官方来源中确认。

这些字段放在来源的 `options` 内，`entryUrl` 放在来源顶层。路径只允许有限的自有属性访问，例如 `data.jobs`；不支持通配符、表达式、括号脚本、原型遍历或 getter。`recordsPath: ""` 表示根数组。记录必须具备稳定 ID 或原始 URL，不能把数组下标当岗位身份；位置与工资文字保持原文，不自动猜坐标或工资数值。

### JSON 结构化地点

当来源为每个实际工作地点提供独立字段时，可在 `options` 显式配置以下平铺映射；新增同协议来源主要调整配置，不复制适配器：

```json
{
  "locationsPath": "offices",
  "locationTextPath": "label",
  "locationCountryPath": "country",
  "locationCountryFormat": "iso2",
  "locationRegionPath": "region",
  "locationCityPath": "city",
  "locationStreetAddressPath": "street",
  "locationPostalCodePath": "postal"
}
```

`locationsPath` 可指向一个对象或对象数组。所有子路径相对**单个地点**；`locationsPath: ""` 选择当前岗位行，空子路径选择该地点值本身。未配置任何子路径时，旧字符串／字符串数组行为保持不变。原地点文本优先；没有文本时，只拼接同一地点实际披露的字段，不从另一地点、公司、币种、来源域名或查询条件补值。国家和城市必须在同一个地点同时满足筛选。

`locationCountryFormat` 省略时采用 `iso2`，只接受国家目录实际成员并规范大小写；`UK` 不作为 ISO2。明确选择 `name` 才使用精确国家名称／别名解析，无法确定的国家、地区或复合文本保留原文。地址和邮编只接受字符串，`"00123"`、`"0"` 保留，数值不强转成邮编。每个字段保存原 selector、原始引用和响应 URL，证据按去重后的输出地点序号绑定；不同地点不会互借字段证据。

这些字段只表示来源披露。上游 `address` 也可能仅含城市名；映射不验证其属于具体道路、不生成坐标、不确认办公地点，也不增加离家距离可比率。远程申请资格、总部／联系地址不能配置成办公室；本批尚未增加通用 JSON 工作方式映射，Remote OK 等既有预设不自动加国家字段。GitHub JSON 仍只输出线索。

新增选项不向旧映射插入默认属性，旧分页形状保持兼容；显式改地点路径或国家格式后，原分页游标失效，需要按新配置重新开始。输出仍受原字段与500条证据契约限制；地点很多或重复很多时，超限记录会省略并报告部分覆盖，不承诺1000地点无损映射。已有来源配置与运行服务不会自动改写。真实只读协议探测和生产链路合成验证见[地点映射报告](../../docs/reports/job-atlas-json-locations-2026-10-22.md)。

### JSON 来源分页

对明确返回下一页链接的 API，可在同一个 `options` 对象增加以下**平铺字段**，不需要新适配器或自定义代码：

```json
{
  "nextPageUrlPath": "links.next",
  "pageParameter": "page",
  "enumerationComplete": true
}
```

只有来源实际返回的下一页会被跟随，且仅允许受审 `entryUrl` 的同源、同路径和相同固定查询参数，改变配置指定的递增数字页码。显式 `null` 表示该 API 当次清单末尾；缺失、循环、跨站或额外参数不会被跟随，已读取的有效记录仍保留并标为部分覆盖。旧配置没有 `nextPageUrlPath` 时保持原有限单页语义，不能靠猜页码扩大读取。

每次调用先下载完整一页，再按现有范围匹配分配输出额度。输出不足以容纳当前页时，私有游标绑定来源、配置、原条件和整页指纹；继续读取仍下载该页，内容变化就拒绝旧偏移。`fetchedRecords`／累计尝试计入实际下载的记录数，重读会重复计数，不能当作唯一岗位数或仅选中记录的网络预算。实时接口的不同页之间可能重复或移动，索引按来源身份处理重复；分页不是跨页快照，也不保证市场全量。`enumerationComplete: false` 的窗口即使没有下一页仍保持部分覆盖。

来源刷新仍受请求、字节、时间、记录、页数和间隔预算约束，下一批由现有 `sources.continue` 工具显式发起。具体工具和持久进度见[服务说明](../../apps/job-service/README.md#分批扫描与显式续读)。内置 Arbeitnow 配置仅为待审默认，已安装来源不会被目录静默覆盖；更新既有来源须在来源工具中读取当前配置、核对这两个分页字段及额度，并按当前版本明确保存。真实两页能力探测和合成持久续读的区别见[验收报告](../../docs/reports/job-atlas-json-pagination-batch-2026-10-22.md)。

代码注册器示意：

```ts
import {
  createSourceRegistry, createControlledSourceTransport,
  greenhouseAdapter, leverAdapter, ashbyAdapter, tencentAdapter,
  mappedJsonAdapter, githubJsonAdapter,
} from "@better-me/source-adapters";

const registry = createSourceRegistry([
  greenhouseAdapter, leverAdapter, ashbyAdapter, tencentAdapter,
  mappedJsonAdapter, githubJsonAdapter,
]);
const transport = createControlledSourceTransport();

// reviewedSource 经 SourceDefinitionSchema 校验，enabled=true 且 status=active。
// trustedContext 由可信 host 提供预算、取消信号、身份与 observedAt，不来自来源 JSON。
const result = await registry.list({
  source: reviewedSource,
  scope: { roles: ["TypeScript"], regions: [], companyNames: [] },
  context: trustedContext,
  transport,
});
```

`SourceRegistry.register()` 只安装可信代码适配器；重复 ID / 版本会拒绝。`describe()` 返回能力元数据。`resolve()` 检查启用状态、版本、能力、运行环境和实体类型，不能用来源 JSON 自行安装未知代码。`list()` 对输入及实际输出做运行时校验，检查记录上限、观察时间、实体类型、分页与过滤覆盖，避免适配器把部分结果声明为完整覆盖。

## 记录与覆盖契约

`SourceJobRecord` 保留 `entityType`、稳定源 ID / URL、雇主与标题、原文、地点、薪资、工作方式、远程资格、源时间、逐字段 evidence、完整度和 warnings。它是外部声明，不会成为个人职业事实。

`SourcePage` 包含 `records`、`observedAt`、可选 `nextCursor`、`coverage`、可选 `stopReason` 和 warnings。`coverage` 明确完整 / 部分覆盖、实际拉取记录数、上游执行 / 忽略的过滤条件；页数、记录数、预算、429、人工验证或来源错误导致的截断不能声称全量。`Retry-After`、取消和固定错误码会传回调用方，不记录原响应中的凭据或私人文本。

下载成功、原站 list 中出现、GitHub push 时间或 `isListed` 都不能单独证明当前在招。只有具备明确源依据的 availability 才能声明 `open` / `closed`；否则保持 `unknown`。源时间与服务拉取时间分别保存。当前解析器不推断企业控股来源、不地理编码、不将未提供的工资自动转换为可比税前年薪。

## 候选发现、抽样与提案

来源发现是通用工具，用户给出的仓库只是种子。导出函数与应用工具一一对应：

| 函数 | 输入 / 结果 |
| --- | --- |
| `discoverSourceCandidates(request, execution)` | `provider: "github-repositories"` 加 `query` 搜索仓库元数据，或 `provider: "seed-links"` 加 `seedUrls` 有限检查显式种子；返回 `needs-review` 候选、来源证据、部分覆盖与分页。 |
| `inspectSourceCandidate(request, execution)` | 输入 candidate，可选最多 3 个 `sampleUrls`、最多 100 条抽样；识别 JSON / CSV / Markdown 的有限字段、覆盖情况和候选映射。 |
| `proposeSourceRegistration(request)` | 输入 candidate、某个 sample、名称和记录限制；输出禁用的待审来源及必须核对的事项，不写入注册器。 |
| `discoverCompanyCareers(request, execution)` | 先匹配已登记公司来源 / 主机提供的别名，再按明确官网或种子发现有限招聘入口；返回已有来源或带证据的待审候选与禁用提案。无官网且未配置搜索 provider 时返回 `requires-company-website`。 |

实际网络请求仍需要一个显式启用、具备 `discover-sources` 能力的来源配置及它的端点策略；发现工具不能越过策略任意访问候选 URL。GitHub 搜索不自动克隆仓库、不运行项目代码，不因为 star、活跃度或仓库许可证就认定岗位内容可再分发。GitHub 结果上限、抽样上限、缺许可和缺稳定 ID 都保留为限制。

CSV / Markdown 当前用于抽样识别与提案。没有对应生产列表解析器时，提案保持待审，不能直接启用为已实现的来源。候选、清单、招聘活动和方向线索均不是已核实岗位，不计入正式岗位数量。

## 公司官网招聘入口发现

`discoverCompanyCareers()` 是独立的来源发现工具，不是岗位搜索接口。其纯契约位于 [`career-discovery-contracts.ts`](src/career-discovery-contracts.ts)，Node 实现位于 [`career-discovery.ts`](src/career-discovery.ts)。浏览器通过 `@better-me/source-adapters/browser-contracts` 导入 Schema，通过本机服务调用；不打包 Node 传输实现。

应用工具名为 `companies.discover-careers`，HTTP 为 `POST /api/v1/companies/discover-careers`，请求体：

```json
{
  "sourceId": "my-reviewed-discovery",
  "request": {
    "companyName": "示例企业",
    "companyWebsite": "https://company.example.com/",
    "limit": 10,
    "maxPages": 3
  }
}
```

`sourceId` 指已经登记、启用、状态为 `active`、在 `local-service` 运行并具备 `discover-sources` 能力的**发现策略来源**，不是尚未发现的企业来源 ID。它定义允许访问哪些主机和路径；提供 `companyWebsite` 不会自动扩张该策略。实际访问仍需 HTTPS、公网 DNS、受控重定向、请求 / 字节 / 时间与速率预算。示例域名及 ID 仅说明输入结构，不会自动注册。

`companyName` 必填；`companyWebsite` 和 `seedUrls` 均可省略，后者最多 20 个。`limit` 默认 10、范围 1–20；`maxPages` 默认 3、范围 1–10，实际页数还受发现来源自身上限限制。已安装来源优先按配置中的公司名、主机注入别名或明确入口匹配；共享 ATS / 仓库主机不因域名相同就成为同一企业来源。

| `status` | 含义与后续动作 |
| --- | --- |
| `matched-existing` | 至少命中一个 `enabled: true` 且 `status: active` 的已有来源，`matchedSources[].matchedBy` 说明匹配方式；优先返回且不读取网页。配置匹配不等于企业归属或岗位可用性已核实。 |
| `requires-company-website` | 没有可用的active匹配、明确官网 / 种子或受信搜索 provider。需要明确官网或配置 provider，不根据公司名猜域名；禁用或待核实的命中仍会列在 `matchedSources`。 |
| `needs-review` | 获得带原链接与证据的入口候选，等待核对企业归属、使用范围和解析能力；可以同时保留禁用、待核实或不可用的已有匹配。 |
| `no-candidates` | 本次有限静态读取未发现可返回入口；不能解读为该公司没有招聘岗位。 |

结果包含 `companyName`、`observedAt`、`matchedSources`、`candidates`、`proposals`、`visitedUrls`、`partial` 和 `warnings`。每个候选包装现有 `SourceCandidate`，另带 `entryKind`、`matchedBy`、`companyAssociation: "unverified"` 和原页 / 目标链接、可选锚文本等证据。发现时间不写成岗位发布时间。

只有 `enabled: true` 且 `status: active` 的已有匹配才保留“匹配后零网络请求”的优先路径。禁用、待核实或不可用匹配仍展示原状态，但不会遮蔽本次明确官网和有效独立发现策略，或宿主已经配置的受信搜索。它们的 `entryUrl`、首页、secret 引用和访问策略不会被拿来授权 fallback；发现结果仍只含待审线索，不会登记来源或写入岗位。

官网 HTML 只有限跟随同 origin 且在原策略内的招聘链接；脚本、表单、嵌入页面与任意用户解析代码不执行。跨域招聘链接只记录待审证据，不跟随。识别 Greenhouse、Lever、Ashby、腾讯的已知入口形式时生成相应适配器提案，**不访问其 API、不登记或启用**；提案 `enabled: false`、`status: "needs-review"`。未知 HTML 使用 `review-required-html`，`capabilities: []`，没有可运行的通用 HTML 岗位解析器，不能直接启用采集。

`jobposting-jsonld@1` 的 `options.enumerationKind: "sitemap-index"` 只接受一个审核过的根 URL，并可设置 `maxChildSitemaps`（1–100，默认 20）。根索引中的 `<sitemap><loc>` 必须是同源、HTTPS、无凭据／片段／歧义路径的 URL；受控 transport 还会按来源 `endpointPolicy` 校验主机、路径、DNS、请求、字节和取消预算。每个子响应的 XML 解析上限为 2 MiB，岗位候选总数仍受 10,000 条清单边界和当前 `refreshPolicy.maxRecords` 限制。子响应必须是叶子 `<urlset>`；若它是另一个 `<sitemapindex>`、跨源或不可读，只记录有限警告并继续其他已读叶子，不递归、不猜测新的索引地址。达到子清单、解析、响应或请求预算会返回 partial / 固定 stop reason，已有岗位候选和详情会保留。根索引及其 `loc` 不会直接成为岗位，只有同源叶子中的链接在岗位页面读取到有效 JobPosting JSON-LD 后才进入候选记录。

底层支持宿主注入 `registeredSources`、`companyAliases` 和 `CareerWebSearchProvider`。这些不是普通 HTTP / Agent 参数。当前 job-service 注入已有来源列表，支持由宿主通过 `--career-search duckduckgo-html|searxng` 显式配置搜索 provider，**默认禁用**，尚未注入公司别名表。受信 provider 使用宿主提供的策略、transport 和预算，其结果仍校验并标待审，不能自行成为已核实官网，也不保证任意企业的全网岗位覆盖。具体配置和限制见 [job-service 说明](../../apps/job-service/README.md)。

编排顺序为 `companies.discover-careers → 审核来源 → sources.register → sources.preview / sources.sync → jobs.search`。已有来源可直接进入显式预览 / 同步；待审入口和缺 provider 状态有不同后续动作。HTTP 输入、幂等写入、未来 LangChain / LangGraph 薄适配与四平台真实站点验收边界，见[公司招聘发现与搜索工具方案](../../docs/planning/company-career-search-tools-2026-10-18.md)。

四平台另有纯函数 `buildPlatformSearchRequest()` 和可审查地区目录，将关键词与平台特有地区参数构造成官方搜索链接。source-adapters 包本身不打开浏览器，也不管理账号；实际浏览器读取由 Web 本机宿主的 `/api/jd/search-session` 与 `/api/jd/search-capture` 承担。宿主只读取用户明确打开并授权的官方搜索页可见 DOM，单页最多 50 张卡片，保留页面 URL、读取时间、门禁／登录／验证／未知布局状态以及逐字段可见证据，不读取 cookies、storage、私有 profile 或隐藏接口。

共享的 `PlatformSearchBatch` 契约支持把一次明确读取保存为批次；用户在原站手动翻页后点击“追加当前页”才会增加页序。它保留逐页回执和历史页面，校验平台／关键词／地区／官方路径范围、页序与重复页，并按稳定岗位链接去重；“再次读取当前页”不会静默增加页数。批次仍只代表用户明确读取的部分页面，不自动翻页、滚动、绕过登录或验证码，也不声称全站或市场全量。页面懒加载内容需要用户在原站完成滚动或加载后，再手动读取当前页；独立 companion 桥尚未提供。每页结果继续走 `reviewed-cards` 的预览、逐卡核对和明确确认后才可进入统一索引；单岗正文读取不会把搜索列表冒充完整 JD。

当前真实站点验收仍需逐站进行：LinkedIn 与猎聘已有有限样本证据，51JOB / BOSS 的真实列表读取仍可能受登录、验证、专用浏览器路线或页面布局影响，尚不能据此把空结果解释为没有岗位。原生浏览器未启动、访问门禁或未知布局会单独返回诊断状态；这些限制不会通过普通代理、接口猜测或自动化绕过。逐站证据和当前缺口见 [`docs/job-atlas.md`](../../docs/job-atlas.md#51job-boss-猎聘与-linkedin-手动分页搜索)。

## 受控传输

持久发现线索的共享契约位于 [`lead-resolution-contracts.ts`](src/lead-resolution-contracts.ts)，由 Node 主入口和浏览器纯契约入口共同导出。`DiscoveryLeadSchema` 保留原来的非 `job-posting` 约束；线索查询与单条读取绑定摘要和 revision，原页读取输入只有持久身份，不接受任意 URL。工具／HTTP 与使用步骤见[本机服务说明](../../apps/job-service/README.md)和[接续报告](../../docs/reports/job-atlas-persistent-leads-2026-10-23.md)。

安装的来源代码可提供 `matchesOriginalUrl({source,url})` 和 `readOriginal({source,url,context,transport})`。前者同步检查链接适用范围、无网络请求；没有 hook 的适配器不会列为原页候选。后者读取当前唯一原页，原编号必须由该页面／原 API 返回；Registry 要求启用的 `job-posting` 来源、`list-jobs`／`local-service`、同返回 URL、非空实际 ID、读取前后取消检查与不变的读取时间。JSON 配置不能添加执行代码或取得新端点权限。

JSON-LD 复用已审 URL／路径和唯一 JobPosting reader，只 GET 该页，不枚举 manifest。SmartRecruiters 仅从配置租户的规范 public posting 路径取实际数字 ID，再走精确 API 校验；原页缺雇主时不以配置中的公司名补齐。此能力未推广至其他 ATS 或四平台浏览器；它不证明全市场覆盖、在招状态或办公精度，也不默认访问 `applicationUrl`。

`createControlledSourceTransport()` 提供 GET-only HTTPS 读取。它对主机 / 路径允许项、重定向每一步、DNS 结果、实际连接地址、响应流大小、总字节预算、请求预算、超时、取消与来源速率做检查。DNS 地址会固定到实际连接；私网、回环、云元数据、保留 / 文档 / Fake-IP 范围会拒绝，不能用公开域名跳入本地地址。

适配器不能透传 Cookie、Authorization 或任意请求头；当前只允许有限的内容协商 / 缓存条件请求头。来源 `secretRef` 仅是引用名，现有 job-service 发现它时返回需要认证，不会从 JSON 读取实际密钥。登录 / 验证码接续仍属于原有本机浏览器流程。

对于系统 Fake-IP 环境，可由可信 host 显式选择：

```ts
import { createControlledSourceTransport, createGoogleDohResolver } from "@better-me/source-adapters";

const transport = createControlledSourceTransport({ resolve: createGoogleDohResolver() });
```

该解析器使用固定的 `dns.google` HTTPS 服务与公网 TLS bootstrap；返回地址仍须符合公网策略。它把请求的来源主机名发送给 Google，不改系统 DNS。DNS HTTPS 和实际来源请求共享同一个请求 / 字节 / 取消 / 截止时间预算，因此一次来源读取至少需要两次请求额度。默认仍使用系统 DNS，不会自动退回放宽地址验证的模式。

`resolve` / `send` 的可注入接口供可信 host 和合成测试使用，不可从不可信来源 JSON 或普通 HTTP 请求中指定。模块没有系统代理修改、shell 执行、浏览器 profile 管理或任意网络代理 API。

## 验证与尚未完成的工作

仓库根 `pnpm test`、`pnpm lint` 和 `pnpm typecheck` 已覆盖本包。单独运行测试：

```powershell
pnpm exec tsx --test packages/source-adapters/tests/*.test.ts
pnpm --filter @better-me/source-adapters typecheck
```

自动化使用合成固定响应、受控连接与预算测试，不请求私人数据。`tests/public-probe.ts` 是显式真实来源检查辅助脚本，不是默认测试；有限样本检查不能外推全站长期可用或完整市场覆盖。

新增公司招聘发现的定向测试为 14/14，通过名称 / 别名与共享域名边界、有限静态链接、四类入口提案、恶意 HTML / URL、预算、取消、错误状态和受信 provider 契约。2026-10-18 还对实际本机 HTTP 新接口做了两项有限读取：用已配置发现来源及腾讯配置中的公司名，返回 `matched-existing`；未登记的合成公司名未提供官网，返回 `requires-company-website`。两次 `visitedUrls` 均为空，没有请求企业官网或新增岗位，前后公共数据集与来源配置不变。这证明实际接口与已有配置匹配 / 缺输入分支可用，不能当成任意公司官网发现或真实四平台采集通过。

本包尚不包含地图渲染、地址解析 / 通勤服务、企业控股研究工具、自动跨源归并、定时调度、完整平台搜索、服务器身份认证或 LangChain / LangGraph Agent。扩展时应复用这些输入 / 输出 Schema、证据、覆盖与受控 transport，让 UI、HTTP 和未来 Agent 使用同一底座。
