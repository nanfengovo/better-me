# 简历伴写：项目理解、受控取证与共识确认

日期：2026-11-01。现有 `agent-os` 分支，基于 `1c63beb1507f55b65a36500b98eba3f3715996c7` 实现。首次功能验收后，按用户要求单独准备提交、推送与 CI / Docker 验收；既有岗位采集改动保留，不纳入本功能提交或发布镜像。最终提交与远端结果以实际 Actions 记录为准。

## 实际交付

入口直接接在 `ResumeWritingCopilot` 的“先对齐项目理解”，不是只做一个独立演示页。隔离页复用实际 FactEditor、ResumePreview、ResumeWritingCopilot 和 ProjectUnderstandingPanel，用来验证这条产品接线。

1. 用户先授权具体目录或单文件，再逐轮同意把当前字段、相关对话和授权材料交给明确选择的推理方式。打开面板不自动读取源码或调用模型。
2. Agent 自己选择列目录、字面搜索、按行读取，或提出问题。所有读取经过 `EvidenceBroker`；不提供 shell、写文件、网络或扩大授权范围的工具。
3. Agent 返回完整项目理解：概要、术语、边界、材料事实、用户陈述、待核对推断和未知。问题与选项由运行时生成，无默认勾选，允许选择加自由补充，也允许只自由作答。
4. 没有固定访谈轮数。只对单轮施加读取/推理预算和超时；默认 180 秒，可随时停止。无效结构或证据引用最多纠正两次，仍不合格则保留历史并明确失败，不降低校验要求。
5. 只有当前版本的完整理解可被确认，绑定 revision 和完整结构化摘要 hash。继续纠正、改原文、变更资料授权会使原确认失效。
6. 确认后回到已有伴写，仍需显式勾选“本次携带已确认项目共识”。背景只用于解释术语和边界，不扩大个人动作、成果、数字的证据范围；不自动生成或写入简历。

## 模块与持久化

- `packages/agent-contracts/src/project-understanding.ts`：跨端契约和结构化决策。
- `apps/agent-host/src/understanding/evidence-broker.ts`：目录/精确单文件授权、限量只读取证。
- `apps/agent-host/src/understanding/service.ts`：持久会话、受控工具循环、历史检索、版本确认、幂等提交、撤销/超时/取消/重启恢复。
- `apps/agent-host/src/understanding/http.ts`：继承现有认证与 Origin 校验的 HTTP 入口，以及已有模型传输适配。
- `apps/agent-host/src/understanding/native-provider.ts`：与普通 CLI Run 分离的严格原生 Agent 推理适配。
- `apps/web/src/components/ProjectUnderstandingPanel.tsx`：实际产品 UI，稳定字段身份恢复历史与草稿。
- `apps/web/src/lib/resume-copilot.ts` 与 `ResumeWritingCopilot.tsx`：确认上下文的新鲜度检查及伴写接线。

会话和证据保存在 Agent Host 专用目录，文件权限 0600、目录 0700，与简历和岗位库分开。浏览器仅保存会话指针、未发送草稿和待确认提交标识。模型认证和运行时闭包不进入会话存储；不保存内部思维链。

这是**当前字段关联的项目共识记忆**，不是已完成的跨项目全局用户画像。完整历史持久保存，模型每次接收有限最近上下文，并可检索更早消息；不宣称某个模型拥有无限上下文。长历史检索回归覆盖第 19 轮恢复早期纠正；UI 用第 41 轮继续提交证明没有固定轮数门槛。

## 受控取证与原生 Agent 边界

- 支持许可范围内的文本源码和文本资料；并非任意 PDF、Office 或二进制解析器。
- 拒绝宽泛系统/用户根目录、越界路径、父级/子级符号链接、硬链接、隐藏或敏感配置、依赖/生成目录、二进制、过大文件及超限片段。读取使用只读句柄和文件身份复核。
- 内容过滤是启发式防护，不是完整 DLP；UI 明确要求用户不要授权凭据或不应共享的材料。
- 每段证据保留文件、行号、内容指纹和采集时间。它是采集快照，不证明生产系统正在如此运行，更不证明本人实现了这些代码。
- 撤销授权会清除可再用于推理的相关源码片段、排除旧派生 Agent 对话上下文并使共识失效；历史对话和采集元信息仍可供用户审计。撤销不是抹除所有历史，也无法撤回已经发送给所选提供商的内容。
- 本机运行时发现使用独立 resolve-only inventory，不自动跑普通 CLI 的版本/鉴权/配置扫描。未支持的运行时保持禁用，不回退到普通无限权 Run。
- 当前严格原生 Adapter 仅实现 Claude Code bare 协议，要求已有 `ANTHROPIC_API_KEY` 环境认证及完整兼容标志；不读取、复制 OAuth 登录态或密钥文件。工具、MCP、插件、hooks、技能和持久会话关闭，使用隔离配置目录、最小环境及 stdin 输入。CLI 输出若出现工具活动、权限拒绝或错误即拒绝结果。
- 本轮原生协议用合成 CLI 子进程测试验证，**没有宣称已用真实 Claude/Codex/Gemini CLI 完成新流程端到端验收**。普通已安装 CLI 不等于本流程已安全支持。该约束也不是恶意可执行程序的 OS 级沙箱。
- 现有配置模型可走同一受控 Broker。真实验证使用了已存在的 Ollama 本机小模型，以及通过本机 Ollama 访问的既有云模型；后者明确是云推理，不冒充离线。

## 实际浏览器验收

专用 Web origin `127.0.0.1:5196` 和 Agent Host `127.0.0.1:5206`，临时会话目录、MemorySaver、虚构简历和 5 行虚构 `dispatch.ts`。没有接入岗位 Repository，没有载入真实简历存储；未读取或修改业务项目。正常 5173 页面未手动刷新、重启或切换配置。

| 验证 | 实际结果 |
| --- | --- |
| 现有伴写入口 | 检查当前简历 → 先对齐项目理解，打开时不自动开始模型轮次 |
| 真实本机 `gemma4:e2b-it-qat` | 最初暴露格式/引用和工具路由错误，均被拦截；补 schema 约束与 Broker 提示后，实际读取授权源码并返回中文边界解释和未预选的问题。该次耗时约 153 秒，不能宣称低延迟 |
| 真实 `gemma4:31b-cloud` | 通过 Broker 读取同一虚构文件；动态提问、选择加自由纠正、后续问题随回答变化、最终进入待确认；共 3 轮是这次样本结果，不是系统固定轮数 |
| 通用语言纠正 | 初次出现无关缩写释义选项，补充“不做缩写猜词题”的约束；自由纠正后保留“运单编排层”，明确“计划生成不代表发送成功或搬运完成”，追问转为实际衔接关系 |
| 人工确认与刷新 | 确认版本 9 后显示已确认；刷新重开恢复相同版本及 7 条历史，虚构简历原文未变化 |
| 撤销授权 | 版本更新为 10，旧共识失效、历史仍在；重新打开显示“等待继续对齐”，不误称初次开始 |
| 超时与恢复 | 使用明确标注的故障夹具和 1.5 秒测试期限：真实 HTTP 请求超时，UI 保留输入/历史；下一轮继续成功，不清空会话 |
| 停止/草稿/原文变化 | 故障夹具中停止后保留输入；重开恢复；原文字段变化后旧确认不可用，显式更新材料才继续 |
| 接回既有伴写 | 收起项目理解 → 一起完善经历，出现未默认勾选的“本次携带已确认项目共识”；不自动发送模型请求、不自动改写原文 |

验收过程中执行环境曾中断，临时测试服务与临时会话内容丢失；UI 对缺失会话明确报错并保留浏览器草稿。中断的模型轮次没有计作成功，随后仅重建隔离环境继续验收。

验收结束仅停止本轮自建的 5196/5206 测试进程；未停止正常应用服务。临时验收记录和截图保留，未删除用户资料。

本地截图（忽略目录，不含真实简历/业务数据）：

- `output/playwright/project-understanding-confirmed-2026-11-01.jpg`：真实云模型 + 虚构资料，确认卡片与原文并列。
- `output/playwright/project-understanding-timeout-2026-11-01.jpg`：真实浏览器超时、输入和历史保留。
- `output/playwright/project-understanding-copilot-2026-11-01.jpg`：共识以显式勾选接回已有伴写。

隔离启动入口：

```sh
pnpm exec tsx apps/agent-host/tests/understanding-browser-host.ts
pnpm --filter @better-me/web exec vite --config tests/ui-lab/project-understanding.config.ts
```

默认是确定性故障夹具；`?live=true` 选择现有本机模型，`?live=true&model=cloud` 选择明确标注的既有云模型。这两个型号只属于手动验收入口，不写入正式用户配置。只有在本机本来具备对应模型时才可运行真实模型验收。`BETTER_ME_UNDERSTANDING_TEST_TIMEOUT_MS=1500` 仅用于故障夹具。不要把测试页当成用户正常应用。

## 自动验证与审查

- 最后定向：`understanding-*.test.ts`、understanding-client、project-understanding-panel、resume-copilot：**66/66 通过，0 跳过、0 失败**。
- 较早一轮包含全部 Agent Host tests 和上述 Web tests：**125/125 通过**；与最终定向用例有重叠，不相加。
- 最后 `turbo run typecheck build --filter=@better-me/agent-host --filter=@better-me/web`：**9/9 任务通过**，含依赖构建。
- 变更生产源码 ESLint：`--max-warnings 0` 通过；`git diff --check` 通过。
- 独立审查发现并修复：能力发现误走普通运行时扫描；旧窗口停止请求可能取消新轮次。分别加入真实 HTTP 路由哨兵和轮次身份回归。
- 既有构建仍提示地图模块 Node 内置依赖被外置和大分块；本轮没有降低门禁或扩大修改到这些既有问题。

首次功能验收未覆盖：真实业务资料理解、真实原生 CLI 新协议生成、跨项目画像合并/成长时间线、移动真机与所有主题组合、远端 CI。不能把虚构浏览器样本外推为这些能力已完成。

## 发布与 Docker 验收范围

发布时仅暂存本功能、测试、文档及对应 Memory Bank 段落；岗位采集、逐岗公司冲突隔离及相关报告继续留在原工作区。使用 Git 暂存树的独立导出构建和回归，而不是从混有采集改动的目录构建镜像。不新建分支，不改 main。

完整 runtime 镜像已包含项目理解模块，持久目录为 `/data/agent/runs/understanding`；增加源码版本标签。Docker 自动验收补充：同源鉴权、容器不冒充宿主机原生 CLI、创建会话不自动读文件或调用模型、精确文件授权/撤销、拒绝尚未生成的共识确认，以及崩溃重启/容器重建后恢复相同历史、原文版本与已撤销授权。测试只使用独立卷和公开镜像内的源码，不接业务项目或外部模型。

Docker 默认不挂载宿主机资料，不复制 CLI 登录态；容器路径与宿主机路径不是同一个授权范围。更新镜像不迁移、清空或覆盖已有数据卷，也不操作正常 5173 页面。使用方式及边界见 [Docker 指南](../docker.md)。

## 参考与取舍

继续沿用已有 Agent Host 与模型适配；新共识状态是独立持久化模块，不把项目事实混入简历 Fact，也不声称新模块已重写为 LangGraph interrupt 图。其确认与恢复语义参考已有 LangGraph 人工介入模式：[官方 human-in-the-loop 文档](https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/)。

本机 Ollama schema 解码仅启用于 loopback、本机非 cloud 标记模型；未假设所有兼容端点支持该能力。[Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)、[OpenAI-compatible transport](https://docs.ollama.com/api/openai-compatibility)。

原生适配以官方 bare/headless 参数及实际 help 校验为依据，不仅凭“命令存在”启用：[Claude headless](https://code.claude.com/docs/en/headless)、[CLI reference](https://code.claude.com/docs/en/cli-reference)。
