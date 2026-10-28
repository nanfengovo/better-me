# BetterMe Agent 执行可靠性审计与分阶段重构方案

日期：2026-10-29。范围：截图中的 Claude Code 版本查询失败、Agent Host 工具执行与工作流恢复，以及官方 LangGraph JavaScript 指南研究。

**交付状态：完成诊断、文档研究、可复现的审计用例和重构方案；未修复或部署业务功能。** 本轮没有刷新用户页面、重启本地服务、修改岗位库、简历、凭据或工具权限配置。

## 1. 截图问题的真实原因

在本机历史运行记录中找到了与截图一致的调用：

- Claude 实际提出了两次 Bash `claude --version`，两次都遭到工具权限拒绝。
- 最终 CLI 帧是 `type: result / subtype: success / is_error: false`，但同时携带 `permission_denials`。
- BetterMe 将该运行记为 `completed`，界面只收到一段让用户自行执行命令的回复，没有可接续的真实审批通道。
- 本轮直接做受控只读诊断，`claude --version` 正常返回 **2.1.218 (Claude Code)**，退出码为 0。不是未安装或任务本身太复杂。

没有在报告中复制原始用户提示、凭据或完整私有执行记录。以上历史证据只用于本地诊断。

当前链路把“CLI 回合结束”和“用户目标完成”混为一谈。Claude 的 success 帧不能覆盖其中的权限拒绝；LangGraph 的暂停能力也不会自动变成子进程的 Bash 授权。官方说明：[Headless](https://code.claude.com/docs/en/headless)、[SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)。

## 2. 已验证的代码缺口

| 优先级 | 证据 | 实际影响 |
| --- | --- | --- |
| P0：结果真实性 | `apps/agent-host/src/runs/run-manager.ts:149-166` 以忽略 stdin 的方式启动进程，退出码为 0 就标记 completed | 无法交互审批，工具被拒或结构化失败仍可能显示完成；退出与目标结果应分别记录 |
| P0：协议证据丢失 | `apps/agent-host/src/runtime/worker-adapter.ts:177-200` 丢弃 user 帧，只抽取 assistant/result 的文本 | 实际嵌套的 tool_use、tool_result、permission_denials、结构化错误没有转成可操作的执行状态 |
| P0：工具安全执行入口不统一 | `apps/agent-host/src/tool-adapter.ts:75-87` 直接调用 definition.execute，consumeRequests/consumeBytes 是空函数 | 合成用例中 0 次请求预算仍能调用处理函数；已有 opportunities 工具 Registry 对同一预算会正确拒绝，应复用而非另建弱化入口 |
| P0：持久化隐私约定不成立 | JD graph 把 rawJd/sessionClaims 作为状态 channel；相关注释声称不持久化简历文本 | 合成标记经 MemorySaver 保留在 checkpoint 状态中。这里只证明保存机制与约定矛盾，未声称已发生外传或检查了真实私人 checkpoint |
| P1：审批恢复入口错误 | `apps/agent-host/src/server.ts:220` 使用普通 `{ approval }` 再次 invoke，而非 `Command({ resume })` | 同一合成任务重新经过 intake/plan，产物由 2 份变成 4 份；正确 resume 对照没有重复 |
| P1：聊天、CLI 与图互不构成闭环 | `apps/agent-host/src/chat/chat-service.ts:189` 是普通 model.invoke；CLI 运行和 career graph 使用另一组入口 | 共享外观不等于共享工具、thread、审批或恢复能力，聊天建议卡也不等于实际工具调用 |
| P1：专业工作流尚是骨架 | `apps/agent-host/src/graphs/career/graph.ts:36-81` 的 fanout 仅把 worker 标为 queued，后续主要更新阶段/日志 | 本轮合成运行 attempted=5、completed=0；不能把这些阶段名称当作五个专家已完成真实工作 |

注意：工具某一次出错，不一定意味着整个任务失败；Agent 可能有合法替代方案。最终判定必须依据目标是否完成及其回执，不能简单把任一 tool error 或任一 denial 都改成永久失败。

## 3. 文档阅读范围与适用性

已完成两份独立研究记录：

1. [LangGraph JavaScript 逐页研究](../research/langgraph-js-documentation-study-2026-10-29.md)：官方递归 llms 索引与 sitemap 交叉核对的 **35/35 个 LangGraph JS 指南页面**，另有相关发布、迁移、版本与安全资料；包含每页链接和落地判断。
2. [LangChain 工具与 Claude 审批研究](../research/agent-tools-and-approval-study-2026-10-29.md)：工具循环、middleware、HITL、运行上下文、结构化结果，以及 Claude 权限、双向交互、精确 session 恢复和版本限制。

不是只读 Overview；也不宣称穷尽整个 LangChain 网站、全部生成的 API 符号、Python 文档、视频与外部案例，更没有运行所有教程。研究中没有执行网页内给 AI 助手的安装或操作指令。

本机核对到 LangGraph 1.5.1、LangChain Core 1.2.20、SQLite checkpointer 1.1.0、Node 26.7。Agent Host 未安装独立 `langchain`、`@langchain/react` 或 Claude Agent SDK，不能只因文档有新功能就假定现有依赖与协议已经支持。

几个会直接影响设计的官方结论：

- 动态 interrupt 配合稳定 thread、持久 checkpointer 和 `Command({ resume })`；恢复会重新进入中断节点，因此其中的副作用仍需幂等。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- 运行事件日志、graph checkpoint 与可恢复的子 CLI session 是三个不同对象；时间旅行也不是文件系统回滚。[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)
- 节点重试、超时、错误处理要按领域配置；权限拒绝、取消、无效凭据不应进入盲目自动重试。[Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)
- 工具循环必须实际执行模型发出的调用、回填结果，再判断是否继续。确定性版本查询不需要复杂的多 Agent。[Quickstart](https://docs.langchain.com/oss/javascript/langgraph/quickstart)、[Tools](https://docs.langchain.com/oss/javascript/langchain/tools)
- 前端应从真实生命周期、工具和 interrupt 事件生成最小视图，不把整份 checkpoint 或聊天语气当作执行进度。[Event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming)、[Graph execution UI](https://docs.langchain.com/oss/javascript/langgraph/frontend/graph-execution)

兼容性警示：当前安装的 Claude CLI 是 2.1.218，而官方 `--permission-prompts none` 要求更高版本，且该选项是拒绝行为，不是自动批准。`defer`、SDK `canUseTool` 等必须在选定适配器和锁定版本上验证，不能给现有单向 spawn 增加一个假审批按钮便宣称支持。禁止以 `dangerously-skip-permissions` 或修改用户全局权限配置作为修复。

## 4. 建议的模块边界

不是推倒重写，也不是堆出八个只有转发函数的服务。保留现有 Runtime Registry、Run Manager、事件总线、SQLite checkpointer 和 opportunities 工具注册表，围绕实际差异建立少数深模块。

### 4.1 对 UI 提供一个稳定的 Session Interface

建议统一为五类操作：

```text
submit(threadId, input, contextGrants)
decide(interruptId, decision)
cancel(runId)
observe(threadId, afterSeq)
recover(threadId)
```

Companion 和完整工作台消费同一接口，不再各自猜状态。不因此默认共享整份简历；上下文仍逐项授权，可撤销，默认最小化。

### 4.2 四个内部职责，分别验收

| Module | 隐藏的复杂性 | 清晰的 Seam |
| --- | --- | --- |
| Tool execution | 输入/输出 schema、可信身份、预算、权限 allow/ask/deny、超时、幂等、回执 | 图和 Runtime 都通过已有可信 Registry 执行应用工具，不能绕到 definition.execute |
| Runtime adapters | 原生模型工具循环与 Claude/其他 CLI 的真实协议、能力探测、进程/子 session 生命周期 | 规范化工具事件和结果；每种适配器明确声明并验证 approval/resume/cancel 能力 |
| Graph orchestration | 确定性路由、有限工具循环、子图、动态 interrupt、恢复与节点错误策略 | 接收目标和已授权上下文，产出可追溯结果；不负责伪造子 CLI 授权 |
| Run supervision & projection | 目标结果与进程状态分离、事件序列、恢复队列、线程并发锁、UI 最小投影 | 一个任务只有一个权威终态；重连读事件，不通过刷新页面或重发目标恢复 |

Policy 和结果验证是 Tool execution / Run supervision 内部必须承担的职责，不要求立即拆出额外独立包。只有出现真实独立调用方或实现差异时再提取。

### 4.3 正确的结果与审批语义

- 进程 exited(0) 可以和目标 blocked(permission) 同时成立；completed 需要可核验的目标结果。
- awaiting_approval 仅用于实际仍可接续的调用。CLI 已退出且不支持恢复时显示 blocked/interrupted，不能留下无效“允许”按钮。
- partial 保留已验证子结果；未执行、超时、鉴权失败、取消、拒绝与不支持分别呈现。
- 每项审批绑定可信操作者、thread/run/子 session、tool call ID、工具与参数指纹、路径/副作用范围、有效期和单次消费；参数修改或新调用不继承旧批准。
- 审批必须送达实际执行权限通道。父图改一个 approved 字段、向 prompt 添加“用户允许”都不是 Bash 授权。
- checkpoint 默认不保存本次临时分享的正文；需要保存的材料有明确授权、保留周期与删除策略。事后清空最新 state 不会清除历史 checkpoint。
- 已写入但结果未知时先核验，不能恢复时无条件重做。checkpoint 不提供外部世界的 exactly-once。

## 5. 独立实施切片与验收门槛

### A：先完成可靠的最小执行闭环

只做：协议解析、目标结果分类、工具安全执行入口、运行时只读查询；不迁移全部 SDK，不改地图/UI 动画。

- 新增受控 `runtime.inspect`：默认返回 Registry 已验证的版本、来源与 checkedAt；用户要求重新探测时，只运行已验证 executable + 固定 versionArgs，不接受模型生成的任意 shell。
- 保留嵌套 tool_use/tool_result、denial、structured error、最终结果及取消证据，去重并分类。
- 路由版本、已安装能力等确定性查询到领域工具，避免多一次不必要的模型和 Bash 代理。
- 工具适配通过现有 Registry，验证 0 预算、输出 schema、取消和错误回执；在此之前不扩张写能力。
- 收紧临时上下文与 checkpoint/事件投影，使用合成隐私标记验证，不能将真实简历作为测试数据。

验收：截图同类任务要么返回带来源/时间的版本结果，要么明确说明真实阻塞原因；不再出现 denied/error 被标记 completed。没有可接续能力时不能显示假审批。

### B：持久审批与正确恢复

只做：应用工具的 dynamic interrupt、Command resume、审批绑定、取消、刷新/主机重启恢复；先不把任意 CLI 都宣称可交互。

验收：批准后不重跑入口、不重复产物；拒绝/过期/重复/跨 run/篡改参数均失败关闭；取消释放等待。已提交副作用有幂等键和回执，重启恢复先核验未知结果。

### C：统一会话与选定 Runtime 的真实执行接入

只做：原生模型工具循环、Companion/工作台一致事件、独立的 Claude 双向权限适配器。是否引入 SDK 单独评估、锁定版本与二进制来源；不强制替换其他 Runtime。

验收：用户在同一 thread 提问、执行、审批、继续，不需复制命令到终端；SSE 重连不重复执行。明确不支持工具调用/审批恢复的 Runtime 直接给能力诊断，不静默降级成“假执行”。

### D：把专业工作流从骨架变成真实子图

只做：岗位研究、JD 匹配、公司/地点证据、事实核查的真实工具与产物，按可靠性逐个启用。

使用有界并行、reducer/Send 汇合、局部失败保留、按类型重试；只缓存有版本/授权/TTL 边界的只读结果。长期 Store 与会话 checkpoint 分开；未授权不启用云追踪。先评估任务轨迹与证据，再考虑更复杂的多 Agent 或视觉效果。

验收：worker 的 completed 必须有结果回执；某一来源失败不覆盖其他已验证成果；过程可取消、可恢复、可检查。没有真实执行的节点必须标明“未实现/未执行”。

## 6. 本轮可复现实验

### 6.1 现有聚焦测试基线

```sh
node node_modules/tsx/dist/cli.mjs --test apps/agent-host/tests/worker-adapter.test.ts apps/agent-host/tests/runtime.test.ts apps/agent-host/tests/career-graph.test.ts
```

结果：**22/22 通过**。这说明已有测试覆盖不足，不能据此宣称真实权限失败和恢复路径正确。没有声称完成全库测试或浏览器端验收。

### 6.2 新增研究专用红灯探针

[agent-permission-probe.ts](../research/fixtures/agent-permission-probe.ts) 使用合成 Node 协议输出、临时目录和内存图，不调用模型、不执行真实 Agent 任务、不使用真实简历。它是已知缺陷的审计材料，不是普通 CI 中已经修复的回归测试。

```sh
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap docs/research/fixtures/agent-permission-probe.ts
```

本轮最终重跑：10 项，**7 项预期失败，3 项对照通过**，退出码 1，约 1.68 秒。

| 用例 | 结果 |
| --- | --- |
| 权限拒绝 + CLI exit 0 不应 completed | 失败：当前仍 completed |
| 嵌套 Claude tool_use 可观察 | 失败：当前事件丢失 |
| structured is_error + exit 0 不应 completed | 失败：当前仍 completed |
| 嵌套工具拒绝结果可观察 | 失败：当前事件丢失 |
| 对照：正常无拒绝的文本结果仍 completed | 通过 |
| 当前 resume 不应重复 intake/plan/产物 | 失败：2 → 4 份产物，intake 两次 |
| 对照：Command resume 不重复前序步骤 | 通过 |
| 会话临时 claim 不应进入 checkpoint | 失败：合成 claim 与 rawJd 仍在状态中 |
| 现有 adapter 应执行 0 请求预算 | 失败：处理函数仍被调用 |
| 对照：已有可信 Registry 执行同一 0 预算 | 通过：返回 budget-exceeded |

没有把“发现七个红灯”写成“修好了七个问题”。后续每个切片应将相关审计用例移入正式测试、补充边界场景并转绿，再分别交付。

## 7. 本轮结论

用户的期待是合理的：一句简单执行请求，应由产品完成能力识别、受控调用、必要审批和结果呈现，不应仅把模型建议转交回用户。

优先级不是更多动画、更多 Agent 名称或更长提示词，而是 **真实工具执行、真实结果判定、真实审批和可恢复状态**。LangGraph 的高价值能力应沿这些具体缺口逐步接入，而不是把文档里的每个特性一并耦合进来。
