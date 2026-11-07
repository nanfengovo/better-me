# Career OS 生成应用与沙箱可行性研究

日期：2026-11-06。源码观察基线：`adb93a3`。本报告是架构研究和建议，不是已采用的架构、已完成的安全验收或任意代码执行授权。

## 结论

BetterMe 可以把现有职业工作区组织为“应用”，通过统一 Dock、窗口生命周期和 Agent 服务形成个人职业系统；这不要求每个菜单都启动一个 Docker 容器。**Dock 是交互入口，应用是能力与数据的组织单位，沙箱是处理不可信代码的执行机制，三者不能混为一层。**

建议先交付受信任的系统外壳和内置职业应用，再允许 Agent 生成采用统一组件的声明式小应用。任意 React/JavaScript 页面以及需要安装依赖、执行命令的完整应用，应分别通过隔离展示环境和独立构建/执行环境晋级，不能直接进入主站进程、主站源域或主数据库。

Career Workspace 继续管理职业资产、事实、版本和业务状态；Agent、生成应用和容器只能经受控命令访问它们。这与当前 [Project Brief](../../.agent-memory/projectbrief.md) 的业务权威约束一致。

## 当前可复用的执行底座

当前 [capabilities/sandbox.ts](../../apps/agent-host/src/capabilities/sandbox.ts) 使用 `quickjs-emscripten`，把生成源码作为数据交给新的 QuickJS/WASM 上下文；可信 Node Worker 引导不向生成函数暴露宿主函数、文件系统、网络或凭据。源码明确限制源码大小、JSON 输入输出、堆栈和运行时间，并在完成/取消时等待 Worker 终止。它拒绝 Promise 输出。

这说明项目已有**同步 JSON 转换工具**的可复用执行基础，但不能据此宣布已有任意 React 应用、npm 安装、Python/原生程序或长期后台服务沙箱。本轮仅检查源码，没有重新执行逃逸、资源耗尽或取消测试。

QuickJS 官方提供运行时内存/栈限制与中断回调；WebAssembly 的安全模型又受宿主暴露的接口和嵌入环境约束。因此“使用 WASM”并不自动证明一个应用安全，宿主桥的能力、输入输出及资源管理仍须单独审查。[QuickJS C API](https://bellard.org/quickjs/quickjs.html#Memory-handling)、[WebAssembly 安全模型](https://webassembly.org/docs/security/)

## 三档生成应用方案

以下是基于当前代码和官方约束的工程建议，而非供应商性能结论。

| 方案 | Agent 交付什么 | 执行与展示 | 适用范围与取舍 |
| --- | --- | --- | --- |
| A 受约束小应用，建议首选 | 页面结构、字段、图表、操作描述；可选纯 JSON 转换函数 | 平台受信任的组件渲染器；转换逻辑沿用受限 QuickJS/WASM | 对比器、整理器、检查清单、职业证据看板；最容易统一字体、颜色、按钮、可访问性和数据权限。不能嵌任意 DOM/脚本。 |
| B 自定义前端应用 | 固定版本的前端源代码、依赖清单、应用描述 | 独立构建环境产出静态包；独立源域 iframe 展示；仅通过受控消息桥调用宿主能力 | 确有自定义交互需求时再启用。自由度更高，但新增源域、消息、网络、资源耗尽与发布审查成本。 |
| C 完整代码应用 | 带后端/命令行任务的版本化包 | 隔离执行端按需启动受限容器，必要时叠加 gVisor 或独立 VM；UI 仍走 A/B | Python、编译、复杂依赖、长任务；运维、容量、成本、数据外发和兼容性需独立验收，不宜每个现有菜单都采用。 |

内置简历、岗位、经历等受审应用可以继续复用当前 React/领域实现；不必为了“像系统”把它们全部 iframe 化。新增应用的清单只是组织与权限描述，**清单本身不是执行隔离**。

## 浏览器应用的隔离边界

### 已核实的浏览器事实

- iframe 可通过 `sandbox` 限制脚本、表单、弹窗、导航等能力；不设置 `allow-same-origin` 会使嵌入内容具有特殊的不透明源。主页面与 iframe 同源时，同时给予 `allow-scripts` 和 `allow-same-origin` 会允许其中的代码解除沙箱限制，MDN 明确警告不要这样使用。[iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox)
- `postMessage` 允许跨源通信，但接收端必须验证发送源、窗口来源和消息格式；发送端在目标源已知时应指定精确 `targetOrigin`，而不是 `*`。[postMessage 安全要求](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage#security_concerns)
- CSP 可以约束脚本和各类资源的加载；`connect-src` 约束 fetch、XHR、WebSocket 等连接，但不是覆盖所有资源和导航的通用出网防火墙。[CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)、[connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)

### 对 BetterMe 的设计推论

生成应用应位于与职业主站隔离、没有主站会话 Cookie 的应用源域，不能直接注入主站 React 树。原则上采用每应用/版本隔离的资源命名与存储策略；主站 Cookie 使用宿主限定，不能把父域 Cookie 广泛共享给应用源域。只有宿主可以创建真正的系统权限对话框，应用内容不能伪装批准按钮。

消息桥应采取固定协议与白名单命令，并绑定当前窗口、应用 ID、发布摘要、会话代次、请求 ID、权限和资源范围。应用不能自己声明 owner 后得到信任；实际 owner 必须由服务端会话派生。业务端再次校验授权、资源归属、版本与幂等键，不能只相信前端桥已经检查过。

对于不透明源，消息 `origin` 不能唯一标识应用，不可把 `origin === "null"` 当作认证。此路线需要受控初始化、指定窗口/MessagePort、每次实例的能力绑定及导航失效处理；如果没有完整验证，先采用 A 档受信任渲染器，不以简化代码跳过这层判断。

iframe/CSP 也不能作为已验证的应用级 CPU/内存硬配额或绝对保密保证。生成 UI 只接收本次任务必要的最小投影，不能拿到完整简历库、主站凭据、模型密钥或任意文件句柄。敏感资料优先由受信任组件展示，生成逻辑仅处理经过授权的结构化输入。关闭应用窗口与取消后台任务是两个不同动作，必须有明确状态和恢复语义。

## 构建与后端执行隔离

Node 官方明确指出 `node:vm` 不是安全机制，不应运行不可信代码；换一个 JS context、工作目录或普通子进程，不等于隔离任意 Agent 生成代码。[Node.js VM](https://nodejs.org/api/vm.html)

Docker 使用命名空间和 cgroups 等机制，但 daemon 控制权和宿主挂载会扩大攻击面；默认容器也没有 CPU/内存资源上限。不能把能构建/运行一个镜像直接称为不可信代码安全验收。[Docker Engine security](https://docs.docker.com/engine/security/)、[Docker 资源限制](https://docs.docker.com/engine/containers/resource_constraints/)

gVisor 通过每个沙箱的应用内核拦截系统调用，降低应用直接接触宿主内核的范围；其官方文档也明确承认系统调用兼容性及性能权衡。独立 VM 则是另一种更强隔离的候选，不能只凭“容器”名称选择。[gVisor 架构与取舍](https://gvisor.dev/docs/)

建议独立设计两个环境：

1. **构建环境**：无真实职业数据、无模型/云凭据、无 Docker socket、无用户 HOME 挂载；临时目录、受控依赖源、固定锁文件、安装脚本默认禁用、日志脱敏、时间/资源/产物大小限制。生成的构建配置与依赖安装同样是不可信代码，不能在主仓库直接执行。
2. **运行环境**：只读应用包、最小临时写入空间、非特权身份、有限进程/CPU/内存/时长，默认无网络；必要的外部访问由受信任网关白名单、预算与授权控制。持久结果通过 Workspace 命令落库，而不是挂载主业务数据库。

pnpm 的 `--frozen-lockfile` 与 `--ignore-scripts` 分别用于保持锁定解析和禁止项目/依赖的安装脚本；它们能减少风险，但不能替代构建环境隔离，也不能保证后续执行的打包工具或依赖可信。[pnpm install](https://pnpm.io/cli/install)

## Agent 创造应用到正式发布的建议流程

```text
明确需要 → 应用规格与权限草案 → 隔离生成/构建 → 自动与对抗验证
         → 合成数据预览 → 用户确认安装及权限 → 不可变版本发布
         → 按授权运行 → 撤权/停用/更新/回滚
```

“Agent 能发布”建议解释为：Agent 可以准备待发布候选，平台依据门槛和本人批准安装；不能解释为 Agent 自行修改鉴权、主站代码、验证器、权限规则或自动扩大授权。

应用清单至少需要：稳定 ID、版本、制品摘要、入口类型、SDK/协议版本、适配设备、读写能力与资源范围、网络需求、资源预算、存储 schema、升级/撤销策略及验证结果。权限变更和代码摘要改变都要重新评估；批准不能只绑定一个可被替换的名称或 URL。

构建来源应可追溯到源代码、依赖、构建器与输出摘要。SLSA 的 provenance 定义可作为记录设计参考；有记录不等于项目已经达到某个 SLSA 级别，也不证明程序业务行为正确。[SLSA 1.2 provenance](https://slsa.dev/spec/v1.2/provenance)

业务数据有单独的生命周期：

- 默认读授权只返回选定资源的投影；写入先形成 Proposal，展示差异，明确确认后由 Workspace 命令采用，保存完整版本回执。
- 撤权同时停止新调用、取消可取消任务、使旧会话代次与迟到结果失效；已完成的业务写入通过另行授权撤销，而不是静默删除记录。
- 回滚应用包不等于回滚数据。升级需要 schema 兼容声明、备份及迁移预演；未知数据版本不允许旧包继续写。初版自定义应用只持有独立命名空间数据，不许迁移核心简历/事实库。
- 一个应用失败应能被停用和卸载，保留其业务成果/审计记录；不得通过关闭整个系统掩盖后台任务状态。

## 手机和平板不承担本机容器平台

iOS/iPadOS 的 Home Screen Web App 能提供应用化入口、独立显示和获准后的 Web Push；这些是 Web 能力，不是宿主 Docker 或任意 OS 进程权限。[WebKit Home Screen Web Apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

WebContainers 提供的是浏览器内 Node.js/命令执行环境，适合代码预览等用途，并非用户机器上的 Docker daemon。官方浏览器支持页目前仍把 Safari 与 Firefox 标为 beta，并要求 SharedArrayBuffer 与跨源隔离。因此它可以作为开发预览候选，不能未经真机验证就成为三端必备基础。[WebContainers 定义](https://webcontainers.io/guides/introduction)、[浏览器支持要求](https://webcontainers.io/guides/browser-support)

建议：三端共享应用协议和任务状态，布局与窗口行为各自适配；手机直接使用受信任的小应用，重构建/长任务由用户明确选择的本地桌面服务或远程执行端承担。远程执行必须说明哪些资料会离开设备。任务续跑依赖执行端持久任务，而不是假定手机页面在后台持续运行。

Electron/Tauri 是日后可选宿主，不是实现 macOS 视觉的前提。Electron 官方要求限制 Node 集成、启用上下文/进程隔离并验证 IPC 发送者；Tauri 也强调 WebView 到核心的能力控制，核心/插件并不会自动受同样沙箱限制。因此换桌面壳不能取代应用权限桥和执行隔离。[Electron security](https://www.electronjs.org/docs/latest/tutorial/security)、[Tauri security](https://v2.tauri.app/security/)

## 进入实施前的最低验收

- 用一个合成“岗位对比器”证明同一应用可在桌面、平板和手机打开、切换、恢复；它只读指定岗位快照，不读取真实履历。
- 证明生成应用不能访问主站 Cookie/DOM、其他应用私有状态或系统权限接口；伪造 owner/app/digest/消息源均被拒绝。
- 注入死循环、内存增长、无限日志、超大输出和外网尝试，验证超时/取消可终止且不阻塞宿主；不能仅用“进程 exit 0”代替业务成功。
- 构建中恶意安装脚本、路径逃逸、宿主挂载、依赖替换与凭据探测均失败；生成器不能修改自己的验证规则。
- 更新加权限需重新批准；撤权、换号、并发版本、关闭窗口和迟到结果不会造成跨账号写入或重复业务操作。
- 验证停用与回滚能保留职业资产；不兼容的数据迁移可被阻止和恢复。真机 Safari/Chrome、输入法、键盘、安全区、弱网及后台恢复分别验收。

本轮已核对官方安全文档与当前纯 JSON 执行源码。没有实现应用注册、生成 UI 运行器、容器平台或发布流水线，也没有做渗透、跨平台真机、Docker/VM 或真实资料验收。
