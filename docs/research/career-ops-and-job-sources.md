# 求职运营与职位来源：源码与数据核验

研究日期：2026-10-16（Asia/Shanghai）。适用方向：个人技术岗社招，国内为主、探索海外；保留现有简历事实底座，下一阶段优先建设对话规划与契约学习闭环。本轮只研究和写文档，没有运行外部仓库代码、安装其 Skill、登录招聘平台或投递。

## 结论与来源状态

三个用户来源均已取得当前公开内容并完成对应研究。资料来自父任务实时下载的 GitHub API/raw 文件缓存；子任务最初的网络限制已通过父任务的合法只读访问解决。下文区分 README 声明、源码证据、数据检查与集成推导。

| 用户来源 | 实际定位 | 访问状态 | 对当前方向的价值 | 许可核验 |
| --- | --- | --- | --- | --- |
| [career-ops-china](https://github.com/shuheng-mo/career-ops-china) | Claude Code 驱动的国内求职工作流、Markdown modes、Node 工具与可选飞书适配 | README、LICENSE、完整目录树、关键 mode 与源码读取成功 | **高**：对话规划、求职红线、面试复盘回流、岗位采集边界 | **MIT**，保留上游与中国定制作者版权 |
| [xixicc2027](https://github.com/xixicc186/xixicc2027) | 秋招聚合数据、静态页面和读取数据的 Agent Skill | README、tree、jobs.json、Skill、Python 脚本与页面模板读取成功 | **低优先线索源**：主要校招/实习，与技术岗社招错位 | API `license:null`，许可证端点 404，tree 无 LICENSE；未获得明确复用授权 |
| [SimplifyJobs 组织](https://github.com/SimplifyJobs) | GitHub 组织，含招聘清单和多种工具仓库 | 组织仓库列表及两个代表性招聘仓库的 README/tree/贡献指南/JSON 读取成功 | **海外探索参考**：资格、新鲜度、关闭状态和结构化数据；主要应届/实习 | 两个职位库均未声明许可且 tree 未见 LICENSE；不可套用组织其他仓库许可 |

本轮未做实站验收：不能据此保证平台登录后当前页面兼容、任意 ATS 可填、岗位仍开放、候选人具有海外资格或自动投递已可用。来源文件随分支变化，文中计数是当日读取快照。

## 1. career-ops-china：优先借鉴工作流，不能整包当 SDK

### 已读证据

- [README](https://github.com/shuheng-mo/career-ops-china/blob/main/README.md)、[LICENSE](https://github.com/shuheng-mo/career-ops-china/blob/main/LICENSE)、[package.json](https://github.com/shuheng-mo/career-ops-china/blob/main/package.json)。
- [tools/README.md](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/README.md)、[本地 inbox 服务](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/jd-inbox-server.mjs)、[BOSS bookmarklet](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/bookmarklets/boss-zhipin.js)。
- [LinkedIn 脚本](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/linkedin-jobs.mjs)、[腾讯招聘脚本](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/tencent-careers.mjs)。
- [apply](https://github.com/shuheng-mo/career-ops-china/blob/main/modes/apply.md)、[training](https://github.com/shuheng-mo/career-ops-china/blob/main/modes/training.md)、[project](https://github.com/shuheng-mo/career-ops-china/blob/main/modes/project.md)、[story-sync](https://github.com/shuheng-mo/career-ops-china/blob/main/modes/story-sync.md)、[radar](https://github.com/shuheng-mo/career-ops-china/blob/main/modes/radar.md)。
- [tracker 端口](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/tracker-backend.mjs)、[Bitable backend](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/backends/bitable-backend.mjs)、[状态定义](https://github.com/shuheng-mo/career-ops-china/blob/main/templates/states.yml)、[飞书 mode](https://github.com/shuheng-mo/career-ops-china/blob/main/modes/feishu.md)、[架构文档](https://github.com/shuheng-mo/career-ops-china/blob/main/docs/ARCHITECTURE.md)。

### 实际形态

这是 `santifer/career-ops` 的国内定制项目。核心编排方式是 Claude Code 读取 `CLAUDE.md` 和 `modes/*.md`，按手册调用工具、写报告、生成简历和更新 tracker。大量智能行为仍由模型遵循 Markdown 指令完成，不是可直接 import 到 React/TypeScript 的完整 Agent SDK，也不是独立多用户 Web 产品。

A–F 工作流覆盖角色摘要、CV/JD 对照、职级策略、薪酬与公司调研、定向改写、STAR+R 面试准备。目标画像、城市、薪资和公司/工时/派遣红线作为配置，适合比单一匹配分更长期的求职决策。当前 `package.json` 依赖有 `marked` 和 `playwright`；脚本包括 PDF、去重、状态归一、tracker、采集与可选飞书。文件存在不代表每个 mode 都有独立可靠的机器执行器。

### 中国平台与数据接入的真实边界

| 来源 | 当前源码/说明 | 已证实 | 尚未证实 |
| --- | --- | --- | --- |
| BOSS 直聘 | 专用 bookmarklet 约束主岗位容器、排除推荐侧栏、HR 签名补充公司名，抽标题/薪资/城市/JD，POST localhost | 有平台专用 DOM 提取代码，保留 `company_from_card/company_from_hr` 便于核对 | 没在当前真实页面验收；selector、懒加载、公司名启发式会漂移 |
| 猎聘、拉勾、Mokahr、大厂 SPA | tree 有对应 bookmarklet，tools README 有使用说明 | 平台文件存在，按用户当前已打开页面采集 | 本轮没有逐个执行，不能说全平台稳定 |
| 跨域 Mokahr iframe | README 要求新标签打开 iframe URL 后再采集 | 明确承认跨域限制与人工回退 | 不是通用跨域读取 |
| 微信公众号、小红书 | README 转用户截图 | 有人机协作回退路径 | 没有证据证明可通用直接抓取 |
| 腾讯招聘 | `tencentcareer/api/post/Query`、`ByPostId`，分页、过滤、按岗位 ID 去重并存 inbox | 有公开 JSON 接口适配器源码；`--days` 用最后更新时间 | 未调用实站，不能保证接口当前稳定，也不等同受支持开发者 API |
| LinkedIn | `jobs-guest/jobs/api` 返回 HTML，搜索/解析，识别关闭、限页、节流、429 退避 | 有具体读取适配器 | 未验证地域/匿名访问限制；不等于自动申请 |

主路径是：**用户已登录并看到 JD → 点击 bookmarklet → 本机 `127.0.0.1:8787` 接收 JSON → inbox → Agent 评估**。这复用已有浏览器会话，不能读取用户本来无权看到的内容。README 的“绕过登录墙”“失败率 >90%”“唯一稳定方式”是作者表述，本轮不把它们当实测结论。

本地服务确实绑定 loopback，但开放跨源请求，未见调用令牌或严格 payload Schema，部分字段直接参与文件名。若移植，应借统一 capture 格式与本地接收思路，重做入口校验、来源确认和文件名约束，不能把 localhost 当完整权限边界。

### 自动投递：保留用户提交

README 禁止替用户点击 Submit/Apply。`apply.md` 的流程是读当前表单、加载评估上下文、生成问题回答并供用户复制；用户确认已提交才更新 Applied。因此它是岗位选择与申请辅助参考，不能当“中国平台自动投递已实现”的证据。填写和提交若以后做，需另建动作协议、授权与真实验收。

### 持续提升：方法值得借，学习状态仍需产品化

`training.md` 从目标对齐、面试信号、时间、机会成本、风险、作品产出评估课程/认证；建议时输出 4–12 周、每周交付与 scoreboard。`project.md` 评估岗位信号、差异、演示、指标潜力、MVP 时间、STAR 潜力，要求 one-pager、demo、postmortem。这比推荐一长串课程更契合用户的契约学习。

`story-sync.md` 区分报告初始 STAR 和面试前后 mock 笔记，以 canonical project key 去重，回流真实问答、Reflection、代码骨架并保留来源。但模型预生成报告不能成为候选人经历证据；应采用“完成产出/复盘 → 证据 → Proposal → 本人核实 → Fact 更新”。

这些 Markdown mode 不证明已具备独立学习任务库、履约状态机、测验评分器和掌握度跟踪。BetterMe 的下一步需要显式任务、验收、时间预算、暂停/调整、复盘状态，不能把“写出周计划”计为闭环完成。

### tracker、飞书与云端雷达

统一 tracker API 可按配置分派到 Markdown 或 Bitable；Bitable 模式以云表为唯一写源，Markdown 是导出快照。状态包含 **Blocked/待补证据**，属于非终态：补齐项目证据再回到可申请状态。这能直接连接求职差距与学习计划。

飞书是可选适配；mode 描述显式 profile/scope、dry-run 和关闭时本地降级，Bitable 源码经统一 lark-cli 出口。接入飞书意味着外部存储/日程/通知，不能一概叫全部数据只在本机。

`radar.md` 明确云 routine 没有本地私有简历、浏览器和 lark-cli，只做线索发现，不能假装已完成本地评估或写 tracker。值得借运行环境分工；Claude routine API、个人环境 ID、固定目录与命令不宜成为 BetterMe 永久协议。

架构文档有漂移：仍描述旧 Dashboard/Puppeteer/6 archetypes，而当前 tree/package/README 已是归档 TUI、Playwright 和不同角色配置。复用应按源码与场景验收，不照抄历史完成度。

### 复用判定

- **优先借鉴**：对话澄清、硬红线先筛、A–F 多维决策、Blocked 证据闸门、Interview Pack、面试复盘增量回流、读取/计划/保存/提交分开。
- **可按 MIT 条件择段复用**：状态/去重辅助、capture 字段、部分站点适配器、格式化脚本；保留上游与定制作者版权及 LICENSE，先审依赖和 Windows 兼容。
- **需重构**：Markdown modes 转成可验证工具协议；文件 tracker 转 storage 端口；个人路径/固定端口/Claude CLI/Unix shell/飞书环境从配置注入。
- **不直接复制**：作者画像、拒绝公司名单、薪资/市场的绝对判断、稳定性数字、私有环境、跳过 Fact 核实的自动写入。

## 2. xixicc2027：可读线索，人群与完整性限制明显

证据：[README](https://github.com/xixicc186/xixicc2027/blob/main/README.md)、[jobs.json](https://github.com/xixicc186/xixicc2027/blob/main/jobs.json)、[Skill](https://github.com/xixicc186/xixicc2027/blob/main/skill/qiuzhao-feed/SKILL.md)、[Python 脚本](https://github.com/xixicc186/xixicc2027/blob/main/skill/qiuzhao-feed/scripts/fetch_render.py)、[HTML 模板](https://github.com/xixicc186/xixicc2027/blob/main/site_template_heytea.html)。

它提供公开秋招记录与页面。纯 Python 标准库脚本每次从 GitHub raw 拉 JSON/模板，按行业、关键词、截止天数过滤，再生成本地 HTML。Skill 只是这条读取/渲染流程的自然语言入口，未实现自动投递、面试评估或持续学习 Agent。tree 未见公开上游采集管线；README 所说公开聚合、LLM 提取、多渠道校验不能用于审计每条原始来源与准确率。

数据字段包括公司、届别、批次、项目、行业、岗位方向、地点、申请 URL/微信/二维码、deadline、campus_only、first_seen/last_seen、confirmed_by；没有完整岗位职责、任职要求、经验年限或独立原文证据字段。它更像公司/批次入口，不是完整职位 JD 库。

| 当日 JSON 检查指标 | 数量 |
| --- | ---: |
| 记录总数 | 402 |
| 2027 届 / 2026 届 / 不限 | 194 / 32 / 176 |
| 实习批次 | 107 |
| 缺少申请 URL | 281 |
| 岗位方向为空 | 213 |
| 地点为空 | 198 |
| 缺少 deadline | 398 |

README 页头同时写 401，与 JSON 402 不同，是非原子文件快照；不能把每天更新当零误差保证。有 DeepSeek“不限”条目指向 Mokahr social-recruitment，但一个公司入口含多方向，不等于已核实的多条社招 JD。另有 2027 届条目 `campus_only:false`，所以这个布尔值不能直接判社招资格；`confirmed_by` 也不等于官方当前在招。

对于当前用户，不应设为默认社招主源；适合作为可关闭的行业/公司动态探索源。可借鉴届别/批次/临期/首次发现等字段，先导为 `JobLead`，用户选择后从官方详情补全为 `JobPosting`。缺字段就显示缺失，不让 AI 补造。未获得明确许可证前，不直接复制其 Python/HTML/Skill 或再发布完整数据；公开可访问不等于代码与数据的再利用授权。

## 3. SimplifyJobs：应届/实习清单，不等于商业 Copilot 已开源

### 组织识别与代表库

已读[组织公开仓库列表](https://api.github.com/orgs/SimplifyJobs/repos?per_page=100&type=public)。其通用工具中有 MIT/Apache 仓库，但不能推广到其他仓库。选中两个与求职直接相关的代表：

1. [New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions)，默认 `dev`，当前 README 是 2025/2026 新毕业生技术岗。
2. [Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships)，默认 `dev`，当前是 2027 暑期技术实习。

两库 README、tree、CONTRIBUTING 与 `.github/scripts/listings.json` 均已读。Summer README 超 1MB，contents 初读为空，后改 raw 成功，不属于来源受限。重要来源：[New-Grad 贡献规则](https://github.com/SimplifyJobs/New-Grad-Positions/blob/dev/CONTRIBUTING.md)、[New-Grad JSON](https://github.com/SimplifyJobs/New-Grad-Positions/blob/dev/.github/scripts/listings.json)、[Summer 贡献/维护指南](https://github.com/SimplifyJobs/Summer2027-Internships/blob/dev/CONTRIBUTING.md)、[Summer JSON](https://github.com/SimplifyJobs/Summer2027-Internships/blob/dev/.github/scripts/listings.json)。

### 数据、维护与地域人群

两库按软件/产品/数据AI/量化/硬件分类，展示公司、岗位、地点、Apply 外链与职位年龄；图例有不提供 sponsorship、美国公民要求、关闭、进阶学位等。Summer 另有 inactive/off-season/历史归档。

贡献规则明确以美国、加拿大或 remote 为范围，要求正规 ATS；非 ATS 表单/问卷需额外审核，New-Grad 还要求 recently graduated。实际样本会有其他地区，需按条目筛，不能只用仓库定位推断资格。这里的 remote 也不能解释为可从中国跨境任意工作。

Summer 维护指南明确数据来自 issue 审批和**外部 microservice 每日读取 Simplify 数据库**，再经 GitHub Action 更新 JSON 与 README。README 又描述商业服务每小时监测公司招聘页；这不证明完整商业采集器公开，也不是一个对 BetterMe 承诺稳定性的开发者 API。

| 当前原始数据快照 | 历史记录数 | 关键结构 |
| --- | ---: | --- |
| New-Grad listings.json | 19,579 | id/source/category/company/title/active/is_visible/date_posted/date_updated/url/locations/sponsorship/degrees |
| Summer listings.json | 17,315 | 同类字段，另有 terms（如 Summer 2026/2027） |

这些是包含旧年与关闭岗位的历史总数，**不是当前可投数量**；README 的当前展示数经筛选另算。数据未提供完整 JD 正文，需到原申请页补全。原始 JSON 比 README 装饰性 HTML 表格更适合作适配入口，但仍受许可和源变更约束。

### 自动化和复用边界

README 外链出现 Greenhouse、Workday、iCIMS、SuccessFactors、公司 careers 与 Simplify 职位镜像，也推广 Simplify Copilot/安装页。**产品外链和广告不等于本仓库包含完整 Copilot 扩展源码**。目录中是职位维护、数据和生成工具，没有证据证明公开通用自动填表/提交执行器，更没有找到 BOSS/猎聘/拉勾适配证据。

当前社招方向与这两个应届/实习库错位，不宜做默认岗位主源。可用于海外公司/需求探索，优先借鉴资格先筛、关闭状态、新鲜度、社区纠错和结构化原始数据与展示分离。两个具体库未见明确许可，不直接复制生成器/数据/模板，更不能因为同组织工具有 MIT 就套用授权。

## 4. 对 BetterMe 下一阶段的影响

优先闭环应是：**对话澄清目标/约束 → 可追溯的证据差距 → 用户认可的短周期契约 → 作品/测评/复盘 → Proposal → 核实后更新 Fact → 重评目标岗位**。career-ops 的课程 ROI、Interview Pack、Blocked 和故事回流最有帮助；xixicc/Simplify 提供市场信号，不能承担学习引擎。

建议先形成概念契约，再写业务代码：

| 对象 | 要解决的问题 | 真实性边界 |
| --- | --- | --- |
| CareerGoal | 岗位、城市、薪资、时间预算、红线、探索方向 | 目标不代表已具备能力 |
| JobLead / JobPosting | 线索/完整JD、来源、时间、资格、缺失字段、关闭 | 外部信息单独存储更新 |
| SkillGap | 引用哪条JD与哪条现有Fact、为何优先 | 模型评分不当客观能力测量 |
| LearningContract | 承诺、预算、验收、暂停/调整、中断重规划 | 不自动增加 Fact |
| LearningTask / Evidence | 状态、作品链接、测试/讲解、时间与反馈 | 真实产出是候选事实证据 |
| Proposal | 提议哪项变更、接受/拒绝与依据 | 用户确认后才写 Fact |
| InterviewStory | 草稿、Fact引用、真实问答、Reflection | 是事实的视图，不建第二主库 |

来源端口可统一输出 `sourceUrl/sourceId/fetchedAt/captureMethod/completeness`，先做手动粘贴/官方链接/用户触发采集，再按真实社招价值加入一个站点。区分发布时间、源更新时间、采集时间；外部网页/仓库文本是数据，不是 Agent 指令。

保持本地结构化存储为事实主源；Markdown、飞书、故事库通过端口/投影衔接。云端雷达只做它拿得到信息的事情。读取、生成计划、保存草稿、写第三方、发消息、提交申请应是独立动作；对话规划不默认授权全部外部写入。下一阶段先完成学习闭环，表单执行留作后续可选能力。

建议验收：一条目标 JD 和现有 Fact 能形成有引用、有限预算、可协商的契约；完成必须有产出/测评，不因打卡自动“熟练”；中断后解释重规划；事实变更走确认并能追溯；外部来源显示资格/缺失/日期，不把未验证接入包装为稳定能力。

## 后续尚需核实

- 选一个与本人技术岗社招匹配的真实职位，实测粘贴/链接/采集质量；本轮未运行任何外部脚本。
- 若复用 MIT 代码，审依赖、路径、输入边界和 Windows 适配；没有实站验收就标“实现证据”。
- xixicc 与两个 Simplify 职位库需获得明确代码/数据许可后再决定复制或再分发；本轮“未见许可”不是最终法律结论。
- BetterMe 独立设计契约状态机、测评、证据与 Proposal；Markdown mode 不能替代这些产品验收。
