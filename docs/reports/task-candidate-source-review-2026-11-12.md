# 完整批次来源支持与STAR源审

后续进行中工作保留守卫、v7新五例及当前资源/回退见[当前任职保留回执](task-candidate-current-work-2026-11-12.md)。本报告的22条审阅只适用于原v6批次，不认证新v7的44条正文；原档和四份SHA继续保留。

2026-11-12，`agent-os`。这轮完成离线源审模块及v6原批次全部22条正文的操作者源审，**不是外部人工认证、盲评或第二模型评测，也不意味着写作质量通过**。生成策略、原Gold标签/分数、失败状态、wire和PDF不变；没有新增真实推理或业务采用。完整目标继续active。

## 实现及覆盖范围

- `evals/resume-quality/semantic-review.mjs` 通过两个公开函数读取已核验的完整材料、校验并另存审阅。复用 `reviewCollection(...verifyOnly:true)`，不另建采样或SDK。默认collection写回行为/回执字节不变。
- 输入只接受来源绑定v4/v5/v6完整终态归档。全计划、全部已记录输出、全部可解析正文必须逐项匹配；task/case/plan/output/text/引用ID和原文hash/UTF-16跨度均核对。修复前拒绝输出、无效JSON/契约及超大artifact保留全文。已记账而无输出的调用数明确显示，不推定提供商已经完成调用。
- 支持源必须是实际被引用的单元；错引必须有未引用的对照源。对照研究不能变成当前实习的事实。非支持项的STAR均为uncertain，源内结果present另需结果原文坐标。
- 成功和被拒输出分账。报告保留完整正文、实际引用单元、对照单元及判读理由；完整raw在material/receipt中，无截取。总体质量状态固定null，精确绑定只验证覆盖/字节，不能证明操作者语义判读必然正确。

## 实际批次判读

原campaign `local-cf65597d98dd26f0`，原collection SHA `83cd79a918fe6f17d6566c9eb7702a33f73a8150c7a08ed523f87b90089f2599`。完整5例/5原始输出/22条，未解析输出0、无已记录输出的记账调用0。本轮推理0次；原5次真实本机推理仍以[来源归属回执](task-candidate-attribution-2026-11-12.md)为准。

| 分母 | 条数 | 源内支持 | 错引 | 不确定 | 源内明确结果 | 仅目的/一般用途 |
| --- | --- | --- | --- | --- | --- | --- |
| 全部可解析原输出 | 22 | 20 | 2 | 0 | 3 | 5 |
| 已接受候选 | 18 | 18 | 0 | 0 | 3 | 4 |
| 已拒绝输出 | 4 | 2 | 2 | 0 | 0 | 1 |

判读是Codex操作者对照源的记录，不是独立就业/指标验证。接受候选全部有源内支持也不是零幻觉认证或优秀简历评分。

- 数据工程前两条分别为Airflow部署与Python/Requests/BeautifulSoup采集，实际实习item-20/item-19支持。后两条EoR/CDAE和low-frequency radio软件来自研究item-14/item-12（后一条另有个人项目item-8），却引用实习item-19，均判错引。第二条经过改写，现有窄全文守卫未单独命中。整个输出仍保持失败，不因其中两条有据恢复成功。
- 三条明确源内结果：后端IoT的pilot到production、移动项目feeds延迟1400ms到100ms、作品集Shoutbox无需刷新即显示消息的功能行为。前两项不证明独立生产验收/测量或本人唯一归因；最后一项不是实测延迟/业务影响。
- 平台3百万用户/600req/s保留为背景规模，不算个人优化成果。Airflow周期获取、Prometheus/Grafana识别瓶颈/提出建议、培训温湿度采集、通用Web职责目的及Yoast SEO的一般作用不算已经观察到的效果。
- 前端所有work组遗漏、SRE遗漏work-1、全栈通用/冗长及版面偏疏的问题没有因此解决；培训必须保留training组限定，不升级为生产任职。源内支持和简历完整性/相关性/表达质量分开处理。

## 耐久产物与独立重建

权威目录：`output/agent-runs/resume-source-review-v6-2026-11-12/`。使用该目录的review JSON和原collection/runtime-context通过正式CLI独立重建至 `/tmp/betterme-semantic-v6-fLig2B/rebuilt`，四文件逐字节相同；核验输出 `/tmp/betterme-semantic-v6-verification.jsonl`。

| 文件 | 完整字节 | SHA-256 |
| --- | --- | --- |
| material.json | 160351 | a89ed1e41e06bac5a56292aeb3f8a1fd602902d40825043e72a2269f287f5f05 |
| review.json | 35716 | 371ec1cc5266dbc8cc5ef7aaac59228b7bca8f1efa7aaeef5ee1b1f644d033c0 |
| receipt.json | 196143 | 80c489690970e7519d615dc3466b330009133e074e7757c6d7830640059e0341 |
| report.md | 41935 | 3aab343c905d6ed52accee3fcc5410d8ae992c30a0c18b47941e73eadbc76cb7 |

原v6 collection/quality仍分别为 `83cd79a9…` / `50da570e…`；原v5 collection/quality仍分别为 `e08f6f91…` / `ffec18f1…`，本轮重核四份完整SHA均不变。没有重新打印或改写旧PDF。

## 验收和下一门

- **67项定向Host/Eval通过**，覆盖全部resume-quality测试及四组candidate契约/归属/编辑/绑定测试，0失败/取消/跳过。日志 `/tmp/betterme-semantic-v6-regression.log`。其中两项新集成测试使用真实认证Host/collector和脚本夹具，不是真实模型质量：完整超大输出、无效JSON/契约、同根修复前后两份输出、传输失败无输出、约17类删项/改hash/跨源/错误结果/冒称外部人工均覆盖。
- 定向ESLint零警告；本轮仅离线Eval与文档，未改生产Web/Host/桌面执行代码，未重新构建/替换App。当前安装资源及可回退路径仍看[来源归属回执](task-candidate-attribution-2026-11-12.md)，不能以这次源审声称重新做了桌面UI验收。
- 真实资料/FactBase/凭据/原PDF/草稿/窗口和原5173/5179未操作；没有提交/推送、下载模型或启用云端。原进度答复是状态说明，不计实现进展；这轮才新增源审模块和完整可重建判读。

下一步：近期任职完整性和相关性、改写错引的生成端处理与留出反例、真正不同的第二模型同条件比较/实际周期、多根/授权变化与最终全目标审计。已有源审不是可直接灌给生成模型的答案，也不改Gold批准未知改写。
