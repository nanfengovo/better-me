# 电脑端视觉自动化：JD 获取、受控投递与本地 MCP 证据核对

核对日期：2026-11-05。状态：研究建议，未实现、未安装依赖、未调用模型、未访问招聘账户、未执行真实采集或投递。外部来源限定为项目官方文档、官方仓库、操作系统官方文档和 MCP 规范；文中“建议／推论”是 BetterMe 的设计判断，不是供应商保证。

## 结论

**电脑端 OpenCV + OCR 可以作为读取可见 JD 和定位界面的辅助能力，但不是一个完整的自动投递系统。** 应拆成“感知、理解、授权、执行、结果核实”五层。优先使用允许访问的 DOM／无障碍树；没有语义接口时，才使用授权窗口截图、OCR 和 OpenCV。Playwright MCP 官方也采用默认 accessibility snapshot、vision fallback 的路线。[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Vision Mode](https://playwright.dev/mcp/vision-mode)

建议的技术次序是：**只读 JD 助手 → 用户核对的材料准备／填表 → 明确许可范围内的逐次受控执行**。跨平台无人值守批量投递不能从“能识别按钮”推导出来；本报告没有验证三家平台的最新许可、任何封号风险降低效果或稳定自动投递能力。

当前仓库的[国内平台投递行动卡](../domestic-delivery.md)已经区分准备、本人操作、本人回执，并单独记录发起沟通／共享简历／提交岗位申请。视觉工具应扩展这些既有业务对象，不能另建一份 Agent 私有投递账本，也不能把截图识别成功写成“投递成功”。

## 1. 感知和执行必须分开

| 层次 | 可以承担的职责 | 不应据此推断的事 |
| --- | --- | --- |
| 截屏适配器 | 用户选择目标窗口；记录帧时间、窗口身份、尺寸、缩放 | 能截图不代表能控制，更不代表平台允许采集 |
| OCR | 提取文字、文本框、识别置信度 | 文本完整、字段正确、岗位真实、动作已生效 |
| OpenCV | 区域裁剪、帧差、模板／锚点候选定位 | 理解业务含义、用户授权、语义按钮唯一性 |
| 本地模型 | JD 字段归一化、缺失信息提问、候选动作计划 | 获得输入控制权、允许上传资料、获准发送 |
| 确定性执行器 | 在批准范围内执行有前置条件的动作 | 点击被系统接收就等于服务端完成 |
| 结果核实器 | 匹配岗位、动作和可核对的结果证据；保留不确定状态 | 按钮消失、超时或没有回复就等于失败 |

上述是建议的模块契约。截图 API、OCR、模型和输入 API 的能力本来就不同：Windows 分别提供屏幕帧获取与 SendInput；后者返回的是成功插入输入流的事件数，而非业务结果。[Windows 屏幕捕获](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)

### JD 获取的最小可信输出

建议每条记录包含 `sourceUrl/platform/jobId-or-sourceKey/capturedAt/sourceMethod`，以及岗位、公司、地点、薪资原文、要求原文、字段证据、缺失项和完整性状态。DOM 原文和 OCR 原文都应当保留“来源与提取结果”的区别；模型不能替来源补全薪资、学历、招聘人身份或任职要求。

只截当前一屏时标记 `partial`；滚动采集要有段落去重、头尾覆盖与终止条件，无法证明完整时不要伪装成完整 JD。证据只保留必要的目标区域，默认不保存全桌面、聊天联系人、验证码或其他应用内容。这是数据最小化设计建议，尚未测试本机效果。

## 2. 浏览器语义优先，OpenCV 是 fallback

### 浏览器路径

Playwright MCP 提供结构化无障碍快照；vision 模式补充基于截图坐标的操作。官方建议普通网页使用快照引用，Canvas／缺少 ARIA 的自定义控件才考虑视觉模式；snapshot boxes 使用的是视口相对 CSS 像素，不应直接当作操作系统全屏像素。[Playwright Vision Mode](https://playwright.dev/mcp/vision-mode)

BetterMe 的设计推论：同一浏览器适配器先尝试语义定位并核对角色、文本、所属岗位和容器；视觉 fallback 不能悄悄扩大到整个桌面。无障碍树和网页正文都属于外部不可信输入；页面中的“忽略规则”“上传所有文件”等文字不得成为执行权限。

Playwright MCP 官方明确说明它不是安全边界，`allowed-origins`／`blocked-origins` 也不是安全边界，且不覆盖重定向。因此仍需 BetterMe 自己实施工具权限、目标范围、文件选择、审批与网络隔离，不能只配一个域名参数就宣称安全。[Playwright MCP 安全与配置说明](https://github.com/microsoft/playwright-mcp)

### OpenCV 能解决什么

`matchTemplate` 用模板在较大图像上滑动比较，生成匹配度图；`minMaxLoc` 可以找到极值。多目标需额外阈值等处理。这是像素相似度，不是“这个按钮就是当前岗位的提交申请”。[OpenCV 4.13 模板匹配教程](https://docs.opencv.org/4.13.0/d4/dc6/tutorial_py_template_matching.html)

由算法输入和输出可以推论：缩放、主题、按钮禁用态、字体、窗口大小、浮层以及重复按钮都会影响候选定位。单个固定模板不能证明身份与可点击性；多尺度匹配也不能替代业务校验。推荐将 OpenCV 用于稳定锚点、帧差、候选区域筛选，不把“超过一个匹配阈值”直接连到最终发送。

### 坐标不能长期复用

建议每次候选操作绑定 `frameId/windowId/capturedAt/displayScale/viewport/targetBox`；执行前重新确认目标窗口、前台焦点、框内内容与帧是否过期。窗口移动、浏览器缩放、跨显示器、滚动、弹窗或用户接管后使旧坐标失效。实际要覆盖 CSS 像素、截图像素与系统输入坐标之间的映射，不能只乘一个固定比例。

Windows 官方也指出，动态 UI 的同步和焦点变化会使重复操作困难。这支持“重新观察—校验—执行—再观察”的受控循环，而不是录一串坐标反复播放。[UI Automation 自动化测试说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usefortesting)

## 3. OCR 与本地模型选型

### PaddleOCR：值得作为首个中文 OCR 候选

官方模型文档明确列出 PP-OCRv5 的简体、繁体、英文等识别支持。官方文档里的测试集和指标不是 BetterMe 招聘截图的验收结果，也不能替代对薪资、地点、中文标点、滚动拼接和小字号的专项测试。[PaddleOCR 文字识别模块](https://www.paddleocr.ai/main/en/version3.x/module_usage/text_recognition.html)

**PaddleOCR 已有官方 MCP Server 集成**，无需为了“接 MCP”从零包装 OCR。当前文档列出 `local`、`aistudio`、`qianfan`、`self_hosted` 四类来源，默认 stdio，也支持 Streamable HTTP；本地模式需要相应推理依赖。选择本地或自托管是配置和部署决策，不能因 MCP 进程在本机就推断截图不会发往远端。[PaddleOCR MCP Server](https://www.paddleocr.ai/main/en/version3.x/integrations/mcp_server.html)

建议首轮使用明确的本地 OCR pipeline，仅允许受控截图目录，不接受任意文件路径／URL；下载模型的网络行为与运行期图片处理分别审查。官方仓库代码为 Apache-2.0；上线时仍应固定包与模型版本，核对所选权重、推理引擎及传递依赖许可，而不是将仓库许可泛化为所有部署产物许可。[PaddleOCR LICENSE](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)

### Tesseract：作为离线基线，不预设性能输赢

Tesseract 官方提供 `chi_sim` 和 `chi_tra` 语言数据，主代码为 Apache-2.0，依赖可能采用其他许可证。适合做一个可复现的离线对照；本报告没有测得其在三家平台截图上更快、更准或更轻。[官方语言数据](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions)、[Tesseract 主仓库与许可](https://github.com/tesseract-ocr/tesseract)

### Ollama：可承担规划与结构化，不直接接管桌面

Ollama 官方支持 tool calling；其模式是模型提出工具请求，应用执行工具，再将结果交回模型。BetterMe 应在应用执行层检查授权、参数与上下文，不能把模型生成的工具名当作权限。[Ollama Tool Calling](https://docs.ollama.com/capabilities/tool-calling)

Ollama 支持用 JSON Schema 约束输出，适合 JD 解析、缺失字段和候选动作结构；仍应做服务端 schema 与业务规则验证。结构正确不代表事实正确。视觉输入、工具调用和结构化能力必须按选定模型分别验证；不能推断每个 Ollama 模型都支持全部能力。[Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)

建议分别测量 OCR、JD 提取和计划三个阶段的延迟、内存、字段准确性和失败率，再选本机模型及量化版本。本报告没有检查本机 GPU／内存、没有运行模型，也不给出未经验证的模型速度或内存承诺。已有 OCR 能读文字时，不需要为每帧强制加载一个视觉大模型。

## 4. 本机系统权限与 Docker 分工

| 运行位置 | 官方能力／限制 | BetterMe 设计建议 |
| --- | --- | --- |
| macOS 宿主 | 屏幕／系统音频录制和 Accessibility 有独立隐私控制；第三方通过辅助功能访问控制 Mac 需要明确授权 | 分开说明截图与控制用途；只申请当前阶段需要的权限；撤销后停止并清理待执行动作 |
| Windows 宿主 | `Windows.Graphics.Capture` 提供窗口／屏幕帧和用户选择 UI；UI Automation 提供多数桌面控件的程序化访问 | 优先用户选择窗口及语义控件；对不支持的控件再进入视觉 fallback |
| Windows 输入 | `SendInput` 受 UIPI 约束，只能向相同或更低完整性级别的进程注入输入 | 权限不符直接回报／交接，不尝试绕过或自动提权 |
| Docker Desktop Linux 容器 | Engine 在 Linux VM 内；Playwright MCP 官方当前 Docker 实现只支持 headless Chromium | 容器运行 Web/API／工作流／可选 OCR；宿主 GUI 由受控本地 companion 承担 |

来源：[Apple 屏幕录制权限](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)、[Apple 辅助功能权限](https://support.apple.com/en-kw/guide/mac-help/mh43185/mac)、[Windows 屏幕捕获](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)、[Windows UI Automation](https://learn.microsoft.com/en-us/windows/desktop/winauto/entry-uiauto-win32)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[Docker Desktop 架构](https://docs.docker.com/desktop/features/networking/)、[Playwright MCP Docker](https://github.com/microsoft/playwright-mcp)。Apple 屏幕录制页本次搜索摘要可读，完整页抓取返回 429；本机权限状态未检查。

**不能把 Docker 内跑通 OCR 理解成容器已经能控制用户桌面。** 根据上述 OS API 与 VM 边界，建议将 `Desktop Companion` 作为独立宿主组件；这不是要求用户给容器挂载整个桌面、浏览器 profile、Docker socket 或开启 privileged。

推荐通信设计（尚未实现）：用户主动配对、限定当前账户与工作区、短期凭据、工具白名单、任务作用域、过期时间、可见执行指示和急停；默认不暴露公网。宿主 companion 主动建立到本地服务的受控连接也是候选方案，但容器与宿主的网络可达性需单独实测，不能假定容器可访问宿主 `127.0.0.1`。

后台通知属于另一条能力：它可以提醒“缺资料／待批准／待核实”，但不能因为页面关闭或定时器触发就获得桌面操作权限。这里仅提出分工，不变更现有 Docker、通知或服务配置。

## 5. MCP 能帮助接工具与补资料，不能代替工作流系统

本节已按 2026-11-05 官方 `specification/latest` 实际重定向的 **2026-07-28** 版重新核对，不将初稿查阅的 2025-11-25 版当作最新版。2026-07-28 的基础模型是无状态、自包含请求和逐请求能力协商；实际接入须检查 SDK／server 支持版本，不能混用旧版握手和新版消息结构。[当前规范入口](https://modelcontextprotocol.io/specification/latest)、[固定版本说明](https://modelcontextprotocol.io/specification/2026-07-28)

MCP Tools 提供工具发现、参数 schema、调用结果与可选输出结构；规范建议在调用时显示状态、让人能够拒绝。工具 annotation 是描述，不是可信授权证明，非可信服务器返回的 annotation 不能直接作为安全判断。[MCP Tools 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

MCP Elicitation 可以让服务端通过客户端向用户补充信息：form 模式收结构化字段；URL 模式处理不应经过 MCP 客户端的敏感交互。form 不得索要密码、API key、access token 等秘密，并应允许查看、修改、拒绝或取消；这些边界在新版仍成立。新版要求在每个请求的 `_meta["io.modelcontextprotocol/clientCapabilities"]` 声明支持的模式，而不是只在初始化时声明。[MCP Elicitation 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)

与旧版接入方式相关的一项变化：`tools/call` 可返回 `resultType: "input_required"` 的 `InputRequiredResult`，携带 `elicitation/create` 请求；客户端补齐后用新的 JSON-RPC id，连同 `inputResponses` 和服务端给出的 `requestState` 继续请求。它可对应“等待用户补资料”，但这是协议继续机制，不等于允许重复外部副作用；BetterMe 仍需自己的幂等和业务审批边界。[当前 Tools 的 Input Required Tool Results](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#input-required-tool-results)

BetterMe 的设计推论：可以把 elicitation 映射为“待补资料”工作流节点；**用户回答资料问题，不等于批准发送简历**。业务审批应另存精确岗位、平台账号标记、动作类型、接收对象、消息、简历／附件版本、分享范围、有效期与内容摘要；任何改变都使旧批准失效。

MCP 的 HTTP 授权规范处理客户端访问受限 MCP 服务；stdio 不使用同一 HTTP 授权流程。这一边界在新版不变；token 受众绑定和禁止透传要求现在由独立的授权安全章节承载，仍然有效。它既不是招聘平台的授权，也不替代用户对具体外部动作的同意。[MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

本轮推荐接入评估仅限：Playwright MCP（浏览器语义交互）和 PaddleOCR 官方 MCP（OCR）。OpenCV 可以作为内部库，不必为每个函数另建一个 MCP 服务。是否使用其他 browser-agent 框架应等到现有路线出现明确能力缺口；本报告不声称 browser-use、Stagehand 或 OmniParser 已通过许可、维护或效果审查。

## 6. 可视化应来自真实执行事件，而不是展示完整模型内心过程

建议以业务节点和事件为依据渲染图，不把模型自由输出的步骤清单冒充已执行记录：

```text
确认求职目标 → 补资料／确认范围 → 只读获取 JD → 校验来源与完整性
    → 匹配与解释摘要 → 准备材料快照 → 等待逐项批准
    → 执行前再次核对 → 受控操作／本人接管 → 核实结果 → 业务记录
```

每个节点显示输入摘要、使用的数据来源、工具及参数摘要、开始／结束、输出、错误、待用户操作、简短决策依据和下一步。决策依据可呈现“薪资字段缺失，需要补充”“材料版本已变更，批准失效”，不需要把完整内部推理链作为产品日志。

建议状态至少区分 `pending / running / waiting_input / waiting_approval / blocked / succeeded / failed / unknown / cancelled`；其中 `unknown` 表示可能已经发生外部副作用，不能自动重试。暂停、取消、恢复、单节点重跑与版本化由 BetterMe 的运行时／业务存储实施；MCP 的工具调用协议本身不能替代这些业务语义。

## 7. 自动投递真正需要的前置资料

以下为建议的字段分层，不要求首次使用一次填满：

- 职业目标：岗位方向、地点、薪资口径、工作方式、排除条件、目标截止时间；缺失时先澄清，不能猜测。
- 资料事实：已由本人确认的经历与证据、可分享的联系方式、简历和附件版本；模型新增成绩或数字不能自动成为事实。
- 来源范围：允许的平台／窗口／页面，是否允许读取、是否允许本地截图留存、保留多久；登录和验证码由本人处理。
- 动作范围：只读、准备、填表或发送分别授予；精确到某个岗位和动作，而非笼统“允许自动求职”。
- 发出前核对：平台在线简历和附件的实际范围、接收对象、文本及账号；本地 PDF 不是唯一可能共享的资料。
- 中断策略：用户接管、页面变化、账号警告、验证、低置信度、未知结果时停止；没有“随机等待即可安全”的承诺。

这些要求承接[已有行动卡契约](../domestic-delivery.md)，不是本轮新增实现。用户许可、系统权限与平台许可必须分开评估；真实设备、OCR 或视觉点击不会自动获得平台许可，也无本轮证据表明降低封号概率。

## 8. 建议的受控验收顺序与未验证项

1. **纯合成离线感知**：用人工构造 JD、已脱敏截图测试薪资／公司／岗位／地点；覆盖高 DPI、主题、缩放、多窗口、滚动缺段、重复按钮。记录字段正确率、缺失检测率、延迟与内存，不直接采用供应商通用 OCR 指标。
2. **本地模拟网页／窗口**：先实现 DOM／AX，再测试视觉 fallback；错误窗口、旧截图、坐标偏移、权限撤销、用户切换账号必须阻止执行。
3. **无外发准备闭环**：获取模拟 JD、生成材料草稿、逐项审批、只填模拟表单；材料变化或授权过期必须回到审批。
4. **外部副作用故障测试**：模拟点击后断网、超时、进程重启、迟到结果、重复启动。即使可能已发送也不得自动补点；恢复必须保留 `unknown` 与证据。
5. **平台边界重新核验**：针对具体平台、具体客户端、当前条款和许可，确认允许什么，再决定是否做任何真实执行测试。需要真实账户或资料时另取明确授权，不从本轮研究推导。

尚未验证：本机各 OS 权限、目标应用 AX 覆盖率、三家平台当前页面／App 结构、完整 JD 获取成功率、真实投递结果的可核验信号、所选 OCR/LLM 的本机性能、companion 通信与沙箱、通知送达、Docker 集成、模型权重最终许可、依赖供应链及平台当前适用协议。**本报告没有发布自动采集或自动投递功能。**
