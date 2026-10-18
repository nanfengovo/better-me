# 四个 Job Search 项目的非 Agent 能力对照

研究日期：2026-10-17（Asia/Shanghai）。本轮用户明确将 Agent 对话、成长计划和自动编排后置，先完善简历、岗位采集、记录与求职工作区。

本记录实时读取公开 GitHub 元数据、README、固定提交的源码、CSS、Schema 与许可文件；匿名 API 达到额度后，改用普通公开 Git 只读取得相同仓库提交和文件。没有运行上游应用、安装其依赖、执行其 Skill/爬虫、登录招聘平台或提交申请。下面的 UI 结论来自组件/样式和 README 中的图像链接，**不是上游应用运行验收**。没有将上游代码、字体、图片或岗位数据库复制进本项目。

## 1. 核对版本与真实形态

| 项目 | 本次固定提交与提交时间（UTC） | 实际形态 | 许可实读 |
| --- | --- | --- | --- |
| [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) | [`407dc34a2c4951e4ea3b047eaccdf2e4081a139a`](https://github.com/MadsLorentzen/ai-job-search/tree/407dc34a2c4951e4ea3b047eaccdf2e4081a139a)，2026-10-15 16:15:59 | CLI/Markdown 工作流 + 独立岗位搜索 CLI + LaTeX 材料；HTML 仪表板由指令生成 | 根 [LICENSE](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/LICENSE) 为 MIT，2026 Mads Lorentzen；随附主题/字体应另核验 |
| [Gsync/jobsync](https://github.com/Gsync/jobsync) | [`2bd2284879d2037883cbd21ee3283cf27138a671`](https://github.com/Gsync/jobsync/tree/2bd2284879d2037883cbd21ee3283cf27138a671)，2026-10-11 06:05:43 | 自托管 Next.js + Prisma/SQLite Web 应用；岗位、简历、联系人、面试阶段、任务与采集 | 根 [LICENSE](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/LICENSE) 为 MIT，2024 gsync |
| [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) | [`55a51658d17332c23b1d5383bc093e0a17b5df9f`](https://github.com/career-ops-hq/career-ops/tree/55a51658d17332c23b1d5383bc093e0a17b5df9f)，2026-10-16 17:56:45 | Node providers、Markdown/TSV 数据、Go TUI；当前提交还已有 Next.js `web/` 工作台 | 根 [LICENSE](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/LICENSE) 为 MIT，2026 Santiago Fernández de Valderrama；另有商标政策 |
| [Hopetree/Jobs-search](https://github.com/Hopetree/Jobs-search) | [`818eadfe519a83afda03629f098e8615f51b9097`](https://github.com/Hopetree/Jobs-search/tree/818eadfe519a83afda03629f098e8615f51b9097)，2017-07-31 05:44:22 | 拉勾、智联、51job 的 Python/Requests/Scrapy 爬虫与 Excel/MySQL/MongoDB/词云示例 | API `license:null`，本次完整 tree 未见 LICENSE；**不按可复制代码处理** |

注意：`pushed_at` 是仓库推送时间，不等于默认分支最新提交时间，本表采用实际 commit。没有以 star 数或 README 宣传推定兼容性、稳定性或效果。

## 2. ai-job-search：最值得借的是“原文和当时材料留档”

### 记录与材料

实读 [`outcome.md`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/.claude/commands/outcome.md) 和 [`apply.md`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/.claude/commands/apply.md)。它的 tracker CSV 字段为：

```text
date,company,sector,role,role_type,channel,status,contact_person,
fit_rating,notes,cv_file,cover_letter_file,source,deadline
```

- `drafted` 与 `applied` 分开：生成 CV/求职信只记草稿，用户报告已提交后再记投递。
- 每次申请保存 `job_posting.md`、当时 CV/求职信与 `outcome.md`；已归档的材料不因重生成覆盖。
- 同公司多个职位必须按完整职位定位，不能宽泛匹配公司名后拿到另一岗位的简历。
- 截止日期只保存来源明确提供的值；空值不能从发布时间或“尽快申请”推算。
- 跟进只针对已提交的开放申请，草稿不计算“公司多久没回复”；跟进草稿和真实已发送日志分开。
- 面试之后被拒，仍保留“曾到达面试”的历史；漏斗按历史到达阶段统计。

**对 BetterMe 的直接价值：**每个岗位关联手动生成的材料快照、用户确认的提交时间、阶段历史和下一步。随后可补职位截止日期、联系人/渠道、实际沟通日志及当时 JD 的版本快照。不能把编辑简历、打开申请页、生成材料都算为已投递。

**不要照搬的缺点：**CSV 的部分写入约定要求备注不含逗号/引号/换行；这是其文本工作流的限制。BetterMe 应由结构化存储保留完整文字，并在 CSV 导出时正确引用/转义。该项目部分归档路径由公司+职位派生，README/命令也承认同名再次申请可能撞到旧归档；本项目应继续使用稳定机会 ID、快照 ID。

### 采集

实读 [`job-scraper/SKILL.md`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/.claude/skills/job-scraper/SKILL.md)、[`linkedin helpers.ts`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/.agents/skills/linkedin-search/cli/src/helpers.ts)、[`detail.ts`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/.agents/skills/linkedin-search/cli/src/commands/detail.ts)、[`job_key.py`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/tools/job_key.py)。

- 搜索与详情分离：先有限列表，再按需补 JD；每个来源 CLI 有统一 `search/detail` 和 JSON 输出。
- 区分 `portal`、`source: cli/websearch`、`first_seen`、原始 `posted_date`、`deadline`，避免把搜索索引命中当成刚发布。
- 岗位关闭检测保留来源证据。LinkedIn `isActive:false` 来自关闭标语；`true` 仅表示没发现该标语，不是已验证正在招。
- 具体代码有请求超时与有限退避；Markdown 健康检查要求将 429 记为限流/未能判定，不能据此称来源坏了。
- 去重 helper 专门处理非拉丁文字和截断碰撞，说明公司/职位 ASCII slug 不足以做中文职位身份。

当前内置主要为丹麦 Jobbank/Jobdanmark/Jobindex/Jobnet，加 LinkedIn guest endpoint 和 Freehire 聚合 API。**没有据此证实其能采集 BOSS、51job、猎聘**。本轮只借接口分层、来源/时间和健康状态，不照搬其 Agent 调用或公司+标题静默去重。

### UI

[`html-report.md`](https://github.com/MadsLorentzen/ai-job-search/blob/407dc34a2c4951e4ea3b047eaccdf2e4081a139a/.claude/commands/html-report.md) 给出“统计卡 → 状态/行业/渠道/漏斗图 → 可筛选表格”的离线页面设计，包含彩色阶段 badge、空值 `—`、默认日期排序和联动筛选。**它是生成指令，不是仓库中现成可接入的 Web UI 实现。**

可采纳：先使可筛选岗位表成为主体，再以少量统计卡补充；没有真实阶段数据时不摆虚构漏斗。未分析岗位显示“未分析”，不要默认给匹配分。

## 3. JobSync：非 Agent 工作台结构最接近当前需求

### UI 和记录模型

实读 [`JobDetails.tsx`](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/components/myjobs/JobDetails.tsx)、[`JobsContainer.tsx`](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/components/myjobs/JobsContainer.tsx)、[`JobsViewToggle.tsx`](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/components/myjobs/JobsViewToggle.tsx)、[`job.model.ts`](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/models/job.model.ts) 和 [`schema.prisma`](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/prisma/schema.prisma)。

- 岗位页面支持 **table/cards** 两种模式；源码不是按阶段的拖拽 Kanban，不能混称。
- 搜索、公司/职位/地点/来源范围、状态/工作方式/雇佣方式 facets 与排序分别组织；同字段 OR、字段间 AND。
- 岗位详情按 **原文、时间线、AI Match、求职信、联系人、备注** 分页，长文本不挤在列表里。
- `Job` 有可空 `appliedDate/dueDate`，关联具体 Resume、CoverLetter、Notes、contacts、stages。
- `JobStage` 保存 `occurredAt/isCurrent`，可关联面试官及准备问题；比仅存一个当前状态更适合回看真实流程。
- `Company` 保存官网、招聘页、行业、规模、watchlist 和 ATS 来源；适合在多个岗位间复用公司信息。
- JD 完整程度单独分 `title-only/partial/full`；只有标题的记录不能装作已经取得完整 JD。

README 的现成图像证据（本轮只读取引用，不声称已打开运行）：[dashboard 截图](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/screenshots/jobsync-dashboard.png)、[jobs 截图](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/screenshots/jobsync-jobs.png)、[match 动图](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/screenshots/jobsync-ai-jobmatch.gif)。

**对 BetterMe 的具体改进：**让列表/看板负责挑选和推进阶段；右侧详情保留“岗位原文 / 跟进记录 / 当时材料”，来源和时间可展开。下一步再加截止日期、待办到期、联系人和公司页。保留当前自研简历多视图，不用引入其整套账户/Prisma/AI chat 才能借这些交互。

### 采集边界

当前 README 与目录包括 Greenhouse、Lever、Ashby 的公司 board adapters、discovered 待审清单和自动搜索运行记录。它适合借“指定公司/board → 采集 → 待审 → 接受进个人机会库”的路径。原始来源、发现清单和个人已接受岗位应保留区分，不把全量发现自动记为自己准备投递。

其详细 Greenhouse/Lever adapter 在同轮来源实现工作中另行核验；本文没有运行任何实际 board。README 宣称“数据不离开服务器”也不能覆盖用户选择云模型时的推理请求。无证据表明这些 ATS adapters 能直接读取国内登录招聘平台。

## 4. career-ops：源码已有 Web，重点借 provider 契约和跟进队列

### 当前 Web UI，不能只看 README 的 TUI 介绍

当前 tree 已有 `web/src/app` 的 pipeline、explore、portals、scheduled-scans、followups、analytics、documents、cv 页面，以及 Go dashboard。实读：

- [`pipeline-view.tsx`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/web/src/components/pipeline-view.tsx)：统一 URL 维护 tab/min/sort/dir，搜索可本地即时输入，详情返回保留查询条件；批选和状态写入有成功/失败处理，确认保存成功后再更新显示。
- [`triage-row.tsx`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/web/src/components/inbox/triage-row.tsx)：紧凑一行展示公司/职位、地点、ATS、年龄；未分析明确 `not scored`，收藏/跳过和分析分开。
- [`followups-view.tsx`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/web/src/components/followups/followups-view.tsx)：ALL/OVERDUE/URGENT/WAITING/COLD，展示下次跟进、实际跟进次数；只有用户实际发出邮件/消息/打电话后 `Log`，并可手动指定下次日期。
- [`report-view.tsx`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/web/src/components/report-view.tsx)：详情优先展示关键结论，其他长报告折叠；PDF、求职信和申请检查清单分别有入口。
- [`globals.css`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/web/src/app/globals.css)：统一语义色 token，暖白/深色表面、强调色、小字对比度和字型分工；移动导航处理 Escape、焦点、减少动效与安全区域。可借一致性和可读性做法，无需复制品牌颜色/图形。

README 的 [`docs/demo.gif`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/docs/demo.gif) 是已有演示引用；仅靠它不能断言当前 Web 运行无误。此前“只有 Go TUI”的判断应以本次固定提交源码修正。

### Provider 与来源契约

实读 [`_types.js`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/providers/_types.js)、[`ADDING_A_PROVIDER.md`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/providers/ADDING_A_PROVIDER.md)、[`greenhouse.mjs`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/providers/greenhouse.mjs)、[`tencent.mjs`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/providers/tencent.mjs) 与 [`mokahr.mjs`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/providers/mokahr.mjs)。

- 统一 `id/detect/fetch`，请求经共享 context 的 `fetchText/fetchJson`，允许 timeout、页数、节流和诊断收敛；每个来源独立适配，避免所有网页都套通用 selector。
- 标准 Job 先有 title/url/company/location，可选 description、postedAt、salary、language、externalId、requisitionId；不额外请求即可取得的正文尽量保留。
- **posting ID 与 requisition ID 分开。** 一个 requisition 可能有多地点/多级别的多个 posting，不能凭 requisitionId 一样便合并；职位 URL 和源内 posting ID 更适合身份，相关 req 只作提示分组。
- 腾讯 adapter 展示企业官网 JSON 路径、关键词分页、限页、间隔及中途失败保留已有结果的方式；这是当前源码证据，不是本次腾讯实站成功证据。
- MokaHR 源码明确自己用的是前端私有接口，并有加密响应、租户、分页与 WAF 差异；不能因代码存在就当成稳定官方第三方 API。优先选维护成本低的公开企业源。

**必须纠正后才能借鉴的语义：**腾讯 `parseTencentResponse` 将 `LastUpdateTime` 映射为统一 `postedAt`。BetterMe 已约定原始发布/平台刷新/发现/采集/核验分离，若未来采用腾讯 adapter，应映射为 **`sourceUpdatedAt`**，原始发布没有则留空，不能直接沿用其 `postedAt` 名称。

[`states.yml`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/templates/states.yml) 给 writer/dashboard 共用规范状态与别名；[`career-ops.ts`](https://github.com/career-ops-hq/career-ops/blob/55a51658d17332c23b1d5383bc093e0a17b5df9f/web/src/lib/career-ops.ts) 的 Application 有 `via/applyLink/followUp/notes`。可借统一状态、渠道与实际跟进记录；不必采用 Markdown 表作为本产品主库。

Agent 的评估、研究、生成 PDF、联络建议和自动流水线本轮后置；读取来源、保存岗位、更新个人记录可以完全不依赖 Agent。

## 5. Hopetree/Jobs-search：历史采集教学，不能充当今天的国内平台能力

实读 [51job/jobspider.py](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/51job/jobspider.py)、[savedata.py](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/51job/savedata.py)、[Scrapy items](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/scrapy-51job/jobsearch/jobsearch/items.py)、[pipeline](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/scrapy-51job/jobsearch/jobsearch/pipelines.py)、[lagouspider.py](https://github.com/Hopetree/Jobs-search/blob/818eadfe519a83afda03629f098e8615f51b9097/lagou/lagouspider.py) 和完整 tree。

- 51job 通过旧 HTTP `search_result.php`、GBK 和 `#resultList > div.el` 提取名称/链接/公司/地点/薪资/日期，再递归下一页。
- Scrapy items 还保存学历、经验、福利、规模、正文和地址，体现“原始文本与可筛选列分开”的基本做法。
- 拉勾使用旧 `positionAjax.json` 和页码；存储各有 Excel/MySQL/MongoDB。按来源拆 parser、按关键词/城市查询以及导出结果的基本分层可作历史参考。
- 没有当前 BOSS/猎聘/LinkedIn adapters，也没有个人投递状态、联系人、材料快照或求职工作台；图像是词云示例，不能当产品 UI。
- 最新提交在 2017 年，旧 Python/Scrapy API、固定页面 selector、宽泛异常、未设请求超时、字符串拼 SQL/固定数据库配置等不适合直接移植。
- 未见明确 LICENSE；不复制其代码/示例数据/字体/词云图。本次没有运行爬虫，也没有证明这些旧接口今天仍可用。

因此，此项目只提供历史的字段/采集分层启发，当前国内平台应做新的、逐站真实样本验证的适配，不导入这套老爬虫宣称“已兼容51job”。

## 6. 对当前 BetterMe 可直接执行的增强顺序

| 优先级 | 非 Agent 增强 | 采用依据 | 验收标准 |
| --- | --- | --- | --- |
| 当前 | 岗位机会库：原文、来源/发现/申请链接、发布主体、独立来源时间、未知状态 | 四库的记录/来源分层；BetterMe 原始要求 | 不依赖模型可录入/编辑/备份恢复；日期缺失显示缺失，不据 Remote 推断资格 |
| 当前 | 列表/阶段看板 + 详情原文/跟进/材料 | JobSync 的列表和详情分工、career-ops 的紧凑收件箱 | 一个筛选结果驱动列表与数量；换视图不改变记录，不把“查看链接”记成投递 |
| 当前 | 具体简历视图和当时材料快照 | ai-job-search 的提交归档、JobSync 的具体 Resume 关联 | 用户手动快照可查看/下载，之后改简历不改旧材料；生成快照不改变投递阶段 |
| 当前 | 手动采集公开公司 ATS 的待审列表 | JobSync 的 discovered review、career-ops providers | 指定 board、来源清晰、限制体积/请求/时间，逐条选中后才收藏，失败不影响原库 |
| 随后 | 截止日期、联系人/渠道、实际沟通日志、到期/逾期队列 | ai-job-search deadline 与跟进、career-ops followups、JobSync contacts | 草稿无“未回复天数”；跟进日志仅记录用户确实做过的动作，可改期而不伪造已发送 |
| 随后 | 筛选可恢复、排序、筛选chips、材料/JD版本关联 | career-ops URL参数、JobSync facets、ai-job-search archives | 从详情回列表保留筛选位置；同岗位的新JD不覆盖投递时旧JD |
| 随后 | 可复算历史漏斗、公司聚合、机会地图 | ai-job-search按历史阶段统计、JobSync公司页、既定地图约定 | 面试后被拒仍计曾到达面试；公司名称计数和实体归一分清；地图每个数回到具体记录 |

当前应优先把“发现一份岗位 → 核对原文 → 收藏 → 选简历/留材料 → 本人提交后记录 → 跟进 → 结果”做完整。任务提醒、日历、联系人都可以是普通确定性产品功能，不必等 Agent；邮件读取、自动发送、自动投递、AI研判和长期学习不纳入本轮的实现前提。

## 7. 采用状态和可复用范围

本记录是方案对照，不代表已经集成四个上游工程。BetterMe 当前业务实现和真实验收以本轮报告/代码为准。MIT 项目可在核对具体文件和依赖后择段复用并保留许可/NOTICE；本次没有复制代码，不需要将参考来源宣传成依赖。无明确许可的 Hopetree 仅借设计观察。根许可证也不自动覆盖主题、字体、商标、截图、第三方网站岗位数据或采集权利。

本轮后置：CLI prompt/Skill、Agent 多步评估、自动排名/学习规划、邮件/Notion同步、自动填表/提交和多代理运行。这些项目的宣传或模式文件不能替代可运行功能与中国平台实测。
