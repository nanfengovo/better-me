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

所有接口都需要 `Authorization: Bearer <token>`。业务数据库、岗位地图坐标和长期用户事实不由 Run Manager 直接写入；写入应由后续确定性工具在审批、证据和 CAS 校验后执行。

## 当前安全边界

默认 `--sandbox auto` 只启用独立运行目录和 `shell:false` 参数数组，并在 RunRecord/access.json 中标记为 `process`；这不是 OS 读写权限边界。需要显式开启 OS 沙箱时使用 `--sandbox required`，或设置 `BETTER_ME_ENABLE_OS_SANDBOX=1` 配合 `--sandbox auto`。macOS 使用 `sandbox-exec`，Linux 使用 `bwrap`/`bubblewrap`；提供者不可用时 `required` 会直接失败，不会静默降级。`allowedReadPaths` 仍会校验和写入清单，只有 `os-sandbox` 运行才会把这些路径交给 OS 策略。

Career Orchestrator 当前提供稳定的阶段、Artifact 和审批状态机，尚未声称已经完成各招聘平台的实时抓取、公司调研或地图写入。具体 Worker 需要通过 Registry 选择可用 CLI，并在确定性工具网关中接入真实来源证据。
