# 直接候选契约、全计划质量报告与本机实跑

2026-11-12，`agent-os`。这是 R5/R6 的工程及真实运行进展，不是全部 R1–R8 完成、优质简历交付或多模型排名。本文保留v3历史批次；当前v4契约、105+14项、4可冻结/1超时及533资源/回退权威改见[来源绑定回执](task-source-bound-candidate-2026-11-12.md)。下方资源与下一门是本阶段历史快照，不再当作当前状态。

## 已落地的接口

- `FreeChatTaskCreateSchema` 可明确声明 `responseContract: "resume_candidate_v1"`，该固定契约随任务持久化并进入原始输入/来源指纹。不接受任意用户 JSON Schema，资料文字也不能切换 Host phase。未声明的普通聊天继续原协议和原来源 hash，不自动迁移旧历史。
- 候选 schema 从 Eval 移至 `packages/agent-contracts/src/resume-candidate.ts`，Host 和冻结器共享同一结构。选定任务由内核派送 `resume_candidate` phase，配置模型使用直接对象 schema，原生/账号运行时沿既有 adapter 收到相同 Host schema；没有新 SDK 或独立执行循环。
- 候选提示只负责已选 JD 的只读交付，不混入普通顾问起始引导。完整授权会话、原始来源、预算和历史观察保留。错误 envelope 由内核拒绝；后续修复仍先扣原根账，上限1时明确停止，不另开根补调用。
- 成功 `reply.content` 是完整直接 wire，保留首尾空白/CRLF，不重新 JSON.stringify。原始错误、partial 和 overflow 继续原机制完整留档；传输未完保持暂停，显式停止挡迟到结果，重开不重放。结构有效不授予事实认证、资料共享、业务采用或写入 FactBase。

## v3 与完整分母报告

`freeze.mjs` 当前协议为 `resume-quality-task-candidate-v3`，请求必须带上述固定契约、直接对象和新 objective。v1/v2 保持各自原材料/目标/外层聊天 wire 的重建规则，不默升、不混作同条件成绩。原 v2 真实失败归档用当前代码离线重建，receipt SHA-256 仍是 **89bf7ad081270251a24890a064b2067d2748b52d93d6a8e6c0fcdd9d9d0a8563**。

`reviewCollectionQuality` 集成到已有 `collection-report.mjs`：先核对全部计划和每例成功/失败归档，再仅对可冻结候选运行既有四轴及正式模板打印。失败/未决仍进入总分母，四轴为 null；条件均值明确只覆盖可冻结样本。全失败/未决不造空白成功 PDF、零用量或质量分，不进行推理/恢复/采用。所有输入、失败、原始输出、PDF、metrics 均保留并列完整字节/hash清单。

```sh
node --import tsx evals/resume-quality/collection-report.mjs DATASET CAMPAIGN NEW_REPORT_DIR EXPLICIT_CONTEXT_DIR --quality
```

旧的不带 `--quality` 命令仍只生成原采样回执。容量核对按任务实际契约选择完整生产提示/phase，训练最大值不充当有效上下文；单次采样、cloud 拒绝及不截取材料的规则不变。

## 本轮真实运行

正常认证 HTTP tasks、全新隔离账号、正式 Host/default resolver、现有本机同权重 65536 配置；每例上限1，预算相同，完整前后容量记录通过。没有复制真实账号凭据、调用 cloud、下载模型或重跑旧 campaign 清账。

- 模型：`betterme-eval-gemma4-e2b-ctx65536-20261112:latest`。
- 声明 revision：`079c2aeeda6f9d859a9d7ed7ca09892af4eaf82bd8d9136966f7afaae0ceff0c`；同原 Gemma 权重，不是第二个模型。
- campaign：`local-2164ef0f18fcfaf9`；原件 `/tmp/betterme-candidate-v3-CXfXCl/run`，完整日志同目录上层 `collection.log`。自有 Host 已正常关闭，进程句柄74497退出0。
- **5次本机派送、0云端**。5例均形成直接 schema 可解析的完整回复；1例通过冻结的来源组映射，4例被严格拒绝，不修组名、不合并重复组或补引证。

| 样本 | 原任务 | 冻结结果 |
| --- | --- | --- |
| 后端 | `ct_67312e8bd101b0f414e78dbbb5dc4c80` | 可冻结，仍须独立质量检查 |
| 数据 | `ct_bb597da476eb8ab155919ffb18470708` | 未知经历组，失败 |
| 前端 | `ct_c01992cd42dd69f37e770a11a3caaf51` | 未知/重复经历组，失败 |
| 全栈 | `ct_7c1421a229bca0ab09cdb7ca7ff35f22` | 未知经历组，失败 |
| SRE | `ct_6c7cce0e8e218e17d97cfdf5797648f0` | 未知/重复经历组，失败 |

全部失败代码为 `candidate_group_unknown_or_duplicate`。数据例包含未列为可渲染组的 profile/skills/education 等；前端/SRE也把同一组拆成重复条目。原模型回复全部保留，不在导出器里替其纠正。

完整质量回执：`output/agent-runs/resume-quality-local-direct-v3-2026-11-12/`。总计划5、可冻结1、失败4、未决0，交付接受率20%，**不是写作质量分**。100个列明文件重新核对字节/hash通过。`quality-receipt.json` SHA-256 **d5d5db9ddf586b10e31292a0082c09400cecd39125e43f921da25a9b5627882c**。

从耐久归档 `collection/` 及其 `runtime-context/` 独立重建到 `/tmp/betterme-candidate-v3-CXfXCl/v3-rebuilt`，不再派送；新旧采样 receipt SHA-256 同为 **52a5366ea42de1f11a054ef8227da2f7b0ee0f783f1a9a9cb4973974cfa4a8c2**。

### 后端真实 PDF 与质量边界

正式模板打印全部页为A4一页，6条正文无缺失、无孤题/水平越界，实际文本垂直占用0.6001。Poppler渲染图片 `tmp/pdfs/candidate-direct-v3-2026-11-12/backend.png` 已目视：没有裁切/重叠，原日期精度保留；正文仍带模型写入的 Source 标签，不作为优秀表达范本。

JD覆盖/保守事实核准/STAR均为0，**不等于独立判定全文编造**：逐条原件核对发现6个来源hash正确、quote均等于对应完整原文，但坐标一律是示例的 `start:0,end:1`，实际quote长度136–231，所以6个引证都无效。规则不给事实/STAR信用，也不自动补正确end。语义改写本身仍需独立复核。

PDF仅评测留样：`output/pdf/Gold_Backend_Local_v3_仅评测_不可投递.pdf`，SHA-256 **c3fd092b1f326d9a0941f312874eb9f8e45635563d8e72d279a5104e14030c87**；与完整报告内PDF逐字节相同。这不是用户个人简历，也不替代此前正式候选。

## 验证与当前桌面资源

- 最终 **98/98 Host/Eval**：7条专用候选契约测试及普通聊天、原生/配置/账号runtime、认证HTTP、项目/根内核和完整Eval集；日志 `/tmp/betterme-candidate-v3-delivery-regression.log`。覆盖完整wire、错误schema、原账修复/单次上限、来源文字不切phase、partial/reopen/迟到、v1/v2/v3重建与成功/失败/未决的完整质量报告。不是整仓全绿或真实模型质量通过。
- **14/14 Desktop**，日志 `/tmp/betterme-candidate-v3-desktop-tests.log`。Contracts/Web类型、Host构建、定向ESLint和完整 `pnpm desktop:build` 通过；日志 `/tmp/betterme-candidate-v3-{contract-types,web-types,host-build,final-lint,desktop-build}.log`。Vite大chunk/Node外置化提示保留，不称零警告。
- 可恢复同步并独立逐路径/大小/SHA-256核对：预期533、安装533、差异0。当前安装 DFS 清单 **a93e1c46b395a97a60a38c09724a249501328fb0f267b543f796aa88d13a9ff1**；Web清单 **78b13561f25a982cf8ab59a9ab9380ff81680b18fa17fcbde3371ffb2a6a2829**。
- 紧邻前版清单 c22309e2…，完整回退 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-raAT2Z/previous-dist`。同步/独立核对 `/tmp/betterme-candidate-v3-{sync,installed-manifest}.json`。未重启用户原Host或刷新真实页面；源链接Host的下次正常启动才加载新代码。
- 安装成品离线 main/preload/React 两窗口重开通过，3 assets/4合成读取/0实际服务或模型调用；`/tmp/betterme-candidate-v3-installed-smoke.log`，独立profile摘要 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-qKbtBa/summary.json`。GPU提示未阻止断言，登录smoke不冒充已登录业务链。

## 下一完成门

1. 依据本轮真实原件，设计来源组/精确坐标的可执行契约，避免让模型凭示例猜字符数或另造组。变更必须新版本/新计划；旧错引证保持原样，不在冻结器里修后再称模型通过。
2. 未知改写/STAR的独立语义裁决、第二个不同实际模型同条件全五例、含失败的综合可比报告及周期实际执行仍待。当前只增加一批同权重/v3，不作排名或声称周期已运行。
3. 历史无scope显式关联、资料/授权变化及中断接手、剩余调用路径与R8总审计继续。真实资料/FactBase/原PDF/草稿/原服务/凭据及其他dirty worktree保留；无提交、推送或新分支。整体目标仍active。
