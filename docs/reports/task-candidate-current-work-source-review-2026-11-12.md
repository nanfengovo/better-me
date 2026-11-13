# v7全部44条来源与STAR核对

2026-11-12，`agent-os`。本轮对最新真实五例候选全部44条正文完成操作者源审，补齐此前明确未完成的语义/STAR检查。**不是外部人工认证、盲评、新第二模型或总体质量通过**。未调用模型、修改原候选/Gold/分数/PDF或采用业务内容。完整目标active。

## 全量结果

原campaign `local-5d649af757dd6e9d`，原collection SHA `b2cac86b7b9e934464ce033dda863de5cb291358a0ef53cd5d426f41bb3375c3`。正式 `loadSemanticReviewMaterial` 先重建终态archive，再逐条对照实际所引完整原文和group；5例/5原始输出/44正文全部覆盖，无未解析或已记账无输出项。

| 案例 | 正文 | 源内支持 | 明确行动 | 源内明确结果 | 仅目的 |
| --- | --- | --- | --- | --- | --- |
| backend | 4 | 4 | 4 | 2 | 0 |
| data-engineer | 3 | 3 | 3 | 0 | 2 |
| frontend | 4 | 4 | 0 | 0 | 2 |
| fullstack | 23 | 23 | 0 | 0 | 9 |
| sre | 10 | 10 | 10 | 0 | 1 |
| 合计 | 44 | 44 | 17 | 2 | 14 |

“源内支持”只指作者原资料支持相应措辞/范围，不独立认证就业、个人归因、数字、生产状态。27条职责或尝试方向的具体行动为uncertain；结果另有27条未陈述、1条笼统学习自评为uncertain。S/T/A/R四项在本文保守口径下全present为2条，不替换旧字面STAR规则分数。

## 核心发现

- **31/44条完整照搬引用单元，12条仅去角色前缀，只有1条其他改写。** 引证机制已正常工作，但不能说明Agent已经做了有效编辑。该比较基于完整字符串，不裁前缀以外的内容，不推断含义变化。
- 后端两条源内结果是“通过类型标注建立类型安全”和IoT从pilot到production。前者是作者定性状态自述，不认证类型覆盖或缺陷下降；后者不认证验收和唯一归因。平台300万用户/600req/s是背景，不作个人优化效果。最近2023–2024 work-1仍遗漏。
- 数据工程三条实习均有各自引用；Airflow定期获取和Django用于注册/存储/搜索是目的，不能自动计为已观测业务结果。与v6研究错挂的失败相比，本次没有借用研究来源，但不能跨协议作模型进步或不同模型比较。
- 前端仅选4个work组，7个project组全遗漏。`project-0-action-0`中1400ms→100ms的feeds结果也被漏选；这仍是移动项目，不准为匹配Web JD改成Web前端。work-3的“improved my skills”笼统自评不能当清晰验收结果。
- 全栈23条均为freelance通用职责，每条重复角色前缀；5个作品集/练习项目全遗漏。Shoutbox的无需刷新显示、SQL Quizzer写入行为等更具体素材未被使用。作品集保留作品集，虚构练习保留fictional；SEO自述/插件一般作用不自动认证客户收益。占满一页不是好简历。
- SRE十条均为对应work组的忠实摘取，没有培训升级为任职；Prometheus/Grafana识别瓶颈/提出建议是目的，轮值一周/月是安排，均不是已解决故障、MTTR或稳定性成果。动作有据而结果多缺失。

全部逐条理由、S/T/A/R状态、实际引用与精确UTF-16来源/结果跨度，保存在完整报告，不只留表中合计。遗漏项目的完整原文和选择组清单另保存在 `editorial-followup.json`，用于编辑后续，不作为生成端Gold答案。

## 产物与独立核验

目录 `output/agent-runs/resume-source-review-v7-2026-11-12/`：

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| material.json | 173056 | `78b064bfe1c605c5e577d551a897718f63ca7f7d2839004237d86e7b13cd5917` |
| review.json | 62513 | `e6941215017371a1f02d3bd787038d7cf0e30a008f65a85243f1b7a4c5900274` |
| receipt.json | 237025 | `b0fdadbc7b35c485932fac7dc7262be0fc7ff0ac827ea4db674a1426e45245a2` |
| report.md | 71812 | `ff8b5fb893f470539c5dd39c3e1a1f01d2d3b50e6038ad9b68cd87fd402879a4` |
| editorial-followup.json | 56145 | `b93f1eb0656723582119e0de01b89f675c83a8ed0c8486f88e934aa1fdcd1bf4` |

- 使用耐久review JSON经正式CLI分别独立重建v7及旧v6至隔离临时目录，**8文件逐字节相同**。临时目录 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-semantic-v7-nFI48S/`；重建不调用模型。
- v5/v6/v7的6份原quality/collection回执SHA未变，**597个原manifest文件**逐大小/SHA一致，包括原PDF。核验回执 `verification.json`，旧v6四文件仍原样；没有重打印旧PDF。
- 首轮核验把v5历史目录与最终attribution目录混用，严格SHA断言拒绝；查阅原编辑回执后改为它声明的最终目录，保留既定SHA，未改原件或为通过而更新期望值。临时review也改用真实 `/private/var` canonical路径，未放宽文件守卫。
- **70项定向Host/Eval全部通过**，0失败/取消/跳过，日志 `/tmp/betterme-semantic-v7-regression.log`。覆盖全部resume-quality测试及candidate coverage/attribution/editorial/bound四组；是当前代码回归，不是70次真实模型推理。
- 本轮没有生产Web/Host执行改动、真实推理或App替换；当前533安装资源另已独立核对，权威看[Studio回执](studio-analysis-task-runtime-2026-11-12.md)。原服务/真实窗口/简历/凭据/Git保留。AGENTS指向的三份个人求职SSOT在当前checkout缺失，本轮未创建替代个人事实库，仅审公开脱敏资料。

## 下个实现与验收门

后续要让Agent明确做有证据的选材、压缩职责和表达结果，而不是继续复制原文或强制所有项目塞满一页。只允许在原组/原范围内编辑；源内已有的结果先识别再取舍，来源确实缺结果才问。保留任职同时不能把作品集当任职、移动经验改Web经验、目的改成果或扩写个人主导。

本轮只完成源审，没有声称这些写作问题已修复；更没有把44条批准为新Gold改写。不同第二模型/同条件比较、剩余实际推理入口、授权变化和最终R1–R8成品审计仍待完成。周期重算已实际两轮，但仍只有同一模型权重，详见[比较回执](resume-campaign-comparison-2026-11-12.md)。
