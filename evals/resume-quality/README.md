# 简历四轴离线质检

离线报告管线不调用模型、不采用简历或修改 FactBase。另有显式启动的隔离本机采样器，只经正常认证 tasks HTTP；它会产生真实本机推理，不能和离线命令混淆。现有 `evals/career-intelligence` 继续负责委员会协议/守卫回归；不能把它的合成案例当作这里的真实 Gold。

## 运行

```sh
pnpm test:resume-quality
pnpm evals:resume-quality --cases /absolute/cases --runs /absolute/runs --out /absolute/new-report
```

三个目录必须显式选择，输出目录必须尚不存在。目录别名会规范化；输入文件 symlink 拒绝。每次写入独立目录，保留完整输入 JSON、逐例 metrics JSON、实际全部页 PDF、报告 Markdown/JSON；kernel 来源另保留完整 task JSON 和 output TXT。失败留下的中间产物保留，不覆盖旧报告。退出成功只表示生成报告，不表示模型质量或整个项目验收通过。

`--cases` 只读取 `*.case.json`；`--runs` 只读取 `*.run.json`。严格输入契约见 [`resume-quality.ts`](../../packages/core/src/career-intelligence/resume-quality.ts)。`fixtures.ts` 仅是可读的**合成协议示例**；它包含一个真实缺口标签，不能计入真实 Gold 或模型成绩。

## 输入与权威

- Case：真实/合成类别、完整所选 JD/脱敏证据及各自 SHA-256、原文固定 URL/commit/hash/许可、脱敏说明、独立标注的 JD 原句 UTF-16 起止偏移、权重、概念 alternatives、可支持证据 ID、STAR 原文信号和必要的实体词表。v2 的 `support` 区分完整支持、部分支持和无据；部分不获完整覆盖，无据的 `evidenceIds` 是空数组，仍进入分母。公开履历是作者自述，不是任职/指标实测证明。
- Run：case ID 与规范化 case JSON hash、冻结候选的 `FactBase + ResumeView` 或只读 `sourceCandidate + ResumeView`、locale、精确引证、模型/版本/runtime ID、协议版本、根预算与观察用量。后者保留原始年份/歧义日期字符串，不补月份，不写个人 FactBase。模型不可修改 case 或替自己填独立评分标签。`approvedParaphrases` 是 case 的独立复核标注，不从候选模型回答自动生成。
- `kernel_task` 来源必须提供相邻的 `<stem>.task.json` / `<stem>.output.txt`。读取完整字节核对 SHA-256，解析真实 AgentTask schema，核对 task/root/runtime ID、根预算与累计用量。它们不能由一次独立直连模型调用伪装成 tasks 运行。模型 revision 是记录的声明，不假装能独立验证云端权重。
- `freeze.mjs` 自动将明确选择的 benchmark owner 完整私有任务目录中的首轮 free_chat 回答冻结为候选。原始 wire/失败修复/全部根成员记录/问题/完整回答/原日期及引证都保留，报告重新从归档推导投影而不是信任可修改的 run JSON。它不执行 Proposal、不采用简历、不改个人事实，也不启动/恢复任务。`archiveTaskFailure` 保留非法/部分/超大输出及派送前零用量失败，绝不构造空白成功候选。任何检查通过也不授予业务采用或资料共享权。

## 显式本机采样与完整批次回执

先用只读容量探针检查现有模型配置，再决定是否真正推理：

```sh
node --import tsx evals/resume-quality/ollama-context.mjs /absolute/gold/v1 EXACT_INSTALLED_LOCAL_MODEL
node --import tsx evals/resume-quality/collect-ollama.mjs --dataset /absolute/gold/v1 --model EXACT_INSTALLED_LOCAL_MODEL --out /absolute/new-isolated-run
node --import tsx evals/resume-quality/collection-report.mjs /absolute/gold/v1 /absolute/isolated-run/campaign /absolute/new-receipt
```

采样器不下载/创建模型、不启用 cloud 别名、不读取或复制现有账号凭据。它创建独立临时身份和正常 Host，复用生产 resolver（不注入脚本 reasoner），推理只走 `/api/v1/agent/tasks`；结束仅关闭自己的 Host。默认每例一个独立逻辑工作区/原根、模型调用上限1/工具上限1/活动300秒，所有五例固定同一上限。单次调用避免格式修复追加完整旧输出后超过预检容量；失败保留，需另行明确设计协议，不能自动开新根重试。

容量探针计完整生产 free_chat 提示、模板/系统及保守余量，不按字符截断；这是 UTF-8 字节上界守卫而非精确 tokenizer 或提供商签名。训练最大上下文不等于已配置/实际加载值；未知、低于门槛、加载值变化或模型代次变化均停止。运行前后保存完整 catalog/show/ps 与容量回执。OpenAI 兼容接口不能直接设置 Ollama `num_ctx`；需要显式选择已有足够容量的本地模型配置，见 [Ollama 官方说明](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size)。不要调整全局服务或缩短资料绕过门槛。

底层 `collectBenchmark` 支持明确传入的既有运行时、owner-bound 内存认证、预算与完整 Gold；不实现第二个 SDK。创建前保存完整计划；创建/启动意图和原 ID 先落盘。丢失创建回执仅只读核对，不自动启动；丢失启动回执只观察原 ID，不再派送。观察超时是未决，不是原任务终止，最终用量保留未知。相同 campaign 已有任务时拒绝再次创建。外部凭据不进入计划、日志或归档。

当前候选协议 **v7** 使用固定 `responseContract: "resume_candidate_v5"`，继承整稿和来源归属规则，新增 `currentWorkInventory`：只有源元数据明确标记进行中的 employment/internship/freelance，且有可引用原单元，才要求保留该组自己的证据。识别明确的 Since、至今/Present/Current 范围及保留歧义的原字段 Until Now；不猜月份、近期任职或先后，也不强制打印全部旧工作/项目。源快照的进行中标记不是现时任职认证。缺组记录 `candidate_current_work_omitted`，完整输出和清单进入原根修复；原额度不增加。该结构检查不证明正文语义支持、个人贡献或写作质量。完整反例、五例实跑和当前资源见[当前任职保留回执](../../docs/reports/task-candidate-current-work-2026-11-12.md)。

历史 **v6** 使用固定 `responseContract: "resume_candidate_v4"`：在共享写作法/整稿规则之后，Host验收完整措辞的来源归属冲突；v7继承同一守卫。完整措辞出现在未引用单元中、却不在任何所引单元中时，记录 `candidate_source_attribution_conflict`，保留完整wire/匹配来源/hash/kind并沿原根预算修复；预算已满则失败，不额外重发。同组错引单元也会检查，非交付学术/培训源不变成合法工作句柄。这个有限匹配不是语义事实裁决，改写的错挂可能漏检，无冲突不等于质量通过。全量v5回放和五例实跑见[来源归属守卫回执](../../docs/reports/task-candidate-attribution-2026-11-12.md)。

输出仍是 `schemaVersion:2,caseId,bullets:[{id,text,evidenceIds}],questions`，不是把wire版本误写为4。完整原消息由 `candidateSource:{messageId,sha256}` 绑定；原 `resume_candidate_bound` phase、同组动态schema、精确整单元引证、单运行时/根账和原预算均不变。完整规则与schema也计容量；不静默修引用、移句、缩短资料或自动采用。

历史v5对应 `resume_candidate_v3`，接共享写作法但不启用新Host归属守卫；历史v4对应 `resume_candidate_v2`。v1–v6按原提示、完整材料和原验收策略重建，不倒改旧失败或评分。不同提示/协议不是同条件模型排名，源码接入方法也不证明真实模型已稳定遵循。

v1/v2/v3仍按各自原目标、完整材料及wire协议逐字重建，各版hash不同，不混作同条件成绩。v3固定 `resume_candidate_v1` 的5例中1可冻结、4失败，保留[历史直接候选回执](../../docs/reports/task-direct-candidate-2026-11-12.md)；新运行不得改写或清除此批失败。所有版本完整wire均原样留存。

`collection-report.mjs` 离线重建每例成功/失败归档，核对 owner/任务/工作区/原根账/完整材料、模型元数据与所有计划案例；全失败也生成回执。v6/v7另从已核验原记录投影完整 `candidateRejections`，报告同时显示最终停止原因和原候选拒绝原因；未知记录为null，旧v1–v5回执不追加此字段。全部文件字节/hash保留，禁止遗漏失败项或覆盖报告。格式接受率不是事实合规或写作质量分；失败/未决不被虚构四轴分数。只有成功候选才可另行送入正式模板四轴评估；多模型综合可比报告和实际周期执行仍待。

报告命令可再显式追加第四个目录 `/absolute/isolated-run`，重核并归档该目录的完整 `local-model.json` 和每例前后 context 原件；成功时单列 `capacityGuardVerified=true`。省略时明确记为未提供容量保证，不能从完整 Host 记录推断提供商处理了全量 token。可将已导出的回执目录作为下一次 campaign 输入、其 `runtime-context/` 作为显式容量输入，独立重建到新目录，无须重发模型。

在上述命令末尾显式加 `--quality`，会生成全计划质量报告：`collection/`保留全部原回执，`quality/`仅打印/检查可冻结候选，`quality-receipt.json`和根`report.md`同时列出成功、失败和未决。失败/未决的四轴分为null、仍进入总交付分母；条件均值只覆盖已测候选。全失败时不生成空白成功PDF。此命令仍是离线、0模型调用，不是周期或多模型排名，也不采用任何简历。

## 完整批次比较与有限周期报告

`comparison.mjs` 复用完整批次验证器和正式模板质检，不增加模型执行器。显式配置一个或多个完整 campaign（原采样目录，或耐久报告中的 `collection/`），不扫描默认账号、模型凭据或用户资料。配置文件只接受以下严格字段；所有路径必须为绝对路径：

```json
{
  "schemaVersion": 1,
  "datasetDirectory": "/absolute/gold/v1",
  "campaigns": [
    {
      "directory": "/absolute/model-a-report/collection",
      "contextDirectory": "/absolute/model-a-report/collection/runtime-context"
    },
    {
      "directory": "/absolute/model-b-report/collection"
    }
  ]
}
```

`contextDirectory` 仅在明确保留了本机 Ollama 容量原件时提供，不能借给其他 provider；省略时不冒称容量保证。本机 Ollama 缺少完整权重来源不能确认为不同模型；其他 provider 的 model/revision 仍只是声明来源，不是云端权重签名。

```sh
node --import tsx evals/resume-quality/comparison.mjs --config /absolute/selection.json --out /absolute/new-comparison
node --import tsx evals/resume-quality/periodic-report.mjs --config /absolute/selection.json --out /absolute/new-periodic --interval-ms 60000 --count 2
```

- 每份 campaign 重新核验完整来源、原根账、成功/失败/wire/hash；所有可冻结候选在新目录重新打印全部页 PDF，原件不覆盖。完整私有成员/问题/失败正文都保留；原根调用与本报告新增推理分别显示，报告新增推理固定0。未记录的货币成本保持null，不推算免费。
- `deliveryComparable` 要求至少两个不同真实模型、相同至少五个真实案例、完整材料/hash/协议/原根上限，以及所有结果已终态且有完整归档。已知失败仍在交付分母，四轴为null；未决/无可核验归档阻止可比。`qualityComparable` 另要求所有计划候选可冻结，不能比较不同的幸存样本集。脚本夹具不计真实模型，条件均值只涵盖可冻结真实案例。
- 有本机原件时，从完整 Modelfile 的全部 FROM/ADAPTER blob hash 建立权重身份；相同权重的不同别名/上下文配置只算一个模型。旧 `run.mjs` / `modelsAreComparable` 的冻结候选入口不具备这些原件，因此不能单凭不同 Ollama 名称声明可比；本机多模型请走完整 campaign 对比。
- 报告保留直接求值/渲染源码快照及指纹，区分数据/协议变化；这不是完整依赖、字体/浏览器或原供应商参数的可复现构建证明。事实规则、字面STAR和A4各轴独立，不合成“最佳模型”或总体质量认证；该结论仍需结合独立语义判读和实际使用取舍。
- 周期脚本要求明确间隔（1000–86400000ms）和次数（1–10000），仅串行生成离线报告。超时错过的槽位跳过，不并发追赶。每轮重读显式 selection 文件，可由操作者选择新完成的批次；不扫描目录、重发推理或自动下载模型。每轮 selection hash、开始/完成、跳过槽位、完整报告hash及前一报告hash均留档。
- SIGINT/SIGTERM 在当前报告完成后停止，保留完整或失败中间产物；任何验证/生成失败记事件后停止，不自动重试。重开需要新输出目录，不能覆盖或偷偷重跑旧周期。输出父目录的符号链接也先规范化，拒绝与输入重叠；配置文件自身的符号链接和未知字段拒绝。

两轮短间隔真实运行证明的是**周期报告机制**，不是长期后台部署、第二模型推理或周期模型质量已完成。已有真实 v6/v7 批次使用同权重且协议不同，必须仍显示不可比，不能生成模型排名。实际记录见[周期对比验收](../../docs/reports/resume-campaign-comparison-2026-11-12.md)。

## 从任务输出冻结候选

先用 `loadGoldCase`、`prepareBenchmarkRequest` 生成带完整 allowlist 材料和固定输出协议的正常 free_chat 请求，再由现有 `/api/v1/agent/tasks` 创建/执行。不得另调 SDK 或把 case 评分标签发送模型。子请求未指定预算时保持省略，由 Host 继承原根。

v7模型按Host整稿/归属及进行中工作保留方法选择已有句柄，给出完整bullet和缺事实问题；Host解析整单元精确引证，雇主/角色/原日期由源锁定。冻结时再独立运行相同版本的归属与工作保留守卫，伪造已接受任务也不能绕过。新数字、未知改写和未命中的语义错挂仍交独立评测，不自动核准。v6保留原归属策略、v5保留原整稿策略、v4保留原来源绑定策略；v1/v2/v3仍核对实际坐标，不补正确值。问题不打印成履历成果，仍在完整回答归档。

## 独立的完整输出源审

`semantic-review.mjs` 是离线操作者源审，不是生成模型自评分，也不是外部人工认证。先重建完整终态批次，再绑定每个原任务、计划、原始输出、正文和实际引用的hash；缺少案例、输出或正文的标注会拒绝。拒绝后的修复尝试、无效JSON/契约和超大artifact全文仍保留。已记账但未记录输出的次数单列为未知，不能据此断言提供商实际完成了推理。

通过 `loadSemanticReviewMaterial({datasetDirectory,campaignDirectory,contextDirectory})` 读取全量材料后，逐条填写独立review JSON。`supported` 必须有实际所引来源的精确UTF-16原文跨度；`wrong_citation` 必须给出未被引用的对照来源，不能把对照源借给当前任职。标注理由及STAR逐项状态必须明确；结果为 `present` 还须有实际引用中的精确结果跨度。用途与观察结果分别记录，非支持项不获得STAR信用。坐标验证不替代对标注本身的语义判断。

```sh
node --import tsx evals/resume-quality/semantic-review.mjs --dataset /absolute/gold/v1 --campaign /absolute/verified-collection --context /absolute/verified-collection/runtime-context --review /absolute/review.json --out /absolute/new-source-review
```

输出独立的完整 `material.json`、`review.json`、`receipt.json` 和 `report.md`；原Gold/规则分数/失败状态/wire/PDF不变。成功和被拒输出分账，无法解析与未记录输出也在报告中显示；总体质量固定为null。所有标注只保留作者自述的源内支持，不认证就业、个人归因、指标或生产状态。真实v6整批22条的源审与重建证据见[源审回执](../../docs/reports/task-candidate-source-review-2026-11-12.md)，不能将它当作第二模型生成、盲评或周期运行。

最新v7五例全部44条另行源审见[44条回执](../../docs/reports/task-candidate-current-work-source-review-2026-11-12.md)：44源内支持但仅2明确结果、14目的，31原样复制、12仅去角色前缀；未将通用职责/平台规模/笼统学习自评当可观察结果。v6/v7共8文件独立CLI重建字节相同，旧6回执及597原归档文件不变；源审不是优秀简历认证，也不灌给生成端。

## v5–v7整稿编辑审阅

`--quality` 对v5–v7的每份已验证冻结包追加 `editorialReview`，从完整原材料而不是候选已选组建立清单。列出未选经历/项目、有据JD要求的未覆盖项、重复/仅标题bullet、结果在来源中缺失或尚未表达、明确原年份范围的倒序问题，以及整条措辞出现在其他源组的疑似错挂。研究/个人项目等不可交付组的完整来源也参与错挂检查，不被当作某次任职的备用证据。离线历史审阅不替换生成时的守卫，也不倒改旧验收策略。仅v7追加 `currentWorkCoverage`（批次中为 `metrics.currentWork`），从原完整材料独立核对所需工作组；其 `overallQualityPassed` 固定null。

这些是审阅线索，不自动改稿或事实核准。未选全部旧项目不必然是错；原日期不补月、不猜歧义；仅对明确 `Since YYYY` / `YYYY-YYYY` 建立部分顺序，同一年结束不猜先后。没有完整支持标签的案例，其有据JD覆盖分母为空，显示null而不是额外判0；原总JD覆盖分数和缺口标签不改。

`automaticChecksPassed` 仍仅涵盖事实规则/排版，v5–v7显式记录 `automaticChecksScope`。`editorialReview.overallQualityPassed` 固定null；即使 `status=no_rule_findings` 也不是优秀简历认证。所有未知改写仍需独立语义复核，规则0分不等于全部编造。完整来源、模型wire、私有根成员、原问题、每页PDF和诊断保留；旧v1–v4指标不追加新审阅字段。

任务停止写入后，显式选择**完整 benchmark owner store**（不是用户真实记录目录，也不是手选共享根的部分成员），执行：

```sh
node --import tsx evals/resume-quality/freeze.mjs --dataset /absolute/gold/v1 --case gold-backend --records /absolute/benchmark-owner-store --task ct_0123456789abcdef0123456789abcdef --owner benchmark-owner --metadata /absolute/model-metadata.json --out /absolute/new-frozen-run
```

metadata 的严格字段是 `execution`（真实推理为 `model`，脚本夹具为 `scripted_fixture`）、`provider`、`id`、`revision`、`runtimeId`。只声明版本/绑定，不放密钥、URL 用户信息或凭据。冻结器不扫描默认用户目录，也不读取模型配置。目录有运行中根成员、换号/换代/缺父记录/任务输入变动/输出不完整/文件变化/链接均失败；仅创建新输出目录，已有归档不覆盖。

`<stem>.freeze.json` 列出全部原始文件大小/hash；run 绑定它与完整模型材料 hash。`<stem>.records/` 保留根内完整私有记录和超大输出文件；原输入目录不改写。报告重建并核对候选、原根累计账与材料。这里是本地完整性/来源记录，不是防伪签名；操作者必须保留真实记录来源，不能把自己编造的文件说成模型实跑。

## 四轴定义

| 轴 | 实际计算 | 边界 |
| --- | --- | --- |
| JD 原句覆盖 | 核准且正确引证的 bullet，命中独立概念组且引用该要求允许的证据；按原句权重计分 | 单独出现 JD 关键词不算覆盖；语义改写需要独立标签 |
| 事实合规 | 每条 bullet 检查精确引用/hash、新数字、词表及新专有名词；完整独立事实单元原样采用或独立批准改写才核准 | 子串不能靠删掉否定词/限定语过关；不声称规则能识别全部中文名词或证明语义蕴含，待复核不算通过 |
| STAR | 依独立来源标注，逐条检查 Situation / Task / Action / Result 的可引用信号 | 来源没有结果时保持缺失，不补造数字；是结构筛查，不是模型自评 |
| A4 / 密度 | 用现有 `ResumeTemplate`、`resume-paper.css`、`getResumePrintCss` 在离线 Chrome/Edge 实际打印 PDF，再读实际页数/尺寸/全文/标题与首条正文所在页/横向越界 | 多页保留全部页并判失败；不使用 pageRanges、字符数或遮溢出伪造一页。密度仅报告实际文本垂直占用，不杜撰审美分 |

四轴独立展示。覆盖率不能抵消无据数字、缺证或排版失败。空候选事实/STAR 得分为未判定，不奖励空白一页。

冻结候选入口的声明可比至少要求两个不同 provider/model/revision 的 `kernel_task + execution=model`、冻结包重建通过、同一组至少五个真实案例、相同 case 与完整模型材料 hash/协议/根 ceiling 且案例完整；它不能证明本机 Ollama 别名指向不同权重，本机入口保守返回不可比。当前完整比较按上方 campaign 规则另核权重、失败分母和交付/质量条件。仅更换 runtimeId 不算第二个模型。合成用例、人工 baseline、`extractive_baseline` 与 `scripted_fixture` 单列；真实/合成不能混算，缺数据时不生成“最佳模型”结论。

## 当前完成门

- 四轴实现、完整归档和离线报告命令已有自动回归；生成 PDF 另做图片目视。
- 五组真实来源脱敏 v1 已生成并逐原始片段验收、独立重生字节复现；标签由 Codex 对照固定源审阅，不冒称外部人工认证。使用/模型材料隔离/许可与日期边界看 [`gold/README.md`](gold/README.md)，实际数量、24项及三份A4抽取报告看 [入库回执](../../docs/reports/gold-benchmark-ingestion-2026-11-12.md)。它们不是模型质量成绩，未知语义改写/未裁决STAR仍需独立复核。
- 首轮任务输出的只读候选自动冻结与完整重建校验已落地，历史五组内核夹具/PDF检验见 [冻结链回执](../../docs/reports/task-candidate-freeze-2026-11-12.md)。批量 tasks、异常失败归档/完整批次回执及本机实际运行见 [采样回执](../../docs/reports/task-benchmark-collection-2026-11-12.md)；当前真实样例不是脚本，格式失败也未伪造质量分。第二个不同实际模型、未知语义裁决、综合可比报告和周期执行仍待。
