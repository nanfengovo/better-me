# BetterMe 合成成长闭环实现与验收

2026-11-13，现有 `agent-os` 工作树。本轮落实本人最新授权的第一条成长闭环：设目标、选资料、保存练习、执行并保存断点、恢复后明确继续、本人验收项目。全部验收使用临时合成账号和资料，没有使用个人简历、岗位、投递或真实模型凭据。

本轮范围对应 [总体设计](../planning/personal-growth-os-system-design-2026-11-12.md) 和 [首片验收契约](../planning/personal-growth-os-first-slice-2026-11-12.md)。语音、OXR、PDF 翻译和 DeepTutor 的真实引擎仍按原规划分阶段接入；此次没有安装、启用或调用这些外部引擎，也没有恢复此前已暂停的统一 Agent R1–R8 自动目标。

## 已实现的使用流程

入口位于现有 Agent 工作区的“成长闭环”，不新增独立 Dock。成长组件只接收成长接口，不接收当前简历、FactBase、岗位或职业工作区的回调。

1. 本人填写目标、目标周期和每周投入，创建一条合成成长记录。此操作只存目标，不生成计划、不调用模型。
2. 从两份 BetterMe 自带合成教材中选一份，保存原文、版本、出处及 SHA-256。提交练习后冻结所选资料。
3. 保存原代码、原答、解释和“教学辅助样例／本人自述”归属。保存本身不执行代码或工具。
4. 明确运行第一步：受限 QuickJS 执行代码，通过唯一白名单工具读取选中的合成教材，将完整结果与哈希保存为断点。
5. 关闭再打开，只读取已有记录和草稿。本人点击继续后，仅使用已保存断点运行固定检查，不再次派送教材 lookup。
6. 四项固定程序检查通过后，仍由本人单独确认验收。项目回执绑定准确的代码、资料、断点与报告哈希；能力状态为 `pending_retest`，范围为 `synthetic_practice`。

四项检查是正确资料引用、未知资料拒绝、未授权工具拒绝和恢复复用断点。它们验证本次代码在冻结用例下的行为，不对原答与解释作语义评分，也不证明独立掌握、长期能力或生产经验。辅助样例保留辅助标记。

## 持久化和执行边界

成长记录由 `GrowthJourneys` 协调，实际练习仍使用现有 `AgentTaskKernel` 的新增 `growth_practice` 类型。没有另建模型循环、调度器或免费工具执行通道。

| 操作 | 持久记录 | 执行效果 |
| --- | --- | --- |
| 创建目标 | 稳定目标 ID、周期、投入、创建幂等键 | 无模型或工具调用 |
| 选择资料 | 原文、版本、出处、哈希 | 不扫描本机文件 |
| 保存练习 | 原代码、原答、解释、归属、稳定任务 ID | 不运行练习 |
| 运行第一步 | 原任务预算账、工具结果、断点哈希 | 一次受限代码决策和一次白名单 lookup |
| 重开或重新读取 | 同一目标、任务、断点、历史和用量 | GET 只读，不恢复执行授权 |
| 明确继续 | 固定检查的逐次工具预算、验证回执 | 只运行 QuickJS 检查，无第二次 lookup |
| 本人验收项目 | 绑定任务、代码和报告哈希的项目回执 | 不写简历、项目经历、FactBase 或岗位 |

每个修改命令包含 `requestId`、预期记录版本和明确同意。Host 先持久化待确认命令，再调用 Kernel。遇到响应丢失，原命令通过稳定 ID 和任务版本对账；读取和对账不会重新派送已保存步骤。不同内容重用同一 ID、过期版本或另一个未确认操作都会拒绝。

已派送但没有持久结果的 lookup 保留为 `outcome_unknown`，不自动重试，也不能通过新练习绕过。纯验证期间进程退出，则保留原断点与累计费用，重开后需要明确继续纯验证。这个策略不承诺任意远端系统的全局 exactly-once；它在本片的本地受限工具边界内避免重派，并将无法确认的结果显式保留为未知。

失败后可明确提交一个修正尝试。旧代码、原答、失败回执不覆盖；新尝试仍属于同一 `growth:<journeyId>` 根，累计使用原预算。不能靠重新提交练习刷新额度。`lookup` 次数与全部工具预算分开：一次正常尝试在断点保存时工具费用为 2，继续四项检查后为 6，但同一次尝试的实际教材 lookup 仍为 1。用户明确建立的新尝试有自己的执行记录，不把不同尝试的调用合并称为一次。

确定的预算耗尽保存为 `budget_exhausted` 停点，而不是悬挂的待确认命令或“检查通过”。原断点、已记用量仍能读取和导出，页面不提供新尝试或执行按钮，服务端也拒绝以新尝试绕过。首次代码求值、实际 lookup 和每次验证求值都在异步保存预算后、真正启动前再次检查会话。

读取时重新核对规范化的请求指纹、原资料正文、断点正文与结果哈希，以及验证对代码、原答、断点的绑定；已验收项目还要匹配当前原任务和原报告。发生漂移则明确拒绝读取为成功，不偷偷修改原记录。固定验证只把受信 Host 的白名单拒绝算作权限拒绝，普通异常、超时、额度不足或客体伪造的错误文本不能算通过；重复恢复结果必须与完整基准结果相等。这些是内容一致性检查，不是对本机恶意文件修改的密码学签名保证。

## 合成数据和账号隔离

新记录只在认证 owner 下新建：

- `growth-journeys-v1` 保存目标、所选资料、命令日志、尝试归属及项目回执。
- `growth-synthetic-tasks-v1` 使用同一 Kernel 实现保存合成练习和根预算账。
- owner 范围的 Web 恢复记录保存页面草稿与活动目标指针，不存凭据，不回放请求。

单独的合成任务目录是此次安全验收边界：Kernel 计算根账时会遍历其任务目录，因此不能让本轮合成练习访问真实职业任务目录。通用 `/api/v1/agent/tasks` 和 `/api/v1/agent/career-tasks` 的 POST 均拒绝 `growth_practice`，只能由成长接口创建，防止绕过目录隔离。

服务端由已认证会话确定 owner，不接受请求体声明身份。私有目录和 JSON、单 writer 锁、账号失效后的响应隔离沿用现有机制。成长模块不提供本机任意路径、网络工具、真实资料导入或职业数据采用命令。

## 已验证的关键行为

- 目标和所选资料关闭重开后完整恢复，Kernel 中没有隐式创建的练习任务。
- 保存练习逐字保留代码、首尾空白、原答和解释，模型与工具费用均为 0。
- 保存断点后关闭并重启 Host，公开记录和用量保持不变；明确继续后四项检查通过，实际 lookup 仍为 1。
- 工具已保存成功但成长回执丢失时，重开后显示原待确认命令，显式重用原 ID 只核对结果，不再次 dispatch。
- lookup 结果未知且上层回执也丢失时，对账可清除待确认命令，但未知结果仍保留且不能重派。
- 修正失败尝试后，旧源码和原答保持原样，新尝试继承同一个根账；一次失败检查加正常修正链累计工具费用为 7，而不是刷新为 6。
- 伪造报告、过期版本、冻结后换资料、重复验收、失效会话、另一 owner 及错误通用创建入口均有拒绝或幂等断言。
- 真实认证 HTTP 在合成职业记录旁完成闭环，预置记录的版本与内容前后不变，职业任务列表仍为空。

## 最终验收结果

以下均为本轮实际结果，不合并成“整仓全绿”，也不替代此前暂停的 R1–R8 验收。

| 检查 | 结果与范围 |
| --- | --- |
| Host 全测试目录 | 736 项：726 通过、0 失败、10 条件跳过；明确关闭真实本地模型、Vork、公共来源及外部导出运行开关 |
| Web 定向回归 | 68/68：成长页面/传输、草稿与导航恢复、现有 Agent、账号边界和工作区布局 |
| 桌面普通回归 | 21/21，未启动默认配置或真实服务 |
| 全仓类型检查 | 9 包、16/16 个任务成功 |
| Lint | `pnpm lint` 成功，零 warning；另核对新增协议文件 |
| 桌面构建 | `pnpm desktop:build` 9/9 成功；既有 Atlas Node 外置和大包提示保留，不作为失败隐藏 |
| 浏览器 | 隔离临时账号完整闭环；保存断点后重载只增加四条 GET，全局执行 POST 仍为 12；随后明确继续至 4/4 和项目验收 |
| Electron 成长流程 | 两个独立 Electron 进程共用同一新建临时配置，进程间实际关闭并重启隔离 Host；恢复不增加 POST、仍是原任务和 lookup=1，明确继续后验收完成 |
| 安装资源 | 536 文件与最新 Web + desktop main/preload 逐路径、字节比较，差异 0 |
| 安装成品离线启动 | 实际加载相邻 App 的 main/preload/React，Electron 45.2.3 两窗口关窗重开成功；所有网络均由进程内 fixture 接管，真实服务/模型调用 0 |

Host 最终日志本机留存于 `betterme-growth-final-host-23Y5bz/results.log`，不纳入 Git。68 项 Web 回归文件为 `growth-journey-client`、`growth-journey-workspace`、`workspace-recovery`、`agent-workspace`、`workspace-chrome`、`workspace-split`、`identity-boundary`、`identity-gate`、`agent-hook-lifecycle`。

新增成长测试包含：认证 owner 隔离、普通任务入口拒绝、回执丢失对账、未知结果不重派、失败后同根修正、额度耗尽停点、代码执行/实际派送前最后一跳撤权、验证中撤权、子进程退出恢复、任意异常不能冒充拒绝、完整恢复结果比对，以及原请求/断点/验收回执漂移拒绝。Web 还覆盖双击、读取与修改同帧竞争、超长及非法数字输入、操作编号未安全落盘时禁止 POST、未知创建/命令重开沿用原编号。

### 视觉与进程证据

浏览器使用真实 React + 认证 HTTP + Kernel + QuickJS，仅由独立 5316 验收服务提供。临时 Host 没有真实运行时，代理仅允许 identity/growth 和职业任务只读列表。页面按 Emil 设计工程技能补齐键盘焦点、深色主要按钮对比和窄屏换行，保留出处、原答及完整回执，不用省略号掩盖内容。

- 最终浏览器截图：本机可视化产物目录内的 `growth-loop-release/`，包含 checkpoint、restored、completed 及 390px 窄屏；本机目录和会话标识不上传。
- 最终 Electron 成长证据：本机临时目录 `betterme-electron-growth-I4Q7bt/`，含两个进程的 summary、checkpoint/completed JSON 和三阶段截图；Host 重启 1 次，外部模型调用 0。阻止的请求仅为 fixture Vite 的 HMR WebSocket，没有放开外部访问。
- 安装资源离线证据：本机临时目录 `betterme-electron-offline-1OK1sy/` 内的 `summary.json` 及 `desktop-login.png`。

最终浏览器 390px 视口下 document/body scrollWidth 均为 384px，没有横向溢出，底部三个动作均为 44px 高，窄屏和 Electron 恢复截图已经目视。浏览器实际点击导出得到本机保存的 `betterme-growth-<journeyId>.json`；独立核对原代码/原答/资料、6 条事件、完整尝试、根预算 6/0、lookup=1、`pending_retest`，其报告哈希与项目回执一致。该导出不是截图或截取版报告，原始合成账号数据不入 Git。

### 桌面同步与运行中的服务

目标为相邻 `../BetterMe.app/Contents/Resources/app/dist`。只更新构建资源，没有打开默认 App、刷新现有窗口或接管真实账号。完整上一版可恢复于 `../.unified-agent-app-0F9BYV/previous-dist`，没有删除备份；以上相对位置均以仓库根目录为基准，实际写入目标由同步脚本校验。

- 安装清单 SHA-256：`f005adcf729def4de6bf1347b3945fe2d4b19add4c16b58ea7b86b1fe6f0ab38`。
- 上一版清单：`c564f0f50c8a3154314a893d8ebb603fa788a9a1666723ab11973ee73478bd7d`。
- Web 构建清单：`4fbd65fad4fd455e13e42c76359f95f852a55e548f64a91e2ded9e94a6bb0e3f`。
- 安装 preload 与本次两进程成长验收所用 preload 一致：`8ad8a3b8fcf0edecb05728f9ec1036a02bca87e9cafc016ae1b70554237898b0`。

实施验收阶段没有重启或停止正式 Web/Host。最终只读观察为 5173 PID51150、5179 PID57409，已不同于最初快照；Host 启动时间早于本轮最终源码，不能把服务仍在运行解释为新后台已加载。体验正式入口时需按现有方式正常重启本地 Host；本轮功能验收使用的是新启动的隔离实例。该阶段完成时尚未提交推送，后续本人明确授权的发布见下节。

### 后续提交与推送授权

本人随后明确要求“代码推送上去”。发布范围只含本片源码、合成测试、README 与技术交接文档，沿现有 `agent-os` 正常提交推送，不创建新分支、不强推、不创建 Release，也不上传构建资源、临时账号目录、原始日志或截图。提交前已实际 fetch，当前基线与 `origin/agent-os` 均为 `3bd263e`，没有待整合的远端提交。最终远端提交指针和对应 GitHub Actions 状态以本次推送回执为准，本地验收不替代远端 CI。

推送前再次验证成长 Host/Web 与恢复测试 48/48，全仓类型 16/16、Lint 零 warning 及 Memory Bank 检查通过。31 个候选文件只包含本片源码、测试与文档；新增内容的凭据/个人资料模式复核未见真实密钥或业务数据。报告已去除个人主目录、会话 UUID 和 macOS 私有临时绝对路径，原始证据继续仅本机留存。

### 复验入口

```sh
pnpm typecheck
pnpm lint
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test apps/agent-host/tests/growth-*.test.ts
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test apps/web/tests/growth-journey-*.test.* apps/web/tests/workspace-recovery.test.tsx
pnpm desktop:build
pnpm test:desktop
```

需要实际进程恢复时，在独立终端启动以下验收服务，然后运行 Electron 脚本。二者仅建立临时合成身份，不连正式 5173/5179，不调用模型：

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/node_modules/vite/bin/vite.js --config apps/web/tests/ui-lab/growth-loop-live.config.ts --configLoader native
node apps/desktop/tests/growth-loop-smoke.cjs apps/desktop/dist
```

此脚本预期新建的临时 Host，重复一整轮时先正常关闭自己启动的验收服务，再重开，避免把上一轮合成账号当成空账号。`--configLoader native` 保留 Host/QuickJS 的真实文件解析路径；不要改成默认打包配置后用不匹配的动态模块路径冒充产品失败。

## 主要实现位置

- 协议：`packages/agent-contracts/src/growth-journey.ts`、`growth-practice.ts`。
- 目标与流程协调：`apps/agent-host/src/growth/service.ts`、`http.ts`。
- 受限执行与检查：`apps/agent-host/src/kernel/growth-practice.ts` 和 Kernel 的 `createGrowthPractice`、`stepGrowthPractice`。
- 页面与认证传输：`apps/web/src/components/GrowthJourneyWorkspace.tsx`、`growth-journey-workspace.css`、`apps/web/src/services/growth-journey-client.ts`。
- 隔离验收：`apps/agent-host/tests/growth-*.test.ts`、Web 的 `growth-journey-*.test.*` 和 `tests/ui-lab/growth-loop-live.*`。

## 后续接入范围

语音以后作为独立的输入输出能力路由，不要求文本模型本身有语音接口；OXR 以后作为资料摄取适配器；PDF 翻译作为有进度和导出物的独立长任务；DeepTutor 的学习策略只能通过同一目标、资料、练习与验收协议接入。本轮的合成教材和固定检查是已验证的第一条实现，不是上述引擎的完成替代品。

下一阶段应先选择一条真实资料接入链，在明确资料共享与依赖许可边界后继续验证，不自动导入个人资料或启用收费模型。此前暂停的职业 Agent 全目标仍按原交接记录保留。
