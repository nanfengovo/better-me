# 任务完整输出冻结为只读评测候选

2026-11-12，`agent-os`。本阶段补齐 R5 的首轮任务输出自动冻结，不是多模型成绩或全目标验收；R1–R8 继续 active。当前安装资源/回退仍看 [完整输出读取回执](task-output-artifact-reader-2026-11-12.md)。

后续正常tasks批量/完整失败与容量守卫、v2显式目标及实际本机运行见[采样回执](task-benchmark-collection-2026-11-12.md)，当前Eval共39项；下方31项、0模型与待办是本冻结阶段历史快照，不覆盖后续真实记录。v1归档仍按原输入重建，不自动升格为v2成绩。

## 已落地

`evals/resume-quality/freeze.mjs` 只读显式指定的 benchmark owner 完整私有任务目录，不扫描真实默认存储、不构建第二个模型执行器、不恢复任务。`prepareBenchmarkRequest` 产生正常 free_chat 请求；实际创建/运行仍归 `/api/v1/agent/tasks` 与原 AgentTaskKernel。模型只见 JD、脱敏组/完整证据/hash、原日期和固定协议，不见评分标签/权重/STAR/作者归属。证据与原 group 绑定，不能挪成另一雇主的成果；技能清单与交付证据保留区别。

| 原边界 | 当前行为 |
| --- | --- |
| 需手工整理候选/引证/账本 | 解析首轮完整回答，自动冻结为 run；不执行 Proposal 或业务采用 |
| FactBase 要求 YYYY-MM | 独立只读 sourceCandidate 保留 `Since 2024` 或原歧义日期全文；不迁移 FactBase，不补月份 |
| task/output hash 尚不能证明候选没换稿 | 保留私有 wire/失败修复/完整回答、原材料与根成员；报告从归档重新构造候选并逐字核对 |
| 子任务可能误看局部用量 | 从完整同 owner 根成员日志累计原根账，固定 runtime/auth generation；不创建第二份计数器 |
| 脚本夹具可能被当模型 | `execution=scripted_fixture` 单列；只有至少两个不同 provider/model/revision 的实际模型与完整五例冻结包同条件才可比 |

冻结包包含完整源 case、allowlist plan、组上下文与原映射、metadata、task JSON、未经改写的 wire TXT、reply TXT、根内全部原始记录和超大输出文件。manifest 记录各文件字节数/hash；run 再绑定 manifest、规范化 case 和完整模型材料 hash。完整问询保留，不打印成个人成果。错误引证/无据数字留给评测器明确失败，不静默修复；跨组/不完整/非法协议拒绝形成有效候选。已有输出目录、文件链接、换号、活动根、代次/输入变化或并发记录变化均失败。

原私有记录不被改写，目录快照前后核对文件集合和全部字节。这里证明本地完整性与可追溯链，不是不可伪造的提供商签名；必须使用真实来源记录。模型版本仍是操作者声明，不能宣称已核验云端权重。

## 验收与实际命令

- 全集合 **31/31**，无跳过。根 CI 形状 tsx/tsconfig/TAP/concurrency=4 最终日志 `/tmp/betterme-freeze-ci-final.log`；实际 `pnpm test:resume-quality` 最终日志 `/tmp/betterme-freeze-package-final.log`。计数包含先前24项和新增7项，不叠加中间29/30项运行。
- 新增7项覆盖：实际内核首次非法回答修复/完整 wire CRLF及首尾空白、原记录不变、换稿、五组来源/原日期实际PDF、共享父子原根2次/两成员、答案标签隔离/跨雇主证据、错引证与Kafka/100000原样判失败、owner/runtime/活动根/材料/文件篡改、不同实际模型与完整材料hash比较门。
- Core 类型、定向 ESLint `--max-warnings 0`、MJS 语法及包含新增未跟踪文件的 scoped whitespace 检查通过。日志 `/tmp/betterme-freeze-core-types-final.log`、`/tmp/betterme-freeze-lint-final.log`。初次发现根目录没有直接 zod 依赖及经验类型不是 project，分别复用 Core 现有依赖、使用现有 work/education/other；freelance 仍为 work。随后 macOS 系统目录别名先规范化，再继续拒绝个别文件 symlink。未加依赖或放宽事实/来源检查。
- 实际 `node --import tsx .../freeze.mjs` 成功，11文件、0模型请求、明确 scripted_fixture；目录 `output/pdf/task-candidate-cli-export-final-2026-11-12`，日志 `/tmp/betterme-freeze-cli-delivery.log`。
- 实际 `pnpm evals:resume-quality` 成功，完整五组 kernel 夹具冻结包→正式模板全部PDF页→四轴报告，当前目录 `output/pdf/task-candidate-freeze-reviewed-2026-11-12`，日志 `/tmp/betterme-freeze-report-reviewed.log`。此前 final 目录保留，不覆盖。真实来源5/合成来源0，但回答为脚本，不是模型；`comparable=false`，外部模型请求0。

五份 PDF 均 A4一页、完整正文保留、无孤题/横向越界/页外文字/网络请求；当前 reviewed 目录全部用 Poppler 80dpi 渲染并逐张目视，无重叠/缺字，freelance 保留在工作经历。短篇抽取夹具只取每例至多前两条，留白明显，仅验来源/归档/日期/排版机制；不能声称是优秀简历或五组模型写作改善。旧三份逐月 Gold 抽取基线及报告保留，未覆盖。

## 尚未完成

1. 真正的多模型批量任务采样与异常候选失败回执采集（当前成功候选从明确选择的离线记录目录导出）；全过程继续统一 tasks，不另调 SDK。
2. 五例同条件实际模型成绩、独立未知改写/STAR 语义裁决、失败逐例记录与模型选择结论。
3. 实际周期执行，不把可重复离线命令说成已调度。未创建后台付费/云推理任务。
4. 历史无 scope 关联、资料/授权变化及中断接手、剩余调用路径和 R1–R8 总审计。

本机 Ollama `/api/tags` 只读核对到一个实际本地 GGUF 模型 `gemma4:e2b-it-qat`；另一个 `gemma4:31b-cloud` 带 `remote_host=https://ollama.com:443`，不能当成第二个离线模型，也未调用它。此观察不是已运行模型评测。

本阶段只改独立 Eval/Core 非生产导出模块、测试和文档，未改生产 Web/Host 执行逻辑、未重建或替换 App。真实简历、FactBase、凭据、窗口、5173/5179服务及无关 dirty worktree 保留，0外部模型调用，无提交/推送/新分支。
