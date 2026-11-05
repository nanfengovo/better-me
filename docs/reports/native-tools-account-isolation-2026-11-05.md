# 原生工具按 BetterMe 账号隔离授权 · 2026-11-05

## 结果与边界

现有 `agent-os`（HEAD `5d5438f`）增加了按服务端身份归属的原生工具授权、受控项目阅读适配和分项状态。不是隐藏不可用项，也没有恢复账号模式下的任意 CLI / shell 执行。未提交、推送、部署或重启正常服务。

| 本机工具 | 本轮实际验证 | 当前新账号状态 |
| --- | --- | --- |
| OpenCode | 真实已安装进程、生产适配器、OS 沙箱和本地合成 TLS 提供方完成往返 | 待本账号独立 API 授权 |
| Gemini CLI | 同上，实际零个可调用工具定义 | 待本账号独立 API 授权 |
| Claude Code | 同上；补齐 `CLAUDE_CODE_TMPDIR`，不再尝试共享 `/tmp/claude-uid` | 待本账号独立 API 授权 |
| Codex | 帮助参数通过，但真实离线启动在管理策略同步阶段失败 | `managed_policy_unavailable`，不伪装为未登录或已接通 |
| DeepSeek Harness / Pi / Antigravity | 本机没有找到对应 CLI 可执行文件 | `not_installed`，不自动安装 |

三个 CLI 的真实进程往返不等于真实云端账号授权成功：本轮没有使用现有登录、没有新建真实 API Key、没有公网模型调用或付费请求。Codex 原生设备登录和可选 API 通道已实现并通过合成身份/HTTP/界面流程，**真实官方登录和真实推理尚未验收**。

## 隔离实现

- 服务端从已认证 BetterMe 会话派生 owner，使用该 owner 的新 `native-tools-v1` 子目录；客户端不能传 owner、可执行文件或宿主目录获取权限。账号资料仍由 Workspace/原业务模块拥有，不迁移简历或历史。
- 凭据只保存到本功能私有文件（目录 0700、文件 0600）；每次调用创建新工作目录，只复制该账号明确授权的凭据。HOME、CODEX_HOME、XDG、Claude/Gemini 配置及临时目录全部独立，不继承父进程 Key、SSH agent、启动脚本、Node 注入参数或已有 CLI 登录。
- macOS Seatbelt 默认拒绝：读本次目录、必要系统运行库和已安装代码/依赖；写仅本次目录。没有放开宿主 home、共享 `/tmp`、全局文件元数据、Keychain 或管理偏好 IPC。进程信息仅允许查询自身。
- 沙箱哨兵真实拒绝另一个账号文件、符号链接和可访问时的 `/System/Volumes/Data` 别名。网络仅经短时认证代理到明确 HTTPS 提供方；拒绝未授权主机、LAN/loopback、保留/映射/隧道地址及 DNS 私网结果，没有普通进程降级路径。当前只声明已验证的 macOS 支持；其他系统返回 `sandbox_unavailable`。
- 原生工具、MCP、hook、插件、浏览器/编辑器自动连接和自动更新等按各 CLI 支持方式关闭；输出按各自 NDJSON 协议校验，拒绝工具事件、异常帧、重复完成、不完整结果和凭据回显。资料请求继续经现有受控 Evidence Broker，不把宿主项目路径挂给 CLI。
- 切号/退出固定原会话代次；撤权/重新授权固定凭据代次并取消在途、排队和对应阅读 turn。提交前再次检查身份/授权，故意忽略 abort 的测试进程也不能保存迟到结果。原生令牌刷新仅写回该 owner；幂等请求不会替换正在运行的撤权监听。
- 撤销只删除本功能的 `connection.json` / `auth.json`，不执行全局 CLI logout，不删除历史。即使工具后来卸载、版本不兼容或沙箱不可用，已有独立授权仍显示并可撤销。

## Codex 原生登录与当前阻塞

设备登录显式运行官方 `codex login --device-auth`，设置本账号独立 CODEX_HOME 和文件凭据存储。只解析 OpenAI 官方设备地址；设备码仅在发起的 BetterMe 会话短期展示，不进入聊天、事件或长期记录。取消/退出后不会接受迟到凭据，也不会复制电脑上已有 Codex 登录。API Key 是另一条明确授权通道，不自动创建或回退。

本机 Codex 的真实启动报 `Failed to synchronize managed preferences`。官方实现要求成功执行 `CFPreferencesAppSynchronize("com.openai.codex")` 才继续读取强制管理策略。当前严格隔离下未能完成该步骤；这不是 Key 错误，也不能用跳过策略、授予共享偏好/凭据权限或假报成功解决。最终离线能力探测仍返回 `managed_policy_unavailable`。

后续需另行明确是否为 BetterMe 准备独立的兼容 Codex 运行版本/受支持策略读取方式并验证；不得覆盖全局 CLI、改管理员策略或动已有登录。还未确认某个替代版本一定解决问题，不能承诺“升级即修复”。

官方依据：

- [Codex 原生认证](https://developers.openai.com/codex/auth/)
- [Codex macOS 强制管理策略加载源码](https://github.com/openai/codex/blob/main/codex-rs/config/src/loader/macos.rs)
- [Claude 专用临时目录变量](https://code.claude.com/docs/en/env-vars)
- [Claude 无交互运行](https://code.claude.com/docs/en/headless)、[OpenCode CLI](https://opencode.ai/docs/cli/)、[Gemini 无交互运行](https://geminicli.com/docs/cli/headless/)

## 界面与使用

“模型与工具 → 项目理解/受控阅读工具”以及项目理解面板共用本账号状态：已连接、待本账号授权、授权已保存但未验证、登录进行中、未安装、缺少适配、沙箱不可用、协议不兼容、管理策略同步受阻、隔离进程被系统终止。不能选择未授权工具，不自动改变上方统一模型。

API 表单要求明确模型、可选 HTTPS 基础地址和保存/配额同意；Key 仅组件内暂存，保存/取消后清除，不进入浏览器持久存储。保存凭据显示“待验证”，首次本人授权的实际运行成功后才标记已连接。Codex 默认提供原生登录；只有其运行环境检查通过后才允许开始授权。

独立合成预览 `apps/web/tests/ui-lab/native-tools.html` 不连接真实 Host、简历、记录、OAuth 或模型。已验证两账号授权不串号、原模型选择不变、官方链接/演示设备码与取消、1512×900 浅色及 390×844 深色。手机实测 viewport/content/body 均 390，无横溢出；演示码取消后不再显示。

截图：`output/playwright/native-tools-desktop-light.png`、`output/playwright/native-tools-mobile-dark.png`。这些截图是合成预览，不冒充原正常页面或真实官方登录。独立验收浏览器和5423预览已关闭，仅保留源码及截图。

## 验证与复现

- `pnpm test`：3786 项，3776 通过、0 失败/取消、10 项既有环境跳过。
- 定向账号/HTTP/界面回归：24/24，包含 React StrictMode、两账号与同账号不同会话、并发登录、退出/撤权/重新授权/资料取消、A→B→A、幂等在途重查、忽略取消的迟到进程及版本失效后仍可撤销授权。
- `pnpm typecheck`：13/13；`pnpm build`：8/8；`pnpm lint` 及本批测试/预览额外 ESLint 零警告；`git diff --check` 通过。生产构建仍有既有 chunk/外部模块提示，不称无警告构建。
- opt-in **真实已安装二进制**验收（不混入默认可移植回归）：下列命令 6/6，通过文件隔离哨兵、其他合成进程元数据拒绝、直接本机网络/未批准代理主机拒绝，以及三个 CLI 真实文本往返。

```sh
BETTERME_NATIVE_ACCEPTANCE_IDS=opencode,gemini-cli,claude-code \
  node --import tsx --test apps/agent-host/tests/native-installed.acceptance.ts
```

测试只通过受信任的进程内 seam 将 `fixture.invalid:443` 转向本地合成 TLS 服务，使用与生产相同的 OS 沙箱、代理认证和输出解析。没有 HTTP 可配置的该 seam、真实账号/Key 或公网模型请求。完整四工具命令保留 Codex，不偷偷跳过它；在当前机器上应因上述管理策略阻塞失败，不宣称全四工具已通过。

## 数据保护与交接

未读取或写入真实简历/旧记录、未迁移或认领资料、未登录/退出真实 BetterMe/Codex 账号、未读现有凭据、未创建 Key、未发送真实资料。测试的合成授权/turn/文件随临时目录清理；项目交接文档和源码是本轮唯一持久变更。

收尾核对：187 个不在本批范围内的原有脏文件 SHA-256 与起点一致。该比较只证明源码保护，不声称读取/逐字节审计了真实业务数据库。原 5173/5178/5179 监听 PID 分别保持 56859/38562/56891；未刷新原浏览器或重启原进程，因此旧 Host 尚未加载本批接线。仍在 `agent-os` / `5d5438f`，索引为空，未新建分支、提交、推送或更新容器。

继续时先保护本人未保存页面；正常环境加载和真实独立授权由本人明确操作。不能把本轮合成账号授权继承到真实账号，也不能拿真实简历替代合成资料做验收。
