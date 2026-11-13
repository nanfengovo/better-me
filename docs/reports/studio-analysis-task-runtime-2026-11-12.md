# Career Studio 五类分析归入统一任务内核

2026-11-12，`agent-os`。排版改写/审核、架构提问/审核、技能映射五类有界分析已成为真实 `studio_analysis` 任务。不是把旧循环包装成一次调用，也不表示整个 Career Studio 已迁完。完整目标保持 active。

后续停点：委员会新增Host内核执行/认证HTTP，前端及采用链尚待迁移；当前安装资源已被[委员会内核回执](committee-kernel-runtime-2026-11-12.md)中的9eb74f02…替换，本文ca130f82…为紧邻回退，以下安装资源是本阶段历史快照。

## 执行与权限

- 原 `createCareerStudioClient().request('/model')` 调用者保持接口，但执行改走 `/api/v1/agent/tasks`；旧 HTTP `/career-studio/model` 在认证后明确 410，旧服务方法也拒绝生成。布局和架构的实际生产适配器已覆盖，不只是手工拼任务。
- 新 kind 在 AgentTaskKernel 内创建、启动、持久化、暂停和显式恢复；稳定 `rootScopeKey` 必须匹配当前 Studio context 的工作区。同 scope 沿用原根 ceiling、累计用量及 owner runtime adapter，不创建独立本地生成器。已有根模型/配置不一致明确拒绝，不悄悄开根或换供应商。
- 固定本地 Ollama 配置及 temperature=0 是原 Studio 分析的选择，不是全局默认。创建、派送前、回复后及读取可采用结果时均验证 context/owner/session/hostGeneration/期限和所选本地模型 digest。目录绑定查询只读，不调用 `complete()`。
- 模型每次实际发送和格式修复均先 reserve 原根。无效回复原文先落盘，最多三次格式尝试且每次消耗原额度；不足停止。完整已完成结果在 GET `/:id/analysis/current` 再做当前权限/digest核验，旧普通归档仍可读，不能用浏览器已完成缓存绕过撤权。
- 有限 JSON contract 解码器只接受当前调用者实际使用的明确类型、object/array约束、enum/const等。未知 keyword、缺失 required 属性或非法结构在生成前拒绝，不丢条件。原完整 JSON schema 同时交给模型 grammar，避免 Zod 转换丢 enum/uniqueItems 等约束。
- 原始 payload 超过96,000 UTF-8字节明确拒绝；回复超过126,000 UTF-16单元完整保存私有 artifact 后失败。部分、无效、撤权后回复均按实际运行代次保留完整记录，停止后迟到结果不采用。没有裁短输入输出、自动采用或 FactBase 写入。

主要源码为 `packages/agent-contracts/src/studio-analysis.ts`、`agent-task.ts`，Host 的 `kernel/service.ts`、`kernel/model-protocol.ts`、`tasks/runtime.ts`、`tasks/http.ts`、`career-studio/service.ts`、`server.ts`，以及 Web 的 `services/studio-analysis-task-client.ts`、`career-studio-client.ts`。

## 定向验收

最终 **65 Web + 50 Host + 14 Desktop = 129 项通过**，0失败/取消/跳过。Contracts/Host/Web类型、Host构建、定向ESLint及完整 `pnpm desktop:build` 通过；不是全仓全绿或真实模型质量成绩。

- 新6项内核测试覆盖完整长输入/输出、严格contract、格式修复原根收费、原额度耗尽、撤权迟到、部分/超大全文及停止代次；没有提高预算或缩短原文使断言通过。
- 新5项真实认证HTTP测试调用生产client和实际布局/架构适配器，覆盖全部五purpose作为5任务共1根/1adapter/5次收费、先前聊天共根、异主/伪造scope、不同runtime拒绝、未知创建对账、幂等冲突、撤权和digest变化。旧 `Studio.complete()` 为会抛错的 tripwire，0调用。
- 配置模型协议测试独立核对SDK实际收到的完整原schema，保留 enum；错误phase在网络前拒绝。其他任务根、退役入口和邻接Studio测试继续通过。
- HTTP回归首轮暴露macOS `/var` 别名和错误代码转换的夹具/错误边界问题；改为真实canonical临时路径和明确的 StudioError→CareerTaskError 转换，未放宽生产权限检查。

完整日志已归档到 `output/agent-runs/studio-analysis-runtime-2026-11-12/`，附逐文件SHA manifest。它们是该实现阶段的测试，不因后续归档而成为新一轮测试。

## 桌面资源与当前权威

完成构建后已可回退同步相邻 BetterMe.app。随后独立遍历 Web + main/preload 构建并集，与安装包逐路径/大小/SHA 比较 **533文件、0差异**；回退副本也重新核对。

- 安装 DFS：`ca130f824018cf658de9b7dbb8b0b2a5685d8d8d8cc87db65a04c69511b43de7`
- Web DFS：`09d12fe16e31a23e06c5243e2456a0caaaa96b9dddd5458e9b447cebe4e57047`
- 紧邻前版：`9212849fe1ebe892aa93af3cfd0ad170c9cf6c8f561f8e7a53cbc1325159ca72`
- 回退：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-OwlY14/previous-dist`
- 完整独立核验：`output/agent-runs/studio-analysis-installed-verification-2026-11-12.json`

已同步成品的隔离 Electron 34.2 main/preload/React 启动及两次开窗通过，3 assets/4合成API读取/0实际服务或模型调用。完整smoke日志亦归档。它是成品启动检查，不是五类分析的完整浏览器/Electron操作验收；五类链路当前证据为生产调用者的真实认证HTTP。

没有重启用户原5173/5179服务或刷新原窗口；源码链接Host在下一次本人正常重启时加载新实现。当前只读收尾没有再次替换App。未操作真实简历/草稿/凭据或提交推送。

## 仍未完成

委员会、回放、harvester及隐私模型步骤、Coding Sandbox仍有独立执行路径；须逐次迁移内部模型与工具收费，不能以本报告宣布全入口只剩tasks。Studio暂停/中断的显式恢复接口已在client，但新的统一恢复交互和完整双端使用流程仍待验收。根配置指纹也不等于所有历史任务均已独立认证实际权重版本。

简历质量最新证据看[44条v7源审](task-candidate-current-work-source-review-2026-11-12.md)，不同模型和有限周期看[比较回执](resume-campaign-comparison-2026-11-12.md)。真实第二模型授权、写作改进、其余入口和全目标总审计未完成。
