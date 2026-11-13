# 来源归属守卫与真实v6反例验收

后续当前资源/回退及候选v5/Eval v7停点见[进行中工作保留回执](task-candidate-current-work-2026-11-12.md)。本文全部批次原件、分数和hash是有效历史证据，2afc50e0…已是紧邻前版资源，不再作为当前安装权威。

2026-11-12，`agent-os`。从“报告提示错挂”推进到“候选进入回复前阻止明确的来源归属冲突”。**生成端守卫已实跑生效，简历质量仍未整体过关，完整目标继续active。** 未使用或改写个人简历/FactBase/凭据，没有提交、推送、下载模型或云推理。

后续离线操作者源审已另存：全22条20支持2错引，成功18条仅3明确源内结果/4目的，原四回执SHA不变；见[完整源审回执](task-candidate-source-review-2026-11-12.md)。它不是外部人工认证，不改本批次分数或失败状态；本文保留v6来源归属守卫的历史验收，当前资源以上方v7回执为准。

## 根因与修复边界

- 实际反馈环：`pnpm exec tsx --test apps/agent-host/tests/resume-candidate-attribution.test.ts`。先用原v3契约在生产内核复现两次：X-ray学术正文选合法Amazon实习句柄，任务却为awaiting_answer；期望拒绝的断言连续失败。最小案例保留两个来源单元及实际任务持久化，不依赖模型随机性。
- 根因：动态schema只证明同组句柄合法，未校验正文所来自的来源；离线editorial提示没有进入生成验收。修复为显式 `resume_candidate_v4` / Eval v6；旧v1–v3 Host策略及v1–v5评测按原版本保留。
- `reviewResumeCandidateAttribution` 对完整正文做NFKC/大小写/空白规范比较，仅忽略句末标点，不删内容词和限定语。完整措辞只在未引用单元出现、而不在任一所引单元中时，形成可审阅冲突；同组错引单元也检查。学术/培训/个人项目来源全文/hash/kind保留，不成为合法工作句柄。
- Host先保存完整wire，再记录 `candidate_source_attribution_conflict` 和完整匹配来源，沿同根预算给模型修复上下文；不更换引用、移动主张或编造结果。一次额度用完即停止，无隐藏调用。未知句柄仍先由原schema拒绝。
- 无冲突不等于有据或质量合格：改写、混合句及部分来源限定丢失可漏检。该守卫是有限的来源冲突门，不是语义裁决或就业事实认证；必须继续独立语义/STAR和完整性审阅。
- 新冻结器对v6再运行同版守卫；伪造已接受任务不能绕过。报告仅对v6从已核验原记录投影完整 `candidateRejections`，同时显示候选拒绝与最终停止原因；旧回执字节不变。

## 全量旧输出回放

对v5权威冻结包逐份重建/hash核验，全部5例/31条完整正文送新守卫，检出原3处研究挂实习，仅数据工程1例有冲突；其余28条不被该窄规则阻止，不代表事实批准。0新模型调用，原标签/分数/wire/PDF均不改。

完整回放：`output/agent-runs/resume-attribution-guard-v6-replay-2026-11-12.json`。旧v5 collection另独立重建到 `/tmp/betterme-attribution-v6-vamZQj/old-v5-rebuilt/`，receipt SHA仍 **e08f6f91ddc11bd3fd5a6e688fcbe64fd6c5af69231ce61559430817496b00d4**；原quality receipt仍 **ffec18f16775fad0a0967c721d19ef14e34736a3121b57bea93017c29a42ad4b**，未重打印旧PDF。

## 新五例真实运行

campaign **local-cf65597d98dd26f0**；原件 `/tmp/betterme-attribution-v6-vamZQj/run`，日志同级 `collection.log`。正常认证tasks/生产resolver/隔离身份，模型 `betterme-eval-gemma4-e2b-ctx65536-20261112:latest`，digest **079c2aeeda6f9d859a9d7ed7ca09892af4eaf82bd8d9136966f7afaae0ceff0c**。同前轮权重，不是第二模型。

完整提示/动态grammar/模板/system及8192保守余量需求最大48571，配置/实载65536，前后原件已重核。每例原上限1模型/1工具/300000ms；实际5模型/0工具，4可冻结/1失败/0未决，0云端、无额外重试，自有Host已关闭。

| 案例 / 原任务 | 结果 | 正文条数 | 总JD覆盖 | 保守事实核准 | STAR字面结构 | 实际A4 / 垂直占用 |
| --- | --- | --- | --- | --- | --- | --- |
| backend / ct_cdb3b6b9fcea136faf8541532bb44bd5 | frozen | 4 | 2.33% | 25% | 56.25% | 一页 / 0.4882 |
| data-engineer / ct_6a77c8fdc03ed7a37496554ab5271ccc | failure | 原wire4条，不交付 | null | null | null | 无成功PDF |
| frontend / ct_c947108e507d8d840f7a075c74488e8e | frozen | 5 | 0% | 0% | 25% | 一页 / 0.4872 |
| fullstack / ct_a666fcad9ad848b61467ab15730da50f | frozen | 4 | 0% | 50% | 12.5% | 一页 / 0.4623 |
| sre / ct_15332eba3dc2702fc4923cf46cd7528f | frozen | 5 | 0% | 0% | 30% | 一页 / 0.4243 |

成功候选共18条/18有效引证、0无效坐标；不是18条事实认证。原规则/Gold标签未为候选改写放宽。全栈无完整支持要求，有据JD分母仍null；未知改写保守0分不等于全编造。不同协议不混比质量改善或最佳模型。

### 拦截证据及仍在的问题

- 数据工程bullet-3再次把EoR/CDAE研究配item-19 Amazon实习；守卫匹配item-14 academic并拒绝，原额度耗尽后终止 `model_call_budget`。报告保留二者而非只显示预算。原wire/问题/完整来源仍在失败归档，四轴null，不生成成功PDF。
- 同份失败输出bullet-4将low-frequency radio模拟研究改写为“as part of Research project C”，仍配item-19。完整item-12 academic/item-8 personal可核对，但非完整措辞匹配，守卫未单独命中；这说明改写的语义错挂仍须下一步处理，不能宣称已彻底防幻觉。
- 本轮后端选work-0/1/2/3，明确日期顺序不再出现上一例倒置，但仅单次观察、不是稳定遵循证明；仍复制角色前缀、偏疏。前端仍省略全部work组，SRE省略work-1，全栈职责偏通用/项目描述冗长。
- 四份实际全部页A4已渲染提取并逐份目视：无缺正文/孤题/越界/裁切，仍明显偏疏，不当优秀投递稿。PNG为 `tmp/pdfs/attribution-v6-2026-11-12/`，个人原稿/候选PDF不变。

## 当前归档与双端

- 唯一v6全计划目录：`output/agent-runs/resume-quality-local-guard-v6-2026-11-12/`，181个manifest文件逐大小/SHA通过；4成功PDF/完整输入/失败wire/源/私有成员/容量/诊断齐全。质量receipt SHA **50da570e8add320df8b8cf16c421a7f8508e17e118ca154c4f4dcef393159116**，collection SHA **83cd79a918fe6f17d6566c9eb7702a33f73a8150c7a08ed523f87b90089f2599**；独立核验 `/tmp/betterme-attribution-v6-archive-verification.json`。
- 最终106 Host/Eval +14 Desktop共120项通过（不是全仓）；完整实际HTTP三条原错挂→拒绝→同根修复/全文回执、单额度不重试、同组错引、重复真实支持、历史v3不升级、新冻结防绕过/失败保留均覆盖。最终 `/tmp/betterme-attribution-v6-final-regression.log`、`-desktop-tests.log`。中间恢复夹具曾因两个同时writer失败，先关闭原kernel后重开已修正，未放宽生产单writer。
- Contracts/Host/Web类型、Host构建、定向ESLint零警告、完整 `pnpm desktop:build`通过，日志同前缀 `-contract-types/-host-types/-web-types/-host-build/-final-lint/-desktop-build.log`。
- 安装533资源与构建逐路径/大小/SHA零差异；DFS **2afc50e0397b1ac3a71c208607b9bbc40d3262e974c9c4aa34590dfd90b774ac**，Web **f7cf6ed3b27285187eaaef924a811398ad48ee0500bac84ea2d89102ee2b130c**，独立排序 **46c74def22bbe4597dc110dea2ff4a9c157cbcb2ba692c70bfc83afa395cff51**。`/tmp/betterme-attribution-v6-sync.json` / `-installed-manifest.json`。
- 完整可回退前版：`/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-vFh2jk/previous-dist`，旧42da04e1…保留。成品main/preload/React离线两窗口退出0，3assets/4合成读取/0实际服务或模型调用，`/tmp/betterme-attribution-v6-installed-smoke.log`；profile `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-cVygnj/summary.json`。GPU诊断非失败。
- 原5173 PID90086、5179 PID89415仍在，无重启/刷新真实窗口；source-linked Host下次正常启动加载源码。真实草稿/简历/FactBase/凭据和dirty改动保留，未stage/提交/推送。

## 下一完成门

独立语义/STAR（尤其改写错挂）、近期任职完整性、不同第二模型同条件比较和实际周期运行、Gold领域代表性、历史多根/资料授权变化及最终全目标审计仍待。现累计七批35次同权重，不作多模型或周期已完成。先保留源审依据和未决事实，不靠改标签/强制加指标提升分数，不默认下载、cloud或复制账号凭据。
