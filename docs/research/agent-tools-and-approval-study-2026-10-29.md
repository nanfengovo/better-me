# Agent 工具执行与审批协议：官方文档补充研究

日期：2026-10-29。范围：LangChain JavaScript 的 Agent harness，以及 Claude Code / Claude Agent SDK 的工具、权限、流式控制与会话恢复。本文件是 LangGraph 主研究的补充，不声称穷尽 LangChain / Claude 的全部文档或所有版本。

本轮仅做只读研究和本文档写入；没有安装依赖、运行模型任务、修改用户设置、重启服务、刷新用户页面或修改应用源码。文中「建议」是面向 BetterMe 的设计推论，不是声称这些机制已经实现。

## 1. 结论先行

截图问题不能仅靠修改提示词解决。用户要求查询 CLI 版本，但宿主把任务交给了一个不能完成交互审批的子 CLI；子 CLI 的对话回合正常结束，不代表版本查询成功。应用必须分别处理：用户意图、实际工具结果、子运行权限、父工作流状态。

建议分两条独立路线：

1. 常见、可确定的本机能力，由应用提供小而明确的 typed tools，例如运行时列表、版本、健康状态、岗位只读搜索。查询已探测版本不需要再让模型调用通用 Bash。
2. 真正需要委托给 Claude Code 的任务，使用已验证的双向协议或 SDK 承接实际工具审批；否则明确标记为能力受限或待人工授权，不能把模型输出的“需要审批”文字当成可继续的审批状态。

LangChain 的 HITL 只管理其自身工具循环里被 middleware 拦截的调用；它不会自动批准嵌套 CLI 的 Bash，也不会自动恢复一个已经退出的子进程。Claude SDK 则有独立的权限评估和用户输入回调。这是两个权限平面，需要显式桥接。[LangChain HITL](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)，[Claude SDK 权限](https://code.claude.com/docs/en/agent-sdk/permissions)。

## 2. 本地版本与证据边界

只读解析 `apps/agent-host/package.json` 所在环境的实际安装结果：

| 依赖 / 运行时 | 本轮确认范围 | 对设计的影响 |
| --- | --- | --- |
| `@langchain/langgraph` | 安装版本 `1.5.1` | 能力以该版本实际导出和测试为准，不能只按最新网页示例推断 |
| `@langchain/core` | 安装版本 `1.2.20` | 与新增 harness / SDK 依赖的 peer 范围一起核对 |
| `langchain` | Agent Host 环境未安装 | 官方 `createAgent`、内置 middleware 不是仅安装 LangGraph 就已经拥有的能力 |
| `@anthropic-ai/claude-agent-sdk` | Agent Host 环境未安装 | `canUseTool` 等 SDK 能力不是现有普通 spawn 的参数开关 |
| Claude Code | 项目既有记录和主审计记录为 `2.1.218`，本研究没有再次运行 CLI | 不能给它直接加上新文档中的新版本参数 |

主审计提供的真实运行证据：子进程使用 `-p --output-format stream-json --verbose`；输入流不承接互动控制；两次 `Bash` 的 `claude --version` 被拒绝；最终帧却是 `subtype: success`、`is_error: false`，并包含 `permission_denials`。宿主将该 Run 标为 `completed`。这些现场事实由主审计核对，本文的补充研究不把它们冒充为自己新执行的真实模型验收。

当前官方 TypeScript 类型也允许 success 结果包含 `permission_denials`、`is_error` 和 `stop_reason`。因此，`success` 不能单独作为任务达成判据。[Claude SDK TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript)。

## 3. LangChain JS 该用哪些能力，不该机械堆哪些能力

### 3.1 Harness、工具和上下文

`createAgent` 在图执行运行时之上组织模型和工具循环；业务工具通过明确名称、说明和输入 schema 暴露。BetterMe 可以保留领域编排图，把通用对话循环封装为其中一个有清晰边界的节点，而不是把所有页面、运行时和业务操作塞进一个提示词。[Agents](https://docs.langchain.com/oss/javascript/langchain/agents)，[Tools](https://docs.langchain.com/oss/javascript/langchain/tools)。

建议将三类信息分开：

- 不可变的调用上下文：用户 / 会话身份、授权范围、请求来源、允许的能力。
- 当前执行状态：消息、工具请求、计划、待审批项、已核验结果。
- 跨会话数据：显式允许持久化的偏好和摘要，不默认包含完整简历。

官方 context engineering 区分 model context、tool context 和生命周期上下文；Runtime 还可提供 store、自定义事件写入，以及线程 / 运行信息。运行时上下文不应由模型输出“授予权限”。[Context engineering](https://docs.langchain.com/oss/javascript/langchain/context-engineering)，[Runtime](https://docs.langchain.com/oss/javascript/langchain/runtime)。

`executionInfo` / `serverInfo` 的文档门槛为 `@langchain/langgraph >= 1.2.8`；本地 graph 版本满足该下限，但本地 standalone 运行不应假装拥有 Server 上下文。实际类型、字段和可用性仍要以已安装包为准。[Runtime](https://docs.langchain.com/oss/javascript/langchain/runtime)。

### 3.2 Middleware、边界与预算

Middleware 可在模型 / 工具调用前后扩展日志、上下文、重试、限流和策略。建议优先采用少量有明确目的的 middleware：本轮工具预算、模型轮数上限、工具输入校验、策略审批、脱敏日志、异常分类；工具调用重试只覆盖瞬态故障，不应自动重试权限拒绝或已产生副作用的未知结果。[Middleware overview](https://docs.langchain.com/oss/javascript/langchain/middleware/overview)，[Built-in middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)。

PII middleware 的默认开关并非覆盖所有方向：当前文档中输入默认启用，输出和工具结果默认关闭。不能因“加了 PII middleware”就声称所有简历信息、日志和工具输出均已脱敏。[Guardrails](https://docs.langchain.com/oss/javascript/langchain/guardrails)。

### 3.3 HITL 是真实暂停点，不是聊天文案

官方 HITL 需要 checkpointer 和稳定线程标识；对工具名称配置审批策略，返回结构化中断，由应用收集决定后以 `Command` 恢复。支持 approve / edit / reject / respond，其中 respond 是提供替代工具结果并跳过工具，不宜用它表达副作用操作的权限拒绝。[Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)。

兼容性注意：当前文档标明 `per_call` 模式要求 `langchain >= 1.5.18`，这里是 `langchain` 包，不是本地 `@langchain/langgraph 1.5.1`。默认批量决定有顺序约束；编辑工具参数后，也必须重新判断该批准是否仍然对应原操作。其他概览页仍可能保留旧配置形状，实施时以选定版本的 TypeScript 类型及测试为准。[Human-in-the-loop](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)。

### 3.4 多 Agent、结构化输出、测试和观测

多 Agent 不是简单版本查询的前置条件。官方把 subagents、handoffs、skills、router 和自定义工作流区分开，并指出单 Agent 配合合适工具已经可以处理许多复杂任务。额外 Agent 也带来调用成本、延迟和上下文管理成本。BetterMe 应先把单次工具执行、审批和结果核验做扎实，再为独立研究 / 分析任务引入并行专家。[Multi-agent](https://docs.langchain.com/oss/javascript/langchain/multi-agent)。

结构化输出可约束最终字段，`providerStrategy` 和 `toolStrategy` 取决于模型能力；同时使用工具和原生结构化输出还要求供应商支持该组合。一个符合 schema 的 `{status: "success"}` 并不是完成真实操作的证据；业务状态必须由工具回执计算。[Structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)。

验证要分层：确定性单测覆盖路由、策略、解析和状态转换；集成测试覆盖真实接口契约；轨迹或场景评估覆盖工具选择与任务完成。模型回答流畅不能替代副作用核验。[Testing](https://docs.langchain.com/oss/javascript/langchain/test)。

观测应串起父 Run、图节点、工具调用、子 CLI 会话和审批决定。LangSmith 是可选外部观测方案，不能在用户未同意时把简历、图片、提示词和工具结果自动上传；建议先用本地脱敏事件和关联 ID，后续再显式开启外部 tracing。[Observability](https://docs.langchain.com/oss/javascript/langchain/observability)。

## 4. Claude 非交互执行：为什么退出成功仍可能没执行成功

`-p` 是非交互模式。没有可用的审批通道时，原本需要批准的调用可能被拒绝；模型仍可正常输出说明并结束回合。当前文档还描述权限拒绝事件和结果中的拒绝信息，宿主必须消费这些结构化字段，不要只看退出码或最后一段答案。[Headless](https://code.claude.com/docs/en/headless)。

新参数 `--permission-prompts none` 的官方门槛是 CLI `2.1.259`；它让未预批准的调用被拒绝，不是绕过权限。本地记录的 `2.1.218` 不能直接使用该标志。当前文档还描述更新版本的非交互默认行为，不能把文档最新默认值反推到旧 CLI。[Headless](https://code.claude.com/docs/en/headless)。

`allowedTools` 是特定规则的自动批准，不是所有其他工具都不存在的严格工具白名单。严格限制可用工具需要核对 `tools` / `disallowedTools` 等实际配置；更不能把 `allowedTools` 与 bypass 模式组合后，声称只有列出的工具能运行。[SDK 权限](https://code.claude.com/docs/en/agent-sdk/permissions)。

建议的宿主结果模型：

| 证据 | 对外状态建议 | 说明 |
| --- | --- | --- |
| 有真实、通过 schema 校验的目标工具回执 | `completed` | 展示结果、来源和时间，而非只展示模型总结 |
| exit 0 / subtype success，但目标调用出现在 `permission_denials` | `blocked` 或 `partial` | 是否 partial 取决于其他目标是否已核验完成 |
| 存活的交互协议正在等待有效批准 | `waiting_for_approval` | 可批准 / 拒绝，操作绑定到该次具体调用 |
| `is_error: true` 或结构化执行错误 | `failed` / `partial` | 保留已经核验的结果，不伪报整轮成功 |
| `stop_reason: tool_deferred` | `waiting_for_approval` 或明确的待处理状态 | 还需要匹配会话和后续权限传输，不能当 completed |
| 无权威 final，进程断开 / 宿主重启 | `interrupted` / `unknown` | 未确认结果的写操作不可盲目重跑 |
| 版本来自已验证注册表缓存 | `completed`，标注缓存时间 | 不伪装成刚执行的新探测 |

这张表是 BetterMe 的建议状态语义，不是直接照抄 Claude SDK 的状态枚举。结构化依据见 [TypeScript result 类型](https://code.claude.com/docs/en/agent-sdk/typescript)。

## 5. Claude SDK 提供什么桥接能力，限制是什么

### 5.1 `canUseTool`：有条件触发的实际权限回调

SDK 的 `canUseTool` 可把待审批工具名和输入交给应用，异步返回 allow（可含更新输入）或 deny。它也承接 `AskUserQuestion` 这类结构化问题，应该在 UI 呈现为真正的用户输入请求，而不是让用户猜一句模型回复能否继续执行。回调中等待 UI 时，应处理取消和断连，而不是制造永远无法恢复的悬空 Promise。[User input](https://code.claude.com/docs/en/agent-sdk/user-input)。

它不是所有工具必经的安全边界。当前文档的权限顺序包括 PreToolUse hooks、deny / ask 规则、权限模式、allow 规则，然后才可能进入 `canUseTool`；已被更早层级决定的调用不会统一再交给此回调。全局不可绕过的应用策略应在执行前的可控边界实现，不能只靠 `canUseTool`。[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)。

PreToolUse hooks 可以对实际工具输入作策略决定；空结果只是继续原有权限流程，并不等于已批准。SDK hook 与 LangGraph 工具 middleware 仍处于不同执行层，需要共享同一个策略决定及审计关联。[SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)。

### 5.2 进程、输入模式和版本不能混用

官方推荐交互任务使用 streaming input；它可承接多轮输入、取消和交互式控制。普通 spawn 配上忽略 stdin，不会因为 UI 增加一个“批准”按钮，就自动获得 SDK 权限协议。字符串单次 query、流式输入和恢复会话是不同的生命周期选择。[Streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)。

官方说明 SDK 的版本与内置 CLI 版本对应，例如 `0.3.191` 搭配 CLI `2.1.191`。使用独立的 CLI 路径也是另一种配置；无论选择哪种，必须明确 pin 的依赖、运行二进制和能力探测，不应把任意新 SDK 文档特性注入已发现的旧 CLI。[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)。

### 5.3 会话恢复不等于回滚或 exactly-once

SDK session 保留对话和工具历史，不是文件系统快照；resume 精确 session 与 continue 最近会话也不同。BetterMe 应持久化自己的 thread / run 与 CLI session 的对应关系，不能在多用户或并发下恢复“最近的那个”。对未知结果的写入还需独立幂等键和核验，不能把重新加载会话当作回滚。[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)。

### 5.4 `defer` 是可研究的协议能力，不是当前可无条件开启的开关

当前 CLI hooks 文档支持 PreToolUse 的 `defer`：工具待执行信息保存到会话，回合以 `stop_reason: tool_deferred` 结束；恢复精确会话时不能提供新 prompt，否则待处理调用被丢弃。它只适用于该轮单工具调用，多工具同轮会忽略 defer 并按正常权限流程处理。当前文档未在此处给出 defer 本身的最低 CLI 版本，计划模式恢复另有 `2.1.246` 门槛，因此不能据此断言旧版 `2.1.218` 支持。[Hooks：defer](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)。

这是可选适配器的兼容性研究方向，不是本轮建议立刻启用的恢复实现。即使 defer 可用，恢复时仍需正确的权限 host 和具体决定，LangGraph checkpoint 不会替它授权。

### 5.5 应用工具也可通过 SDK MCP 暴露

SDK 支持自定义 typed tool / MCP server，可将应用受控能力交给 Claude，而不是开放通用 Bash。工具 annotations（例如只读提示）有助于调度和模型理解，但不能替代执行端权限校验。[Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)。

## 6. BetterMe 建议：先实现可验证的小闭环

### 6.1 第一个闭环：版本查询

建议提供 `runtime_inspect({runtimeId, refresh})`：

1. 默认读取 Runtime Registry 中已验证的版本、可执行文件来源、能力和 `checkedAt`，不经过模型 shell。
2. 用户明确要求重新探测时，才调用预定义运行时的已验证可执行文件与固定 `versionArgs`；限制时长、输出和环境，不接受模型构造的任意命令。
3. 版本结果携带 `source: cache | probe`、时间和核验回执；失败明确区分未安装、超时、权限拒绝、不支持此探测。
4. 对用户说“没执行”时，把真实拒绝原因和可操作方案放在首位，而不是只回一段需要用户自行复制的终端命令。

这是针对当前问题的领域工具设计建议，不是建议对一般命令跳过授权。使用 SDK 或 LangGraph 都不应改变这个边界。

### 6.2 第二个闭环：具体操作、具体审批、具体回执

审批记录至少绑定下列应用字段：操作者、thread / run、子 session、tool call ID、规范化工具名与参数指纹、工作目录 / 路径范围、预期副作用、风险级别、有效期、单次使用和幂等键。审批 UI 必须展示用户真正要授权的操作及其范围。

后端在决定生效时重新校验绑定；参数修改、过期、跨 Run 重放、用户撤销和重复提交都不能复用原批准。必须把决定发送到真实执行该工具的权限通道；只改变父 Run 状态或加一句“用户已允许”到 prompt 不构成执行授权。

这些绑定是建议的 BetterMe 安全协议，不是 LangGraph / Claude SDK 自动保证的功能。不要默认持久化“以后总是允许”，不要静默写入用户 `.claude` 权限设置，不使用 `dangerously-skip-permissions` 作为补救。

### 6.3 第三个闭环：刷新 / 重启恢复

分别恢复三个对象，而不是只恢复聊天文本：

- 父工作流状态：图 checkpoint、待完成目标和已验证回执。
- 审批状态：具体调用的批准请求、到期与消费状态、审计记录。
- 执行适配器状态：仍存活的交互进程，或者经能力验证可恢复的精确子会话。

若子 CLI 已退出且不支持挂起调用恢复，应诚实显示执行已中断，重新规划一个受控调用；不能把旧审批盲目套给新进程。写操作结果未知时先核验，再判断能否幂等重试。

## 7. 拆分实施和验收建议

建议与地图 UI、查询索引等工作保持完全独立，按以下顺序落地：

| 独立切片 | 核心交付 | 先不扩张到 |
| --- | --- | --- |
| A. 结果真实性 | final / error / denial / deferred 规范化；工具事件不丢失；blocked / partial 文案 | SDK 迁移、多 Agent、视觉效果 |
| B. 应用工具闭环 | 运行时版本等确定性工具、输入 schema、工具回执 | 任意 Bash、所有页面写操作 |
| C. 持久审批 | Graph 暂停、审批 API、过期 / 重放防护、刷新恢复 | 默许所有工具、跨 CLI 通用审批幻想 |
| D. Claude 可选适配器 | 固定并验证版本、双向协议、权限桥接、精确会话恢复 | 强制替换全部已有运行时 |
| E. 质量体系 | 预算、轨迹、故障分类、本地脱敏观测和场景评估 | 未授权上传简历 / tracing |

每个切片独立测试、可回退。添加 `langchain` 或 Claude SDK 前，单独验证包兼容性、二进制来源和权限行为，不把“改包”与“改全部 UI”绑定。

最小回归矩阵：

- 版本查询命中注册表时不调用模型、不运行任意 shell；重新探测只使用固定参数。
- success final 包含 permission denial 时不得判定目标完成；结构化 error 不能因 exit 0 被覆盖。
- 嵌套 tool_use / tool_result、重复帧、缺失 final、断流和取消都能归一化且保留证据。
- 允许 / 拒绝 / 编辑 / 过期 / 撤销 / 重复批准 / 跨 Run 重放的结果可预测。
- 活动审批刷新后可恢复；子进程退出后不能留下伪装可批准的按钮。
- 取消真正终止等待并释放相关资源；超时不是审批拒绝，审批拒绝不是自动重试理由。
- 多工具审批对应正确调用；不支持 defer 的版本失败关闭，多工具 defer 限制有显式用例。
- 模型未配置、模型不支持工具调用或输出无效时，给出可操作的能力错误。
- 默认不发送简历 / 图片；撤销授权立即对下一请求生效；日志和外部 tracing 单独脱敏和授权。
- 对未知结果的写入，先核验并使用幂等协议，不把恢复或重试伪装成 exactly-once。

以上是建议验收项，本轮未声称它们已经全部通过。真实协议验收应先使用脱敏记录帧和受控假适配器，再在明确授权后执行一个有边界的真实只读任务。

## 8. 官方资料阅读索引与兼容性提醒

本轮直接查阅的官方主题：

- LangChain JS：[agents](https://docs.langchain.com/oss/javascript/langchain/agents)、[tools](https://docs.langchain.com/oss/javascript/langchain/tools)、[middleware overview](https://docs.langchain.com/oss/javascript/langchain/middleware/overview)、[built-in middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)、[HITL](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop)、[context engineering](https://docs.langchain.com/oss/javascript/langchain/context-engineering)、[runtime](https://docs.langchain.com/oss/javascript/langchain/runtime)、[multi-agent](https://docs.langchain.com/oss/javascript/langchain/multi-agent)、[structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)、[guardrails](https://docs.langchain.com/oss/javascript/langchain/guardrails)、[testing](https://docs.langchain.com/oss/javascript/langchain/test)、[observability](https://docs.langchain.com/oss/javascript/langchain/observability)。
- Claude：[headless](https://code.claude.com/docs/en/headless)、[permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[user input](https://code.claude.com/docs/en/agent-sdk/user-input)、[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)、[hooks](https://code.claude.com/docs/en/agent-sdk/hooks)、[CLI defer protocol](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)、[sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)。

长页面重点阅读相关机制、边界、类型和兼容性段落，不把无关示例或整套其他语言 / 部署产品文档宣称为逐字完整阅读。文档是 2026-10-29 的在线版本；实施时应再次对照已锁定的包类型及运行时，尤其避免将新 CLI 的非交互行为、defer 和新 flags 推断到旧安装版本。
