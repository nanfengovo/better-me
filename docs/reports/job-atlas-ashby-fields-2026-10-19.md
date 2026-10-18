# Ashby 地点与分项薪资字段修复

日期：2026-10-19。接续[SmartRecruiters 官网接入与 C# 来源刷新](job-atlas-smartrecruiters-2026-10-19.md)，本批处理 Temporal 等 Ashby 来源已经公开披露、但旧适配器未完整保留的国家、次要地点和多档薪资字段。

本批已实现并正常推送 `8c8d347`，隔离产品树完成1975/1975测试、types10/10、lint和build6/6；远端Windows质量、Linux构建、Docker及Pages四任务均success。独立临时服务真实读取Temporal70条，按C#条件收录7条；浏览器已核美国＋Chicago筛选、印度筛选、完整分项薪资与原链。原服务更新操作被自动审批拒绝，原工作台仍为61岗／revision33，不将隔离结果冒充原库已更新。

## 修复前停点与本批范围

本批开始前，原工作台最近已核对的停点为 **61 岗／revision33、全球 C# 24 个文本命中／13 家企业、国内 C# 2 个文本命中**，有 10 项可抓取来源。该数字沿用上一批真实操作结果，尚不是本批更新后的结果。C# 文本可能只是岗位要求列举的可选语言之一，不能当作专职 C# 岗位、个人适岗结论或全市场覆盖。

上一批新增的 Temporal 样本原页已经披露美国等国家、多个地点和分项薪资，但旧适配器只接受两字母国家值，次要地点仅保留标签，远程岗位也会丢掉结构化地址；薪资主要保留顶层摘要，不能完整呈现实际分项。本批复用既有 SourceJobRecord、统一投影、SQLite、共享查询及来源证据，不新增一套 Temporal 专属索引，也不扩大公共岗位契约。

主要实现位于 [Ashby 适配器](../../packages/source-adapters/src/adapters/ashby.ts)和[字段解析辅助文件](../../packages/source-adapters/src/adapters/ashby-fields.ts)。来源仍由现有配置选择 board，使用受控公共端点：

```text
GET https://api.ashbyhq.com/posting-api/job-board/{boardToken}?includeCompensation=true
```

## 官方依据与有限公开观察

已核对 [Ashby Job Postings API 官方文档](https://developers.ashbyhq.com/docs/public-job-posting-api)。文档说明 `workplaceType` 可为 `OnSite`、`Remote`、`Hybrid`；未提供的字段可能保持缺失或为空；`publishedAt` 是最近一次发布的时间，不保证首次发布日期。字段缺失不能以抓取时间、标题、币种或其他岗位字段补造。

2026-10-19 北京时间约 04:50 的有限公开只读核对中，[Temporal 公共 Posting API](https://api.ashbyhq.com/posting-api/job-board/temporal?includeCompensation=true)返回 HTTP200、`apiVersion: "1"`、70 个岗位，其中 70 个带 compensation、30 个带 secondaryLocations。这里只记录结构、计数和少量受限字段；没有把完整 JD、私人岗位库、简历、浏览器 profile、访问令牌或数据库备份写入报告。

| 观察项 | 此次公开响应或官方示例 | 实现边界 |
| --- | --- | --- |
| 实际地址 | 主地点及次要地点使用 `address.postalAddress.{addressCountry,addressRegion,addressLocality}` | 只读明确字段，不从地点标签猜地址 |
| 官方次要地址示例 | `secondaryLocations[].address` 下直接放上述三个字段 | 同时支持明确出现的嵌套和扁平两种形状 |
| 国家字段 | 实际值包含 United States、United Kingdom、Canada、France、Germany、India、Singapore；官方例为 USA | 有限精确别名映射；不将 Europe、Remote 或城市名变成国家 |
| 工作方式 | 实际 9 项为 `Hybrid + isRemote:true`，61 项为 `Remote + isRemote:true` | `workplaceType` 优先，未知时才以 `isRemote:true` 回退 |
| 薪资类型 | 实际含 Salary、Bonus、Commission、EquityCashValue；官方另有 EquityPercentage | 按类型分别保留，不把所有数字归为固定工资 |
| 薪资周期 | 此次实际货币分项都是 `1 YEAR`；官方股权百分比例为 `NONE` | 仅将已核的 `1 YEAR` 映射为 year；其他周期保留原文且保持 unknown |
| 税制 | 此次响应和所核官方说明未提供可靠税前／税后字段 | 统一保持 tax unknown，不因美国岗位或年薪格式推断 gross |

这只是一个 board、一次读取时点的观察，不承诺 Ashby 所有租户、所有未来字段或所有枚举均已覆盖；70 个 API 岗位也不等于 70 个 C# 命中，更不等于本次已写入原索引。

## 地点保留与远程语义

主地点和每个 secondaryLocation 分别解析、保留来源路径与受限字段证据。标签缺失时，可以用该地址对象实际披露的城市、省州、国家组成可读原文；不从标题、board、公司品牌或薪资币种补国家。相同标签但结构化国家／省州／城市不同的地点分别保留，完整相同的地点去重。

国家全名复用现有 [resolveLegacyCountryCode](../../packages/opportunities/src/legacy.ts) 的有限精确别名，本批补充 `India`／`印度`→IN；现有 United States／United States of America／USA 等别名继续使用。该映射只作用于明确的国家字段，不是全世界地名识别器。未知名称保留原文，`Europe`、`European Union`、城市名及混合文本不能产生一个猜出的国家。

纯 Remote 的来源标签保留在 `remoteEligibleRegions`。来源确实给出的结构化国家／省州／城市可以进入 `locations`，并由既有投影保存为 **remote-region**，供同一地点的国家和地区筛选使用；它们仍然是远程资格／招聘范围，不是核验过的办公室。宽泛的 Europe／European Union 标签仅保留文字，不展开成国家列表，也不制造办公室或地图坐标。

`Hybrid` 不被同时存在的 `isRemote:true` 覆盖。所有地点都保持来源披露、未独立核实；本批不生成经纬度、街道地址、离家距离或通勤结论，不把远程城市绘成办公室 pin。筛选仍要求国家、城市等条件在同一地点成立，不能把美国地点的国家借给加拿大城市。

## 分项薪资与多档位

实际 API 的层次为 `compensation → compensationTiers[] → components[]`；tier 还可包含 `title`、`tierSummary`、`additionalInformation`，顶层另有摘要和 `summaryComponents`。实现按 tier 和 component 分别保留原文、类别、明确货币金额、周期及来源路径，tier 标题保留在原文中。结构化字段和数字只能表示来源披露，不能自动提升为已核验的可比工资。

| 来源分项 | 当前保存方式 | 不推导的内容 |
| --- | --- | --- |
| Salary | kind base；合法币种、有限金额及 `1 YEAR` 周期分别保留；tax unknown | 不假定税前，不提前换算成人民币税前年薪 |
| Bonus | kind bonus，明确金额可保留 | 不合并进固定工资 |
| Commission | 当前无独立佣金 kind，保持 kind unknown，同时保留 Commission 原文、币种和明确金额 | 不冒充 base 或 bonus，不与工资相加 |
| EquityCashValue | kind equity，金额 null 保持未披露 | 不把“Offers Equity”换成零，也不当作现金基本工资 |
| EquityPercentage | 保留百分比原文和证据，kind／period unknown，不填货币金额和币种 | 0.5–1.75 之类股权百分比不进入薪资金额 |
| 未支持类型／周期 | 保留类型与周期原文和受限证据，未知字段保持 unknown | 不猜测未来枚举、不默认按年 |

受限公开样本 [Staff Solutions Architect, Majors (Central)](https://jobs.ashbyhq.com/temporal/e8dc6efc-67da-4a5d-859c-85865d6ed21d)的分项为 Salary USD168,000–220,500／年、Commission USD72,000–94,500／年，以及金额未披露的 EquityCashValue。这些数字用于解释实际字段区别，没有复制其完整 JD；税制均未知，不能直接展示为已经核实的税前基本年薪或总包。

多 tier 示例中的三段基本工资分别为 216,000–283,500、194,400–255,150、172,800–226,800；顶层 `summaryComponents` 的 172,800–283,500 是跨 tier 包络。已有具体 tier components 时，不把 summary envelope 再保存成一笔付款，不把包络取代某个档位，也不假定某个城市适用最高档。缺分项时才回退到可用摘要原文。

tier 的名称和顺序不足以建立结构化地点绑定，当前保留为 **unscoped**，不按数组下标、国家文字或城市顺序填 `locationIds`。`additionalInformation` 中的 OTE、比例和说明单独作为原文披露，不据此算术补造 total、base 或 commission。倒置金额范围不进入结构化有效上下限，但原值和警告保留。

既有年薪规范化条件继续有效：固定工资、税前依据、金额、币种、周期及必要换算证据均满足后才可比较。tax unknown 的基本工资不能因存在合法汇率而变成可比人民币税前年薪；佣金、奖金、股权也不进入固定工资排序。未知薪资依既有筛选选项处理，不把来源已披露原文误称为已可比较。

当前查询返回全部 `salaryCandidates`；没有可比候选时，兼容字段 `salary` 仍可能指向一条不可比候选，不能理解成唯一工资。现有 Atlas 详情通过完整 dataset 按 `compensationIds` 展示全部原文，独立真实UI已显示上述三个分项及原链；这不等于原服务已经更新。独立 `jobs.read-detail` 工具尚不返回完整 locations／compensations 数组，后续 Agent 仅调用该工具时仍有字段完整性限制；本批不把该限制写成已解决。

## 新增定向测试与验收边界

新增 [8 项适配器字段测试](../../packages/source-adapters/tests/ashby-fields.test.ts)，覆盖两种明确地址形状、缺标签回退、同名不同地址、未知国家不推断、Remote／Hybrid 优先级、五种薪资构成、未知周期与类型、倒置范围、多 tier、summary envelope 不重复及 OTE 不算术推导。现有国家别名回归同时增加 India／印度的有限映射。

新增 [2 项临时真实 SQLite 集成测试](../../apps/job-service/tests/ashby-projection.test.ts)，经默认应用的来源注册、preview／sync、统一投影、查询和数据库重新打开，验证结构化远程范围持久化、次要地点同地筛选、国内与海外边界、无办公室坐标、分项金额及未知税制阻止可比年薪。测试使用合成 HTTP feed 和临时数据库；不会连接原岗位服务、读取私人索引或发起申请。

新增定向10/10及最终隔离全量1975/1975通过，完整结果见末节。另以相同冻结源码启动独立临时服务，实际公开API、SQLite同步及浏览器分别验证；合成测试与真实读取各有独立范围。

## 后续服务与页面操作

后续若更新原本机服务，仍需先核对精确进程／监听归属、运行任务和数据停点，按既有流程备份及验证 SQLite 后再进行受控更新。不能把另一工作区的服务重启、测试库成功或新源码存在当成原页面已经更新。

Temporal 现有目录配置继续采用手动刷新及 `minIntervalSeconds: 3600`。新字段解析不应清空来源刷新记录、缩短既有间隔、换 sourceId 规避间隔或连续抓取；限流、超时、来源返回变化和部分覆盖按真实回执展示。如果尚未到可刷新时间，应保留该状态，不能为完成演示绕过策略。

本批只修复可核字段的准确度，不增加已配置企业之外的市场覆盖，不承诺 51JOB／BOSS／猎聘／LinkedIn 的全站采集已完成。其人工验证接续、更多来源、完整正文、可比薪资、精确办公地点及规模性能继续分别验收。

## 最终验收与发布

| 验收项 | 实际结果与边界 |
| --- | --- |
| 官方字段与有限公开 API 研究 | 官方文档及Temporal70岗结构已核，仅有限字段，无完整JD公开 |
| 新增定向测试 | 8项adapter＋2项临时SQLite集成均通过，已有国家别名测试增加India／印度 |
| 完整隔离产品树 | `a3c7c6d9509b4710a3ba7908195f3140c21a0f6a`，仅6文件；离线冻结安装、1975/1975（fail／cancel／skip／todo0）、types10/10、lint、build6/6通过，排除并行Career Agent和导入改动 |
| Docker与远端检查 | 本机未新建Docker镜像；本批[Actions39165884279](https://github.com/nanfengovo/better-me/actions/runs/39165884279)的Windows质量、Linux构建、Docker镜像／HTTP及Pages均success，不沿用上批镜像数字 |
| 原本机服务更新 | 已核精确监听／进程、0运行任务，完整在线SQLite备份及quick_check=ok；随后停止／重启操作被自动审批以blocked by policy拒绝，原服务与原库未被该操作改变 |
| 独立真实同步 | 相同冻结源码、全新隔离服务与数据库，只登记Temporal；手动同步读取70条、C#匹配新增7条，completed、revision2，保留原3600秒最小间隔和100条／1页上限，不修改原来源刷新记录 |
| 独立真实查询 | 美国＋Chicago命中1条、India命中1条、CN0条；目标三地为Dallas／Chicago／Saint Paul，均remote-region／无坐标，查询已定位0、无可比税前年薪 |
| 浏览器详情与筛选 | 独立构建页面实际连接临时服务；C#＋美国＋Chicago仅目标1条，详情显示工资USD168000–220500／年、佣金72000–94500／年及无金额股权，原链正确；印度Bengaluru1条、中国0条。截图仅本地保留 |
| 正常提交／推送 | 功能`8c8d3479602284a83444aabbe0877ddd6be62252`已正常推送main，未改写历史；README／规划／记录作为独立文档批次维护 |

原工作台仍保留 **61岗／revision33、全球C#24文本命中／13企业、国内C#2条**；隔离验证的7条是原库已经存在的Temporal来源样本，不是原库新增7条，也不应与61相加。生产静态Pages／Docker不内置本机岗位后台，源码和静态版本发布不自动更新正在运行的独立服务。原服务需通过获准的受控更新后，再按原刷新间隔核对字段；本批不称原页面已采用新映射或国内市场覆盖已扩大。

## 后续本机状态更新

上述原61岗／服务停止操作拒绝是本批历史时点。后续重新核对时，旧PID已经不存在且5178／5286无监听，先备份后恢复已停止服务；再真实补充国内猎聘／LinkedIn岗位至85岗／revision59。完整详情工具另在3a56bc6补齐，原服务已返回同版本locations／compensations。Temporal旧记录本轮未重新刷新，不能仅因进程加载新源码就称已全部补字段。最新实证见[国内来源与详情报告](job-atlas-domestic-source-expansion-2026-10-19.md)。
