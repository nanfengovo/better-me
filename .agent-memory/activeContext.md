# Active Context

## 当前焦点

2026-11-20 本轮已关闭已发现的简历 Agent 可靠性故障。正常文字任务经完整选材、字段绑定的本人确认、逐条证据审批与独立版本保存，模型短编号选择由 Host 落到真实来源，截断可安全进入人工复核。最终冻结源码实测三组两轮 6/6、12 次实际模型返回均完整，项目原句三组 3/3、24/24 工具和 6/6 Token 回执。裁判三组 32/32 组合判断吻合，原模型 25/32，24 条非支持材料中零误自动通过。全仓主组 5301/0、20 条件跳过，质量组 88/88，最终专项 84/84，双端已构建并同步相邻 `BetterMe.app`。当前无本轮已知验收卡点。下一步按实际使用反馈增加独立留出案例及经授权的材料评估，现有结论限本机模型和合成数据。必读附加为 `docs/reports/agent-reliability-closure-2026-11-20.md`。

2026-11-20 追问是否全部修好，新增同名项目回归：同账号、同工作区、同项目标签和同名文件、两个独立项目标识，跨项目授权读取及引用均被拒，分别确认并重启读回两份正确材料；原句、更正、简历定向修改相关专项合计 37/37。真实简历两轮改写仍缺完整通过记录，前次停在首轮原简历引用校验；独立模型表现与裁判误判仍是评估事项。下一步核对完整两轮真实改稿及跨多个独立样本的语义覆盖。必读附加为 `docs/reports/resume-agent-reliability-2026-11-20.md` 和 `docs/reports/agent-runtime-knowledge-evaluation-2026-11-20.md`。

2026-11-20 已把同一个仓储项目接入自研运行时、项目证据和模型版本评测。任务通过真实进程重启和重复确认验收。明确索要原句时，模型选取已授权行，Host 重读、核验并生成证据，推断和未知分列。独立模型 × 提示 × 检索版本八格为 2/8 全对，所有格均能检索到材料。下一步用其他独立项目检验语义漏项、错归属及两轮简历修改后的证据保持。必读附加为 `docs/reports/agent-runtime-knowledge-evaluation-2026-11-20.md`。

2026-11-20 简历 Agent 可靠性已加入本地评测。定向修改按句序保护已确认内容；新采集可按模型返回核对耗时和 token；固定裁判样本与真实本机改稿分别出结果。Gemma 裁判全体吻合 5/12，两例误放。真实改稿首轮只改对了 Redis 的文字，却因漏引原简历句而被拒，未进入第二轮。下一步优先验证如何可靠带上原句和新增材料这两类引用，同时保持逐句审批。必读附加为 `docs/reports/resume-agent-reliability-2026-11-20.md`。

2026-11-19 用户授权将本轮按需训练、职业任务关联和复测推荐推送到既有 agent-os 分支。README 已更新使用流程；本地全量测试主组 5,178 项通过，另有 PDF 1 项与简历质量 64 项通过，类型、Lint 与双端构建通过。待核对远端推送及 CI 状态。必读附加为无。

2026-11-19 晚间已启动当前 agent-os 开发服务。Web 5173 与当前源码的 Agent Host 5179、岗位服务 5178 已就绪，健康检查均为 200。旧开发 Host 已重新启动以使用最新复测推荐代码，侧边浏览器申请打开 AI 顾问页（应用返回 queued）。下一步为用户实际体验训练工坊。必读附加为无。

2026-11-19 现有训练工坊已接通异题复测后的下一练。Agent 对照首答、本人改写及其发生时间、换题作答和站内帮助记录，为下一项目标给出逐条可核对的理由。用户采纳后按推荐的目标和练法生成新题，职业任务可主动保留本轮证据及建议。下一步可依据实际学习者反馈评估多轮使用的效果。必读附加为无。

2026-11-19 训练工坊支持已提交开放题的定点点评和本人改写。目标和题目决定观察重点，英语语法、工作沟通和设计取舍共用入口。点评绑定原题、原答与生成练习的本机模型版本。本人保存的改写可以作为受助来源进入补练，独立首答和复测时间各自保留。已关联的职业任务支持分别存下原答、点评或改写后的记录。阶段范围是文字作答；长期掌握仍需独立换题观察。

2026-11-19 工坊已把通用练习生成接入现有职业 Agent。普通入口可只填目标，本机模型选择练法、生成材料、安排换情境复测，用户可在生成前调整练法。排序、数值、JavaScript 单参函数和开放表达可组合；作答后按步骤核对，选择具体原答可带着版本、提示记录和证据生成补练。旧版本及职业任务回写兼容。Web 与 Electron 合成账号已跨端验证编辑练法、代码运行、按原答补练。现阶段代码限受控标量函数，工程项目运行和英文口语录音评估仍待扩展。下一步从真实使用反馈判断最需要增加的底层交互。必读附加为无。

2026-11-19 职业学习与按需训练首期闭环已落地 `agent-os`。JD 原句选择后，用户确认能力目标并绑定已采纳计划里的具体任务与验收项。Host 从当前账号存储解析关联、冻结题目版本及计划来源，Ollama Agent 负责诊断和设计，QuickJS 和独立规则核对练习。24 小时后换题，原答、题目版本、提示使用和检查结果可回到原任务；计划替换后旧任务仍可查看并保存复测证据。实际隔离浏览器首练、Electron 同账号换题复测及原任务复盘均通过，0 页面异常；本机 Gemma 真实生成三次调用、7 组沙箱校验、两题不同。Lint、16 项类型任务、9 项双端构建、最终定向 Web 51 项与 Host 13 项、桌面 24 项、运行时 13 项、已装 Electron 主进程和 preload 烟测通过。本机 BetterMe.app 已同步 623 项资源；最终资源摘要为 `80d0b8176e1c725ede7d6d2b372f8c36a6283cacae80be8ed35422d6ffa4ddba`。本轮卡点为真实 C# 项目沙箱、阅读资料版本及跨岗位能力聚合尚未扩展；无个人资料或远端发布变更，未运行全仓单测。下一步继续扩展同一业务链路。必读附加为无。

2026-11-19 `agent-os` 本地审查的 2 项 P1 和 8 项 P2 已修复并验收。桌面招聘浏览器共用网络设置并写入私有目录，退出等待浏览器和 Agent 用量，跨来源同步核验一次性授权。工坊暂停后台轮询，朗读、DOCX 照片和旧壁纸都通过回归。本机 `BetterMe.app` 已同步 623 项资源并留有完整回退备份。卡点为 Windows 和 Linux 实机尚未验证。下一步核对本次提交的远端 CI。必读附加为无。

2026-11-19 第九轮 P0 回归清零、安全加固、静态资源瘦身与 CI 门禁收口（本地 agent-os）：
- P0 回归与模块探针修复：[atlas-workspace.test.tsx](apps/web/tests/atlas-workspace.test.tsx#L92) 补齐 `"./AtlasJobDetail"` 相对导入拦截以适配上轮抽出的 `AtlasJobDetailPane.tsx`，地图工作区回归 `89/89` 全绿；[agent-guide.ts](apps/web/src/lib/agent-guide.ts) 将 `beacon.innerHTML` 拼接改为 `createElement` + `textContent`，并新增 [agent-guide.test.ts](apps/web/tests/agent-guide.test.ts) 验证非转义 payload 不会注入 DOM。
- 桌面端 IPC 与 HUD 加固：[apps/desktop/src/main/index.ts](apps/desktop/src/main/index.ts) 为 4 个 `ipcMain.handle` 补齐 `trusted(event)` 主框架来源校验、严格 URL 协议/凭据校验并将菜单与 HUD 触发统一收口为不暴露预置数据的安全提示（`isolated-qa.test.cjs` 增加拒绝非信任调用断言）；[hud-window.ts](apps/desktop/src/main/hud-window.ts) 开启 `sandbox: true` 与 `webSecurity: true`，彻底清除硬编码虚假 RCS/4.2x/FB-02 示例话术与 `innerHTML` 拼接。
- P1 资源瘦身与版权风险清理：Dock 图标 [icon-atlas.png](apps/web/src/components/desktop/assets/icon-atlas.png) 由 `1.7M` (`1254×1254`) 压缩至 `84K` (`256×256`)；清理 `apps/web/public/wallpapers/` 10 张第三方动漫图片及缩略图并从 [preset-wallpapers.ts](apps/web/src/lib/preset-wallpapers.ts) 移除 `anime` 分类，3 张 `vork_*.png` 转为 `1920px` JPEG 并压缩其余壁纸（`wallpapers/` 由 `55M` 降至 **`14M`**，`apps/web/dist` 总体积由 **`135M` 降至 `92M`**）；[DesktopShell.tsx](apps/web/src/components/desktop/DesktopShell.tsx) 新增壁纸 `onError` 回退。
- 透明化标识与 CI 门禁：[AutopilotNodeInspector.tsx](apps/web/src/components/autopilot/AutopilotNodeInspector.tsx) 新增中英双语「监控与快捷入口 / Monitor & shortcut」标识，清晰区分通用监控节点与 `#10/#11/#13/#19/#20` 交互节点；[verify-golden-flow.mjs](scripts/verify-golden-flow.mjs) 与 [ci-pages.yml](.github/workflows/ci-pages.yml) 将 `CI=true` / `BETTERME_GOLDEN_REQUIRED=1` 缺少浏览器时的静默跳过改为明确失败。
- 第九轮全仓终验（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`（9/9）、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test:golden`（5 步闭环 + `resume-zh-Lin Golden Flow.docx` + `spokenUtterances: 1`，`pageErrors: 0`）、`pnpm test`（隔离 PDF `1/1` + 主单测 `5,117` 通过 / `0` 失败 / `20` 条件跳过 + `test:resume-quality` `64/64`）与 `BetterMe.app` 624 资源同步（`installedHash: 5276e0d8d7204b5a3cb757ba1f009f5e9b5be427ffc4e9ce9a5080d15a1614ee`）全部通过；未自动 `git commit` 或删除父目录备份。必读附加：无。

2026-11-18 第八轮规模压测核验与超大组件持续拆解（本地 agent-os）：
- 5k/15k 规模与增量压测全绿：修正 [atlas-snapshot-sync-scale.test.ts](apps/web/tests/atlas-snapshot-sync-scale.test.ts) 以兼容分页增量 `jobs.sync-pages` / `jobs.baseline-page`，完整 `BETTER_ME_SCALE_BENCH=1 BETTER_ME_PROJECTION_BENCH=1 BETTER_ME_ENRICHMENT_BENCH=1` 6 文件 **`43/43` 通过**（15,000 岗位热查询 `0.62–1.97 ms`、`1,086×–1,814×` 加速、caller 最大事件循环延迟 `51–57 ms`、三批增量同步合计仅传 `147.6 KB`）。
- 超大工作区模块拆解：从 [AutopilotStudioWorkspace.tsx](apps/web/src/components/AutopilotStudioWorkspace.tsx)（`2,027 → 1,935` 行）抽离 [autopilot-pipeline-mappers.ts](apps/web/src/components/autopilot/autopilot-pipeline-mappers.ts) 并更新 `ui-audit-regressions.test.tsx` F21 映射断言；从 [AgentWorkspace.tsx](apps/web/src/components/AgentWorkspace.tsx)（`2,415 → 2,278` 行）抽离 [AgentEmptyPromptCards.tsx](apps/web/src/components/agent-workspace/AgentEmptyPromptCards.tsx) 与 [AgentActiveJobHeader.tsx](apps/web/src/components/agent-workspace/AgentActiveJobHeader.tsx)（完整保留 3 处 F03 IME 键盘处理器）；从 [AtlasWorkspace.tsx](apps/web/src/components/AtlasWorkspace.tsx) 抽离 [AtlasEmptyJobList.tsx](apps/web/src/components/atlas/AtlasEmptyJobList.tsx) 与 [AtlasJobDetailPane.tsx](apps/web/src/components/atlas/AtlasJobDetailPane.tsx)。

2026-11-18 第七轮主包压入 500 kB、Kernel 抽离与端到端真实对话/朗读全链路闭环（本地 agent-os）：
- 首包压入 Vite 阈值以内：[App.tsx](apps/web/src/App.tsx) 将 `AgentCompanion` 改用 `React.lazy` 惰性挂载；[vite.config.ts](apps/web/vite.config.ts) `manualChunks` 进一步分离 `vendor-yaml`、`fact-editor`（`100.23 kB`）、`desktop-shell`（`162.51 kB`）、`agent-sidebar-shell`（`121.01 kB`）与 `better-me-opportunities`（`149.91 kB`），主块 `App-*.js` 降至 **`456.69 kB`**（gzip `156.47 kB`，首次进入 500 kB 以内）、`App-*.css` 降至 **`178K`**。
- 模块继续瘦身：从 [kernel/service.ts](apps/agent-host/src/kernel/service.ts)（`1,535 → 1,495` 行）抽离 [kernel/kernel-helpers.ts](apps/agent-host/src/kernel/kernel-helpers.ts)（`205` 行纯 Store/预算/阶段与提示词构造工具）；从 `AtlasWorkspace.tsx` 抽离顶部主搜索、采集范围弹窗与连接提示组件 [AtlasPrimarySearchBar.tsx](apps/web/src/components/atlas/AtlasPrimarySearchBar.tsx)。
- 端到端闭环覆盖真实对话与自动朗读：[verify-golden-flow.mjs](scripts/verify-golden-flow.mjs) 集成隔离本地 OpenAI 兼容模拟模型服务与 `speechSynthesis` 探测，真实跑通「本机注册 → FactEditor 中文姓名编辑 → 预览实时更新与 `resume-zh-Lin Golden Flow.docx` 下载 → 系统设置保存本机模型与选定 Agent 来源 → 提交示例 JD 并开启自动朗读 → 对话回复到达并触发 1 次本机语音播报（`spokenUtterances: 1`，0 `pageErrors`）」。
- 第七轮全仓终验（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test:golden`（5 步闭环通过）、`pnpm test`（隔离 PDF `1/1` + 574 文件主单测 `5,116` 通过 / `0` 失败 / `20` 条件跳过 + `test:resume-quality` `64/64`）与 `BetterMe.app` 644 资源同步（`installedHash: 75f2a279...`）全部通过；未自动 `git commit` 或删除父目录备份。必读附加：无。
- 第六轮零 `as any` 收口、Vite 分包、地图抽离与黄金链路进 CI（本地 agent-os）：
- 零 `as any` 收口：清理全仓生产代码最后 `21` 处 `as any`（[MapLibrePrototype.tsx](apps/web/src/components/atlas/prototypes/MapLibrePrototype.tsx) 13 处改用 `maplibre-gl` 原生 `FilterSpecification`/`ExpressionSpecification`/`GeoJSONSource["setData"]` 参数类型，[file-parsers.ts](apps/web/src/lib/file-parsers.ts)、[AtlasWorkspace.tsx](apps/web/src/components/AtlasWorkspace.tsx)/[card-badges.ts](apps/web/src/components/atlas/card-badges.ts)、[DesktopSettings.tsx](apps/web/src/components/desktop/DesktopSettings.tsx)、[resume-prefill.ts](apps/web/src/components/atlas/resume-prefill.ts)、[server.ts](apps/agent-host/src/server.ts) 与 [office-address-provider.ts](apps/job-service/src/office-address-provider.ts) 全部替换为严格窄接口，生产源码实测 `0` `as any`）。
- 黄金链路接入与精确断言：[package.json](package.json) 新增 `"test:golden": "node scripts/verify-golden-flow.mjs"`，[ci-pages.yml](.github/workflows/ci-pages.yml) 在 `pnpm build` 后接入该步；[verify-golden-flow.mjs](scripts/verify-golden-flow.mjs) 精确锁定 `FactEditor`「中文姓名」输入框，端到端校验导出 `resume-zh-Lin Golden Flow.docx`。
- 分包与地图抽离：[vite.config.ts](apps/web/vite.config.ts) 配置 `manualChunks` 拆分 `vendor-react`、`vendor-lucide`、`vendor-zod`、`template-catalogs`（`244K`）与 `better-me-core`（`247K`），`App-*.js` 进一步由 `1,076.55 kB` 降至 `961.81 kB`、`App-*.css` 由 `490K` 降至 `342K`；从 `AtlasWorkspace.tsx`（`2,312` 行）抽离 [atlas-live-harvest-notice.ts](apps/web/src/components/atlas/atlas-live-harvest-notice.ts)。
- 第六轮全仓最终门禁（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test:golden`（`resume-zh-Lin Golden Flow.docx`，0 `pageErrors`）、`pnpm test`（隔离 PDF `1/1` + 主单测 `5,116` 通过 / `0` 失败 / `20` 条件跳过 + `test:resume-quality` `64/64`）与 `BetterMe.app` 629 资源同步（`installedHash: 1a3fa296...`，保留最近 2 份 `.unified-agent-app-*` 备份）全部通过；未自动 `git commit` 或删除父目录历史备份。必读附加：无。
- 第五轮后端搜索拆解、地图筛选抽离、主包瘦身、每会话自动朗读与端到端黄金链路验收（本地 agent-os）：
- 搜索核心拆解：`apps/web/server/jd-live-batch-search.ts`（`2,151` → `396` 行）按单一职责拆出 [jd-live-search-cards.ts](apps/web/server/jd-live-search-cards.ts)（`1,095` 行，卡片规范化、分页判定与预算边界）与 [jd-live-cdp-capture.ts](apps/web/server/jd-live-cdp-capture.ts)（`731` 行，原生 CDP 抓取执行器），通过主入口保持对外导出兼容（`jd-live-*` 74/74 通过、`noUncheckedIndexedAccess` 与 0-warning lint 通过）。
- 地图模块化与首包按需拆包：从 `AtlasWorkspace.tsx`（`2,521` → `2,351` 行）抽出 [AtlasQuickFilters.tsx](apps/web/src/components/atlas/AtlasQuickFilters.tsx) 与 [AtlasSettingsModalBody.tsx](apps/web/src/components/atlas/AtlasSettingsModalBody.tsx)；将 `ResumePreview.tsx` 的 `docx-export` 改为点击导出时动态加载，并在 `App.tsx` 将 `ImportSourceReview` 与 `ResumeDesignPanel` 切回 `React.lazy`（`App-*.js` `1,076.55 kB` / gzip `348.67 kB`，`ResumeDesignPanel`/`docx-export`/`ImportSourceReview` 独立分包）。
- 可选每会话自动朗读开关：[AgentSpeechControl.tsx](apps/web/src/components/AgentSpeechControl.tsx) 新增纯内存 `useSessionAutoSpeech` 与 `AgentAutoSpeechToggle` 并接入 `AgentCompanion.tsx` 与 `AgentWorkspace.tsx`（默认关闭、开启时记录已有消息快照绝不回放历史、仅自动本机朗读新到达且通过 `canReadReply` 核验的完整助手回复、失活/关闭/切换会话立即停止并复位）；补充 [session-auto-speech.test.tsx](apps/web/tests/session-auto-speech.test.tsx)。
- 端到端黄金链路门禁：新增隔离环境 Playwright 脚本 [verify-golden-flow.mjs](scripts/verify-golden-flow.mjs)（自启临时 `agent-host` + 静态构建代理），自动化验证本机账号注册 → FactEditor 编辑与预览同步 → DOCX 真实文件下载 → AI 顾问提交示例 JD 与自动朗读开关切换（0 `pageErrors`）。
- 全仓复验（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（exit 0，`rendererMounted: true`）、`verify-golden-flow.mjs`（`status: passed`）、`pnpm test`（隔离 PDF `1/1` + 574 文件主单测 `5,116` 通过 / `0` 失败 / `20` 条件跳过 + `test:resume-quality` `64/64`）、`BetterMe.app` 639 资源同步（`installedHash: 03520a51...`）、`pnpm memory:check` 与 `git diff --check` 全部通过；未自动 `git commit` 或删除父目录历史备份。必读附加：无。

2026-11-18 第四轮首屏 CSS 瘦身、桌面桥强类型、F21 收口与深度模块化（本地 agent-os）：
- 桌面桥全局类型 & F21 双语完善：`apps/web/src/vite-env.d.ts` 新增 `DesktopBridgeApi` 与 `Window.desktopApi` 全局声明，清除 `AutopilotStudioWorkspace.tsx`、`DesktopShell.tsx`、`IdentityGate.tsx`、`ResumePreview.tsx` 的强转；[AgentApplyModal.tsx](apps/web/src/components/agent-workspace/AgentApplyModal.tsx) 三步提示与 [autopilot-nodes.ts](apps/web/src/components/autopilot/autopilot-nodes.ts) `localizeStudioNode` 完成英文切换。
- 首屏 CSS 瘦身与持续拆解：将 16 个简历纸张与模板 CSS 从 `main.tsx` 登录前入口移入登录后按需加载的 `App.tsx`，登录前 `index-*.css` 由 `516K` 降至 `331K`（-36%）；进一步拆出 `BlueprintMicroChamber.tsx`、`CyberJobCard3D.tsx` 与 `AgentFitAnalyticsHeader.tsx`，将 `AutopilotStudioWorkspace.tsx` 降至 `2,027` 行、`AgentWorkspace.tsx` 降至 `2,413` 行。
- 全仓复验（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test`（隔离 PDF `1/1` + 主单测 `5,115` 通过 / `20` 跳过 + `test:resume-quality` `64/64`）与 `BetterMe.app` 634 资源同步（`caf4dbfe...`）全部通过；未自动 git commit。必读附加：无。

2026-11-18 第三轮持久计量、严格索引与前后端模块化治理（本地 agent-os）：
- `ModelUsageMeter` 持久化与跨日滚动：`apps/agent-host/src/tasks/usage-meter.ts` 与 `apps/agent-host/src/server.ts` 支持 per-owner `owners/<id>/usage-metrics.json`（`0o600` 私有校验、`150ms` 防抖落盘、`drain()` 关闭前 `flush()`，并在本地跨日时自动重置）；新增持久化与跨日重置单测（`usage-meter.test.ts` 3/3）。
- `apps/web/tsconfig.node.json` 开启 `"noUncheckedIndexedAccess": true`：修复 `jd-native-edge.ts`、`jd-native-liepin-browser.ts`、`jd-managed-browser-proxy.ts`、`jd-native-boss-expand.ts`、`jd-boss-expand.ts` 与 `jd-cdp-dom-snapshot.ts` 全部越界索引检查（JD 全量测试 1,053 通过 / 1 跳过）。
- 前端超大工作区拆解：`AutopilotStudioWorkspace.tsx`（3,341 → 2,669 行）抽出 `autopilot/AutopilotAgentSprites.tsx` 与 `autopilot/autopilot-nodes.ts`；`AgentWorkspace.tsx`（3,497 → 2,651 行）抽出 `agent-workspace/AgentReplyActionsCard.tsx`、`AgentJdDetailsView.tsx`、`AgentProposalListSection.tsx`、`AgentApplyModal.tsx`，保持 `ui-audit-regressions` / `agent-workspace` / `agent-sidebar` 回归测试完全通过。
- 最新全量复验（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test`（隔离 PDF `1/1` + 主单测 `5,115` 通过 / `20` 跳过 + `test:resume-quality` `64/64`）及 `BetterMe.app` 634 资源同步通过；未运行 git 提交，保留既有未提交工作树修改与 `coding-engine.ts` 严格协议版本白名单。必读附加：无。

2026-11-18 第二轮架构补齐、打包对齐与性能优化（本地 agent-os）：
- 跨平台路径：`apps/web/server/job-atlas-paths.ts` 统一 `darwin`/`win32`/`linux`/`BETTERME_JOB_DATA_DIR` 路径解析，替换 `nearby-companies.ts`、`company-intelligence.ts`、`atlas-dev-index.ts` 中硬编码的 macOS `Library/Application Support` 路径。
- 桌面打包端能力与体验对齐：`apps/web/server/runtime-gateway.ts`、`apps/web/server/jd-desktop-bridge.ts`、`apps/desktop/scripts/build-runtime.mjs` 与 `apps/desktop/src/runtime/server.ts` 在 `mode === "desktop"` 下完整接入 `/api/network/*` 代理与定位中间件和 `/api/jd/*`（`jd-middleware.mjs`）提取/会话中间件，Docker 模式仍严格保持 `501`；`apps/desktop` 默认落地页由 `/?workspace=autopilot` 调整为 `/?workspace=resume`，并新增 `desktop:export-pdf`（`webContents.printToPDF` 直接导出 A4 PDF 文件）与 `ResumePreview.tsx` 桌面端一键保存。
- `App.tsx` 代码分割与履历盘点恢复：恢复 `CareerInventory` 主入口（工具栏按钮、导入后邀请提示、`ResumeWritingCopilot` 会话控制与对账），并将 `AgentWorkspace`、`OpportunityWorkspace`、`ResourceLibrary`、`AutopilotStudioWorkspace`、`VersionHistoryPanel`、`AiConfigModal`、`JdMatchModal`、`JdMatchDrawer` 切回 `React.lazy` + `<Suspense>`；`docx-export.ts` 支持本地安全 `data:image/*` 头像内嵌并保持远端 URL 阻断与单栏无表格语义。
- Autopilot 真实内核遥测与超大组件拆解：`apps/web/src/components/autopilot/autopilot-telemetry.ts` 与 `AutopilotNodeInspector.tsx` 接入真实 `AgentTaskKernel` 任务队列与 `/api/v1/agent/usage` 灵动岛统计，替换原静态 JSON 占位面板；提取 `atlas/atlas-filter-presets.ts` 与 `atlas/prototypes/maplibre-styles.ts`。
- 统一后端计量、卸载泄漏修复与同步脚本轮转：`apps/agent-host/src/tasks/metered-adapters.ts` 与 `server.ts` 将 `CapabilityService`、`CodingTaskService`、`LearningPaths`（`TrainingKits`/`pdf2zh`）与 `CareerStudio` 本地 Ollama 调用统一纳入 `ModelUsageMeter`；`VorkStudioCard.tsx`/`vork-client.ts` 增加 `AbortController` 卸载取消，清理 `desktop-shell.test.tsx` 异步泄漏；`scripts/sync-local-desktop-dist.mjs` 自动保留最近 2 个 `.unified-agent-app-*` 回滚备份。

2026-11-18 安全加固、I/O 优化与桌面能力对齐（本地 agent-os）：
- `apps/agent-host/src/server.ts` + `vork/service.ts` + `vork-client.ts` + `VorkStudioCard.tsx`：将 `/api/v1/agent/vork/*` 移入 `principal` + `X-BetterMe-Owner` 鉴权之后，HTTP 路由禁止透传 `sceneJson`，改为串行渲染队列与每请求私有临时目录（`0o700`）并在 `finally` 清理；前端使用 `ownedFetch` + 动态运行时令牌，移除硬编码 `/Users/feng/.local/bin/vork` 与 `Apple M1 Pro` 假回退；`makeOwner` 改为按需懒初始化 `runManager`。
- `apps/agent-host/src/capabilities/sandbox.ts`：QuickJS 沙箱 `BOOTSTRAP` 改用预捕获内建引用 + 间接 `eval` + `Function.prototype.toString` 源码核对，防止表达式逃逸与 `JSON.stringify` 劫持。
- `apps/agent-host/src/identity/service.ts` & `builtin-idp.ts`：`IdentityService` 增加基于 `lstat` 元数据的内存缓存并节流 `lastUsedAt` 落盘（10s），消除每请求多次全量 `fsync` 重写，同时将 `users`/`sessions`/`bindings` 上限放宽至 10000；`builtin-idp.ts` 使用原子串行写队列，并仅在 `BETTERME_DEV_AUTO_OIDC=1` 时开放 `auto_subject`。
- `apps/agent-host/src/kernel/service.ts`：`AgentTaskKernel` 新增 `rootIndex` 并在 `rootState()` 中复用 `storeCache`，消除心跳/查询时对无关任务文件的 `readPrivateJson` 重复读取。
- `apps/web/server/runtime-gateway.ts` & `opportunity-sources.ts`：桌面打包网关（`mode === "desktop"`）接入官方 ATS `/api/opportunities/source` 端点，补齐与 Vite dev 的非浏览器来源拉取能力对齐。
- 验证：全仓 `pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`（9/9）、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、安全/身份/内核/沙箱/来源专项测试（55/55 + 前轮 206/206）与 `git diff --check` 全部通过；598 个 `BetterMe.app` 资源已同步（备份 `.unified-agent-app-MFoyU4`），未重启既有运行中服务或清理根目录历史副本。下一步按需运行完整 `pnpm test` 并整理提交当前工作树改动。必读附加：无。

2026-11-17 模型配置与使用提示（本地 agent-os，独立于下方已发布版本）：配置窗口已区分保存连接、选择 Agent 来源和运行生成测试；授权前可看到原模型与待测模型冲突，并直接保存或只查列表。旁批、共享额度和来源设置给出实际入口。隔离 Web / Electron 验证提示进入可视区、教程轮廓不穿透、草稿可恢复；没有调用真实云模型或操作正式任务。边界：不改旧任务绑定、权限或预算；未重启当前 Host，旧服务使用兼容提示。下一步仅在本人保存草稿、结束当前运行后加载新版 Host；不自动改选或重试。必读附加：无。

2026-11-17 已完成本人“推送，发布，更新readme”：现有agent-os的工坊/README已推送，v1.2.0标签精确指向97997ac，正式Release于22:27:31发布。标签Actions 44098811836全发布门成功，六包/归档＋四SHA清单均已上传；本机下载四清单并与GitHub全部摘要核对。完整本机测试、Windows修正/原生验收与598资源可回退同步见回执。当前无发布阻塞；收尾出现另一批并行源码修改，未带入标签/回执，不自动续做。下一步由本人按平台下载并准备本机模型；不自动安装、重启、改main或私人资料。必读附加：docs/releases/v1.2.0.md、docs/reports/training-workshop-release-2026-11-17.md。

2026-11-17 学习提升已接入「按需训练工坊」：用户授权诊断、选方向再构建；真实本机模型可生成练习画布或在 QuickJS 编写计算程序。已用隔离账号跑通 Web/原生 Electron 保留、重开、换题和服务重启；无云调用、未改私人记录。卡点/边界：无实时语音，不认证专业能力或长期成效。下一步：本人可在「学习提升」输入一个具体困难试用；不主动扩权或重启既有服务。此条必读附加：`docs/reports/personal-training-workshop-2026-11-17.md`。

2026-11-15 本人要求“启动起来”后，已正常启动相邻 BetterMe.app，并通过桌面可访问性界面实际确认“欢迎回来”登录页和账号/第三方登录控件可见，不是仅有进程或首页200。复用原Web(::1:5173)、Host(5179)、岗位(5178)、OIDC(18000)及Ollama(11434)；桌面启动器另在127.0.0.1:5173启动其配套Web，未关闭原进程。两个Web→Host、带授权的Host/岗位健康、OIDC discovery、Ollama版本、主入口和App模块均200。未登录/授权模型、读取业务记录、重置账号或重启原服务；登录后主工作区仍需本人进入，不把登录页当完整业务验收。本次启动无新增必读附加。

2026-11-15 本人要求“合并，远端为准”：现有 `agent-os` 从 `95256e2` 快进到 `39d4174`，20 个远端提交已合入，HEAD 与 origin/agent-os 一致。5 个冲突文件（本文件、decisionLog、App、AutopilotStudioWorkspace、CareerTaskPanel）完整采用远端；依赖旧本地接口的 UnifiedCareerTaskSurface 及 career-task-panel 测试同样采用远端。其余无冲突本地改动与新增文件保持未提交。原 56 个已跟踪改动和 60 个新增文件完整保留在 stash `86b0f021e1bbe1bd79ef88e6f434219db3d85181`，逐字节备份说明见 `/Users/feng/Documents/Private/简历/简历Agent/.remote-sync-backup-20261115-Bu8n9q/README.md`。下方被替换的本地 UI 功能历史记录不代表这些入口仍在当前 App 中接通。

本次类型检查16/16、双端构建9/9、桌面模块23/23、全仓lint零warning和diff检查通过；定向回归133项为131通过/2失败，均为远端 Dock 默认透明度/预设文案改动后旧断言未同步，相关生产文件与测试相对HEAD无diff，不改远端行为来迁就旧测试，未跑完整pnpm test。596个安装资源已同步并核对hash，旧dist保留在 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-dK85CC/previous-dist`；没有重启正式服务、操作用户窗口、调用真实模型或改账号/个人数据。

2026-11-15 机会卡片尺寸微调（最新，以本段为准）：仅针对职业机会 3D 卡片正面收紧桌面端尺寸，将卡片最小高度从330px降至250px，正面取消305px最小高度并改为16px紧凑内边距，标题/状态区/翻面按钮间距同步收紧；620px以下保留原有365px移动端高度与可读性。未改组件结构、文案、数据或其他页面。

验证：Web typecheck、Web lint、双端构建9/9、桌面测试22/22、git diff --check通过。机会/UI定向回归当前基线有2项既有失败（F17导航控件缺失、F21英文文案断言不匹配），与本次CSS无关。5173预览已启动并能取得登录入口，但未进入需要登录的岗位卡页面，未声称真实卡片截图视觉通过。

仍未全部关闭：F21的Autopilot演示岗位示例/节点原文、F17深层任务浏览器流程、其他历史样式、全站200%与macOS实机。下一步沿agent-os直接处理明确UI缺项，不新建分支。必读附加：apps/web/src/components/opportunities.css。

2026-11-14 UI 审计续修（最新，以本段为准）：继续关闭 F21/F23 可独立缺项。恢复提示/只读档案、Agent 备份、旧根账关联、原始输出阅读、帮助首页、外部模型手工交接、共享根额度及登录方式错误现已双语；恢复只读会话去除内联历史色值，接入共享 surface/border/control tokens。未读取私人资料、启动模型、恢复授权或采用内容。

验证：新增英语宿主流程回归与既有 UI/账本/侧栏/身份相关测试累计通过（最新身份+UI 23/23，账本+UI 25/25，侧栏+UI 35/35，原文阅读+UI 20/20）；Web 类型、全仓 lint 零 warning、双端构建9/9、桌面22/22及 diff 检查通过。浏览器全新 WebGPU 会话在1097×826深色下成功取得中英文登录页和英文截图；截图暴露登录方式失败回执仍为中文后已修复，但刷新后的同会话再次变为空页，故没有把该最后一处改动声称为浏览器视觉通过。

仍未全部关闭：F21 的 ProjectUnderstandingPanel、AgentReaderTools/NativeToolConnections、Autopilot 深层演示及其他历史原文；F23 其他历史样式；F17登录后深层任务、全站200%与macOS实机。下一步继续优先小而可测的宿主原文，再处理大面板；浏览器空页或实机卡点按本人要求先跳过，不阻塞其他修复。5173预览继续暴露。必读附加：本轮修改组件及 apps/web/tests/ui-audit-regressions.test.tsx。以下历史停点不覆盖本段。

2026-11-14 UI 审计续修：针对5173登录预览持续占住浏览器主线程，已把装饰性 cobe 地球改为渐进增强：空闲时动态导入、30fps上限、降低采样，并在减少动态效果、节省流量、自动化、软件GPU或无法确认硬件渲染器时使用静态地球；登录、身份和私人工作区逻辑不变。职业任务与本地编码实验台上一轮双语、共享令牌及权限边界保持。

验证：身份门4/4（新增静态地球降级断言）、Web类型、全仓lint零warning、双端构建9/9、桌面22/22、diff检查通过。浏览器新会话可取得页面标题，但在媒体模拟时仍发生CDP主线程超时；随后进一步收紧“无法确认硬件渲染器即降级”，因本轮浏览器连续失败上限未再导航，不能声称真实登录页已视觉通过。

仍未全部关闭：F21主应用其他历史流程、Autopilot深层说明及部分宿主原文国际化，F23其他历史模块迁移；F17深层子任务浏览器验收、全站200%与macOS BetterMe.app实机。下一步从全新浏览器运行时复核静态降级后的登录页，再继续逐模块关闭缺项；不恢复旧R1–R8、不改私人资料或调用收费模型。必读附加：聊天附件 BetterMe UI 审计与修复进度；apps/web/src/components/LoginGlobe.tsx、apps/web/tests/identity-gate.test.tsx、ui-audit-regressions.test.tsx，独立夹具 tests/ui-lab/ui-audit.config.ts。以下为历史停点，不覆盖本段结果。

2026-11-14 全站 UI 审计修复（本轮最新）：按 F01–F23 修复真实岗位混入演示数据、规则伪称 AI、IME、原生导入弹窗、灵动岛计时/焦点/未知用量、卡面 inert、模板回退、要点撤销、资料搜索与设置键盘；渐进布局及共享样式已接入。最终 UI 定向56/56、地图定向4/4、桌面22/22、类型/lint/diff、双端构建9/9通过。地图完整大套件首次120秒截止中断，不能以定向通过冒充全绿。

本轮卡点：浏览器导入夹具仍仅 Vite 连接后空白（模块HTTP200不证明加载成功），完整登录态/200%缩放及macOS BetterMe.app未验；Linux不能刷新Mac安装包。本轮剩余：F17全部导航整合、F21全站英语、F23历史样式迁移仍部分完成，不能声称23项全部关闭。下一步沿agent-os继续这些明确剩余项与完整视觉验收，不自动执行旧成长/模型任务。未写私人资料或调用收费模型。必读附加：无；原审查与逐项修复快照在聊天附件 BetterMe UI 审计报告，永久回归在 apps/web/tests/ui-audit-regressions.test.tsx。

2026-11-14 灵动岛 UI 细节优化：将中间灵动岛升级为与左右菜单胶囊统一的深烟色毛玻璃材质（`backdrop-filter: blur(28px) saturate(1.55)`、顶部镜面高光与暗边轮廓）；展开态重构为平衡顶栏 + 两张内嵌玻璃卡片（「服务与引擎」彩色状态胶囊、「今日 Token 消耗」总量数字 + 输入/输出双色比例条 + 各模型类型标签与占比条），支持中英文切换、面板外点击收起、减少动态效果偏好，并修正首次加载误弹异常横幅与 Esc 收起残留提示。`desktop-shell.test.tsx` 31/31、Web 类型检查、零 warning lint、双端构建 9/9、桌面测试 22/22 均通过；847×826 真实 CSS 夹具已核对空闲/运行中/展开三态截图。卡点不变：完整登录页动态模块加载在自动化浏览器中仍受阻，运行中的 Agent Host 需重启一次以暴露 `/api/v1/agent/usage`，Linux 无法实测 macOS `BetterMe.app`。本轮必读附加：无。

2026-11-14 顶部灵动岛与服务状态：Host 在统一任务模型派送缝 `tasks/runtime.ts` 加每账号内存 `ModelUsageMeter`（`tasks/usage-meter.ts`），只读 `GET /api/v1/agent/usage`；直连模型 token 取自 provider usage_metadata，ChatGPT账号/本机CLI 只计调用并标 `metered:false`，不估算；按本地日期重置，Host 重启清零（`since` 标明）。Web `DynamicIsland`+`StatusDots`（SWR 30–60s，运行中3s）：代理=网络设置/探测，引擎=Agent Host健康+runtimes+vork，模型=今日真实调用成败（不发付费探测）。宿主类型/lint、计量2/2、Host runtime/task 182/182、桌面壳31/31、双端构建9/9、桌面22/22通过；847px 展开态CSS夹具截图已核对。未验：运行中的 Host 需重启才有新接口；真实登录页及macOS app未实测。继续沿agent-os。本轮必读附加：无。

2026-11-14 菜单栏截图细化：本人再次强调参考整张截图最顶部的系统菜单。现按左右两块28px圆角玻璃胶囊实现，中间/整条header完全透明，保持34px总高度；仅DesktopShell菜单内容增加左右包裹，desktop.css改为约22.5%薄色层、6px默认模糊、暗轮廓/内高光，保留浅色壁纸白字对比及减少透明度降级。菜单结构回归、桌面构建、桌面测试均通过。1097×826/390×844真实CSS隔离夹具截图已核对分组/透底/无溢出；夹具不等于登录应用验收，浏览器缺中文字形，完整应用动态模块导入仍失败。Linux无法刷新/实测macOS BetterMe.app。下一步只需正常预览里确认真实菜单观感；继续沿agent-os，不新建分支。本轮必读附加：无。下文上一版整条磨砂方案已被本次替代。

2026-11-14 菜单栏玻璃样式：按本人截图仅调整 `desktop.css` 中 `.os-menubar-system > .os-menubar`，改为深色半透明底、背景模糊、细高光边缘，保持白字对比度及现有尺寸/交互，下拉菜单与其他区域不变。此前预览修复已合并到 `agent-os`，临时分支已删除；本人要求后续直接在 `agent-os` 修改，不新建分支。本轮菜单栏回归、`pnpm desktop:build`、`pnpm test:desktop` 与 diff 检查通过。当前卡点：自动化浏览器主页面空白，隔离导入真实菜单栏组件也报动态模块加载失败，不能声称视觉已通过；Linux 无法刷新或实测 macOS BetterMe.app。下一步：在正常登录的预览里核对菜单栏玻璃效果，不扩展其他功能。本轮必读附加：无。以下历史停点保留。

2026-11-14 v0 拉取启动复核：远端 `agent-os` 为 `95256e2`，锁定依赖同步与前置五包构建通过；仅在独立 `v0/preview-startup-host` 分支给 Vite 增加当前预览域名 `3-web.v0.build`，没有业务变更。Web 5173 已启动，独立浏览器会话登录页正常且无 JS 错误，预览 Host 请求为 200；原验证会话重载曾空白，不以该会话证明通过。双端构建 9/9、桌面测试 22/22 通过；Linux 无法刷新或实测 macOS BetterMe.app。本次只跑项目，不恢复历史自动目标；后续使用预览正常登录，登录后流程未验。无新增必读附加，以下原产品停点保留。

2026-11-14 PDF 云翻译从现有 agent-os 的干净基线独立整理：包含所需资料导入、本机排版、显式 DeepSeek 通道及双端验证。不包含同时进行的其他界面或写作实验。产品质量仍是同一合成样本的 2B 对照被拒绝、实际云端调用为 0。详见 `docs/reports/learning-translation-cloud-2026-11-14.md`。

2026-11-13 本人新授权的 Windows CI 排查与 Agent 本机朗读已落地：伴侣/岗位工作区共用显式点播、仅系统本机音色、停止与重开不自播。四种模拟模型在 Web/实际 Electron 两入口共 16 组原生启停及进程恢复通过，0 真实模型/个人资料变更；专用验收窗口与服务已关闭，原服务和窗口保持。唯一实现、证据与最终构建回执为 `docs/reports/local-speech-windows-ci-2026-11-13.md`。

本人已授权沿现有 `agent-os` 正常推送本片及逐轮CI修正，未新建分支或强推。第八轮 `f65b31e` / Actions `43462234239` 的Windows桌面及其他平台成功；普通4,883通过/1个采集器安全夹具失败/20原有跳过（共4,904），前轮UI已过，独立62项因前段失败未执行。真实Git捕获增加3.1秒慢准备后，本机复现预期1次模型却为0；仅正向合成policy由3秒设为30秒，新增200ms准备超时仍0模型/保留尝试/不重试，以及有效JSON模拟泄密拒绝，完整采集器15/15通过并加入前置门。原CI无entry错误码，新断言附实际错误码以区分原因，不伪称捕获了原超时码。完整门、Windows Node24.21.0、生产预算/权限不变。最后提交及两个Windows最终结论从当前分支同SHA的Actions核对，完整复验/资源回退与逐轮失败只看本片报告；个人SSOT、冻结Gold/旧分数/hash不改。

前片第一条合成成长闭环与其授权发布已完成，唯一权威仍是 `docs/reports/personal-growth-first-loop-2026-11-13.md`；固定 4/4 不代表独立掌握认证。本片不自动接入其他引擎或恢复此前暂停的 R1–R8，不创建 Release、接管正式服务或修改个人三份 SSOT。

前序 Studio 缓存恢复、分组发布和旧全目标的停点保持在下方条件指针；早期 PID/资源数量属于历史快照。个人候选与两项事实仍待本人核对，三份个人 SSOT 不创建替代事实。

## 卡点

- 本轮v1.2.0正式发布无阻塞；第三方模型依赖、签名和实时语音边界见本版说明。收尾新出现的并行未提交修改保持，不代表本次发布源码，也不自动提交或修复。

- 本次启动无阻塞，桌面停在正常登录页；后续由本人登录。未代填账号或触发第三方授权，先前各功能的待验门保持。

- 本次代码同步无未解决冲突；Dock 两条旧测试仍失败（默认值0.85→0.28、65%预设文案已变），不声称全仓全绿。原合成成长、云端文本、翻译等其他未验门不因合并而关闭。

- 当前UI续修：成长深层双语已补齐，其他全站英语及历史样式仍有剩余；深层任务、真实登录态、原生全站200%及macOS实机未完整验收。5173入口已分离登录后加载，但本轮浏览器CDP连续超时，白屏是否解决未知；不要再把HTTP200当通过。F04键盘/F22长列表已有前轮隔离真实组件证据。以下为历史其他目标卡点，不自动续跑。
- 本机语音与历次Windows桌面打包/成品启动已过；本阶段只有最后推送SHA对应Windows普通及桌面均最终成功才交接。最终机器结论查看该SHA的Actions，不从旧作业/本机结果推定；实际Windows/Edge音色另验。语音输入/云端语音、OXR、PDF翻译、DeepTutor真实引擎、真实资料/语义评分/隔时独立复测未实现；成长样例4/4不是掌握或生产经验认证。
- 本机完整重跑及各轮失败分母保留在本片报告；不把定向通过拼接为完整全绿，也不将macOS的规范路径不变量先红当作Windows原生崩溃已在本机复现。
- 发布验收不等于产品全目标完成：回放/harvester/隐私模型步骤/Coding Sandbox 仍有待迁，新类型 BM25/offset、其他运行时失权后的全文、多根/授权版本变化及总审计未完。采集器旧模型步骤当前安全失败，不声称已迁完。
- 源审已定位复制职责、项目遗漏、目的当成果风险；本轮未声称已修复选材或模型写作。原Gold/分数/候选不改，操作者判读不是外部人工认证。
- 有限周期报告已实际2/2，但0新推理、仍同一权重，不可排名。第二模型须本人选择原已授权BetterMe账号正常tasks跑公开五例，或给隔离评测身份另行官方授权；不借登录、不默认cloud。

## 下一步

本轮工坊推送/README/正式Release已完成；本人可从GitHub v1.2.0选择系统与架构并核对SHA清单。本机模型另行准备，保留输入后再自行决定更新；不自动恢复旧任务、接管并行工作或重启现有服务。

本次桌面已启动，无需重复创建服务。本人可直接在桌面窗口登录，或使用http://localhost:5173/；不自动恢复旧任务或调用模型。

本次拉取/合并已结束。需要加载新桌面资源时由本人保存输入后正常重开；不自动重启现有Host或恢复旧任务。恢复旧本地冲突功能需先从备份隔离审阅，不直接pop旧stash覆盖本次远端版本；不自动提交、推送或创建Release。

当前优先仅续UI审计剩余：按模块关闭F21语言与F23样式；补深层任务及真实登录态验收。保持agent-os直接修改与正常推送，不触发旧自动目标。下文历史Windows任务不是本轮自动待办。

本片按本人授权限定文件提交推送，跟到最后SHA的Windows两作业最终通过；两项成功即结束本片，不自动启动新功能或原目标。失败依日志先定位再修复，不取消安全校验或以跳过失败换绿灯。实际Windows系统音色与CI打包/合成测试分开验收。其他真实资料/外部能力接入链需另行确认共享与依赖许可；不恢复原R1–R8、导入个人资料或调用收费模型。体验语音只需在成功回复旁明确点“本机朗读”，无需改文本模型配置。

## 必读附加

- **继续本次远端优先合并或恢复本地改动**：`/Users/feng/Documents/Private/简历/简历Agent/.remote-sync-backup-20261115-Bu8n9q/README.md`（原始stash、文件hash、冲突取舍、测试和安装资源回退）。

- **继续成长闭环/本轮资源回退/复验**：`docs/reports/personal-growth-first-loop-2026-11-13.md`。
- **继续本机语音/Windows CI/最新安装资源与回退**：`docs/reports/local-speech-windows-ci-2026-11-13.md`；远端 Windows 最终结论必须重新实查 Actions。
- **前序发布或 Studio 缓存恢复**：`docs/reports/agent-os-workspace-publish-2026-11-13.md`；相应进度见 `progress.md` 2026-11-13 记录。
- **原阶段闭环/目标停止**：`docs/reports/committee-retirement-2026-11-12.md`；生产 caller 前情按需读 `committee-caller-adoption-2026-11-12.md`。
- **继续质量改进**：`docs/reports/task-candidate-current-work-source-review-2026-11-12.md`、`evals/resume-quality/README.md`；原v7/旧v6证据按报告链接按需读。
- **继续第二模型/周期**：`docs/reports/resume-campaign-comparison-2026-11-12.md`，有限重算不等于新模型试验。
- **完成总目标前**：`docs/reports/unified-agent-expansion-2026-11-11.md`（R1–R8）；涉及旧根接手读`task-scope-association-2026-11-12.md`。
- **涉及本人简历/原生授权才读**：`docs/reports/native-codex-context-integrity-2026-11-11.md`。历史停点保留`archive/activeContext-history-20261112-pre-studio-review.md`，其“当前资源/下一步”均属当时快照。
