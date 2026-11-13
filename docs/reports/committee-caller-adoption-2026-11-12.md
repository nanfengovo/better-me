# 委员会生产调用、采用链与迟到全文留存

后续旧入口退役、隐私证据复用和本人要求的阶段收尾见 [阶段闭环](committee-retirement-2026-11-12.md)。下文是上阶段原始回执，其“旧入口待退役”是当时停点，不覆盖后续结果。

2026-11-12，`agent-os`。生产委员会页面已经通过统一 tasks 创建、读取、停止与明确恢复；发布审阅及架构白板使用内核当前结果和计量后的新鲜证据。**旧委员会 HTTP/执行器仍待退役，完整统一 Agent 目标仍 active。** 本回执接续 [Host 阶段](committee-kernel-runtime-2026-11-12.md)，不把脚本模型验收当成真实写作质量成绩。

## 本轮实现

- `createStudioCommitteeTaskClient` 使用 `/api/v1/agent/tasks` 及其子路径。旧逻辑方法名 `/committee/start` 只在 client 内分流，生产浏览器不再向旧 committee HTTP 发送推理请求。同工作区继承先前聊天根预算和同一个 owner runtime Adapter，不创建独立的 28 次/80 次/330 秒生成额度。
- 完整 context、运行时、claimIds、statement、代码文件和范围冻结。稳定输入指纹派生幂等键；未知创建回执先核对原记录，不以新键重发。存在同键异资料、异 owner/scope/runtime 时拒绝；GET、重连和再次 start 都不会自动恢复暂停任务。
- 页面明确显示实际 task usage。单独“核对原任务状态”“明确恢复原任务（沿用原预算）”和停止按钮操作原 task ID；编辑资料清除同意。超过 40 句或 20 份陈述明确报错，未取前 N 条。补充首尾空白、CRLF、emoji 原样保留；未知创建待核对时展示并保留完整冻结请求。
- `studioCommitteeOperation` 是 task 的只读展示投影，不另存 SQLite 执行权威。历史列表兼容旧记录，同时呈现新 task；旧数据没有被改写或认领。
- Host 的 `reviewStudioCommittee` 仅接受已完整完成的当前任务，重核 owner、context、授权、会话、本地 digest、snapshot/report 绑定以及完整源版本；源码重读消耗原根 tool 额度。
- 发布审阅和白板导入复用该受信任 bundle。白板从刚刚计费读取的 evidence 构建原坐标/版本记录，不再额外免费调用 Broker。源码改动、撤权或原工具额度不足都会阻止采用，不触发新模型或重新开账。

## 实际发现并修复的全文缺失

原浏览器验证发现：第二项委员会任务停止时已派送模型，但迟到输出没有进入私有日志。直接 kernel 测试曾通过，不能覆盖真正 owner runtime 的返回链。

复现命令：

```sh
pnpm exec tsx --tsconfig apps/web/tsconfig.json --test --test-name-pattern='actual owner runtime preserves' apps/web/tests/studio-committee-http.test.ts
```

认证 HTTP 测试连续两次失败在 `the real owner runtime must deliver late complete wire to the kernel's private archive before refusing adoption`。已付调用是 1，任务为 paused，实际回复已从脚本 Adapter 返回，但日志无输出。

原因是 `tasks/runtime.ts` 在 `await inner(...)` 后先执行 abort/binding 检查，抛错会丢失已返回的完整 wire，内核归档代码根本未得到执行机会。不是 SQLite 投影或模型没有响应。

修复使用仅 Host 内存可构造的 `RejectedTaskModelOutput` 携带原始完整输出和安全拒绝码。运行时仍拒绝旧授权结果；委员会内核仅把内容保存到原 owner 私有日志/超长 artifact，并标明旧运行代次，再抛出拒绝。它不会恢复任务、进入完整轮次回放缓存或产生可采用结果。请求前的停止/权限检查没有放宽。其他任务类型及 Native/账号下层中断路径仍须各自核验，不能凭此声称所有迟到路径都已验收。

新增回归覆盖：普通迟到全文、超过 126,000 字符的 artifact 原文逐字一致、停止后完成缓存为空且没有 result；运行时另测 pause、lease、close 三种返回后失权，约 19 万字符及 finishReason 完整保留，后续派送仍被拒绝。

## 验收证据

完整目录：`output/agent-runs/committee-caller-adoption-2026-11-12/`。61 个原始成员及逐文件大小/SHA manifest，包含最终/失败日志、浏览器和 Electron 私有合成任务、安装验证、截图与本轮相关源码快照。没有复制 cookie、真实凭据或真实简历。

| 验收层 | 结果与边界 |
| --- | --- |
| Host/运行时/根账/Studio 相关 | 最终串行 109/109 通过；覆盖实际认证 HTTP、语法原样传输、同根预算、暂停/恢复、source/digest/owner 变化和采用 |
| Web | 44 个不同用例通过。主日志 29 项中 Panel 6 项随后以新增后的 7 项重跑替换，另 14 项 adoption/layout；重复执行不重复计数 |
| Desktop | 14/14 通过；另有下面两种 opt-in 实际 Electron 验收，不混入 node:test 数量 |
| 类型、构建、lint | Contracts、Host、Web 类型及 Host build、完整 `pnpm desktop:build`、定向 ESLint 和 diff 检查通过；不是整仓全套测试通过声明 |
| 浏览器真实操作 | 完整生产 Panel/client + 认证临时 Host。已有聊天 1 次；第一委员会完整 14 步加 1 次部分失败共 15 次；第二任务派送 1 次后明确停止。共 17 次脚本调用、1 Adapter、0 legacy complete、0 外部模型 |
| 浏览器刷新 | 三份原任务字节/hash、完整 statement/source/部分 wire、停止迟到全文及全部 POST 路径在 reload 后一致；没有自动推理或恢复授权 |
| Electron 实际流程 | 独立新环境执行同样流程，安装 preload + 生产源码 React/client + 实际认证 Host；同样 3 任务/17 脚本调用/1 Adapter/0 legacy。第二独立进程和 reload 后三份原记录 hash、POST 清单均不变，同意不恢复 |
| 安装成品 smoke | 实际安装 main/preload/React 两窗口启动及重开通过，3 assets、4 合成 API 读取、0 真实服务/模型调用；与上一项源码 React 功能链分开说明 |

首次大并行测试有一个既有 400ms aggregate-active-time 用例在派送前耗尽，`calls=0` 而期望 2；原失败日志保留。未改测试阈值或预算断言，完整 109 项串行重跑通过。另一次浏览器验收错误使用异步 waitForFunction 谓词，导致在模型开始前停止；另一次 Electron 固定等待短于故意延迟的回复。这两次未记为通过，最终改为同步 DOM 状态/实际私有归档条件等待，并在全新临时环境完整重跑。

三张最终浏览器截图均已目视；完成态截图位于报告下方滚动位置，不据单一 viewport 声称全部视觉状态通过。只有 favicon 404 和 React DevTools 提示，没有授权或模型网络异常。Electron 两进程截图/回执亦单独保留。

## 桌面同步与保护

相邻安装成品：`/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist`。

- 533 文件，安装完整 DFS SHA `7bdb7347f61e3dbb760d106457e087f7e767bc88ddb9395f48418108854ebf8f`。
- Web DFS SHA `13c867d60769193de22ad0bc765c6c394da23a132aa72b62ef51c6fc821f0c7f`。
- 上一安装 SHA `9eb74f029a4848cc89166b19880909b5b031784a000202d7c44a09720497e486`；完整可回退副本 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-h6gVr5/previous-dist`。
- 同步后及最后一次完整构建后，独立逐路径/大小/内容比较均为 0 差异，备份 hash 独立重核。后一次构建与现安装相同，没有再次无意义替换。

真实 5173 PID90086、5179 PID89415 保持，未重启、刷新或操作用户窗口；自有 5296、Playwright 会话和 Electron 测试进程已关闭。未修改真实 PDF、FactBase、个人草稿、账号凭据或旧 Gold/候选/PDF，未提交/推送。源码链接 Host 需要本人下次正常重启才加载新 Host 实现；资源同步不代表运行中的服务已切换。

## 尚待完成

1. 退役旧 `CareerStudio.committee()` 和 `/career-studio/committee/start` 的执行权威；旧历史读取与必要审阅兼容保留，不能留两套可生成循环。
2. 回放、harvester、隐私模型步骤与 Coding Sandbox 等其余实际循环迁入同一内核；多根/资料授权变化及各类返回失权的全文路径继续核验。
3. 委员会等新类型的 BM25 Top-K/精确 UTF-16 manifest 分页逐类验收。当前有冻结目录和有界证据回读，不冒称该新类型的两阶段检索已经完成。
4. 修复简历选材、职责复制和遗漏项目；最新 v7 的来源支持不等于编辑质量。第二模型同条件实跑仍需本人选择正常授权路径；有限周期重算不能替代真实不同模型比较。最后执行完整 R1–R8 总审计。

本轮只完成上述生产调用/采用纵切片与确定性 bug 修复，未缩小原目标，也未标记整体完成。
