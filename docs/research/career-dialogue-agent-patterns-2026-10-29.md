# 职业顾问式 Agent：多轮提问、证据与可恢复交互

研究日期：2026-10-29。本文是拟议设计，不代表功能已经实现或服务已经验收。复用此前的 [LangGraph JS 章节研究](./langgraph-js-documentation-study-2026-10-29.md)，本次只复核与职业对话相关的官方文档；没有重新声称覆盖全部 LangChain 文档。未读取或保存个人简历、私聊、共享对话正文及个人画像。

## 1. 要复现的是交互能力，不是假定能读取 ChatGPT 记忆

建议目标是：使用用户明确授权的资料，先给有证据的初步判断，再用少量关键问题减少不确定性；提交选项后，在同一对话中自动继续分析。不能宣称了解未导入的历史、恢复未提供的附件，或复制 ChatGPT 未公开的内部画像机制。

输出分开记录：

- **事实**：可回溯到简历条目、用户原话或岗位来源，并携带出处与版本。
- **偏好**：用户明确表达的目标、约束、取舍及确认时间；新旧矛盾时询问，而非静默覆盖。
- **待确认观察**：只描述与工作相关的行为线索、其他可能解释和需要验证的问题，不把推断写成稳定人格结论。
- **建议**：排序依据、相关事实、主要代价、未知条件，以及什么新信息可能改变排序。不伪造精确人格分数或“岗位适合度 93%”。

这些是 BetterMe 的产品约束，不是框架自动提供的客观评估能力。LangChain 官方强调每次模型调用的上下文需要主动选择；永久保存的状态与本轮临时模型上下文可以不同。[Context engineering](https://docs.langchain.com/oss/javascript/langchain/context-engineering)

## 2. 三种存储职责必须分开

| 层次 | 建议保存 | 不应承担的职责 |
| --- | --- | --- |
| Checkpointer | 线程消息、当前阶段、已确认回答、待答问题与版本、授权和来源引用 | 自动获得跨会话画像；默认保存所有检索原文 |
| Store | 用户明确允许跨会话复用的偏好与记忆，含来源、更新时间、确认状态 | 把每次模型推测升级为事实，或替代线程断点 |
| 来源库与检索 | 已授权的简历/历史片段、索引、文档版本；按本轮需要返回有限证据 | 把所有历史逐字塞进每次提示词，或绕过授权 |

官方短期记忆依赖线程状态及 checkpointer；跨线程数据由 Store 补充。Store 的 namespace 是组织数据的手段，不是应用鉴权的替代品；检索必须限定当前身份和授权范围。[Memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory)、[Stores](https://docs.langchain.com/oss/javascript/langgraph/stores)

建议每轮重新核对资料授权，再组装最小必要上下文。撤销授权后，停止后续检索及模型使用，并处理旧摘要、checkpoint、检索缓存和追踪副本；仅删除 Store 条目不代表其他副本已经删除。简历事实库保持独立，职业对话不得自动回写事实或改动简历。权限应由宿主强制执行，不能只依赖模型提示词。[Security policy](https://docs.langchain.com/oss/javascript/security-policy)

## 3. 普通追问和工具审批是两类协议

普通职业追问推荐采用结构化输出：`分析内容 + 可选问题卡 + 当前证据/缺口`。一次回答结束后等待用户；点击提交形成下一轮用户输入，随后自动调用同一线程继续分析，无须复制选项或再点“发送”。不必把每个普通问题都包装成工具调用。

若工作流必须暂停在图的中间阶段，才使用动态 `interrupt(questionPayload)`，配合持久化 checkpointer；回答通过相同 `thread_id` 的 `Command({ resume: answer })` 恢复。已正常结束的普通多轮聊天则传新的普通输入对象，不能用 `Command({ update })` 冒充恢复。动态中断会重跑所在节点开头，故生成问题 ID、记账等逻辑必须可重放；不要在中断前放无幂等保护的写操作。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

`awaiting_input` 表示需要了解用户目标；`awaiting_approval` 表示准备执行一个有影响的动作。回答“愿意考虑其他行业”不能授权采集、运行终端、修改简历或投递。两者可复用卡片外观，但必须有不同的服务端命令、校验和授权语义。

结构化响应可以通过原生结构化输出或受支持的工具策略获得，仍需在服务端做 schema 校验。采用前应核对当前模型、适配器和依赖支持，不能假设安装 LangGraph 就同时拥有 `createAgent` 的全部能力。[Structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)

## 4. 最小问答协议草案

以下为应用协议示例，不是已存在的项目类型；选项和提交均为数据，不执行任意 HTML 或脚本。

```ts
type CareerQuestion = {
  kind: "career.clarification";
  threadId: string;
  questionId: string;             // 服务端生成，重放时保持稳定
  revision: number;               // 问题/选项改变时递增
  basisRevision: string;          // 该问题依据的分析/资料版本
  prompt: string;
  whyItMatters: string;
  selection: "single" | "multiple";
  options: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
  canSkip: boolean;
  interruptId?: string;           // 仅真正暂停的图需要，不能作为权限凭证
};

type SubmitCareerAnswer = {
  threadId: string;
  questionId: string;
  questionRevision: number;
  basisRevision: string;
  clientEventId: string;          // 双击/网络重试复用同一个值
} & (
  | { action: "answer"; selectedOptionIds: string[]; freeText?: string }
  | { action: "skip" }
);
```

宿主依据登录/本机会话身份验证线程归属，不能信任客户端传入的身份。检查选项属于当前问题、单多选数量、文本长度与 skip 权限；只有校验通过后才提交回答。对 interrupt 使用 Zod `responseSchema` 可验证恢复值；仅提供 JSON Schema 不会自动获得该运行时验证。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

前端建议：不预选答案；支持“都不符合/补充说明”和允许时的“暂时跳过”；提交后先展示用户的真实选择，再呈现后续分析。错误留在原卡片上，保留选择并提供重试；不把失败变成空白回答。一次先追问一个最能影响排序的问题，通常不超过三问再回到有用结论，避免问卷式阻塞。

## 5. 状态合并、去重和自动继续

拟议流程为：授权与证据检索 → 初步排序 → 关键缺口判断 → 问题卡 → 接收回答 → 更新当前取舍 → 重新排序/给出下一步。每次用户提交只触发一个后续逻辑轮次，不让 Agent 在没有新用户输入时自行扮演用户继续对话。

消息使用稳定 ID 及 message-aware reducer；新消息追加，已有同 ID 消息更新，不能在重试或恢复时机械 concat 造成重复。待答问题采用明确的单值替换，答案按问题 ID 合并；这些是应用设计，普通数组 reducer 本身不保证去重。官方 Graph API 提供消息 ID 感知的 `MessagesValue`/`messagesStateReducer`，并说明默认状态更新为覆盖。[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)

应用层仍需：

1. 用当前线程的待答状态和 `questionRevision + basisRevision` 做原子比对，旧卡片不修改新分析；提示用户问题已更新。
2. 持久化唯一提交键（会话身份、线程、`clientEventId`），同键同内容返回既有回执，同键不同内容拒绝。
3. 每线程串行提交或加版本锁；把“接受回答”和“排队继续”做成可恢复提交，防止崩溃后答案已存却没有后续运行。
4. 让重试恢复同一逻辑 turn/run；保证一个用户轮次和一致结果，不声称跨网络、模型供应商和数据库具有天然“恰好一次调用”。

界面只接收白名单投影：正文、证据引用、问题卡、提交状态、可行动错误、`threadId/runId/seq`。不要直接转发包含完整私有上下文的 `values`。官方 custom channel/transformer 可传结构化 UI 数据并处理流式脱敏，但仍需项目自己的投影和权限策略；无需因此强制迁移现有通信层。[Custom stream channels](https://docs.langchain.com/oss/javascript/langgraph/frontend/custom-stream-channels)

## 6. 正确性验收与分阶段落地

先做可独立验收的对话闭环，再接长期记忆和更多工具，不与地图、采集、查询索引或视觉动画耦合。

- **证据与诚实性**：未授权/未提供的历史明确显示未使用；事实、偏好、观察、建议分层；每条关键结论可指向来源，缺失条件可见，不用无依据分数制造精确感。
- **交互闭环**：单选、多选、自由文本、跳过均可走完；一次提交显示一次用户回答并自动产生一次后续逻辑轮次；普通输入不要求执行审批。
- **恢复一致性**：双击、断网重试、刷新/重连、宿主重启、旧卡片提交、同时提交和资料版本变更均有明确结果；恢复不重复写入答案，也不重用失效授权。
- **隐私边界**：用合成 canary 验证未授权内容不会进入模型请求、UI 流、Store、checkpoint 或追踪；已授权但临时检索的内容按政策处理，撤销后不能从旧摘要继续偷偷使用。
- **安全边界**：用户选择不自动授予工具权限；不会改简历、写入 Fact 或投递；执行类操作使用独立授权协议。
- **测试证据**：先用合成资料和确定性模型替身测试 schema、路由、幂等与授权；再做带持久化 checkpointer 的图集成测试，实际经过 pause/resume，而非只单测节点函数。官方测试指南提供图与节点测试的不同边界。[Test](https://docs.langchain.com/oss/javascript/langgraph/test)

本文没有验证当前 BetterMe 是否已经具备上述能力，也未运行模型、安装依赖、启动服务、刷新用户页面或改动应用代码。
