# BetterMe Agent Host

本地 Agent 基座的第一阶段实现，包含：

- `@better-me/agent-contracts`：Runtime、事件、Artifact、ContextPack、Run 和审批批次的 Zod 契约。
- Runtime Registry：扫描当前 `PATH`、`~/.local/bin`、Homebrew 等常见目录，预置 Claude Code、OpenCode、Gemini CLI、Codex、DeepSeek Harness、Pi、Antigravity。
- Run Manager：每次运行独立目录，参数数组启动本地 CLI，输出事件化并支持取消、超时和结果回收。
- Worker Adapter：把 ContextPack、CLI 参数和 Claude/Codex/通用 JSON 输出解析集中在运行时 seam，Career 图不直接耦合某个 CLI。
- 沙箱计划：记录 `process` / `os-sandbox` / `none` 隔离级别；支持 macOS `sandbox-exec` 与 Linux `bubblewrap` 的显式 fail-closed 模式。
- SSE 事件流：事件带单调 `sequence`，支持 `Last-Event-ID`/`after` 断线回放。
- Career Orchestrator：岗位发现、公司研究、匹配、地点证据、事实检查和覆盖率检查的 LangGraph 默认模板，在审批门禁前中断。

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
- `POST /api/v1/agent/runs`
- `GET /api/v1/agent/runs`
- `GET /api/v1/agent/runs/:runId`
- `GET /api/v1/agent/runs/:runId/events`
- `POST /api/v1/agent/runs/:runId/cancel`
- `GET /api/v1/agent/health`
- `POST /api/v1/agent/workflows/career/start`
- `POST /api/v1/agent/workflows/career/resume`

除精确 GET OIDC 回调外，所有接口都需要 `Authorization: Bearer <token>`，但它只代表应用连接，不代表某个用户。除健康与账号入口外，私有接口还需要服务端签发的 HttpOnly 会话 Cookie，以及与该会话一致的 `X-BetterMe-Owner` 竞争保护头。归属从 Cookie 验证结果确定，客户端头、工作区或 thread ID 不能授权访问别人的记录。OIDC 回调由浏览器绑定、单次 state、PKCE、nonce 和签名 JWT 验证保护，不是免鉴权私有接口。

账号接口：`POST /api/v1/agent/identity/register`、`POST /api/v1/agent/identity/sign-in`、`GET /api/v1/agent/identity/session`、`POST /api/v1/agent/identity/sign-out`。私有记录接口 `GET/POST /api/v1/agent/records/continuity?key=...` 和 `.../growth?key=...` 使用 revision CAS，不会在出错时回退到旧的无归属库。

可选 Casdoor 通过服务端私有 OIDC 配置启用：`GET .../identity/providers` 查询可用性，`POST .../identity/oidc/start` 发起登录/显式关联，`GET .../identity/oidc/callback` 完成。外部 `issuer + sub` 映射既有稳定 owner，关联要求当前本机密码与活跃原会话，不按邮箱/手机号自动合并。`GET .../recovery` 及其文档/完整会话子路径只读列出本 owner 的不可变恢复档案，没有 HTTP 认领或迁移写入口。详情见 [Casdoor 与旧资料恢复](../../docs/casdoor.md)。

账号根目录默认是运行数据目录（未配置时为 checkpoint 所在目录）下的 `accounts-v1`，每位用户再分配 `owners/<server-uuid>`。身份密码使用带独立盐的 scrypt；会话仅存摘要，8 小时绝对到期、1 小时未使用到期。POSIX 上私有目录/文件使用 0700/0600。旧 checkpoints、runs、源码授权和 ChatGPT 凭据不自动认领，不能通过源码取证读取账号私有目录。

业务数据库、岗位地图坐标和长期用户事实不由 Run Manager 直接写入；写入应由后续确定性工具在审批、证据和 CAS 校验后执行。

## 当前安全边界

账号模式默认拒绝启动通用 `/runs` 或继承系统凭据的原生项目理解 CLI（403 `runtime_identity_isolation_required`）；仅改变工作目录或 thread ID 不构成隔离。Registry 仍可显示安装信息，但会注明不能执行。受控取证可搭配本人明确配置的模型或本人 ChatGPT 授权，不会改走付费 API。

底层单用户嵌入/隔离测试可由可信代码显式设置 `trustedSingleUserRuntimeExecution: true`，HTTP 和 CLI 不提供开启参数；它不应被当作多用户修复办法。该底层执行器默认 `--sandbox auto` 只启用独立运行目录和 `shell:false` 参数数组，并在 RunRecord/access.json 中标记为 `process`；这不是 OS 读写权限边界。其显式 OS 沙箱使用 macOS `sandbox-exec` 与 Linux `bwrap`/`bubblewrap`，提供者不可用时 `required` 会直接失败，不会静默降级。它也不自动解决多账号凭据隔离。

当前文件事务按进程串行，仅支持单实例 Host 拥有一个账号目录，不支持多进程共享写入；没有本机密码重置、云端账号数据同步、端到端加密或公共网络部署验收。会话 Cookie 使用 SameSite=Strict/HttpOnly，OIDC 流程 Cookie 为 SameSite=Lax/HttpOnly；通过受信任 HTTPS origin 时加 Secure。Casdoor OIDC 已可选接入，公网产品仍需 TLS、可信代理和数据库隔离专项验收，不应暴露开发 token。

Career Orchestrator 当前提供稳定的阶段、Artifact 和审批状态机，尚未声称已经完成各招聘平台的实时抓取、公司调研或地图写入。具体 Worker 需要通过 Registry 选择可用 CLI，并在确定性工具网关中接入真实来源证据。
