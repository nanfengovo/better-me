# 对练子任务内核 · 2026-11-12

后续阶段：ChatGPT账号Host和三类前端已迁tasks，明确选择接入对练Panel并完成账号隔离Web/Electron发送与独立重开；当前安装资源/回退唯一权威改为 `chatgpt-task-runtime-2026-11-12.md`（04e099f4…）。该账号夹具是直接Panel入口，账号下实际攻防按钮跨Workspace仍待补验；本文“未迁入运行时”及资源hash均为本对练阶段历史快照。配置/原生真实按钮的既有证据仍有效。

以下为本对练阶段历史停点：R7 **配置/原生任务路径的实现及双端机制验收完成**，真实内核、production client、`JdMatchDrawer` 实际按钮与 `AgentWorkspace` 子会话已接通；Web和Electron均完成首问、两轮作答、手动结束与完整回执恢复。Electron另完成两次完整进程重开、独立草稿与实际下载核对。当时旧ChatGPT协议尚未迁入，后来进展和当前资源以上方账号回执为准；不能把本阶段结论外推到真实模型面试质量，整体active。

## Electron 多轮与重开验收（当前停点）

新增 opt-in `apps/desktop/tests/mock-interview-smoke.cjs`，复用仓库已有Electron隔离测试方式，而不是给React注入回答。测试加载相邻安装包的实际preload、5296合成页的真实Provider/Workspace/Drawer/默认client，以及独立认证Host/真实kernel；只有reasoner为脚本化回答。三个独立Electron进程共用一个新临时profile，两个完整退出/重开均不接用户profile、凭据、原5173/5179或外部模型。

1. `seed`：实际攻防Tab/对练按钮打开子会话，未授权时0推理/0任务写入；返回顾问填写独立草稿再回对练，明确授权首问。填写2555个UTF-16单元、含换行/emoji/尾标的完整作答；结束按钮在有草稿时禁用。保存cookie及本机日志后退出整个进程。
2. `answer`：新进程恢复同一首问与完整草稿，授权未勾选、提交禁用；仍1次调用、无新增POST。返回顾问核对独立草稿，再由本人式操作授权/提交两答、手动结束。真实Blob下载得到完整JSON，逐字核对两答及每条回执quote、JD原文、父根、累计4次用量和证据尾标。
3. `verify`：第三个进程恢复completed与完整逐答回执，正文hash不变、无恢复许可或POST。再reload一次仍4次/1adapter/原POST列表；返回顾问草稿仍独立。回执截图已目视，长文通过同一滚动区阅读，不从单屏截图推断全文完整；完整性由DOM hash和下载JSON共同证明。

本轮 **14 Desktop +8 对练Host/Web定向回归=22项通过**，另有上述三阶段Electron场景在两个全新合成Host/profile中独立通过；不将重复运行算成新增用例，也不声称重跑上一批344项。新脚本语法与定向ESLint `--max-warnings 0`、`git diff --check`通过。安装资源按文件路径/大小/内容hash只读比对：533构建/533安装、0差异，清单仍`edc6ea98…`，没有重新构建或替换已经一致的资源。

最终验收任务 `ct_7debcd996e8b67ec7a7acbc3e92ae11c` completed，JD parent/root同为`ct_256866f720aa9306ae0500a6b09a1d38`，两答长度2555/67，子及根累计均4次。实际网络为2次create、1次start、3次answer（最后一次是finish），adapterBuilds=1，恢复/reload未追加任务POST。0外部模型/真实服务调用；Electron GPU shared-image告警没有阻断DOM/下载/进程恢复。

- 最终原始回执：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-interview-ZmquyE/summary.json`
- 完整合成下载：同目录`complete-record.json`，SHA-256 `91efc0f7642e65e17e43e94baacbf0d305ec9c05923b807f01a402fbd5addd51`。
- 已目视截图：同目录`electron-interview-receipt.png`。
- 首次成功复验：`betterme-electron-interview-rc7WCN/summary.json`；早期失败profile `betterme-electron-interview-8KDDGx`保留。最初脚本错把保存提示的role=status当任务状态；Host当时已awaiting_answer/1次。仅将测试定位限定到任务滚动区，未放宽状态或修改生产执行。另一次只读清单检查因DFS/全路径排序差异误报；按相同路径逐文件比对0差异，未覆盖App。

这是实际Electron中的源码组件/production client/安装preload验收，加上此前安装main/renderer离线smoke；**不是已登录正式App、真实账号或实际模型的全链质量验收**。自有5296/全部测试进程已退出；未刷新用户窗口、重启原Host、写真实简历/FactBase、提交或推送。下一步迁移旧ChatGPT账号执行器及历史接手，不再重复已经通过的UI/对练验收。

复现（先以tsx启动`free-chat-live.config.ts`，须全新合成Host；脚本拒绝已有调用或任务写入）：

```sh
node apps/desktop/tests/mock-interview-smoke.cjs '/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist'
```

## 本轮客户端与 UI 交付

`MockInterviewTaskClient` 只调用 `/api/v1/agent/tasks`。JD client 分出不推理的 `prepare`，开始对练时冻结授权材料并创建真实 JD 父任务，不额外跑一次岗位分析；子任务沿用父根与固定运行时。`find/get/observe` 只读，恢复不会 start/resume 或领新预算。回答绑定用户所见 revision 与稳定 message ID，旧问题不会被自动 rebasing 到新问题；结束为明确的 finish action。

| Before | After | Why |
| --- | --- | --- |
| 攻防按钮把提示发送到普通聊天 | 本地导航交接完整选题；Workspace 打开独立子会话，明确授权后才执行 | 导航不授予资料许可，也不混入普通聊天历史 |
| 对练缺少独立恢复位置 | owner/workspace/选题隔离的完整草稿、pending message 与任务指针；普通顾问 DOM 与草稿保持挂载 | 返回、重开和刷新均可恢复，授权不持久化 |
| 未知发送结果可能诱发盲目重试 | 先保存 pending，读取原任务核对；问题或草稿变更后须本人核对并重新授权 | 保留输入，防止重复作答或回答错题 |
| 普通聊天结果与面试回执没有独立层级 | 问题、本人作答和完整评估回执分区；原句/证据按需展开，底部操作独立 | 让主流程清晰且保留所有内容，不靠截断换整齐 |
| 本地匹配模板补写“稳定上线与指标提升”，学历防守预设三年/多系统经历 | 弱表达保留精确原句，问题引用完整要求；未确认学历、年限、上线与指标不作个人事实 | 关键词关联不是已验证的工作成果 |

`emil-design-eng` 的层级/焦点/触控原则用于上述状态与主次操作：窄屏目标44px、可见焦点、独立滚动和换行，无新增装饰性入场动画。`codebase-design` 用于保持边界：前端负责选择/授权/草稿，内核负责派送/账本/引用，未另造执行器。任务全文、本人作答、无效/部分输出及证据 JSON 均完整保留；artifact 元数据不冒充已读取的正文。存储失败或来源/底座变化明确拒绝新执行；不会写简历或 FactBase。

## 本轮验证

- 最终 **134 Host +192 Web +14 Desktop +4 Core =344项通过**，不叠加中间重跑。定向 ESLint `--max-warnings 0` 通过；完整 `pnpm desktop:build` 产物晚于最后源码修改，main/preload/React 已通过实际成品 smoke。Core 两个新增事实守卫先复现旧模板编造再转绿，4/4通过。
- 新 `mock-interview-http.test.tsx` 使用实际 React/默认 client/临时认证 Host：普通聊天1次→JD父0次→对练首问、两次回答和手动结束4次，3任务同根累计5次、adapterBuilds=1。覆盖实际 Drawer 按钮交接、普通草稿不变、刷新不恢复授权、长Unicode/CRLF尾标完整、发送结果未知的核对/重授权、旧revision/来源/底座变化拒绝、另一owner404；读取与重开不推理。
- Playwright `betterme-interview-1112` 仅访问自有5296合成页。实际 Drawer 攻防按钮交接后0调用，授权创建JD父 `ct_783658a3ebc7c83080bda17341a6a729`（ready、0次）与子 `ct_710b57e34ad115cb45f509386b2e969d`。首问后填写带尾标草稿并刷新，内容完整且授权未勾选，调用仍1次。重新授权提交两轮、手动结束后子 completed，共4次、adapterBuilds=1、同JD根。再次刷新完整两答及逐答回执恢复，仍4次/1adapter，POST列表不增。
- 截图 `output/playwright/mock-interview-kernel-1112.png` 已目视检查：头部、原要求、对话卡和固定操作栏完整；回执正文位于同一滚动区域。滚动后另存 `output/playwright/mock-interview-receipt-1112.png` 并目视确认两条原答/问题/建议/证据ID及后续练习，回执正文473字符，无截断。自有浏览器与5296均已关闭，原5173/5179未操作。
- 浏览器使用脚本化 reasoner，0外部模型/真实服务调用；favicon404与合成模型目录探测的CSP拒绝不是推理结果。上述测试验证协议、恢复和界面，不证明真实模型面试质量。旧枚举 `verified_match` 为兼容保留，Drawer 显示 claimed；完整语义事实分数仍是R5待办。

## 最终桌面资源

相邻 `../BetterMe.app/Contents/Resources/app/dist` 533文件可恢复同步，源/候选/目标清单核验后原子替换；未修改真实窗口、profile、原5173/5179或当前Host进程。

- 安装清单：`edc6ea98e2886ecc75016e6ce6e802fa5294f8b9574d721c57a3a0ffa5ad8b2c`
- Web清单：`f9aef3bfd3dbf85070f19b6ef43ed2b6bd0b2a06461bb5bceac62ccda5c5d72f`
- 上一资源：`dee5e32a2d18926f3aeba190f7610f8e5dcd069404038dabfe1fdc35886b286c`
- 最近回退：`../.unified-agent-app-cG7ivd/previous-dist`，更早备份保留。
- 成品离线回执：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-nuedRs/summary.json`。

Electron34.2.0 的实际main/preload/React、两窗口创建/重开通过，独立profile、4次合成API读取、0真实服务/模型调用。此处仍只是安装启动验收，后续真正的Electron多轮/进程恢复证据见本文首节，两者不混同。GPU context警告未阻止渲染/IPC。用户正在运行的旧Host未重启，不宣称它自动加载新协议；使用新版前先保留旧窗口未发草稿，再由本人正常重开。未提交、推送或采用个人事实。

## 协议和责任

- 创建必须提供已有 `jd_match` parentTaskId、精确 parentSourceFingerprint、当前运行时和明确 consent。Host 从该本人账号内的父任务复制完整 JD 与授权自述，不接受客户端另塞匹配材料；不复制旧模型建议为事实。所选 question/gapItem/corePoints 是不可信的提问背景，不是候选人经验。
- 子任务真实 parent 是 JD；若 JD 自身为聊天根的子任务，则三者仍共享同 rootTaskId、根额度与固定运行时/授权代次。不得借另建会话换供应商或领新预算。证据使用本地 BM25/Top-6 精确片段、完整 manifest、UTF-16分页，原文和完整回答/无效输出留存。
- `/tasks/:id/start` 首问；等待回答时 `/answer` 携带 `interviewAction:answer` 与唯一 user message；明确结束携带 `interviewAction:finish` 且不带伪造回答。非对练任务不接受该 action，start/resume 也不能携带新的回答/结束动作。`resume` 只由本人对中断/暂停任务显式执行，不由恢复自动触发。
- Host 决定 interview/evaluation phase。模型不能提前结束；未结束的 receipt 拒绝，结束后继续 question 也拒绝。有效回执必须逐一覆盖全部 user answers，用准确 message ID、原答非空精确引用和已挂载 answer evidence；改写建议的无据数字/职责升级拒绝。最终完整回执含漏洞、精确表达和后续练习，仅为本次作答辅导，不是能力认证或录用概率。
- 每次模型、格式/引用修复、证据回读先计原根账再执行。完整输出超解析额度另存私有 artifact，length 暂停而不自动续答；停止整组拒迟到回答，重开 Host 不重放/退款。不提供原生工具、外部网络、简历写入或 FactBase 采用。

## 当前证据

新增六项 `mock-interview-task.test.ts`：多轮/手动结束、父范围/运行时/预算守卫、提前回执/错引/80%升级修复、长Unicode精确分页、整组停止/额度、Host重开及完整超长/未完输出。

新增 `mock-interview-task-http.test.ts` 使用真实临时认证 Host/owner kernel/resolver：顾问聊天先1次→JD父（0次）→对练首问/回答追问/结束3次，3个任务共1根、累计4次、adapterBuilds=1。另一账号404、未登录401、Fact写入422；读取完整回执不增加模型调用，父原文不变，凭据/端点不落任务记录。所有回答脚本化，0外部模型调用。

`career-task-runtime.test.ts` 新增 SDK wire schema 检查（question/read_evidence/receipt，1次传输），原生阶段测试新增 mock_interview（同授权/同adapter，未知阶段仍派送前拒绝）。这证明协议/计账，不证明任何真实模型的面试质量；通用名词幻觉、STAR和A4评测仍是R5待办。

上一内核批次134 Host +191 Web +14 Desktop共339项通过，是历史快照；当前客户端批次与安装资源以上方本轮段落为准。没有刷新用户窗口或重启当前真实Host，故不宣称正在运行的真实会话已加载新类型。未提交、推送或使用真实简历/模型。

## 下一步验收门

1. R1/R2优先：账号Host运行时已接入并通过124项相关回归；下一步迁移Companion的respond、Writing的generateChatGptWritingReply及understanding-client旧分支，检查Workspace/对练明确账号选择不降级，迁完再关闭旧独立执行器并验收双端。详见账号运行时报告；保留明确账号/模型、授权/撤权/身份代次与完整消息。
2. 旧无scope关联与资料变化接手、完整artifact正文阅读；不凭父根关系扩大资料授权。当前对练协议/客户端/独立草稿/双端恢复已验收，不重复重写或把旧账号路径当作已统一。
3. R4真实脱敏Gold的来源/许可/hash/标签，以及R5四维矩阵/实际A4和R6周期对比仍未完成；本轮事实模板守卫不替代这些目标。整体保持active。
