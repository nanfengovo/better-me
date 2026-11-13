# BetterMe Agent Host

本地 Agent 基座，当前推理执行以统一任务内核为权威，包含：

- `@better-me/agent-contracts`：Runtime、事件、Artifact、ContextPack、Run 和审批批次的 Zod 契约。
- Runtime Registry：扫描当前 `PATH`、`~/.local/bin`、Homebrew 等常见目录，预置 Claude Code、OpenCode、Gemini CLI、Codex、DeepSeek Harness、Pi、Antigravity。
- AgentTaskKernel：真实任务类型、明确选择的模型/原生/账号运行时、owner 隔离、同工作区累计根账、证据装载和人工恢复；执行只使用 `/tasks` 及其子路径。
- Run Manager / Worker Adapter：内部执行及历史兼容模块；原 run 的完整输出、事件回放和取消仍可读写，但 HTTP `/runs` 不再启动独立 CLI。
- 沙箱计划：记录 `process` / `os-sandbox` / `none` 隔离级别；支持 macOS `sandbox-exec` 与 Linux `bubblewrap` 的显式 fail-closed 模式。
- SSE 事件流：事件带单调 `sequence`，支持 `Last-Event-ID`/`after` 断线回放。
- 旧 Career Orchestrator：历史纯阶段/审批模板不再由 HTTP 构建或执行；本人既有检查点仅通过 owner 隔离的只读入口完整回读。

## 本地启动

```bash
pnpm --filter @better-me/agent-host start \
  --host 127.0.0.1 \
  --port 5179 \
  --token better-me-agent-token
```

如果本机切换了 Node 主版本，需要按当前 Node 版本重建 `better-sqlite3`：

```bash
npm rebuild --prefix node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 better-sqlite3 --build-from-source
```

## 主要接口

- `GET /api/v1/agent/runtimes`
- `POST /api/v1/agent/runtimes/scan`
- `POST /api/v1/agent/tasks`，执行/续答/恢复等使用对应 tasks 子路径
- `GET /api/v1/agent/tasks`
- `GET /api/v1/agent/tasks/:taskId`
- `GET /api/v1/agent/tasks/:taskId/outputs/:outputId`：owner私有完整原始输出，只读，不推理/重试；共享Web reader先核对完整字节数/SHA-256再显示或下载。当前资源与双端恢复证据见 [完整输出读取回执](../../docs/reports/task-output-artifact-reader-2026-11-12.md)。
- `GET /api/v1/agent/runs`
- `GET /api/v1/agent/runs/:runId`
- `GET /api/v1/agent/runs/:runId/events`
- `POST /api/v1/agent/runs/:runId/cancel`
- `GET /api/v1/agent/health`
- `GET /api/v1/agent/workflows/career/state/:threadId`：完整历史 checkpoint / pending writes，只读，不自动关联或认领无主记录

兼容推理 POST `/chat`、`/chatgpt/response`、`/routing/respond`、`/understanding/sessions/:id/turns`、`/runs`、`/workflows/career/start` 和 `/workflows/career/resume` 均返回 410 和 `next: /api/v1/agent/tasks`；原 JD start/resume 的 410 保持。模型目录、登录、routing 配置、历史读取与显式历史撤权/取消不是新的推理入口。具体迁移边界和验证见 [工作流退役与账号攻防验收](../../docs/reports/career-workflow-retirement-and-account-defense-2026-11-12.md)。

除精确 GET OIDC 回调外，所有接口都需要 `Authorization: Bearer <token>`，但它只代表应用连接，不代表某个用户。除健康与账号入口外，私有接口还需要服务端签发的 HttpOnly 会话 Cookie，以及与该会话一致的 `X-BetterMe-Owner` 竞争保护头。归属从 Cookie 验证结果确定，客户端头、工作区或 thread ID 不能授权访问别人的记录。OIDC 回调由浏览器绑定、单次 state、PKCE、nonce 和签名 JWT 验证保护，不是免鉴权私有接口。

账号接口：`POST /api/v1/agent/identity/register`、`POST /api/v1/agent/identity/sign-in`、`GET /api/v1/agent/identity/session`、`POST /api/v1/agent/identity/sign-out`。私有记录接口 `GET/POST /api/v1/agent/records/continuity?key=...` 和 `.../growth?key=...` 使用 revision CAS，不会在出错时回退到旧的无归属库。

可选 Casdoor 通过服务端私有 OIDC 配置启用：`GET .../identity/providers` 查询可用性，`POST .../identity/oidc/start` 发起登录/显式关联，`GET .../identity/oidc/callback` 完成。外部 `issuer + sub` 映射既有稳定 owner，关联要求当前本机密码与活跃原会话，不按邮箱/手机号自动合并。`GET .../recovery` 及其文档/完整会话子路径只读列出本 owner 的不可变恢复档案，没有 HTTP 认领或迁移写入口。详情见 [Casdoor 与旧资料恢复](../../docs/casdoor.md)。

账号根目录默认是运行数据目录（未配置时为 checkpoint 所在目录）下的 `accounts-v1`，每位用户再分配 `owners/<server-uuid>`。身份密码使用带独立盐的 scrypt；会话仅存摘要，8 小时绝对到期、1 小时未使用到期。POSIX 上私有目录/文件使用 0700/0600。旧 checkpoints、runs、源码授权和 ChatGPT 凭据不自动认领，不能通过源码取证读取账号私有目录。

业务数据库、岗位地图坐标和长期用户事实不由 Run Manager 直接写入；写入应由后续确定性工具在审批、证据和 CAS 校验后执行。

## 当前安全边界

通用 `/runs` 及旧 career start/resume 在可信单用户模式下也只返回 410，不另建执行权威。tasks 中原生运行时须使用当前 owner 的独立授权和隔离能力，不能继承系统共享凭据；仅改变工作目录或 thread ID 不构成隔离。Registry 的发现结果不等同执行授权。受控取证只使用本人明确选择且已授权的底座，不会自动改走付费 API。

底层单用户嵌入/隔离测试仍有可信代码选项 `trustedSingleUserRuntimeExecution`，HTTP 和 CLI 不提供开启参数，也不能借此重开已退役路由。历史底层执行器默认 `--sandbox auto` 的独立目录和 `shell:false` 参数数组只是 `process` 隔离，不是 OS 权限边界。其显式 OS 沙箱使用 macOS `sandbox-exec` 与 Linux `bwrap`/`bubblewrap`，`required` 不可用时直接失败，不静默降级，也不自动解决多账号凭据隔离。

当前文件事务按进程串行，仅支持单实例 Host 拥有一个账号目录，不支持多进程共享写入；没有本机密码重置、云端账号数据同步、端到端加密或公共网络部署验收。会话 Cookie 使用 SameSite=Strict/HttpOnly，OIDC 流程 Cookie 为 SameSite=Lax/HttpOnly；通过受信任 HTTPS origin 时加 Secure。Casdoor OIDC 已可选接入，公网产品仍需 TLS、可信代理和数据库隔离专项验收，不应暴露开发 token。

旧 Career 检查点读取不执行阶段、模型或审批，不代表实时招聘抓取、公司调研或地图写入已完成。历史显式关联/范围变化接手、完整 artifact 阅读 UI、真实 Gold 集及完整四维评测/模型比较仍须按验收表推进；不能用合成任务测试宣称模型写作质量或全部目标完成。
