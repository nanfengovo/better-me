# SmartRecruiters 企业官网来源接入

日期：2026-10-19。接续[来源召回与候选核对](job-atlas-candidate-recall-2026-10-19.md)和[地区确认](job-atlas-location-confirmation-2026-10-19.md)，本批扩展一种企业招聘系统协议，复用现有来源目录、官网发现、有限预览、明确刷新和统一索引流程。

通用适配器、官网发现、来源目录与服务默认注册已接通；原本机服务备份重启后，主界面明确添加Bosch来源并完成有限预览、同步、国内省市筛选与原文核对。索引从50岗／revision27前进到51岗／revision29，本批实际新增1条有完整正文证据的`.NET`岗位。隔离产品源码树完整1965/1965测试、types10/10、lint及build6/6通过；随后补齐Docker对新增地区JSON的复制和分发白名单，最终22文件树的实际Docker构建、只读非root容器及275次HTTP检查通过。产品三批已正常推送，远端质量检查及部署结果见末节，不能用本机验证代替。新增协议不等于自动收录所有使用该协议的企业，也不代表四个招聘平台或全市场覆盖已经完成。

## 通用协议与采集范围

新增适配器以 `smartrecruiters@1` 注册到现有 `SourceRegistry`，由 `apps/job-service` 默认安装；项目 JSON 只能选择已安装代码及其配置，不安装或执行外部模块。Web 继续通过认证的来源工具调用预览和刷新，后续 Agent 复用同一工具层。

每个来源明确配置 `companyIdentifier`，请求该企业的公共 Posting API：

```text
GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings
GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings/{postingId}
```

本批实现按租户、岗位 ID 和受控端点限定列表／详情身份。源 JSON 还可配置公司展示名称、页大小、详情读取开关、每页详情次数和固定国家范围。具体选项及默认值以 `packages/source-adapters/src/smartrecruiters-contracts.ts` 为准；所有请求仍受来源主机／路径、HTTPS、无自动跳转、请求／字节／超时预算、取消和刷新间隔约束。

本批适配器路径为 `packages/source-adapters/src/adapters/smartrecruiters.ts`，沿用共同 `SourcePage` 与 `SourceJobRecord` 契约。列表的 `q` 是上游候选查询，原始返回条数不等于关键词确认命中数。岗位是否满足关键词、公司与地区条件仍以实际取得的字段和共享匹配器判断；有有效原链但未读取要求的候选保留“待核对”，不等于不匹配，也不自动计作符合要求的岗位。缺原链候选另按下文规则有界补读，最终无链则排除。

分页游标须绑定原来源、配置与查询范围；改变公司或条件后不能继续旧游标。多词分次查询可能有重叠，不累计声称唯一岗位总数。只读配置允许的页数、记录数及详情数量，明确显示剩余页、预算或来源错误造成的部分覆盖。

详情读取须显式启用，按已配置次数查询同租户／同 ID 的原始详情；列表先保留为元数据或摘录。队列先为满足公司／地区条件、关键词已命中但缺链接的候选获取回链，再补读关键词尚未确认的候选；返回顺序仍保留原列表顺序。职责和任职资格不截断；缺少关键章节或出现尚未支持的额外正文章节时保留摘录，不声明完整 JD。详情超时保留已下载且有有效原链的列表记录，并停止后续详情／分页；最终仍无原链的候选按下述规则排除。429、认证失败、取消、受控端点或预算失败不会被改写为空结果。

真实列表可能不含 `postingUrl`。有合法岗位ID及租户身份但缺链接的记录先作为内存候选，允许在既有详情额度内从**同租户、同ID的详情**取得经过校验的原岗位链接；列表或详情明确给出非法链接时拒绝相应数据。最终仍无有效原链的候选不返回为可操作岗位、不入索引，并标注部分覆盖；不能由API ID或标题拼造链接。相同ID详情若省略链接，可以保留已经验证的列表原链。详情若给出错误ID、租户、`ref`或不匹配原站链接，不注入其他岗位的要求；外部申请地址不自动访问。

## 官网发现与明确登记

现有 `companies.discover-careers`／`POST /api/v1/companies/discover-careers` 增加 SmartRecruiters 入口识别：

- `https://careers.smartrecruiters.com/{companyIdentifier}`。
- `https://jobs.smartrecruiters.com/{companyIdentifier}/{postingId-or-slug}`。

同一租户的两个入口归一为 `careers.smartrecruiters.com/{companyIdentifier}` 的候选主页；来源 API 仍指向固定 `api.smartrecruiters.com` 企业路径。URL 主机采用标准 URL 归一规则，租户标识保留大小写，并按精确标识匹配已登记来源，不能仅凭共享主机判断企业归属。

用户提供的入口和企业官网静态锚点都保留原证据 URL、目标 URL 与可用锚点文字。发现过程只产生候选和**禁用、待审核**的来源提案；识别 ATS 结构时不自动访问其 API，不联网验证企业归属，不自动登记、启用、采集或写岗位。现有来源名称与可信别名可以先匹配，但这种配置命中仍不替代企业归属核验。

提案通过现有JSON核对界面接续。SmartRecruiters提案建议 `pageSize: 20`、`fetchDetails: true`、`maxDetailRequestsPerPage: 2`，让明确采集时能在有界详情中核对正文并补全列表缺失的原链；Schema本身的`fetchDetails`默认值仍为false。端点策略只允许该公司`postings`路径及其详情子路径。用户须核对企业、端点、使用范围、署名、预算和启用状态，再明确保存；生成提案和保存配置均不发起采集，首次读取仍由手动预览或刷新触发。

企业名称没有已登记匹配、也没有官网或入口时，继续返回“需补充企业官网或配置可信网页搜索提供方”。本批不从企业名称猜域名，也不将未配置搜索提供方描述为已能搜索全网。

## 来源目录与界面接线

现有来源目录与工具界面依据来源和已安装适配器的元数据工作，新增 ATS 无须再写一套平台专属控制面板：

| 接线点 | 本批要求与验收点 |
| --- | --- |
| 包导出与服务注册 | 导出契约和适配器；服务默认安装后，`sources.list` 返回正确版本、`list-jobs` 与实际支持的远程条件 |
| 官网发现契约 | `CareerEntryKindSchema` 增加 `smartrecruiters`，识别入口、精确租户匹配与禁用提案保持同一输出契约 |
| 受控访问 | SmartRecruiters 三个共享主机不能作为企业所有权依据；编码分隔符、反斜线、原始点路径和近似恶意域不能获得可执行的 ATS 提案 |
| 静态来源目录 | 如纳入企业预设，保持 `enabled: false`／`needs-review`，记录实际核对日期、端点说明、覆盖限制与证据，不填写未经核验的技术标签 |
| 显式添加来源 | 继续多选后明确添加，既有同 ID／规范端点配置不覆盖；只保存配置，不因打开面板或添加预设自动抓岗 |
| 查询和覆盖状态 | 预览、刷新、部分结果、原始数与命中数使用现有组件；提案中的 `remoteFilters` 须与适配器及实际 `coverage.appliedFilters` 一致 |
| 岗位来源展示 | 每岗保留具体企业来源标签与原岗位链接；可为 `smartrecruiters` 增加统一配色规则，回退配色仍须保留原来源身份 |

本批来源目录新增 `reviewed-bosch-china-official`（Bosch · 中国官网岗位），默认禁用、待审核，采用 `companyIdentifier: "BoschGroup"` 与显式 `countryCode: "CN"`。目录预设开启详情、每页20条、每页最多2次详情、最多5页／100条、手动更新且最小间隔3600秒；官网发现提案同样建议开启有界详情。本轮早期临时探针的10次详情额度独立记录，不冒充目录默认值。

原工作台明确添加Bosch后保存12项来源配置，其中10项可抓取；添加时岗位仍为50条，revision27→28。随后由主界面明确同步，有限采集状态为partial、新增1条，最终51岗／revision29。添加配置和读取岗位是两个独立操作，具体查询及筛选验收见下文。

## 国内英文地名与省市筛选

新增共用配置 [text-aliases.json](../../config/geography/china-administrative/text-aliases.json)，覆盖现有31个大陆省级节点的英文文本别名及有限10个城市别名，绑定既有行政目录版本与父子关系。Web查询和采集范围复用这些配置；别名只供文本核对，不改写来源地点，不补坐标，也不声称覆盖全部城市、拼写或行政变动。

英文城市必须结合父省证据消歧：`Suzhou`在江苏对应苏州、在安徽对应宿州，缺父省信息时不单凭同名英文归到任一城市；同时避免把`Hangzhou`误认进`Changzhou`、把县名或词片段认作城市。最终查询仍要求国家及各级地区在同一地点满足条件，切换省份会按既有级联规则清下级。地区专项12项与工作台29项回归通过。

## 字段与事实边界

来源岗位 ID、公司名称、地点原文与结构化城市／国家、原岗位链接、正文片段和源发布时间分别保留字段证据。来源提供的 `releasedDate` 表示该源发布／重新发布记录的时间，不能称为首次发布，也不能用读取时间补造未知发布时间。

原平台的 `active` 或类似标记可保留为来源证据，不提升为独立核实的在招状态。来源城市、远程标记或经纬度不自动证明办公室地址、远程资格或企业最终控股方；不自动生成离家距离或企业性质分类。未披露薪资币种、周期、税制或金额时保持未知，不参与凭空的年薪换算。

原始 JD 和公司介绍中的关键词可能与实际岗位要求不同，不能把文本命中称为个人适岗。本文不发布私人简历、机会备注、API Key、SQLite／WAL、浏览器 profile、完整私人备份或未授权的整篇岗位正文。

## 定向自动化与协议实证

最终隔离的20文件产品源码树（Git树ID`9203c15962e3c929ccc030cb73ab239e30317eb3`）完整测试 **1965/1965通过**，fail／cancelled／skipped／todo均0；types10/10、lint和build6/6通过。该快照排除并行Career Agent和简历导入成果。随后仅为Docker增加两行地区JSON复制／分发白名单，形成22文件树`857588e439e13d2a9130ab23228a6ceccc659dc0`；这两行不改产品源码；最终树的Docker构建与隔离容器实际通过，UID101、只读根目录、健康状态healthy，275次HTTP覆盖13项地理公开资源、PDF／MapLibre worker、静态API边界和许可分发。分发包含96个模板许可文件、20份适配源文件、95项依赖与97份依赖许可文件；镜像ID为`sha256:9f8f175a9efff472dddc9c00749b91de84df3fd44176269f1dcb8bc29af796eb`。这是20文件源码全量验证与最终22文件树Docker复验的组合证据，没有声称22文件树重新执行了1965项全量测试。

适配器定向测试覆盖列表与同ID详情、关键词只在要求／职责中出现、C#／C++边界、宽查询三态、详情次数与优先级、游标绑定、OR查询、短页和坏响应、错租户／错ID／错ref、缺列表原链后详情补链、最终无链排除、原链继承、取消、超时、429、认证失败、预算透传、时区与未知位置。集成测试使用临时真实SQLite和默认应用注册，经 `sources.preview → sources.sync → jobs.search／jobs.read-detail`：4条合成列表全部缺`postingUrl`、有界读取3个详情，只有正文C#且取得详情准确slug原链的岗位写入；排除完整Python候选、正文C#但详情仍无链候选及未读无链候选。预览返回2条有链候选、确认匹配1条，sync按fetched4／added1报告partial；保留CN／城市／来源时间／回链，不写API城市中心坐标。最终集成单跑1/1与ESLint、diff-check亦通过，合成集成不代表实站全租户长期可用。

官网发现19项包括原有回归与新增SmartRecruiters范围：careers／jobs入口归一、精确租户匹配和禁用提案、官网锚点证据、不擅自访问ATS、共享主机不冒充企业归属，以及编码分隔符／点路径／反斜线／相似恶意域拒绝。

公开HTTP核对从[博世官网招聘入口](https://www.bosch.com/careers/job-offers/)进入[博世招聘站](https://jobs.bosch.com/en/)，站内公开内容关联 `careers.smartrecruiters.com/BoschGroup`。协议依据为 [Posting API](https://developers.smartrecruiters.com/docs/posting-api)、[列表和详情端点](https://developers.smartrecruiters.com/docs/endpoints)及[字段说明](https://developers.smartrecruiters.com/docs/objects)，不执行外部仓库代码。`releasedDate` 按其“posting release”原义保存，`q` 按实际宽查询结果处理。

2026-10-19北京时间03:56—03:57的受控适配器探针只保存本地元数据，摘要如下。请求计数包含所选解析路线的DNS HTTPS请求，不能等同于岗位API调用数。

| 本次探针 | 实际读取及本地核对 | 覆盖边界 |
| --- | --- | --- |
| `q=C#`、固定CN | 取20条，来源声称总量121；最多尝试10个详情，9个完整；0个已确认命中、11个要求未知、9个排除；计22请求／127645字节 | 仍有下一页且partial，未知不算命中，也不等于市场没有C#岗位 |
| `q=.NET`、固定CN | 取4条，4个完整详情；1个已确认文本命中、3个排除；计10请求／55168字节 | 本次该租户／查询列举完成；不代表所有企业、历史岗位或整个市场 |

`.NET`确认样本为[全栈开发工程师 (.net)_BCI](https://jobs.smartrecruiters.com/BoschGroup/744000140377569--net-bci)，ID `744000140377569`，来源地点为 `Suzhou, Jiangsu, China`，结构化CN／Jiangsu／Suzhou；完整清理文本5182字符，源 `releasedDate` 为 `2026-07-29T03:47:46.915Z`。实际职责／资格含 `.net and Angular`。该岗位原页HTTP200；这只支持原链与正文读取，不独立证明当前在招或适合个人。

该探针发生在最终链接处理收尾前；早期部分C#摘录只记录ID形式页面，不能当作最终严格原链版全部实站通过。后续实际确认Bosch列表没有`postingUrl`、同ID详情才返回准确slug，因此最终实现按详情证据补链，仍无链则排除。上表保留为早期探针历史，正式主界面读取使用目录的每页最多2次详情，结果与索引增量单独记录如下。

飞书招聘仍是另一个候选协议：MiniMax官网到其飞书租户的公开关联已看到，但本次ByteDance与MiniMax普通POST列表请求均为405，不算已可用来源。现有transport继续GET-only；本批没有扩大为任意POST、执行外部爬虫或绕过验证。

## 真实主界面、服务停点与待补验

原5178服务在准确重启前完成在线完整SQLite备份，`quick_check=ok`；重启前为50岗／revision27且无running任务。重启后完整公共dataset哈希和token哈希保持，`sources.list`确认 `smartrecruiters@1`、`list-jobs` 与 `roles`元数据。本报告不公开私人数据库路径、令牌、完整备份或哈希值。

原工作台本轮实际操作及结果如下：

| 操作 | 已核对结果 |
| --- | --- |
| 明确添加Bosch配置 | 50岗／revision27→50岗／revision28；12项来源配置，10项可抓取 |
| Bosch `.NET`／CN预览 | 首次超时，手动重试成功；fetched4、返回2条有链记录、本地确认匹配1条，完整详情2/4，覆盖partial |
| 主界面明确同步 | partial、新增1条；51岗／revision29；未将另外两条未取得原链的候选写入索引 |
| 国内`.NET`、全国范围 | 3条文本命中／3家企业；这不是3条个人适岗结论 |
| 国内`.NET`、江苏→苏州市 | 仅Bosch1条；原地点`Suzhou, Jiangsu, China`保留，无办公室坐标 |
| 原岗位外链 | 新标签实际打开[全栈开发工程师 (.net)_BCI](https://jobs.smartrecruiters.com/BoschGroup/744000140377569--net-bci)，核对标题、岗位ID与JD正文成功 |
| 最终恢复原工作台 | 全球`C#`为14条文本命中／9家企业，总库51岗／revision29，10项可抓取来源 |

本批新增的是`.NET`正文命中，**没有增加`C#`文本命中数**；二者不因技术生态相关而合并统计。`.NET`职位原链和正文可读也不独立证明当前仍在招。第一次预览超时后手动重试成功，说明真实网络仍有超时边界；这次有限成功不保证所有租户或后续每次读取均可用。

| 后续验收 | 本稿状态 |
| --- | --- |
| 适配器列表／详情／分页／超时／取消／错误回归 | **已完成**；包含全列表无原链、详情补链及最终无链排除的合成覆盖，有限实站同步已验 |
| 服务默认注册、元数据与关键词预览／刷新 | **已完成有限实站链路**；首次预览超时后手动重试成功，sync为partial |
| 来源目录与真实主 UI | **已完成有限操作**；12项配置／10项可抓取，实际原文新标签及省市筛选已核 |
| 真实原岗位核对与入库 | **已完成1条`.NET`岗位**；50岗／revision27→添加配置revision28→51岗／revision29；C#命中数未增加 |
| 完整隔离产品树检查 | **20文件源码树已通过**1965/1965、types10/10、lint、build6/6；并行Agent／导入排除；最终22文件树仅补Docker两行，实际容器复验275次HTTP通过 |
| 正常提交、推送与远端 CI／部署 | 产品三批已正常推送；首批Windows既有Edge合成测试失败、Pages skipped，后续核查与修复另见末节 |

本批继续扩大可复用的官网协议底座。51JOB／BOSS 列表可读性、更多猎聘和 LinkedIn 地区、其他官网协议、来源发现覆盖、精确办公地址与规模性能仍分别验收，完整岗位聚合与地图目标保持进行中。

## 按功能发布与远端核查

产品三批已正常推送main：`6f967a3`（SmartRecruiters协议、官网发现与来源配置）、`2aa6936`（国内英文地点别名及Docker配置分发）、`32186f7`（原站有界加载诊断）。最后产品提交树精确等于上述22文件冻结树。没有混入并行Career Agent／简历导入、其依赖与锁文件或共享Docker内容。

首批[Actions39163391393](https://github.com/nanfengovo/better-me/actions/runs/39163391393)的Linux构建及Docker成功，Windows检查在既有真实Edge合成导航测试失败：中间页识别预期`platform_intermediate`、实际`unknown`，因此Pages skipped。首批失败不能写为本批部署成功；后续功能批、修复与最终发布实况见[分批发布记录](github-atlas-feature-batches-2026-10-19.md)。

### 本轮C#刷新与测试收尾

随后在原工作台以全球 `C#` 明确刷新10个配置来源，9个返回回执、原始返回705条，实际新增10岗（Arbeitnow 3、Temporal官网7），最终为 **61岗 / revision33、C# 24个文本命中 / 13家企业**。另400条候选要求尚未读全，Bosch受3600秒刷新间隔拒绝、腾讯详情超时，仍保留部分覆盖。Temporal新增样本原文和回链已实际核对，C#是多种可选语言之一，不把24条当专职C#或个人适岗。原页披露的薪资与地点尚未完整映射到索引，当前仍有字段缺口。

新增Temporal样本[Staff Solutions Architect, Majors (Central)](https://jobs.ashbyhq.com/temporal/e8dc6efc-67da-4a5d-859c-85865d6ed21d)原文新标签已核对岗位标题、相同ID和正文；要求在Java／Golang／Python／C#／TypeScript等语言中至少一种。原页显示美国Central时区及多个地点、薪资和佣金区分，但本次API投影尚未把这些规范成国家、可比年薪或办公坐标，保持待补；不以标题中的Singapore或Central猜事实。原本机页面保持全球C#、无国家或城市限制；所有本轮来源等待已终结，61岗／revision33。

首批Windows失败日志仅显示分类unknown，没有记录snapshotState，未声称复现了确切瞬态。测试修复`1209042`只改既有Edge合成测试：在人工导航后有界等待公开navigation_in_progress结束，严格断言ready；ready未知、failed和oversized不重试，原分类／gate／URL／请求数／不导航断言保留。5/5定向及ESLint通过；独立最终树`ce36b767f8d2e4c49a6e49a4b7d3da44f436ce71`冻结安装、types10/10、lint和1965/1965全量（失败／取消／跳过／todo0）通过，未改生产代码，未重复未变的产品构建和Docker检查。该修复正常提交推送，后续[Actions39164275826](https://github.com/nanfengovo/better-me/actions/runs/39164275826)以实际运行结果为准。

产品第二批及最终产品第三批的Windows质量、Linux构建、Docker和Pages已分别全部success，最终产品运行见[Actions39163675586](https://github.com/nanfengovo/better-me/actions/runs/39163675586)。首批失败是历史记录，不能继续当作最新产品发布失败；测试收尾和文档提交的后续CI独立核对。Pages只更新静态程序，本机61岗位、来源配置、密钥与浏览器profile没有上传到GitHub或公共站点。
