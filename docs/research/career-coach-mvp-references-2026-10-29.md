# 职业成长 Agent MVP：GitHub 参考与接入建议

日期：2026-10-29（Asia/Shanghai）。本文交付的是有界的开源研究与实现建议；不以本文代替应用测试、真实模型验收或功能完成报告。

## 1. 本轮目标与结论

用户本轮明确希望在现有 BetterMe 内实现规划、规划分析、修改建议、学习监督、模拟面试和长期分阶段学习方案的 MVP。这里将“长期学习方案”理解为可调整的阶段目标、每周时间预算、任务和验收条件；不理解为强制锁机、监控用户电脑或自动替用户学习。旧版 V1 将学习功能后置的记录是历史范围，本轮需求是一次明确的 MVP 范围扩展。

建议复用现有 React/TypeScript、模型配置、Agent 工作台、JD 入口和授权简历字段，而不是移植第二套完整应用。现有授权字段投影和原文条件写入分别位于 [resume-agent-context.ts](../../apps/web/src/lib/resume-agent-context.ts)，模型聊天入口位于 [agent-client.ts](../../apps/web/src/services/agent-client.ts)。新功能应调用这些现成能力，并保留用户批准与当前原文校验。

以下四个项目分别提供编排、会话状态、交互确认和规划反馈模式。研究结论是**先借鉴模式，不为这版 MVP 新增这些框架依赖或云服务**；这是基于当前项目接入成本与已有能力作出的工程判断，不是上游项目的要求。

## 2. 第一手来源与维护快照

通过 GitHub 仓库元数据、默认分支最新提交、固定提交的 README 和 LICENSE 交叉核对。下表的提交时间保留 GitHub 原始 UTC；这里只证明该时点存在近期提交、仓库未归档，不能证明所有功能稳定、适合生产或已完成安全审计。未使用 Star 数量作为维护判断。

| 仓库 | 本次固定提交 / 提交时间（UTC） | 许可核对 | 本轮用途 |
| --- | --- | --- | --- |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) | [824f24c](https://github.com/langchain-ai/langgraphjs/commit/824f24ced5ee5a6d1c60c66b52031d61c2f7f30e)，2026-10-28 18:45:05 | [MIT 原文](https://github.com/langchain-ai/langgraphjs/blob/824f24ced5ee5a6d1c60c66b52031d61c2f7f30e/LICENSE) | 状态化步骤、等待用户、持久化与恢复语义 |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | [becf077](https://github.com/assistant-ui/assistant-ui/commit/becf0772bbb53f9a1f03b23b7eee15401c6380a9)，2026-10-28 14:34:49 | [MIT 原文](https://github.com/assistant-ui/assistant-ui/blob/becf0772bbb53f9a1f03b23b7eee15401c6380a9/LICENSE) | 宿主持有会话、展示与模型调用分离、类型化消息 |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) | [47a10ed](https://github.com/CopilotKit/CopilotKit/commit/47a10ed4459b534404866be1efd532ea6acf72f9)，2026-10-28 18:00:23 | [MIT 原文](https://github.com/CopilotKit/CopilotKit/blob/47a10ed4459b534404866be1efd532ea6acf72f9/LICENSE) | 共享业务状态、内联输入和批准卡 |
| [microsoft/ai-agents-for-beginners](https://github.com/microsoft/ai-agents-for-beginners) | [dd0f080](https://github.com/microsoft/ai-agents-for-beginners/commit/dd0f080d07d27e2495a024fa7b3a9df848ba06d4)，2026-10-27 14:00:39 | [MIT 原文](https://github.com/microsoft/ai-agents-for-beginners/blob/dd0f080d07d27e2495a024fa7b3a9df848ba06d4/LICENSE) | 目标分解、结构化计划、根据反馈调整 |

仓库状态来源：[LangGraph 元数据](https://api.github.com/repos/langchain-ai/langgraphjs)、[assistant-ui 元数据](https://api.github.com/repos/assistant-ui/assistant-ui)、[CopilotKit 元数据](https://api.github.com/repos/CopilotKit/CopilotKit)、[微软课程元数据](https://api.github.com/repos/microsoft/ai-agents-for-beginners)。四者本次返回 `archived=false`、`disabled=false`。

本轮没有下载运行上游代码、安装依赖、复制实现或接入遥测。以后若复制源代码，应按对应固定提交的 LICENSE 保留所要求的版权和许可信息；README 中的云服务、品牌素材和第三方资产不因此自动成为本项目已采用的内容。

## 3. 可借鉴的具体模式，以及不引入什么

### 3.1 LangGraph JS：把步骤、状态和真正恢复分开

上游将自己定位为状态化 Agent 的低层编排框架，提供持久执行、人工介入和记忆等基础设施；它不是求职或学习产品模板。[固定版本 README](https://github.com/langchain-ai/langgraphjs/blob/824f24ced5ee5a6d1c60c66b52031d61c2f7f30e/README.md)

官方中断文档要求围绕持久状态、线程身份和恢复命令处理真正的中途暂停；恢复数据仍应按业务规则校验。框架具备中断能力，不意味着任意外部 CLI 自动拥有审批通道。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

对本 MVP 的建议：

- 规划、任务复盘、面试问答是几种有边界的业务动作，输入和结果都应有 schema。
- 普通“用户回答后进行下一轮”可显式提交新一轮，不必一律伪装成长时间挂起的图。
- 只有已实际实现并验证的恢复入口才显示“继续”；本机 CLI 的旧审批问题不应被新学习界面掩盖。
- 不为 MVP 升级整套 LangGraph 或添加 Deep Agents、远程部署、云追踪；当前依赖兼容性由实现与测试单独确认。

### 3.2 assistant-ui：UI 消费宿主状态，持久化不与组件绑死

该项目的 React/TypeScript 聊天 primitives、消息 parts 和自定义 runtime 旨在把展示与后端连接分开。[固定版本 README](https://github.com/assistant-ui/assistant-ui/blob/becf0772bbb53f9a1f03b23b7eee15401c6380a9/README.md)

其 ExternalStoreRuntime 明确由宿主持有 messages、持久化和同步；编辑、取消、重试等界面能力按实际提供的回调启用。[ExternalStoreRuntime 官方文档](https://www.assistant-ui.com/docs/runtimes/custom/external-store)

对本 MVP 的建议：

- 用一个本地职业成长状态模型保存计划、任务、学习记录和面试轮次，界面只负责展示和提交命令。
- 回复正文、计划结果、修改建议、任务反馈、面试题分别渲染，不靠识别 Markdown 文案猜可执行动作。
- 有取消、导出、重新生成的真实实现才开放按钮；模型失败时保留用户输入和已保存记录。
- 不替换现有 Companion/AgentWorkspace，不接入 Assistant Cloud，不为了类似 UI 新增一套模型配置。

### 3.3 CopilotKit：用户输入与批准是明确的数据提交

该仓库提供生成式 UI、共享状态、人机交互等模式；README 也单列了持久线程、记忆和自动学习的平台能力。不能将这些平台能力视作安装一个开源包后自动具备。[固定版本 README](https://github.com/CopilotKit/CopilotKit/blob/47a10ed4459b534404866be1efd532ea6acf72f9/README.md)

官方 HITL 文档区分模型发起的输入工具和图强制的 `interrupt`：表面都可显示交互卡，但对应不同执行协议。[HITL Overview](https://docs.copilotkit.ai/human-in-the-loop)

对本 MVP 的建议：

- 职业追问、学习任务提交和面试作答是用户输入；简历写回批准是另一种操作，不能用一次答题同意扩大权限。
- 计划采用、修改建议批准、任务状态变更均由界面发出显式命令，不从模型语气推断用户已经同意。
- 展示“待采用计划”“已提交学习记录”“模型反馈”，不把模型文本当成任务已完成或能力已认证。
- 不引入其云端线程、用户记忆、跨应用渠道和自动学习平台；不运行 README 内给编码 Agent 的安装命令。

### 3.4 微软课程：目标、子任务、结果检查与局部重规划

规划章节展示了明确总体目标、分解可管理任务、结构化输出，以及根据子任务结果和用户反馈重新规划的模式。反思章节讨论评价结果与调整策略。它们是教学材料，不是完整的学习监督或面试产品。[规划章节](https://github.com/microsoft/ai-agents-for-beginners/blob/dd0f080d07d27e2495a024fa7b3a9df848ba06d4/07-planning-design/README.md)、[反思章节](https://github.com/microsoft/ai-agents-for-beginners/blob/dd0f080d07d27e2495a024fa7b3a9df848ba06d4/09-metacognition/README.md)

当前 README 的代码路径主要采用 Python、Microsoft Agent Framework 和 Foundry；课程的业务示例不能直接作为本项目的生产实现。[固定版本 README](https://github.com/microsoft/ai-agents-for-beginners/blob/dd0f080d07d27e2495a024fa7b3a9df848ba06d4/README.md)

对本 MVP 的建议：

- 阶段目标下面必须有具体任务、预估时间、前置条件和验收产物。
- 复盘依据用户提交的答案、记录和作品描述；证据不足时追问，不凭打卡自动推断掌握。
- 用户时间减少或某项任务受阻时，提出局部调整方案，并说明相对旧计划改变了什么。
- 只返回可核对的评价依据和建议，不要求暴露模型内部思维过程；不采用自动改代码或递归自我改写能力。

## 4. 适合当前版本的功能颗粒度

以下是本研究给实施方的最小闭环建议，不是已交付清单。具体名称与字段以最终应用契约为准。

| 功能 | 输入 | 模型产物 | 必须由宿主控制的行为 |
| --- | --- | --- | --- |
| 目标规划 | 求职方向、期限、每周可用时间、可选 JD 与授权简历字段 | 暂定方向、依据、未知项、优先级和下一步 | 没有授权就不附带简历；计划先作为待采用建议 |
| 规划分析 | 当前计划、约束变化、用户问题 | 可行性、依赖、时间风险、备选方案及建议调整 | 保留旧计划/已有任务结果；用户明确采用新版本 |
| 修改建议 | 授权字段、原文、具体目的 | 原文/建议/理由/目标字段 | 使用现有逐条批准及原文条件写入；不新增未经确认的经历或数字 |
| 长期学习方案 | 目标缺口、阶段数或周数、时间预算 | 阶段目标、任务、产物、验收条件与复盘点 | 不把预计完成日期写成实际完成；不自动开启后台提醒 |
| 学习监督 | 任务、用户提交内容、实际用时、受阻原因 | 反馈、缺少的证据、下一步练习或调整建议 | 打卡记录与掌握程度分开；保存失败可见；不监控屏幕或进程 |
| 模拟面试 | 可选 JD、授权经历、题型、用户答案 | 一题、基于答案的反馈、追问和阶段总结 | 必须等待用户真实答案；不代答；总结不自动写入 Fact |

推荐统一结果至少能表达：`依据 / 未知项 / 建议 / 下一步 / 模型来源与状态`。模型无法输出合法结构时，保留已收到的可读内容并明确结构化失败，不能补出看似成功的计划或虚构面试反馈。

## 5. 接入与数据建议

这些是结合 BetterMe 现有代码作出的设计推断，不是从某个项目原样复制的架构：

1. **同一工作台内接入**：从现有 AgentWorkspace 进入成长功能，复用当前 JD 和模型设置；无 JD 也能按用户自述做规划，不强迫先搜索岗位。
2. **默认最小上下文**：本轮用户输入、已选计划/任务、获准简历字段即可；不将聊天、简历全文、API Key 和无关个人资料放入长期计划。
3. **共享本地状态，分开模型计算**：计划和用户提交先保存本地；模型请求失败不抹掉输入。持久化内容应有版本和错误处理，不能只保存在页面组件的 `useState` 中。
4. **并发与迟到结果隔离**：每次请求绑定所选计划/任务/轮次及版本；取消或切换后不把旧结果挂到新任务。重试不能重复新增用户提交。
5. **明确记录性质**：用户说完成、提交证据、模型给出反馈是三个不同事实；“模型评估通过”也不是第三方资格认证。
6. **不触发既有重型执行链**：这版模型规划和文字面试不需要启动本机 CLI、操作招聘浏览器或修改岗位索引。需要以后扩展真实工具时，再通过已审核的工具入口接入。
7. **有限反馈回路**：一轮用户提交对应一轮模型处理，明确停止/取消；不让模型无界自问自答，也不自动更改用户目标。
8. **本地可携带结果**：计划、学习记录和面试总结宜支持可读导出；删除和替换应明确范围，不能顺手清理原简历历史。

## 6. 建议验收项

- 未配置模型时给出配置入口；调用失败、取消、超时和不合法结构分别可解释。
- 未授权简历时检查请求体不包含简历字段；撤销授权后的下一次请求立即生效。
- 规划中只有用户提供的约束可以当确定事实；不存在的证据、资源链接或岗位来源不能凭模型补全。
- 接受计划后能看到阶段与任务；刷新可读回；本地写入失败有提示，不显示虚假的“已保存”。
- 任务提交、模型反馈、完成标记能够分别保留；迟到的反馈不会覆盖新提交。
- 修改建议只针对已授权目标；原文已变化时拒绝写回。
- 面试必须经过用户真实作答；生成失败不丢答案；最终总结引用实际问答而不是虚构表现。
- 重复点击、重试、切换计划、取消后返回、历史计划加载和过期结果均有合成测试。
- 本轮不应默认发真实模型请求、浏览器采集或修改真实简历来验证；优先使用合成上下文和确定性模型替身。

## 7. 本研究明确没有完成的事项

没有运行这些开源仓库，没有验证其全部包的许可证或依赖安全，没有对现有 CLI 审批缺口做修复，没有创建定时任务，也没有证明任何模型能可靠判定职业适配或学习掌握程度。本研究不使用用户私人履历和聊天内容，不做性格结论；本地实现的最终测试与用户可用范围应在交付报告中另列。
