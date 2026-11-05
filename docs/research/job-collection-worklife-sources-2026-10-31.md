# 岗位采集与工作制度来源调研

调研日期：2026-10-31。以下为 GitHub 公开 README、源码、提交 API、目录树与 LICENSE 的只读核查；时间均为 GitHub 返回的 UTC 时间。本次没有运行爬虫、请求招聘平台、操作真实简历/岗位数据库或改变运行服务。项目最近提交时间不等于每条企业信息的核实时间，也不证明接口当前可用。

## 结论

1. **Hopetree/Jobs-search 确实包含岗位爬虫，但不宜直接作为当前生产采集引擎。** 核心实现来自 2017 年，依赖当时的页面结构及接口；未发现明确 LICENSE，不能因为仓库公开就推定允许复制、修改与再分发。应先取得授权，再把解析思路作为适配器参考，独立验证平台访问规则、接口现状和数据质量。
2. **955.WLB、996.ICU 更适合作为有出处、有时效及适用范围的企业工作制度线索，而不是岗位事实。** “公司出现在名单中”不等于所有城市、部门或当前岗位都遵循该制度。双休、日工时、加班、远程应分别建模，不能将 955/965 自动等同于经过核实的八小时双休。
3. **remoteintech/remote-jobs 是远程友好企业目录，不是实时岗位聚合 API。** 当前版本的 README 与根 LICENSE 标注 ISC；公司目录未发现独立 CC0 文件，不应沿用历史印象给其内容套用 CC0。第三方公司原文、网站及商标的权利不能只凭本仓库 LICENSE 一并推定。
4. 地图必须保持“企业城市线索 / 可验证办公地址 / 精确坐标 / 远程可雇佣地区”边界。名单城市不能直接生成公司办公点，远程岗位不能被定位成公司总部坐班岗位。

## 证据快照

| 项目 | 本次读取的默认分支 HEAD | HEAD 提交时间 | 许可核查 |
| --- | --- | --- | --- |
| Hopetree/Jobs-search | `818eadfe519a83afda03629f098e8615f51b9097` | 2017-07-31T05:44:22Z，README 更新 | GitHub API `license: null`；递归目录树未见 LICENSE/COPYING；README 未给出明确复用许可 |
| formulahendry/955.WLB | `eff96b0b20a5fc71d1d51cd9ff0c225eb5da140e` | 2025-02-03T05:14:25Z，新增公司 | GitHub API `license: null`；递归目录树未见 LICENSE/COPYING；不能推定自由复用 |
| 996icu/996.ICU | `f5e35f48d769bf92ed885888bfe911d3e5b5a63d` | 2025-08-22T06:01:29Z，合并 PR | 根 LICENSE 为 Anti996 License Version 1.0 (Draft)，不是 MIT |
| remoteintech/remote-jobs | `fa2253f1ed02cc4d8f59ab3ccc831b008cdd7189` | 2026-10-30T00:02:42Z，发布 v4.16.0 | 当前 README 标 ISC；根 LICENSE 另列模板 MIT、字体 SIL 条款；递归树只发现该根 LICENSE |

复核入口：[Jobs-search 提交](https://github.com/Hopetree/Jobs-search/commit/818eadfe519a83afda03629f098e8615f51b9097)、[955.WLB 提交](https://github.com/formulahendry/955.WLB/commit/eff96b0b20a5fc71d1d51cd9ff0c225eb5da140e)、[996.ICU 提交](https://github.com/996icu/996.ICU/commit/f5e35f48d769bf92ed885888bfe911d3e5b5a63d)、[remote-jobs 提交](https://github.com/remoteintech/remote-jobs/commit/fa2253f1ed02cc4d8f59ab3ccc831b008cdd7189)。许可结论是本次指定快照的技术核查，不替代必要的法律审核。

## 1. Hopetree/Jobs-search：能爬，但不能据此认定今天可直接用

### 已确认的实现

- `51job/jobspider.py`：requests + BeautifulSoup，使用 `http://search.51job.com/jobsearch/search_result.php`、旧 `#resultList` DOM 与 GBK 编码，提取岗位名称、公司、城市/地点、薪资、发布日期并直接写 MySQL。
- `lagou/lagouspider.py`：先解析旧列表页 `span.totalNum`，再 POST `https://www.lagou.com/jobs/positionAjax.json`，依赖 `content.positionResult.result`，导出 Excel。
- `zhilian/zhilianspider.py`：访问 `http://sou.zhaopin.com/jobs/searchresult.ashx`，解析旧表格 DOM，提取岗位、公司、城市、薪资、摘要、学历/经验等，直接建表写 MySQL。
- `scrapy-51job/jobsearch/jobsearch/spiders/jobinfos.py`：Scrapy 版本同样使用旧 51job 搜索入口，进一步解析岗位详情中的地址与职位内容。这里有地址提取，但没有当前地址真实性、坐标精度或办公点核验体系。

核心 requests 爬虫文件各自最后一次路径提交为 `ab378f5ec33e203a150d407a3feedf9f8e38a914`（2017-07-22T07:07:35Z，add all files）；Scrapy 爬虫路径最后提交为 `8b6b661a0e913f9d310fc26f6be2b810666ee2e1`（2017-07-30T10:46:47Z，项目合并）。因此最后的 README 更新不是一次现代平台适配或采集恢复的证据。

源码证据：[51job](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/51job/jobspider.py)、[拉勾](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/lagou/lagouspider.py)、[智联](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/zhilian/zhilianspider.py)、[Scrapy 51job](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/scrapy-51job/jobsearch/jobsearch/spiders/jobinfos.py)、[项目说明](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/README.md)。

### 生产使用前的缺口

代码可见 requests 调用没有显式 timeout、依赖固定旧结构；部分翻页异常被当成结束处理，存在把结构变化/网络失败误判为采集完成的风险。保存层与爬虫耦合，不应对真实岗位库试跑。未观察到现代的来源状态、字段证据、去重/失效策略及精确坐标核验契约。

本次**没有**实际访问招聘平台，因此只能确认入口与解析规则年代久远，不能宣布它们已逐一失效，也不能宣布现在仍可用。源代码许可和招聘平台访问/数据使用授权是两个独立问题；即使获得代码授权，也不代表可以绕过登录、验证码、反爬或平台访问限制。

建议：先向作者确认代码及历史导出数据的授权范围；不要直接拷贝整仓或导入附带 XLS/XLSX。需要时在隔离合成样本与被允许的源上重建小型适配器，明确超时、节流、取消、去重、来源时间、失败/阻断/部分成功状态。每个平台单独验收，不以“脚本跑完”代替质量验证。

## 2. 955.WLB：适合发现候选企业，不是岗位工时保证

README 按公司列出主要城市，并明确说明：地区与部门可能不同，部分时期仍加班，个别公司可能更接近 975/985；名单不保证准确性。它是企业工作生活平衡线索，不是带当前岗位、劳动合同工时、办公楼地址与坐标的数据库。

例如公司名称后的部门排除说明必须保留，不能把一个公司名匹配成功就传播为全公司的确定事实。抓取时间应与原始报告/核验时间分开记录；仓库 2025 年有提交并不代表全部老条目 2025 年已复核。

许可方面，未发现明确授权条款。因此当前可作为用户查看原始依据的外链参考及候选来源；批量复制、派生和随产品分发名单前，应取得作者许可或确认适用许可，不能称“完全开源所以直接拿来”。

证据：[指定快照 README 与声明](https://github.com/formulahendry/955.WLB/blob/eff96b0b20a5fc71d1d51cd9ff0c225eb5da140e/README.md)、[指定快照目录树](https://github.com/formulahendry/955.WLB/tree/eff96b0b20a5fc71d1d51cd9ff0c225eb5da140e)。

## 3. 996.ICU：有证据和撤销记录，仍需范围及时效约束

- `blacklist/README.md`：包含城市、公司、曝光/施行时间、制度描述与证据链接；另有标题为“已取消996名单列表”的表，其中一些行的说明是条目被无故删除、缺乏证据或存在争议。该分区只应视作名单条目撤销/争议记录，不能仅凭分区标题推断企业已取消 996 制度；是否实际改变必须看相应证据。贡献规则要求证据、隐藏个人信息；声明强调时效、公信力、部门差异与纠错。不能只扫公司名把撤销表也加入当前风险标签。
- `whitelist/README.md`：标题是 965 良好制度名单，含城市、公司、时间、制度与证据，不等于全部是 955。可见各条工时及午休安排不同，必须保留原始制度，不能统一显示“八小时”。
- `remotelist/README.md`：定义为可跨城市居家协作、劳动合同及五险一金等要求的公司目录；按五险一金账户所在地分目录，**不是办公地址地理编码**，也不是当前岗位在全国任何地点都可雇佣的保证。

对应路径最近修改：blacklist `78c11d11c1aadcc5042d3221aeea295e394964ca`（2025-08-22T06:00:11Z）；whitelist `72875d5f6b95a5eaafabb263fa4257edbf736082`（2020-11-25T10:26:17Z）；remotelist 目录 `8acf4aaacf56db0df9e7756ee7b49718d1d712a7`（2019-04-23T15:31:46Z）。这比根仓库更新日期更能提示白名单/远程资料的陈旧风险，但仍不能替代逐条检查。

根 LICENSE Anti996 1.0 Draft 允许使用、复制、修改和分发等，同时要求保留许可/通知，并包含适用劳动法律、劳动权益相关条件。不能误标为 MIT，也不应只保留一个 GitHub 来源链接便认定完成许可义务。应在接入时保留许可与归属，审查所用文件及第三方证据的独立权利；不要复制员工截图或个人信息进入产品。

证据：[blacklist](https://github.com/996icu/996.ICU/blob/f5e35f48d769bf92ed885888bfe911d3e5b5a63d/blacklist/README.md)、[whitelist](https://github.com/996icu/996.ICU/blob/f5e35f48d769bf92ed885888bfe911d3e5b5a63d/whitelist/README.md)、[remotelist](https://github.com/996icu/996.ICU/blob/f5e35f48d769bf92ed885888bfe911d3e5b5a63d/remotelist/README.md)、[LICENSE](https://github.com/996icu/996.ICU/blob/f5e35f48d769bf92ed885888bfe911d3e5b5a63d/LICENSE)。本报告不据社区名单作法律定性。

## 4. Remote In Tech：结构化远程企业候选与招聘官网入口

当前公司内容在 `src/companies/{slug}.md`。贡献模板有公司网站、招聘官网、地区、远程政策、公司规模、技术栈；地区枚举区分 worldwide、americas、europe、americas-europe、asia-pacific、other；远程政策区分 fully-remote、remote-first、hybrid、remote-friendly。正文要求企业简介、远程状态和申请方法。

贡献规范要求可核查企业信息、直接雇佣与真实远程机会；它仍是社区目录，规范或自动字段校验不证明每家公司正在招聘、某岗位接受中国居民或具备相应劳动关系/税务安排。招聘官网链接适合作为进一步获取岗位事实的入口。

当前 README 标 ISC、递归树只发现根 LICENSE，未发现公司内容另行 CC0 的声明。应按当前快照明确许可及保留要求处理自有仓库内容，不把旧版本许可印象外推到当前版本。根 LICENSE 同时说明网站模板含 MIT 组件及 SIL 字体；如仅使用企业目录，不需要复制网页模板/字体，但若复制它们必须分别履行其条款。公司网站、招聘页或用户贡献中的第三方原文不因聚合进入仓库就必然取得无限再授权。

证据：[README](https://github.com/remoteintech/remote-jobs/blob/fa2253f1ed02cc4d8f59ab3ccc831b008cdd7189/README.md)、[贡献规范及 schema](https://github.com/remoteintech/remote-jobs/blob/fa2253f1ed02cc4d8f59ab3ccc831b008cdd7189/CONTRIBUTING.md)、[公司目录](https://github.com/remoteintech/remote-jobs/tree/fa2253f1ed02cc4d8f59ab3ccc831b008cdd7189/src/companies)、[LICENSE](https://github.com/remoteintech/remote-jobs/blob/fa2253f1ed02cc4d8f59ab3ccc831b008cdd7189/LICENSE)。已有 996.ICU remotelist 可作为中国远程线索补充，本次未扩大到其他未经核查的目录。

## 5. BetterMe 接入建议：先证据层，再派生标签与筛选

建议分开三种记录：岗位原站事实、企业工作制度声明、办公地点/远程雇佣范围。

955/996 声明只能作为单独的社区证据层，不允许直接覆盖当前岗位的 remote/workMode、workhours 或雇佣地区等原站字段。本次用户请求是评估接入，不代表已授权复制第三方代码、批量导入名单或实施大规模采集。

每个外部声明至少保存：

- 来源仓库/文件、固定 revision、原始证据 URL、许可及归属信息；
- 公司规范化 ID 与别名，适用城市/部门/岗位范围；名称模糊匹配只作候选，不自动传播标签；
- 原文制度、工时/休息日/加班/远程分别的结构化值，无法确定就未知；
- 原始报告时间、实际核实时间、抓取时间分别记录；缺失时间不补造；
- 状态：社区线索、原站明确、已人工核实、已过期、已撤回、有冲突；保留多来源矛盾而非互相覆盖。

展示可用“社区 955 线索 · 公司级 · 部门待核实”“历史加班报告 · 2019 年 · 查看依据”“远程友好企业 · 本岗位未确认”，避免无依据的“955 认证”“确定双休八小时”“全国居家”。岗位正文的明确说明可以提高本岗位证据强度，但仍应显示来源与发布时间。

地图仅对可验证办公点落点；企业总部、城市中心、社保城市、远程可工作地区采用不同语义，不能冒充岗位办公地址。远程岗位适合独立列表/图层与地区筛选，不宜为了增加地图覆盖率生成虚假坐标。新外部来源先在隔离数据中验证授权、字段覆盖、重复率、失效率、地址精度、状态真实性，再考虑写入正式索引。

## 6. 现有代码接入点与优先级（建议，尚未实施）

本轮只读检查了 `packages/opportunities/src/schema.ts`、`packages/source-adapters/src/index.ts` / `registry.ts` 以及 `apps/web/src/components/AtlasWorkspace.tsx` 的相关片段：

- 岗位域已有 `workMode`、`remoteEligibleRegions`；字段证据已有来源 URL、观察时间、原文引用以及 verified / unverified / conflicting / unknown 状态。可以复用证据基础，但岗位级远程字段不能被公司目录自动改写。
- 当前公司模型没有独立的结构化工时、周休、值班或工作制度声明集合。建议新增可独立撤回/更新的 `CompanyWorklifeClaim` 证据实体，再依据公司身份和适用范围投影到岗位展示；这不是已确定的迁移方案。
- source-adapters 已导出 Greenhouse、Lever、Ashby、SmartRecruiters、腾讯适配器；注册器只运行显式安装的适配器，不会因添加 JSON 来源而执行外部仓库代码。存在适配器不代表本轮验证了所有来源当前在线可用。
- Atlas 实时结果由 `activeLiveHarvest` 驱动，本机索引统计与地图另依赖 `result` / `locatedBuckets`，并提供实时结果/索引切换。因此截图中的 4059 个匹配岗位与 772 个实时卡片不能直接比较成召回率或入库率。截图中地图显示国内而实时卡片为美国，属于范围一致性的明确待核对现象；本轮没有重放实际请求，不能据此认定唯一根因。

建议执行顺序：

1. **先收紧采集质量与范围一致性。** 对同一查询显式展示本轮原站卡片、已去重入库岗位、本机索引三个集合及地区条件；核对“国内”在各平台请求和返回结果上的落实。地图、当前列表与统计应共享已选结果集，切换集合时同步说明。来源被阻断、解析失败、仅取得卡片、详情缺失、部分分页、尚未入库必须分别可见。
2. **再补岗位事实和办公点。** 保留原始 JD、来源职位 ID/URL、原始发布时间与抓取时间、在招状态、薪资口径、雇佣主体、岗位城市/实际地址。每个平台报告字段覆盖率、去重/入库/过滤数量和办公点证据覆盖率，不能以卡片数代表完整岗位数，也不以城市中心坐标增加办公地图点数。
3. **增加工作制度证据层和企业身份核对。** 分开日工时/周工日/周休形式、加班/值班、远程模式与可雇佣地区；保留社区线索和岗位原文的冲突。公司同名、集团/子公司、外包主体、城市和团队范围匹配不足时，只进待核对队列。955/996 来源授权未明确前先登记来源与外链，不默认整库复制。
4. **最后增加偏好筛选与解释。** 双休、工时上限、加班风险、远程/混合、中国境内可工作、通勤距离分别筛选；未知项允许单独保留，而不是默认判作不符合或 996。不建议先做无证据的统一“好公司分”。

可验收的合成案例应包含：同名企业、母子公司、不同城市/部门规则、历史及撤回声明、多个转载同源证据、JD 与社区说法冲突、远程仅限其他国家、缺失办公地址、国内查询返回海外卡片、部分采集和部分入库。先用隔离数据及独立浏览器验收；本轮未触发正式采集或数据库迁移。

关于公开仓库与许可的区别，另参见 [GitHub 官方许可说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。代码许可、名单内容、第三方证据和招聘平台访问/数据使用约束需分开核查；本报告不是法律意见。

## 未验证事项

- 未运行任何爬虫，未测三个招聘平台当前接口、登录/反爬、可访问性及条款。
- 未逐一核实社区名单中的公司是否仍招聘、制度是否变化、原始证据是否仍可访问。
- 未取得 Jobs-search 与 955.WLB 作者额外授权，不能把授权缺口视为已解决。
- 未将这些资料写入产品岗位/企业数据；以上属于接入前研究，不是已实现功能或采集成功报告。
