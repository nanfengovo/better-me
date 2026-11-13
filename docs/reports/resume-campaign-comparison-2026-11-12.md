# 完整批次比较与有限周期报告

2026-11-12，`agent-os`。比较器、有限周期runner及实际两轮报告已落地；**真正不同的第二模型和同条件排名尚未完成**。本回执补齐README指向，不把重算历史产物当新增模型试验或永久定时服务。

## 实现与边界

- `evals/resume-quality/comparison.mjs` 只接受显式绝对路径的dataset和1–32个campaign/context。完整验证所有计划案例/失败/未决、原archive及冻结候选，归档完整原件和12个直接评测/模板源文件。不调用SDK，不向生成端回灌Gold标签，不改旧评分或PDF。
- canonical路径、symlink/hardlink、输入输出重叠、重复归档和重复campaign均拒绝。报告仅写全新目录，附完整manifest；失败/未知留在全计划分母，未知金额为null，不给失败补优秀分。
- Ollama以已保存的全部FROM/ADAPTER实际权重blob识别模型；同权重的不同名字/digest配置不当作不同模型。非Ollama revision只属声明，不冒充加密认证。
- 严格比较至少需要两个不同真实模型、每个至少5个真实案例、相同材料/协议/模板/预算及全部终态。综合质量比较还要求全部候选可冻结。脚本fixture单独记账；不满足时没有“最佳模型”或总体质量通过。
- `periodic-report.mjs` 只按本人显式有限次数与间隔运行，串行不重叠，跳过错过时槽；每轮重新读选择文件并保留其SHA。取消等待当前报告结束，不启动下一轮。不安装cron，不安排后台模型推理或默认付费调用。

定向比较4项、邻接54项通过；覆盖真实认证HTTP/scripted kernel、完整失败/长raw、改文件/重复/路径攻击、每轮重读选择和取消阻止第三轮。日志归档 `output/agent-runs/resume-comparison-validation-2026-11-12/`。同权重别名反例先红后绿；不是实际双模型质量验证。

## 已实际执行的两轮

选择文件 `output/agent-runs/resume-comparison-selection-2026-11-12.json`，SHA `47bfcce4c1ace0cf731f22edf0d4f1427925eac8da5d2b1c8f1429d65c63cfc5`。耐久目录 `output/agent-runs/resume-comparison-periodic-2026-11-12/`，runner已完成2/2，不留常驻作业。

| 周期 | 实际开始/完成（UTC） | 完整报告SHA |
| --- | --- | --- |
| 1 | 08:05:58.778 / 08:06:34.091 | `65c63b1cdf92d5522cb4951597edf5041c330e5f4312405e8852144c75820a50` |
| 2 | 08:06:34.778 / 08:06:50.956 | `2a730e0a65acb01e9e8b8354a93513b0153d9483b2b4a313b0b7f5387ee64fb5` |

第一轮完成时跳过35个过期时槽，没有并发补跑。每轮均选原v6/v7两campaign，10计划/9冻结/1失败/0未知；0新模型请求。

814个manifest文件、18份重打印PDF及18个metrics投影已核对，投影与原值一致，原件不变，见目录内 `verification.json`。18份PDF是每轮打印9份已有候选，**不是18次新生成**；未声称新重打印图全部再次人工目视或内容质量合格。summary SHA `607a29e5f9ca8777f0b1382bdbaf242a21b2b7f5dcc2a41bfda615ccf2cbae71`。

两个campaign使用同一组权重blob：`3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd`、`58c187648007cab392bd5678b87e862c3e8794017deb945feea2cf256195e96a`。所以实际不同模型数仍为1，deliveryComparable/qualityComparable均false，原因 `different_real_models_required`、`conditions_differ`。周期报告已执行不解除这个完成门。

## 下一门

第二模型须本人选择原已授权BetterMe账号通过正常tasks运行这五组公开脱敏材料，或为隔离benchmark身份另行官方授权。现有空评测身份的Codex预检needs_authorization不代表原账号已退出；未读取/复制既有登录，也未启用cloud或下载模型。

取得明确选择后保留原完整材料、契约、模板及每例原预算，在相同条件下实跑，所有失败进入分母。质量依据还须包含逐条语义/STAR和选材，不用规则100%或A4一页代替优秀简历。最新独立源审见[44条回执](task-candidate-current-work-source-review-2026-11-12.md)。本轮离线收尾未改生产执行或再次替换App，当前资源看[Studio回执](studio-analysis-task-runtime-2026-11-12.md)。
