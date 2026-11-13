# BetterMe Agent Harness：三种深化设计

研究日期：2026-11-10。源码观察对象是本地 `agent-os`，HEAD 为 `cafe1d074f39c919b8e20c701b28c26310cefa79`，**另含未提交的工作区源码**。下列行号是当日工作树坐标，不表示这些能力已发布、已合入此提交或已完成线上验收。本文是候选设计，不是业务或权限变更；未调用项目配置的模型或 CLI、读取真实简历、执行生成代码或实际发布。

**选择建议：当前迭代选 A，多个职业任务共用宿主时选 B，只有出现值得跨任务复用的工具才投资 C。** 三版的区别是把复杂性放在哪里，不是三套模型，也不是必须逐级升级。B 可内用 A；C 可作为 B 的一种工具后端。三者都不接管 Career Workspace 的写入权。

| 决策维度 | A · 现有循环＋证据工作集 | B · 宿主统一管理任务、事件、工件 | C · 受验证的本地能力包 |
| --- | --- | --- | --- |
| 最适合 | 同一任务读了很多材料，反而忘记关键证据 | Web/桌面需看同一个任务，多个场景各自重写暂停、恢复和审阅 | 多个任务反复做同一种确定性变换，或确实需要新的交互微应用 |
| 上下文单位 | 每次决策的按需原文窗口；摘要附可重读引用 | 每个任务阶段的状态快照、事件游标、证据/草稿引用；按当前目标编译窗口 | 能力清单、固定版本的输入输出、按页结果；任务历史依然要靠 A/B |
| 工具决策与执行 | 模型从本轮许可菜单选；Host 校验/扣账/取片 | 模型提议下一步；Host 以命令执行，同一本账写工具回执和工件，客户端订阅 | 先选合格版本；纯变换可不经模型执行。缺能力只能提案，不能自动安装 |
| 保存/恢复 | 沿用现有岗位任务，不保证其他模块受益 | 断线只重放可见进展；宿主重启后等待人工恢复；保存要有 Workspace 回执 | 已安装与本次获准分开；按版本/权限再核验。能力回滚不回滚已批准业务记录 |
| 主要代价 | 低；检索策略不佳会多花读取额度 | 中高；处理并发、迟到响应、双写、迁移和幂等 | 高；加入构建与运行隔离、验证、版本治理、供应链和撤权 |
| 判断做对的信号 | 更早的关键原文仍能被引用，少编造，不仅是提示词更短 | 同一任务从两个入口看到相同修订，断线/重试不重复执行或保存 | 新输入能复用同版本、独立验证通过；未验证/篡改包不能获准执行 |

## 先分清：当前有哪几条执行路径

| 路径 | 源码能证明什么 | 不能据此宣称什么 |
| --- | --- | --- |
| 普通聊天 | 主聊天识别明确的岗位定制意图时先打开授权面板并返回，普通消息走另一条路径。[AgentWorkspace.tsx:898](../../apps/web/src/components/AgentWorkspace.tsx#L898)；普通 Host 将 JD 截至 1,500 字符、选中文本截至 12,000 字符，把这次请求带入的消息序列组装后调用模型。输出过长最多续写两次，之后解析动作卡；3D 卡有特殊渲染分支。[chat-service.ts:157](../../apps/agent-host/src/chat/chat-service.ts#L157)、[186](../../apps/agent-host/src/chat/chat-service.ts#L186)、[208](../../apps/agent-host/src/chat/chat-service.ts#L208)、[232](../../apps/agent-host/src/chat/chat-service.ts#L232) | “续写”不是模型读到工具结果再选择下一步；不能由此推断普通聊天拥有后台取证权限。该 HTTP 路径在连接提前关闭时中止。[server.ts:699](../../apps/agent-host/src/server.ts#L699) |
| 岗位定制职业任务 | Host 先检查并扣本轮模型调用额度，再解析一个结构化决策；可读工具、问用户或提草稿。读工具后将实际结果加入记录，下一圈重新决策；非法决策会收到有上限的修复反馈。[tasks/service.ts:166](../../apps/agent-host/src/tasks/service.ts#L166)、[178](../../apps/agent-host/src/tasks/service.ts#L178)、[188](../../apps/agent-host/src/tasks/service.ts#L188)、[195](../../apps/agent-host/src/tasks/service.ts#L195) | 这里**已有选择—行动—观察闭环**，不需要重新发明一套 Agent 循环。当前决策协议是七个固定读工具及 `ask_user/draft`，并非任意 shell、MCP 或全站工具注册发现。[career-task.ts:66](../../packages/agent-contracts/src/career-task.ts#L66)、[tasks/evidence.ts:18](../../apps/agent-host/src/tasks/evidence.ts#L18) |
| 项目理解 | 独立的多步读取/综合机制：一轮默认允许 12 次工具调用，设合成阶段与有限协议修复。模型输入最多取近期 14 条消息、以 24,000 **字符**为近似上限（首条过长可例外）、最近 8 个仍授权的文件证据和近 4 次工具结果。持久旧消息还可经专门的 `conversation` 标识列举、按字面检索和按行读取。[understanding/service.ts:68](../../apps/agent-host/src/understanding/service.ts#L68)、[252](../../apps/agent-host/src/understanding/service.ts#L252)、[422](../../apps/agent-host/src/understanding/service.ts#L422)、[450](../../apps/agent-host/src/understanding/service.ts#L450) | 项目理解的同会话资料不自动成为职业任务证据。这个“短上下文＋受限历史检索”是有价值的本地先例，不是一套两者已经共用的权限或摘要机制。 |
| 其他专用路径 | JD 匹配图是结构化 JD→匹配→人工确认→输出的有条件固定流程。[jd-match/graph.ts:39](../../apps/agent-host/src/graphs/jd-match/graph.ts#L39)。本地职业评审委员会还允许角色从已授权目录请求限行证据，把观察交给该角色下一轮，表现出类似 ReAct 的取证循环。[committee.ts:112](../../packages/core/src/career-intelligence/committee.ts#L112)、[154](../../packages/core/src/career-intelligence/committee.ts#L154)、[169](../../packages/core/src/career-intelligence/committee.ts#L169) | 固定图、限定场景的角色循环、通用后台任务不是同一个运行时。不要为了架构图画得整齐就合并它们，或把内部观察、角色投票叫作业务成功。 |

### 眼前的瓶颈不是“有没有 Agent”，是证据能否重新进入上下文

当前职业任务每轮列出全部获准字段/材料的元数据，发送最新 **24** 个证据、每个摘录至多 **4,000 字符**，以及近 **8** 次观察；持久观察滑窗为 12。只算 24 个摘录，最多就有 96,000 个字符，还没算目录、规则和工具结果。这是字符切片，不是模型 tokenizer；不能换算成实测 token 或断言所有请求都会触顶。[tasks/service.ts:42](../../apps/agent-host/src/tasks/service.ts#L42)、[201](../../apps/agent-host/src/tasks/service.ts#L201)。配置模型适配器返回文本、当前任务运行时不返回 token usage；本地 Ollama 可带 JSON Schema，其他底座仍须通过 Host 的决策校验。[tasks/runtime.ts:48](../../apps/agent-host/src/tasks/runtime.ts#L48)、[tasks/service.ts:178](../../apps/agent-host/src/tasks/service.ts#L178)

「证据已保存」与「模型还能看到原文」也不同：同 ID 的重读结果不会把旧证据移到数组末尾；近期观察通常仅带工具、证据 ID 和附属元数据。因而超出 24 条的原文不能靠同样参数重读就保证重回 prompt。[去重与记录](../../apps/agent-host/src/tasks/service.ts#L198) · [简历读取响应结构](../../apps/agent-host/src/tasks/evidence.ts#L24)

可以直接构造另一个反例：允许简历字段的 `originalText` 长达 12,000 字符；非目录资料按行读取、默认至多 40 行，再截前 6,000 字符；一轮 prompt 只保留前 4,000。对于**单行 8,000 字符、尾部有唯一证据**的合成字段，换起始行不能取回该行的后半段，而草稿验证要求 `originalText` 与正式字段完整相等。这一读取路径无法可靠支持已承诺的字段大小；这里是静态可推导的测试样例，不是对某份用户简历的实测。[输入契约:40](../../packages/agent-contracts/src/career-task.ts#L40)、[取片:10](../../apps/agent-host/src/tasks/evidence.ts#L10)、[发送:48](../../apps/agent-host/src/tasks/service.ts#L48)、[比对:70](../../apps/agent-host/src/tasks/evidence.ts#L70)

同时不能丢掉已有护栏：默认全任务累计 **12 次模型、30 次工具、600,000 毫秒活跃时间**；恢复会比对来源与运行时，复核已引文件的内容 hash 并计工具额度。模型/工具下一动作都须过三维预算；配置模型禁 SDK 隐式重试，运行前后核对运行时和会话授权。工具读材料只能从本次提交中按 ID 命中，目录经 EvidenceBroker 检查真实路径、范围、符号链接、敏感内容和文件摘录限制。[预算契约:8](../../packages/agent-contracts/src/career-task.ts#L8)、[预算闸:28](../../apps/agent-host/src/tasks/service.ts#L28)、[恢复:119](../../apps/agent-host/src/tasks/service.ts#L119)、[文件复核:156](../../apps/agent-host/src/tasks/service.ts#L156)、[运行时:79](../../apps/agent-host/src/tasks/runtime.ts#L79)、[材料与目录:28](../../apps/agent-host/src/tasks/evidence.ts#L28)、[EvidenceBroker:181](../../apps/agent-host/src/understanding/evidence-broker.ts#L181)

## A · 一步推进：让模型取到该看的原文，不另建调度器

**主张。** 在现有 Career Task 执行循环内部放一个 Module：负责一次模型决策需要的上下文、一份本轮可用工具清单，以及最多一次实际观察。后台生存期、人工审阅、暂停/恢复仍归现有 Host；Career Workspace 仍是职业资产的写入权威。先改最难做好的那一步，而不要求所有聊天都变为任务。

### Interface 与调用示例（拟议，不是现有 API）

```ts
// 唯一供宿主调用的入口；ref 是 Host 签发的当前 Run 引用，不是浏览器任传的任务 ID 或 grant 数组。
advance(ref: ActiveRunRef, signal: AbortSignal): Promise<
  | { kind: "continue"; observationId: string }       // 已记下工具结果或被拒决策，不代表成功
  | { kind: "ask"; question: QuestionArtifact }       // 停在此处，等人回答
  | { kind: "review"; proposal: ChangeProposal; checks: VerificationReceipt }
  | { kind: "hold"; reason: "budget" | "source_changed" | "grant_lost" | "window_too_small" | "runtime_error" }
>

// 已有的宿主循环调用；不是 UI 连点多次，也不是创建新的 Task Contract。
const step = await harness.advance(activeRun, signal);
if (step.kind === "continue") continue;
return parkExistingCareerTask(step); // 等回答、等审阅或暂停；本入口没有“保存简历”命令
```

`ActiveRunRef` 解析为 owner、任务/执行代次、固定底座、当前授权和同一份预算账本；模型和客户端均不能制造它。每个 `advance` 至多一次计入任务额度的模型决策、至多一次计入额度的工具调用；协议修复要进入下一步并重新过预算，不能在 Adapter 内无限重试。已撤权、旧代次、来源改变或输入预留排不下时输出明确停止原因，不能裁掉关键限制“试一试”。进程重启仍由原任务生命周期要求人工恢复，不回放外部写入。

### Implementation 隐藏什么

1. **把源数据、证据索引和本轮投影分开。** owner 存储保留的是任务约定允许的快照/必要摘录及来源索引，而非任意目录镜像。每个片段带 `sourceId / sourceVersionHash / span / evidenceId / kind`；文件保留相对路径和行号，另定义可靠的行内偏移（例如 UTF-8 字节、不能切断码点）。对过长观察返回“省略了什么／下一游标／可重读句柄”。重新取片仍须检查 owner、当前授权和来源版本；摘要、文件名与索引项都不是证据。
2. **按模型窗口编译本轮输入。** 先预留输出及协议空间；固定保留 Task Contract 的目标、受限动作、权限/不确定性、未解决问题、当前目标字段及证据定位。再依次放本步需要的原文、近期成对的动作与观察、历史摘要索引；重复摘录按版本与 span 去重。必要时用确定性状态摘要；若采用额外模型生成摘要，把它明确计为一次独立调用及费用，不能无声插进上面的单步。不知道 tokenizer 或有效窗口时记录“估计”及依据，使用保守配置，仍不可保证则暂停；不是把中文字符串长度除以四就算完成。
3. **按能力和权限发现，不按提示词授予权限。** 当前只有七个固定工具，不值得盲目加一轮搜索。基础的任务内读取直接展示；没有目录授权就不展示对应目录工具。目录或其他候选开始多到挤占窗口时，才启用只返回当前许可交集的工具名称、适用条件和参数摘要的查询；真正执行再次校验。发现工具不能扩大资料范围、安装能力、静默引入新供应商或取得 Workspace 写权限。目录只能走原有 Broker，不能因为“文件是好接口”开放 shell。
4. **解决长原文与草稿校验的矛盾。** 能完整容纳目标字段时仍走现有逐字验证。过长而要编辑单句时，可在下一版决策协议增加 `fieldId + fullSourceHash + span + exactOldQuote + replacement + evidenceIds`：Host 在正式原文上核对版本、范围和旧句，组装保有完整 `originalText` 的现有提案，再执行逐句校验；偏移失效、旧句重复而无确切范围、未读到或引用过期都不提案。本版若不扩决策协议，就明确“检索可以成功，但该字段不能安全地产生编辑提案”，不要放松校验来凑成功率。[现有逐句、数字与归属校验:64](../../apps/agent-host/src/tasks/evidence.ts#L64)
5. **回执不混写。** Verification Receipt 记录这一版候选有哪些可复做的检查、命中哪些原文、哪些仍未知；不把团队证据推断为本人贡献，也不证明履历真实性。只有用户逐项批准且 Workspace 实际持久化并回读，才有 Business Receipt；Host 的“收到浏览器回报”不是第三方独立认证，更不表示投递。任务中的本人回答不自动晋升长期事实。[项目术语:67](../../CONTEXT.md#L67)、[Host 的回执与独立事实提案:226](../../apps/agent-host/src/tasks/service.ts#L226)

**依赖与 Adapter。** 调整片段优先级、预算分配、去重、选择工具菜单是进程内算法，无需先造插件接口；通过 `advance` 的结果测试。文件访问已有真实 EvidenceBroker 与合成目录夹具；底座已有配置模型/native CLI Adapter，可用固定决策的离线 Adapter 对照。给业务存储增加写 Adapter **不属于 A**：复用既有 Workspace 审阅与回读。真实提供方若报告 token/缓存命中要标成“实际”，不报告则记录本地估计、窗口假设和超限次数，不落明文提示或简历。

**取舍及反证。** 改这一处即可惠及岗位任务的每次决定；检索、窗口分配和工具菜单可以一起测试。不足是它只影响接入的职业任务，不解决插件供应链，也不能自动让普通聊天变为后台任务；激进延迟加载反会耗掉默认 12 次模型请求。用同授权、同模型、同总预算的合成样本对照：把唯一证据放在第一条，再加入 24 条其他证据；把唯一旧句放在单行第 7,500 字符；另测已撤权文件、只证明团队成果的材料。分别统计关键证据命中、正确拒绝、原文可回链率、额外工具/模型调用和 p95 输入 token（实测与估计分开）；**越权或编造任一项即失败**。不得用 token 下降掩盖漏证、错误归属或未经批准的写入。

### A 的一手依据与迁移界限

- **Cursor**：工程文介绍把长工具输出变成可重读对象、摘要后保留历史引用、按需载入工具说明。其 46.9% 是 Cursor 在**调用了 MCP 工具的样本**上的总 agent token 降幅，且方差较大，不是 BetterMe 的效果承诺。这里迁移“可找回＋延迟展开”，不迁移终端、文件系统权限或别人家的数字。[Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery)
- **Pi**：官方说明持久会话保留原始条目，模型下一次请求可采用“摘要＋保留边界后的消息”；压缩文档给出 `firstKeptEntryId`、预算和不把工具结果从相应调用拆开的规则。借鉴“持久历史不等于模型视图”；不把个人材料永久保留视为默认授权，也不把模型摘要当事实。[How Pi works](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md)、[Compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
- **Anthropic**：官方工具工程文推荐按任务选择少量有用工具、建立命名范围、分页/范围选择/过滤/明确截断，并让错误提示告诉模型下一次如何缩小请求。Claude Code 团队还公开比较了自由文本追问与单独的结构化追问工具。迁移到 BetterMe 是让工具返回可继续读取的结果，且把缺失本人贡献交给独立提问状态；不是复制 Claude 的通用工具箱。[Writing effective tools for agents](https://www.anthropic.com/research/writing-tools-for-agents)、[Seeing like an agent](https://claude.dev/blog/seeing-like-an-agent/)

## B · 同一个任务宿主：断线后看到同一份进度，而不是再跑一遍

**主张。** 把「人发出命令」「Host 推进任务」「界面读取进展」「工作区保存」分成不同操作。普通聊天依旧可以只聊天；明确启动的职业任务才进这个宿主。桌面关闭、另开窗口、换到审阅页不会创建第二个执行者。不是重写 LangGraph，也不要求一开始就改成全量事件溯源。

**公开接口（拟议）。** `command(taskId, expectedRevision, idempotencyKey, action)` 用于启动、回答、暂停、手动恢复、追加预算；`observe(taskId, afterSequence)` 用于只读订阅或补看；`readArtifact(ref, version, range)` 用于查看按当前授权裁剪的工件。读取/订阅不会调用模型、复活工作进程或重发工具。客户端无权自己指定 owner 或声明自己已经批准/保存。模型的 JSON 决策和提供方原生 tool call 是两个可替换的输入适配器，最后都变成同一种 Host 命令，不让原生调用绕过授权。

**实现取舍。**

1. 状态按 `owner + task + revision + attempt` 管理；一个有效执行租约。每次推进在同一持久事务或等价的可恢复记录中提交预算扣减、动作标识、状态转换与可观察事件。事件只放类型、序号、状态、证据/工件引用和可重试原因，不复制简历原文、凭据或模型的私有推理。证据索引、未答问题、当前差异稿独立版本化；给模型的是这一步需要的信息，不是整份事件日志。
2. 工具的权限检查在真正执行处：已授权读可在同一父账本下预留额度；提案不是写入；同一审批绑定相同字段版本、选中的差异和草稿哈希。晚回包、旧修订、换账号或撤权不能更新新状态。工具请求已送出但结果不明时标记 `outcome_unknown`，先按幂等键查已有结果/业务回执；不能确定就停，不能因客户端重试而再产生一次副作用。
3. 模型不用负责“记住自己跑到哪里”。例如先保存 `本人贡献待确认` 和项目材料的引用，等用户回答时才编译下一次输入。等待不计活跃时长；关闭窗口但 Host 仍工作时计入。Host 重启只显示中断与已有结果，手动恢复先检 owner、运行时、材料版本、授权与剩余额度。来源不再允许读取时，旧摘要及派生缓存也不可重新进入模型。
4. 正式保存仍在 Workspace：用户按句采用 → 写入新的岗位版本 → 回读真实版本与回执 → Host 记录对应任务结果。暂停、完成一次工具调用、生成草稿、通过格式校验，都不是「岗位版本已经保存」。恢复观察与恢复执行是不同按钮；事实更新是另一份提案。

**从哪里接。** 已有职业任务持久化、重启中断与逐句审阅；已有另一条 Run 路径按序号发布、恢复和推送事件。先为岗位任务做一份可订阅投影，沿用已有执行权，不迁移源业务数据；等项目理解成为第二个真实调用方时才抽共同生命周期。不要把 Graph 里名叫 `fanout`/`commit` 的节点当成已经执行的 worker 或已写入的业务版本；也不要认为 `SqliteSaver` 的内存降级支持进程重启恢复。[职业任务恢复](../../apps/agent-host/src/tasks/service.ts#L75) · [职业任务 UI](../../apps/web/src/components/CareerTaskPanel.tsx#L164) · [Run 事件接口](../../apps/agent-host/src/server.ts#L554) · [事件恢复](../../apps/agent-host/src/events/event-bus.ts#L42) · [Career Graph](../../apps/agent-host/src/graphs/career/graph.ts#L52) · [checkpointer 降级](../../apps/agent-host/src/checkpointer.ts#L36)

**外部可借鉴的不是 SDK 依赖，而是边界。** [Codex Agent Loop](https://openai.com/index/unrolling-the-codex-agent-loop/)说明一次模型决策和工具执行的关系；[Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)用 thread/turn/item、生命周期和审批使多个界面共享宿主。BetterMe 对应的是任务、一次主动执行、工具/问题/差异等条目，但人工审批和正式保存还需 Career Workspace 的语义。[OpenCode V1 Server](https://opencode.ai/v1/docs/server/)分开异步提交和 SSE 观察；它不是“有 SSE 就能持久恢复”的证明。[OpenCode V2 开发规格（固定提交）](https://github.com/anomalyco/opencode/blob/30e7a4d573cb8f83d186cef682569cb5758ad8f3/specs/v2/session.md#L5-L19)区分持久输入和模型对话，适作设计参考，不把开发分支规格当作发布保证。[Antigravity Artifacts](https://antigravity.google/docs/artifacts/)把计划、差异等成果给人异步审阅；对应的是**差异、依据、待确认项**的呈现，不是应用发布、业务审批或后台沙箱。

**何时值得。** 如果用户只用一个入口，B 的并发与迁移成本换不来多少收益。若聊天、桌面和审阅页都要操作同一任务，或项目理解与岗位定制反复实现相同中断规则，B 的公共接口就能让多处同时受益。验收看同任务两窗是否一致、客户端重连是否零新增执行、宿主断电后是否诚实展示未知、重复审批是否至多一个新版本；不是看事件日志有多长。

首个共用范围建议是**同账户、同一工作区、两个界面**；不能从“账号相同”推出“两个设备的本地简历库是同一权威存储”。协议可以先返回带事件水位的任务快照，再推后续序号；断点过期回到新快照。重复命令同标识同内容返回原接纳结果，同标识改内容拒绝；两个不同命令同时批准同一旧修订，最多一个成功。现有 [Workspace 只读对账](../../apps/web/src/lib/career-task-reconciliation.ts#L22)可以复用。检查已存在回执不等于重新派模型分析。若要实验另一种写法或派子 Agent 独立质疑，才产生新的计额工作；只给它必要片段、父任务内划出的额度和只读权限，不复制保存资格。

## C · 本地能力包：可复用的是通过验证的版本，不是模型生成的源码

**主张。** 如果任务反复需要一种稳定能力，例如“把两种岗位导出格式标准化”或“把带证据的改动显示为可交互逐句对比”，才值得把它变成独立单元。前者是 JSON 变换，无须浏览器；后者是视图，无须 shell。写正式简历仍不是两者的能力。这里所说的「发布」默认为**注册到该用户的本地私有能力目录**，不是部署服务、给第三方公开链接、写 FactBase 或投递。

**接口（拟议）。** `resolve(intent, taskScope)` 仅返回与本次授权相容的名称、版本、输入输出及开销；`invoke(versionRef, taskLease, boundedInput)` 才执行。另设独立的 `propose → build/test → approveInstall → activate/revoke` 生命周期；普通任务的 `invoke` 不能递归调用它给自己安装依赖。能力输入优先传小投影或受限引用；输出是有 Schema、可分页、可回查的结果/证据引用，不把全部中间日志塞进模型。匹配失败时回到普通手工工具、如实标记缺能力，或另行询问是否启动构建；**不换底座，不扩大资料范围**。

**本机其实已有几种不同的“沙箱”。** 设计能复用的部分，必须先认清它属于哪一种：

| 代码路径 | 当前做到 | 不足以证明 |
| --- | --- | --- |
| Studio → 构建 → 审批弹窗 → Dock 微应用 | 当前定制入口可按关键词选择内置源码模板；Host 用 esbuild 转译、静态检查及 `node:vm` 冒烟；通过账户约束的前端存储登记安装，iframe 仅 `allow-scripts`，Host 按 scope 投影数据，检查来消息的窗口，白名单动作回传为提案。[Studio](../../apps/web/src/components/AutopilotStudioWorkspace.tsx#L1858) · [Host 入口](../../apps/agent-host/src/server.ts#L401) · [构建](../../apps/agent-host/src/sandbox/build-service.ts#L69) · [数据桥](../../apps/web/src/components/SandboxedAppHost.tsx#L39) · [iframe](../../apps/web/src/components/SandboxedAppHost.tsx#L141) | 不是任意 React/npm 应用都经过了离线容器构建；这个入口 `bundle:false`。运行时的 iframe 不保护之前执行生成代码的 Node 进程。[Node 官方安全说明](https://nodejs.org/api/vm.html#vm-executing-javascript)明确 `node:vm` 不是运行不受信任代码的安全机制。 |
| 能力服务 → JSON 变换 → 独立资格与结果验证 → 私有复用 | 可固定工具契约、环境、代码哈希和验证器版本。每次在独立 Worker 中创建 QuickJS/WASM，执行有限输入输出、带超时的同步变换，不给文件、网络或凭据；先对候选做资格验证，再核对本次输出，已有合格版本能复用。[CapabilityService](../../apps/agent-host/src/capabilities/service.ts#L167) · [执行隔离](../../apps/agent-host/src/capabilities/sandbox.ts#L37) · [本次结果验证](../../apps/agent-host/src/capabilities/service.ts#L225) | 这是特定岗位格式的先例，不是任意工具的通用审核器，也不是运行 React、npm 或 MCP Server 的沙箱。业务结果通过与发布一个通用软件包不是一件事。 |
| 微应用容器构建计划／MCP 扩展 | `app-builder` 可生成分阶段容器参数，另一个函数在 QuickJS 中以合成夹具验证指定变换；本地另有审过的 stdio 命令、产物哈希、OS 沙箱及 MCP scope 授权。[容器计划](../../apps/agent-host/src/capabilities/app-builder.ts#L99) · [夹具与回执](../../apps/agent-host/src/capabilities/app-builder.ts#L186) · [stdio 防线](../../apps/agent-host/src/career-mcp/stdio.ts#L22) | 产生参数或回执里有隔离标志，不等于该次 Web 构建实际启动了容器。审过的 MCP 工具也不能因此把浏览器 UI、所有工作区材料或长期发布权一并拿走。 |

**当前发布链最该先补的不是市场页面，而是拒绝不合格产物。** Host 请求不成功时，浏览器路径可直接生成三个 `passed: true`，没有执行对应的构建/运行检查；Host 路径也可返回 `verification.passed=false` 的产物；弹窗的两个批准按钮在代码中均直接调用 `onApprove`。而且「仅单次运行」与「固定 Dock」共用 `installMicroApp`，两者都会经过保存安装清单的路径。这些是源码可观察到的门禁缺口，不是本轮运行不受信代码或证明发生过数据泄露。[浏览器降级](../../apps/web/src/services/sandbox-build-client.ts#L559) · [Host 汇总检查](../../apps/agent-host/src/sandbox/build-service.ts#L147) · [批准按钮](../../apps/web/src/components/MicroAppPermissionModal.tsx#L199) · [安装处理](../../apps/web/src/components/AutopilotStudioWorkspace.tsx#L1895) · [登记](../../apps/web/src/lib/micro-app-registry.ts#L331)

还有一道与 iframe 强度无关的门槛：当前桌面入口没有传具体选中的岗位；默认投影按机会库阶段取前四条，投影的摘要字段可含职位说明、个人备注、沟通摘要拼接的前 120 字符。视图桥单凭 `selected_offers` 就可发送整个投影，并未再按记录 ID 和字段区分 `backcheck_summary`。这是**宿主主动交给视图的内容可能宽于用户以为自己所选内容**，不是观察到对外传输。要按明确选中的 ID 和获准字段生成投影；缺任一选择就给空集，绝不用“库中前四条”补齐。[桌面调用](../../apps/web/src/components/desktop/DesktopShell.tsx#L103) · [取样与投影](../../apps/web/src/lib/micro-app-registry.ts#L64) · [摘要内容](../../apps/web/src/lib/micro-app-registry.ts#L100) · [桥接选择](../../apps/web/src/components/SandboxedAppHost.tsx#L39)

另一个可验的区别是“夹具跑过”不等于“计算正确”。独立的微应用变换 helper 对三个输入检查返回 ID 数量与时薪为有限正数，并不核对 ID 真伪、排序或时薪的正确值；同长度的虚构 ID 列表加正数可满足这些断言。这是[校验条件](../../apps/agent-host/src/capabilities/app-builder.ts#L196)的静态反例，不是本轮实际执行。可复用能力应像另一条[岗位变换资格验证](../../apps/agent-host/src/capabilities/verification.ts#L26)一样，有独立预期结果，并且将「这版工具有资格」与「这次结果正确」分开记录。

**建议的本地发布门禁：**

1. 将 `preview_only`、`verified_candidate`、`installed_private` 区分开。未验证的任意代码不在 Host 里用 `node:vm` 试跑；Host 不可用时最多展示可信外壳/只读静态预览，不能伪造验证，更不能注册、固定或获得真实资料。
2. 发布由本机可信 Host 复核，不只禁用按钮。绑定整个产物（代码、HTML/CSS、manifest、权限、依赖锁和执行环境）的摘要、验证器版本及真实测试结果；内容哈希用于一致性，不是发布者数字签名。重建、扩大 scope、修改依赖、改变运行环境，旧批准失效。候选允许合成资料；正式运行重新取本次短期授权。
3. 把“运行一次”与“安装这版”分成真正不同的命令；安装也不等于可读所有简历。工具只拿任务授予的投影；交互 UI 只能发约定的提案，不能从 iframe 直接写入业务库。撤权要挡住进行中的晚回包与下次重试；回滚只切换能力版本，绝不静默回滚已审批简历。

**最相像的一手参考，分别解决不同问题：**

- **最像本地微应用的运行方式：** [MCP Apps 官方说明](https://modelcontextprotocol.io/extensions/apps/overview)及[日期化规范，固定提交](https://github.com/modelcontextprotocol/ext-apps/blob/19256f52cad5517ba8272581ed2e11d6a81273d5/specification/2026-01-26/apps.mdx)。工具声明 `ui://` 资源，Host 加载到受限 iframe，工具/视图沿 `postMessage` 通道交互。对标 BetterMe 的 `SandboxedAppHost` 非常直接；BetterMe 当前使用自有消息，不代表已经实现 MCP Apps 兼容。这个协议不替你构建、审核、签发或安装制品。
- **最像能力目录与组合：** [DeepSeek Harness 官方架构，固定提交](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.zh.md#cordis)将插件、bundle、profile、适配器与事件解耦。可以借配置组合及启停，不建议允许第三方插件替换 BetterMe 的授权裁决、预算账本、宿主身份或 Workspace 写入网关。加载插件与执行不可信代码的隔离是不同性质的保证。
- **最像本地安装的操作：** [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)支持从本地路径、npm 或 Git 安装/列出/移除能力资源，并区分个人和项目级配置。官方还说明项目包需要先获信任，扩展能执行代码。值得借「显式范围、固定版本、可移除」，不把“受信任并加载”误当成“为不可信代码提供沙箱”。
- **最像“做成东西、再决定给谁看”的产品体验：** [Claude Code Artifacts](https://code.claude.com/docs/en/artifacts)把会话产出变为可交互页面并支持控制分享。可借预览、明确告知可见范围；它发布到 `claude.ai`，不是本地私有包仓库，也不是处理个人简历的默认目的地。[Claude Code 的 shell sandbox](https://code.claude.com/docs/en/sandboxing)则是命令执行期间的文件/网络约束，不能代替产物资格验证或安装审批。

## 把三个设计放回同一个岗位任务

假设目标岗位强调“独立设计”；用户授权的项目说明只证明团队做了该功能，早期本人回答是“我参与联调，没有主导设计”。这些是**示例材料**。

- **A** 的胜负：再读二十多条新材料后，仍能按引用取回早先的否定陈述与旧简历精确句子，写“参与联调”或列待确认；绝不把岗位要求/团队资料写成“主导设计”。
- **B** 的胜负：用户关窗后宿主可以推进到待审草稿；另一窗口看到同一份差异、依据与待确认项。两次点击采用，最多一个岗位专用版本；宿主重启只显示中断，不因打开审阅页重新花额度。本人陈述仍只在本任务使用，不能顺带修改共享 FactBase。
- **C** 的胜负：允许已验证版本比对旧句/新句与引用，或以微应用呈现三栏审阅；不能让该工具自行裁定个人贡献、替用户采纳或投递。没有高频复用证据时，使用内置检查器比发布插件更好。

## 最小试点与通过条件（建议，不是已测成绩）

1. **先用 A 做一条窄切片。** 只接岗位专版任务。保留现有七个工具，不建向量库，不默认多 Agent。加可回读的证据索引与长行游标、带哈希的旧句锚、窗口预留与选择理由；把来源和本人的否定/纠正信息标为不可随意挤出的条目。选择记录只留 ID 与取舍原因，不记私有思维链。逐句草稿只引用真实原文，摘要只能指路。
2. **用同样的合成材料和任务额度做对照。** 验证：早期证据和长行尾部均可精确找回；只有团队证明时不扩大个人责任；撤权/材料换版后，旧证据或由它生成的摘要不外发；等人/等批不扣活跃时长，关窗口后运行要扣；预算耗尽保存检查点与未完成项，不生成“已完成”。记录正确引用、正确保留未知、工具往返次数、预算耗尽率、端到端耗时和输入 token；提供方实报与本机估算分列，不报虚构的节省百分比。
3. **严格区分调用额度和费用。** 现有 UI 已明确 native CLI 内部步骤、重试、token 未必可见。[额度说明](../../apps/web/src/components/CareerTaskPanel.tsx#L306) 指定必须硬限制真实上游次数的任务，应只接受可核算/能按上限停止的 Adapter；不支持的底座提示不满足严格模式，不能默默换付费 API。摘要、格式修复、评审、子任务都记同一累计预算；扩大资料、换供应商或换 CLI 须重新获批。
4. **下一笔投入以失败类型决定。** 消失的证据、重复检索、丢了否定句 → 继续做 A；多入口状态不一致、断线重做或审批回执难对账 → 做 B 的首个共享投影；反复实现相同受限能力、确有第二个复用场景 → 开 C。C 的未验证不可安装必须作为安全门禁独立修正，不必等到建设完整插件平台。

以上比较是设计判断。此次只核对代码与公开一手资料；没有测试外部模型效果、跑真实审批、签发能力包、同步远端或修改业务代码。此前的[本地应用与沙箱研究](career-os-sandbox-primary-sources-2026-11-06.md)可作背景，本次对构建入口、浏览器降级及任务上下文的判断均以当前工作树为准。
