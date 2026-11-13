# 来源绑定候选与真实 v4 评测

后续安装资源已更新：当前成品/回退及旧账接手验收看[历史关联回执](task-scope-association-2026-11-12.md)。本文v4实际质量、完整归档与候选协议仍为该批权威，533资源2b0a7502…一段仅为当时快照；本轮关联合成测试不算新增真实模型评测。

2026-11-12，`agent-os`。**来源句柄/精确坐标契约已接通并实测，不等于简历写作质量或完整目标通过。** 本轮5次真实本机调用，4份可冻结、1份300秒超时；20个解析引用均有效。内容仍有JD冒充经历、引用范围不符、过度抽取和低覆盖问题。独立语义、第二个不同实际模型、周期及历史接手/总审计仍待。真实资料/FactBase/凭据/草稿/窗口及原服务不动，未提交/推送。

## 固定契约与原执行链

- 固定可选 `responseContract:"resume_candidate_v2"`，以 `candidateSource:{messageId,sha256}` 绑定唯一用户消息的完整内容摘要；读取该消息JSON的 `.material`。缺少绑定、角色/身份歧义、原文/hash变化、重复来源身份在派送前拒绝。它不授予文件读取或业务采用权限。
- Host选择 `resume_candidate_bound` phase。共享契约按实际caseId、可渲染组和同组证据ID建立动态schema；配置/原生/账号adapter均沿原单实例/根预算传递当次来源，不缓存上一案例schema。不接受任意caller schema或从资料文字切phase。
- 模型直接返回 `{schemaVersion:2,caseId,bullets:[{id,text,evidenceIds}],questions}`。Host把明确选择的**完整证据单元**解析为原有组、源hash及精确UTF-16半开区间 `0..text.length`。未知/跨组/重复句柄拒绝；不让模型猜组或坐标。非交付组的完整来源仍在输入，完整wire/修复/问题/根成员均留存，不裁剪。
- Eval升为 **resume-quality-task-candidate-v4**。这是新契约的约定投影，不是冻结器修复旧错引证；v1/v2/v3仍按原目标、完整材料和wire重建。独立质检继续核对无据名词/数字、未知改写和JD证据资格；有效句柄不是事实核准，不写FactBase或采用简历。

## 实际本机批次

生产 `createAgentServer` / 默认resolver / 正常认证tasks HTTP，全新隔离身份，无脚本reasoner或凭据复制。原目录 `/tmp/betterme-bound-v4-OT8QQ4/run`、日志同级 `collection.log`，campaign **local-8545b99a931efbd9**。

模型 `betterme-eval-gemma4-e2b-ctx65536-20261112:latest`，digest **079c2aeeda6f9d859a9d7ed7ca09892af4eaf82bd8d9136966f7afaae0ceff0c**。与此前Gemma同权重，不是第二模型；零云端调用。容量守卫含完整动态schema/来源/协议/template/system及8192保守余量，最大需求44520，明确及实际65536；前后catalog/show/ps全文保留。这不是精确tokenizer或提供商全量处理的签名证明。

| 案例 | 原任务 | 结果 | 实际活动毫秒 |
| --- | --- | --- | --- |
| backend | ct_d57045eac8a67d0e461751c013d706e3 | frozen | 43124 |
| data-engineer | ct_08fd6d866c9e7ca091e21c5331c85d57 | failure / active_time_budget | 300000 |
| frontend | ct_c9dd70cf99c367385e3d3ceae9ee5612 | frozen | 52629 |
| fullstack | ct_733c06ae08e824a437ee539beb260dbb | frozen | 34480 |
| sre | ct_8afbd58140b4ed76b78345d16723df93 | frozen | 45993 |

每例恰好1次模型、0工具，上限1模型/1工具/300000ms未变；未决0。数据工程未收到完整回复，不捏造空白候选或部分输出，不扩大预算/重建根重试。采样句柄7788已终止0，自有Host关闭。加历史四批共25次同权重不同配置/协议，不作不同模型或公平同条件排名。

## 全分母质量与实际 PDF

完整报告 `output/agent-runs/resume-quality-local-bound-v4-2026-11-12/`：`collection/`保留全部5例，`quality/`保留4份真实候选PDF/metrics，根 `quality-receipt.json` / `report.md`含失败/null分。181个manifest文件独立逐大小/hash核对通过。

- quality receipt SHA-256：**2bfb505f57fd6629e9efe2e343bb12fd77c22ef6612055f96dc638392d5d73cb**。
- collection receipt SHA-256：**823d87192a19df60abed7ace16dd8c4e2433e1b04036df784a8d54dcca5b2d69**。耐久归档独立重建至 `/tmp/betterme-bound-v4-OT8QQ4/v4-rebuilt` 后哈希一致、0推理；诊断同级 `{quality-report.log,archive-verification.json,v4-rebuild.log}`。
- 旧v3/v2也独立重建至同级 `old-v3-rebuilt` / `old-v2-rebuilt`，原receipt哈希52a5366e… / 89bf7ad0…不变，旧失败未改写。

| 案例 | bullet / 有效引用 / 无效引用 | JD覆盖 | 保守事实核准 | STAR字面结构 | A4 / 垂直占用 |
| --- | --- | --- | --- | --- | --- |
| backend | 2 / 2 / 0 | 0% | 0% | 87.5% | 一页 / 0.2476 |
| data-engineer | 无完整候选 | null | null | null | 无PDF |
| frontend | 7 / 7 / 0 | 0% | 0% | 28.57% | 一页 / 0.5961 |
| fullstack | 5 / 5 / 0 | 0% | 100% | 20% | 一页 / 0.2406 |
| sre | 6 / 6 / 0 | 13.89% | 83.33% | 29.17% | 一页 / 0.4972 |

STAR仅为来源标注的字面结构筛查，不是事实核准。后端两条均待独立审阅，0%不是判定两条都编造。全栈完整抽取可获事实核准，但覆盖0、STAR低、重复职位前缀且明显过疏；其 `automaticChecksPassed=true` **仅表示事实/排版两项通过，不能作为完整四轴或优秀简历通过**。格式接受率80%也不是质量分。

实质反例及下一质量门：

- 前端bullet-1声称开发GitLab产品；其有效句柄work-0仅是Android开发职责。质检指出无据GitLab、待语义复核，不给事实/JD覆盖信用；新增回归重放这一实际失败，确保有效句柄不能将JD职责升格为本人经历，原输出不修。
- SRE首条把跨经历概述放在当前雇主下，只引该雇主原文；质检指出引用中无据的Kubernetes/SRE/CI/CD。不能因别处出现这些词就替该引证补证。
- 后端仅2条、近期经历欠覆盖及顺序欠佳，全栈仅通用职责；不能通过少写实现一页后称作完整优化。

4份实际PDF全部页使用正式模板打印、Poppler渲染并逐页目视：正文无缺失、无孤题/水平溢出/裁切，内容问题如上。图片 `tmp/pdfs/candidate-bound-v4-2026-11-12/{backend,frontend,fullstack,sre}.png`。PDF在完整报告的 `quality/`，**仅评测不可投递，不是用户个人简历**。

## 验证与当前安装权威

- 最终 **105/105 Host/Eval + 14/14 Desktop**。日志 `/tmp/betterme-bound-v4-final-regression-serial.log` / `/tmp/betterme-bound-v4-desktop-tests.log`。覆盖绑定/Unicode/错hash/歧义/跨组/重复、原账修复、各adapter当次schema、完整wire、独立语义拒绝、v1–v4重建及全分母归档。
- 初次103项通过；增加容量回归的并行复跑有1项采样/报告测试触达30秒超时，日志 `/tmp/betterme-bound-v4-final-regression.log` 保留。实测结束后按原30秒门槛、并发1重跑105项全通过，无放宽断言/门槛，不把超时轮报成全绿。
- Contracts/Web类型、Host构建、定向ESLint `--max-warnings 0`、完整 `pnpm desktop:build` 通过。日志 `/tmp/betterme-bound-v4-{contract-types,web-types,host-build,lint,eval-final-lint,desktop-build}.log`；既有Vite大chunk/Node外置化提示保留。
- 独立逐路径/大小/SHA-256：预期533、安装533、差异0。当前DFS清单 **2b0a750246868fa30d1a67d149a7bef46813f96c5e782d2fb0eb54b0d66fc556**；Web **30f5aa0bd831288b08c2eafa2f2cd9d81d9f079ab9c19cd37a204a71f6e60e28**。
- 紧邻前版a93e1c46…完整回退 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-zdTxkg/previous-dist`；核对 `/tmp/betterme-bound-v4-{sync,installed-manifest}.json`。
- 安装Electron34.2 main/preload/React独立profile两窗口重开通过，3assets/4合成读取/0实际服务模型调用；`/tmp/betterme-bound-v4-installed-smoke.log`，profile摘要 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-okZEmy/summary.json`。GPU提示未阻止通过，不冒称正式账号业务链。
- 原5173/5179服务及真实窗口未重启/刷新，源链接Host需本人下次正常启动才加载新代码。未stage、提交、推送、切分支或清理dirty worktree。

## 后续完整目标

继续独立语义、事实限定语/完整性及JD定向写作；第二个不同实际模型同五例/材料/协议/模板/原根上限比较、含失败综合报告及周期实际执行仍待，不默认cloud或复制账号凭据。历史无scope显式关联、资料/授权变化、中断接手、剩余推理路径和R8成品总审计继续。整体active，不以本轮契约/局部绿测替代全部完成。
