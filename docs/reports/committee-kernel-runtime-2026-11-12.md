# 委员会审查内核执行与原根计量

后续生产caller/采用迁移、真实owner runtime迟到全文修复及最新安装资源见[委员会生产调用回执](committee-caller-adoption-2026-11-12.md)。下文保留本Host阶段历史证据与当时限制，不是最新剩余清单。

2026-11-12，`agent-os`。本轮新增真实 `studio_committee` 任务和认证 tasks HTTP 执行，复用现有四角色、交叉审阅、最终裁决协议。**这是委员会迁移的 Host 阶段，不是整个委员会页面切换完成，更不是完整统一 Agent 目标完成。** 旧页面、旧委员会入口及发布/白板采用链还保留；下一步要把它们迁到内核真值，不能只保留两套执行器。

## 实际实现

- 共享任务创建/持久化契约加入 `studio_committee`，内核拥有创建、启动、暂停、预算、显式恢复和完成状态。选中的 context、claimIds、完整 statement、代码路径及范围、岗位和本地 model digest 冻结保存；不会伪造 JD 或混入父聊天资料。
- Host 从当前 owner/session/context 读取权威快照，而不是接受浏览器传入的完整快照。范围必须是 `studio-committee:<workspace>`、同 `rootScopeKey`；运行时沿用 Studio 固定的本地配置，同根有不同配置则拒绝。context/会话/期限/Host 代次及当前本地 digest 在派送前后和 current 读取时复核。metadata `binding()` 不生成内容。
- 提示和 grammar 提取为纯 `committeeModelRequest` Module；旧本地 Adapter 复用它，新内核直接调用现有 owner runtime Adapter，不调用 `LocalOllamaClient.complete()`。新增 `studio_committee` 模型 phase，原始完整 grammar 经 SDK 发送，不以 Zod 转换丢掉 `prefixItems/const/uniqueItems`。
- 每次实际模型发送、协议修复、源码 grant 解析、Broker 读取/重验，以及角色的冻结证据读取，都先把费用落到同一个根账。无效/未授权读取也计 toolCalls，不能用失败绕过额度。原根不足立即停止后续角色，不提高 ceiling 或另开 allowance。core 的协议循环上限不是额外预算。
- 四角色仍先独立，再做 red_team/advocate 交叉及最终 adjudicator。core 继续独立检查 claim、读过的证据、精确 hash/行号/引文和个人归属；模型一致意见不作为事实认证。未确认贡献仍为 unknown。
- 新内核路径的后续grammar允许在assessment与`request_evidence`间选择，完整目录中的其他句柄仍能回读，不再首8份后强制评价。已读引文grammar也去掉静默40条上限，保留所有精确合法已读选项；超出后续容量则明确失败。旧页面的首8份策略暂未替换，待caller迁移；本阶段不能视作所有类型的BM25/UTF-16 manifest验收。
- 完整实际 prompt、原 grammar 和原始回复保存在 owner 私有 journal；超出126,000 UTF-16单元的回复完整进入0600 artifact后拒绝，部分回复暂停。未截取输入输出，也没有自动采用、发布或 FactBase/简历写入。
- 明确恢复时，从冻结快照重新运行纯协议，只有 role/stage/round/turn/完整prompt/schema指纹一致的完整 wire 才本地回放，不再次发送模型。部分/失败的待完成发送必须再次计费；冻结证据再次实际读取也照常计费。报告中的 core usage 是协议步数，**task/root usage 才是跨恢复的实际调用权威**，不能把两者混作第二账本。
- 暂停或撤权后返回的完整回复也按原运行代次私有归档，但不恢复任务、不进入完成缓存、不被采用。源码改变会阻止继续使用旧冻结证据。
- 新 `GET /api/v1/agent/tasks/:id/committee/current` 在读取当前结果前重验授权/digest/源码；源码重验有实际工具费用。普通 task GET 仍可读历史，不代表历史结果仍可采用。

主要源码：`packages/agent-contracts/src/agent-task.ts`；core `career-intelligence/contracts.ts`、`committee.ts`；Host `kernel/studio-committee.ts`、`kernel/service.ts`、`kernel/model-protocol.ts`、`career-studio/committee-model.ts`、`career-studio/service.ts`、`tasks/http.ts` 和 `server.ts`。

## 验证范围

最终 **96 Host/core +21 Web +14 Desktop =131项通过**，0失败/取消/跳过。这里包含新增11项内核、3项真实认证HTTP、1项SDK grammar和1项超过40引文保留测试；不是131次真实模型推理。Contracts/Host/Web类型、Host构建、定向ESLint及完整 `pnpm desktop:build` 均通过，不宣称整仓全绿。

- 完整合成任务实际14次脚本模型、7次冻结读取、7个角色阶段，HTTP只建立1个owner Adapter，旧 Studio complete tripwire **0调用**。GET/幂等创建不产生新推理。
- 10份选定证据中，首8份后实际另读第10份，全文进入后续prompt：15次模型/57次冻结读取全部计同根。另一正例以50条已读精确行范围核对完整grammar，不再只保留前40条。
- 已有聊天根上限4，聊天先用1，委员会只再发送3次即停止；原聊天全文未进入委员会。无效冻结读取先计费，下一次读取在原 tool ceiling 前停止。
- 非JSON完整输出保留，修复不能逃过原根耗尽；本人显式增额后沿同任务恢复，不退还旧用量。部分输出及超大 artifact 恢复仅补未完成轮次：完整14步加1次已付失败，共15次实际模型发送。
- 停止后的迟到输出按 `late` 和原 generation 完整归档，任务仍 paused。撤权、digest变化、源码在派送中改变、异主、伪造scope及替代runtime均阻止采用/后续发送。
- core、旧Studio、已有五类任务、根账和采用组件邻接回归保留。**旧流程回归通过不是旧推理循环已经退役**。

首次HTTP夹具错误地期望异步启动200、异主context404；核对实际契约后分别改为202和`studio_context_stale`409，未放宽生产守卫。新增SDK测试的对象括号错误已修正后重跑。一次桌面glob用了不存在的`.test.ts`，该命令未执行；最终按实际`.test.cjs`运行14项。上述失败不计入通过数。

最终并行回归曾95/96：原有根时长400ms测试在没有模型派送的情况下已耗尽，断言要求先派送2次。其最小隔离6/6、全96项按文件串行重跑96/96。与并行构建/多组测试争用时间相符，但不把一次通过宣称为所有负载下无时序问题；未改生产计时、400ms预算或断言。失败原log和隔离/最终串行log均保留。

最终本轮日志及安装核验归档于 `output/agent-runs/committee-kernel-runtime-final-2026-11-12/`，16个成员和逐文件SHA manifest。较早的15成员目录是补回读前的阶段原件，未覆盖。真实模型调用为0；不使用个人资料或第二模型授权。

## 双端与安装资源

虽然没有修改Web页面，任务契约被Web消费，因此仍完整构建并可回退同步相邻 BetterMe.app。独立遍历 Web+main/preload 构建并集与安装包：**533文件，0差异**；回退副本亦单独重验。

- 安装DFS：`9eb74f029a4848cc89166b19880909b5b031784a000202d7c44a09720497e486`
- Web DFS：`84ef2669bc3421bacb21f5c4432e9d313ef4b44d85bbb570a3924e4d2cbc726b`
- 紧邻前版DFS：`ca130f824018cf658de9b7dbb8b0b2a5685d8d8d8cc87db65a04c69511b43de7`
- 回退：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-BNNoOT/previous-dist`
- 独立核验：上述归档中的 `installed-verification.json`。

同步成品实际 Electron34.2 main/preload/React启动和重开两窗口通过，3assets/4合成API读取/0真实服务或模型调用，exit0。GPU context警告未影响检查。这只证明成品可启动，不是委员会UI端到端验收。构建仍有既有Atlas Node外置化及大chunk提示。

原真实5173 PID90086、5179 PID89415只读核对仍在；没有重启它们或刷新用户窗口。源码链接Host在本人下次正常重启加载新实现；安装资源更新不表示运行中的Host已切换。真实简历/草稿/FactBase/凭据、旧Gold/候选/PDF及Git提交/推送未动。

## 下一步完成门

1. 迁移生产委员会caller和轮询/取消/明确恢复，实际推理只走tasks。旧committee入口随后退役，不能先禁用再把功能缺失算迁移。
2. 发布审阅、架构白板导入及历史只读投影接内核权威；使用新任务结果时，授权/源码重验亦计根账。不能把复制到Studio SQLite的completed记录当独立授权。
3. 补齐新类型BM25 Top-K/精确UTF-16 manifest的逐类验证、实际浏览器/Electron委员会完整流程及恢复验收，然后继续回放、harvester、隐私模型步骤和Coding Sandbox。多根/授权版本变化仍待。

简历写作质量仍有[44条源审](task-candidate-current-work-source-review-2026-11-12.md)中已定位的复制职责/遗漏项目问题；第二模型选择和同条件实测、最终R1–R8总审计均未完成。全目标保持active。
