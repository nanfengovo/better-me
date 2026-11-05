# 统一 Agent 底座、原生授权与自动备援验收

日期：2026-11-05。现有 `agent-os` 工作区本地实现；未暂存、提交、推送、发布或重启正常服务。本报告承接 `native-tools-account-isolation-2026-11-05.md`，不将此前的“凭据已保存”或本次合成验收称为真实云账号已授权。

## 交付范围

- 一处统一来源，伴侣对话、简历伴写、职业成长和项目理解接同一个 owner 路由。可手动固定任何已登记底座，也可编辑首选和备用列表；未安装、未适配、未授权或受阻的选项不隐藏，明确给出原因。任意选择指已登记适配器，不接受浏览器提供 shell 命令、路径或 owner。
- 自动模式仅在本账号明确批准的列表内选用；同链原生登录优先，API 通道须另行打开可能计费的备援开关。默认不打开该开关；原有明确配置模型和 ChatGPT 路线不被暗中加入自动链。手动选择 API 工具也明确提示使用该工具已授权额度。
- 安装、协议、OS 隔离、管理策略和账号的启动前检查可跳过后检查下一项；一旦分派推理，超时、限额、损坏输出、撤权、身份变化或结果不明均停止，不重放给另一个提供方。不把“进程未成功结束”当成“没有发送或消耗额度”的证明。
- 顶部不再把旧 DeepSeek/API 的探测结果当作当前原生底座状态；显示待确认、待执行、实际最近执行工具、运行或停止。最近一轮可展开逐项选择/跳过/停止原因和错误码。加载原生路由和刷新状态不探测旧 API。

## 原生登录与真实工具的当前状态

| 工具 | 本批状态 | 仍需区分的真实门槛 |
| --- | --- | --- |
| Claude Code | 新增当前 BetterMe 账号专属的官方订阅登录；独立配置目录、一次性 `code#state`、PKCE/状态/会话绑定；实际 CLI 的独立 OAuth 文件路径与订阅输出协议已通过合成服务验收 | 本人仍须在官方页面完成真实订阅登录。本批未使用真实账号或交换真实令牌，不证明该账号有可用额度 |
| OpenCode | 生产隔离适配及已安装真实进程可执行；可手动选择或经明确批准进入自动链 | 当前独立 API 授权可用，原生交互 OAuth 尚未适配；不会复制宿主登录来冒充接通 |
| Gemini CLI | 生产隔离适配及已安装真实进程可执行；可手动选择或经明确批准进入自动链 | 当前独立 API 授权可用，原生交互 OAuth 尚未适配；不会自动切 API |
| Codex | 原生设备登录/独立 API 路径保留，统一路由不以 Codex 成功为前提 | 本机已安装版本在强制隔离内无法同步 macOS 管理策略，仍明确阻塞；未跳过策略、升级权限、导入全局凭据或覆盖全局 CLI |
| Pi / DeepSeek Harness / Antigravity 等登记项 | 保留可见、可选择、可说明状态的注册入口 | 未安装或缺少账号隔离适配时不运行，不自动安装 |

Claude 登录使用 `claude auth login --claudeai`，不是 Console/API 建 Key。官方授权 URL 仅向发起的 BetterMe 会话暴露；一次性完整授权码只进入本次进程 stdin，不进对话、长期记录或 localStorage。独立原生登录失败/取消不删除之前的有效连接，也不退出电脑上原有登录。

实际 Claude 2.1.218 在订阅模式输出 `rate_limit_event`。解析器只接受明确的非执行元数据；拒绝状态停止，不能充当最终结果，不能在完成后追加，带顶层工具字段的伪装帧拒绝。原工具/MCP/hook/plugin 与敏感输出边界保留。

## 隔离、撤权与业务边界

- 路由在现有 Host 鉴权和 Origin 检查之后，owner 由服务端身份派生。新 `routing-v1` 只保存选择版本与不含提示词/输出/密钥的执行回执；GET 默认非写入，不迁移或认领旧资料。
- CLI 的新授权继续存于 owner 专属 `native-tools-v1`；fresh HOME/配置/临时目录，私有目录与 0600 凭据。不读共享 CLI 登录、Keychain、宿主环境密钥或其他账号目录。仅 macOS 强制文件、跨进程信息与网络隔离实测通过后运行；其他平台不降级成普通进程。
- Claude 官方登录为了其原生回调绑定，单独允许本进程监听本地临时 TCP 端口；没有开放向本机/LAN 直连、Keychain、CFPreferences 服务或整个宿主目录。出站仍只有认证代理内明确允许的提供方域名。该权限由可信登录代码指定，不可由 HTTP 请求任意打开。
- 改选择、撤权、重授权、退出或换号取消在途请求并复核迟到结果。项目理解整轮在首次推理后固定原底座和凭据代次，后续取证决策不因重授权借用新凭据或偷偷换工具。幂等重试不能移除原取证撤权监听；短期缓存结果同样不能越过后来撤权或选择版本边界。
- 已发送请求只保留短期内存幂等结果；磁盘回执是重启后的“不得自动重放”标记，不是模型回答缓存。新请求仍须新的用户资料授权。选择修订 CAS 拒绝并发覆盖。
- CLI 是可替换的受控推理底座，不获得自由 shell/文件工具。资料读取仍通过 BetterMe 原 Broker 和原授权；业务输出仍经过伴写/成长/理解既有校验。Workspace 持有简历、版本、事实与业务记录，切底座不迁移它们，也不自动采用候选。
- 本机账号隔离不等于抵御拥有宿主管理员权限的人员，也不等于跨平台/公网多租户安全认证。

## 验收记录

所有验证只用合成数据、新临时 owner/目录和独立测试浏览器；没有读取或写入真实简历库、已有对话/任务/版本，未登录真实模型账号、创建真实 Key 或请求公网模型。

1. 全量 `pnpm test`：3803 项，3793 通过、0 失败、0 取消、10 个既有跳过。此前一轮原主题浏览器测试因启动超时取消，独立复测 9/9，此次完整重跑通过；未修改该原测试或放宽其超时。
2. 全量后最后补强缓存撤权栅栏，路由/真实鉴权 HTTP 专项 14/14；包含幂等缓存跨撤权/切换拒绝、多次 Broker 取证撤权、A/B 隔离和迟到进程。
3. 新统一选择/原生授权/顶部状态专项 27/27；随后订阅元数据和统一 UI 定向 21/21。额外测试与 UI-lab lint 零警告。
4. 真实已安装 OpenCode、Gemini CLI、Claude Code + 生产 macOS 沙箱 + 本地合成 TLS 验收 9/9。包含跨进程信息拒绝、普通/登录监听模式均不能向本机直连、独立 OAuth 文件发 Bearer 而无 API-Key、官方 Claude 登录 URL 离线初始化后立即取消、真实路由跳过受阻 Codex 后选 OpenCode、重复请求零新增分派。CLI 可能显示按模型表计算的成本字段，但实际网络仅达本地合成服务，不是账单或真实扣费证明。
5. 类型检查 13/13、生产构建 8/8；最后 Host 补强单包重建与全量类型再通过。全量源代码 lint 与后续变更/额外夹具 lint 零警告。保留原有地图模块 externalized/chunk size 打包提示，未作为本批顺带改造。
6. 真实浏览器合成页：手动选择、明确保存、Claude 演示原生登录、Codex 原因可见→Claude 完成回执；A→B 无 A 的配置/授权/回执，返回 A 保留原选择；1512×1000 浅色、390×844 深色，滚动宽度 390，无横向溢出。控制台 0 error/0 warning，未发起动态业务或模型请求。

截图（独立合成 UI，不是真实账号运行凭证）：

- `output/playwright/agent-routing-desktop-light.png`
- `output/playwright/agent-routing-mobile-dark.png`

可复现：

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
BETTERME_NATIVE_ACCEPTANCE_IDS=opencode,gemini-cli,claude-code node --import tsx --test apps/agent-host/tests/native-installed.acceptance.ts
# 独立合成 UI（从 apps/web 目录运行；不连接业务 Host）
pnpm exec vite --config tests/ui-lab/native-tools.config.ts
# http://127.0.0.1:5423/tests/ui-lab/agent-routing.html
```

## 原数据和启动交接

本轮开始时 231 个原脏文件中，26 个为明确的接线/测试/交接重叠文件，另外 205 个 SHA-256 全部未变，没有缺失。保留用户全部未提交工作，索引仍空、分支仍 `agent-os`、HEAD 仍 `5d5438f`。没有修改真实简历、版本、旧对话/项目理解记录、自动保存偏好、模型凭据或已有授权。

原 5173/5178/5179 监听 PID 56859/38562/56891 与启动时间保持原状；未接管或刷新原浏览器。本批独立 5423 合成预览与专用 Playwright 会话在验收后关闭。旧的正常 Host 尚未重启加载新服务端代码，不能把代码完成说成原页面的真实账号已接通。

正式启用下一步：本人先保护当前未保存输入，再加载新 Host；在「模型与工具」中为当前 BetterMe 账号完成官方原生登录，选择手动底座或审核自动链并保存；逐轮确认资料后运行。默认不创建 Key、不自动开启 API 备援。若后续补 OpenCode/Gemini 原生 OAuth，仍需按其官方账号/回调/令牌刷新协议单独适配与隔离验收，不共享已有登录来绕过这一步。

## 参考来源与取舍

借鉴的是 OpenDesign 的运行时注册、检测、适配与统一入口思路，不直接复制其代码或把“扫描到安装”当成“已完成授权”。本批工具/取证循环继续由 BetterMe 管理，不能称为 OpenDesign 式不受约束的原生编程 Agent 全能力。

- [OpenDesign Agent adapter interface](https://github.com/nexu-io/open-design/blob/main/docs/agent-adapters.md)：单一注册与适配入口。
- [OpenDesign local agents](https://open-design.ai/help/local-agents/) 与 [chat](https://open-design.ai/help/chat/)：安装、登录、选择和后续请求切换的区别。
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)、[CLI reference](https://code.claude.com/docs/en/cli-reference)、[environment variables](https://code.claude.com/docs/en/env-vars)：原生订阅、独立配置目录与 API 通道区别。
- [Codex authentication](https://learn.chatgpt.com/docs/auth?surface=cli) 与 [macOS managed configuration loader](https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/macos.rs)：原生登录及强制管理策略边界。

不选：仅隐藏不可用项；共享宿主凭据/Keychain；取消沙箱/管理策略；一轮已发送后自动改投；静默使用付费 API 或默认小模型；为演示使用真实简历/旧记录；把新端口当成账号隔离；让 CLI 持有职业事实库。
