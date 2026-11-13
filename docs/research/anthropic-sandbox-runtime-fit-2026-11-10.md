# Anthropic Sandbox Runtime 对 BetterMe 的适用范围

**结论：借它设计原生工具执行边界，先不替换现有沙箱。** `srt` 解决的是一个本机进程及其子进程能接触哪些文件、网络和本地服务。它不会判断一条简历改写有没有依据，也不会替 Agent 决定下一步。对必须运行真实二进制的工具有参考价值；对于已能在 QuickJS 里完成的纯 JSON 转换，引入 OS 进程没有相应收益。[上游用途与机制](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#how-it-works) · [BetterMe 工具生成与独立校验](../../apps/agent-host/src/kernel/tool-builder.ts)

截至 2026-11-10，npm `latest` 与 GitHub 正式发布均为 `0.0.82`；此次查询的 `main` 与 `v0.0.82` 标签指向同一提交 `f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889`。包要求 Node ≥22.12，许可证 Apache-2.0；项目仍将整体定位为研究预览。以下为源码与发布说明评估，不是 BetterMe 接入或跨平台实测。[npm 固定版本元数据](https://registry.npmjs.org/@anthropic-ai%2Fsandbox-runtime/0.0.82) · [固定提交](https://github.com/anthropics/sandbox-runtime/commit/f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889) · [发行说明](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.82) · [项目定位](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#anthropic-sandbox-runtime-srt)

## 对照现有执行路径

| BetterMe 路径 | 已有能力 | SRT 带来的选择 |
| --- | --- | --- |
| [岗位任务和 QuickJS](../../apps/agent-host/src/kernel/tool-builder.ts) | 宿主固定 JSON 契约、用例和真实输入的预期输出；生成、修复、执行计入任务额度。 | 保留。不要把模型生成的 JS 升格到能执行原生程序的环境。 |
| [原生模型 CLI](../../apps/agent-host/src/native-tools/process.ts) | 专用环境、macOS 默认拒绝型配置、逐端点代理、跨账号文件探针；这个 runner 在非 macOS 不可用。 | 借鉴代理和平台适配，不替换这套更窄的读取、凭据及账号边界。 |
| [已审阅的 MCP stdio](../../apps/agent-host/src/career-mcp/stdio.ts) | 校验可执行文件与制品指纹，强制 OS 沙箱，再针对 macOS/Linux 收紧读取并断网。 | 可作为 A/B 比较的安全基线，不是缺少沙箱、等上游来补。 |
| [通用本地 Run 计划](../../apps/agent-host/src/runs/sandbox.ts) | `auto` 可能只有进程隔离；通用 macOS 计划允许出站，通用 Linux 计划以只读方式挂宿主根。只读不等于保密；专用调用方另可收紧。 | 若未来要执行不需要联网的原生文档解析器，最值得在这一层比较受限后端，而不是将通用计划直接赋给岗位任务。此处不是对已有岗位任务越权的实证。 |

还有一道重要区别：普通账号调用通用 `/runs` 时，[Host 入口](../../apps/agent-host/src/server.ts#L526) 会返回 403，除非显式启用受信单用户运行模式；这一路的[通用子进程启动](../../apps/agent-host/src/runs/run-manager.ts#L155)会继承父进程环境。试点应使用独立、最小环境的工具执行器，不应为了试 SRT 解开 `/runs`。现有[受审 Office 转换](../../apps/agent-host/src/career-studio/final-export-renderer.ts#L128)也是可复用的断网策略基线。

## 值得照搬的原则和不能照搬的默认值

1. **一次授权，逐次强制，而不是每读一次都确认。** 由可信 Host 将任务许可翻译成文件与网络策略，子进程不能自行扩权；授权目录外的访问是「需要新授权」，而非「换一种命令再试」。网络白名单只决定允许到达哪里，不判断发送内容是否包含私有简历，像 GitHub 这样的共享域名不是对应特定仓库或业务动作的授权。[双重隔离设计](https://www.anthropic.com/research/claude-code-sandboxing) · [上游限制](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#security-limitations)
2. **默认配置不是个人资料保险箱。** 上游读取规则默认宽松，`allowRead` 是在已拒绝区域内重新开放，不是单独设置就构成只读白名单；写路径也存在系统/工具便利例外。不要让上传材料、项目配置或模型决定开关。建议优先将准许的最小输入经 stdin 或不带硬链的独立文件传给工具，隔绝真实资料根、凭据、其他账号、Host 接口和本地 socket；不能证明隔离就不上真实材料。[文件策略和例外](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#filesystem-configuration)
3. **任务身份、沙箱会话、命令编号是三件事。** 库有模块级配置和代理状态；上游明确说明按命令登记出站域名不构成并发执行间的隔离。文件策略在进程运行中也不会因更新控制通道而即时撤回。建议可信 helper 按授权域分离，撤权时结束进程树并拒收迟到输出，不复用旧进程或只改一个配置对象。[管理器源码](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/src/sandbox/sandbox-manager.ts#L185-L208) · [控制通道](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#updating-the-config-while-the-command-runs---control-fd) · [按命令网络授权](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#as-a-library)
4. **保留 BetterMe 的固定命令和干净环境。** v0.0.82 的 `wrapWithSandboxArgv` 输入仍是命令字符串；在 macOS/Linux 返回的描述包括 shell `-c`，`env` 沿用调用进程环境。不能因外层使用 `shell: false` 就把文件名、JD 或模型生成文本拼进命令。固定受审工具入口，在 helper 启动前裁剪环境，数据只走数据通道；宿主、策略、执行器及测试预期都在可写目录之外。[固定版本接口实现](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/src/sandbox/sandbox-manager.ts#L3064-L3087) · [安装位置风险](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#security-limitations)

平台必须分别评估。macOS 使用 Seatbelt；不要开启能拉起沙箱外应用的 `allowAppleEvents`。Linux 使用 bubblewrap 与网络命名空间，Unix socket 的 seccomp 能力还要单独检查。Windows 在该发布中已有 **alpha** 原生后端；默认 dedicated-account/WFP 后端涉及一次提权安装，官方列出系统服务代发和特定 token 绕过等边界。另一个可选 MXC 后端是不同机制，要求 Node 24+ 与可选 SDK，不能据此认定所有 Windows 安装具有同样防护。不要自动给用户机器安装账号或改系统策略。[各平台机制](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#how-it-works) · [Windows 已知限制](https://github.com/anthropics/sandbox-runtime/blob/v0.0.82/README.md#known-limitations) · [MXC 发行说明](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.82)

## 对本地模型造工具更直接的一项发现

调研时发现的工作区快照中，本机 Ollama 的[配置模型适配](../../apps/agent-host/src/tasks/runtime.ts)对每次调用设置严格的 `career_task_decision` 响应结构；内核把同一个 reasoner 传给[工具构建器](../../apps/agent-host/src/kernel/tool-builder.ts)，后者只接受 `{source: string}`。[决策结构](../../packages/agent-contracts/src/career-task.ts)并不接受这个对象。上一次合成验收注入的脚本化 reasoner 绕过了配置模型的 HTTP 序列化，因此可以验证沙箱测试与修复机制，但不是这一条真实适配路径的证明。

本次让实际配置适配器和构建器运行，把其 `fetch` 替换为不转发的内存函数，固定返回符合决策协议的 `{kind:"tool",tool:"read_job"}`。拦截的三次请求均同时包含生成 `source` 的提示和 `strict: true` 的 `career_task_decision`；预算预留回调触发三次（仅内存计数），未进入 QuickJS，最终为 `tool_qualification_failed`。外部请求和真实模型调用均为零，没有写实际任务账本。这个检查证明请求契约冲突，不证明所有 Ollama 版本在真实推理中一定有同一种表现。

优先建议按宿主任务阶段选择返回协议：决策阶段用决策 schema，生成/修复阶段用源码 schema；两者仍绑定同一模型、同一授权和根预算，不按材料中的特殊字符串切换协议。解决这点无需更换沙箱。

**后续实施更新（同日）：此冲突已修复。** [Host 阶段协议](../../apps/agent-host/src/kernel/model-protocol.ts)由内核明确选择，配置模型与原生推理适配分别使用决策/源码契约。实际配置适配器 + 持久任务 + QuickJS 的离线传输回归覆盖首轮失败、源码修复及返回待审，同端点同模型累计扣 6 次根请求；没有发真实模型请求。JD 定向旁写也已接续同一任务面板、证据与版本审阅。具体范围及未迁路径见[续作验收](../reports/unified-agent-kernel-2026-11-10.md#续作宿主阶段协议与当前经历交接)，不再把上述调研时缺陷当作现存实现。

## 最小验证建议

用户已采纳**有条件触发**的实验，不是立即安装或引入原生命令：等首个确实需要原生程序的工具出现，再用**固定版本、无网、无模型、只读合成项目文档的抽取器**，输出带页码的原句。本轮没有这种需求，未安装或启动 SRT。在隔离环境里用相同输入比较现有专用执行器与 SRT：合法输出逐项一致，再验证跨账号直读、符号/硬链接、子进程、未授权网络/本地服务和 socket 全部被阻止；并发或撤权后不串任务、不接收迟到结果。测试不可用的 OS 能力、超时及超额输出必须停，不能退回裸进程。一次历史漏洞曾让空域名列表未能禁网（`<0.0.16`，`0.0.16` 已修复）；用实际恶意探针验证，不能以配置回显代替。[维护者安全公告](https://github.com/anthropics/sandbox-runtime/security/advisories/GHSA-9gqj-5w7c-vx47)

若实验没有增加可验证的原生工具能力，或做不到现有专用路径的权限边界，保留现有实现。若通过，SRT 也只作为受控执行后端；证据引用、根预算、运行回执、合格工具版本、长期安装、正式简历保存与 FactBase 提案仍分别由 BetterMe 处理。沙箱为编码提供可重复的试错环境；模型是否真的写得更好，应单独用固定底座与留出合成用例测量。[现有统一内核与验收范围](../reports/unified-agent-kernel-2026-11-10.md)

若要衡量对本机模型的帮助，应另做同模型、同输入、同预算的对照：比较首次通过率、修复后留出用例通过率和累计调用成本；越权或撤权后仍发布结果属于硬失败，不能被效果分抵消。研究本身不改变当前优先级：岗位任务与旁写共用内核、授权和审阅链，无须等待这个原生后端实验。
