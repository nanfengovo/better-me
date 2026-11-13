# 历史根账显式关联与中断接手

后续安装资源与真实候选质量已更新，当前权威见[整稿v5回执](task-candidate-editorial-2026-11-12.md)。本报告的历史关联/中断接手证据仍有效，533资源59a76b93…为当时快照，不再是当前安装清单。

2026-11-12，`agent-os`。新增**旧无scope原根→尚无根账工作区**的显式关联；原根及所有既有成员的原文、来源、授权、修订和用量不重写。新任务继承原根、原总上限和固定运行时。**工作区已有另一根时明确拒绝**；多根合并、资料/授权版本变化及全目标审计仍未完成，不能据此勾选完整R2或总体目标。

## Host拥有归属规则

- 正常认证 `/api/v1/agent/tasks/legacy-scopes?rootScopeKey=…` 只读预览本人旧根，列出完整任务标题、原工作区、状态、模型、整组用量和上限。GET不获取模型adapter、不恢复任务；既有Host重启读取仍按原规则将失联running标interrupted并保留计量。
- `/api/v1/agent/tasks/:id/associate-scope` 必须提交目标scope、完整组快照token及 `confirmation:"associate_records_and_usage_only"`。token含owner、目标和按ID排序的**完整原store**；任一后代修订、用量、存档来源/授权或根归属变化都需重新预览。运行/撤权组不能关联，跨owner和冲突根拒绝。快照只绑定任务存档，不读取外部材料或证明账号当前授权；后续真实发送仍由原来源/运行时守卫重查。
- 同一owner writer内，单个私有 `task-scope-associations-v1.json` 原子记录完整关联回执及原成员ID，不改写多份历史task JSON，也不建立第二份累计计数器。根用量继续从原逐任务charge推导。新子任务必须持久化有效scope；未确认的无scope注入成员、损坏/串owner/重复映射一律关闭操作。
- 对旧成员的有效scope及缺失的rootTaskId只做读取投影，原父子拓扑/输入hash不动。关联后原额度已满仍拒绝新派送；上限变更继续走本人精确确认，不自动扩额。运行时/account generation仍沿原Host守卫，不因关联放行。
- 回执丢失后只读可核对原根；同token/目标再次明确提交返回原关联，不重复写或启动模型。不同目标/token不能覆盖已有回执。

## 现有中心内的显式入口

“共识与进度→工作区共享额度→关联旧任务记录”，默认收起，读取预览也需点击；选定原根后还需勾选“仅关联记录与用量，不恢复运行或资料授权”。冲突显示两份根身份，确认禁用，不悄悄清账/合并。文字使用完整换行，无Agent输入/输出截取。

账号代次变化即清除旧预览/根用量，取消观察并拒迟到结果；切换工作区后旧刷新也不能覆盖新账。未增加运行、资料共享、简历采用或Fact写入动作；后续发送仍走原任务授权流程。UI遵循既有主题/对齐和32px、窄屏44px目标，无新动画/独立工作区。

## 验证范围与原件

- **71项 Host/Web + 105项跨kind/候选/Eval + 14项 Desktop = 190项通过**，文件集不重叠。分别见 `/tmp/betterme-scope-association-final-regression.log`、`cross-kind-regression.log`、`desktop-tests.log`（后两者同前缀 `/tmp/betterme-scope-association-`）。无失败/cancel/skip，不是全仓全绿或真实模型写作质量成绩。
- 七项新Host测试：原JSON逐字不变/原账用尽不清零/同运行时新子任务；后代变化/不同scope/缺确认；并发唯一归属；运行与撤权/owner；恶意成员与损坏映射；缺rootTaskId旧记录；真正关闭Host后的interrupted接手。最后一项证实关联仍interrupted、模型仍1次，缺consent/不同runtime拒绝，另行明确resume后才累计2次，旧迟到回复不采用。
- 真实认证HTTP/生产客户端：一次旧调用→预览→缺确认400；模拟**持久化后回执丢失**，GET核对已关联原根、不重发；显式相同确认幂等，后续新视图同根累计2次/adapter只建1个。全部推理/关联写入在tasks下；无外部模型。
- 独立Playwright `betterme-legacy-1112`：实际读取/选择/确认原根 `ct_c9a34c8e88ef1018eaccf5b71bc1c47d`，关联前后1次；新同根调用后累计2次；另一无scope根保留为冲突，不能确认。最终3次合成调用/0 fallback/1 association POST。390×740横溢出false；宽/窄图 `output/playwright/task-scope-association-{browser,narrow}.png` 已目视。仅合成组件夹具，不称正式账号全应用视觉验收；自有浏览器已关闭。
- 新 `apps/desktop/tests/task-scope-association-smoke.cjs`，最终日志 `/tmp/betterme-scope-association-final-electron.log`，进程0。使用新隔离Host/完整OAuth adapter协议夹具、源码React/默认client及安装preload，两个**独立Electron进程**完成相同流程/恢复。原根 `ct_a9f5c6cf8fc54230687817e1ecbebf63`，原JSON SHA **5981b7a4796c2f978659c3295debd710981c912890399c2cef04556b4c57bda7** 关联后及重开均不变；原根+新子累计2，另一旧根独立1。两进程均7个task POST/3次合成调用，记录hash **dcc5cf4887dad160fdaddb3ed7a062c724624f5e26b5cb1b0482d72c2c24a87e** 不变，0外部模型/fallback/业务采用。
- Electron profile `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-scope-S5k3Bx`，保留checkpoint、run/restore-summary和PNG；restore图已目视。Host夹具 `/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-account-browser-UCtRWx`；自有5299已关闭。前一回合Glo0UT为父账迟到刷新保护前的历史验收，不作为最终源码唯一证据。

## 当前双端资源与回退

- Contracts/Host/Web类型、Host构建、定向ESLint `--max-warnings 0`、完整 `pnpm desktop:build` 通过；日志 `/tmp/betterme-scope-association-{contract-types,host-types,web-types,host-build,lint,desktop-build}.log`。既有Vite Node外置/大chunk提示保留。
- 最终sync `/tmp/betterme-scope-association-final-sync.json`；独立逐路径/大小/SHA核对 `/tmp/betterme-scope-association-final-installed-manifest.json`：533预期/533安装/0差异。DFS清单 **59a76b93a0a382f53493990fc659db7278053c4887286fc48f864b6447e29229**，Web **829a7422cc99fcdeaba50b86770c32440744e3eaaddf2efe483a96fc1b2473b1**。
- 紧邻前版331bae19…回退 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-4admfn/previous-dist`；本轮开始前2b0a7502…完整回退 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-wihqJW/previous-dist`，两份均保留。
- 当前安装main/preload/React离线两窗口smoke进程0，3assets/4合成读取/0实际服务或模型；`/tmp/betterme-scope-association-final-installed-smoke.log`，profile `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-s1Gz4v/summary.json`。GPU诊断不影响成功，不冒充正式业务链。
- 原5173 PID90086、5179 PID89415仍在；未重启/刷新真实窗口。source-linked Host需本人下次正常启动加载新代码。真实简历/FactBase/原PDF/凭据/草稿及其他dirty改动未动，未stage/提交/推送/换分支。

## 完整目标剩余门

本轮只推进历史无scope原根显式关联与同指纹中断恢复。已有根之间的合并/授权版本变化、剩余实际推理路径、最终业务成品总审计仍待。不同第二个模型、独立语义/完整性/STAR及周期实跑仍待；v4真实质量和五例失败分母保持原样，详见 `task-source-bound-candidate-2026-11-12.md`。当前只读Ollama tags仍只有同Gemma权重两个本地配置和一个明确remote的31b-cloud，未下载/改变模型或调用云端，不把本轮合成协议验收混作模型成绩。整体active。
