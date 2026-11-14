# PDF 中译英独立试点（2026-11-14）

本文保留模拟协议阶段的原始结论。之后真实安装、转换/取消、双端恢复及**译稿质量仍未放行**的当前停点，统一见[真实本机续片](learning-translation-real-2026-11-14.md)；不要把下文“未安装”当作最新运行状态。

## 本轮范围

在此前资料/练习/隔时复测链上增加独立、可恢复、owner 私有的 PDF 翻译作业。不变更简历、求职、FactBase、聊天模型设置或原有成长预算。翻译是本人单次明确授权的文档转换，不是第二个 Agent。每个作业最多 32 次模型请求、10 分钟；所有上游重试必须先记账。一个 owner 一次转换，本机原生转换全进程一次。

当前主机只读检查：Ollama 有本机 Gemma 权重及另一个 cloud 别名，后者不用于该试点；没有安装 PDF2zh，默认 Python 3.14 不符合固定版本要求。未下载引擎、布局权重或字体包，不调用收费模型。不能因此报告“真实中译英质量通过”。

## 实现与停止线

- 稳定请求编号先落本机 journal，再提交；Host 先以 FULL synchronous SQLite 保存作业，再启动。创建丢回执按原编号只读核对，重开只 GET。取消/审阅也保存待核对动作，明确重试复用原编号。
- 原件 ID/hash/revision、语言方向、本机模型 digest、术语表和单双语选择冻结。相同请求返回同一记录；不同内容不能复用编号。扫描、多栏未校对或超过 10 页拒绝，不偷偷调用 OCR。
- 进度来自引擎事件，不用定时器伪造；缺少进度显示未知。取消、退出账号、撤权和 Host 关闭拒绝迟到模型结果/候选文件。历史用量不归零；Host 中断不重排队。
- PDF 字节单独校验类型/大小/hash，私有 no-store 二进制接口；生成只到 `review_required`。原页、候选画布和提取文本分开复核。六项本人审阅绑定保存的候选，接受/拒绝不可静默改写。模拟件不能接受为译文。
- 可选 PDF2zh-next 2.10.2 / BabelDOC 0.7.1 原生 adapter 使用明确的可信安装路径、离线资源缓存、当前单独选择的本机 Ollama 权重。Python 模块与版本不合要求即阻止；不继承 API Key/代理环境，不读取 BetterMe 模型配置。每个实际模型请求走临时能力令牌代理和既有 `createLocalOllamaClient`，仍逐次检查本机权重/remote 标志；不直接交付模型密钥。
- 原生 adapter 仅 POSIX 试点：进程组停止、终止后再清理自己创建的临时目录。Windows 原生进程隔离/清理未审查时明确不可启动；Web/桌面记录与审阅可用，不宣称 Windows 原生翻译可用。Python socket 约束不是 OS 沙箱或恶意原生依赖隔离。

## 双端 QA 清单（先列，实测另记）

| 承诺 / 控件 | 功能核对 | 视觉核对与预期证据 |
| --- | --- | --- |
| 成长页折叠入口、引擎只读刷新 | 不安装/不推理，不更改聊天默认模型 | 初始未就绪、明确不可点击开始 |
| 原件选择、语言、模型、单双语、术语表 | 冻结精确版本；改选撤销本次勾选；不读 FactBase | 模型为空、单/双语、错误术语格式 |
| 独立同意、开始、中断、取消 | 无同意零写入；稳定编号、单次派送、取消不收迟到结果 | 有进度/无进度/已停止 |
| 关页/重开/重启 Host | 恢复只读，授权不恢复，模型调用与执行 POST 不增加 | 原作业/中断停点；Web、全新 Electron |
| 未确认动作、只读核对、明确原动作核对 | GET 不重发；重复原 ID 不重复启动；内容冲突拒绝 | 待核对状态与下一步 |
| 单双语候选、页码、原页对照、文本、收起、下载 | 校验 hash/字节/类型，逐页可看，草稿文件名 | 原件/候选画布与文本；模拟件明确非译文 |
| 六项审阅、两项确认、接受/拒绝、导出回执 | 缺项或模拟件禁止接受；拒绝保留原因 | 未检查/失败/不涉及/冻结结果 |
| 撤权、跨 owner | 原件/译稿不可读、后续请求停止；历史计量保留 | 撤权后无候选正文/预览 |
| 浅/深色、390px、键盘与桌面窗口 | 44px 控件、焦点可见、无横向溢出 | 两种主题下设置、待审、密集对照 |

额外探索：真实 Host 已保存但创建响应丢失；转换中另一窗口撤权；空白/缺页输出；Host 中断后原请求再核对。模拟结果只验证作业协议，不构成英文翻译成绩。

## 上游核对

固定版本源代码和许可，不混用 PDFMathTranslate 1.x 与 PDF2zh-next 2.x：

- [流式 API 文档](https://pdf2zh-next.com/advanced/API/python.html)：progress / finish / error，以及结果对象与取消。
- [2.10.2 设置与版本](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pyproject.toml)：Python >=3.10,<3.14；AGPL-3.0；BabelDOC >=0.7.1,<0.8.0。本试点进一步固定 BabelDOC 0.7.1。
- [2.10.2 实际实现](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pdf2zh_next/high_level.py)、[设置](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/blob/v2.10.2/pdf2zh_next/config/model.py)：中文→英文、单语/双语和 debug 模式接口。
- [BabelDOC 0.7.1 资源实现](https://github.com/funstory-ai/BabelDOC/blob/v0.7.1/babeldoc/assets/assets.py)：字体、CMap 与布局资源应另行准备、校验，不应在使用私有 PDF 时隐式下载。

AGPL 依赖尚未打入 BetterMe 分发包；未来实际服务/分发组合须针对许可证条款评估。进程分开不是许可豁免，也不在本报告提供法律结论。

## 实际功能验收

全部使用原创 PDF、独立合成账号及临时 Host，没有真实推理。`simulation=true` 的 adapter 故意交回原中文 PDF，界面和文件名均明确不是英文译稿；不能接受为译文。这是作业协议验收，不是译文质量成绩。

- **Web 丢回执**：真实 Host 已保存创建记录，再由浏览器把响应改为 502。重开/按原编号只读核对后，同一作业只启动一次、两次模拟模型回调；不再次 POST 创建。补测同页不重开场景，提交尝试即清除本次勾选，GET 核对后新作业仍禁用。错误术语零派送。回执分别为 `output/translation-acceptance/web-job-receipt.json`、`web-consent-consumed-receipt.json`，观察日志为 `web-observed.log`、`web-review.log`、`web-consent-consumed.log`。
- **实际 Electron 45.2.3**：最终以原创 v2 作业 `lt_b32c3703a13280110b2058eab5734ca9` 恢复，owner `1e756a11-2d67-43aa-a1aa-7ad3e1dbd561`，原件 hash `3b282f5f4bd7e782354fc8e2b2077c2d8e1a3cf3182c0f5d0034f4ffcf332cfa`。全新进程、再开进程、专用 Host 重启后再开三个区间成长执行 POST 均为 0，计量不增，单次勾选不恢复，speaking/pending 均 false。原件/候选画布、原生 preload 和下载实际使用；不是把 Web 视口改大当桌面验收。
- **停止**：最后的原生新作业 `lt_a6fc02fd9692c40531228e66d261b09a` 在已派送后停止，`modelCalls=1 / inputBytes=74 / outputBytes=0`；无候选。重启 Host 后同一账单不变。主回执 `output/translation-acceptance/native-observed-summary.json`，专用 profile `/private/tmp/betterme-learning-electron-mB5H50`；前一版证据保存在 `native-source-v1-observed-summary.json`。台账最终 7 次模拟 adapter 启动、8 次模拟模型回调，**外部模型 0 次**；这些累计数包含多次主动验收，不能当成恢复时的新增执行数。
- **跨窗口撤权**：一窗口在转换中，另一窗口明确撤销同一原创 v1；约 1843ms 后原窗口显示原件撤权、无候选画布，保留已经发生的 1 次请求。`web-revoked.log`、`web-revoked-receipt.json` 保留原始结果；认证 HTTP 测试另外验证跨 owner 元数据、原件/译稿字节及命令均拒绝。
- **审阅/导出**：三页原件/模拟候选实际渲染，文本单独展开，下载字节与 PDF hash 复核。Poppler 提取同样仍为中文，未伪造英文结果；六项均记问题，接受按钮禁用，明确拒绝后原因/冻结回执可恢复。`web-rejected-receipt.json` 不表示六项真实译文测试通过。
- **默认未安装状态**：另一个无注入引擎的 5336 临时 Host 实测显示未配置原因，开始禁用，成长 POST=0、外部模型=0。不是在主模拟页拦截能力响应来假装生产不可用状态。

人工可重复入口：先启动 `apps/web/tests/ui-lab/learning-translation.config.ts` 的 5337，实际 UI 导出作业回执；再执行 `node apps/desktop/tests/learning-translation-acceptance.cjs <回执文件>`。脚本只使用指定端口及自己的临时 profile，非普通测试自动启动项。生产环境不提供 QA 时钟或重启接口。

## 界面复核与改进

| 复核前 | 复核后 / 实际证据 |
| --- | --- |
| 停止原因暴露 `translation_cancelled` 机器码 | 中文说明停止、已发生计量、不自动续跑；`output/playwright/translation-native-cancelled-before.png` → `translation-native-cancelled.png` |
| 同页创建丢回执时可能保留旧勾选 | 提交尝试即消耗；只读核对不授权下一作业，实际一派送/两回调；`translation-web-consent-consumed.png` |
| 术语空值会直接展示 Zod 技术错误；有失败项仍可尝试接受 | 本机可读校验、零派送；缺页/无文字层/失败项/模拟件禁止接受；`translation-web-review-light.png` |
| 仅有宽屏布局不能说明窄屏可用 | 390×844 浅深色、单列原页/候选、实际 scrollWidth 384、按钮/选择框无低于44px、Tab焦点 solid；`translation-web-mobile-light.png`、`translation-web-mobile-dark.png`、`translation-web-mobile-preview-dark.png` |
| 文件生成容易被误读为质量完成 | `review_required`、原页与候选、提取文本和六项本人审阅分开；模拟件明确不是译文，默认不可接受 |

使用 PDF 及界面打磨技能的实质影响：保留独立字节来源，在真实画布之外复核提取文本；以观察到的错误、窄屏和键盘状态改进，不拿截图好看或成功出文件当翻译正确。

## 回归、发现与修复

最终 `pnpm test` **实际退出 0**：普通 **4,921 项，4,901 通过 / 0 失败或取消 / 20 原有条件跳过**；独立简历质量 **62/62**。日志 `output/translation-acceptance/full-test-final.log`。类型 **16/16**、双端构建 **9/9**、lint 零 warning、桌面普通测试 **22/22**、runtime **10/10** 均通过。定向原生代理测试 **2/2**，验证能力令牌、来源拒绝、并发占位、环境不继承、进程组退出及精确临时目录清理；仍不是 PDF2zh 实装验收。

收尾定向再跑翻译Host/认证HTTP/原生代理/Web客户端共 **14/14**，见 `targeted-final.log`。最终390px复核 scrollWidth=390，四个可点击同意标签高度为44/57.59/44/44px，`web-mobile-final.log` 与 `translation-web-mobile-final-dark.png` 留证。已关闭本次两专用浏览器、所有专用Electron，正常停止5336/5337及其临时Host；个人窗口/默认服务/Ollama不动。交接时5173/5179无监听，没有擅自拉起。

保留红→绿证据，不覆盖失败记录：

1. 全仓首先在地图恢复测试失败：源码已把多个页面的初始化合并进一个 effect，旧正则要求单行且依赖必须恰为 `[page]`。语法检查确认 Atlas 调用及 `page` 依赖仍在；只改测试为 AST 结构断言，并验证遗漏依赖/错误调用为红，不修改并行页面实现。`atlas-repro.log` 与 `full-test.log` 保留原失败。
2. 原生代理协议替身复现并发拒绝请求错误释放别人的占位，允许第三个请求进入。改为只由取得占位的请求释放；`native-protocol-red.log`、`full-test-before-proxy-fix.log` 保留失败，`native-protocol.log` 及最终全仓为绿。卡住的测试只停止已确认的专用进程组，未停止正式服务。
3. 桌面验收脚本曾误读上一份作业的 2/32，在新作业尚未派送时停止，真实回执为 0。修正为先只读刷新新作业再验证停止；没有把 0 篡改为 1，也不把提前停止当生产错误。

## 桌面资源与数据边界

`scripts/sync-local-desktop-dist.mjs` 已最终逐文件同步 **616** 资源，清单 hash `b58b3dfbc05cd58d64c3b900f97bba56c2da09da3603a735d4dbce010c56df17`，未重启默认应用或触碰 profile。当前上一版完整备份为相邻 `.unified-agent-app-zgfZ5d/previous-dist`；本轮开工前 587 资源的备份为 `.unified-agent-app-YwuaKm/previous-dist`，其 hash `0e87293c26808f592fefbe308e7d5ec75dd5b59cdc80a7dc3e79511eb017534a`。

安装入口的 actual main/preload/React 再做隔离离线两窗口验收，真实服务/模型请求 0，原始回执 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-electron-offline-SG7NtZ/summary.json`。离线 smoke 的“服务已运行”输出是拦截的合成健康响应，不表示本轮启动了正式 5173/5179。

工作区另有并行壁纸、模型设置、Autopilot、地图和版式改动，保留原样；类型错误由并行工作修好，不归为本片修复。桌面构建资源包含工作区当前组合，不表示本片拥有或已发布那些改动。三份个人 SSOT 与 Gold 目录 diff 为空；学习临时 Host 不访问职业数据目录，职业写入 0。没有提交、推送、创建 Release 或恢复暂停目标；仍为 `agent-os` 的未提交实现，旧 `3a31cf2` Windows 绿灯不能替代本片 CI。

## 仍未放行的下一步

1. 先在**独立** Python 3.10–3.13 环境准备固定版本引擎和校验通过的离线资源；不覆盖默认 Python，不共享个人 BabelDOC 缓存，不默认拉云端模型。`BETTERME_PDF2ZH_PYTHON` / `BETTERME_PDF2ZH_ASSETS` 仅由可信 Host 配置，不能由网页请求传可执行路径。
2. 只有实际跑原创样本后，才能记录真实中译英漏页、数字单位、否定词、公式、阅读顺序、英文溢出、耗时和资源。当前**零份真实英文译稿质量通过**，原生 adapter 是未实装验证的实验接口；不得开 production-ready 标签。
3. Windows 原生进程隔离/取消清理与实机声音仍需独立验收；OXR 硬件/代码及权重许可、标注样本对照仍未完成。DeepTutor 仍先借教学方法，服务收益和共享账号边界未过门，不接管 BetterMe 长期状态。
