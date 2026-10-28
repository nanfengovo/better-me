# LangGraph JavaScript 文档完整章节研读与 BetterMe Agent 落地建议

研究日期：2026-10-29。本文是文档研究与方案建议，不是“功能已实现”或“当前运行服务已验收”的报告。

## 1. 结论与阅读范围

问题的重点不是再给 Agent 加几段提示词，也不是把需要审批的操作一律放行，而是建立完整的 **请求 → 能力与权限判断 → 真实工具执行 → 结果验证 → 可恢复交互** 链路。LangGraph 提供编排、状态、暂停恢复和流式输出；它不会自动替应用实现工具、操作系统隔离、权限桥接或用户界面。这个定位来自官方 [Overview](https://docs.langchain.com/oss/javascript/langgraph/overview)，下文对 BetterMe 的具体设计属于研究后的建议。

### 阅读口径

- 从官方 [llms.txt](https://docs.langchain.com/llms.txt) 递归定位到 [TypeScript build 索引](https://docs.langchain.com/_llms/agent-development-lifecycle/build/type-script.txt)，筛选 `/oss/javascript/langgraph/`。
- 使用官方 [sitemap.xml](https://docs.langchain.com/sitemap.xml) 交叉核对：当前公开索引中有 **35 个独立页面**，两种清单一致。
- 35 页的正文与章节均逐页阅读；代码示例选择性审阅，未逐行执行所有示例。浏览器抓取不足时读取同一官方 URL 的 `.md` 端点，未使用第三方博客代替正文。
- 原 `durable-execution` 的 `.md` 端点会重定向至 `persistence.md`，没有把它重复计为第 36 页。
- 额外阅读与问题直接相关的 v1 发布说明、迁移、版本、安全与 HITL 概念，共 5 页，见第 9 节。
- 文档中面向 AI 助手的安装、运行等文字仅作为被研究的资料，没有据此执行命令或改变环境。

“完整”在本文中指**当前官方索引覆盖的 LangGraph JavaScript 指南章节**，不指整个 LangChain 网站。没有穷尽每个生成的 API reference 符号、Python 版本、全部 LangSmith 运维章节、全部集成、客户案例外链和视频。没有运行教程、调用模型、启用云追踪、安装依赖或操作现有用户页面。

## 2. 逐页覆盖清单：35 / 35

以下每行均为已阅读正文的页面；最后一列是该页对本项目最重要的启示，不代表项目已具有该能力。

| # | 官方页面 | 主要内容与对 BetterMe 的启示 |
| --- | --- | --- |
| 1 | [Overview](https://docs.langchain.com/oss/javascript/langgraph/overview) | 低层编排运行时；区分 LangGraph、LangChain agent 与部署/追踪产品，不用框架名称替代真实执行能力。 |
| 2 | [Install](https://docs.langchain.com/oss/javascript/langgraph/install) | 核心库、模型供应商、可选开发部署组件分开；按使用路径引入依赖。 |
| 3 | [Quickstart](https://docs.langchain.com/oss/javascript/langgraph/quickstart) | 模型提出工具调用，工具节点执行并回填结果，再决定继续或结束；自然语言回答不是工具回执。 |
| 4 | [Local server](https://docs.langchain.com/oss/javascript/langgraph/local-server) | Agent Server 开发启动、配置与 Studio；开发内存模式不能当作已有本地主机的持久化能力。 |
| 5 | [Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph) | 按职责和失败边界拆节点，状态保存原始数据，区分重试、模型可纠正错误和需要人处理的问题。 |
| 6 | [Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) | 串行、并行、路由、调度者/工作者、评估循环；简单确定性工作无须复杂多 Agent。 |
| 7 | [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | thread、checkpoint、superstep、pending writes、重放和持久性等级；事件日志与执行断点是不同机制。 |
| 8 | [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) | 节点级重试、超时、错误处理和优雅 drain；不能把待审批、取消与暂态故障都当成重试。 |
| 9 | [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) | 内存、SQLite、Postgres 等后端的取舍与配置；本地恢复需要真正落盘的 checkpoint。 |
| 10 | [Stores](https://docs.langchain.com/oss/javascript/langgraph/stores) | 跨线程存储、namespace、检索和分页；不把所有用户、任务和简历混在一个记忆空间。 |
| 11 | [Event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming) | 生命周期和细粒度执行事件；用真实运行事件呈现工具开始、完成、失败，不解析聊天语气充当状态。 |
| 12 | [Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) | updates、values、messages、custom 等流、子图命名空间和格式；面向 UI 选择最小投影。 |
| 13 | [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | 动态暂停、持久化、同一 thread 恢复、响应 schema、重放约束；审批应是可交互状态。 |
| 14 | [Time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel) | checkpoint 重放和分支；不是对外部写操作的撤销，也不能假定不再调用模型/接口。 |
| 15 | [Memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory) | 短期 checkpoint、长期 Store、裁剪/删除/摘要；控制模型上下文并保留事实来源。 |
| 16 | [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) | 共享状态或包装转换、持久化模式、状态查看和并发限制；专家能力应有清晰输入输出。 |
| 17 | [Application structure](https://docs.langchain.com/oss/javascript/langgraph/application-structure) | 图、依赖、配置和 `langgraph.json` 的项目结构；配置文件不意味着必须替换现有主机。 |
| 18 | [Test](https://docs.langchain.com/oss/javascript/langgraph/test) | 节点测试与图集成测试；独立调用节点无法证明 checkpoint、暂停和恢复正常。 |
| 19 | [Backward compatibility](https://docs.langchain.com/oss/javascript/langgraph/backward-compatibility) | 恢复通常使用最新图代码；改节点名、状态字段和已暂停流程时需要兼容策略。 |
| 20 | [Studio](https://docs.langchain.com/oss/javascript/langgraph/studio) | 图/对话调试和执行检查；适合开发验证，不是给最终用户显示内部复杂度的理由。 |
| 21 | [Agent Chat UI](https://docs.langchain.com/oss/javascript/langgraph/ui) | 成熟开源交互参考，支持工具、interrupt 和分支体验；可借鉴而非整站替换。 |
| 22 | [Deploy](https://docs.langchain.com/oss/javascript/langgraph/deploy) | 部署方式与服务端能力；自建 Node 主机并不会自动获得 Agent Server 全部语义。 |
| 23 | [Observability](https://docs.langchain.com/oss/javascript/langgraph/observability) | LangSmith tracing 调试链路；用户隐私与本地优先要求追踪默认脱敏、外传显式选择。 |
| 24 | [Frontend overview](https://docs.langchain.com/oss/javascript/langgraph/frontend/overview) | 前端流式集成、客户端能力和 transport；先明确协议，不靠完整刷新获取运行进度。 |
| 25 | [Graph execution UI](https://docs.langchain.com/oss/javascript/langgraph/frontend/graph-execution) | 节点级执行呈现、分支、并行和暂停；只显示实际观察到的步骤，不造固定进度。 |
| 26 | [Custom stream channels](https://docs.langchain.com/oss/javascript/langgraph/frontend/custom-stream-channels) | 自定义通道和 transformer 分离 UI 数据与对话；避免把整份状态/简历流给浏览器。 |
| 27 | [Pregel runtime](https://docs.langchain.com/oss/javascript/langgraph/pregel) | plan/execute/update 与 superstep 可见性；并行节点不等于 CPU 工作线程或系统沙箱。 |
| 28 | [Choosing APIs](https://docs.langchain.com/oss/javascript/langgraph/choosing-apis) | Graph API 与 Functional API 同一运行时、可组合；按场景选择，避免为迁移而重写。 |
| 29 | [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) | StateSchema、节点边、reducer、Send、Command、运行上下文；副作用权限仍由应用管。 |
| 30 | [Use Graph API](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api) | 多模式示例：私有状态、并行、缓存、重试、动态路由和工具；示例细节要核对安装版本。 |
| 31 | [Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api) | entrypoint/task、恢复重放、保存值与返回值；task 是可恢复计算边界，不是任意命令授权。 |
| 32 | [Use Functional API](https://docs.langchain.com/oss/javascript/langgraph/use-functional-api) | 顺序/并行任务、interrupt、对话和组合；副作用、随机性等需要稳定 task 边界。 |
| 33 | [Agentic RAG](https://docs.langchain.com/oss/javascript/langgraph/agentic-rag) | 检索、相关性判断、改写与生成循环；适合来源问答，不应给版本查询强加向量库。 |
| 34 | [SQL agent](https://docs.langchain.com/oss/javascript/langgraph/sql-agent) | 固定步骤限制查询链路、检查与人工介入；教学数据库包装并不等于生产安全边界。 |
| 35 | [Case studies](https://docs.langchain.com/oss/javascript/langgraph/case-studies) | 应用案例索引；证明适用面，不证明 BetterMe 的现有质量或性能；外链案例未逐篇研读。 |

## 3. 不能混淆的执行层次

建议把下列层次分别设计和验收。该划分是对项目的架构建议，不是 LangGraph 自动生成的模块。

| 层次 | 应负责什么 | 不应误认为 |
| --- | --- | --- |
| 用户交互 | 提交目标、选择上下文、审批或拒绝、查看执行证据 | 模型写出“已完成”就算成功 |
| 编排图 | 路由、状态转换、工具循环、重试边界、暂停恢复 | 自动知道本地工具能力和平台权限 |
| 权限策略 | 可信工具定义、参数范围、只读/写入分级、审批绑定 | 模型自称“安全”即允许执行 |
| Runtime / adapter | 定位受信任可执行文件、结构化调用、取消、超时、读取真实输出 | shell-free 子进程等于操作系统沙箱 |
| 结果验证 | 调用身份、返回 schema、结果证据、部分成功与未执行状态 | `exitCode=0` 或聊天文本就证明目标动作发生 |
| 持久化与调度 | checkpoint、待审批项、恢复队列、并发锁、事件回放 | 只写 `run.json/events.ndjson` 就等于图能恢复 |

官方快开始例明确包含工具调用和回填工具结果的循环，不能省略这一步再指望提示词补齐。[Quickstart](https://docs.langchain.com/oss/javascript/langgraph/quickstart)

针对截图，不能仅凭“需要用户批准”的英文回复判断究竟是 CLI 真正发出了审批事件、适配器没有交互通道、工具没有注册，还是模型仅生成了建议。必须检查本次请求实际经过的 adapter、工具调用和结果。文档研究能给出设计标准，不能替代这一代码与运行证据诊断。

## 4. 高价值能力及容易误用的边界

### 4.1 审批是可恢复状态，不是失败文案

官方推荐动态 `interrupt(payload)`，配合 checkpointer 和稳定 `thread_id`，随后通过同一线程的 `Command({ resume })` 恢复。恢复会从中断节点开头重跑，因此中断前的代码可能重复执行；副作用应放在审批后并具备幂等性。静态 `interruptBefore/After` 主要是调试断点，不宜作为生产 HITL 的主要机制。Zod `responseSchema` 可在保存前校验回答；仅传 JSON Schema 不等于运行时校验。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

BetterMe 建议：

- 建立 `awaiting_approval`，显示“准备执行什么、使用哪个工具、参数、工作目录、可能影响、为什么需要批准”。
- 审批绑定 `threadId + interruptId + toolCallId + 参数摘要 + 工具身份 + 策略版本`；参数变化或新的分支不继承旧授权。
- 按钮可以批准、拒绝；修改参数必须重新校验。审批结果是结构化命令，不通过让用户在聊天框输入“同意”后靠模型猜测。
- 宿主图的审批与 Claude Code 等工具自身的权限是两个层次。没有桥接能力时如实报告“此运行时不支持当前审批方式”，不能偷偷增加跳过权限的参数。
- 需要输入与需要执行审批分开；人工提供的答案可作为人工证据，但不得标成真实工具执行结果。

补充 HITL 文档区分逐调用与批量审批：逐调用允许无须审批的工具继续，按 interrupt ID 响应；批量模式可能使同一轮的只读工具也等待。逐调用中间件要求 `langchain>=1.5.18`，不是只要 LangGraph 版本高就具备。[HITL 概念](https://docs.langchain.com/oss/javascript/concepts/human-in-the-loop)

### 4.2 恢复有三个不同问题

1. **界面恢复**：重新连接后知道当前运行状态和最近事件。
2. **图恢复**：进程重启后从 checkpoint 恢复状态与下一步。
3. **外部动作恢复**：判断上次工具是否已经改变外部世界，防止重复执行。

LangGraph checkpoint 解决第 2 类的核心部分。superstep 中已成功节点的 pending writes 可避免同层失败恢复时全部重算；内存 saver 不保证跨进程恢复。`async`、`sync` 和 `exit` 持久性等级有不同的崩溃窗口和 I/O 成本，不能都宣传成相同的恢复保证。[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)

对 BetterMe 的建议是：已有 SSE 日志继续负责事件回放，checkpoint 负责图执行状态；再用 host 层的单线程运行锁、恢复队列、动作幂等键和已提交回执处理调度与外部副作用。checkpoint 不会恢复一个已经消失的子进程，也不会自动重建 OS 句柄。

### 4.3 失败分类比“重试三次”重要

节点重试是显式启用的。当前专门的容错指南规定先尝试、按策略重试、耗尽后才进入错误处理；取消/中断不会按普通错误盲目重试。超时、错误 handler 和统一节点 defaults 有版本要求。优雅 drain 停在 superstep 边界，不等于马上杀死正在执行的外部工具。[Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)

BetterMe 应有独立分类：`unavailable`、`unsupported`、`awaiting_approval`、`auth_required`、`timed_out`、`cancelled`、`retryable_failure`、`failed`、`completed`。暂态网络故障可以退避；缺少工具、权限拒绝、无效参数、配额不足和用户取消不应浪费等待时间重复尝试。每次恢复、重试、取消都必须针对原始 run，而不是悄悄开启另一轮新任务。

### 4.4 图状态不是默认安全的数据流

输入/输出 schema 和所谓 private channels 主要约束图的数据接口，不是流式脱敏保证；`values` 可能暴露完整状态，需要显式选择输出或另做投影。并行更新需要正确 reducer；顺序不应由并行任务返回时间决定。`Command.goto` 与同节点静态边同时存在时，两者可能都执行。[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)、[Use Graph API](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api)

建议只向 UI 发白名单事件：任务状态、节点状态、工具名与安全参数摘要、审批项、有限输出和结果证据。模型输入、私有简历、API Key、完整环境变量及内部异常栈不应因为“调试方便”进入浏览器流。`UntrackedValue` 也不是隐私访问控制。

### 4.5 流式进度服务于真实执行

官方流支持状态更新、消息 token、工具和自定义数据；前端图执行方案可用观察到的节点表达并行和暂停。自定义 channel/transformer 可把执行事件转换成适合界面的数据，而不是把一切塞进聊天气泡。[Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)、[Event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming)、[Frontend graph execution](https://docs.langchain.com/oss/javascript/langgraph/frontend/graph-execution)、[Custom stream channels](https://docs.langchain.com/oss/javascript/langgraph/frontend/custom-stream-channels)

建议事件统一携带 `runId / threadId / seq / node / toolCallId / status / evidenceRef`。递增 seq 处理重连去重和排序，时间戳仅展示。UI 首层只显示“正在做什么 / 已得到什么 / 是否需要你处理”，工具细节按需展开；不要固定显示五个步骤或虚构百分比。完成状态必须来自结果验证，不能依据 assistant 的结束 token。

### 4.6 记忆、时间旅行和子图要分别管

- Checkpoint 用于线程内状态，Store 用于跨线程数据。存入状态不意味着应全部发给模型；裁剪与摘要也需要维护工具调用/结果配对，避免破坏消息协议。[Memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory)、[Stores](https://docs.langchain.com/oss/javascript/langgraph/stores)
- 时间旅行会重新执行后续工作，分支是新 checkpoint，不会替外部世界“撤销”。生产写入仍需幂等或补偿，不得把调试重放当安全的重看记录。[Time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)
- 子图可用共享状态或转换包装；调用级与线程级持久化语义不同。对同一有状态子图并发调用可能冲突，不能只加 Promise.all。默认不继承父图的所有容错 defaults。[Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)、[Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)

对 BetterMe：简历 Fact 仍为事实来源；跨线程记忆保存偏好、已核实的信息及出处，不自动把模型总结变成求职事实。默认不共享简历，用户选择的摘要仅进入当前授权任务。长期记忆、checkpoint 和追踪应有独立删除/保留政策。

### 4.7 并行和缓存不能掩盖副作用

Pregel 的节点并行和 superstep 更新语义，不是 CPU 隔离或操作系统权限隔离；Functional API 的 task 给出可恢复计算边界，未完成的副作用仍可能重试。[Pregel](https://docs.langchain.com/oss/javascript/langgraph/pregel)、[Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api)、[Use Functional API](https://docs.langchain.com/oss/javascript/langgraph/use-functional-api)

建议并行执行真正独立、只读的来源查询，设置最大并发与预算；重 CPU 工作放 worker。缓存限纯计算或有 TTL 的只读查询，缓存键包含版本、用户权限范围、来源与参数，不缓存“用户已批准”作为可复用通行证。副作用工具不靠节点缓存提供“恰好一次”保证。

## 5. 针对“查个版本也不行”的最短可靠路径

以下是独立能力设计建议，不是本轮已经修复的结果，也不是对截图根因的未经验证定论。

```text
接收请求
  → 确定性路由：版本/能力探测，还是需要模型规划的任务
  → 宿主能力目录与权限策略检查
  → 若需要审批：持久化 interrupt → 明确审批 UI → 同 thread 恢复
  → 真实执行受限工具
  → 验证结构化回执与目标结果
  → 展示结果及证据；必要时交给模型解释
```

例如只问 Claude Code 的本机版本，宜暴露窄接口 `get_runtime_version({ runtimeId })`，由宿主 registry 解析可信 executable 并使用固定 argv；不是把用户文本拼成任意 shell，也不必“先运行另一个 LLM，再让那个 LLM 决定是否运行命令”。若策略允许，这个窄只读探测可直接执行；若运行环境确实要求授权，则在当前界面提供审批通路。

建议回执最少包括：工具调用 ID、runtime ID、解析到的可执行身份、安全参数摘要、执行与结束时间、退出码、限长 stdout/stderr、结果类别和经过验证的版本。版本未知、输出格式不符、工具未安装、权限受阻、用户拒绝应给不同结果。只有真正执行并得到可验证版本时才显示“已读取本机版本”。

对于通用 CLI Agent，一次 CLI 进程返回 0 只能证明那个进程结束，不必然证明用户委托的内部动作发生。外部程序如果返回的是“请你自己运行”，可以展示为“运行时回复”，不能包装成“动作执行成功”。没有结构化执行事件时明确证据能力上限，不用英文关键词猜审批状态。

此处的安全目标与官方建议一致：最小权限、只读凭证、沙箱和纵深防御；提示词不是安全边界。[Security policy](https://docs.langchain.com/oss/javascript/security-policy)

## 6. 保持深模块、避免一次性耦合重做

推荐模块接口如下，既适合明确 Graph API，也不排斥少量线性的 Functional API；两者可组合，无须全量迁移。[Choosing APIs](https://docs.langchain.com/oss/javascript/langgraph/choosing-apis)

| 模块 | 提供的窄接口 | 独立验收重点 |
| --- | --- | --- |
| CapabilityRegistry | `listCapabilities / resolveTool` | 工具可用性、可信可执行身份、运行时协议能力真实 |
| PolicyGate | `evaluate(action) → allow / interrupt / deny` | 不依赖模型自评、参数变动失效、默认拒绝不明能力 |
| ToolExecutor | `execute(call, signal) → receipt` | 真调用、超时、取消、输出限额、环境与目录限制 |
| GraphOrchestrator | `start / resume / inspect` | 工具循环、状态与 checkpoint、不会吞掉 interrupt |
| RunSupervisor | `enqueue / lock / recover / cancel` | 重连不重复启动、重启恢复、孤儿运行归类 |
| ResultVerifier | `verify(intent, receipt) → outcome` | 运行结束与目标完成区别、版本/文件/来源结果证据 |
| EventProjection | `project(internalEvent) → publicEvent` | 脱敏、有序、可回放、不暴露私有状态 |
| UIController | `renderState / submitDecision` | 操作入口明确、错误可行动、状态可靠而不是装饰 |

用原始数据与证据构建状态，提示词按需生成；节点按失败和权限边界拆，避免单个“万能 executeAgent”同时负责规划、策略、进程、校验、UI 文案。[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)

多 Agent 不是第一阶段的必选项。资料研究、JD 比较、事实核验等职责稳定后，才考虑独立子图；每个专家必须有工具、输入输出 schema、预算和证据标准。RAG 和 SQL 教程展示了可控的专用链路，但不应把所有工作都套成同一种复杂框架。[Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)、[Agentic RAG](https://docs.langchain.com/oss/javascript/langgraph/agentic-rag)、[SQL agent](https://docs.langchain.com/oss/javascript/langgraph/sql-agent)

## 7. 本地依赖兼容性核对与文档差异

以下为本轮从 `apps/agent-host/package.json` 所在位置解析安装包并只读检查得到的结果，不代表现存进程一定已加载这些版本。

| 项目 | 本地核对结果 | 对方案的影响 |
| --- | --- | --- |
| `@langchain/langgraph` | 1.5.1；包元数据 engine `>=18` | 有条件使用当前指南中的新 API，仍需按具体类型与测试验证。 |
| `@langchain/core` | 1.2.20；engine `>=20` | 不应因相邻包版本不同就无差别升级整个工作区。 |
| `@langchain/langgraph-checkpoint-sqlite` | 1.1.0；engine `>=18` | SQLite 后端已可解析，但“已安装”不等于“所有实际运行图已接入”。 |
| 本轮 shell 的 Node | 26.7.0 | 满足安装元数据和当前迁移指南的较高运行要求。 |
| `langchain`、`@langchain/react`、`@langchain/langgraph-sdk` | 从 Agent Host 入口不可解析 | 不能假设中间件或前端 SDK 已可直接使用；不等于整个工作区绝无这些传递依赖。 |

版本门槛与已核对差异：

- per-node timeout、errorHandler、`setNodeDefaults` 等当前容错能力要求 LangGraph 1.4.0+；Zod interrupt response schema 要求 1.4.16+；custom stream channel/transformer 要求 1.3.1+。本地 1.5.1 满足这些文档门槛，类型定义中也能查到相关能力。[Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Custom stream channels](https://docs.langchain.com/oss/javascript/langgraph/frontend/custom-stream-channels)
- LangChain 逐调用 HITL 的 `langchain>=1.5.18` 与 `@langchain/langgraph@1.5.1` 是不同包的版本。若仅使用原生 LangGraph interrupt，可不为这个需求立刻引入 LangChain 中间件。[HITL 概念](https://docs.langchain.com/oss/javascript/concepts/human-in-the-loop)
- `use-graph-api` 中较旧的 retry 说明与专门的 `fault-tolerance` 页面默认异常规则不一致。本地 `dist/pregel/retry.js` 更符合后者：包含 abort、GraphValueError、部分 4xx、`ECONNABORTED` 和配额判断；不要照搬旧页的另一份异常名单。生产建议显式编写领域重试条件，而不是依赖读者猜默认值。
- 当前迁移页写 Node 22+，但安装包的 engine 元数据分别是上述值。这是文档/包元数据口径差异；当前 Node 26 同时满足，不能因此声称环境不兼容或直接批量升级。[LangGraph v1 migration](https://docs.langchain.com/oss/javascript/migrate/langgraph-v1)
- v1 发布/迁移说明推荐 LangChain `createAgent` 取代 deprecated `createReactAgent`。现有手写 `StateGraph` 不需要因此改成 LangChain agent；`Annotation.Root` 的存在也不等于项目必须全面重写状态定义。[v1 release notes](https://docs.langchain.com/oss/javascript/releases/langgraph-v1)
- 文档个别示例保留不同代际的 streaming import 或 Python 风格命名。实现应以安装版本的公开 TypeScript 类型、专门能力指南和测试为准；本轮也检查到 `streamEvents(... version: "v3")` 类型，但没有据此改变现有网络协议。

## 8. 分期与验收：先可靠执行，再扩充智能

### P0：执行真实性与可行动失败

独立完成版本/能力等窄只读工具、真实回执、结果验证和状态分类。默认对话与本机任务的路由需明确；不能让用户发出执行请求后只收到教程。此阶段不需要 UI 动画、多 Agent 或查询索引优化。

验收至少覆盖：已安装/未安装、可信 executable 解析失败、版本输出不符、执行超时、取消、运行时回复了建议但没有工具证据。fake adapter 测试必须证明“调用了正确工具且参数正确”，不能只断言页面出现“完成”。

### P1：持久审批与断点恢复

独立接入持久 checkpoint、typed interrupt、审批接口与 run supervisor。界面可只先做清楚的审批卡，不等待完整视觉改版。

验收至少覆盖：批准后执行一次、拒绝不执行、无效回答不污染待审批状态、重复点击去重、重启后同 thread 恢复、参数修改重新审查、多个待审批项按 ID 恢复、取消不自动重试、同 thread 并发请求串行化。

### P2：工具循环、上下文与流式体验

给模型明确工具 schema；工具结果回填正确 toolCallId 后再继续。限制步骤/时间/成本，处理可纠正参数错误，按需读取而不是默认塞入简历。前端只展示真正发生的节点和证据。

验收包括：工具错误反馈后的有限修正、工具调用与结果配对、多轮 plain input/interrupt resume 区分、上下文裁剪不打断工具协议、SSE 断线重连有序去重、私有状态不外泄。

### P3：专用子图、检索和评估

在真实用例出现后增加 JD 来源核实、公司研究、Fact 对照等专用子图；先定义成功标准、证据来源与预算，再决定并行、缓存、RAG 或 evaluator。不能为简单本机命令添加不必要的 agent 调度层。

官方测试指南区分节点与图测试。暂停/恢复、幂等与跨进程持久化须做真实图级集成测试；单独调用 node handler 不足以证明它们。[Test](https://docs.langchain.com/oss/javascript/langgraph/test)

升级期间应保持已暂停线程依赖的节点名与状态兼容，使用可选字段/default 和明确流程版本；不能修改完图就假设旧 checkpoint 一定能接着运行。[Backward compatibility](https://docs.langchain.com/oss/javascript/langgraph/backward-compatibility)

## 9. 部署、观察与扩展阅读边界

Agent Server 的持久化、开发配置与部署特性，只有实际采用对应运行路径才成立。BetterMe 自有 Agent Host 不因引入 `@langchain/langgraph` 或增加 `langgraph.json` 就自动获得这些特性；是否替换服务器应作为独立决策。[Application structure](https://docs.langchain.com/oss/javascript/langgraph/application-structure)、[Local server](https://docs.langchain.com/oss/javascript/langgraph/local-server)、[Deploy](https://docs.langchain.com/oss/javascript/langgraph/deploy)

Studio 与 Agent Chat UI 适合作为成熟交互参考：可观察图、工具和审批，而非仅渲染 Markdown。可以借鉴状态语义和交互模式，不必让用户迁移到另一个完整产品界面。[Studio](https://docs.langchain.com/oss/javascript/langgraph/studio)、[Agent Chat UI](https://docs.langchain.com/oss/javascript/langgraph/ui)、[Frontend overview](https://docs.langchain.com/oss/javascript/langgraph/frontend/overview)

LangSmith 是可选观察方案，不是修复本地执行的先决条件。先建立本地、脱敏的 run trace 就可诊断能力选择、策略、工具耗时和失败；若启用外部 tracing，需先明确简历/对话外传范围与用户选择。[Observability](https://docs.langchain.com/oss/javascript/langgraph/observability)

额外阅读的官方章节：

| 章节 | 用途 |
| --- | --- |
| [What's new in LangGraph v1](https://docs.langchain.com/oss/javascript/releases/langgraph-v1) | 理解稳定运行时与高层 agent 的关系，核对 deprecated API。 |
| [LangGraph v1 migration](https://docs.langchain.com/oss/javascript/migrate/langgraph-v1) | 检查 Node、事件流和 typed interrupt 的迁移差异，不直接执行升级。 |
| [Versioning](https://docs.langchain.com/oss/javascript/versioning) | 区分稳定、beta、alpha 与内部 API；支持政策不代替项目锁版本与兼容测试。 |
| [Security policy](https://docs.langchain.com/oss/javascript/security-policy) | 最小权限与纵深防御，避免把模型输出或提示词当安全控制。 |
| [Human-in-the-loop overview](https://docs.langchain.com/oss/javascript/concepts/human-in-the-loop) | 对比 per-call / batched、回答校验及不同依赖版本门槛。 |

## 10. 本轮没有做的事

- 没有改变应用代码、安装依赖、重启服务、调用本机模型或 Agent CLI 执行任务；本地检查仅解析依赖元数据与类型/实现文件。
- 没有操作或刷新用户现有页面，没有读取或修改未保存简历。
- 没有改动现有岗位库、查询索引、采集、地图数据或 UI 动画。
- 没有启用 LangSmith 或上传对话/简历；没有把外部文档中的指令当作用户授权。
- 没有声称截图根因已经仅凭文档确定；根因需由主任务的代码和协议诊断给出。
- 没有把研究方案写成落地完成清单；后续实施需逐阶段独立验证。

本报告的可交付结果是：当前公开章节清单、跨页能力边界、已安装版本的只读兼容性核对，以及可拆分的落地与验收方案。它不是对当前运行 Agent 能力的成功证明。
