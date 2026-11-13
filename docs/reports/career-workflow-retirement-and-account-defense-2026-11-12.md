# 旧职业工作流退役与账号攻防按钮验收

后续权威：完整artifact正文读取已另行落地；当前533资源/回退及双端证据见 [完整输出读取回执](task-output-artifact-reader-2026-11-12.md)，四轴与真实来源准备见 [Eval回执](resume-quality-eval-2026-11-12.md)。本文的cdb867ee…资源和“artifact待办”保留为本阶段历史快照，不再作为当前安装或下一步权威。

2026-11-12 · `agent-os`。本阶段退役旧 career workflow 的两个执行入口、封闭遗留默认浏览器推理传输，并补齐 ChatGPT 协议路径的实际 JD 攻防按钮 → AgentWorkspace 子会话验收。截图对应的贴边/面板层级已在前序交付，本轮保留样式，只修正一个误导性的连接状态标签。**完整 R1–R8 目标仍 active**；历史接手、artifact 全文 UI 和真实 Gold / Eval / 周期比较没有据此完成。

全部新验收使用临时合成账号、虚构 OAuth 提供者和脚本化回答，0 真实外部模型调用；不是正式 OpenAI 账号验收或模型写作/面试质量成绩。未读取真实简历、FactBase 或凭据，未刷新真实窗口或操作原 5173/5179 服务，未提交、推送或换分支。

## 执行入口与完整历史

- 审计未发现生产 UI 调用旧 career start/resume。旧 LangGraph 只有纯阶段/审批模板，不是实际模型循环；删除 server 对它的构建和 invoke，而不是把模板包装成新任务。
- `POST /api/v1/agent/workflows/career/start` 与 `/resume` 统一 410 `career_workflow_moved_to_tasks`，`next: /api/v1/agent/tasks`。与上一阶段五个已退役入口合计七个；既有 JD start/resume 的 410 保持。
- `GET /api/v1/agent/workflows/career/state/:threadId` 只用 owner 命名空间读取既有 checkpoint，返回 `legacy/readOnly/threadId/checkpointId/state/pendingWrites`；完整 channel values 和 pending writes 不裁剪。thread ID 严格校验，无记录/他人/无主旧记录不自动认领，读取不审批、不恢复或写回检查点。
- 浏览器 `startCareerWorkflow` / `resumeCareerWorkflow` 保留兼容签名但在 fetch 前明确失败。新增 `getLegacyCareerWorkflow` 使用原 owner-aware fetch，只读并核对完整响应及 thread ID；尚未把它接成完整历史接手 UI。
- 默认 `ChatGptClient.respond`、routing respond 和没有显式协议适配器的 `generateWritingReply` 均在网络前失败。登录、状态、模型目录、routing 配置与历史读功能保留；显式注入的纯协议测试 seam 不是生产默认推理路径。不能据此宣称已审计所有子系统或全部历史入口。
- 真实认证 HTTP 测试直接用历史格式 fixture 写入 pending/approved checkpoint，再验证本人完整读取、他人隔离、无主不认领、账号变化拒绝、退役执行不触发及 checkpoint 序列化完全不变。没有为了测试重新开放旧执行器。

## 连接状态文案

`JdMatchDrawer` 在健康探测未确认时原来显示“直连模式”，但当前推理只走 tasks。现在显示“连接待确认”，说明“本机服务连接尚未确认。模型请求仍只走统一任务，不会浏览器直连或自动切换 API。”

新增 503 探测回归证明只发生一次 GET，不会派送模型；实际隔离浏览器重新打开 Drawer 也看到新标签，旧标签不存在，模型仍 4 次、fallback 0。这是状态表达修正，不是新增降级策略或改变提供商选择。

## 实际按钮、两答与完整恢复

### Electron 账号协议链

`chatgpt-task-live` 的 interview 夹具改用真实 `JdMatchDrawer + AgentWorkspace`，删除直接 Panel/预建选题捷径；`chatgpt-task-smoke.cjs` 通过实际“面试攻防防御”与“与 Copilot 模拟对练这道题 →”进入子会话。

- 选题打开时模型/task POST 均不增加，授权未自动授予；返回顾问保留独立未发送草稿，再进入子会话才手动授权开始。
- 两次完整作答后手动结束；通过真实 Blob 下载 `BetterMe-面试攻防评估记录.json`，逐字验证两条答案（含首尾空格/Unicode）、完整 JD、实际 JD parent、原 root、空 draft 与无 pending。
- 同一次全链另覆盖伴侣、单次任务、顾问、润色、项目与报告：**8 个任务、1 根、10 次合成模型调用、18 个 task POST，fallback 0**。第二个独立 Electron 进程恢复完整记录与各入口草稿；任务 ID / 完整记录 hash / task POST 均不变，许可关闭，顾问与伴侣草稿独立。
- 使用真实安装 preload、源码 React/Provider/默认 client 和临时认证 Host；不是已登录正式产品的模型能力验证。两个进程各阻止 2 个范围外请求。

原始目录：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-account-J9ULmE`；临时 Host `betterme-account-browser-9Zx8wF`。规范 JSON 记录 hash `b352b8bd22e44908cbfb66e63a756373b4300c292f1ac7dd8c05f32a1f7b6817`。

| 文件 | SHA-256 |
| --- | --- |
| complete-task-records.json | d8ee7c9c45a78c1291326c75624647e1e84568599436991ab066c8c24fba29c3 |
| complete-interview-record.json | 3f1ceae99e451c3e798aa99bf84fe1bf08eb678560342541e7f9811ce0c2ccd8 |
| restore-summary.json | b264447c351be21db08a6a3716fe50ad33793501fae18a9f051735f07501b0b9 |

### 独立浏览器链

Playwright 会话 `betterme-account-defense-1112` 只接自有 5299。实际按钮进入、明确授权、2853/2157 字符两答、手动结束，**2 任务、同 JD 根、4 次模型、6 个 task POST**；所有答案和回执逐字核对，未使用旧推理 POST。reload 后再完整重开，任务 ID、完整记录 hash 和 POST 不变、许可未恢复、两答/回执仍可读；fallback 0。

- JD parent：`ct_4c36eb63d2778812ab98615afc441794`；对练：`ct_d6bbb28683bfb977b80ab7ff89d85b80`。
- 完整记录 hash：`84ac851e1fe5baef14b22d83d2db3859c6c24cd392d8dae0f34d2747ffaae96d`；临时 Host `betterme-account-browser-mEimyQ`。
- 首次恢复脚本错误地要求完成态必须存在 checkbox；完成态没有该控件，改为核对没有任何选中许可，生产代码未改。任务全文/hash/POST 的断言前后均通过。
- 浏览器两条控制台错误来自隔离页 favicon 404 与刻意禁止的健康探测 410，不声明零控制台错误。未为 UI 重新拍真实资料页面。

## 回归与构建

本轮不重叠集合 **100 Host/Web + 11 Drawer + 14 Desktop = 125 项通过**。100 项来自 18 个文件（其中 3 个 suite）；不与前阶段165项、早期98项试跑或单项重复相加。Web 类型、Host 构建、定向 ESLint `--max-warnings 0`、Electron 脚本语法、`git diff --check` 与完整 `pnpm desktop:build` 通过；相关实际 HTTP React 测试仍有异步 act 提示，Atlas Node 外置化/大 chunk 提示保留，不称整仓全绿。

日志在 `/tmp/`：`betterme-career-retirement-regression-final.log`、`betterme-task-status-label.log`、`betterme-career-retirement-desktop-tests.log`、`betterme-career-retirement-types.log`、`betterme-career-retirement-host.log`、`betterme-career-retirement-lint-delivery.log`、`betterme-career-retirement-desktop-build-delivery.log`、`betterme-account-defense-electron.log`、`betterme-account-defense-browser-{checkpoint,restored-final,label}.log`。复现仍先启全新 fixture 并确认 modelCalls=0，再运行 Electron；活跃句柄只等待，不因观察超时重启。

## 当前桌面资源与回退

最后生产标签修改后已重新完整构建，同步相邻 BetterMe.app，再独立按路径/大小/SHA-256 比对 **预期533、安装533、差异0**。没有替换运行中 Host 或刷新用户窗口。

- 安装清单：`cdb867ee53adb69c67b4ee4da56dab31f94a8697c4d7f37d8e670fed931db8d1`。
- Web 清单：`f6f9cce1340e58bbe22209fda2a55b78d5ecb29ab393ae983dbfd4f9581dbff0`。
- 紧邻前版备份：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-YnMbAd/previous-dist`；其清单 `de0c03b014aac6e65bb502cf7a3943a306b9a7314d8dfbcf1144329db713fe59`。本阶段首次 workflow 构建的前版另保留于 `.unified-agent-app-Jc1lRc/previous-dist`，未覆盖旧备份。
- Host `dist/server.js`：`33868c71e945b9ec5366c888e17a7f33afd0e87ca1fb1723f7074171b7181c60`；`dist/tasks/runtime.js`：`62bb7da26f56bfebd88f4b5d68fc389df3396c26d65dcb378f5d610c3eddd00c`；安装 preload：`70cb32be239ff1f00c102248b1ea8cf9746365b76250c8246a41ea1c001c256e`。
- 最后安装成品离线检查：Electron34.2.0、实际 main/preload/React、两窗口重开、3 assets/4 synthetic reads、独立 profile、0 真实服务/模型调用。摘要 `betterme-electron-offline-ZsvBVe/summary.json`（系统临时目录）；既有 GPU context 提示未影响断言，不把登录页 smoke 当作已登录业务全链。

本批自有 5299 / Playwright 与最终 Electron 进程已退出。原5173/5179、真实资料、未发送草稿和大量已有脏改动保留；source-linked App 资源同步不代表旧运行服务热更新。

## 下一阶段

1. R1/R2：旧无 scope 任务的显式关联、资料/授权变化及中断接手、完整 artifact 正文读取 UI；保留原任务/累计账，不自动认领或重放许可。其他子系统调用者仍按实际路径审计，不能从七条410外推全项目已封口。
2. R4：5–10 组真实脱敏 JD/履历，来源、再利用许可、hash 与人工事实标签完整；现有合成协议夹具另列。
3. R5/R6：原句覆盖、无据新增名词/数字、STAR 与实际 A4 一页密度/孤行/截断矩阵，及同数据/版本/预算的可复现周期模型对比。真实模型比较需明确数据/模型/费用边界，不默认定时付费推理。
4. R7 当前配置/原生/账号协议的实际按钮机制已有双端证据；真实面试质量仍另评。R8 全目标成品审计在剩余门完成后进行，整体不标 complete 或 blocked。
