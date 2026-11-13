# 整稿写作方法接入与真实v5质量回放

后续来源归属已接入Host候选验收，当前资源/回退与新五例结果见[来源归属v6回执](task-candidate-attribution-2026-11-12.md)。本报告的v5完整原件/质量反例仍有效，42da04e1…资源为历史快照；旧输出未用新规则倒改。

2026-11-12，`agent-os`。本轮补上直接候选分支遗漏的共享写作方法，增加独立整稿审阅，并以原五例、同一本机权重和原单次预算实际运行。**5/5返回完整可评测候选，不等于质量通过；整体目标仍active。** 未使用个人简历、云模型或真实账号凭据，未采用候选、写FactBase、重启原服务或提交推送。

## 写作链路与版本

- `resume_candidate_v3` 是显式新Host编辑策略，保留v2来源绑定wire的 `schemaVersion:2`。原phase/动态同组schema、owner运行时、根账、修复计量及全部源文本不变；v1/v2旧提示不悄悄升级。
- 实际reasoner提示接入 `resumeWritingMethod("tailor")`，再约束整稿：近期经历/具体交付/本人动作和有据结果、互补贡献、原责任及学术/移动/培训/团队边界、缺事实针对性追问。方法不是模型训练或申请人证据；本轮证实提示抵达，不宣称模型已经稳定遵循。
- Eval默认协议为 `resume-quality-task-candidate-v5`，旧v1–v4按原请求重建。正常认证tasks HTTP/生产resolver派送，无第二SDK、隐式重试、来源/输出裁剪或备用云模型。
- 红绿信号：`pnpm exec tsx --test apps/agent-host/tests/resume-candidate-editorial.test.ts`。原v2实际prompt缺少共享编辑方法的断言先失败；新v3通过，测试明确保留历史v2策略。具体质量反例另由真实采样及源审判断，不以提示字符串断言代替质量验收。

## 独立整稿审阅

`evals/resume-quality/editorial.mjs` 在冻结包重建后读取完整来源清单，不只看模型选中的组；Gold支持/STAR标签只在离线评测，未发送生成模型。

- 全量未选经历/项目及原日期、有据JD要求覆盖/部分支持/真实缺口、结果缺失/尚未表达、重复/仅标题bullet完整展示。
- 按明确 `Since YYYY` / `YYYY-YYYY` 建立部分顺序；不补月份、不推测歧义日期，同结束年不强判先后。保留模型实际组顺序，不按源清单排序掩盖倒置。
- 完整候选措辞仅出现在另一个源组时提示疑似错挂，保留可能来源的完整文本/hash/kind；不自动换引用或把研究经历升格为实习交付。句末标点可成为源署名后缀，匹配仅忽略句末标点、保留全部内容词和限定语；匹配只产生审阅线索、不授予事实信用。
- v5显式写 `automaticChecksScope=["antiHallucination","layout"]`；`overallQualityPassed=null`。无规则发现也不是总体合格。未选所有旧项目不自动判错；没有源结果应追问，不为STAR编指标。

## 实际运行与完整归档

campaign **local-8bc58fa0eba88496**；原目录 `/tmp/betterme-editorial-v5-UkA07t/run`，日志同级 `collection.log`。默认生产Host/正常认证tasks，全新隔离身份。模型 `betterme-eval-gemma4-e2b-ctx65536-20261112:latest`，digest **079c2aeeda6f9d859a9d7ed7ca09892af4eaf82bd8d9136966f7afaae0ceff0c**（同前批Gemma权重，不是不同第二模型）。

完整提示/动态schema/系统模板及8192保守余量，最大需求47505；配置/实载上下文65536，前后catalog/show/ps原件保留。每例1模型/1工具/300000ms原上限，实际各1模型/0工具；没有超时/重发/未决，0云端。五次活动时间依次40528、32701、64267、34241、55676ms。

| 案例 / 原任务 | 正文条数 | 总JD覆盖 | 保守规则事实核准 | STAR字面结构 | A4 / 垂直占用 |
| --- | --- | --- | --- | --- | --- |
| backend / ct_f82c0a397312b045fd98d321f47b1afd | 4 | 0% | 0% | 81.25% | 一页 / 0.3824 |
| data-engineer / ct_a245ed6d74ca1211e1310e6f35050e31 | 5 | 0% | 0% | 20% | 一页 / 0.3255 |
| frontend / ct_3a4bb7838a80d5760608ea3341c4c4f7 | 5 | 0% | 0% | 40% | 一页 / 0.5292 |
| fullstack / ct_eda2483cef6f4895ae9d2a7ea3719277 | 4 | 0% | 0% | 0% | 一页 / 0.3774 |
| sre / ct_601fd932097fde1f31a51fe1be4b2cc0 | 13 | 0% | 0% | 25% | 一页 / 0.7119 |

共31条/31个有效解析引证，0无效坐标。所有措辞仍需独立改写复核；许多只是删除已在组标题展示的角色前缀，并不意味着31条全部编造。**没有为本轮修改旧事实/覆盖/STAR评分或补批准标签。** 全栈原Gold为31缺口/4部分支持、0完整支持要求；有据要求覆盖分母为空，另列null，不能把总覆盖0%全归咎模型或把部分支持改成完整支持。

当前完整权威目录：`output/agent-runs/resume-quality-local-editorial-v5-attribution-2026-11-12/`。208个manifest文件逐大小/SHA核验，包含完整输入/wire/源/私有成员/前后容量/5份PDF/诊断；质量receipt SHA **ffec18f16775fad0a0967c721d19ef14e34736a3121b57bea93017c29a42ad4b**，collection receipt SHA **e08f6f91ddc11bd3fd5a6e688fcbe64fd6c5af69231ce61559430817496b00d4**。核对 `/tmp/betterme-editorial-v5-final-archive-verification.json`。先前同轮不含最终归属提示的报告保留为历史快照，不是新增采样。

## 实际反例及目视结论

- 后端已选当前work-0和具体多租户/IoT/迁移交付，但顺序work-0→work-3(2018–2021)→work-1(2023–2024)仍错误；最终归档审阅确实检出1处倒置，未自动重排。
- 数据工程bullet-3/4/5只引item-19的Amazon抓取实习，却写EoR/CNN/X-ray研究。完整原源item-14/15/13属 `research-achievements / academic`，最终归档审阅确实提示3处疑似迁移；来源在别处存在也不能替本实习补证。这些不是普通改写未知而已。
- 前端保留具体移动项目/原延迟数字，但省略所有work组；项目不等于完整任职史，原歧义日期不猜。缺少近期任职上下文仍待编辑审阅。
- 全栈加入Shoutbox及旅游网站，较此前通用职责更多交付对象，仍有泛化措辞/源自述SEO及范围限定待核，不据单批称改善显著或最佳模型。
- SRE四个源组均出现，13条、培训明确另列；大部分为删角色前缀的源内表达，仍未有独立语义批准/完整结果，不能把规则零分误读为全造假。

五份实际全部页A4渲染/提取检查无缺正文、孤题、横向溢出或裁切，PNG位于 `tmp/pdfs/editorial-v5-2026-11-12/`，均已目视；后端/数据工程仍明显过疏，未发明密度阈值或删字换一页。PDF只用于匿名评测，不能作为个人投递版交付。

## 验证与双端

- 最终定向Host/Eval回归100项、Desktop14项（文件集不重叠）；具体最终结果看 `/tmp/betterme-editorial-v5-final-regression.log`、`/tmp/betterme-editorial-v5-desktop-tests.log`。不是全仓全绿。采样器夹具同步新协议wire，未减少原丢回执/完整超量/失败分母断言。
- Contracts/Host/Web类型、Host构建、定向ESLint零警告、完整 `pnpm desktop:build` 通过；日志 `/tmp/betterme-editorial-v5-{contract-types,host-types,web-types,host-build,lint,desktop-build}.log`。
- 安装533资源逐路径/大小/SHA与构建0差异，DFS清单 **42da04e15aab31ffbf8b941c9fe5faeee008af94dfa911341d3ffe7dbdad5f73**，Web **950ed172d963753b1c84b8fbb109db6805aaa095ce307f85c332142b4ea2bd4c**；独立排序清单 **d1fab1550bc6646b9d893c6eb49b767acabe6cb6571723e1c088ed557fc14af9**。sync/独立核对同前缀 `sync.json` / `installed-manifest.json`。
- 完整回退 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-RzVJdg/previous-dist`（原59a76b93…）保留；未启动/刷新真实窗口，原5173 PID90086、5179 PID89415不变，source-linked Host下次正常启动加载新代码。
- 安装main/preload/React离线两个窗口smoke通过：`/tmp/betterme-editorial-v5-installed-smoke.log`，profile `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-Hs84Dk/summary.json`。3 assets/4合成读取/0实际服务模型调用，非正式账号业务验收。

旧v2/v3/v4完整collection回执离线重建哈希分别仍89bf7ad0… /52a5366e… /823d8719…，原v4全部181归档文件hash不变，四例所有分数/布局重算一致。新打印PDF自身二进制hash变化，故新完整质量receipt不是旧2bfb505f…；不能把“原件未改、分数/布局一致”表述为“重打印全部字节一致”。诊断 `/tmp/betterme-editorial-v5-old-v4-verification.json`；原始PDF/旧失败未改写。

## 剩余完成门

本轮是写作策略及审阅机制的真实推进，不是四轴整体通过。继续独立语义/STAR裁决、近期任职完整性及错挂的生成侧改进；同五例/完整材料hash/协议/模板/原预算比较第二个真正不同模型并实际周期运行。Gold领域代表性、历史多根/资料授权变化和最终全目标审计仍待。不默认下载、启用cloud、复制账号凭据或业务采用。
