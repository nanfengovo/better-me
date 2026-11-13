# Career OS：受信运行配置与隔离验收

日期：2026-11-09。本文说明当前实现的可选集成入口，不是已连接真实账号、云模型、外部 MCP 或公开互联网部署的证明。所有验收只能使用合成材料、独立临时目录和明确选定的本机运行时。

## 1. 默认可用性与信任边界

| 能力 | 未配置时的行为 | 启用前仍需完成的动作 |
| --- | --- | --- |
| 本地模型分析 / 隐私摘要准备 | 不自动选择或下载模型；没有云端兜底 | 用户选择本地 Ollama 模型及确切 digest，创建资料快照并授权 |
| 外部 MCP Client | 服务器列表为空 | 操作员登记服务器；用户分别审查 manifest、连接权限与每次请求 |
| Candidate Twin / 本地 MCP Server | 可准备受支持的脱敏快照；未签发令牌就没有公开数据权限 | 独立预览、明确发布、签发有限作用域及期限的令牌 |
| 隐私云端派送 | 不可用；仍允许有界本地准备 | 操作员配置现有 provider；用户审查精确披露稿，分别同意与派送 |
| Vork 证据徽章实际 PNG | 渲染不可用；编译的证据映射不等于已渲染 | 固定受信二进制及 SHA-256，用户选择实际渲染 |
| 最终 PDF / DOCX 分页核对 | 未配置的格式保持未核对，不由 DOM 冒充 | 固定受信渲染器；逐格式授权生成、解析实际字节，再做人工视觉核对 |
| 岗位办公室坐标权威读回 | 保持未知，不接受浏览器自报 verified 坐标 | 单独显式提供只读 JobService token 引用 |

这些功能复用当前 owner、会话、Workspace 与私有派生产物 SQLite CAS；不会创建第二个业务 Fact 库、通用任务队列或独立登录系统。旧业务 Fact 不会因为被选入快照就自动升级为独立核验通过。

不得把未配置标成已连接，也不得为了完成流程创建 API Key、读取既有凭据文件、调用真实付费模型或接管用户现有进程。外部结果永远是待审数据；unknown 不得自动重试或改成成功。

### 本地 Ollama 生成要求

本地客户端要求受审查的稳定 `0.x >= 0.40.15` Ollama API。旧版、预发布版、未知版本或未审查的 major 会明确停止为 `local_completion_safety_unavailable`；不会忽略不支持的安全参数或切换到云端。每次调用前后都重新检查 API 版本、所选模型 digest 和非远端模型标记。本地 daemon 仍是操作员信任边界，版本字符串不是远程证明。

生成请求固定使用 `num_ctx: 16384`、`num_predict: 4096`、`truncate: false`、`shift: false` 和 `think: false`，保留模型模板。注入适配器只允许更小、有限且保留上下文余量的配置。`ollama-local-v2` 指纹绑定 API 版本与这些策略；旧隐私草稿不能复用新运行时的同意。上下文或输出上限不足时，应新建资料更少的独立审查，不自动删减当前输入、扩大额度或重复请求。

只有完整的 `done_reason: stop` 响应才可继续解析。`length`、请求被上下文边界拒绝、以及明确的正文/传输/上下文硬上限均拒绝接纳；委员会锁存该次运行的确定性停止，后续角色不再隐式调用模型。原有单次 180KB 输入、48KB 生成正文和 90 秒活动上限不变。模型输出还须经过各能力自己的结构、引用和事实检查，传输成功不是事实通过。

## 2. 操作员 JSON 配置

Host CLI 接受 `--career-config /absolute/private/operator.json`，或显式环境变量 `BETTERME_CAREER_OPERATOR_CONFIG`。前者覆盖后者。没有路径时不扫描磁盘。配置必须是固定绝对、canonical、非符号链接的普通文件；POSIX 下 owner 为当前用户或 root，且组/其他用户不可读写（建议 `0600`）。Windows 若没有受信 ACL 审查适配器，此集成不可用。

最小配置如下，没有任何密钥：

```json
{
  "version": 1,
  "revision": "operator-2026-11-09-v1",
  "mcpServers": []
}
```

只允许 `version`、`revision`、`mcpServers`、可选 `privacyCloud` 与 `vork`。未知字段被拒绝。不要在 JSON 放 `apiKey`、Authorization、环境变量副本、token 或任意 HTTP 提交的 executable/args。配置加载不执行程序，也不调用模型。

配置内容和受审文件均被哈希绑定；运行中更改需要重新挂载/重启 Host，再做新审查。旧同意不能迁移到新配置。不要在仍有操作运行时覆盖配置文件来“热修复”。

### MCP：预登记，而不是自动安装社区命令

HTTP 模板中的 `.invalid` 是占位，不是可连接的服务：

```json
{
  "id": "reviewed-evidence",
  "label": "已审查的只读证据服务",
  "server": {
    "id": "reviewed-evidence",
    "version": "reviewed-v1",
    "transport": {
      "kind": "streamable-http",
      "endpoint": "https://mcp.example.invalid/mcp"
    },
    "allowedTools": ["list_evidence"],
    "allowedResources": ["evidence://public-index"],
    "maxInputBytes": 16000,
    "maxOutputBytes": 64000,
    "maxActiveMs": 30000
  }
}
```

把上述对象放入 `mcpServers` 数组，并替换为已审查的真实服务、实际工具名和资源 URI。JSON 配置只允许 HTTPS、无用户名/密码/query/hash 的固定外部 endpoint，不支持把测试用 loopback 例外写进产品配置。重定向和自动重连重试被拒绝。当前 JSON 没有远程服务器凭据配置入口；需要认证的服务只能经受信 Host 注入 `authorizationHeader` 适配器，并在账号/权限变化时更新 `server.version`。

`stdio` 的 `transport` 形状为：

```text
{ kind: "stdio", spec: {
  command: <受信运行时可执行文件的绝对路径>,
  args: [<固定受审入口文件的绝对路径>, ...<固定参数>],
  executableHash: <真实可执行文件的64位小写SHA-256>,
  artifacts: [{ path: <受审安装文件的绝对路径>, hash: <该文件SHA-256> }, ...],
  allowedReadPaths: [<最小必要运行库/安装子目录>, ...]
} }
```

这是形状说明，不能原样复制为有效 JSON。先在独立安装位置审查/固定安装内容，再登记实际 hash；不得使用 `sh -c`、`npx` 临时下载命令、shell 包装器或从浏览器传入的任意程序。入口/安装文件与必要运行库读范围必须明确，不允许授权整个 home、根目录或临时目录。

stdio 通过官方 SDK 传输，并强制使用支持的 OS sandbox：禁止网络、仅运行目录可写、只读明确允许的文件/子树、不继承 Host 凭据。无可用 OS sandbox 的平台会报告不可用，不会把普通子进程或 QuickJS 当作隔离等价物。

用户流程是：选择已登记服务和权限子集 → 审查确切 manifest/hash → 明确连接及期限/次数 → 审查实际工具目录 → 准备一次确切工具参数或资源读取 → 独立同意调用。远程服务会看到批准发送的请求数据。返回内容不能指挥本机 shell、增加权限或直接写入 Fact。结果未知时查询该调用记录，不能自动补发。

对外 `list_career_facts` 将当前 publication-review 投影为 `self_reported`，并保留贡献自述和限制。授权片段的引用/版本核对不等于独立作者认证；不能把内部公开审查记录的旧 `verified` 状态直接包装成对外认证。该投影不回写旧记录或业务 Fact。

### 云端隐私适配器：仅引用已配置的 provider

在 JSON 加入 `"privacyCloud": { "providerId": "career-summary-provider" }`，并由操作员在 Host 进程中显式提供以下**配置名称**。这里不创建、不打印、不复制任何秘密：

```sh
export BETTERME_CAREER_PRIVACY_PROVIDER_ID='career-summary-provider'
export BETTERME_CAREER_PRIVACY_PROVIDER='openai-compatible'
export BETTERME_CAREER_PRIVACY_BASE_URL='https://provider.example.invalid/v1'
export BETTERME_CAREER_PRIVACY_MODEL='REPLACE_WITH_EXPLICIT_MODEL'
export BETTERME_CAREER_PRIVACY_RUNTIME_VERSION='reviewed-v1'
export BETTERME_CAREER_PRIVACY_API_KEY_ENV='MY_EXISTING_CAREER_CREDENTIAL'
export BETTERME_CAREER_PRIVACY_MAX_OUTPUT_TOKENS='4096'
```

这些示例必须替换为已审核的现有 provider/model/URL；`.invalid` 不可调用。`MY_EXISTING_CAREER_CREDENTIAL` 仅是操作员已安全注入的环境变量名，文档不要求创建或显示其值。没有默认 provider、模型、URL 或 Key，不读取 `.env`/浏览器凭据/用户凭据库。现有模型设置界面保存的凭据不会被该工厂自动发现。

支持 `openai-compatible`、`custom` 或使用兼容接口的 `gemini` 标签；这都是固定 `/chat/completions` 的窄兼容协议，不代表支持任意供应商 API。模型必须支持当前 JSON-object 请求和非流式响应，否则失败，没有协议猜测、工具调用、修复重发、自动切换模型或付费降级。一次派送零重试，限制输入、输出与活动时间。

Host 只发送用户逐字段审查的结构化摘要及明确来源 id/revision/hash，不发送原始 diff、源码、私有绝对路径、会话标识或本地任务编号。`local_only` 来源在进入本地披露摘要准备前就被排除；本地分析原始源码需要独立 EvidenceBroker 授权，不能借此路径外送。PII/秘密阻断是纵深检查，不是任意自然语言的绝对无泄露保证。

UI 顺序是本地 prepare → 查看精确字段、摘要 hash、接收方 origin、endpoint fingerprint、模型/版本及预算 → approve → 单独 dispatch。prepare 不是外发授权。配置/模型/凭据 generation 改变、切号、撤权、期限或预算变化都使旧同意失效。未知派送在出口前先持久化，不因失败或重启释放次数；重启后需要新操作与新同意。不要通过重复点击恢复未知云请求。

### 仅本地源码与 Embedding 检索

隐私面板可另外列出当前已完成委员会中仍有效的原 EvidenceBroker 授权片段。HTTP 只接收原 operation/evidence id，不接收新路径、扩大行范围或把源码改标为可出云。每次选择及每次本地使用前后，重新通过原 grant/range 读回并核对来源与片段 hash；期限、权限、账号、简历版本或源文件变化都拒绝复用，须重新审阅委员会。源码保持 `local_only`，不会进入披露摘要生成或云端请求。

本地向量检索需单独勾选源码复用、显式选择已安装的 Embedding 模型及 exact digest，并给出独立 Embedding 同意与调用预算。生成模型不自动兼任向量模型；未安装、未选择、remote/cloud tag、digest 不符或缺少 Embedding 能力时显示不可用，不下载、不降级、不用生成 token 伪装向量。当前本机未配置的 Embedding 能力不宣称已由真实模型验收。

调用走仅 loopback 的本地 `/api/embed` 边界；查询、向量和源码正文不写入检索历史或云出口。owner 私有 CAS 账本仅留 hash、模型指纹、阶段、预算消耗及 source id/相似度。调用前持久占用额度，取消、切号、授权变化、存储失败和重启后 unknown 均不自动重试。相似度只是授权片段的检索信号，不是事实认证、个人归属证明或 Offer 概率。私有名称需在表单显式填写用于摘要阻断/脱敏，系统不声称已自动识别所有公司名、人名或秘密。

### Vork

可选配置为 `"vork": { "binaryPath": "/absolute/reviewed/vork", "sha256": "<真实64位小写hash>" }`，其中占位 hash 必须替换。每次渲染前重新检查配置与受信二进制。这里不会通过 PATH 搜索/下载 Vork，也不沿用旧通用 Vork API 的自动发现行为。

新徽章仅编译内建几何、灯光和材质场景，在私有临时目录渲染，不接受调用者提供的贴图、文件路径或任意场景。图像 hash 绑定本次场景、来源和核对回执；几何复杂度/折射率只是观测映射，不是能力分、招聘概率、作者身份认证或计算意义上的 PoW。缺失覆盖率等指标保持未知。

## 3. 最终 PDF 与 DOCX 渲染器

此项独立于 operator JSON，仅由受信安装环境或 Host DI 配置。没有默认安装、PATH 搜索或自动下载：

```sh
export BETTERME_CAREER_EXPORT_CHROMIUM='/absolute/reviewed/chromium'
export BETTERME_CAREER_EXPORT_CHROMIUM_SHA256='<真实64位小写hash>'
export BETTERME_CAREER_EXPORT_SOFFICE='/absolute/reviewed/bundled/soffice'
export BETTERME_CAREER_EXPORT_SOFFICE_SHA256='<真实64位小写hash>'
export BETTERME_CAREER_EXPORT_SOFFICE_READ_PATHS='["/absolute/reviewed/bundle-runtime"]'
```

只配置所需格式即可。SHA-256 字段可省略，但部署建议显式固定；省略时首个实际调用固定本实例观察到的二进制，后续变化拒绝。`SOFFICE_READ_PATHS` 仅列转换器所需、已审查的安装/运行库目录，不授权用户 Library、私有仓库、home、根目录或整个 temp。不要配置用户当前正在使用的桌面 LibreOffice；需要专用受信 bundled soffice。程序/读范围不是 HTTP 参数。

PDF 输入必须来自现有简历模板/打印 CSS 的静态 HTML 捕获，不创建第二套简历模板。Chromium 使用新私有 profile、禁 JavaScript/ServiceWorker、禁止网络与 file 资源、仅接受受约束的内嵌 data 图片/字体；外部资源或主动 SVG 导致失败，不静默删掉资源冒充完整输出。

DOCX 输入是现有序列化器的确切 ZIP 字节。先检查 ZIP 目录、实际有界解压、CRC、OOXML 关系和主动内容，拒绝宏/OLE/外链资源/ZIP bomb 等，再以独立 profile、禁宏配置、强制 OS sandbox 和固定参数转换为派生 PDF。安全外部超链接仅保留为 inert PDF 注释，不打开网址。取消会终止本次转换进程组；临时文件不会被用来覆写用户原件。

macOS headless Office 使用本次私有生成的 Fontconfig 清单，只枚举固定公共 `/System/Library/Fonts`，缓存写在本次私有 temp；不加载默认/用户 Fontconfig、不读取用户 `Library/Fonts`，也不扩大 OS sandbox 权限。否则部分 bundled Office 会仅发现西文字体，出现“Unicode 可抽取、中文页图却空白/方框”的假成功。该修复不保证部署机器具有所有语言字体；缺字、替换字体与分页仍需逐页检查。

当前 CLI 预算：每个原始输入与 PDF 输出各不超过 8,000,000 bytes，DOCX+分页 PDF 合计不超过 11,000,000 bytes，活动时间上限 115 秒，进程级单并发（忙时拒绝，不新建队列）。UI 默认最终文件观察为 60 秒；先达到的限制会取消，不自动重试。输出过大不会截断。

界面逐格式执行“明确生成 → Host 实际渲染 → SHA-256 核对 → PDF.js 读最终字节 → 对照独立源正文/href → 页级诊断 → 下载本次字节”。最终 DOCX 必须同时有其精确字节产生的分页 PDF；不能拿 PDF 的结果替代 DOCX。即使哈希和全文一致，仍不是事实真实性、语义等价或人工视觉验收证明；需要逐页检查实际文件/图像。其他 Word 版本可能采用不同分页。

## 4. 只读岗位权威读回

Host 只接受显式环境引用：

```sh
export BETTERME_CAREER_JOB_AUTHORITY_TOKEN_ENV='MY_EXPLICIT_READONLY_JOB_TOKEN'
```

该名称所指的 token 必须由操作员单独、明确提供；不得读取/打印已有 JobService token 文件、浏览器连接设置或用户账号数据库。当前适配器固定 `http://127.0.0.1:5178`，无 endpoint 覆盖，禁重定向，不发投递/抓取/修改操作。只读取岗位详情与索引搜索；搜索使用 POST 是只读查询，不是业务写入。

只有同版本持久详情、索引成员、来源链与唯一 verified 办公室一致时才产生办公室节点。城市文本、客户端布尔值、远程岗位、多个办公室歧义、缺来源或服务失败都保持未知。默认每次最多核对 50 个岗位、4 并发、5 秒总预算。连线只表示显式技能证据交集，不证明仍在招聘、录用概率或公司认可。

## 5. Candidate Twin / MCP 的分享范围

发布是显式 eligible facts 的静态、不可变、脱敏快照，不是让公众访问整个 Workspace。预览不发布；发布不自动签发令牌。读取、问答和 MCP 使用独立 scopes、audience、期限及调用次数。问答是授权快照上的抽取/引用；没有证据的问题返回 unknown，不从私有源码或开放网络补答案。

链接把 opaque token 放在 fragment（`#access_token=...`）中，固定 bootstrap 读入后立即清除 fragment，并仅在内存中用 Authorization 请求数据。不要把实际分享链接/token 写进日志、截图、Git、文档或二维码服务；二维码由本机库生成。泄露链接等于泄露其有限能力，应立即撤销。

当前 CLI 通常监听 loopback；产生的 `127.0.0.1`/`localhost` 链接只能在该本机访问，不能当作招聘方从互联网可打开的在线作品集。这里未部署公共 HTTPS、反向代理或穿透服务，也不授权为了分享而将 Host 直接暴露到公网。若未来部署，必须另外审查身份、Origin、TLS、存储与运维边界。

胶囊本体可以在 owner 私有列表中持久管理/撤销；内存令牌不跨 Host 重启存活，需要重新签发。撤销阻止之后的在线访问，无法收回别人已经下载的副本。退出原授权会话/撤权也会使在线能力失效。

### 已保存白板的独立公开审阅

在“公开与隐私 → 数字胶囊”中，可以另行读取本次 context 已明确保存的白板与本次已经审阅的陈述。没有保存记录时保持空，不创建示例；历史白板必须在当前范围重新恢复并保存，不能借分享继承原 EvidenceBroker 授权。

流程为：选择关联陈述 → 选择节点、端点完整的连线及允许字段 → 填写内部名称 → 查看脱敏公开预览 → 独立确认冻结。目录、预览和确认分别使用 `/architecture/publication/{catalog,preview,confirm}`。服务端绑定白板 store revision/hash、关联审阅记录 hash、账号、会话、context、源内容及五分钟预览期限，并在最终写入前重新检查。版本、权限或身份发生变化时拒绝复用。

只投影选定节点名称、可选标题和连线标签；未选连线标签保持精确空字符串。公共节点重新编号，不复制白板的原 ID、源码、证据 ID、路径、备注、guard、故障记录或问答。显式内部名称脱敏外，仍有保守的秘密、路径和已知源码行拒绝检查；无命中不等于通用 DLP 证明，必要时会拒绝无害同名。

确认新增不可变的公开候选审阅记录，不覆盖原记录、不写业务 Fact、不发布胶囊、不签发访问令牌。随后必须另选该含图记录及“设计取舍／已批准架构图”，完成原有胶囊公开预览和发布流程。所有图示明确标记为用户自述设计，不证明实现、作者、部署、防护或生产效果。最终接收页使用只含受审标签的静态 SVG 与完整文本拓扑，不运行用户图形脚本或加载外部资源。

## 6. Electron 原生 QA：只复用隔离服务

真实用户服务 `5173/5179` 与真实桌面账号目录不属于 QA。先由验收主流程在独立数据目录运行 QA Vite `5273` 与 Host `5279`；Vite 必须代理到 QA Host。不要为了验收停止/复用真实用户 Host，也不要从其 cookie/token 配置复制身份。

不启动 Electron 的窄构建命令（cwd 为 `apps/desktop`）：

```sh
node_modules/.bin/esbuild src/main/index.ts --bundle --platform=node --target=node22 --outfile=dist/main/index.cjs --format=cjs --external:electron
node_modules/.bin/esbuild src/preload/index.ts --bundle --platform=node --target=node22 --outfile=dist/preload/index.cjs --format=cjs --external:electron
```

工作区标准双端构建目标仍是 `pnpm desktop:build`（包含 Web 和 desktop）；上面的窄命令用于已单独构建/启动 QA Web 的原生主进程回归，不代替最终双端构建与 BetterMe.app 同步。依赖已安装时直接调用现有二进制，避免 `pnpm exec` 触发并发自动安装。

在拥有 Electron 进程的持久 Node/Playwright REPL 中启动，以下名称是演示变量而非秘密值：

```js
var fs = await import("node:fs");
var os = await import("node:os");
var path = await import("node:path");
var { _electron } = await import("playwright-core");
var desktopRoot = "/absolute/workspace/apps/desktop";
var qaProfileRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "betterme-desktop-qa-")));
var electronApp = await _electron.launch({
  args: [path.join(desktopRoot, "dist/main/index.cjs")],
  cwd: desktopRoot,
  env: {
    ...sanitizedLaunchEnvironment,
    NODE_ENV: "test",
    BETTERME_DESKTOP_QA_MODE: "external-reuse-only",
    BETTERME_DESKTOP_QA_HOST_URL: "http://127.0.0.1:5279",
    BETTERME_DESKTOP_QA_WEB_URL: "http://127.0.0.1:5273",
    BETTERME_DESKTOP_QA_TOKEN: separatelyProvisionedQaHostToken,
    BETTERME_DESKTOP_QA_PROFILE_ROOT: qaProfileRoot,
  },
});
var appWindow = await electronApp.firstWindow();
```

`sanitizedLaunchEnvironment` 只包含运行 Electron 所需的系统环境与上述明确 QA 配置，不要展开真实 `process.env` 把 provider 秘密带进验收。需先将 REPL 的模块搜索范围设到现有安装位置，不为这一步自动安装 Playwright/Electron。

QA 入口要求 unpackaged Electron、`NODE_ENV=test`、确切 mode、两个不同的数字 loopback HTTP 端口、显式 QA token 与 fresh profileRoot。默认端口 `5173/5179`、远程 URL、`localhost` DNS 名、HTTP credentials/query/hash、缺字段和未知 QA 字段均拒绝。正常无 QA 配置时行为不变；打包产品不接受此测试入口。

`profileRoot` 必须是系统 temp 的直接子目录、canonical 绝对路径、当前用户所有、私有且为空，命名为 `betterme-desktop-qa-*`。主进程在 `whenReady()`、任何 Session/BrowserWindow 之前创建子目录并显式 `app.setPath` 设置 userData/sessionData/logs/crashDumps。重复使用旧 QA 目录会被拒绝；每次主进程重启必须新建 mktemp。不要提前添加 `--user-data-dir` 或写入该空目录。Windows 暂无受信 ACL 流程，因此此 QA profile 入口不可用。

QA Managers 只对指定端口做有界 GET readiness；Web 还核对 BetterMe 入口特征。不可用、被其他页面占用或重定向时中止，不发现源码、不启动子进程、不回退到真实服务。stop/quit 不停止外部 QA 服务。窗口固定到审核后的 QA Web origin，忽略 `VITE_DEV_SERVER_URL` 并阻止跨 origin 导航。

原生验收仍需覆盖真实控件操作、启动时窗口尺寸、最小窗口、逐屏截图与可读性、取消/切号/撤权等非快乐路径。单元测试不是原生视觉验收。完成后只关闭本次拥有的 Electron 实例；保留合成产物或按明确目录回收，不操作真实桌面服务/账号。

## 7. 已执行与未执行的证据范围

模块测试使用合成 canary、本机 fake HTTP、官方 MCP Client/Server 真协议、实际 OS sandbox。最终渲染专属测试在显式注入的受信 Chromium 与 bundled soffice 上实际执行，11/11、0 skip，覆盖 exact PDF/DOCX 字节、外链/主动内容拒绝、晚结果失效、进程组取消、私有 temp 清理和实际 CJK 字体嵌入。中文字体回归先红后绿，不能仅以文本抽取作为中文可读性证据。这不等于真实简历或所有文档的逐页人工视觉验收。

另对本次全合成 `actual-final-docx.docx` 实际重渲并查看全部两页 PNG，中文均完整可读。源字节 SHA-256 为 `6aa51d7f0ccea96ef03c1f6680b58756e8538cdaa909469675c403419e251f29`，未改原件；派生 PDF SHA-256 为 `ce3fbe6f307279873b4cf6ecbe13048456df5d373925b82dadeb31a05893c693`。产物位于本次 QA 目录的 `actual-final-docx-cjk-fixed.pdf` 与 `final-docx-cjk-fixed-page-{1,2}.png`。补齐真实字形后是两页，第二页留白较多；原先缺中文字形的“一页”不能沿用为排版通过证据。

MCP 公开语义修复另外通过 12/12 专项回归，包含生产 Studio 投影 + 真实 SQLite + 官方 SDK StreamableHTTP；确认无独立作者回执的材料对外为 `self_reported`，贡献/限制未丢失，内部记录未被重写。

桌面新增隔离测试 5/5，加既有生命周期回归 5/5；strict TypeScript 与定向 lint 通过。这些测试不启动 Electron，真实原生 UI 验收由主流程另行记录。本文没有调用真实云模型、读取真实凭据、连接用户第三方账号，或更改任何运行模型配置。

全量回归不能据上述专项结果宣称全绿。记录时的 `full-test-2026-11-09.log` 为 4354 项、55 fail，其中新 Type3 PDF 项已另行修复复验；其余不能一概称为历史失败。只读审计确认 JD 浏览器相关 6 个主源码/测试与 `HEAD 7674df22df1f512656cfa59729b04bb8745c0306` 字节相同，并以 `git show HEAD` 内存 loader 对选定 10 项复现同症状，未 checkout/worktree/改依赖。真实 Chromium 4 项是合成 fixture 拒绝已规范化的桌面 URL，并非 EPERM。捕获文件 `head-jd-readonly-comparison-2026-11-09.log`（12820 bytes，SHA-256 `d926d9755a1057ad24949dc29b5b01b015624bae31e266ade0fc1feae3b531b2`）留在本次 QA 目录；其余依赖仍由现有工作区解析，不冒充完整 HEAD 环境复刻，也不推断全部失败的历史归属。

既有无关 STAR HUD 仍含历史硬编码示例，不属于新 Career Studio 的事实产物，不作为本次 12 项功能的任何验收证据。

实现入口：`apps/agent-host/src/career-studio/{operator-config,operator-provider,export-config,verified-jobs,final-export-http}.ts`、`apps/agent-host/src/{privacy,career-mcp,candidate-twin}/`、`apps/web/src/services/career-final-export.tsx`、`apps/desktop/src/main/isolated-qa-config.ts`。所有“可用/通过”以当前配置、身份、版本与对应真实测试记录为准。

## 8. 派生构建与可恢复应用资源同步

2026-11-09 首次统一冻结放行后实际执行一次 `pnpm desktop:build`，exit 0。包含生产 Web 的 TypeScript/Vite 构建，以及 Desktop main/preload esbuild；不是 Agent Host 的构建或服务重启。Vite 有既有 Node 内建浏览器兼容外置和大 chunk 警告，不能据成功退出声称已解决这些性能/兼容边界。

实际构建输入限定为生产 Web/Desktop 源码、公共构建素材、所依赖 packages/src、配置与 package/lock，不计入仍可能追加的测试/报告。前、后及同步前 744 个输入、122209909 bytes 指纹一致：`386122a4d6a284cb4817eba935da447a5a0bd09a50a278f5390a6f19ca786943`。

仅刷新已核实的 `/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist`。先将全部旧 dist 同卷移动到独立 canonical mktemp 私有目录，再安装已逐文件验证的 `apps/web/dist` 与 `apps/desktop/dist/{main,preload}` 并集。旧版 556 文件、142896301 bytes 的原始 manifest 为 `06148e47c349a5aaf2243343893394c410e810f30b2bcde008388a5de0899869`，内容与事前 metadata 均未漂移，全部保留可恢复，未删除。

首次安装结果为 532 文件、137249926 bytes，完整路径/字节/SHA-256 manifest 为 `818eabb59690f3da10a58d1bdb270ed844d4abcf6f1a5d958da27b70b2ec6cdf`。递归并集无多余文件或目录、无符号链接或特殊文件。入口 `index.html` 为 `16dd6b1c65d7acc2bf2c95fd5d56f16f79db78daf35cb3dd34395290dc9d79f4`；main 为 `ae122804c786110f69392870a4527da504ea1e713fc551a264970aa9785b1a20`；preload 为 `70cb32be239ff1f00c102248b1ea8cf9746365b76250c8246a41ea1c001c256e`。

原始备份位于 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-app-dist-backup-Zw25FY/previous-dist`。同目录父级保留 previous/expected/installed 三份完整 manifest 与 `sync-receipt.json`；回执 SHA-256 为 `91be0df33e7d612c5d2bae6e05fd3e1436dca90824621e7a578d2cefe90be0eb`。`Info.plist`、app/package.json 前后 hash 相同；没有操作账号/userData、启动/退出应用或重启任何服务。

同步执行后收到新的 Workspace 跨上下文 active-adoption 生命周期竞态报告，因此上述是首次构建/同步证据，**不是该竞态已修复、最终发布或原生 UI 终验通过的证据**。后续生产源码变化须以新构建和独立备份补同步，保留这里的原始备份；主流程另行记录最终验收。

### 最终补同步：采用 Root 全工作区构建产物

Root 随后修复 active-adoption token 生命周期问题并重新冻结生产源码，实际 `pnpm build` 完成 9/9、exit 0，48.288 秒（其中 5 项 cache）；`build-final-2026-11-09.log` 保留该全工作区构建证据。没有再次运行 `desktop:build`。本次只将该构建产生的 Web/main/preload 新并集补同步，Agent Host 服务仍未由此同步操作重启。

补同步时生产输入为 744 文件、122211382 bytes，前后指纹同为 `0d53bd62536df6293b68c0f40e1998677f265c88a039d3059ca750d7f0e20588`。首先将现有首次安装结果与其原回执、完整 installed manifest 核对一致，然后固定本次 metadata，私有 staging 及同步前再次核对，无外部内容、目录、符号链接或特殊文件漂移。

最终 `/Users/feng/Documents/Private/简历/简历Agent/BetterMe.app/Contents/Resources/app/dist` 为 532 文件、137250837 bytes，完整并集 manifest 为 `4f87794b2a88a7f94bd2a49a40e6294e6264db9a136ca9bd7a7a18e757f7a8aa`。最终入口 SHA-256 为 `93741411c2e047a3707f4a08a91750f6d8438c8dd332efa1a152502b86a7d6a3`；main/preload 与首次结果相同。全部文件、相对路径和目录集合与精确新产物并集相等，没有沿用过期 hashed chunks。

新的独立备份 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-app-dist-backup-rkgBlf/previous-dist` 保存首次 532 文件版本；原始 556 文件版本仍完整保存在 `betterme-app-dist-backup-Zw25FY/previous-dist`，两者均未覆盖或删除。最终新备份目录中 `sync-receipt.json` 的 SHA-256 为 `25592fd4c91c74687964d520387d28c1571d62ac49b01468fa41909a424f9e91`，另存 previous/expected/installed 完整 manifest；回执关联 Root 全量 build log 与首次同步回执。

两次同步均保持 Info.plist、app/package.json 前后 hash 相同，未改真实账号/userData，未启动/退出任何应用或重启任何服务。系统 temp 备份是本次可恢复保留，不承诺绕过系统 temp 清理政策永久归档。**最终文件 SHA 相等只是派生产物交付证据，仍不等于真实原生窗口或全部功能终验通过**；后续生产 dist preview、委员会语义正例、隐私与原生终验由 Root 单独执行和记录。

## 9. 有界改写与规则回放的收尾约束

措辞模式只允许修改本轮实测问题明确定位到的可编辑 anchor；明确但未知、空白或不可编辑的 anchor 不会借全局分页问题扩大范围。只有没有 anchor 的页尾留白／孤页诊断可回退到本稿已有的合法文本。无适用问题或预算为零不调用改写模型。请求包含目标原句、保护片段和字数建议，建议不授予删事实、翻译、升级资历或修改无关姓名／岗位的权限。确定性保护、原文 exact 比较与另一新上下文的七项等义审查仍分别执行；模型返回错误候选时拒绝整组，不删掉失败部分来伪造成功，也不保证每次都收敛或达到单页。

个人规则的闭环限于审核、采用和后续 typed replay 的只读分析，不宣称所有 committee/layout 模型均自动消费，更不是 RL 训练。每次新建或分叉回放时，Host 冻结当前已审阅、仍 active 的规则及其精确 revision/hash，并把 fingerprint 纳入执行输入。未采用 revision 0 初稿、完全回退的内容不进入模型；曾审阅版本的轻量元数据仍参与 fingerprint，防止 apply→revert 的 ABA 漂移。

继续运行前、模型返回后及 SQLite checkpoint append 都复核规则版本；变化后不保存迟到分析，不隐式重放。旧历史仍能只读查看，继承分析保留原 hash 与原 inputFingerprint，不因新分叉重新认证。使用新规则需新建或显式分叉；缺少该规则快照的旧运行只能查看／新分叉，不能静默续跑。界面在采用读回或确认回退后清除下次模型同意，下一次用户明确执行才创建独立的新规则版本请求。采用／回退本身不调用模型、不修改真实简历、全局 Skill 或 `.agent-memory`。

本说明中较早的构建、导出 SHA 与测试计数是对应历史快照，不作为之后源码的当前通过声明。最新逐项状态与证据以 `docs/planning/career-os-expansion-{acceptance,qa}-2026-11-09.json` 为准；全仓失败、未安装 Embedding、未配置云端／外部 MCP，以及尚未执行的真实正例必须分别保留。

## 10. 最终源码快照的有界收尾记录

以下为最后生产源码冻结后的验收，不覆盖前文历史回执。入口为“AI 顾问 → 职业演练与证据”，九个页签承载十二项能力。实现与有界验证已收尾，不代表十二项所有真实正例均通过、所有外部集成已配置或全仓测试全绿。

最终 `typecheck-closure-final.log` 为 13/13 成功，`lint-closure-final.log` 对应 lint exit 0，`build-closure-final.log` 为 9/9 成功，`desktop-build-closure-final.log` 对应双端构建 exit 0。专项 `career-targeted-closure-final.log` 为 630 项、626 pass、0 fail、4 可选环境 skip；其中受信真实 PDF/DOCX 渲染器 11/11，无 skip。独立 Desktop 生命周期及隔离入口测试为 10/10。`golden-closure-final.log` 为 36/36 **脚本协议夹具**符合预期；faithfulness/citationPrecision 为 1 仅表示该夹具中的约定一致性，431 次脚本模型调用、204 次工具调用和 24ms 不能充作真实模型语义能力或成本证明。

全仓 `full-test-closure-final.log` 仍为 exit 1：4435 项、4361 pass、54 fail、20 skip、0 cancel。54 个“文件＋测试名”与前一次 strict 快照完全相同，不等于全部已被证明是既有失败。限定 HEAD 源码对照已覆盖其中 21 个同名失败；另外 33 个均在岗位浏览器会话组，相关主源码／测试虽与 HEAD 字节相同，但没有逐项 HEAD 执行证明。未 checkout、创建干净 worktree 或复刻完整 HEAD 环境。完整计数、日志 hash 与限定结论保存在 QA `final-test-audit.json`。

### 实际本地模型与最终文件

真实 compiled Native 委员会已完成 14 次模型调用、21 次证据读取、105744ms；最新 Web 快照另一次完成 14 次／21 次／115781ms，输出 18500 字符、7 个角色阶段记录。均仅针对明确选择的一条合成进程内夹具陈述；资料支持和引用核对不构成独立作者或生产成果认证。见 `native-committee-strict-public-operation.json`、`native-committee-strict-report-top.png` 及 `committee-closure-operation.json`。

带胶囊链接的最终一页 PDF 已按实际字节核对正文与 3 个 URI。PDF SHA-256 为 `c7b5256061eeb9656ce532a9596f898bed603853227fb01c77e075c7d4de5cb3`；独立零 Cookie 接收方实际打开从 PDF 提取的精确 URI，首次数据读取为 200，撤销后新接收方的受保护数据请求为 403（静态 bootstrap 仍为 200 属预期）。文件仅在撤销后归档为 `capsule-linked-resume.pdf`，不把访问 token 写入报告。`capsule-linked-pdf-proof.json` 保留链接 hash、读取和撤销证据。较早 DOCX 的两页、孤页与正文差异诊断仍保留，没有以这个 PDF 结果替代 DOCX 验收。

最新版 Native 的措辞分支明确为**部分验收**：真实 Gemma4 e2b QAT 三次请求均为 HTTP 200，但均返回 `candidates: []`，契约锚点只允许本轮问题 `claim:claim-sample-2`。三轮／四次 DOM 渲染实际是原稿与三个布局参数候选，不是措辞改写成功；仍为两页、两项提示、罚分 3，未收敛、未采用。没有措辞候选，因此本次未调用 fresh-context 七项等义审查；其实现和门禁回归不能冒充真实正例。旧改写曾试图改变无关个人标题，被确定性保护拒绝的负例也保留。见 `native-layout-wording-closure-proof.json`，本轮预算结束，不继续逼出成功或放宽保护。

### 图示分享与规则进入下一次分析

最新生产 UI 已完成：同一冻结 context 的独立审阅陈述＋明确保存的两节点／一连线白板 → 精确版本目录 → 选定字段预览（1 处内部名称脱敏）→ 单独冻结 → 明确选择 design/diagram → 单独发布／签发 → 零 Cookie 独立接收方实际看到静态 SVG。接收内容不含内部名称、私有备注、源码路径、问答或故障记录；原始内部 ID 不进入公开图。接收页保留完整文本拓扑及设计限制，不把节点图认证为代码实现。随后撤销胶囊，新接收方受保护数据为 403，owner 不能再签发该胶囊。见 `diagram-closure-proof.json` 与 recipient／revoked 截图。图示正文在 390×844 页面无横向溢出；SVG 的可视截短标签仍可通过完整文本拓扑读取。

同一真实本地运行时另完成两次有界回放：人工审阅规则采用为 v3、hash `2cdcb1f3298544b0c96c93bcf06161278b17880810b79263fbcfcefcaf4a47a4` 后，用户重新确认创建独立分析，持久 metadata 精确包含一条 active 规则及其 fingerprint；回退为 v4 后再重新确认，新分析的 active 规则为空，versions 保留 inactive v4，fingerprint 发生变化。两次均 completed、三个持久检查点、一项分析、零外部 effect。旧 v2 采用／回退历史未覆盖。采用及回退后模型同意均被清除，没有自动重跑。见 `rules-closure-proof.json` 与两份 exact run JSON。这证明版本与输入接线，不证明输出优于旧版，更不是 RL 训练、因果归因或全局 Skill 自动演化。

### 最终应用资源与隔离边界

最后一次实际 `desktop:build` 后已做第三次 recoverable App dist 同步：532 文件、64 目录、137260974 bytes，完整 manifest SHA-256 为 `4fbeaad54a4afb036251a761bdb2888bf8e3cf35cf586f0a2f85d5c86d4dbefa`。入口为 `assets/index-BuI-q5WS.js`，其 SHA-256 为 `2657c02aff5ea36acf7eb5119860752b44dfbdd584ba1485dd03a63f98beba3c`。完整 Web／main／preload 并集与安装后逐文件 hash、路径及目录集合相等；`Info.plist` 与 app/package.json 的字节和 metadata 不变。

新增旧版备份为 `/private/var/folders/hj/dq9kl7md40l2hhdwppqsbc_r0000gn/T/betterme-app-dist-backup-fP7SZ3/previous-dist`；原 `Zw25FY`、`rkgBlf` 两份备份未覆盖或删除。`app-dist-sync-closure-final-2026-11-09-receipt.json` SHA-256 为 `bd50efb94d29429b0322cfb8cf626881116004697809aeec6ff5eee4c9594dc2`。备份仍受系统 temp 清理政策约束，不是永久归档承诺。

实际 compiled Native 已载入最终入口，使用新的隔离 profile 与仅 QA 服务；1180×760 最小窗口的 CSS viewport、document clientWidth／scrollWidth 均为 1180，未发生横向溢出。Root 已逐张查看相关最终截图。没有为了更新资源重启日常 App、真实 Host、登录或浏览器账号。只在当前 `agent-os` 分支保留本次源码与文档变更，没有 commit、push、新建分支、stash、reset 或 clean。

未安装 Embedding、未配置付费云 provider／真实外部 MCP 和未授权公网部署仍是外部配置限制；本轮没有下载模型、创建凭据、连接私人账号或将 loopback Host 暴露公网。#3 的真实措辞成功正例与既有 DOCX 诊断仍保留为限制，不将其改写为成功。

收尾已撤销两端 QA 资料范围、全部合成胶囊及本轮规则采用，关闭本次创建的 Electron／Playwright／REPL，并在核对确切 PID、命令、cwd 与监听端口后，仅 SIGTERM 本次 QA 的 5273／5277／5279 进程。合成证据与私有数据目录仍保留，未删除用户文件。5173／5178／5179、Casdoor 18000 与 Ollama 11434 的原监听进程保持不变，见 `final-service-cleanup.json`。

**启用提示：**保留日常 Host 进程意味着它没有被本轮重新加载到新源码。App 的派生资源虽已更新，仍需由用户选择合适窗口重启原有 Host／App，才能在日常会话启用新增接口；如果 Host 是独立启动的外部进程，只重开 App 不会自动替换它。不要停止不属于本次的进程来“代做”这一切换。上述功能验收使用的是新源码、独立私有数据的 QA Host，不冒充日常真实账号已经完成迁移或功能启用。
