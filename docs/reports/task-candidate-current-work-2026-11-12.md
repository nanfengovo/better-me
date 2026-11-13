# 进行中工作保留守卫与真实 v7 验收

后续更新：本批44条已全部独立另存操作者语义/STAR源审，44源内支持但仅2明确结果/14目的，31原样复制/12仅去前缀；写作质量仍未通过，见[44条源审](task-candidate-current-work-source-review-2026-11-12.md)。本报告的533资源263ec7b0…现为历史快照，当前安装/回退唯一看[Studio回执](studio-analysis-task-runtime-2026-11-12.md)的ca130f82…及独立零差异。原本批材料/候选/评分/PDF和事实继续有效，不因新源审倒改。

2026-11-12，`agent-os`。候选契约 v5 / 评测 v7 已把来源中明确标记为进行中的工作保留检查接入 Host 验收和原根修复。五例真实本机运行已完成并保留完整输入输出，**结构机制通过不代表简历写作质量通过**。完整目标保持 active；不同第二模型、可比周期、语义质量及剩余历史接手仍未完成。

本报告是该批次和当前桌面资源的权威停点，取代 v6 报告的“当前安装资源”定位；历史批次原件和评分继续有效。后续只读复核没有新增真实推理，没有重新打印旧 PDF 或刷新真实窗口。

## 反例、修复和适用范围

- 最小反馈环是 `apps/agent-host/tests/resume-candidate-coverage.test.ts`。原契约在源明确保留进行中工作时，仍可接受只有作品集的整份候选；同一反例连续两次红。新契约明确版本化为 `resume_candidate_v5`，旧契约不被倒改为失败。
- `resumeCandidateWorkInventory` 从完整源元数据建立清单，只处理 employment / internship / freelance。明确的 Since、有效年月到 Present/Current/至今、英文月份及中文年月等进行中格式可识别；原字段 Until Now 的特殊歧义投影只保留“进行中”标记，不推断日期顺序。
- 原日期字符串、全部组、全部原文与证据句柄均保留。不支持或已结束的日期、没有可引用原单元的工作列为未判定，不猜“近期”、不补月份、不编造职责或结果。源快照自述进行中，不是当前真实任职认证。
- `reviewResumeCandidateWorkCoverage` 要求每个 required group 至少有一条属于该组的引用。作品集、培训、研究、旧工作不能替代来源中的进行中工作。缺细节可以提问，不能以提问抹去已经存在的工作来源；全部旧工作和项目不被强制塞入一页。
- Host 先保存完整 wire，再记录 `candidate_current_work_omitted` 和完整 workCoverage，沿同一任务根、运行时和原预算修复。来源归属冲突仍优先报告；原额度耗尽停止，不开新根或隐藏重试。
- 冻结器独立重跑同版本检查，不能通过伪造“已接受任务”绕过。离线四轴报告为 v7 追加 currentWorkCoverage，批次投影为 metrics.currentWork，overallQualityPassed 固定 null。
- 这个检查只证明所需组被选中，不证明正文语义支持、岗位相关性、完整个人行动、STAR 或优秀表达；标题占位和泛泛职责也需要独立编辑审核。v1–v6 依各自原提示、材料和策略重建，不升级旧判断或改引用。

## 真实五例运行

campaign `local-5d649af757dd6e9d`；原运行 `/tmp/betterme-current-work-v7-yOZFvm/run`，完整日志同级 `collection.log`。正常认证 tasks HTTP / 生产 resolver / 新隔离身份，没有注入脚本 reasoner、复制账号凭据或访问私人简历。

模型 `betterme-eval-gemma4-e2b-ctx65536-20261112:latest`，digest `079c2aeeda6f9d859a9d7ed7ca09892af4eaf82bd8d9136966f7afaae0ceff0c`。完整提示、动态 grammar、模板、system 与 8192 保守余量最大需求 51123，配置及实载 65536；每例前后完整 catalog/context 原件已核对。

每例原上限 1 模型 / 1 工具 / 300000ms；实际 **5 模型 / 0 工具，5 可冻结 / 0 失败 / 0 未决**。自有采样 Host 正常结束，0 云端、无额外修复调用。累计八批 40 次仍是同一模型权重、不同协议，不是两个模型或同条件排名。

| 案例 / 原任务 | 正文条数 | 总 JD 覆盖 | 保守事实规则 | STAR 字面结构 | 实际 A4 / 垂直占用 |
| --- | --- | --- | --- | --- | --- |
| backend / ct_bf774b702d826886c3bb25372dcf2db0 | 4 | 9.3% | 100% | 81.25% | 一页 / 0.4253 |
| data-engineer / ct_1d6225e31877530a61e5f39f3b9b8b97 | 3 | 0% | 0% | 50% | 一页 / 0.2736 |
| frontend / ct_6185d8585b87f85d1f1a59856b378a2a | 4 | 0% | 100% | 0% | 一页 / 0.5252 |
| fullstack / ct_acb2f79f2924163cbe38896e7ff86ef0 | 23 | 0% | 100% | 13.04% | 一页 / 0.8067 |
| sre / ct_71449be42444df33422844bebb132980 | 10 | 0% | 0% | 32.5% | 一页 / 0.5362 |

共 44 条正文的实际引用均有有效坐标，不是 44 条事实批准。规则不识别的改写保守待审，0 分不等于全部编造；全栈无完整支持要求的“有据 JD 覆盖”分母仍为 null，不通过改 Gold 放宽。该批次 44 条尚未完成逐条独立语义/STAR 源审；v6 的 22 条审阅不能借给它。

### 发现的真实质量问题

- backend 保留所需 work-0，选 work-0/2/3，但省略 2023–2024 的 work-1，整体偏疏。进行中工作守卫不意味着全部职业时间线已完整。
- data-engineer 的两段实习日期均为结束状态，没有 required group；选出的 Airflow、Python/Requests/BeautifulSoup 和 Django 三条均保留真实原引用，但改写与 STAR 仍需语义复核，不能借规则结果认证。
- frontend 保留全部四个 work 组，却漏掉全部七个项目，包括源内 feeds 延迟 1400ms→100ms 的项目成果；保留原角色前缀和通用职责，还询问源项目已提及的 React 经验。原 `Until Now / 10,2022 (original fields; chronology unresolved)` 字段未被猜成日期。**保住任职没有解决选材和表达质量。**
- fullstack 保留进行中的 freelance，但有 23 条近原样通用职责，多次重复角色前缀，五个作品集/练习项目全部遗漏。占满一页不能算写得好。
- SRE 保留 work-0/1/2，未把 training work-3 升级为生产任职；改写的证据语义和结果仍待核实。

旧 v6 的五份完整原输出通过新规则离线回放，只有 frontend 缺 required work-0；其余无该 finding 不是质量批准。原状态不改，回放原件为 `output/agent-runs/resume-current-work-v7-replay-2026-11-12.json`，0 模型请求。

## 完整归档和复核

权威目录 `output/agent-runs/resume-quality-local-current-work-v7-2026-11-12/`。208 个 manifest 文件按完整字节数和 SHA-256 核对，完整材料 / wire / 问题 / task / 私有根成员 / 容量回执 / 五份全部页 PDF / 诊断保留。

- quality receipt：`275986bb979feede10c8bbf322ea44df12a8d1e04dd1f67a4ada9eede4742147`
- collection receipt：`b2cac86b7b9e934464ce033dda863de5cb291358a0ef53cd5d426f41bb3375c3`
- 旧 v6 collection 独立重建：`83cd79a918fe6f17d6566c9eb7702a33f73a8150c7a08ed523f87b90089f2599`；原 quality `50da570e8add320df8b8cf16c421a7f8508e17e118ca154c4f4dcef393159116` 不变。
- 旧 v5 collection 独立重建：`e08f6f91ddc11bd3fd5a6e688fcbe64fd6c5af69231ce61559430817496b00d4`；原 quality `ffec18f16775fad0a0967c721d19ef14e34736a3121b57bea93017c29a42ad4b` 不变。

五份真实 PDF 均经 pdftoppm 渲染并逐份目视，无缺正文、孤题、重叠或裁切；PNG 在 `tmp/pdfs/current-work-v7-2026-11-12/`。这只证明本批排版完整，不为稀疏选材或冗长职责提供审美背书。没有重打印旧 PDF。

后续只读复核再次核对 208 文件，使用正式 reviewCollection(verifyOnly:true) 从耐久目录重建 collection receipt 字节相同，且当前安装 533 文件仍匹配。耐久复核回执为 `output/agent-runs/resume-current-work-v7-verification-2026-11-12.json`；原首轮核验 `/tmp/betterme-current-work-archive-verification.json` 保留。复核不调用模型。

## 定向验收和桌面资源

- 最终 **73 Host/Eval + 41 运行时 + 14 Desktop = 128 项定向通过**，无失败/取消/跳过，不是全仓测试。日志分别 `/tmp/betterme-current-work-final3-regression.log`、`-runtime-regression.log`、`-desktop-tests.log`。
- 新增四项 Host 反馈环覆盖源清单的确定/未知/多组/无据格式、单额度拒绝、原根两次完整修复和重启不重发、旧 v4 不升级；HTTP collector 另验证两份完整尝试及缺组拒绝归档。冻结层验证伪造接受不能绕过。
- Contracts / Host / Web 类型、Host 构建、定向 ESLint、完整 pnpm desktop:build 通过，日志前缀 `/tmp/betterme-current-work-`。其中一次新评测测试的目录/返回值夹具错误已修正后重跑；没有修改生产逻辑来放宽断言。
- 当前安装 `BetterMe.app/Contents/Resources/app/dist` 533 文件与构建逐路径/大小/SHA 无差异。安装 DFS `263ec7b02f33a2aadd79cbd16b5a67893932be4829209381fda5a262bc7dd146`，独立排序 manifest `386bc3a4ab71e6c071886368d1fbfa1deb268199f81b9745d1751bd0d5080fb1`，Web `f3fbbebbf0e467ac40e40d3579a74ff1e8c9fde6732e77195a9ce45860d03fa5`。
- 可回退副本 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-kCy52K/previous-dist`，紧邻前版 DFS `2afc50e0397b1ac3a71c208607b9bbc40d3262e974c9c4aa34590dfd90b774ac`。`/tmp/betterme-current-work-sync.json` 与 `-installed-manifest.json` 保存核对依据。
- 安装成品 Electron 34.2 的 main/preload/React 离线两窗口完成，3 assets / 4 合成读取 / 0 实际服务或模型调用，退出 0。日志 `/tmp/betterme-current-work-installed-smoke.log`；隔离 profile `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-zUx3fR/summary.json`，其中 GPU 诊断未使运行失败。
- 真实窗口未强刷、原 Host 未重启，源码链接 Host 在下次正常启动加载新实现。个人原 PDF、FactBase、草稿、凭据与无关 dirty 改动保留，未 stage / 提交 / 推送。后续只读收尾没有再次替换 App。
- 最后一次定向 ESLint（包含新增 HTTP 修复归档测试）退出 0，日志 `/tmp/betterme-current-work-final-lint-verified.log`；项目 Memory Bank 检查和 git diff --check 通过。收尾仅新增耐久核验产物及文档/项目停点，不需要再替换桌面资源。

## 第二模型路径与下一门

2026-11-12 15:36 的只读本机目录仍只有同权重两个配置，以及带 remote_host 的 gemma4:31b-cloud 别名；未调用 cloud、下载新模型或改全局服务。

用生产 RuntimeRegistry + NativeAccountTools、全新空私有目录做真实 Codex 离线协议预检，返回 available=true / needs_authorization。该回执确认新 benchmark 身份没有授权，不表示用户原 BetterMe 账号的既有授权失效。没有读取/复制任何既有登录、发起登录或模型请求；完整预检结果合并保存在耐久复核回执中。官方 [非交互执行说明](https://learn.chatgpt.com/docs/non-interactive-mode) 说明 exec 默认复用保存的 CLI 授权，但这不授予跨 BetterMe owner 复用权限。

下一步需要明确选择：在原已授权 BetterMe 账号内通过正常 tasks 路径，仅对这五组公开脱敏材料运行 Codex，或为隔离 benchmark 账号另行官方授权。选择前不复用凭据或自行启用付费 API/cloud；已有原材料/协议/模板/预算保持不变，失败仍进全分母。此次没有第二模型推理，不能声称同条件对比或周期完成。

其余完成门：新 44 条语义/STAR 和代表性项目选择、改写错引处理及留出反例；真实不同第二模型同条件报告与实际周期；多根冲突/资料授权变化及更广历史接手；R1–R8 最终逐项成品审计。不要继续把同权重改协议或守卫通过计作写作质量改善。
