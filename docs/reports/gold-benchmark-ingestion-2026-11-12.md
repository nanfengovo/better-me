# 五组真实来源脱敏数据与实际四轴基线

2026-11-12，`agent-os`。本轮从来源准备推进到实际生成、复现、坐标验收和真实 PDF。完整目标仍 active，不把抽取基线当模型效果或全目标完成；当前桌面资源/回退仍以 [完整输出读取回执](task-output-artifact-reader-2026-11-12.md) 为准。

## 成品与证明

数据包 `evals/resume-quality/gold/v1`：五位不同作者、五份不同官方 JD、337 个脱敏证据单元、147 条 JD 要求，29 个数据文件。完整未脱敏快照仍仅在 `/tmp/betterme-gold-sources-WAeQAE`，未复制进仓库、发送模型或执行来源代码。

| 岗位范围 | 证据单元 | JD 要求 | 完整支持 / 部分 / 尚无证据 | 抽取基线 |
| --- | ---: | ---: | --- | --- |
| SRE 共同职责，非架构师职级 | 118 | 21 | 6 / 1 / 14 | 有 |
| Backend 共同职责，高容量候选 | 72 | 34 | 4 / 2 / 28 | 年份日期不补月份，未生成 |
| Frontend 共同职责，移动端转 Web | 81 | 38 | 2 / 0 / 36 | 原日期字段有歧义，未修造 |
| Fullstack 非 Senior/Staff 共同职责 | 34 | 35 | 0 / 4 / 31 | 有 |
| Data Engineer Junior，实习/学术转岗 | 32 | 19 | 3 / 0 / 16 | 有 |

来源和许可固定在 `gold/sources.mjs`，不是从 HEAD 静默更新；原文及许可证明 hash 在写出前完整复验。JSON/TOML/HTML/LaTeX 只作为数据提取，身份/联系人元数据不进入材料，机构/客户/项目名确定性替换。自述、团队参与、协助、实习、移动端、学术、个人及 fictional 练习边界保留。完整所选职业条目与技能列表分开，不裁片段制造完整事实。

原始片段位置、行号和 hash 与十份固定来源实际核对 **1,339 处全部通过**。映射为完整 token/标记条目级，不把派生坐标当成原始字符位置。独立目录再次生成 **29 文件逐字节相同**，目录 `/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-gold-reviewed-eWJmD5/reproduction`；拒绝覆盖现有目录。同级 `previous-v1` 保留此前标签版本，可恢复，未删除用户文件。当前数据 manifest SHA-256：`f487edd6ca2aa892cd2c3f45f2873b7b9966d33050e638853be6ddca99b275e2`。SRE 原文明写管理 GitLab CI，已校正为支持使用 GitLab。

`goldModelMaterial` 是采样材料唯一 allowlist：保留 JD/脱敏角色及原始日期精度/证据全文与 ID/hash，排除来源身份、独立要求权重/答案、STAR 和批准改写。测试修改评分标签不改变模型材料。它尚未替代后续真实 tasks 运行与候选冻结链。

## 评测语义与验收

评测器升为 `resume-quality-v2`，加入 `extractive_baseline` 明确区别脚本/人工/模型来源，以及 `supported / partial / not_evidenced`。部分支持即使匹配全部 anchors，也只列 partialClaimIds，不获得完整 JD 覆盖；支持状态与 evidenceIds 矛盾直接拒绝。修正了研究摘要对 Rails 的简化：后端原文有历史 freelance Rails，但不足以自动证明当前岗位要求的 significant professional depth，不标成完全没有。

Gold 入库阶段最终本集合 **24/24**，无跳过，包含原有10项和新增14项，不与中间20/23项重复累加。按根 CI 的 tsx/tsconfig/TAP/concurrency=4 命令形状执行，日志 `/tmp/betterme-gold-ci-delivery.log`。覆盖五作者/不同源、完整派生包/精确映射、PII 与官方 JD host allowlist、UTF-16/emoji/CRLF、真实缺口、限定语删除、无据 Kafka/数字、部分支持、源篡改先失败、许可分离、文件/链接篡改、完整抽取及真实三 PDF 报告。后续冻结链新增项另见相应回执，不混加历史运行次数。

Core 类型检查、定向 ESLint `--max-warnings 0`、MJS 语法通过，日志 `/tmp/betterme-gold-core-types-final.log` 与 `/tmp/betterme-gold-lint-delivery-final.log`。首轮19/20因测试在追加 support 后未按 schema 规范化就算 case hash 而失败，修正测试 hash 构建后再完整运行；没有放宽完整性检查。生成前的官方 JD 链接误判亦已分离：候选仍禁个人 URL，JD 仅允许明确 HTTPS 官方文档 host，并拒绝近似域名/用户信息/邮箱。

## 实际 PDF 与报告

实际 CLI 成功输出 `output/pdf/gold-source-baselines-final-2026-11-12`，日志 `/tmp/betterme-gold-baseline-report-delivery.log`。真实来源5、合成0；三份确定性抽取，不是三个模型。`comparable=false`，模型请求0。报告、完整 case/run、逐条 metrics 与全部 PDF 均保留；此前报告目录未覆盖，最终以 final 目录为准。

| 抽取基线 | JD覆盖 | 引证事实筛查 | STAR结构 | 实际页数 | 垂直文本占用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SRE | 27.78% | 100% | 62.5% | A4 1页 | 49.72% |
| PHP/JS 全栈 | 0% | 100% | 50% | A4 1页 | 28.75% |
| 数据工程实习 | 27.59% | 100% | 45% | A4 1页 | 38.84% |

三份均无缺失 bullet、孤题、横向越界、页外文字或外部资源请求。通过 Poppler 96dpi 转 PNG 并逐张目视，完整限定语与文字保留。留白明显、重复上下文及 STAR 缺项如实显示，这是保守基线，不是“优秀简历”成品。全栈0覆盖表示现有证据只能支持所选复合要求的一部分，不鼓励模型补造 Ruby/语义 HTML/安全/高规模审查。

PDF SHA-256：SRE `4117d713f22d3e87fbee7de73d4becfd8e91ad3465b1757b69f33b6eb494d0df`；全栈 `2efa044218662e1c6dd17565c02e4f52851be76a0462ac9e09034d918420f6b2`；数据 `6efd24022cc06b9096704c58519b66cd3d293b25c421ec38443b06498d102b03`。技能标签/自述结果不是独立任职或性能证明，100%只表示这些完整抽取句满足当前保守引证规则。

## 后续门与保护

1. 首轮 tasks 成功候选冻结及年份/歧义日期只读投影已由[冻结链回执](task-candidate-freeze-2026-11-12.md)接续；仍需真正批量采样/异常候选失败回执，不把夹具当真实模型运行。
2. 完善独立语义裁决：当前标签由 Codex 对照固定源审阅，未声称外部人工认证；未知改写和未裁决 STAR 保守不给分。Gold 文本来源已落地，不据此证明完整生成质量标签成熟。
3. 同数据/协议/模板/根上限下完成真实多模型全五组运行、逐例失败与可比报告，再接实际周期执行。当前没有最佳模型结论、调度或后台付费。
4. 历史无scope关联、范围变化/中断接手和其他调用路径，以及最终 R1–R8 成品总审计继续。

本轮只改离线 Eval/Core 非生产导出模块、测试、数据及文档，没有修改生产 Web 或再替换已一致的 App，不冒充本轮桌面重建。真实资料/FactBase/凭据/窗口/原5173/5179服务和共享 dirty worktree保留；0外部模型，未提交、推送或换分支。
