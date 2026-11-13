# ChatGPT 账号运行时接入统一任务内核

2026-11-12 · `agent-os` · **Host 及三类账号 Facade 已迁入 tasks，并完成本阶段隔离双端验证；整体目标仍 active**。后续成长六操作和JD元数据已迁入真实task；当前安装资源/回退及剩余门以[字段提取回执](jd-intake-task-runtime-2026-11-12.md)为准，本页资源/待办保留为当时快照。截图识别、历史显式接手、artifact 全文及真实 Gold/Eval/周期比较仍待完成；旧独立推理 HTTP 尚未关闭。合成账号成功不代表正式账号实跑或模型写作质量成绩。

## 本轮前端迁移

- 伴侣删除 `chatGptClient.respond` 分支，旁写删除 `generateChatGptWritingReply` 调用；分别传入既有 free_chat、experience_refine 客户端，保留完整历史、引用、本人补充、授权背景和原 rootScope/parent。项目理解新建不再绕到旧 sessions，所有运行方式都创建 project_understanding；旧记录仍可读、撤权、取消，但客户端拒绝再从旧 turns 推理，不自动搬历史或恢复许可。
- 新增共享选择 seam `lib/agent-task-runtime.ts`：统一底座、明确账号和配置模型按既有显式选择解析；不可用账号保持被选中并停止，不换 API。伴侣、旁写、顾问、报告和对练使用该 Interface，在派送前及采用结果前核对选择/就绪状态；Host 的 owner、授权代次和根预算守卫保持原样。
- 顾问、岗位报告和对练不再遗漏账号选择。账号文本任务遇图片明确拒绝，图片保留；报告标题显示实际任务底座，不再显示旧 API 模型名。截图 OCR 仍有独立且标注配置模型的旧通道，尚未迁移，不能把此处报告选择修复外推到 OCR。
- 伴侣和顾问原输入完整传递，包括首尾空白与 Unicode。浏览器核对发现顾问构建 userMsg 时还二次 trim，已移除并加入真实组件回归；旧合成任务不改写，另发明确新一轮验证。textarea 的 CRLF→LF 属原生表单行为，测试按实际 textarea 值逐字比较，没有模型端裁短。
- 使用 codebase-design 的小 Interface 复用现有 task Adapter，而非再加模型执行器。writing-for-agents 只用于把本轮停点与后续门写入项目记录，没有改个人事实或全局记忆。

## 本轮验证

最终相关 **91 Web +124 Host +14 Desktop =229 项通过**，不是整仓测试结果。新增3项选择/迟到结果验证及1项生产 Facade 认证 HTTP；修改原账号旁写和旧项目客户端测试以断言 tasks/停止旧推理。Host 构建、定向 ESLint `--max-warnings 0`、脚本语法、diff 检查、完整 `pnpm desktop:build` 通过。构建仍有既有 atlas Node 模块外置/大包提示，未作为新错误处理。

- 生产客户端 + 实际临时认证 Host + 有效签名的虚构 OAuth 供应商：聊天、润色、项目理解3任务/同账号/同根，3次派送；完整长 Unicode/CRLF 原文、补充和共享背景逐字比较，重复调用/读取不派送，不使用 API/native fallback。
- 隔离浏览器真实按钮/默认客户端：伴侣、顾问、旁写、项目理解、对练和报告共7任务同根；8次完整链请求，另1次为修复二次 trim 后的明确顾问续问。共9次，fallback=0；手动结束回执，报告只读恢复，两次刷新不增调用。浏览器原始完整回执 `output/playwright/account-tasks-browser.log`，SHA-256 `3ab1e5983cd6ab52a1cd1b0610b9587aef00f2bc2dfc466174d547abfcfd1ed7`；截图 `account-tasks-browser.png` / `account-tasks-report.png` 同目录，已目视。
- 新 `chatgpt-task-smoke.cjs` 在全新合成 owner/Host/profile 下：实际安装 preload + 生产 React/default clients 完成7任务、8请求、同账号/根，完整补充/作答/回执引用逐字一致。第二个独立 Electron 进程恢复伴侣未发草稿、完整旁写、项目对话、对练回执和报告；授权仍未选，task ID 和全部 tasks POST 数组不变，模型仍8次。完整任务 JSON 由测试通过实际 owner API 另存，不冒充本轮重新点击了 UI 下载按钮。
- 本轮账号对练通过生产 MockInterviewPanel 专用合成入口启动；没有把它冒充账号下的 JD Drawer→Workspace 攻防按钮全链已重跑。该真实按钮跨入口的配置/原生验证仍见 mock-interview 回执，账号全链仍是后续门。
- 最终 Electron 目录：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-account-fuxluF`；`complete-task-records.json` SHA-256 `e785dbe63ae65916a896f88d78a6a77d57a24464ab2d280cb5a9f147a691ce37`，`restore-summary.json` `65bfa3eb127193d0a7a046e2a0f3fae57d069588c2c8d2b30a58d0ac71074221`。installed preload `70cb32be239ff1f00c102248b1ea8cf9746365b76250c8246a41ea1c001c256e`。
- 初轮新测试先修正 DOM 初始化时序、清理方法名和 prompt.context 的观察位置；长项目样本触及既有16000字符硬限，未放宽限制或裁短后发送，改用限内完整样本。Electron 脚本修正可访问名称/精确聊天字段定位、等待授权框可用和展开已保存旁写后读 textarea.value；生产授权守卫未放宽。顾问二次 trim 是实测发现并修复的生产问题，和这些夹具问题分开。

最终日志：`/tmp/betterme-account-ui-final-tests.log`（SHA-256 `5f89cb80deb03804e61656ab6f34114d45abfefff5c6d69339400f671258be59`）、`/tmp/betterme-account-host-regression.log`（`2b24af4dfc2752711d9cc625302b4d1d6aec85a605510442864d1d19aaf9887f`）、`/tmp/betterme-account-desktop-tests.log`、`/tmp/betterme-account-electron-flow.log`（`bfc43c7b7679dc95ef7882c62e943e6d1f87daefdd4124cbf2eb42d164f3b9b6`）。复现 Web 集：

```sh
pnpm exec tsx --test apps/web/tests/{agent-task-runtime,chatgpt-task-facades-http,agent-companion-output,agent-workspace,resume-copilot,understanding-client,project-understanding-panel,mock-interview-http,free-chat-http,experience-refine-http,project-understanding-http,jd-match-http}.test.*
```

账号双端夹具先启动 `pnpm exec tsx apps/web/node_modules/vite/bin/vite.js --config apps/web/tests/ui-lab/chatgpt-task-live.config.ts`，仅5299临时服务、签名合成 OAuth 和脚本回答。全新 Host 下运行 `node apps/desktop/tests/chatgpt-task-smoke.cjs '/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist'`。不得替换为原服务、原窗口或真实账号材料。

## 当前安装资源与保护范围

- 最终 `BetterMe.app/Contents/Resources/app/dist`：533文件；独立只读比对构建并集按路径/大小/hash **0差异**；清单 SHA-256 `04e099f437f39b8ff3ee95166365e524e05dfc80ba79a63c88362b4da481bb4e`，Web清单 `c42b33d0927ed4d27218cc768c98dc5de0aa235a15eb122de48a87ac33691023`。
- 紧邻最终版本的可回退备份：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-Fy30xw/previous-dist`，清单 `cdea86cdefe579d30f98037aa2dac948e9b2e74cda3be00f7ec86d76a53e4cbf`。本轮开始前的 edc6ea98… 资源仍完整保存在 `.unified-agent-app-ZfzfMo/previous-dist`。中间重建分别用于真实模型名和完整输入修复，没有覆盖这些备份。
- 最终成品 main/preload/React 离线 smoke 两窗口重开通过；摘要 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-7siiPV/summary.json`。这与账号链使用源码 React + 安装 preload 是两项独立证据，不混为运行中的原应用已刷新。
- 外部 OpenAI/真实模型调用0；原5173/5179服务、真实简历/FactBase/凭据和用户页面未操作。仅停止自有5299/测试进程；没有提交、推送、发布或全局记忆写入。原页面需本人保护旧草稿后再手动重载。

## Host 实现（前一阶段，仍有效）

## 实现

- `tasks/runtime.ts` 不再拒绝明确的 `chatgpt` kind。`server.makeOwner` 将原 owner 私有的 ChatGptPlanService 接入同一个 resolver；缓存按注册/profile、明确模型和授权指纹分开，不借配置模型、原生 CLI 或其他 owner 的账号。原统一内核继续决定任务类型、预算、证据和修复。
- `ChatGptPlanService.respondTask` 是一次实际 Responses 派送，不包含对话/JSON 修复/证据回读循环。Host 选择 phase 和完整输出 schema；原 prompt 不裁短，不加 max_output_tokens，不借浏览器 API Key、CLI 凭据或 backend-api 路由。模型目录读取和 OAuth 刷新不是模型推理，不另领任务预算。
- 授权存储新增私有可选 `grantId`；旧记录首次参与内核时在原安全事务中生成。正常 refresh 和进程重开保持同一指纹，成功重新授权生成新代次。指纹只进入任务运行时的 opaque digest，token/subject/client ID 不进入任务 JSON。退出/重新授权中止在途账号派送，前后检查 BetterMe lease 和账号代次；已有任务不能借新授权继续旧根。
- 刷新/模型目录与重新授权竞态：旧 refresh 的成功结果不能覆盖新 tokens，迟到 refresh/catalog 失败不能清除新 tokens 或给新授权记失效问题，旧目录也不发布为新授权的目录。未改变原账户映射与密钥权限，也没有读取真实凭据。
- 新任务路径删除旧 100000 字符成功输出上限：完整较大文本交给内核，超解析额度保存在原 owner 私有 artifact；未完成/断流/流内失败保留已收到的完整文本并返回 incomplete，内核只暂停，不自动修复或续写该传输失败。保留既有事件流字节硬限，触及硬限明确失败，不能冒充完整答复；旧 `respond` 的兼容行为未在本轮隐式改变。
- 当前账号文本协议不支持图片，明确报告 supportsImages=false 并拒绝图片，不丢弃图片后发送文本。配置模型图片路径不变。

该 seam 遵循 codebase-design：复用 owner 内账号 Adapter，一次传输对接原内核 Interface；不是把旧多轮理解执行器包成一次免费调用。

## 当前官方协议依据

既有 SIWC 套餐授权通道使用明确账号的 OAuth token、当前模型目录及 `POST /v1/responses`，`store:false`、`stream:true`；没有改成 Platform API Key。[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

注册映射与凭据保持隔离；退出停止请求，refresh 串行旋转。套餐权限/额度错误停止推理，不静默更换计费。[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。grantId 和根内固定授权是本项目控制设计，不是文档提供的官方 token 字段。

## 验证与边界

新增 9 项 runtime +1 项真实认证 HTTP 测试，最终相关 **124/124** 通过；包含旧配置/原生任务、父根账、JD/对练、身份隔离及既有 SIWC 回归。不是整仓测试全绿或真实模型质量结果。

- runtime 通过真实 ChatGptPlanService、签名有效的虚构 OAuth provider 与注入 fetch，7 个 Host phase 各一次实际虚构 Responses 派送。长 Unicode/CRLF prompt 逐字核对，完整长输出、incomplete/断流/流内额度错误均不裁短或内部续发；未知 phase、图片、错模型、身份/授权变化均拒绝。
- 认证 HTTP 使用真实 server/身份注册/owner/kernel/resolver/account transport，不注入 reasoner 答案：free_chat 首轮无效输出+内核修复共2次，experience_refine 1次，project_understanding 1次；3类任务同 rootScope/根/runtime，总4次。下一次被根额度拒绝，GET/events不增加调用，完整原文和无效输出尾标保持。
- 另一 owner 读取/下载为404，不能以同 profile ID 使用首个 owner 的账号；新任务 start 为401，0外部调用。重新授权后旧暂停任务 resume 为409 `runtime_authorization_changed_new_task_required`，用量不变。
- 独立 incomplete 根只派送1次，paused且完整 partialOutput；独立超解析额度输出保留完整 artifact，下载逐字相同。没有把这些独立根算作三类任务共根的证据。
- 首轮 HTTP 断言错把 JSON 内编码的 CRLF 文本当作 raw prompt 子串；改为解析实际 prompt 后逐字核对。另一次断言漏写已有 `_new_task_required` 错误后缀；均只修正测试观察点，未放宽授权或内容校验。
- Host 类型/构建（`pnpm --filter @better-me/agent-host build`）、改动源与新测试定向 ESLint `--max-warnings 0`、diff 检查通过。

最终测试日志：`/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-account-kernel-tests.hpeM4yDrWg`。复现命令：

```sh
pnpm exec tsx --test apps/agent-host/tests/{career-chatgpt-runtime,career-chatgpt-http,career-task-runtime,career-task,career-task-http,chatgpt-plan,chatgpt-http,free-chat-task,free-chat-task-http,experience-refine-task,project-understanding-task,task-root-scope,task-root-ledger,task-root-ledger-http,jd-match-task,mock-interview-task,mock-interview-task-http,identity-http,understanding-native-provider}.test.ts
```

前一Host阶段全部测试使用新临时合成账号/目录/端口；外部 OpenAI/真实模型调用0，真实资料/原服务未操作。该阶段当时只有Host产物；本轮前端与安装包已按上方记录完成同步，勿沿用历史“未更新App”的停点。

## 下一步

1. 审计并迁移 `CareerCoachWorkspace:186` / career-coach/model 的配置、账号及 routing.respond 旧执行链；同轮核对 JD 截图 OCR 等剩余前端模型派送。不得先关闭被这些调用者使用的兼容 HTTP，或把其多次调用包成一次免费任务。
2. 旧任务保留完整只读历史，显式授权另建/关联内核任务；补旧无scope关联、范围变化接手、完整 artifact 正文。全部调用者迁完后关闭旧独立推理 HTTP，并补账号攻防按钮→Workspace实际交接双端证据。
3. 继续真实 Gold/四维矩阵/周期比较；合成夹具不充真实 Gold。后续 Web 改动仍需完整双端构建/可恢复同步，R1–R8 全部有证据前保持整体 active。
