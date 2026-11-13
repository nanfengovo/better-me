# 独立推理入口退役与单次任务归核

后续停点：本文保留五入口/单次任务阶段的历史证据与旧资源hash。career workflow两POST退役、owner完整检查点读取、遗留默认传输封口及账号实际攻防按钮已在后续完成；**当前资源/回退、验证和剩余门以[工作流退役与账号攻防回执](career-workflow-retirement-and-account-defense-2026-11-12.md)为准**。下方当时待办不再代表当前状态。

2026-11-12 · `agent-os`。本阶段完成五个旧推理 HTTP 入口退役，以及伴侣高级区的单次文本任务迁移。完整 R1–R8 目标仍 active；职业工作流、历史接手、完整 artifact 阅读和真实 Gold / Eval / 模型比较仍有待办。全部使用临时合成账号与脚本化回答，0 真实外部模型调用，不是正式账号或写作质量成绩。

## 入口与执行权威

以下认证 POST 统一返回 HTTP 410、明确错误码及 `next: /api/v1/agent/tasks`，请求内容不会进入旧执行器：

| 旧路径（前缀 `/api/v1/agent`） | 错误码 |
| --- | --- |
| `/chat` | `free_chat_moved_to_tasks` |
| `/chatgpt/response` | `chatgpt_response_moved_to_tasks` |
| `/routing/respond` | `routing_response_moved_to_tasks` |
| `/understanding/sessions/:id/turns` | `project_understanding_moved_to_tasks` |
| `/runs` | `runtime_run_moved_to_tasks` |

授权、origin、owner 隔离和 no-store 保持；未登录仍 401、错误 origin 仍 403。既有 JD start / resume 的 410 继续有效。ChatGPT 登录 / 模型目录、routing 配置、本机能力扫描、旧项目记录及确认 / 撤权、旧 run 的完整 output / SSE / 列表 / cancel 保留。测试为旧 run 写入隔离的已结束记录后验证完整回读，不为测试重新开放旧执行器。可信单用户模式也不能通过 `/runs` 绕开任务根账。

`startLocalAgentRun` 客户端保留兼容签名但在 fetch 前明确抛出迁移错误，生产调用者已移除。其余历史 read / SSE / cancel 函数不等同新的执行权威。尚可达的 `/workflows/career/start` 和 `/workflows/career/resume` 仍须下一阶段审计实际调用者、迁移并退役；不能将本表说成所有旧推理已关闭。

## 单次文本任务

- `AgentCompanion` 高级区使用 `OneOffAgentTask → free-chat-task-client → /tasks`，是实际 `free_chat` kind。删除旧 raw CLI start / SSE / cancel 执行链及独立运行时选择；能力卡只显示发现结果，当前底座由统一设置决定。即使没有本机 CLI，明确选择的账号 / 配置模型也可使用任务入口。
- 单次任务沿用工作区 `rootScopeKey`、当前明确 runtime / account / model 和累计根预算。只发送下方完整原文，不隐式附带普通聊天、简历、文件或共识。输入与输出未 trim、摘录或限制展示长度；复制结果使用完整原文。
- 发送前冻结稳定 message ID 和完整输入并保存 owner-scoped journal；保存内容没有凭据或许可。创建结果未知时，使用稳定 message ID 只 GET 核对；下一次明确授权可沿原 task ID 启动，不新建根或重复创建。
- 原文冻结后锁定输入；“新任务 · 沿用总额度”是显式操作，不删除 Host 历史或清账。暂停 / 中断恢复须重新授权，以原 revision / source / runtime 执行。普通聊天未发送草稿单独保留。
- 离页只停止观察；显式停止调用内核 pause，忽略 abort 的迟到回答也不能成为结果。恢复 / 重开只 GET，完整结果、部分原始输出和执行事件可读，许可保持关闭。只接受同任务不倒退的 revision，陈旧读取不覆盖新结果。

## HTTP 迁移暴露的相邻修复

1. `readBody` 超过既有 16 MiB 限额返回带可信 code / status 的 413，不被 tasks 层误报为 500；没有扩大限额或裁剪请求。
2. Host `close` 回调等待 task 私有写入 drain 后才释放存储生命期；关闭时任务记为 interrupted，迟到结果不能在目录释放后写回。重开只读，不重放模型。
3. 任务运行时将已知 NativeToolError / DeepSeekApiError 转为安全、可识别的任务错误；未知异常继续是通用 operation_failed，避免持久化提供商提示、路径或凭据。

先前 chatgpt / understanding / native / identity / provider HTTP 测试已改走真实 tasks，旧入口另用拒绝与历史保真测试覆盖；没有通过删除能力断言来取得绿灯。

## 验证与复现

当前最终不重叠集合 **52 定向 + 99 相邻 + 14 Desktop = 165 项通过**，不与前一轮 94 / 19 或各次试跑相加。Web 类型检查、Host 构建、定向 ESLint `--max-warnings 0`、Electron 脚本语法和完整 `pnpm desktop:build` 通过。部分实际 HTTP React 测试有异步 act 提示，既有 Atlas 外置 Node / 大 chunk 构建提示保留；不是整仓全套或零控制台警告声明。

- 新增四条真实 React Companion → 默认 client → 临时认证 Host / AgentTaskKernel 场景：逾 6 万字符完整输入与近 9 万字符完整回复 / 复制；创建已提交但响应丢失；完整 partial 留存与原 ID 手动续作；显式停止后忽略迟到结果。验证同根、1 个 adapter、换 runtime 拒绝及卸载重挂不增 POST。
- 入口退役测试设置旧 executor tripwire，五入口均不派送；新 tasks 仍实际执行，旧记录序列化不变。Host 关闭 / 重开单独覆盖完整补充、interrupted、一次计账和迟到输出不写回。
- 实际浏览器：普通聊天先建根，再通过实际高级区发送 2732 字符完整单次原文，Host / UI 结果 2760 字符逐字相同；普通未发送草稿没有进入单次上下文。首次 reload 后原文 / 完整结果 / 普通草稿都恢复、许可 false；再设完整记录检查点并二次 reload，2 任务同根、2 次调用、4 个 task POST、任务 ID / 完整记录 hash 均不变，fallback / 旧推理 POST 为 0。临时 Host `betterme-account-browser-HPQEju`，记录 hash `c4cfe02a074bc68538ac87f1e2c432b3c51d38011108962fd2cb188ff5c6bd76`。浏览器仅有 fixture favicon 404；continuity 写入与 ChatGPT 模型目录 POST 是非推理，检查明确区分它们与旧执行路径。摘要见 `output/playwright/one-off-task-summary.json`。
- Electron：实际安装 preload + 源码 React / Provider / 默认 client + 临时认证 Host。首进程完成聊天、单次任务、顾问、润色、项目、两答 / 手动结束的对练及报告；**8 任务、1 根、9 次合成模型调用，fallback = 0**。第二个独立进程完整恢复单次任务、普通未发送草稿及其他回执；原记录 ID / hash / 17 个 task POST 均不变，许可关闭。账号对练本次仍为 Panel 直接入口，不冒称已重跑 JD 攻防按钮跨入口。
- Electron 初轮在账号目录仍加载时就发送，明确就绪守卫拒绝，0 模型请求；脚本改为等待账号与 runtime 均 ready。另一次早于 Vite 启动导致 ECONNREFUSED，0 请求。确认全新 Host 0 次后才运行最终双进程链，没有放宽生产就绪或授权守卫。
- 成品离线两窗口：安装 main / preload / React、Electron 34.2.0、3 assets、4 synthetic reads，0 真实服务 / 模型调用，独立 profile。摘要 `betterme-electron-offline-YQk9Nr/summary.json`；GPU context 提示未影响断言。这不替代上述任务全链证据。

Electron 原始目录：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-account-HXiuaN`；临时 Host `betterme-account-browser-fJgddo`。`complete-task-records.json` 文件 SHA-256 `79cdf1c958d31b9de4968e0115a508f9f83b4dc1d5ec0cda733d1b7b8cf75aa7`，规范 JSON 记录 hash `e1f838626d424be50b9bb304a4f419b09e51f391277e0453bb0d90400997cf8c`；`restore-summary.json` SHA-256 `6342d2023dd0d278e781f4205dace502a6293992829b2c749c72b858d5f40121`。两个进程各拦截 2 个范围外请求。

复现时先启动全新的合成服务、确认 ready 且 modelCalls = 0，再执行 Electron；同一场景仍在运行时只等待原进程，不因观察超时重启：

```sh
pnpm exec tsx --test apps/web/tests/one-off-task-http.test.tsx apps/web/tests/agent-companion-output.test.tsx apps/web/tests/agent-client-run.test.ts apps/agent-host/tests/legacy-inference-retirement.test.ts apps/agent-host/tests/server.test.ts
pnpm exec tsx apps/web/node_modules/vite/bin/vite.js --config apps/web/tests/ui-lab/chatgpt-task-live.config.ts
node apps/desktop/tests/chatgpt-task-smoke.cjs '/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist'
```

日志：`/tmp/betterme-one-off-regression-final.log`（52）、`betterme-one-off-neighbor-final.log`（99）、`betterme-one-off-desktop-tests.log`（14）、`betterme-one-off-types-final.log`、`betterme-one-off-host-build.log`、`betterme-one-off-lint-final.log`、`betterme-one-off-desktop-build.log`、`betterme-one-off-electron-ready.log`、`betterme-one-off-offline.log`。

## 当前安装资源

相邻 BetterMe.app 已可回退同步；之后独立按路径 / 大小 / SHA-256 比对：预期 533、安装 533、差异 0。

- 安装清单：`aa4220eb5fa283b69d765486867af7942a2555501a5ae9b1568adaa1ecbd0622`。
- Web 清单：`40f3a78631276b8d68bb2a4d14fd3aa1f75186a8fc8dc59b4588134711e5c11b`。
- 紧邻前版备份：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-Wn9MHG/previous-dist`；前版清单 `20ce8653d79a269362600c05f49c8283ffa8ec6fcc7eb4e500dbc0d3f39d3ad9`，未覆盖旧备份。
- 构建 Host `dist/server.js`：`63a8e0eb131cd5e86ba52593a57bc48df6df808f2f4a4a9f08ee94babe845ee9`；`dist/tasks/runtime.js`：`62bb7da26f56bfebd88f4b5d68fc389df3396c26d65dcb378f5d610c3eddd00c`。当前是 source-linked App，不把资源同步说成对旧运行中 Host 的热替换。

真实窗口、原 5173 / 5179 服务、简历 / FactBase / 凭据 / 未发送草稿与无关 Git 改动未操作；没有强制刷新、提交、推送、换分支或发布。本批在已有大量脏改动的 `agent-os` 上 scoped 实现，不声称工作树干净。

本批自有 5299 合成 Vite / Host 和独立 Playwright 浏览器均已关闭，最终 Electron 任务及离线进程均退出。没有停止未知进程或原服务。

## 当时下一阶段（历史快照）

1. R1/R2：审计职业 workflow start / resume 及尚存的未调用 inference helper，迁移实际调用者后再关入口；保留历史读取 / 授权 / 配置功能。不要重复迁已经完成的五入口或单次任务。
2. 旧无 scope 任务的显式关联、资料 / 授权变化与中断接手、完整 artifact 正文读取 UI；完整账与旧记录保留，不自动认领、重放许可或新根清账。
3. ChatGPT 账号下实际 JD 攻防按钮 → AgentWorkspace 的双端跨入口证据；本阶段 Panel 验证不能替代它。
4. R4–R6：5–10 组有来源、再利用许可与人工事实标签的真实脱敏 Gold，四维 Eval / 实际 A4 PDF 反例以及可复现周期模型比较。合成协议测试不是 Gold，不默认定时付费推理；真实模型比较须明确数据、模型与费用边界。R8 全目标成品审计在上述完成后进行，整体仍 active。
