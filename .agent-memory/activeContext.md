# Active Context

## 当前焦点

2026-10-31 CI 跟进：最新已推送 `9ec50ba` 的 Windows/Edge 完整测试有5项失败，Linux构建与Docker任务通过。根因是3个POSIX可执行夹具、平台路径分隔符断言、PDF测试手工拼接Windows `/@fs` URL；已改为Node可执行夹具、原生路径和Vite实际生成的worker URL，并等待Run持久化收尾再读取/清理。定向23/23通过；完整测试与远端Windows复验继续。严格先让适用CI全绿，再处理8个Hooks警告，不禁用规则、不修改main或真实数据。

2026-10-31 双工作区整合完成验收：用户已暂停另一写入聊天，新增推荐样例/截图补充归档并合入现有 `agent-os`。职业成长、首次分页基线、DeepSeek/PDF、推荐优化及 Agent 权限/审批/预算/检查点隐私修复已整合；全量3370项中3360通过、0失败、10性能压力用例按开关跳过；真实隔离浏览器6/6、类型13/13、构建8/8、lint 0错误8警告、隔离Compose启动/持久化/崩溃恢复/重建通过。仅保留 `简历Agent/better-me`（main，远端稳定03c8e55）与 `简历Agent/better-me-agent-os`（开发分支）；旧副本已私有归档后移除，原主目录源代码另有本地stash，真实数据/浏览器/已有容器保留。提交与远端清理记录见 `docs/reports/worktree-consolidation-2026-10-31.md`。真实Worker调度、原生CLI交互审批、真实模型与大规模性能验收仍属后续工作，不将骨架宣称为闭环。

2026-10-27 修复实时招聘采集当前异常：补全页级懒加载状态，翻页后重置探测；独立平台最多2路并发；BOSS滚动等待不再每轮重复做整页DOM快照；LinkedIn有已验证岗位但部分分页失败时保留卡片并明确标成部分覆盖。将“连续无新增”改成按unknown_layout/ready区分页面未识别与翻页未确认。macOS新建采集浏览器请求后台且隐藏启动（`open -g -j`），采集仍只操作自己的后台target。定向采集/启动/UI测试41/41、Web typecheck和diff-check通过。未抓取真实平台、未重启5173/5178或刷新浏览器；macOS实际窗口层级仍需用户本机观察。若后续继续，优先在用户允许的情况下验证后台Chrome是否仍会显现，并用站点真实错误样本修正51JOB/猎聘首屏解析，不放宽来源字段校验。

2026-10-27 已修复 Agent Companion 图片入口反馈：按钮优先调用原生 `showPicker()`，遇浏览器不支持/异常回退到 `input.click()`；聊天输入框粘贴 PNG/JPEG/WebP 图片时进入既有本地预览流程，不自动发给模型；普通文本粘贴不拦截。先新增按钮与粘贴行为测试，见其因未调用选择器而失败，再实现并通过；Companion 测试6/6、Web typecheck、diff-check通过。未在用户浏览器实际操作系统原生文件对话框，建议刷新热更新后的页面后复试。

2026-10-27 已将本机配套服务并入单一 `pnpm dev` 入口：Vite dev 启动或复用 Agent Host（5179）和岗位索引服务（5178），索引沿用现有仓库外数据目录。健康外部进程不会被接管，异常令牌/Origin/端口不会强行覆盖；关闭竞态会等待 ensure 收尾并只停止自有子进程。Turbo dry graph 确认先 build 所需 workspace 包再运行 web dev；Agent Host + Atlas + Companion 相关测试26/26、Web typecheck 和 diff-check通过。没有重启运行中的服务或刷新 IAB，以保留可能未保存的简历草稿；该编排在下次 `pnpm dev` 启动时生效。

2026-10-27 已收敛 Agent 伴侣的重复入口：Agent 对话作为默认主流程；本机工具默认折叠，CLI 单次运行继续收在“高级功能”。明确该入口不自动继承本对话/简历上下文，提示用户粘贴任务文本；默认不保证 OS 沙箱，运行后显示实际隔离级别；清除“只读 Run”和易误解的“isolated directory”措辞。Companion 定向测试5/5、Web typecheck、diff-check通过。IAB页面仍显示旧版，本轮未刷新或清除站点存储，以免丢失内存中的简历草稿。

2026-10-27 已修复“完整版本已保存，但草稿保护失败”的本地配额问题：草稿 localStorage 写入失败时转存独立 IndexedDB 草稿库；启动时按保存时间与完整版本比较恢复；备用写入成功清除误导性警告，双存储均失败则明确提示立即下载备份。存储回归46/46、storage typecheck、diff-check通过；临时Playwright会话真实调用 IndexedDbDraftRepository 完成写入/读取往返。未清理数据、未碰原浏览器标签。后续仅在用户备份确认后，再讨论是否清理其他同源旧数据以释放空间。

2026-10-27 已完成 Agent Companion 图片问答闭环：聊天框支持选择 PNG/JPEG/WebP，单张 <2 MB、每条消息最多3张，本地预览与逐张移除；仅用户发送时附入该条聊天的多模态请求，历史图不向后续轮次重复发送，成功发送后清理待发态。拒绝 SVG/超大图片，增加 Host JSON 请求体16MB上限与413响应；定向 Companion/客户端/Agent Host 测试30/30、Web 与 Agent Host typecheck、diff-check通过。没有触发真实模型请求或做浏览器目视验收。

2026-10-27 已把图片问答规则延伸到完整 AgentWorkspace，并增加模型视觉能力提示：只对明确已知的模型家族标记支持/不支持，Ollama 与自定义兼容网关未知型号保留“未验证”；已知纯文本模型阻止发送，未知模型允许用户在知情下尝试。两处入口均只把当前轮图像发给模型，之前图片字节不再随之后问题重发；Companion 已发送图片展示去重。模型能力、历史附件过滤与纯文本模型拦截用例覆盖；定向测试23/23、Web 与 Agent Host typecheck、`git diff --check`通过。未向真实视觉模型发送图片或做浏览器目视验收。

2026-10-27 Agent Companion 空间与回复动效收尾：对话占主区，模型服务与本机工具默认精简/折叠；工具区展开时仍为独立限高滚动，消息记录单独滚动、输入固定底部，等待状态固定在记录下方。新回复逐段显现、可跳过；减少动态效果时直接显示完整 Markdown。Agent Companion 与聊天客户端定向测试8/8、Web typecheck、diff-check通过。IAB桌面页检查折叠和展开态后已恢复关闭；未发真实模型请求。当前机器无法用受支持 viewport API 做移动尺寸复核。

2026-10-27 已补齐 Agent Companion 的简历隐私授权缺口：普通聊天默认不携带任何简历摘要；用户显式开启后才发送活动简历视图的简介、技能、可见经历要点，排除姓名、联系方式、头像与全文；撤销授权对下一条请求立即生效。独立引用仍只随该条问题发送。增加脱敏摘要构建和工作台请求体测试；Companion/上下文/Agent Host chat 定向测试17/17、Web 与 Agent Host typecheck、`git diff --check` 通过。未触发真实模型请求或浏览器真实页面验证。下一步可继续完善伴侣附件图片的明确授权与上传交互，确保图片不会在未预览/未发送时进入模型请求。

2026-10-27 已将简历“引用回复”闭环落在右下角 Agent 伴侣：简历预览选区和 FactEditor 引用都只打开伴侣，不再切换到 AI 顾问整页；伴侣展示/移除引用，在面板内发送引用问答并展示 Markdown 模型回复。真实浏览器已验证选中文本→点击引用入口后仍停留简历工作室、引用载入且伴侣自动展开；未发送问题、未触发真实模型。引用问答与聊天客户端定向测试 7/7、Web typecheck、`git diff --check` 通过。下一步如需可继续目视微调伴侣内的回复卡片与小屏布局。

2026-10-27 已补齐 Agent 答复不完整问题：聊天 Host/浏览器直连按模型长度结束原因最多自动续答两次、标记仍不完整并可手动继续；快速 Run 不再按单个 stdout chunk 的前500行静默丢行，单行长答案上限提高至80,000字符且超限可见标记，Companion 收到权威 `replace` 答复时替换临时流片段。模型来源/状态标签和 Markdown 答案展示保持分离。Agent Host 41/41、回复相关 Web 20/20、Web typecheck、`git diff --check` 通过；未使用模型服务做真实生成 E2E。

2026-10-27 已修复截图暴露的 Agent 快速运行失败：Claude Code 2.1.218 在 `-p` + `--output-format stream-json` 下强制要求 `--verbose`；Builtin definition 与 Claude Worker Adapter 已补齐并加回归测试。重启 5179 后真实 HTTP Run 和浏览器 Companion 输入“你好”均返回完成，时间线显示文本输出与 `run.completed`。

2026-10-27 已完成 Agent Companion 入口的主题与交互收尾：补齐 `agent-companion.css`，运行时轨道保留前5项并以 `+N` 图标堆叠折叠其余项，使用 Lucide 品牌感图标和语义 CSS token 跟随森林/藏蓝/梅紫/石墨及明暗主题；`App` 已传入 LLM 配置与模型设置入口。桌面、深色和 390×844 移动端已用真实浏览器验证，折叠 aria 状态、未安装禁用、移动端滚动与横向溢出均正常。Web typecheck、Agent 定向测试、build 和 `git diff --check` 通过。

2026-10-26 已开始实现 BetterMe 本地 Agent 基座 M0：新增共享 Zod 契约、Runtime Registry、独立 Run/SSE 事件总线、Worker Adapter、默认 Career Orchestrator 审批图，以及右下角 Agent Companion。5179 当前已启动并真实探测到 Claude Code、OpenCode、Gemini CLI、Codex；Career 工作流能在 `SearchPlan`/`CoverageReceipt` 后暂停审批。Run 已写入 `run.json`/`events.ndjson`，服务重启可恢复已结束记录；默认仍是 shell-free `process` 隔离，OS 沙箱仅在显式启用且提供者存在时使用，不能把不可信 CLI 当成生产最小权限运行。

2026-10-26 已定位并修复“4901 个岗位但地图像没有办公点”的显示误解：当前服务快照为 4901 岗、227 个真实来源坐标、4674 个无精确坐标岗位；227 个逻辑点实际重叠在 20 组经纬度。地图现在对同坐标地址显示可见聚合标记和地址/岗位数，机会标题旁也常驻显示“真实坐标 / 承载岗位 / 待定位”口径，点击仍可逐个选择真实来源地址；不把城市中心或未知地点伪装成办公室。

1. **实际覆盖**：最新两词合并：猎聘10/10页、51JOB6/10页（C#首屏未读到，.NET取得150卡）、BOSS40/40次滚动、LinkedIn10/10页，全部属于有限预算/部分覆盖。上一完整采集轮取得656卡并新增190岗；更早一轮新增274岗；最后UI复核只提交首块新增6/更新19后已停止重复入库，825张不能声称已全部入库。
2. **地图与地区**：最终UI为3053岗/revision2959，上海C#严格匹配324岗、10个可点位置、314岗无精确位置。按精确理由前缀隔离了603条历史推测办公室（其中旧上海C#地图310条），恢复来源地点，不删岗位或历史决策。剩余10点未逐个独立审计。自动导入不再生成企业园区/抖动办公坐标。
3. **代码与验证**：首屏实际卡片等待、BOSS真实滚动、来源地点恢复、CAS有限重试、逐批累计计数、最终快照版本校验、跨国家/模式旧回执清理、实时/索引切换均已修复。最终Workspace/实时视图/流水线77/77、仓储相关44/44、Web与job-service noEmit及diff-check通过；此前采集解析197/197、实时批次26/26通过。全文件lint有既存未使用import/空catch问题，未声称全仓lint通过。
4. **运行现场**：Vite由dev-server.mjs启动，localhost:5173（IPv6）；5178本机服务使用现有私有数据目录。Chrome9222会话未重启。重启前完整SQLite备份pre-final-refresh-2026-10-26.sqlite，immutable quick_check=ok、3047岗。IAB原草稿tab3保留；最终新tab5显示825实时卡片，第2页51–100/825可滚动、有原文链接，截图output/atlas-live-csharp-825-2026-10-26.png；旧验证tab4已关闭。后续用户要求启动服务时，已重新启动Vite及5178岗位服务，前端与bootstrap接口均HTTP200，沿用现有数据库。
5. **本轮地图复核**：通过运行中的 `/api/v1/jobs/search` 复现 `totalJobs=4901, mappedJobs=227, unlocatedJobs=4674, locationPinCount=227, nextCursor=true`；即使列表页 `limit=1`，完整地图桶仍为227，排除只取第一页。新增 exact-coordinate stack marker、hover 提示、底部和机会标题旁的“真实坐标/来源地址/岗位”口径；浏览器 AX 实测同页显示 4901 / 227 / 4674，focused map/query/workspace tests 61/61 与 Web noEmit、diff-check 通过。
6. **Agent 基座 M0**：`packages/agent-contracts` 提供 Runtime/事件/Artifact/ContextPack/Run/Approval Schema；`apps/agent-host/src/runtime` 扫描 PATH 与 macOS fallback，并通过 Worker Adapter 统一 CLI 参数和 Claude/Codex/Gemini/通用输出；`src/runs` 使用参数数组、超时/取消、独立目录、`run.json`/`events.ndjson` 恢复；`src/events` 支持 sequence + SSE 回放；Career Orchestrator 暂停于审批门禁；Web Companion 实测显示本机运行时、快速运行入口和实时事件区。Agent Host 定向测试26/26、Agent client SSE 2/2、契约/Host/Web typecheck与 Web build 通过；仓库级 `pnpm test` 为 2617 项：2593 通过、1 跳过、23 失败，失败主要是本机未安装 Edge、既有浏览器/session 夹具与开发中间件时序问题，未将其归因于本批 Agent 代码。
7. **模型接入核验**：Ollama 已是现有受支持的 OpenAI-compatible provider；本机 `127.0.0.1:11434` 的 `/v1/models` 可读到 `gemma4:e2b-it-qat` 与 `gemma4:31b-cloud`，API Key 留空时浏览器直连和 5179 Agent Host 均已完成真实对话验证。Antigravity 桌面应用的账号额度没有公开的 OpenAI-compatible API，Runtime Registry 中的 `antigravity` 仅是未安装 CLI 的占位探测，不得读取或复用内部 host-bridge token。

## 卡点

当前卡点：Windows CI 的5项跨平台测试失败正在修复并等待远端复验。此前并发写入已由用户暂停、最后差异已归档整合，旧副本与已合并分支清理已完成；以下旧运行现场信息仅为历史限制，不能据此声称当前浏览器或服务状态。

尚未达到全站完整覆盖或稳定低延迟。51JOB的C#首屏仍未取得可验证卡片；.NET后续真实成功150卡，不能笼统说51JOB全失败或无岗位。大库每证据块重复全量投影/校验/索引重建，补充行政地区与企业分类逐条CAS很慢，曾使snapshot请求超过60秒；本轮停止后续补充处理，保留原站卡片。仅对canonicalProjection的地点/alias查找做语义不变Map优化，不能宣称整个慢链路已解决。上海严格命中没有随总索引增长，仍需处理来源地区结构化与历史错误行政覆盖；不能放宽地理条件或用推测坐标凑数。浏览器存储已满，原草稿仅在内存，禁止刷新/关闭原tab3。

## 下一步

完成跨平台回归后正常提交推送并盯完全部适用CI；全绿后修复8个Hooks警告，测试推送并再次跟到全绿。继续仅保留 `main`、`agent-os`，不新建功能分支，不清理运行中容器/个人浏览器资料；完成后停止本次CI心跳监控。

0. Atlas 地图与实时抓取等待体验收尾（2026-10-27）：未选岗位默认两栏、空详情栏不占位；实时商业平台请求走 SSE，向页面推送 queued/start/page-scroll-card progress/逐平台结果，最终回执仅用平台 ID + 时间戳，不重复传卡片；每流24 MiB限额、写入背压、客户端断流取消；真实地图仍只显示已核实坐标。定向测试通过后无需重启用户正在使用的工作台以规避未保存简历草稿风险。
1. Agent Companion 当前布局/等待状态/逐段回复与减少动态效果回退已完成；若后续继续，优先补齐附件图片的预览与逐次发送授权，不触发用户未授权的简历/图片数据传输。
2. 优先补齐真实来源披露的街道/门牌与可审地址证据；当前4674条无精确坐标不能靠城市中心补点，需来源原文或本人核对后才进入办公地图。
3. 优先优化真实大库入库/行政地区处理：保留CAS、来源证据和失败回执，测量全量投影/校验/关系表与FTS/Rtree重建开销，再做增量或批处理；不要在真实采集运行时编辑触发热重载。
4. 审计来源披露地点到结构化地区的链路及历史错误行政确认；新地区缺失和旧海外岗位误归上海都不能靠放宽筛选掩盖。严格上海C#324与原站返回825是不同集合。
5. 核对51JOB失败查询的实际页面与解析诊断，区分加载/布局/读取异常；随后标准/深度模式逐站实测，记录停止原因，不把上限当全量。
6. 保存原草稿需单独处理存储空间问题；当前原页保留、新页验证，不自动清理用户版本或重启Chrome会话。
7. 在真实 CLI 样本上逐个验收 Worker Adapter 的协议参数和输出 fixture；再把真实平台抓取、公司研究、地点工具和确定性写入接到 Career Worker。OS 沙箱通过 `--sandbox required` 或 `BETTER_ME_ENABLE_OS_SANDBOX=1` 显式启用，继续保留缺少提供者时 fail-closed。

## 必读附加

- `docs/reports/worktree-consolidation-2026-10-31.md`（本轮恢复入口；原有附加清单为历史技术上下文）
- `apps/web/src/components/atlas/harvest-pipeline.ts`
- `apps/web/server/jd-live-batch-search.ts`
- `apps/web/src/components/AtlasWorkspace.tsx`
- `apps/job-service/src/repository.ts`
- `apps/web/tests/harvest-pipeline-commit-summary.test.ts`
- `packages/agent-contracts/src/index.ts`
- `apps/agent-host/src/runtime/registry.ts`
- `apps/agent-host/src/runs/run-manager.ts`
- `apps/agent-host/src/runs/sandbox.ts`
- `apps/agent-host/src/runtime/worker-adapter.ts`
- `apps/agent-host/src/graphs/career/graph.ts`
