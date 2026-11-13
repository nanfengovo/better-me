# BetterMe 个人成长操作系统：总体设计

2026-11-12 · **目标设计，不是发布说明。** 采用两份参考对话选定的方向：**产品以个人成长为中心；技术保留 BetterMe 自己的 Agent 内核，按需吸收外部项目。** Career 仍是职业资产的权威，但职业只是成长的一条路径。判断产品价值的标准是：用户隔一周回来，能否从一个本人选择的目标继续，找到上次的原始依据和真实成果，并决定下一步；不是 Agent 说了多少话，也不是接了多少模型。

[交互架构图](personal-growth-os-architecture/overview.html) · [可编辑图源](personal-growth-os-architecture-2026-11-12.json) · [首片交付契约与验收](personal-growth-os-first-slice-2026-11-12.md) · [领域词表](../../CONTEXT.md) · [四类外部能力的版本与许可调研](../research/career-voice-document-learning-integrations-2026-11-12.md)

## 一条贯穿六个领域的用户旅程

以「三个月建立 Agent 工程能力」为**合成示例**。用户选择第一周要能演示“只读工具已经执行，界面关闭后恢复不会重复调用”。他选一段公开或合成资料，学习关于断点的解释，做一次练习；把练习变成有固定输入、版本和测试的小项目。下次打开，Home 显示「测试已通过；能否独立解释仍待复测」，而非「已具备 Agent 工程师能力」。若用户想用于求职，Career 据原成果拟一段**个人练习项目**描述；不写简历也能完成成长闭环。

| 领域 | 谁说了算、持有什么 | 对外提供什么；不能做什么 | 当前可复用的接点 |
| --- | --- | --- | --- |
| Goals & Growth | 本人决定目标、时间预算与达成标准；Goals 持有目标版本、里程碑、任务关联、采纳的计划 | 给各域稳定的目标引用和待办；呈现「待验收／已达成／未知」。不能因换目标提高运行额度 | [Coach 目标确认](../../apps/web/src/lib/career-coach/journey.ts#L4)、[计划采纳与历史](../../apps/web/src/lib/career-coach/state.ts#L57)；稳定的跨域目标尚需新增 |
| Knowledge | 持有原件版本、可定位引用、结构化资料与索引 | 提供授权片段及页码/段落/代码行；一篇文档可支持多个目标。检索命中不能授予阅读整库的权限 | [资料导航](../../apps/web/src/components/ResourceLibrary.tsx#L7)不是知识库；[项目资料引用](../../apps/agent-host/src/understanding/evidence-broker.ts#L126)已有哈希、出处与节选 |
| Learning | 持有路径、章节、原答、评价依据、复测记录和能力观察 | 给出下一次学习活动；允许反馈被纠正。出题成功或模型评分不能成为工作资历证明 | [练习回执契约](../../packages/agent-contracts/src/career-coach.ts#L88)、[带证据的提交](../../apps/web/src/lib/career-coach/state.ts#L76) |
| Projects | 持有用户新建或主动关联的项目、交付物版本、验收条件、测试回执及个人贡献说明 | 向 Learning/Career 提供精确版本的产物与限制；确认“理解了项目”并不确认“由我独立完成” | [项目理解任务契约](../../packages/agent-contracts/src/project-understanding.ts#L36)、[项目来源与授权命令](../../apps/agent-host/src/tasks/http.ts#L72) |
| Career | 继续持有职业事实、简历版本、岗位材料、申请与面试的业务状态 | 引用知识、实践观察与项目产物起草候选；只有 Career 的校验、本人采纳及业务回执可改变职业资产。生成材料不等于投递 | [职业事实与工作台](../../CONTEXT.md#L9)、[职业工作台回执核对入口](../../apps/web/src/App.tsx#L443) |
| Insights | 对多个领域已有且获准的记录做可重建的读取、统计和带依据的复盘 | 可以建议调整目标、补材料或安排复测；不能替本人改目标、改成绩、写简历，不能把相关性当因果 | [反馈与未知结果的限制](../../packages/core/src/career-intelligence/outcome-feedback.ts#L149)、[只允许分析的重放](../../apps/agent-host/src/career-studio/replay-feedback.ts#L15) |

六个领域共享的是 **owner 范围内的带版本引用**，不是同一段文字在六个数据库的副本。Home、目标工作区和 Agent 都是它们的入口，不再建“首页个人档案”。

## 从参考图到产品交互

本次用独立浏览器打开了两个分享地址。公开界面的回复区域当时没有渲染正文，但**同一公开页面随页返回的回答**保留了三份 Mermaid 定义和架构、工作区、流程等富图卡，因此可核对分组及箭头方向。另逐张查看了 A 的学习题库、掌握路径、记忆、录音和朗读示意，以及 B 的知识图谱和交互书页。下表区分「参考资料展示什么」与「BetterMe 选择怎么做」；本文开头的交互架构图是新设计，不是对话截图或当前线上拓扑。

| 参考资料实际表达的关系或画面 | BetterMe 的设计取舍 |
| --- | --- |
| [A · 能力架构图](https://chatgpt.com/s/t_6af544ac4b708191bfd17e48612c256d)：Web/桌面/移动进入一个 Runtime，再分模型、语音、文档、教学、职业；语音分 STT/TTS/实时，文档分解析与翻译。图尾还有 Learning → Verified Capability → Agent 的回路。 | 保留同一入口和分路；**拆开最后一根箭头**。教学回传的是人的能力观察，供下次规划参考。只有方法或工具通过独立验证并获准启用，才能进入 Agent 的能力清单。测试是练习者的，授权是系统的，两者不是同一回事。 |
| [B · 统一执行循环](https://chatgpt.com/s/t_6af5461e25b481918d238c161d6d29b9)：规划后有「调用工具、询问本人、申请授权、申请完成」四种分支；观察回到上下文，Verifier 未通过也回到上下文，通过后才产生结果。 | 任务抽屉区分「等你补资料」「等你批准」「正在做」「结果待核对」。Verifier 验证本次产物；图中最后的记忆/目标更新，在 BetterMe 先产生修订建议，由相应领域确认，不是模型通写个人档案。 |
| [B · 个人对象关系图](https://chatgpt.com/s/t_6af5461e25b481918d238c161d6d29b9)：人关联目标和资料；Goal → Milestone → Task，任务通向 Artifact/Evidence，资料经 Knowledge 关联 Evidence，能力再反馈到 Goal。 | 把它落成有归属、有版本的多对多引用。资料支持「这份设计使用了某技术」与支持「这个人负责设计」是两种不同主张；知识与项目产物均可作为证据，**不从图上有边推断本人贡献**。 |
| A 的知识流程卡从资料、识别/翻译走到知识中心、学习、证据沉淀。证据卡用「原稿第 12 页」与待确认的本人角色举例；PDF 卡保留原件哈希，把英文版与双语版列为两个输出。 | 原文、译文、学习笔记分别存版本。点职业表述，先定位引用，再看「这能否证明是我做的」；下载提供「仅英文」「中英对照」，某页未能可靠翻译就标出页号和原因。 |
| [A · 学习题库原图](https://images.openai.com/static-rsc-4/_8Olw01bM5YwoOLZv6NKHfwQiAxQ0BaDAgcSjy0RnZHZ609oWCdzNRoQBKF0kNwjV2SeCtZPHnIGbHZeC-rexmfhYc41qJiWPnJArPRJreV9E09g-APMwNXu_vhGjB36oxmNGUzkISY63k_ky64fnXW185Ktn9Zv-p7lL9wkVu4?purpose=inline)有错题、收藏、答案解释；[路径原图](https://images.openai.com/static-rsc-4/5B4VvkiarfKS-zvNps6C51fJZjh8wMC78owjkMdabgahooyETUH8k87hnSFGhziKhcWGvNcQ6EFWxXA4Rdup4sLPCfQW1l4oYqm5CahM3dVSQExf0enx15V8STSISaTb9pzgMq-NI0cJDCunUmf3SKfiZ2sfD7tAgPqs5aVsglw?purpose=inline)分别显示已通过项与到期复习项。 | 下次打开直接推荐一道该复测的题，同时可回看上次原答和出处。收藏只是“我想留着”，不是“我已掌握”；不把 A 的十二周示例写死成默认承诺。 |
| [A · 录音输入示意](https://images.openai.com/static-rsc-4/ixnrfSOthCPR9QuoOl6GhmFRq3QMtviJrBnzaM5VQD8XGHNwIKIlwyNk9nR-I60Mwnk4lTsYE2O3-RExLZ65JERAHeKuVpIr15RIrvtfu97cDY7q66gdm7UICBvJ5hSEkiVTX3JmCUgsJuFFuSug9SqyQ3mdSeHdzVp1FrNcpW0?purpose=inline)有波形、时长、停止和发送；[朗读示意](https://images.openai.com/static-rsc-4/-9JPJtoVpcCg1d_dnAX_ycXHW4UQT3oL1bn2E3RGS3IYvUruye6tWV_uAXdWX4aD1RC8St2-Qmogckv-tpLeICRwtaAP0IVXt3ryPvtFu-oLGA7ATWlAE5NsFrLBq_lYzIZbZbmrAviBg-_AHxyFx7hpZlUe477huTb19FspSYY?purpose=inline)则有文本分段、选声和播放控件。这是两种不同交互。 | 消息旁的「朗读／停止」**不申请麦克风**。只有按下输入区的话筒才进入录音态；停止后展示能编辑的文字，由本人发送。首版不需要音轨编辑器，也不把波形当成「已发送」。 |
| [B · 知识图谱原图](https://images.openai.com/static-rsc-4/JKWhaP_A-5o1NfQtce4C75xQwocoDaedXTd2M23RuPBfhu-dgdv7DldiesPeWMYMT6C9RXS21vP-LC_S2VnjcBamev2zZ7I_3jk4F2N9yim98V7iq_HIlth0I8Ku_Z1xu73EjFvVVQBRVV8qyp-AmEyGX6xXP3a_xpCRwOVm24o?purpose=inline)：中间可搜索的节点与带标签的连线，底部按类型区分节点；右侧选中节点有说明、属性、时间和关联列表。 | Knowledge 首屏默认显示**当前目标的一小段关系**，可切换同内容的列表；点节点弹出来源抽屉，显示原件版本、页/段/框、关系性质和可访问状态。能点回原处才显示「有出处」；线多、节点大或匹配度高不代表证据强。 |
| [B · DeepTutor 书页原图](https://images.openai.com/static-rsc-4/112wHn3TlOnXv-qCzHY_Zs6A2hZGyIlaj1aVPUG3blBUJ7r7qQF-eJF4aIW1RaMj2yIA9zEjEsI2W-RoXtaD_UtKAFpJ24XwfXGNr5oON2wuLw1_Jca6nkZFbNo9x1czWfgA3DE4zEEKiJ0qUGRxC0_xNbIsdJwMOyqXxKVnAZk?purpose=inline)：书与章节目录在左；正文里有要点、选择题和单独的「查看答案」；右侧有本页目录，底部另列章节进度和学习摘录收件箱。 | Living Book 保留「目录—正文—就地练习」：选段可朗读、提问或存入**待审摘录**，不自动升为长期记忆。明确分开章节已生成、已阅读、已查看答案、已独立作答、已复测。「查看答案」不算答对，翻到最后一页不算掌握；章节重建生成新版，不覆盖旧作答。 |

这些界面图是参考样例，不是 BetterMe 的产品截图。B 的知识图谱来自 SharedMemoryAI 示意，不能当成 DeepTutor 或 BetterMe 的现成功能。图谱要回答「凭什么得出结论」，书页要回答「我现在能否不用提示做出来」；不照搬品牌、主题色或账户结构。

## 七层职责，先部署为一套本地应用

参考 B 的完整分层图把 **④领域与⑤能力并排**：前者判断「个人资产能否变更」，后者回答「任务可以怎样做」；不是每次请求都要从一数到七。图中的 TypeScript Core、Python Workers、Media Services、Infrastructure 是部署分组，也不是必须启动的四个进程。

| 逻辑层 | 模块接口与实际职责 |
| --- | --- |
| ① 体验 | Web/Electron 共用 React 页面与任务抽屉；键盘、选中文字、录音转写是同一个任务的不同入口。UI 可读投影、发明确命令，不自己判定业务采用。 |
| ② Agent 运行时 | 沿用 TypeScript Agent Host：把意图变成有预算与验收条件的任务；组装获准上下文、执行步骤、保存游标/回执、处理暂停和恢复。规划器可以提出下一步，不能直接写领域资产。 |
| ③ 个人上下文 | 从用户选择的目标、记忆、知识引用和能力观察组装**本次允许读取的快照**，保留版本与有效期。只索引领域记录，不另设“个人事实总表”。 |
| ④ 领域模块 | 上表六方各自校验命令、维护权威版本；跨域变更用提案及接收方回执。Goals 与 Knowledge 在③供检索，在④才有写权，不存两份。 |
| ⑤ 执行能力 | 注册可复用的工具、方法、MCP 连接和受限临时工作台，声明类型契约、权限、版本、验证情况。能找到某项能力，不代表能在这个任务里使用。 |
| ⑥ 提供方与工作进程 | 由适配器处理不同模型、语音、PDF、OCR 与教学协议。CPU/GPU 密集或依赖 Python 的作业可移出 Host；只收指定输入，回传进度和产物，不直连职业库。 |
| ⑦ 基础设施 | 本地身份与授权、按账号私有的业务记录、原件/产物、作业检查点和可重放事件。日志默认只记标识、哈希、耗时、费用与失败种类，不记原件、音频或模型密钥。 |

**部署选择：** 首版保留现有 React/Vite、Electron、TypeScript Host、`@better-me/core` 和 `@better-me/agent-contracts`；参考稿的 Vue/Pinia 与本仓不符，不迁移 UI。Host 在[经认证主体的私有目录](../../apps/agent-host/src/server.ts#L160)创建任务内核；当前任务是[逐任务私有 JSON，含归属检查](../../apps/agent-host/src/kernel/service.ts#L131)，不是一个已经运行的全局事件数据库。首版在原存储旁增加目标和引用的最小版本记录，不要求拆服务或引入 PG、Redis、S3、图数据库、向量数据库、SSE。领域关联表加索引即可；只有跨设备、并行写入、资产规模、后台队列或事件延迟出现可量化瓶颈，才按该项需要升级。在此之前不承诺云同步、公网多租户或跨设备实时一致。

## 执行、授权与恢复契约

- **Goal → Milestone → Task → Run → Step。** Goal 表示想达成什么，Milestone 表示怎样证明一个阶段已达成；Task 持有输入范围、交付物、额度和验收条件；Run 是一次获准尝试，Step 是该尝试的动作或等待点。一个 Task 可有多次尝试，一个尝试可产多份 Artifact；Step 完成不等于 Task 通过，更不等于 Goal 完成。`runId/stepId` 是拟新增的可寻址尝试/步骤记录；不能把当前 Kernel 的 `runGeneration`（过滤过期执行）当成已有完整业务 Run 表。
- **稳定目标不等于既有确认或任务根。** Coach 的[旧确认每次都会生成新 ID](../../apps/web/src/lib/career-coach/journey.ts#L14)，[旧记录的 `basis.goalId`](../../apps/web/src/lib/career-coach/state.ts#L41)指那次确认。新增 `growthGoalId`，目标变更升 `goalRevision`，可链接 `legacyConfirmationId` 和旧指纹；用户预览后关联，不按同名自动归并。`rootScopeKey/rootTaskId` 是已有的运行时和共享预算关系；`GoalTaskLink(goalId, milestoneId, taskId)` 是业务用途，不移动任务、不新建根、不重复记账。多个目标可引用同一已验产物；未归属旧记录原状保留。[根任务契约](../../packages/agent-contracts/src/career-task.ts#L14) · [旧记录关联限制](../reports/task-scope-association-2026-11-12.md#L3)
- **三种动作、三次不同判断。** `link` 仅关联可见记录；`dispatch` 可能外发或产生费用，需绑定用途、输入版本、接收方/端点、模型/工具版本、预算及当前会话授权；`adopt` 对特定领域资产写入，需预览、目标版本、候选哈希和幂等键。Host 从身份会话推导 owner，不接受正文自报。更换提供方、提高权限或源发生实质变化时停止并要求重新选择。资料中的指令不是授权，模型不得生成有效 grant。
- **兼容现有协议。** 客户端继续走 `/api/v1/agent/tasks`；读取列表/详情和 `GET …/:id/events?after=N` 用于重新连接（当前为逐任务 JSON 游标），`POST …/:id/start|resume|answer` 才请求执行。沿用 `expectedRevision + sourceFingerprint + runtimeBinding + consent`；重复相同请求核对原件，不同内容复用同一键报冲突。不要照抄参考稿 `/api/agent/runs` 建第二个工作队列。[真实路由](../../apps/agent-host/src/tasks/http.ts#L90) · [运行契约](../../packages/agent-contracts/src/career-task.ts#L99)
- **失败不是一种状态。** 缺资料→等待补充；撤权或账号切换→停止、丢弃迟到结果；输入修订冲突→读取差异，不覆盖；预算耗尽→显示剩余条件；宿主重启→`interrupted`，不重发。外部请求可能已收费/完成但回执丢失→记「结果未知」，仅查询作业号或本地收据；不能查询就等待本人决定，不自动换云重跑。停听进度不等于取消远端执行；“已请求取消”和“确认取消”分开标记。
- **事件不是写权限。** 拟新增跨域事件信封 `eventId, publisher, aggregateId, revision, type, taskId?, runId?, artifactRefs, occurredAt`，由 Host 绑定归属。`DocumentParsed` 只能使资料投影可更新；`PracticeVerified` 只添加对应观察；`CareerProposalAdopted` 只能来自 Career 的业务回执。每个消费者按聚合版本和事件 ID 去重；跳号回读权威记录。业务变更与待发布记录同存储时原子提交；跨私有文件/业务存储时保留待对账记录、按幂等回执修复。不可宣称跨库一次且仅一次；重建投影不重放付费调用、不签第二张业务回执。

## 知识、证据与三层记忆

以一次文档导入为例：Knowledge 持有 `SourceVersion`（原件 ID、版本、哈希、属主、许可与保存范围）；解析结果生成 `SourceCitation`（页码及框/段落、坐标约定、引擎版本、原始与规范化文本）。学习章节、项目说明、职业提案使用 `EvidenceLink(subjectRef@revision, sourceRef@revision, relation, scope)` 引用它，不复制原件。一个章节可引用多份资料，同一页可支持或限制多个主张；同一项目可服务多个目标，一项职业表述也可能需要项目产物、个人归属说明与其他证据共同支持。`supports` 不是认证，另有 `contradicts/uncertain`，保留不同结论、评价者和条件。

**修订与删除：** 原件变动产生新版本，不悄悄把旧引用移到新页。引用旧版且旧版仍获准时按原文回看；撤权、删除或过期则停止检索、摘要、路由与外发，投影显示「依据不可用／待复核」，重建缓存/索引。在适用的清除请求下删除主体可识别正文和衍生缓存，回执仅按保留策略留最少元数据；已经导出的本地文件或已交第三方的副本不承诺远程抹除。历史业务版本不静默重写；若其主张因此缺证，提示纠正、撤回或重新导出。

| 记忆层 | 可以存什么 | 升层和用户控制 |
| --- | --- | --- |
| L1 原始轨迹 | 本人选择保留的会话、原答、资料定位、模型或工具回执 | 记录当时发生了什么；可查看、限期与删除，不因保存就同意跨域检索或发送。录音默认不留。 |
| L2 经整理记录 | 带来源与范围的知识卡、本人确认的事实引用、特定练习上的能力观察 | 提取结果先待核，标出自述、确定性测试、独立复测等性质；职业事实始终引用 Career 的权威版本。纠正可回溯，撤回会使依赖项待复核。 |
| L3 阶段性理解 | 带时间窗的目标偏好、学习趋势与下一步建议 | 显示「为什么这样推断」、引用 L2/L1 和反例；允许拒绝、改正、设失效时间。采纳总结不自动改目标，更不训练外部模型。 |

区分三个“学习”：**人通过练习增长能力**（Learning 记录表现）；**系统更了解这个人**（本人可审阅的 L2/L3，不是后台持续训练）；**Agent 得到可复用的方法或工具**（见下节独立晋升）。三者不能共用一个“能力值”。

## 学习与知识如何变成项目

1. **Mastery Path**：由已审目标、时间预算、已有观察和授权资料拟出先修关系与里程碑；本人确认后才成为当前路径。自评、能解释、固定练习通过、换题独立完成、真实场景应用是不同维度，可以同时部分未知。失败保留原答，用于下次复测。
2. **Living Book**：一本按 `bookRevision → section → block → citation(s)` 组织的个人学习书。章节可由概念、例子、代码、图、题目、实践和来源块组成；段落问答只取当前选区及获准上下文。源文或路径变化时生成章节修订候选和差异，不覆写个人笔记、作答或旧版。全文检索先按归属和授权筛选；后续才将语义索引作为可删除的加速层。
3. **Practice-to-Project**：练习保存题目、原答、任务与验证回执。用户选择「作为项目继续」才创建 Project 并引用练习版本；后续新增独立工作目录、测试与归属信息。项目验收之后，Career 仍须另做个人贡献核对和措辞审核。DeepTutor 适合作为可关停的教学适配器或设计参考，不接管 BetterMe 的身份、长期目标或个人事实库；独立接入前不可用一个共享账号的不同工作区冒充用户隔离。

## 能力路由：一个 Agent，允许更换执行方式

**Provider 能力**说明某端点是否能处理某种输入；**Agent 执行能力**描述是否有一套经验证、适用于该任务且有权限的方法。注册 `reason.text`、`speech.play`、`speech.transcribe`、`speech.realtime`、`document.parse`、`document.translate` 等具体操作时，对输入、输出、语言、处理地点、引擎版本分型校验。路由先过滤用途、数据分类、设备/语言、功能要求和预算，再在允许集内按 Fast/Balanced/Deep 及成本时延排序；没有合格选项返回不可用与原因。云端只能经本人选择，禁用或失效不默认换供应商。Tool、Skill、MCP 和子 Agent 都在运行时同一额度和授权之内，不另借身份。

| 需求 | 设计与降级 | 接入前的放行条件 |
| --- | --- | --- |
| 四种聊天模型都能开口 | 先对**成功回复或主动选区**用系统本地音色点播；播放失败仍保留文字。再加按键 STT，转写可改后沿原 Task 提交；实时打断/双向音频是另一个适配器，不创建第二个语音 Agent。 | Web/Electron 分别验证中英音色、停止、撤权和不取麦；需要统一音色再试本机引擎。商业云 TTS 另选接收方，提示费用；Ollama 聊天模型名不等于该设备可用的中文发音引擎。 |
| 中文材料生成英文 PDF | **原生简历**：同一事实逐字段译稿+审核，现有模板导出；**外部文字 PDF**：原件交排版翻译 worker，明确 `zh→en`、翻译后端，产出单语/双语副本；**扫描或混合页**：逐页判定、必要时 OCR；能重建可靠文字层才做保版翻译，否则标为「英文重排版」。 | 校验页眉姓名、数字单位、阅读顺序、溢出和文字可检索性。[现有导出](../../apps/web/src/services/career-final-export.tsx#L25)复用；不要把 OXR 的 JSON 当成可直接交给 PDFMathTranslate 的原 PDF。 |
| 复杂资料理解或教学 | OXR 仅为可选版面解析器：区块、阅读顺序、原件坐标和不确定项是输出，不直接填职业事实。DeepTutor 接最小技能目标、教材引用与预算，产出路径/练习/复测反馈。 | OXR 免费 API 不送真实材料，独立校对代码和权重的不同商用条件，GPU 不是桌面前置。PDFMathTranslate 两系 AGPL，隔离运行不等于免除许可；DeepTutor 代码 Apache-2.0，第三方内容、部署认证、账号级记忆和删除另验。[逐项一手依据与固定版本](../research/career-voice-document-learning-integrations-2026-11-12.md) |

**Agent 能力晋升**是另一条受控路径：先区分缺工具、缺资料、缺授权、临时不可用；确有能力缺口才提出方法/工具候选。用合成样例独立验证，生成绑定源码/版本、测试条件、许可及结果的资格回执；试用、启用、升级权限、对外发布均不是同一动作，保留禁用和回滚。仓内已有[限定的能力生命周期](../../packages/agent-contracts/src/capabilities.ts#L35)、[固定配方的 QuickJS 验证](../../apps/agent-host/src/kernel/tool-builder.ts#L20)和[只给获准数据投影的沙箱界面](../../apps/web/src/components/SandboxedAppHost.tsx#L40)；不是已交付任意 npm 应用构建、默认联网或自动发布。首版动态工作台只组合受支持的资料、章节、任务与回执视图。

一个实际的路由例子：同一条中文回答可以由 DeepSeek 写、由系统本地声库读；点击已生成的正文只是播放，不重新运行生成回答的任务。若给英文增加 Ollama 发音适配器，要探测**具体端点和声音模型**：官方通过 `/api/show` 发现 speech/voices，合成另走 `/v1/audio/speech`；默认 Phonon 检查点面向英语。端点是远程地址时仍是外发，查不到中文声库不能标为支持中文。[Ollama 语音协议](https://docs.ollama.com/capabilities/speech) · [Phonon 适用范围与权重许可](https://ollama.com/library/phonon)

## 产品表面：从「去哪个菜单」变为「继续哪件事」

- **Home** 首屏只回答三件事：当前最重要的目标、上次停在哪里、本次能做什么。主入口可以是「继续上周断点练习」，次入口才是「审阅英文草稿／复盘」；无目标时邀请创建或继续原来的简历工作区，不自动代选目标。
- **Goal Workspace** 按目标展示本周里程碑，旁边是当前材料/学习书/练习/项目产物；选中页面或片段后打开出处，附证据才展示结论。「为职业描述准备素材」独立于「采用到哪版简历」，拒绝也不会让目标变失败。
- **全局 Agent 与任务抽屉** 在原处打开，明确列出当前目标、选区、将交给哪个模型、在本机还是云端处理。任务抽屉区分进行中、等回答、等批准、已中断、待对账；从桌面或手机重新打开默认读取同一记录，不重新执行。沿用[现有导航恢复](../../apps/web/src/lib/workspace-navigation.ts#L5)、[共享任务表面](../../apps/web/src/App.tsx#L463)和[桌面壳](../../apps/web/src/components/desktop/DesktopShell.tsx#L14)，而非把六域一次性替换成六套 CRUD 菜单。
- **多端是同一语义的布局变化。** 桌面 Web/Electron 用 Dock、资料与任务分栏；平板压成主文档+可收起侧栏；手机聚焦当次动作、快速记录、按键说话。三端共用领域组件、token、权限与状态说明；平板/手机原生应用、云同步和后台录音都是后续选择，不作为已交付能力。

参考 B 的桌面卡把一句意图输入、当前目标和 Learning／Projects／Career／Knowledge 四个快捷入口放在一屏；六域不必在首页等权平铺。BetterMe 保留「当前目标＋最近工作」作为主操作，四个入口仅作捷径，底部导航也不是必须复刻的功能清单。

## 推进与回退

| 阶段 | 可检验的交付门 | 失败时保留什么 |
| --- | --- | --- |
| 1 · 收敛骨架 | 按[首片契约](personal-growth-os-first-slice-2026-11-12.md)用一个目标/一段资料/一项实践证明可以查出处、断点续读、看完整回执且不重复执行；两个合成账号彼此不可见。六域先用已有表面，不要求六个新菜单。 | 目标关联与投影可关停；旧 Coach、Career 和任务历史可独立读取，不迁移未知归属。 |
| 2 · 文档、语音与知识 | 四种聊天适配器的一组成功回执可本机点播；确认英文候选后原生模板导出；用文字/扫描/混合文档测页级引用与失败提示。必要时才启用单独 worker。 | 退回文字、原语言 PDF、既有 PDF.js/视觉导入；原件不动，无云端静默补位。 |
| 3 · 学习与项目 | 同一技能经学习书、作答、隔时换题复测和有固定验收的项目形成可核查记录；Insights 只提议调整，用户能保留旧路径。 | 关闭教学适配器不丢失目标、原答、回执、资料版本及已获准的本地导出。 |
| 4 · 受控扩展 | 一项限定用途的能力在合成任务中完成提议、独立验证、本人启用、跨任务复用、撤权回滚；验证失败不能晋升，自扩权始终拒绝。 | 继续用内置能力和静态工作台；不为达成演示放宽权限或把样例制品公开。 |

**本稿的证据范围。** 产品定位和场景取自[参考对话 A：能力与开源组合](https://chatgpt.com/s/t_6af544ac4b708191bfd17e48612c256d)、[参考对话 B：个人成长总体架构](https://chatgpt.com/s/t_6af5461e25b481918d238c161d6d29b9)及其随附正文。上述代码锚点属于本机 `agent-os` 工作树（基线 `cafe1d0`，含未提交的并行实现），不是远端/安装包、真实模型质量、跨设备安全或此设计已实施的证明。

**架构图交付回执（仅验证图，不是产品验收）。** `architecture`，showcase 9/9，0 错误、0 警告，修正 2 轮；四个桌面尺寸的自动溢出检查通过，另已逐图查看 1440×900、2048×1320 的明暗校样，通过。[截图与尺寸](personal-growth-os-architecture/overview.visual-check.html) · [自动测量记录](personal-growth-os-architecture/overview.visual-check.json)。可编辑图源 SHA-256：`c45ab5c7a85d5fc2c43ead029dfae245cd670902fc717d2b9395848b15254256`；交付 HTML SHA-256：`d92f88e56755c2761dd6aacd5733cc682d081f734832f81e5b47f8caa150fa49`。
