# 统一 tasks 批量采样、失败回执与本机实跑

2026-11-12，`agent-os`。本阶段是 R5/R6 的真实运行进展，不是全部目标完成、真实多模型排名或已调度周期评测。本阶段生产 Web/Host 执行逻辑和安装包未改；后续直接候选契约/v3实跑/完整分母质量报告与当前资源见[直接候选回执](task-direct-candidate-2026-11-12.md)。下方三批15次、v1/v2与39项保留原历史证据，不当作最新累计或当前安装状态。

## 实现与边界

- `evals/resume-quality/collect.mjs` 只通过正常认证的 loopback `/api/v1/agent/tasks` 创建、启动和观察；不另调 SDK、旧 Facade 或 provider API。完整 allowlist 材料、预算、模型元数据、创建/启动意图及原任务 ID 先落盘，运行时凭据仅在内存。每例独立逻辑工作区/原根，固定同一 ceiling；同 runtime 的五例复用一个 adapter，修复仍计原根。
- 创建回执丢失只读核对，不自动启动；启动回执丢失只观察原 ID，不第二次 POST。短暂观察错误继续原句柄，观察期限到达标为未决、最终用量未知，不把它当终止或失败。相同 campaign 已有任务时拒绝另开输出目录重跑。
- `freeze.mjs` 新增完整失败归档/重建，保留全部原始 wire、非法修复、部分输出、overflow artifact、源材料与原根成员，允许派送前零调用/无 runtime generation 的已停止记录。错误候选不转为一份空白成功稿，不在导出时补 group、引证或数字。
- `collection-report.mjs` 离线重核完整计划、每例 owner/原任务/工作区、材料 hash、模型/预算与累计账，并完整复制成功/失败包。遗漏样例、改账、改候选、改文件或覆盖报告均失败。所有失败仍在分母；格式接受率不是事实合规/STAR/写作质量分，失败不伪造四轴成绩。
- 候选协议 v2 将“目标已选定、交付严格候选 JSON”加入显式任务 objective。v1 继续按原目标、原材料、原 hash 重建，不能把 v2 与 v1 当同条件模型比较。

## 本机有效上下文风险与修正

首次实际运行后，只读 `/api/ps` 观察原模型有效上下文为 **4096**；`/api/show` 的训练最大值 **131072** 并不等于实际加载容量。完整五组生产提示的保守字节上界守卫需要约 **44.3k** 容量；这不是精确 tokenizer，也不能仅凭该上界断言每例实际丢了多少 token。因此首批不能用来给完整材料写作能力下结论。

按 [Ollama 官方兼容说明](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)，兼容接口不能直接设置上下文；[创建 API](https://docs.ollama.com/api/create) 支持基于现有模型指定参数。已仅从现有 `gemma4:e2b-it-qat` 权重创建独立配置 `betterme-eval-gemma4-e2b-ctx65536-20261112:latest`，参数 `num_ctx=65536`，没有下载权重、覆盖原模型或修改全局服务。新配置保留在本机，原配置和 cloud 别名未变；它与原模型是同一套权重，不是第二个模型。

`ollama-context.mjs` 只读核对 catalog/show/ps，使用完整生产 free_chat 提示 UTF-8 字节上界、完整模板/系统和8192余量；未知、cloud、训练上限过小、显式/加载容量不足都失败。`collect-ollama.mjs` 在任何推理前检查，逐例启动前/完成后再次检查并保存全文；固定每例模型上限1，避免自动格式修复追加完整旧输出后绕过初始容量守卫。它不自动创建配置或调整服务。

实际只读反馈环：

```sh
node --import tsx evals/resume-quality/ollama-context.mjs evals/resume-quality/gold/v1 gemma4:e2b-it-qat
node --import tsx evals/resume-quality/ollama-context.mjs evals/resume-quality/gold/v1 betterme-eval-gemma4-e2b-ctx65536-20261112:latest
```

第一条退出1（4096/保守门槛44296），第二条退出0（显式65536）；完整原件在 `/tmp/betterme-quality-local-vCjemc/context-probe-{red,green}.json`。后续实际加载的 `/api/ps` 也为65536，不只依赖参数声明。容量守卫不能证明模型语义注意力或提供商逐 token 处理，生产其他入口的上下文能力总审计仍待。

## 真实运行结果

均为隔离新账号、正式 `createAgentServer`、默认生产 resolver；没有注入 reasoner、复制真实账号凭据、调用第二套执行器或使用真实个人简历。总计 **15 次本机模型派送、0 云端调用**，不是15个模型或两模型成绩。

| 批次 | 条件 | 实际结果 | 使用限制 |
| --- | --- | --- | --- |
| 首批 | 原模型、v1、每例 ceiling 3，实际各1次；随后观察有效4096 | 5例均 invalid_candidate | 容量风险诊断，不能作完整材料质量结论 |
| 容量修正 | 同权重独立65536配置、v1、每例上限1 | 5例均 invalid_candidate | 完整保留容量守卫/前后原件；不生成虚假质量分 |
| 明确目标 | 同65536配置、v2、每例上限1 | 5例均 invalid_candidate | 部分仍反问目标或输出非法/错误结构 JSON；保持失败，不替模型修稿 |

因此当前只能证明“真实采样与失败归档链可工作”，不能证明这个小模型适合严格结构化简历生成，更不能宣称简历效果提升。容量修正不是唯一因素；v2 也未达到有效候选门。没有有效新候选，故本阶段不制造新的候选 PDF；此前合成/抽取 PDF 和个人正式候选原件保留。

仓库忽略的完整产物：

- `output/agent-runs/resume-quality-local-capacity-risk-2026-11-12/`：首批完整失败回执，无容量保证。
- `output/agent-runs/resume-quality-local-context-v1-reviewed-2026-11-12/`：v1五份完整失败与前后容量原件，`capacityGuardVerified=true`。
- `output/agent-runs/resume-quality-local-protocol-v2-2026-11-12/`：当前v2五份完整失败与容量原件，`receipt.json` SHA-256 **89bf7ad081270251a24890a064b2067d2748b52d93d6a8e6c0fcdd9d9d0a8563**。

原临时 Host 私有记录、三轮完整日志/目录仍在 `/tmp/betterme-quality-local-vCjemc/`；不是默认用户存储。回执复制的是任务/公开Gold与容量数据，不复制账号数据库或登录 cookie。离线从已归档 v2 重建的独立目录为 `.../reconstructed-v2`，不需要再派送模型。

## 验收

- 最终 `pnpm test:resume-quality` **39/39**、0跳过；日志 `/tmp/betterme-collector-package-delivery.log`。
- 按根 CI 的 tsx/tsconfig/TAP/concurrency=4 形状，完整 Eval 集 **39/39**，日志 `/tmp/betterme-collector-ci-delivery.log`。不与历史31/35/38项相加，不宣称全仓测试全绿。
- 本阶段新增8项/扩充原测试覆盖：真实认证HTTP五例、单adapter/原根修复计量、完整非法/overflow、丢失回执、短暂观察失败、活任务观察到期不重启/不假定终止、owner/原ID/材料/账与完整分母重建、旧v1继续重建、新v2目标、实际容量与训练上限区分/cloud拒绝。定向 ESLint、MJS语法与 scoped whitespace 检查通过，日志 `/tmp/betterme-collector-lint-delivery.log`。
- 没有生产 Web/Host 执行逻辑或 App 更新，因此未做无关双端重建/替换。真实资料、FactBase、原PDF、窗口、原服务、共享凭据及其他 dirty worktree 保留；无提交/推送/新分支。

## 下一完成门

1. 保持完整来源和严格事实校验，改进可执行的候选交付协议并取得有效真实候选；不能通过放宽字段、补引证或只选成功样例完成。
2. 明确第二个不同实际模型/运行时，再在同五例/完整材料hash/协议/模板/根上限下比较；同权重配置或不同协议不充当两模型。当前未启用 cloud 别名或默认付费比较。
3. 合并成功质量与失败/未决率的完整多模型报告、独立语义/STAR裁决和实际周期执行；当前只是显式本机采样与离线回执，没有设置后台定时模型任务。
4. 历史无scope显式关联、资料/授权变化与中断接手、剩余调用路径和整个R1–R8审计仍未完成。完整目标继续 active。
