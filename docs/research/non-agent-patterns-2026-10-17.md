# 非 Agent 层：开源做法与当前落地点

研究日期：2026-10-17（Asia/Shanghai）。本轮根据用户“Agent 层先不急、先做好非 Agent 层”的新顺序，对公开 GitHub 元数据、README 与下列关键源码做了只读核验；没有运行外部仓库或安装上游采集器。前半部分记录设计建议；末尾另列本轮 Greenhouse/Lever 官方公开 API 的实际试点与样本结果，不能据此宣称所有招聘平台接入已验收。

本轮优先服务“岗位保存 → 来源核对 → 选择简历 → 手动记录投递 → 面试/跟进 → 结果留档”。职业对话、自动规划、学习契约和自主执行继续保留在远期路线图。

## 1. 当前值得采用的五个具体做法

### 1.1 机会条目保留原链接、详情快照与来源时间

**来源证据。** Simplify 的 [listings.json](https://github.com/SimplifyJobs/New-Grad-Positions/blob/01ba0b0a34f31c28537f10a9fb82c7e15dc05c96/.github/scripts/listings.json) 有独立 `id`、`active`、`is_visible`、`date_posted`、`date_updated`、`url`、`locations`、`sponsorship`、`degrees`。样本的 `url` 直接指向 SmartRecruiters ATS；`active:false` 的记录仍保留，历史总量因此不等于当前开放数量。

JobSpy 的 [JobPost 模型](https://github.com/speedyapply/JobSpy/blob/1988484ac76ff9ae57784750346842e967e8ba10/jobspy/model.py#L155) 分开 `job_url` 和 `job_url_direct`，并记录 `salary_source`、薪资周期与币种。Reactive Resume 的 [postingSourceSchema](https://github.com/reactive-resume/reactive-resume/blob/ef0c187eb4748dc25c72500a0641c23d889aab12/packages/schema/src/applications/data.ts#L11) 分开 requested/resolved URL、读取时间、截断状态和失败原因，并明确读取时间不代表源发布时间。

**BetterMe 的落地。** 用户手动新建、现有 JD 粘贴/链接/OCR 都能保存为同一机会条目；至少保存公司、职位、地点/市场、正文、原文链接、申请链接、平台/官网、采集方式与观察时间。未取得的发布时间显示未提供，不用保存时间补值。招聘状态与用户是否展示/收藏分开；地图以后基于这组条目和共同筛选派生。

同 URL 提示已有条目便于更新，但没有稳定岗位 ID 时，不按“同公司同标题”静默合并。工作地点、远程资格和工作授权保留人工可修正值；`Remote` 不能推导为可在中国工作。

**阶段边界。** 此轮先保存和查询用户选中的机会；公司官网与原始平台仍是正式数据接入主源。个人库是早期验证手段，不能替代已确认的未来正式地图覆盖要求。Simplify/xixicc 未见明确许可，当前只借字段设计，不直接再发布其整库数据。

### 1.2 投递用统一阶段和事件时间线

**来源证据。** career-ops 的 [states.yml](https://github.com/shuheng-mo/career-ops-china/blob/67d317bba2f5ed3eca3f321c5f10389995905511/templates/states.yml) 统一机器 ID、显示标签与别名；[tracker.md](https://github.com/shuheng-mo/career-ops-china/blob/67d317bba2f5ed3eca3f321c5f10389995905511/modes/tracker.md#L16) 要求日期独立于状态，区分 Applied、Responded、Interview 和终态，Blocked 为可恢复的非终态。

Reactive Resume 的 [application schema](https://github.com/reactive-resume/reactive-resume/blob/ef0c187eb4748dc25c72500a0641c23d889aab12/packages/schema/src/applications/data.ts#L3) 使用 saved/applied/screening/interview/offer/closed，并将关闭原因独立记录；[timeline](https://github.com/reactive-resume/reactive-resume/blob/ef0c187eb4748dc25c72500a0641c23d889aab12/packages/schema/src/applications/data.ts#L156) 包含 stage/note/interview 三类事件。

**BetterMe 的落地。** 收藏机会与个人投递进度关联但分开建模；可手动记录准备、已投、已回应、面试、Offer、结束及原因，保存每次变更时间和备注。公司关闭岗位不自动等同本人被拒，用户主动撤回也不等同公司拒绝。先给列表、按阶段计数、跟进日期和历史记录；看板可与列表共用状态定义。

手动登记“已投”必须由用户选择，打开原始申请页面不算已投。提醒先用到期清单或日历导出，不能默认代发邮件/消息或提交申请。

### 1.3 记录“当时投了哪一版”，避免材料随着编辑漂移

**来源证据。** Reactive Resume 的 [SentDocuments](https://github.com/reactive-resume/reactive-resume/blob/ef0c187eb4748dc25c72500a0641c23d889aab12/apps/web/src/features/applications/components/detail/sent-documents.tsx#L50) 使用 `sentResumeVersionId` / `sentCoverLetterVersionId` 打开只读发送版本，并区分“准备材料”和“已经发送”。

**BetterMe 的落地。** 机会可关联当前 ResumeView，但用户登记投递时应保存发送材料快照/版本、语言、模板、投递渠道和日期。之后修改事实或当前简历，不改写历史材料。现有历史仅最近 50 版，因此投递记录不能只引用一个未来可能被裁剪的历史 ID；应持有投递快照或具有独立留存策略的版本。

这也推动下一步多简历工作区：命名、复制、切换、按岗位关联、查看投递快照；各 ResumeView 仍引用同一事实底座，不能为每家企业制造互相矛盾的事实。

### 1.4 结构化内容与输出适配器分离，增加“导出后能读”的检查

**来源证据。** NewFuture/CV 的 [README](https://github.com/NewFuture/CV/blob/748b54d843fab4347a82943967ba8eedbeaa4ae6/README.md#L31) 将内容放 `_data/resume.yml`/JSON，布局与打印样式另存。Reactive Resume 的 [resume schema](https://github.com/reactive-resume/reactive-resume/blob/ef0c187eb4748dc25c72500a0641c23d889aab12/packages/schema/src/resume/data.ts#L507) 将栏目内容、主栏/侧栏、页面格式与排版参数分开，README 声明提供 PDF/Word/Markdown/JSON；其 [export 模块](https://github.com/reactive-resume/reactive-resume/tree/ef0c187eb4748dc25c72500a0641c23d889aab12/packages/resume/src) 可作为后续源码评估入口。

OpenResume 的 [PDF 解析入口](https://github.com/xitanggg/open-resume/blob/4f8255a2c763479837f69f1dccf2a3338730cd79/src/app/lib/parse-resume-from-pdf/index.ts) 与 [Parser 页面](https://github.com/xitanggg/open-resume/blob/4f8255a2c763479837f69f1dccf2a3338730cd79/src/app/resume-parser/page.tsx) 展示从 PDF 提取/分组后的字段，让用户检查解析结果；可借鉴“可检查的解析视图”，不能将单一解析器结果宣传为所有 ATS 认证。

**BetterMe 的落地。** 保持 Fact → 当前投影 → 输出适配器：新增 RenderCV YAML 等可交换格式时，仅转换当前可见内容，不直接泄露隐藏事实，也不迁移主数据模型。外部格式不能表达的排版/样式明确提示。后续 DOCX 与 PDF 的可读性检查应使用实际导出文件，验证中文、链接、阅读顺序、分页与遗漏，而不是只检查预览 HTML。

OpenResume 为 AGPL-3.0，此轮借方法并独立实现，不复制其解析器源码；MIT 项目若以后复制实质代码/模板，需补上游版权、LICENSE/NOTICE 和依赖检查。本轮建议不等于已经移植这些模板。

### 1.5 面试资料先作为带来源的手动资料索引

**来源证据。** Tech Interview Handbook 的 [README](https://github.com/yangshun/tech-interview-handbook/blob/e1d28e8886c0b6ff3e50da991ce0e895134ddc59/README.md#L24) 将算法主题、coding cheat sheet、行为题与简历准备分开，适合按求职阶段检索。海外手册、0voice 题集和 awesome-resume 索引的详细内容/局限承接现有 `interview-and-learning-sources.md` / `resume-and-template-sources.md`。

**BetterMe 的落地。** 先做用户可收藏的资源卡：标题、原始 URL、主题/技术栈、语言、适用阶段、已读/待看、个人备注与最近核验日期；可以从岗位或面试记录关联。此时不需要 Agent 自动推荐、自动评分或学习计划。只链接原文与独立摘要，不整包导入题解、付费课程或不明许可资料。

## 2. 补充候选及取舍

| 候选 | 本轮实时核验 | 当前值得借鉴 | 当前不直接接入的部分 |
| --- | --- | --- | --- |
| [JobSpy](https://github.com/speedyapply/JobSpy) | 原 Bunsly 地址会重定向；MIT；README + `jobspy/model.py` + LICENSE | 标准岗位模型、原站/直达链接、薪资来源、逐源错误和 warning | Python 采集器不是浏览器库；当前列出的站点不含 BOSS/51job/猎聘；真实限流/页面效果未测。优先考虑未来用户导入其 CSV，而非立即在 Web 主包运行 |
| [Reactive Resume](https://github.com/reactive-resume/reactive-resume) | 原 AmruthPillai 地址重定向；MIT；当前为 v6 方向；schema、stage、timeline、发送材料、CSV 源码已读 | 多简历工作区、投递状态、发送版本、日历/CSV、PDF 阅读顺序检查 | 无需把其 PostgreSQL、账号、Redis、AI 编排全搬入本地 BetterMe |
| [OpenResume](https://github.com/xitanggg/open-resume) | AGPL-3.0；README 与 PDF/parser 目录核验；最新提交仍为 2024-10-29 | 本地解析、查看解析结果、可导出 PDF 的最终预览 | 不直接复制源码；其“ATS friendly”是作者产品表述，不能当第三方全面认证 |
| [JobSync](https://github.com/Gsync/jobsync) | MIT；README、Greenhouse/Lever mapper、备份 manifest 源码已读 | 公司 watchlist、官网 ATS 分适配器、逐源失败隔离、版本化备份/导入预检 | 不搬入其 Agent 层、云模型匹配和全套服务器；平台数据并非 MIT 代码许可自动覆盖 |

JobSync 的 [Greenhouse adapter](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/lib/scraper/greenhouse/index.ts#L22) 有超时、并发限制和单公司错误隔离，适合未来官网主源试点；但当前 `postedDate: first_published || updated_at` 会混合首次发布时间与更新时间，**BetterMe 不采用这个时间回退逻辑**。[Lever mapper](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/lib/scraper/lever/mapper.ts#L21) 保留多地点、正文列表和 workplaceType 值，值得用于设计独立 adapter 合同。[备份 manifest](https://github.com/Gsync/jobsync/blob/2bd2284879d2037883cbd21ee3283cf27138a671/src/lib/backup/manifest.ts#L32) 记录格式版本与导出时间，导入前明确校验版本，可用于未来全工作区备份。

用户提到的 “JOB-search” 尚无明确仓库 URL，本文件不把它等同于 JobSpy、JobSync 或其他同名项目，也没有用未查询的 Star 数认定“热门”。

## 3. 九个原始入口：本轮快照与采用边界

下表通过 GitHub REST 重新核对默认分支提交与许可证元数据。除上文新读的具体文件外，其余内容分析沿用 2026-10-16 的三份来源研究，不能把元数据刷新说成逐行重审全库。

| 原始来源 | 本轮提交快照 | 许可观察 | 非 Agent 层采用方向 |
| --- | --- | --- | --- |
| career-ops-china | `67d317b`（2026-10-17） | MIT，已读 LICENSE | 阶段/状态字典、收件箱、材料/日期、手动投递辅助 |
| xixicc2027 | `191d214`（2026-10-16） | API license 为 null；此前未见 LICENSE | 校招批次/届别/截止日、线索与完整 JD 分开；不复制整库 |
| SimplifyJobs 组织 | New-Grad `01ba0b0` / Summer2027 `2f06e50`（2026-10-17） | 两具体职位库 license 为 null | 资格、原申请链接、关闭状态、新鲜度、历史与当前数量分开 |
| tech-interview-handbook | `e1d28e8`（2026-08-07） | MIT | 主题/阶段资料索引、手动准备清单 |
| 海外求职面试手册 | `5b5948c`（2024-02-25） | API license 为 null | 海外资格/简历/面试/谈薪资源入口，保留来源与时效 |
| 0voice 校招题集 | `8b9539f`（2025-07-16） | API NOASSERTION；实际 `LICENSE.md` 为 CC BY-NC-SA 4.0，并声明第三方版权 | 仅链接索引与自有备注，不导入统一题库或销售内容 |
| awesome-resume-for-chinese | `fefc06e`（2026-07-22） | API license 为 null | 模板发现索引；每个模板分别核验许可，不把清单许可套给模板 |
| RenderCV | `1d4b87b`（2026-03-25） | MIT | 可选结构化 YAML 输出与本地渲染；模板/资源适配独立于 Fact |
| NewFuture/CV | `748b54d`（2019-06-29） | MIT | 数据/布局/打印样式分离；中文语义化/打印样式参考，关注年代与依赖差异 |

补充快照：Reactive Resume `ef0c187`（2026-10-16），JobSpy `1988484`（2026-10-15），OpenResume `4f8255a`（2024-10-29），JobSync `2bd2284`（2026-10-11）。日期是 commit committer UTC 日期，不是岗位发布日、项目质量评分或平台稳定性证明。

## 4. 本批与后续验收

本批适宜交付：机会库/检索与状态统计、来源/时间可编辑、手动投递阶段与事件、完整本地备份兼容、当前投影的 RenderCV YAML 输出。真实验收应证明保存→刷新→筛选→状态更新→备份恢复的一致性，且旧简历备份仍可读；未取得的外部数据不生成虚假默认值。

后续按需求增量：多简历命名复制与投递版本留存、DOCX、CSV/ICS、一个可验证官网 ATS adapter、资料索引。国内/海外地图应在稳定岗位模型与统一查询完成后基于同一数据落地；持续主源同步仍单独验收。自动填表、外部通知和提交申请不包含在手动投递跟踪中。

## 5. 本轮追加：官网 ATS 主源读取试点

新增 `apps/web/server/opportunity-sources.ts`，提供 Vite dev/preview 插件 `opportunitySourcesPlugin()`；POST `/api/opportunities/source` 接受 `{provider: "greenhouse" | "lever", company: "公司 board slug"}`，只向两个固定官方 HTTPS API 读取。返回供用户核对/选择的最多 300 条标准 `OpportunityInput`，明确 `truncated`，不自动提交申请，也不自动写用户机会库。

固定 API 主机、slug 白名单、拒绝重定向、15 秒超时、8 MB 解压后响应上限、同源请求与 JSON/大小校验均有测试。原始地点留在正文“工作地点（原文）”，国家/省州/城市与市场保持未知；仅源明确 workplaceType 才设置工作方式，远程资格仍为空。board slug 不伪装成已核验公司全称；源未提供公司名时保留 slug。详情页/申请页/发现 API 分开保存，原始发布/更新/采集/核验时间分别记录，非法或缺失时间不回退补造。

2026-10-17 09:23–09:24（Asia/Shanghai），直接调用新增 TypeScript 函数和实际 Node fetch，读取公开岗位成功：

| 来源样本 | 当次结果 | 核对点 |
| --- | --- | --- |
| Greenhouse `duolingo` | 63 条，未截断 | 原页面 `careers.duolingo.com`；first_published 与 updated_at 独立；地点原文保留 |
| Lever `spotify` | 82 条，未截断 | hostedUrl/applyUrl 分开；createdAt 毫秒正确转 ISO；明确 hybrid 保留但不推断国家/资格 |
| Greenhouse `automattic` / `retool` | HTTP 404，明确报错 | board slug 需与来源匹配；公司名不保证等于 slug |

没有登录平台、写用户数据或提交申请。此验收证明当时两个样本公开 JSON API 可读取，不保证所有公司、国内平台或后续源变更一直兼容。8 项定向自动测试、Web 类型检查和定向 ESLint 已通过；主应用接线与用户选择入库由同轮主任务处理。
