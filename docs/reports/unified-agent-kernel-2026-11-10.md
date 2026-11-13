# BetterMe 统一 Agent 内核实施验收

2026-11-10，本地 `agent-os` 工作区。首条岗位定制任务已接通统一宿主内核、右侧共享任务视图及一种受限自建工具；普通聊天、原旁写生成和旧图的整体迁移仍未完成。原设计见 [统一内核与工具成长](../planning/unified-agent-kernel-and-tool-growth-2026-11-10.md)。

## 已实现的任务链路

AI 顾问的“岗位定制任务”将 JD 快照和目标交给右侧“岗位任务”。用户先确认底座、简历字段、项目材料、目录、预算及可选工具权限，Host 再执行取证、下一步决策、必要追问和草稿生成。逐条批准后，Career Workspace 保存独立岗位版本，并向 Host 回写保存回执。采用文案不更新共享 FactBase，也不安装工具。

```text
AI 顾问入口 → 稳定的右侧任务视图 → Task Client
                                      ↓
                          每个 owner 一个 AgentTaskKernel
                          授权 / 累计账本 / 检查点 / 游标事件
                                      ↓
                       本任务工具目录与执行前校验
                    /                         \
          JD、简历、授权材料、目录          同底座受限工具构建
                    \                         /
                         带来源的逐条待审稿
                                      ↓
                    用户批准 → Workspace 独立版本及回执
```

`apps/agent-host/src/kernel/service.ts` 是本路径唯一执行实现，旧 `tasks/service.ts` 只保留兼容导出。新 `/api/v1/agent/tasks` 和旧 `/api/v1/agent/career-tasks` 共用同一实例、私有任务文件和 SQLite 单写者锁，没有另建第二套任务库。

内核提供 `createTask`、`dispatch`、`readTask`、`watch`。事件支持 `afterSequence` 游标；读取状态和重连不重新推理。正式简历与长期事实仍走现有独立审批接口，尚未将所有兼容操作改造成仅四种外部方法的严格 facade。

## 工具接入范围

| 工具与入口 | 本批状态 | 执行边界 |
| --- | --- | --- |
| `discover_tools` | 已接入 | 只返回当前任务获准的目录，执行时再次检查 |
| `read_job`、`decompose_job` | 已接入 | 固定 JD 快照；拆解复用 `decomposeJdText`，无额外模型请求 |
| `read_resume` | 已接入 | 只读授权字段，不写正式简历 |
| `search_materials`、`read_material` | 已接入 | 仅用户选定的材料文本 |
| `list_directory`、`search_directory`、`read_file` | 已接入 | 复用 EvidenceBroker，未授权时不进入工具目录 |
| `list_evidence`、`read_evidence` | 已接入 | 分页来源索引和原文回读，不能借句柄扩大资料范围 |
| `build_tool`、`use_tool` | 已接入一种契约 | 显式启用后构建；只执行合格的本任务版本或逐版本授权的私有安装版本 |
| 逐句审阅、岗位版本保存、长期事实提案 | 复用业务审批 | 不向模型提供自动批准、正式写回或投递工具 |
| 普通聊天、原旁写生成、旧 JD / understanding 图、独立编码实验台 | 尚未整体迁入 | 后续先拆出逐次可计量适配，不把隐藏多次调用的黑盒登记成一次读取 |

右侧任务面板挂在 App 的稳定层，不随顾问页、活跃简历版本或普通指令变化重新创建。原“当前经历”和“自由对话”入口继续存在；这不等于它们的生成链已经使用新 Host 任务循环。

## 上下文与执行约束

上下文采用摘录工作集，不让模型生成的摘要成为事实。当前策略为约 28,000 字符的证据摘录、来源索引及最近六项动作观察；本人陈述优先于新近普通材料，超大观察返回回读提示。来源包含完整文本 SHA-256、来源 ID、行号及 UTF-16 偏移，长单行材料可按偏移分页回读；CRLF 定位有单独回归。

该策略不是适配所有模型的 token 计数器，也不是语义矛盾检测器。未装入的本人陈述会提供句柄并要求回读；目录证据沿 Broker 的行范围读取，不宣称任意文件都支持字符分页。来源证据和完整本轮回答保留在任务私有记录中。

默认累计上限沿用 12 次模型请求、30 次工具读取、10 分钟活跃执行时间，并允许账号默认值及任务追加额度。构建、修复、资格测试和真实输入调用使用同一本账；暂停、回答和手动恢复不清零。配置模型的 SDK 关闭隐式重试。原生 CLI 内部不可观测步骤或用量仍不等于该账本，界面不将宿主次数称为硬账单上限。

收起或关闭 UI 不取消 Host 工作；等待人类输入不计活跃时间。Host 退出或重启后任务只进入中断状态，重新确认当前授权后手动恢复。账号、底座、源指纹、权限代次及超时检查继续拦截迟到结果；没有自动切供应商或付费 API 备援。

## 沙箱工具构建与安装

首个契约为 `material-lines-v1`：输入已授权材料的 `text`，按 CRLF 或 LF 拆行，去首尾空白、忽略空行、保留原始一基行号。它不具备事实抽取、联网搜索或通用编程权限。

生成与修复使用本任务固定的 reasoner；每次请求计入根模型额度。Host 固定四个资格用例，候选不能修改用例或预期值。代码在新建 QuickJS WASM worker 中执行，限制堆和执行时间，不提供文件、网络、Shell、进程或凭据。每个资格用例、真实调用均计入根读取额度，并另有每任务最多三次构建、八次调用的上限。

通过固定样例只获得当前任务临时资格。每个实际输入仍由 Host 重新计算有限转换契约的预期值并逐项比较；针对资格样例过拟合、对新输入捏造“本人负责上线”的代码会被拒绝。这里的正确性只指机械转换，不证明材料或个人贡献真实。

安装必须单独审阅代码与 SHA-256，并批准精确版本。私有库保存源任务和批准时间；新任务仍需勾选该版本，默认不借用。撤销后库不再返回它，使用该版本的活动任务暂停，且 worker 返回后再次查撤销状态。工具记录与任务记录是各自原子文件，不宣称跨文件业务事务。

目前只有这一种可信宿主契约，没有开放任意工具契约、npm、文件系统、网络、React 应用构建或自动发布。现有编码实验台与应用发布通道没有被绕过或改成任意代码安装器。

## 隔离浏览器验收

验收使用独立临时 owner、示例简历、虚构岗位、合成项目材料和注入式离线 reasoner，实际 HTTP Host、持久任务记录及 QuickJS worker 均参与执行。真实模型和外部业务服务调用为零。

| 场景 | 观察结果 |
| --- | --- |
| 工具首次生成故意失败，再修复 | 两个候选；最终四个资格用例通过 |
| 首任务取证、补问、待审 | 根预算累计模型 8 次、读取 10 次，构建 1 次、实际调用 1 次 |
| 收起再打开右侧面板 | 原任务及已勾选的逐条审阅状态保留 |
| 批准并保存岗位版 | 简历版本从 1 个增至 2 个，原版本内容相同，FactBase 逐字序列化比较相同 |
| 保存不附带安装 | 岗位版回执落盘后工具库尚不存在；单独批准安装才创建库记录 |
| 新任务关闭构建，只授权已安装版本 | 新输入处理成功；累计模型 5 次、读取 4 次，构建 0 次、实际调用 1 次，停在待审阅，未保存第二个岗位版 |
| 撤销已安装版本 | HTTP 返回后 UI 工具库条目消失，磁盘版本记录为 `revoked` |

合成首任务 ID 为 `ct_a4c1dd19afeec1cc4ed133bcd0a65db2`，保存版本为 `career-ct_a4c1dd19afeec1cc4ed133bcd0a65db2`；复用任务 ID 为 `ct_09088c049592d0cfd933d0a0c1dd047c`。测试工具版本为 `tool_1ef061364422e274d273acb06d84074b`，源码 SHA-256 为 `ef62e43e6cfb6e3ebfaa397ea7c8e479b428859d002ef4ce34803931b8d3a688`。这些都是验收用私有制品，不是发布安装。

截图与结构化回执位于 `output/playwright/unified-agent-review-20261110.png`、`output/playwright/unified-agent-reuse-20261110.png`、`output/playwright/unified-agent-acceptance-20261110.json`。浏览器夹具 `apps/agent-host/tests/career-task-browser-host.ts` 默认使用新建临时目录；不要指定真实账号目录。夹具只代理 Agent API，外围 `/api/jd/sync-extension` 返回 404，远程字体被主动拦截，因此控制台并非零错误。该验收不代替真实模型质量评估或全站 UI 验收。

验收完成后仅关闭本次命名浏览器会话并停止本次临时 Host，没有操作用户已有窗口或服务。合成私有记录保留在 `/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-career-ui-uJDCVX`。

## 自动化检查

本批定向测试共 206 项通过，不等于整个仓库测试或全量 lint 通过。

- 172 项任务内核、预算、HTTP、运行底座、沙箱、侧栏、审阅与保存回执相关回归通过，包括授权/账号切换、重启不重放、预算累积、长行回读、已安装版本运行中撤销及迟到结果。
- 20 项模型客户端离线测试通过；同时修复 `response.json()` 的 `unknown` 对象守卫，未改变模型供应商、端点或回退策略。
- 14 项桌面生命周期、私有 QA 与 Host runtime 回归通过。
- Web 与 Agent Host 类型检查、改动生产文件的定向 ESLint、`git diff --check`、同步脚本语法检查通过。
- `pnpm desktop:build` 完成 Web、Electron main 与 preload 构建。现有 Atlas Node 模块外置及大 chunk 提示仍是构建警告。

主要复现命令：

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test --test-concurrency=4 apps/agent-host/tests/agent-task-kernel.test.ts apps/agent-host/tests/agent-task-tools.test.ts apps/agent-host/tests/career-task.test.ts apps/agent-host/tests/career-task-http.test.ts apps/agent-host/tests/career-task-runtime.test.ts apps/agent-host/tests/sandbox-coding-engine.test.ts apps/agent-host/tests/sandbox-coding-tasks.test.ts apps/agent-host/tests/sandbox-reviewed-build.test.ts apps/web/tests/career-task-panel.test.tsx apps/web/tests/career-task-client.test.ts apps/web/tests/career-task-facts.test.ts apps/web/tests/career-task-reconciliation.test.ts apps/web/tests/agent-sidebar.test.tsx apps/web/tests/agent-workspace.test.tsx packages/core/tests/career-task-resume.test.mjs packages/storage/tests/document-history.test.ts
node --test packages/core/tests/ai-client.test.mjs apps/desktop/tests/lifecycle.test.cjs apps/desktop/tests/isolated-qa.test.cjs apps/desktop/tests/agent-host-runtime.test.cjs
pnpm --filter @better-me/agent-host typecheck
pnpm --filter @better-me/web typecheck
pnpm desktop:build
```

## 桌面资源与恢复

本机源链接版 `/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app` 已同步当前构建的 Web 资源与 Electron main/preload。逐路径文件大小和 SHA-256 对比为 533/533 一致。安装目录清单摘要为 `1090756141c49d866505f5c50d194b6803b905e1629e1bc3b7fb6d13384babd0`。

同步脚本为 `scripts/sync-local-desktop-dist.mjs`，只处理明确的相邻 App 资源目录，拒绝符号链接、构建源变化或安装资源并发变化，保留整份旧资源供恢复。本轮备份为 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-B31khI/previous-dist`；未删除旧资源或用户资料。这不是独立便携安装包，也没有更改 macOS 签名或发布远端版本。

实际 Electron 34.2 离线 smoke 使用安装后的 main、preload 和 React，私有 profile 启动成功、关窗重开得到两个窗口，真实服务/模型调用为零。回执为 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-iPpy2G/summary.json`，截图同目录 `desktop-login.png`。

用户已有页面未被强制刷新。体验前先保存或备份仍可见的旧草稿，再手动重新打开应用；旧 Host 若仍驻留，需要正常退出宿主后再启动，任务不会因重启自动续跑。

## 续作：宿主阶段协议与当前经历交接

用户确认三项顺序后，先修复配置模型的真实调用适配，再迁入针对选定 JD 的旁写路径；没有安装 SRT 或为实验虚构原生工具需求。

### 决策与源码分开，但不换底座或预算

`kernel/model-protocol.ts` 定义可信 Host 阶段 `decision` / `tool_source`，分别使用 `CareerTaskDecisionSchema` / 严格的 `{source:string}` 契约。主循环明确请求决策，构建与修复明确请求源码；不检查提示词、材料或模型返回中的标记来切换协议。缺少或未知阶段在派送前拒绝。

配置模型共用同一个已固定的模型实例。Ollama 的实际请求按阶段分别携带 `career_task_decision` / `career_task_tool_source` JSON Schema；其他配置模型也使用相应阶段的 system 指令。账号隔离 CLI 仍只作推理端，在同一已固定授权上接收宿主阶段契约，不启用其原生工具或另选 CLI。每次调用前后仍核对同一会话、授权和路由代次，SDK 不自行重试。

新增回归让真实配置适配器、任务持久化和 QuickJS 协同运行，仅在外部模型 HTTP 传输边界替换不转发的 `fetch`。首次候选故意失败、第二次修复成功，请求顺序为「决策×3 → 源码×2 → 决策×1」，全部使用同一端点和型号，根任务扣 6 次模型调用；最后得到一项任务临时工具和待审稿，没有安装、保存或真实推理。将源码标记放进任务目标不会改变决策请求的 schema。另覆盖原生端两种契约及源码迟到结果的账号/授权拦截。

### 岗位旁写进入同一任务与审阅链

`ResumeWritingCopilot` 在有明确 JD 或已有宿主任务时，将原句完整字段锚、源简历 ID/指纹和已确认本人补充交给稳定的 `UnifiedCareerTaskSurface`，不走旧直连生成、共享记忆或直接采用路径。新建时只预选该字段，将补充列为 `user_statement` 材料；仍须核对模型、岗位、资料与预算并授权才创建/运行。旧项目共识、目录许可和长期记忆不继承，工具构建/复用仍默认关闭。

已有任务只定位，不修改目标、授权、根用量或逐条审批，不因为再次进入而启动第二个执行者。等回答时，可主动把新补充放进当前问题的回答框，暂不发送；再确认任务授权才提交。来源或原句锚过期会阻断新交接。保存岗位版后，匹配已完成任务的原句显示为历史，不把切到新版本误报成失败交接，也不给新版本继承旧许可。恢复任务指针不因带入新目标而被跳过。

此处仅迁入 **JD 定向旁写**。无目标岗位的轻量伴写、项目理解旧会话、普通聊天和旧图仍保留兼容路径，未宣称 M2 全入口统一；不把其内部调用包装成一次黑盒预算。

### 本轮合成验收与最终构建

- 独立账号、实际 HTTP Host 与浏览器走「顾问准备合成 JD → 当前经历补充 → 同一岗位任务授权 → 原文/补充取证 → 逐条审阅 → Workspace 另存」。任务 `ct_8004125850ef8cd252e71c1d0718e431` 最终 `completed`，累计模型 4 次、工具 3 次、活跃 172ms；这些为离线脚本化推理调用，不是实际模型耗时或费用。
- 只授权 1 个字段和 1 份本人陈述材料。返回当前经历再交接，任务仍只有 1 个，审阅勾选与 4/3 用量不变。保存后版本由 1 增至 2，原版本和共享 FactBase 逐字序列化比较不变；新版本为 `career-ct_8004125850ef8cd252e71c1d0718e431`，有 Workspace 和 Host 回执。无工具构建、安装或自动投递。
- 本轮最终定向测试 **263 项通过**：229 项内核/工具/HTTP/真实模型请求适配（离线传输）/审阅/旁写/恢复/写作规则/业务版本回归，加 34 项模型客户端与桌面检查。无失败、无跳过；不是整仓业务或全站验收。Web/Host 类型、定向 ESLint、`git diff --check` 通过。
- `pnpm desktop:build` 完成；原有 Atlas Node 模块外置与大 chunk 警告仍在。最终相邻 App 为 533 个资源，清单摘要 `dba526c1bf6d3f70d88c0dd89cff744eaed469851511dceededc73f070d4acbc`。最终替换前资源完整保留于 `../.unified-agent-app-2tyDdn/previous-dist`；本轮开始前的原资源还保留于 `../.unified-agent-app-QLr0kU/previous-dist`。没有删除备份或更改用户资料。
- 最终实际 Electron 34.2 main/preload/React 离线启动、两个窗口与关窗重开通过；隔离回执 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-AHxvBI/summary.json`。软件渲染有 GPU 上下文日志，测试并非零日志；真实服务/模型调用为零。
- 浏览器截图 `output/playwright/protocol-writing-review-20261110.png`；合成 Host 资料保留于 `/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-career-ui-2xCV7Y`。外围 JD 扩展轮询在夹具返回 404，字体出网被拦截，控制台不是零错误；它们不作为新任务链通过的证据，也不扩称全站验收。
- 最终构建页面重载后，再从原经历交接，仍恢复同一已完成任务，原句显示「任务原句（历史）」、用量仍为 4/3。只读 API 再查仍为 1 个任务；临时 Host 退出计数也是 4 次脚本化决策、0 个生成候选、0 次外部推理。结构化回执在 `output/playwright/protocol-writing-acceptance-20261110.json`。仅关闭本次命名浏览器并停止明确 PID/端口对应的临时 Host，合成记录与备份保留。最终只读逐路径比对确认 Web/Electron 构建并集与 App 为 533/533、差异 0。

本轮没有调用真实模型、读取/改动真实简历、重启用户 Host、Git 提交或远端发布。本地模型是否写得更好，仍须另经授权，以固定模型、题目和预算比较首轮/修复后/留出成绩；不能用以上协议与机制回归替代效果评测。

## 下一阶段

继续将无 JD 的轻量旁写与原项目理解拆为可逐次计量的适配，迁入统一任务，而不是再建并行聊天 Agent。旧 JD 和 understanding 图逐步迁入同一授权、根账和事件投影后，才可把 M2 的全入口统一标为完成。扩展第二种自建工具前，先给它单独定义输入输出、独立验收和权限边界。只有真实任务首次需要固定原生程序时，才做用户采纳的合成文档原句/页码 SRT 对照实验；未达到现有权限边界就不采用，通过也仅增加这一种受审工具，不开放通用命令或自动安装。

本次未读取或修改真实简历，未调用真实模型或付费 API，未投递、提交 Git、推送或发布。工作区原有大量未提交改动保持原状。
