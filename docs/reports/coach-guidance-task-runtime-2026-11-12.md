# 职业成长六操作归入统一任务内核

2026-11-12 · `agent-os` · **本阶段已实现并完成隔离双端验证，R1–R8 整体仍进行中。** 后续JD元数据也已迁tasks，当前安装资源与回退改以[jd-intake回执](jd-intake-task-runtime-2026-11-12.md)为准；本页及前序 hash 是历史快照。全部验证使用合成资料与脚本回答，外部/真实模型调用为 0，不代表正式账号实跑或模型质量成绩。

## 实现边界

- 新增真实 `career_coach` kind，覆盖 analysis、resume、plan、review、drill、interview 六操作。契约冻结完整请求、显式许可与运行时；Host 复用原 owner、lease、停止/迟到守卫、rootScope/parent 和累计根预算。创建不推理、不写简历、不采纳方案或认证个人能力。
- 共享 `career-coach-protocol` 只负责纯提示、请求/输出规则与业务校验，不执行模型、IO 或存储。独立 `resume-edit-context` 模块消除共享协议的实际 ESM 初始化循环。遵循 codebase-design：复用原 task Adapter，不包装旧浏览器多次调用为一次免费执行。
- Host 决定每次推理与格式/业务修复，最多三次尝试，每次先计原根账；完整无效输出和校验观察保留。长度结束/未完成只暂停，不自动续答；超过 126000 字符的原始输出完整保存私有 artifact 后明确失败，不裁短后当成功。
- CareerCoachWorkspace 的生产三分支已删除，默认 client 只走认证 `/api/v1/agent/tasks` 子路径，使用当前明确底座/账号。`createCoachGenerator` 仅保留必须显式传入 transport 的测试 seam，没有生产默认独立派送。
- 同一完整请求重开只读已有任务；中断须核对完整冻结请求、已有输出与用量，重新勾选许可，再恢复精确原 task ID。资料、owner、运行时或原任务不匹配时拒绝，不新建任务清账。关闭页面只停止观察，明确取消才暂停 Host。
- 成长记录以实际 task ID 幂等保存。目标确认、方案采纳、练习保存及每条简历提案采用仍由本人决定，原业务存储权威不转移。

## 完整性与实际发现的问题

- 移除成长文本及刷题/面试回答的保存、发送 trim；保留首尾空白、Unicode 与完整历史。练习证据包含完整代码和全部检查；旧 12000 字符 evidence 限制容纳不下允许的 20000 字符练习，已统一为显式 64000 字符上限。超限明确拒绝，不摘录后发送。
- Electron 实测发现：Host Schema 将 `profile.skills/headline` 等对象键规范化重排，恢复后的记录按另一顺序计算 contextFingerprint，导致同一资料无法确认目标。最小回归先稳定失败，再修为递归排序对象键；数组顺序和精确原文不变。真实文本、目标预算或共享范围变化仍失效。
- 旧指纹保持原样可读，不静默升级确认依据；若旧记录指纹与当前资料不符，须重新分析/确认。goalFingerprint 算法未改。
- 新 smoke 首轮还修正了测试时序/观察点：等待账号目录就绪；自由聊天应为 awaiting_answer；重开后的资料授权提醒是预期保护，不是加载错误。只修测试断言，没有放宽生产权限检查。

## 验证

最终 **22 内核/HTTP +108 成长 +55 相邻 +14 Desktop =199 项通过**。Host 类型/构建、定向 ESLint `--max-warnings 0`、脚本语法、diff 检查及完整 `pnpm desktop:build` 通过。不是整仓全绿；构建既有 atlas Node 模块外置/大包提示仍在。

- 内核/实际认证 HTTP：六模式同 adapter/根，格式修复计账；长 Unicode/CRLF、超过 20k 的完整证据原样到模型；incomplete 保留全文并暂停；重开不派送，显式恢复沿原 task/账。超大输出私有 artifact 全文回读、另一 owner/未认证及运行时变化拒绝。SDK/native phase 各一次协议派送，不冒充真实模型效果。
- 浏览器实际组件/default client 验证了分析暂停、勾选后原任务恢复和简历候选，同根 3 次、fallback=0；刷新不重放/不恢复资料授权。该浏览器链未覆盖六操作全部确认，最终完整链以如下 Electron 验收为准。
- 最终全新 Electron owner/Host/profile：实际安装 preload + 源码 React/Provider/default clients，先建聊天根，再经真实按钮完成六类成长操作、暂停后刷新及人工恢复、确认目标、明确采纳方案、保存证据/刷题回答、两答面试结束。共 10 任务、9 条成长记录、同账号/根、11 次模型请求，review 有实际 parent；完整目标、证据、长回答逐字一致，未调用旧独立推理 HTTP 或备用模型。
- 第二个独立 Electron 进程只读恢复完整任务/成长记录、分析未发草稿、简历候选及面试回执；全部任务 JSON hash、ID 和 tasks POST 数组不变，模型仍 11 次。授权均未勾选，存在资料范围变化提示，提案应用按钮禁用。不是在用户真实窗口刷新，也不是 UI 下载按钮验收。
- 最终原始回执目录：`/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-coach-M53nef`；`complete-records.json` SHA-256 `d80848dfeb16fe53e50946c7c439ec5e7aa371720df79da35588ab455571add5`，`restore-summary.json` `f7fe03cbd68747cbfccd7ba92c3c1668ee48966b035d33060e34819546857bd4`。临时 Host 为 `betterme-account-browser-IniOvE`，仅合成资料。

复现（每次完整 Electron 链使用全新临时 Host，先启动夹具）：

```sh
pnpm exec tsx --test apps/agent-host/tests/coach-guidance-task.test.ts apps/agent-host/tests/career-task-runtime.test.ts apps/web/tests/coach-guidance-http.test.ts apps/web/tests/chatgpt-task-facades-http.test.ts
pnpm exec tsx --test apps/web/tests/career-coach-*.test.ts apps/web/tests/career-coach-*.test.tsx apps/web/tests/career-growth-loop.test.ts
pnpm exec tsx apps/web/node_modules/vite/bin/vite.js --config apps/web/tests/ui-lab/chatgpt-task-live.config.ts
node apps/desktop/tests/coach-guidance-smoke.cjs '/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist'
```

最终日志：`/tmp/betterme-coach-kernel-http-final.log`、`betterme-coach-regression-final.log`、`betterme-coach-neighbor-regression.log`、`betterme-coach-desktop-tests.log`、`betterme-coach-electron-final.log`（均在 `/tmp/`）。Electron 日志 SHA-256 `8775eedc8f5ce2aaf8e141c869b3622906f949861242ca9dd1995a41c9c61058`。

## 当前安装资源与保护范围

- 完整桌面构建后可回退同步相邻 BetterMe.app，独立只读比较构建并集的路径/大小/hash：533 文件、0 差异。清单 `5df0ce5e8c952e4dad84cf72bb7f6b0acee1074e38c51abc0bae2eaaec21228d`；Web 清单 `6dbe7bbb4b92b588ae2308da35d3ea856e110ade0281aad2fa79ab13b632aedd`。
- 紧邻最终版本备份：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-CCuEz6/previous-dist`，清单 `e439beb142cd05876c0f528dc1addbd7d57ca0e680f9eea284968e1525bc9dd0`；本阶段开始前 `04e099f4…` 资源保留在 `.unified-agent-app-ToH91D/previous-dist`。未覆盖旧备份。
- 最终安装 main/preload/React 离线两窗口 smoke 通过，摘要 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-jHl0Wt/summary.json`。与源码 React 的成长全链是两项独立证据；GPU context 提示未影响断言。
- 自有 5299/测试进程已停止；原 5173/5179、真实窗口/简历/FactBase/凭据和并发 Git 改动保留，0 外部模型调用，未提交/推送/发布。运行中的原窗口未被强制刷新，保护旧草稿后由本人重载。

## 后续门

1. 后续已完成元数据迁移、删除 `parseJobWithLlm` 及3000字符截取，见上述回执；剩余 JD 截图 OCR 的实际调用者/完整图片存储须继续迁入，不用合成成绩宣称全入口已经统一。
2. 调用者迁完再关闭旧独立推理 HTTP；旧无 scope 历史显式关联、资料变化/中断接手及 artifact 全文 UI 继续补齐。
3. 账号下实际 JD 攻防按钮→AgentWorkspace 全链、5–10 组真实脱敏且有来源/许可/人工事实标签的 Gold 集、四维 Eval 与可复现周期真实模型比较仍待完成。不把合成夹具算作 Gold，不默认定时付费推理。
