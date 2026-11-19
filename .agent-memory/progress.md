# Progress

## 本地审查 P1/P2 修复 · 2026-11-19

- [x] 桌面网关和岗位浏览器共用代理实例。招聘浏览器路径写入桌面私有目录，隔离 Chrome 只使用本次启动获得的调试端口。
- [x] 桌面退出等待各服务收尾，Agent Host 先关闭计量来源再写入用量。同步脚本仅轮换验证完整的自有备份，保留旧备份和未完成目录。
- [x] 已配对的扩展和书签桥接可通过桌面网关。Ollama 不可用时不派送生成请求。
- [x] 退出会话或切后台时关闭自动朗读。DOCX 提供带照片的明确选项，工坊仅在打开时读取任务概览，保存过的旧 Vork 壁纸路径继续可用。
- [x] Lint、类型及双端构建通过。主单测 5,124 项通过、20 项条件跳过，隔离 PDF 1 项及简历评估 64 项通过。桌面 24 项、运行时 13 项、端到端 6 步和 macOS arm64 隔离打包启动与退出验证通过。
- [x] 本机 BetterMe.app 同步 623 项构建资源并生成完整备份。

## P0 回归修复、桌面/XSS 安全收口、资源瘦身与 CI 加固 · 2026-11-19

- [x] 修复 `apps/web/tests/atlas-workspace.test.tsx` 相对导入 hook，使 `AtlasJobDetailPane` 场景下 89/89 用例全部通过；修复 `apps/web/src/lib/agent-guide.ts` 的 `beacon.innerHTML` XSS 风险并补充 `apps/web/tests/agent-guide.test.ts`。
- [x] 加固 `apps/desktop/src/main/index.ts`（`trusted(event)` 主框架来源校验 + 严格 `http/https` URL 校验 + 统一 `explainHud` 提示，同步加强 `isolated-qa.test.cjs` 拒绝非信任调用断言）与 `apps/desktop/src/main/hud-window.ts`（启用 `sandbox: true`、`webSecurity: true`，清除硬编码虚构 RCS/4.2x/FB-02 指标话术与 `innerHTML`）。
- [x] 压缩 `icon-atlas.png`（`1.7M → 84K`），清理 10 张第三方动漫壁纸与缩略图及 `preset-wallpapers.ts` `anime` 分类，`vork_*.png` 转 JPEG 并压缩其余壁纸（`wallpapers/` `55M → 14M`，`apps/web/dist` `135M → 92M`），`DesktopShell.tsx` 增加壁纸 `onError` 安全降级。
- [x] `AutopilotNodeInspector.tsx` 增加「监控与快捷入口 / Monitor & shortcut」标识；`scripts/verify-golden-flow.mjs` 与 `.github/workflows/ci-pages.yml` 在 `CI=true` 缺少 Chrome/Chromium 时直接报错阻断。
- [x] 第九轮全仓最终门禁通过（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`（9/9）、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test:golden`（5 步闭环 + `resume-zh-Lin Golden Flow.docx` + `spokenUtterances: 1`，0 `pageErrors`）、`pnpm test`（隔离 PDF `1/1` + 575 文件主单测 `5,117` 通过 / `0` 失败 / `20` 条件跳过 + `test:resume-quality` `64/64`），`BetterMe.app` 624 资源同步通过（`installedHash: 5276e0d8d7204b5a3cb757ba1f009f5e9b5be427ffc4e9ce9a5080d15a1614ee`）。

## 5k/15k 规模压测全绿与超大工作区模块拆解 · 2026-11-18

- [x] 修正 `apps/web/tests/atlas-snapshot-sync-scale.test.ts` 对 `jobs.sync-pages` / `jobs.baseline-page` 的字节统计，6 个规模/投影/富化专项基准测试文件 `43/43` 通过（15,000 岗位热查询 `0.62–1.97 ms`）。
- [x] `AutopilotStudioWorkspace.tsx`（`2,027 → 1,935` 行）抽离 `autopilot-pipeline-mappers.ts`；`AgentWorkspace.tsx`（`2,415 → 2,278` 行）抽离 `AgentEmptyPromptCards.tsx` 与 `AgentActiveJobHeader.tsx`；`AtlasWorkspace.tsx` 抽离 `AtlasEmptyJobList.tsx` 与 `AtlasJobDetailPane.tsx`。

## 主包压入 500 kB、Kernel 拆层与 5 步端到端对话/朗读全链路 · 2026-11-18

- [x] `App.tsx` 将 `AgentCompanion` 改为 `React.lazy`，配合 `vite.config.ts` 拆分 `vendor-yaml`/`fact-editor`/`desktop-shell`/`agent-sidebar-shell`/`better-me-opportunities`，`App-*.js` 降至 `456.69 kB`（gzip `156.47 kB`）、`App-*.css` 降至 `178K`。
- [x] `apps/agent-host/src/kernel/service.ts` 抽出 `kernel/kernel-helpers.ts`（`205` 行纯工具）；`AtlasWorkspace.tsx` 抽出 `AtlasPrimarySearchBar.tsx`。
- [x] `scripts/verify-golden-flow.mjs` 升级至 5 步全链路：覆盖本机账号注册、姓名编辑导出 DOCX、系统设置本机模型配置与来源切换、提交样本 JD 并发送真实对话、模型回复与自动本机朗读触发（`spokenUtterances: 1`，`pageErrors: 0`）。
- [x] 第七轮全仓最终门禁通过（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`（9/9）、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test:golden`（5 步闭环 + `spokenUtterances: 1`，0 `pageErrors`）、`pnpm test`（隔离 PDF `1/1`、574 文件主单测 `5,116` 通过 / `0` 失败 / `20` 条件跳过、`test:resume-quality` `64/64`），`BetterMe.app` 644 资源同步通过（`installedHash: 75f2a279...`）。

## 零 `as any` 收口、Vite 分包与黄金链路进 CI · 2026-11-18

- [x] 清零生产源码全部 `21` 处 `as any`（覆盖 `MapLibrePrototype.tsx` 13 处、`file-parsers.ts`、`AtlasWorkspace.tsx`/`card-badges.ts`、`DesktopSettings.tsx`、`resume-prefill.ts`、`agent-host/src/server.ts` 与 `office-address-provider.ts`）。
- [x] `package.json` 接入 `"test:golden"`，`.github/workflows/ci-pages.yml` 在 `pnpm build` 后自动执行；`verify-golden-flow.mjs` 精确定位「中文姓名」编辑并核验 `resume-zh-Lin Golden Flow.docx` 真实导出。
- [x] `apps/web/vite.config.ts` 新增 `manualChunks` 拆分长缓存底座 chunk，`App-*.js` 降至 `961.81 kB`、`App-*.css` 降至 `342K`；从 `AtlasWorkspace.tsx` 抽离 `atlas-live-harvest-notice.ts`。
- [x] 全仓最终复验通过（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`pnpm test:golden`（`resume-zh-Lin Golden Flow.docx`，0 `pageErrors`）、`pnpm test`（隔离 PDF `1/1`、574 文件主单测 `5,116` 通过 / `0` 失败 / `20` 条件跳过、`test:resume-quality` `64/64`），`BetterMe.app` 629 资源同步通过（`installedHash: 1a3fa296...`）。

## 搜索模块化、地图拆解、按需拆包、每会话自动朗读与黄金链路验收 · 2026-11-18

- [x] `apps/web/server/jd-live-batch-search.ts`（`2,151 → 396` 行）拆分为 `jd-live-search-cards.ts`（`1,095` 行）与 `jd-live-cdp-capture.ts`（`731` 行），保留主模块全量兼容重导出并满足 `noUncheckedIndexedAccess`（`jd-live-*`/`jd-search-api`/`jd-linkedin-streaming` 74/74 通过）。
- [x] `AtlasWorkspace.tsx`（`2,521 → 2,351` 行）拆出 `AtlasQuickFilters.tsx` 与 `AtlasSettingsModalBody.tsx`；`ResumePreview.tsx` 动态加载 `docx-export`，`App.tsx` 懒加载 `ImportSourceReview` 与 `ResumeDesignPanel`。
- [x] `AgentSpeechControl.tsx` 新增 `useSessionAutoSpeech` 与 `AgentAutoSpeechToggle` 接入 `AgentCompanion` 与 `AgentWorkspace`（默认关闭、仅当前会话生效、不重放历史记录），补充 `apps/web/tests/session-auto-speech.test.tsx`。
- [x] 新增隔离 Playwright Golden Flow 验证脚本 `scripts/verify-golden-flow.mjs`，实测通过本机账号注册、FactEditor 与预览实时同步、DOCX 真实下载与 AI 顾问示例 JD 提交及自动朗读开关切换（0 pageErrors）。
- [x] 全仓最终门禁通过（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（`rendererMounted: true`）、`verify-golden-flow.mjs`（4/4 核心步骤，0 `pageErrors`）、`pnpm test`（隔离 PDF `1/1`、574 文件主单测 `5,116` 通过 / `0` 失败 / `20` 条件跳过、`test:resume-quality` `64/64`），`BetterMe.app` 639 资源同步通过（`03520a51...`）。

## 首屏 CSS 瘦身、桌面强类型、F21 收口与二次模块化 · 2026-11-18

- [x] `apps/web/src/vite-env.d.ts` 新增 `DesktopBridgeApi` 与 `Window.desktopApi` 类型定义，消除 `AutopilotStudioWorkspace.tsx`、`DesktopShell.tsx`、`IdentityGate.tsx`、`ResumePreview.tsx` 的 `(window as any).desktopApi` 强转；`AgentApplyModal.tsx` 与 `autopilot-nodes.ts` (`localizeStudioNode`) 补齐英文双语映射。
- [x] 将 16 个简历纸张/模板主题 CSS 从登录前入口 `main.tsx` 迁移至登录后 `App.tsx`，`index-*.css` 由 `516K` 缩减至 `331K`（保留 `studio-workbench.css` + `studio-materials.css` 顺序不变）；从 `AutopilotStudioWorkspace.tsx` 抽出 `BlueprintMicroChamber.tsx`、`CyberJobCard3D.tsx`（主文件 `2,669 → 2,027` 行），从 `AgentWorkspace.tsx` 抽出 `AgentFitAnalyticsHeader.tsx` 与 `useAnimatedCounter`（主文件 `2,651 → 2,413` 行）。
- [x] 最新全量复验通过：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（exit 0，`rendererMounted: true`）、`pnpm test`（隔离 PDF `1/1`、主单测 `5,115` 通过 / `0` 失败 / `20` 条件跳过、`test:resume-quality` `64/64`）；`sync-local-desktop-dist.mjs` 已同步 634 个 `BetterMe.app` 资源（`installedHash: caf4dbfe...`）。

## 用量持久化、严格索引对齐与组件模块化 · 2026-11-18

- [x] `apps/agent-host/src/tasks/usage-meter.ts` 与 `server.ts` 新增 per-owner `usage-metrics.json` 私有持久化（启动同步水合、`0o600` 常规文件边界校验、Zod 校 schema、本地跨日自动清空、`150ms` 防抖落盘与 `drain()` `flush()`），补充 `usage-meter.test.ts` 跨重启与跨日重置验证（3/3）。
- [x] `apps/web/tsconfig.node.json` 启用 `"noUncheckedIndexedAccess": true`；完成 `jd-native-edge.ts`、`jd-native-liepin-browser.ts`、`jd-managed-browser-proxy.ts`、`jd-native-boss-expand.ts`、`jd-boss-expand.ts` 及 `jd-cdp-dom-snapshot.ts` 全量边界安全化，通过 `apps/web/tests/jd-*.test.*`（1,053 通过 / 0 失败 / 1 跳过）。
- [x] 拆解 `AutopilotStudioWorkspace.tsx`（3,341 → 2,669 行：`AutopilotAgentSprites.tsx`、`autopilot-nodes.ts`）与 `AgentWorkspace.tsx`（3,497 → 2,651 行：`AgentReplyActionsCard.tsx`、`AgentJdDetailsView.tsx`、`AgentProposalListSection.tsx`、`AgentApplyModal.tsx`），保持现有回归套件与 UI token/IME 约束 100% 兼容。
- [x] 最新全仓门禁通过：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（exit 0）、`pnpm test`（隔离 PDF `1/1`、主单测 `5,115` 通过 / `0` 失败 / `20` 条件跳过、`test:resume-quality` `64/64`）；`sync-local-desktop-dist.mjs` 已同步 634 个 `BetterMe.app` 资源并自动轮转旧备份。

## 全链路闭环补齐、桌面端对齐与模块化治理 · 2026-11-18

- [x] 新增 `apps/web/server/job-atlas-paths.ts` 跨平台解析 `job-atlas` 数据目录，并在 `nearby-companies.ts`、`company-intelligence.ts`、`atlas-dev-index.ts` 统一使用；确认 `packages/opportunities/src/query.ts` 与 `apps/job-service/src/repository.ts` 复用 `JobQueryIndex` 快照索引缓存。
- [x] 打包桌面端 `runtime-gateway.ts`（`mode === "desktop"`）接入 `/api/network/*` 与 `/api/jd/*`（`jd-desktop-bridge.ts` + `dist/runtime/jd-middleware.mjs`），Docker 模式保持 `501`；桌面端默认首页切换为 `/?workspace=resume`，新增 `desktop:export-pdf`（`webContents.printToPDF`）原生导出通道并接入 `ResumePreview.tsx`。
- [x] `App.tsx` 恢复 `CareerInventory` 完整入口与 `ResumeWritingCopilot` 联动，拆分重型工作区与弹窗为 `React.lazy` 懒加载（主 `App-*.js` 缩减至约 1.1 MB）；`docx-export.ts` 支持本地 `data:image/*` 头像内嵌并保持远端阻断。
- [x] `AutopilotStudioWorkspace` 接入真实 `AgentTaskKernel` 任务遥测与 `/api/v1/agent/usage` 模型用量（`autopilot-telemetry.ts` / `AutopilotNodeInspector.tsx`），提取 `atlas-filter-presets.ts` 与 `maplibre-styles.ts`。
- [x] `apps/agent-host` 新增 `tasks/metered-adapters.ts` 将 Capabilities、Coding Sandbox、TrainingKits、pdf2zh 翻译与 CareerStudio 本地调用纳入 `ModelUsageMeter`；修复 `VorkStudioCard.tsx` 卸载未取消异步请求；`sync-local-desktop-dist.mjs` 轮转清理旧 `.unified-agent-app-*` 备份（保留最近 2 个）。

## 安全加固、I/O 性能优化与桌面源对齐 · 2026-11-18

- [x] `vork` 路由收口至已认证 owner 与 `X-BetterMe-Owner` 校验后，移除 HTTP `sceneJson` 注入与共享 `/tmp/betterme-vork`，改为每任务隔离临时目录与串行队列；修复 `vork-client.ts` 鉴权头与 `VorkStudioCard.tsx` 硬编码个人路径/型号回退。
- [x] `capabilities/sandbox.ts` 加固 QuickJS 沙箱为预捕获内建函数 + 间接 `eval` + 源码匹配校验；`identity/service.ts` 增加 `lstat` 元数据缓存与 `lastUsedAt` 落盘节流（10s）并放宽用户上限；`builtin-idp.ts` 改用原子写队列并门控 `auto_subject`。
- [x] `kernel/service.ts` 在 `rootState()` 中引入 `rootIndex` 与 `storeCache` 命中路径，消除任务心跳时的目录文件全量读盘；`server.ts` 懒加载 `runManager`；`runtime-gateway.ts` 在桌面模式下开放 `/api/opportunities/source`。
- [x] 复验通过（Node 24.19.0）：`pnpm lint`（0 warning）、`pnpm typecheck`（16/16）、`pnpm desktop:build`（9/9）、`pnpm test:desktop`（23/23）、`pnpm test:runtime`（10/10）、`pnpm desktop:smoke`（exit 0）、专项测试（55/55 与 206/206）及 `git diff --check`；`BetterMe.app` 598 资源已同步。未执行完整全仓 `pnpm test` 与跨平台 Windows/Linux CI，未删除根目录历史 `.unified-agent-app-*` 备份目录。

## 模型配置与任务提示 · 2026-11-17

- [x] 截图问题已用合成账号复现并修复：模型冲突在授权前解释，保存后可直接进入来源选择；模型列表缺项明确提示，任务额度报错可定位到实际面板。原生模态窗口隔离后台教程，打开测试会定位到结果。
- [x] 完整 Web 设置走通保存到来源选择，Web 与原生 Electron 的隔离冲突场景保留旁批草稿、未新增模型调用。复验证据：`apps/web/tests/one-off-task-http.test.tsx`、`apps/agent-host/tests/task-root-scope.test.ts`、`output/playwright/model-guidance-20261117/`。本人 Key、真实付费生成、正式运行中的任务不在本次验证范围；未发布此片。

## 训练工坊发布与 README · 2026-11-17

- [x] 本人明确授权后，README 增补入口、三类生成方式、模型与费用、账号/沙箱/复测边界；仓库与桌面版本同步准备为 1.2.0，发布说明已创建。
- [x] 功能提交 5afb22b 已普通推送 agent-os，保留原有未跟踪语音研究；本机完整普通套件5,099通过/20条件跳过/0失败、独立PDF1/1、简历质量64/64、类型16/16、零warning lint、桌面23/23、runtime10/10及双端构建9/9通过，598个本机App资源同hash可回退核对/同步，未重启正式服务。
- [x] Actions 44087472335 四平台成品、Docker与生产构建成功，Windows完整普通套件5,101通过/23条件跳过/2夹具失败。真实复现大于两秒Git准备旧断言失败、取消失效新断言失败，以及Vite Windows分支短路径403/规范路径200且.env保持403；仅修测试与前置门，生产文件/预算/权限零diff。
- [x] 修正97997ac已普通推送；Actions 44094307792最终全门成功，Windows普通5,103通过/23条件跳过/0失败、简历质量64/64。arm64因GitHub runner容量取消，单独重跑后原生成品通过；v1.2.0注释标签已普通推送并精确指向同SHA。本机修正后第二次完整普通5,099通过/20条件跳过/0失败及简历质量64/64、双端9/9和App同hash同步再次通过。
- [x] 正式标签Actions 44098811836全发布门成功；v1.2.0于22:27:31正式公开，六项安装包/归档＋四份SHA清单全部uploaded。发布前CI对全部二进制验hash，发布后本机实下四清单，与公开API六项二进制及清单自身摘要完全一致；非草稿/非预发布。说明链接已指向不可变标签；main/Pages与私人资料不动，并行源码修改不带入。回执：`docs/reports/training-workshop-release-2026-11-17.md`。

## 按需训练工坊 · 2026-11-17

- [x] 本机模型按困难组合不同主题的练习；邮件、并行排期走独立验算，开放式练习只核验填写。临时试用/保留/舍弃/24h 换题按账号隔离，未改职业事实。
- [x] 真实本机模型跑通 Web 与原生 Electron 交接、重启恢复与窄屏；定向 82/82、桌面 23/23。报告：`docs/reports/personal-training-workshop-2026-11-17.md`。未做真实用户长期教学评估。

## 本机工作台启动 · 2026-11-15

- [x] 正常启动相邻BetterMe.app，实际桌面界面已显示“欢迎回来”登录页；未操作登录或授权。
- [x] 原Web/Host/岗位/OIDC/Ollama复用，桌面启动器新增127.0.0.1:5173的配套Web监听，原::1:5173保留。带授权Host与岗位/两Web代理、OIDC discovery、Ollama版本、Web入口和App模块均200；没有重启原服务、改账号/数据库/浏览器状态或调用模型。
- [ ] 登录后私人工作区由本人进入；不以启动登录页替代完整业务验收。

## 远端优先本地合并 · 2026-11-15

- [x] 按本人要求在现有agent-os从95256e2快进至39d4174，合入20个远端提交；5个冲突文件及2个依赖旧接口的调用/测试完整采用远端，无冲突本地改动保持未提交，无新分支/新提交/推送。
- [x] 原56个已跟踪改动和60个新增文件保留于stash `86b0f02`；完整hash清单、Git行尾归一化前的vosk.js原始字节及恢复说明见 `/Users/feng/Documents/Private/简历/简历Agent/.remote-sync-backup-20261115-Bu8n9q/README.md`，历史stash不动。
- [x] 类型16/16、双端构建9/9、桌面模块23/23、lint零warning及diff检查通过；596个安装资源同hash可回退同步，旧dist为 `/Users/feng/Documents/Private/简历/简历Agent/.unified-agent-app-dK85CC/previous-dist`。正式进程、窗口、账号/密钥/资料不动，真实模型调用0。
- [ ] 定向133项131通过/2失败：远端Dock默认透明度与预设文案已改、旧断言未同步；保持远端行为，不改测试掩盖，未声称整仓测试通过。后续功能恢复与UI实测不属于本次代码同步。

## 机会卡片尺寸微调 · 2026-11-15

- [x] 仅针对机会 3D 卡片正面收紧桌面端尺寸：卡片最小高度 330px→250px，正面去除 305px 最小高度，缩小内边距、标题间距、状态区间距及翻面按钮上方留白。
- [x] 620px 以下保留原有移动端 365px 高度与 44px 控件高度，避免窄屏卡片过度压缩。
- [x] Web typecheck、Web lint、双端构建 9/9、桌面测试 22/22、git diff --check 通过。
- [ ] 真实登录后岗位卡页面未完成浏览器截图复核；机会/UI 定向回归存在 2 个本基线失败，与本次 CSS 无关（F17 控件缺失、F21 英文断言不匹配）。

## 全站 UI 审计修复 · 2026-11-14

- [x] 真实岗位与演示指标隔离；关键词规则不再自称模型推理或输出固定置信度；来源与发布时间仍配对显示。
- [x] IME 四路径、导入 dialog、灵动岛计时/激活/未知用量、翻面 inert/焦点、模板回退、单条撤销、资料筛选、Dock 方向键及透明度状态语义修复。
- [x] 任务概览、授权缺项提示、技术详情折叠、紧凑岗位卡及限定工作区共享样式接入；不改私人资料、权限或纸张导出。
- [x] 最终 UI 定向56/56，地图定向4/4，桌面22/22，Web类型检查、全仓lint零warning、双端构建9/9及diff检查通过。构建仍有既有外置Node模块/大chunk提示。
- [x] 后续完整地图大套件89/89：首次120秒截止后，完整重跑198.9秒退出0，不再是仅定向复验。
- [x] 顾问/资料练习/证据一层主导航与四字段状态概览；导航窄屏、独立生产真实组件导入双向Tab/Esc恢复、20模型长列表双视口滚动和长岗位卡CSS两倍缩放通过。隔离证据不代替登录主应用或浏览器原生200%。
- [x] 地图格式、学习主要操作、成长全阶段控制/检查/历史/通知、证据授权与顾问模式扩展英语；成长/学习/证据表面迁移共享令牌，保留纸张与原文。新增6个英文成长阶段回归验证零写入和原文保持。
- [x] 登录门内可恢复懒加载App；访客零工作区加载测试通过，登录控件及模块加载/失败提示双语。本轮关联38/38、Web类型、全仓零warning lint、双端构建9/9、桌面22/22通过；不是全仓测试结果。
- [x] 职业任务配置/授权/预算/审阅/回执/工具/事实/事件与本地服务错误完成双语；本地编码实验台目录/校验/连续修复/候选审阅完成双语及共享令牌迁移。职业任务22/22、编码实验台11/11、Web类型、lint零warning、双端构建9/9、桌面22/22通过。
- [x] 登录装饰地球改为延迟动态导入和30fps更新；减少动态效果、节省流量、自动化、软件GPU及无法确认硬件渲染器均静态降级。身份门4/4、Web类型、lint零warning、双端构建9/9、桌面22/22通过。
- [x] 恢复/备份/旧根账/原文阅读/帮助/外部手工交接/共享额度/登录失败回执完成双语；只读恢复会话迁共享样式令牌。相关最新23/23、25/25、35/35、20/20，Web类型、全仓零warning lint、双端构建9/9、桌面22/22与diff检查通过。
- [x] F21：ProjectUnderstandingPanel（95处）、AgentReaderTools、NativeToolConnections 及共享 `nativeToolStatus`/`agentBaseLabel`（新增可选翻译参数，默认中文，旧调用方不变）完成双语；新增原生连接英语回归。相关58/58、Web类型、全仓零warning lint、双端构建9/9通过。会话原文/模型输出/服务端消息保持原样。
- [x] F21/F23 Autopilot：主工作区、岗位卡、蓝图腔体的界面文案/提示/aria/title 约90处完成双语；岗位阶段名仅翻译显示（`stageLabel`/`stageShort`），存储值仍为中文标识。60处 `isLight`/`theme==="light"` 明暗成对色值（40组）改为 `autopilot-studio.css` 中 `--ap-tone-N` 主题变量，两主题均定义。新增2条回归，UI审计相关88/88、Web类型、全仓零warning lint、双端构建9/9、桌面22/22通过。顺带修复语言切换后节点副标题不更新的 useMemo 依赖。未做浏览器视觉验收。
- [ ] Autopilot 仍保留：演示岗位示例数据（虚构公司与简历，约200处中文）、STUDIO_20_NODES 中2处节点名/副标题中文（`招聘检索`、多内核编排副标题），以及约220处 Agent 品牌色/吉祥物图标色（品牌常量）。F17深层任务浏览器流程、其他历史原文与样式仍待完成。全站200%与macOS实机待验；Linux不能刷新Mac安装包。
- [ ] 5173预览继续暴露；新WebGPU会话曾成功取得中英文登录页及英文截图，暴露的中文失败回执已代码修复；随后刷新同会话再次空页，未把最后改动声称为视觉通过。

## 灵动岛 UI 视觉与交互优化 · 2026-11-14

- [x] 材质与动效对齐顶部玻璃胶囊：深烟色毛玻璃、顶部高光边、4 段均衡波形、平滑宽高弹簧过渡，支持桌面中英文与 `reduceMotion` 偏好。
- [x] 展开面板重排为内嵌双卡片：服务与引擎状态胶囊（绿/黄/红/灰语义标签）、今日 Token 总量英雄区 + 输入/输出双色比例条 + 各模型标签与消耗占比条，去除冗余重复小标题与裸表格。
- [x] 交互修复与回归：首次状态基线不误弹异常横幅、点击岛外或按 Esc 干净回到空闲态；`desktop-shell.test.tsx` 31/31、类型检查、lint 零 warning、双端构建 9/9、桌面测试 22/22 及 847×826 三态真实 CSS 截图通过。
- [ ] 完整登录态页面与 macOS `BetterMe.app` 仍待本机实测；运行中的 Agent Host 需重启一次加载 `/api/v1/agent/usage`。

## 顶部灵动岛与服务状态 · 2026-11-14

- [x] Host 统一任务派送缝新增每账号当日模型用量计量与只读 `/api/v1/agent/usage`；仅 provider 上报 token 计入，未上报的运行时只计调用，不估算。
- [x] 顶部中间灵动岛（空闲/运行中/异常提示/悬停展开）与右侧代理·引擎·模型状态点；不发付费探测，触屏点击、键盘聚焦、Esc 关闭、减少动态效果均支持。
- [x] 类型、lint、计量2/2、Host runtime/task 182/182、桌面壳31/31、双端构建9/9、桌面22/22、diff 检查通过；847px 展开态夹具截图已核对。
- [ ] 正在运行的 Agent Host 需重启才提供新接口；真实登录后页面与 macOS BetterMe.app 未实测。用量在内存中，Host 重启后清零。

## 顶部左右透明玻璃胶囊 · 2026-11-14

- [x] 根据再次提供的截图替代上一版整条磨砂：左右独立圆角玻璃，中央完整透出壁纸；仅菜单栏结构/样式及对应回归断言变化。
- [x] 菜单栏结构/自动隐藏/键盘交互回归、`pnpm desktop:build`、`pnpm test:desktop` 和 diff 检查通过。
- [x] 使用真实CSS的隔离夹具检查1097×826与390×844截图：胶囊布局、背景透出及无溢出；夹具不冒充真实登录后页面。
- [ ] 完整应用自动化浏览器仍有动态模块导入失败；浏览器缺中文字形，真实中文字体/完整交互未视觉验收。macOS BetterMe.app无法在本Linux工作区刷新/实测。

## 顶部菜单栏透明玻璃 · 2026-11-14

- [x] 仅修改顶部菜单栏 CSS 覆盖：深色半透明玻璃、背景模糊、细高光与柔和投影，白字保持清晰；不改布局、壁纸、下拉菜单、业务行为或偏好存储。
- [x] `desktop-shell.test.tsx`、`pnpm desktop:build`、`pnpm test:desktop`、`git diff --check` 通过，Web/Electron 共用本次样式。
- [x] 复用并展示现有 5173 预览；按本人要求留在 `agent-os`，不新建分支。
- [ ] 1097×826 深色自动化浏览器显示空白，隔离导入真实组件报动态模块加载失败，视觉验证未完成；未修改无关启动代码或绕过登录。
- [ ] Linux 工作区无法刷新及实测 macOS BetterMe.app。

## v0 最新代码启动 · 2026-11-14

- [x] 获取远端 `agent-os`，确认最新基线 `95256e2`；非交互锁定依赖同步、前置五包构建成功。
- [x] 独立分支仅新增精确预览 Host 白名单；5173 启动、Host 请求 200、独立浏览器登录页及无 JS 错误验证通过。旧浏览器会话重载空白，未伪称旧会话恢复或登录后功能通过。
- [x] 双端构建 9/9、桌面测试 22/22 通过；未修改业务逻辑、调用模型或恢复旧自动任务。
- [ ] macOS BetterMe.app 刷新/实机验证不适用于当前 Linux 工作区，未执行。

## PDF 翻译发布切片 · 2026-11-14

- [x] 整理三页合成 PDF 的本地/显式云通道、必要资料入口、术语/公式分开审阅和 Web/Electron 验证；未包含真实资料、密钥或私有测试产物。
- [ ] 真实 DeepSeek 同样本质量对照仍需本项单独授权；发布不等于该门已通过。

## PDF 云端强模型选项 · 2026-11-14

- [x] 默认本机；按作业显式授权官方 DeepSeek，原件/术语/模型绑定、请求上限、只读恢复、公式与术语分开审阅。9 次合成回放通过真实排版，保留已知公式质量失败；未改正式服务及全局聊天模型。
- [x] 安装资源双端分别验证临时密钥/已配官方密钥；创建成功回执丢失，重开只读找回，新增执行 POST 为 0；相关 23/23、桌面 23/23。记录见下方报告。
- [ ] 同三页/六术语的真实 DeepSeek Pro 对照仍未授权；0 真实云端翻译请求。证据与复验方法见 `docs/reports/learning-translation-cloud-2026-11-14.md`。

## 履历选材到原句、听写核对 · 2026-11-14

- [x] 明确选一段已确认经历的当前可见原句，定位伴写；独立材料不挂靠、不继承发送同意、不因跳转而调用模型。本轮只做选句和引用，不切换已有云端写作流程。
- [x] 可点击原词核对否定、数值、术语和严格对齐的低置信词；五句固定合成输入（否定 3/3、数值 4/4、术语 1/3）揭示“重试/Redis”未保留。合成结果、导出验收、命令与回退见 `docs/reports/career-inventory-review-handoff-2026-11-14.md`。
- [x] 此片最终安装资源网页含听写、桌面文字链路均通过；全量普通 4,935 通过/20 跳过、质量 64/64、定向 50/50、桌面 23/23，类型、lint、构建及同步通过。与其他并行线未验门分别记账。
- [x] 14:37 自然解锁后的最终安装版听写已补验：项目 Electron 45.2.3 及安装包自带 Electron 34.2.0（隔离副本的 112 个运行时条目逐一核对）均退出 0，626 个安装资源 hash 前后未变。空格/鼠标、未按住拒绝、松手/退出停轨、核对/丢弃/只追加不自动保存和导出均通过；0 真实麦克风与云模型调用。前次锁屏拒绝保留为负例。

## 云端五例与分步文本写作 · 2026-11-14

- [x] 本人新授权后复用当前DeepSeek配置，在独立benchmark身份经正常Host/tasks/resolver实际5次调用：4冻结、1来源句柄契约失败、0未决、无重跑；同v7/完整hash/根上限只读重算两批，完整质量不可比，不指定最佳模型。
- [x] 同一内核新增选材/追问→精确计划本人确认→显式成稿→逐条批准/独立版本→Markdown导出；未发送回答私有恢复但确认/发送同意不恢复，丢创建与异步指纹仍用原编号；迟到结果私有留存不采用。跨字段回答、未知数字、未负责上线、超长确认与回执负例先红后绿。
- [x] 最终完整pnpm test退出0：普通4,950项/4,930通过/20原条件跳过，独立64/64；关联63/63、桌面模块23/23、类型16/16、lint零warning、双端构建9/9。626资源同hash同步与同内容备份、原模型/个人数据不变及服务清理见唯一报告 `docs/reports/resume-cloud-text-loop-2026-11-14.md`；未提交推送。
- [ ] Web此前实际观察到2次显式调用与独立版本1，下载字节/完成态重开未核对。最新截图已证实5341浏览/下载均始终允许，但一次原地址工具重试仍拒；属于显示规则/工具判定不一致，下一步本人安全重连，不再改权限或索要相同截图。原任务仍revision10/模型2/工具0/同一回执、80文件hash未变，此次0新增执行且未启动服务/窗口；最小诊断已留本机未外发。工具恢复后再补双端下载、新进程重开及Host重启；新两阶段真实云端质量与完整语义源审仍未完成，不能以构建或接口替代实测。

## 旧稿倒序盘点与私有工作画像 · 2026-11-14

- [x] 导入后分流、随时开启/恢复、按材料倒序访谈、作品与未解析原文单列、分用途授权、逐项确认、同主题替换/撤回、材料排序与精修引用。JD 只比对本人选定的原词，不调整分数或推断文化。
- [x] 使用临时账号、合成旧稿和模拟推理验收真实 Web/Electron：刷新无盘点 POST/无额外推理、不同意的回答未进入策略；两端实际导出与公开投影不泄露新偏好。定向6/6、桌面22/22、类型16/16、构建9/9和完整回归结果、资源与回退见 `docs/reports/career-inventory-2026-11-14.md`。
- [x] 同日续片增加本机普通话按住输入与纠错，不存音频，不自动保存/发模型。真实 WASM 配合合成音轨、桌面权限、回归和资源回退见 `docs/reports/career-inventory-dictation-2026-11-14.md`。
- [ ] 真实强模型同样本同预算质量比较、真实麦克风/口音与持续语音主持未验；未提交/推送或重启正式服务。

## PDF 真实本机转换与恢复 · 2026-11-14

- [x] 独立Python3.12.14/PDF2zh-next2.10.2/BabelDOC0.7.1及182份固定hash公开资源实际准备完成，不覆盖系统Python/个人缓存、不下载LLM权重。源码与资源许可分开、运行时不打入发行包；macOS ARM64结论不外推Windows。
- [x] 原创三页PDF实际五个作业：0次推理前失败、9次产出拒绝、9次取消、9次结构守卫候选拒绝、9次六术语候选拒绝，累计36次真实本机请求。最终9页逐页渲染/全文核对，公式名词误译未过门，零候选获接受，无云端/收费调用。
- [x] 实装定位并修正真实资源上限、expanduser私有路径、可回写资源副本、macOS系统代理、finish不退出及公式占位输出结构问题，红→绿留证；不把结构守卫或重排成功当语义正确。取消保留9次用量，清理自有进程后零原生临时作业目录。
- [x] 实际Electron/built preload三组“新进程→重开→Host重启”，恢复成长POST均0、9→9/18→18/18→18；最终拒绝审阅也恢复一致。最终Web刷新18→18、adapter2→2、同意false且静音，未用可见画面替代调用计数。
- [x] 最后完整pnpm test实际退出0：普通4,925项/4,905通过/20原有跳过、独立62/62；定向13/13、类型16/16、双端9/9、桌面22/22、lint零warning、真实离线引擎探针与资源5/5。616资源同hash可回退同步，actual installed main/preload/React离线两窗口已验。专用窗口/5338已关闭，个人SSOT/Gold无diff，并行改动保留，未提交推送。
- [ ] 正式入口未配置；英文公式/通用翻译质量、Windows原生隔离、OXR、DeepTutor服务、STT和真实隔周掌握仍未放行。最新用户转为附件方案扩展，仅分析；云端对照须另明账号/接收方/资料/预算，不能从附件推定外发授权。唯一真实续片：`docs/reports/learning-translation-real-2026-11-14.md`；下方模拟阶段作为历史保留。

## PDF 中译英作业协议试点 · 2026-11-14

- [x] 同一 Host/owner 私有学习库增加冻结来源/模型digest/术语表的后台作业，先记账再派送，32次/10分钟、取消/中断/撤权、候选字节校验、六项本人审阅、模拟件不能接受。单次勾选提交即消耗；丢回执只读核对不复用许可。
- [x] 真实Web丢创建响应，刷新/原编号GET不重发；实际Electron新进程/再次打开/Host重启后恢复三个区间执行POST均0、静音、用量不增。主动停止保留1次已发生计量，无候选；跨窗口撤权约1.8秒停转换/清正文。
- [x] 三页原件/候选画布与文本分看，模拟草稿下载/拒绝审阅/回执冻结、错误术语零派送；默认未配置真实界面禁用，0成长写入。390px浅深色单列、44px控件和可见Tab焦点目视核对。
- [x] 固定版本本机adapter实验接口，未装引擎/下载资源或调用真实模型；原生协议替身2/2验证能力代理、环境不继承、并发拒绝与POSIX进程组清理。修复拒绝请求错误释放他人占位，红→绿日志保留；Windows原生隔离未验时明确不启动。
- [x] 最终完整pnpm test退出0：普通4,921项/4,901通过/20原有跳过，独立62/62；类型16/16、双端9/9、桌面22/22、runtime10/10、lint零warning。地图旧单行正则改AST连接断言，保留缺依赖/错调用负例，不改并行页面代码。
- [x] 616桌面资源可回退同步，实际安装main/preload/React隔离离线两窗口通过。个人三份SSOT与Gold无diff，职业写入/真实模型0；并行壁纸/设置/Autopilot等保留，未提交推送。唯一报告：`docs/reports/learning-translation-pilot-2026-11-14.md`。
- [x] 此后已实际安装固定引擎/离线资源并记录真实中译英质量、耗时/失败与恢复，见上方真实续片；质量拒绝不标完成可用译文。AGPL实际部署/分发评估、Windows原生清理、OXR/DeepTutor服务仍未放行。

## 外部资料与隔时复测 · 2026-11-14

- [x] 附件近期两轮落地：owner 隔离原件字节/不可变版本、逐页引用/坐标/哈希、PDF 原页高亮、选段与题目本机点播、可恢复原答/代码、提示前原答、到期换题、计划差异/拒绝/采纳和五项本人项目验收。原合成入口不迁移、不覆盖，共用原内核实现，不读取职业任务或改个人事实。
- [x] 真正原创中文 PDF 第2页 → 显式练习 → lookup断点 → 关Web/重启隔离Host/全新Electron → 同owner/原答/引用/断点 → 第二个Electron进程静音恢复 → 明确继续；两个恢复区间成长POST均0，同次lookup=1。Web与桌面原生选段/题目发声状态、停止、朗读中退出后不续播均观察通过，不当作Windows声学试听。
- [x] 受控隔周 4/4→故意新失败2/4→拒绝不改计划→采纳补练→第三道不同操作编号4/4→本人项目完整导出；三次记录与提示/验证器v1-v3、全部复盘不覆盖，累计lookup3/工具18/模型0。一次补练采纳严格绑定对应证据，不反复沿用旧许可；原根预算耗尽不借新尝试补额。
- [x] 同名修订保留旧引用；混合扫描逐页“需要识别”、双栏“需校对”、损坏拒绝；撤权可取消且跨窗口约3.4秒停音、清原页/正文、计量不归零。客户端异步文件切账号在POST前拒绝；真实认证跨owner元数据/字节/选段/路径均404，职业写入0。
- [x] PDF改嵌入固定许可的Noto子集，附OFL/hash/生成器；PDF.js与Poppler交叉目视三页和混合/双栏，两次生成四哈希一致。浅深色、默认原生窗口、390px扫描/撤权/展开代码与行为JSON目视；成长按钮44px、键盘焦点、无页面横向溢出。合成预置布局与实际按钮演示分账。
- [x] 最后依赖冻结后完整 `pnpm test` 实际退出0：普通4,910项/4,890通过/0失败或取消/20原有跳过，独立62/62；类型16/16、lint零warning、双端9/9、桌面22/22、runtime10/10。普通Node先红检出桌面runtime缺直接PDF依赖，离线补同版依赖后转绿。最终全量日志与原始回执归本片唯一报告，不相加套件重复计数。
- [x] 587安装资源同清单可回退同步，实际安装main/preload/React隔离离线两窗口通过；专用验收窗口和5336已关闭，原正式进程/profile保持。备份与原始账单见 `docs/reports/learning-materials-retest-2026-11-14.md`。当前未提交/推送，仍agent-os；原R1–R8不恢复，真实简历/求职/FactBase/模型配置不改。
- [ ] 此阶段之后PDF作业协议及真实运行见上方新记录，真实译文已验但拒绝；OXR扫描页、DeepTutor服务、Windows实机声音、语音输入/云端音色、语义评分与实际隔周保持也不冒称通过。

## 本机朗读与 Windows CI 排查 · 2026-11-13

- [x] 伴侣/岗位工作区回复共用本机点播与停止，只接受成功完整正文、本机语言音色；退出/隐藏/切换停止，恢复不重播，未发草稿沿原恢复机制保留。不引入语音凭据、收费调用或麦克风。
- [x] 四种模拟供应商 × 两入口 × Web/Electron 共 16 组原生启停，以及中英句段、快速切换、键盘、卸载重开和独立进程恢复通过；深浅色/390px 粗指针布局目视及 44px 点击高度通过。0 外部模型/个人资料变更，已关闭自己新建的验收窗口和服务，原服务不动。
- [x] 实查基线 Actions `43387764396` 的 Windows 普通 33 失败和桌面 4 失败；修正 Git 规范根比较及路径/SQLite 清理/平台拒绝/预算时序测试，不取消沙箱或 ACL。关联 Host 91 通过/1 opt-in 跳过，本机桌面 21/21。
- [x] 完整回归单独复现旧响应取消的未处理异常，新增先红回归后仅处理 best-effort 清理拒绝；身份拒绝仍生效。身份/HTTP/朗读/伴侣相关 35/35。
- [x] 最终普通全仓4,876通过/0失败/20条件跳过，独立评测58/58；类型16/16、零warning lint、桌面构建9/9、桌面21/21、Memory检查与diff检查通过。相邻App536资源可回退同步，清单/备份统一见 `docs/reports/local-speech-windows-ci-2026-11-13.md`。
- [x] 本人授权后限定28文件正常提交推送 `c3e4fb2`，本地/远端一致、无新分支/强推；提交前关联38/38和桌面21/21通过。新 Actions `43427883983` 的 Windows 桌面作业131893717291已最终成功，含成品启动及自有服务清理。
- [x] 首轮Windows普通4,880通过/3失败/20条件跳过；新增失败是HTTP协议夹具的60秒预算、10ms响应猜测、200次归档等待。两个受控场景本机先红后绿，夹具同步修正后关联26/26通过；仅CI总上限20→30分钟，不改生产预算或安全规则。
- [x] 第二轮修正正常推送 `c67f5d1`，Actions `43431952687` 的Windows桌面及其他平台通过；前轮3项HTTP已过。Windows普通仍4,871通过/2失败/20跳过：40ms生成夹具在预检先耗尽，以及代理文件native进程退出3221226505，原始回执保留。
- [x] 40ms夹具加慢预检在本机两次先红，再按实际生成barrier推进39+1ms，保留abort/原额/1次计量/重开断言。Windows原生退出对照官方Node问题，只调整Windows CI为24.16.0并增5次实际代理回归，完整门不减。
- [x] 第三轮已正常推送 `897f423`，Actions `43435709198` 的Windows5轮代理文件与桌面成品启动最终通过；普通4,880通过/3失败/20跳过，前轮HTTP与40ms生成已过。40ms生成用例本机连续10轮通过，不当作10个不同测试。
- [x] 本机全仓4,875通过/1个UI短轮询失败/20跳过后，150ms实际采用回执先红复现，UI helper改为5秒有界条件等待，8/8通过；双端构建9/9、桌面21/21及536资源同hash可回退同步。
- [x] UI夹具修正后的本机完整重跑退出0：4,876通过/0失败/20条件跳过，随后独立58/58；前次失败原始回执保留，未拼接定向结果冒充完整绿灯。
- [x] 第三轮新失败逐项可复现后修正：字幕等待真实identity就绪、批注按稳定ID覆盖早/晚1ms、Vite夹具根经realpath。原生fs-event崩溃另核对上游精确修复，仅Windows CI Node固定24.21.0；不冒称macOS复现Windows C崩溃。4个Web文件57/57、类型16/16、lint零warning、双端构建9/9、桌面21/21、536资源可回退同hash同步。
- [x] 这批修正后的本机完整 `pnpm test` 实际退出0：普通4,897项，4,877通过/0失败或取消/20原有条件跳过，随后独立58/58。新增1项为另一种批注排序；个人三份SSOT相对本片基线无差异，未触碰真实简历或求职数据。
- [x] 第四轮正常推送 `374aa45`，Actions `43440809655` 的Windows前置门/桌面成品及其他平台最终成功；普通4,883通过/1失败/20跳过，第三轮3项全过。唯一剩余大文本迟到归档先用受控外部读取守卫约4秒复现，再改测试等待生产GET串行发布新修订/artifact后核对完整原文，2/2通过；30秒/3秒迟到/暂停不采用/原计量等保留。原Windows无errno，不伪称已定位具体syscall；无生产实现/权限修改。
- [x] 第五轮补丁关联HTTP/身份26/26、类型16/16、lint零warning、双端构建9/9、桌面21/21通过，536资源同hash可回退同步；完整 `pnpm test` 再次退出0，普通4,877通过/0失败或取消/20原有条件跳过，随后独立58/58。最终Windows仍只认最后SHA的实际Actions，未碰个人三份SSOT或简历/求职数据。
- [x] 第五轮 `a59be31` / Actions `43446485326` 的Windows普通实际4,904项，4,884通过/0失败或取消/20原有跳过，迟到归档和前置门全过；桌面成品亦最终成功。随后独立58项29通过/29失败，同源于Gold原生反斜杠清单key，不是29个新模型质量失败。
- [x] Gold实际递归遍历注入两种路径适配器，Windows约1ms先红后改为逻辑POSIX key/物理原生访问；完整Gold15/15含新增两平台、原hash/许可/标签隔离/篡改/额外文件/链接拒绝均过。该文件加入Windows早期门，冻结v1/旧分数/hash及个人SSOT不改，完整门保留。
- [x] 第六轮补丁完整本机重跑退出0：普通4,877通过/0失败或取消/20原有跳过，独立60/60（新增2条路径回归，旧58条不删）；类型16/16、lint零warning、双端构建9/9、桌面21/21、协议与runtime10/10、Memory/diff/YAML均通过。仅6个评测/CI/交接文件，未再替换安装资源或触碰个人数据。
- [x] 第六轮 `476e59d` / Actions `43452149622` 的Windows普通4,904项再次4,884通过/0失败或取消/20原有跳过，Gold前置门及桌面成品最终成功；独立60项59通过/1失败，报告清单的原生反斜杠使3份PDF前缀计数成0，不是Gold旧29项失败。
- [x] 报告真实遍历的Windows路径适配器约2ms复现同一0≠3后，逻辑key统一POSIX、物理访问仍原生；批次比较复用同一遍历并核对规范key。两平台路径与Gold17/17、实际HTTP到三份PDF文件头/完整字节/hash核验通过；链接/非普通文件拒绝、全计划失败分母、0额外推理和完整门均保留，个人SSOT/旧评测数据不改。
- [x] 第七轮补丁本机完整重跑退出0：普通4,897项，4,877通过/0失败或取消/20原有跳过，独立62/62（新增2条报告路径回归）；类型16/16、lint零warning、双端构建9/9、桌面21/21、协议、runtime10/10、Memory/diff/YAML均通过。限定9个评测/CI/交接文件，安装资源及个人数据不改。
- [x] 第七轮正常推送 `d5ca112`，Actions `43457619995` 的Windows桌面成品5分20秒通过、其他平台也成功（macOS DMG busy未再现）；普通4,883通过/1个反馈UI竞争失败/20原有跳过，独立62项因前段失败未执行。Gold/报告路径前置门成功，不冒称完整评测已过。
- [x] 正常反馈表单在真实identity请求增加60ms延迟后，本机同一2秒/busy=none失败先红；全部五条正向流程共享快照就绪与解除禁用barrier，完整UI10/10通过。两秒上限、原授权/内容hash/采用回退/导出/0自动重跑等断言保留；未改生产实现或权限。
- [x] 第八轮补丁本机完整重跑退出0：普通4,877通过/0失败或取消/20原有跳过，独立62/62；类型16/16、lint零warning、双端构建9/9、桌面21/21、协议/runtime10/10、Memory/diff/YAML均通过。536资源同hash可回退同步至报告最新备份，仅一个合成Web测试及三份交接，个人数据/原服务不动。
- [x] 第八轮正常推送 `f65b31e`，Actions `43462234239` 的Windows桌面5分10秒及其他平台成功；普通4,883通过/1个采集器非法输出用例失败/20原有跳过，前轮UI已过。独立62项因前段失败未运行，未拿前置/本机绿灯替代。
- [x] 真实Git捕获加3.1秒慢准备先红复现0≠1；仅正向合成policy从3秒设30秒，保留慢准备并要求实际处理一次输出/非超时，新增有效JSON模拟泄密实际拒绝和200ms准备超时0模型/保留尝试/不重试。完整采集器15/15过，加入早期门；原CI无错误码，不假装已捕获，新断言附实际码供区分。生产时限/权限不改，新增1条独立测试不是跳过旧断言。
- [x] 第九轮补丁本机完整重跑退出0：普通4,898项，4,878通过/0失败或取消/20原有跳过，独立62/62；类型16/16、lint零warning、双端构建9/9、桌面21/21、协议/runtime10/10与Memory/diff/YAML均通过。仅Host合成测试/CI/交接5文件，Web/安装资源及个人数据不改。
- [x] 最后正常提交 `3a31cf2`，本次实查本地/远端同SHA，Actions `43467648072` 的Windows普通132030936909及桌面132030938146均已最终success，前轮CI阶段结束。仅覆盖该旧SHA；2026-11-14新学习功能尚未发布，不能继承旧绿灯。实际Windows系统音色始终与CI打包分开验收。

## 第一条合成成长闭环 · 2026-11-13

- [x] 最新明确授权范围已完成：现有 Agent → 成长闭环串起目标、合成资料、原代码/原答、真实受限 lookup、持久断点、明确继续固定验证、本人验收及完整 JSON 导出。共用 `AgentTaskKernel` 实现，独立 owner 合成目录，不读取职业任务或写简历/FactBase。
- [x] 重开 GET-only；稳定命令 ID/版本对账，未知不重派；失败修正仍计原根，额度耗尽可读停止，不以新根加额。原请求/断点/报告/项目完整绑定，guest 异常不能冒充权限拒绝，代码/派送前最后一跳撤权有回归。
- [x] Host 全目录 736 项：726 通过/10 条件跳过/0 失败；相关 Web 68/68、Desktop 21/21、全仓类型16/16、零 warning lint、双端构建9/9通过。Browser 重载不增 POST，两个独立 Electron 进程及中间 Host 重启保留 lookup=1；最新536安装资源差异0、成品离线两窗口通过。
- 范围/日志/视觉/回退唯一权威：`docs/reports/personal-growth-first-loop-2026-11-13.md`。0 外部模型/真实资料变更；原正式窗口和服务未由本轮重启。实施验收时未提交推送，随后本人已明确要求将本片沿现有 `agent-os` 发布；最终远端和 CI 以 Git/Actions 回执为准。4/4不作语义评分或独立掌握认证，仍 `pending_retest`；四类外部引擎和此前暂停 R1–R8 不据此算完成或自动续跑。

## Studio 懒加载 504 与白屏恢复 · 2026-11-13
- [x] 实际隔离 Chrome 复现同一 `CareerStudioWorkspace.tsx?t=1794532225701` 动态导入失败，日志定位 `qrcode.js?v=fc225f4f` 连续 504；原服务存活和首页200不足以覆盖懒加载。qrcode 包存在，旧预构建索引缺项；运行依赖同步后须验证模块图或重启开发服务，不能只看存活。
- [x] 仅备份 `.vite` 生成缓存至 `/private/tmp/betterme-vite-recovery.N5vQcx/previous-vite-cache`，正常关闭 Web 后由 `dev-server.mjs --force` 恢复。托管岗位服务沿原目录恢复；Host/OIDC/Ollama 未重启，所有健康200。同 URL 导入转绿，合成组件标题/授权初始区可见、未自动授权、当前资源504为零，截图 `output/playwright/studio-cache-recovered.png` 已目视。
- [x] 本轮为运行缓存修复，没有生产组件修改或适合锁定环境缓存的纯单测 seam；保留实际浏览器红→绿证据，不伪造代码回归。合成渲染断言曾误等未授权前不可见的抗压tab，改验授权初始区后通过；没有为验收建立权限范围。真实白屏窗口需刷新一次，保留账号/数据库/浏览器状态。修复阶段只更新本地记录；本人随后明确要求推送，本次仅提交两份交接记录，缓存/日志/截图仍留本机。

## 相关服务可用性复核 · 2026-11-13
- [x] 本人要求启动相关服务；实查 Web 5173、Agent Host 5179、岗位服务 5178、现有 OIDC 18000 与 Ollama 11434 均已运行。页面/入口模块、Host 与岗位带授权健康检查、Web→Host 同源链路、OIDC discovery 和 Ollama version 均通过。
- [x] 复用原进程，保留账号、数据库、凭据和用户窗口；未重启、调用模型或重启自动目标。执行 `pnpm memory:check` 时 pnpm 自动按新锁同步依赖（缓存复用 167，+167/-88，无下载），检查通过；不声称旧后台已加载本轮新源码。只追加本地状态记录，未提交推送。

## 工作区分组发布与 README · 2026-11-13
- [x] 沿原 `agent-os` 将工作区按共享协议、统一内核、沙箱、Studio、桌面、两组 Web、评测与文档分组提交；隔离 detached 工作树整合远端十个提交，保留发行包安全/持久化后台和菜单栏，没有新建分支或强推。
- [x] README 增补六组详细功能、报告链接及待验边界；归档原本地/远端当前上下文。全仓类型 16/16、零 warning lint、Desktop 21/21、完整桌面构建 9/9 通过；整仓最终结果与发布状态以发布回执为准。
- [x] 相邻 App 534 资源可回退同步，与构建逐路径/字节比对零差异；Electron 45 构建及 Electron 34 安装成品隔离离线两窗口均通过，0 真实模型调用。原服务、账号/凭据/资料和历史 stash 保留；新后台由本人正常重启加载。
- [x] 独立简历评测组 58/58、账号隔离复验 3/3、两个浏览器文件复验 6/6、修正后的旧断言 14/14 通过；普通整仓阶段仍实际 4,817 通过/1 失败/2 超时取消/20 跳过，不拼接定向结果声称整仓全绿。失败、复验和负载/期限取舍均保留回执。
- 不恢复此前暂停的 R1–R8 自动目标、不更新 Release、不默认采用个人候选。原始失败、测试计时取舍、提交和回退目录统一看 `docs/reports/agent-os-workspace-publish-2026-11-13.md`。

## 历史归档索引

- 2026-11-11 及更早阶段进度与待办详情已无损归档至 `archive/progress-history-20261111.md`（更早期记录在 `archive/progress-history-20261107.md`）。
