# 简历四轴 Eval 与真实来源准备

2026-11-12。这是统一 Agent 目标的实质新进展，不重复UI检查；**R4/R5/R6尚未整体完成**。当前桌面资源/回退看 [完整输出读取回执](task-output-artifact-reader-2026-11-12.md)。

后续已完成五组真实来源脱敏 v1、1,339 处原始坐标核验与三份实际 A4 抽取报告，见 [Gold 入库回执](gold-benchmark-ingestion-2026-11-12.md)。下文10项/来源尚待入库是初版阶段快照，不代表当前最新状态；真实模型比较和周期执行仍待。

首轮 tasks 输出自动冻结及五组只读原日期投影已接续，最新31项、实际命令/完整归档重建/PDF与未完成门见 [冻结链回执](task-candidate-freeze-2026-11-12.md)。回答仍是脚本夹具，不当模型成绩。

## 已实现的可运行链

- `packages/core/src/career-intelligence/resume-quality.ts`：严格 case/run 契约、immutable hash/UTF-16原句坐标、独立加权JD覆盖、精确引证/新增实体数字/未知改写守卫，以及来源标注驱动的STAR结构分。资料/标签不被评测改写；缺证的JD要求留在分母，空候选不获事实/STAR满分。
- `evals/resume-quality/render.mjs`：复用正式 ResumeTemplate/纸张CSS/打印边距，离线Chrome或Edge实际打印全部PDF页；PDF.js核对A4尺寸、完整正文、标题与首条正文所在页、横向越界及PDF文字页外边界，报告实际垂直占用。多页明确失败，不裁页、不缩小原文。
- `report.mjs` / `run.mjs`：完整case/run/metrics/PDF归档，kernel来源另验证并保留完整task/output字节、task/root/runtime与根预算用量；fresh输出目录避免覆盖。模型版本是输入声明，不把云端权重当已独立核验。
- `pnpm evals:resume-quality --cases DIR --runs DIR --out NEW_DIR` 可重复生成Markdown/JSON对比报告；`pnpm test:resume-quality` 执行独立回归。
- 合成和人工baseline不进入真实模型汇总；至少两个kernel模型、相同不少于五个真实case、hash/协议/根ceiling和完整case集合，才允许 `comparable=true`。不同轴独立展示，覆盖率不能抵消事实/排版失败。

自动规则是保守诊断，不是完整语义判定。独立标签之外的改写标待核对并不算事实通过；不把“没有检测到新词”冒称零幻觉，也不由生成模型评自己。自动检查不授予资料共享或业务采用权限。完整使用与边界见 [README](../../evals/resume-quality/README.md)。

## 当前验收

- 首轮8项，macOS `/var`→`/private/var`路径别名导致报告测试失败；改为先规范化显式选择的目录，个别输入文件symlink仍拒绝。随后补完整kernel归档hash与“删掉否定词的精确子串”反例，最终 **10/10**，日志 `/tmp/betterme-resume-quality-delivery-tests-final.log`。
- 覆盖已知缺口不被关键词填补、错引用/hash、无据Kafka/Kubernetes/数字、未知改写独立审核、子串不能删除否定/限定边界、原文坐标/版本/重复ID、Go/Mongo边界、空候选、实际一页/120条多页、完整末尾内容、文件不可覆盖、合成分数不混入真实汇总及不接受伪造完整归档。
- 独立实际CLI成功：真实0组、合成1组、模型请求0、`comparable=false`，没有伪造模型排名。原始报告 `/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-quality-report-5HRweU/cli-report-final`；日志 `/tmp/betterme-resume-quality-cli-final.log`。
- 正式模板生成短稿实际一页、长稿实际六页；全部120条及末尾Contribution119保留。PDF在 `betterme-quality-pdf-1TfBTT` 系统临时目录；用Poppler渲染短稿/长稿首张并目视，PNG `output/pdf/resume-quality-synthetic-{short,long-first}.png`。长稿是明确不满足一页的负例，不作为合格简历交付。
- Core类型、定向ESLint `--max-warnings 0`、MJS语法和 `git diff --check` 通过。本阶段新增独立评测/脚本/资料研究，没有再改生产Web或替换App；完整输出批次的双端构建与安装一致性仍有效，不把本节算作新一轮桌面构建。

## 真实 Gold 来源准备（初版历史，已由上述入库回执接续）

按research技能由后台来源核查完成5位不同作者的完整履历文字、5份不同GitLab官方岗位定义，以及各许可/README/固定commit/完整字节hash。覆盖云原生SRE、高容量Django后端、前端迁岗、PHP全栈与数据工程转岗；不把架构师职级、商业交付或实测指标补到来源没有的地方。

研究回执 [gold-benchmark-sources-2026-11-12.md](../research/gold-benchmark-sources-2026-11-12.md) 包含全部第一方URL、许可取证与排除项。MIT模板代码不自动等于履历内容许可；GitLab公开文档按其内容CC BY-SA4.0处理，而非误套仓库软件MIT。

完整未脱敏公开来源只在 `/tmp/betterme-gold-sources-WAeQAE`，尚未复制入仓库或发给模型。仍需确定性替换身份/联系人/机构/URL、原文→脱敏坐标映射、PII检查、逐条事实/要求/支持与缺口/STAR标签及notices，然后才纳入Gold。公开可回溯来源不保证不可逆匿名；这些材料也不是作者真实申请GitLab的结果记录。

## 后续完成门

1. 五组来源按固定hash完成可重复脱敏、标签与许可notices；保留自述/练习/开源/商业边界。
2. 将任务完整输出和人工核对后的候选投影/引证自动冻结为run包，而不是要求操作员手动整理；仍只通过统一tasks执行，不新增模型SDK黑盒。
3. 在相同数据/版本/模板/根预算下做真实多模型运行，形成可直接比较的逐样本和汇总报告，并补事实/排版反例审计。
4. 再接周期执行的实际机制；当前没有创建调度、后台付费推理或自动发送真实/公开原始履历。已存在可重复离线命令不等于周期模型比较完成。

未动真实简历/FactBase/凭据/原窗口或5173/5179服务，未提交/推送；0外部模型调用。统一目标保持active，不以此标complete或blocked。
