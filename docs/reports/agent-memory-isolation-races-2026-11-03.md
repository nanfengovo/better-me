# 账号记忆隔离：切号、并发与迟到结果专项回归

日期：2026-11-03。工作区：`better-me-agent-os`，现有分支 `agent-os`，起始 HEAD `1668ecfce4bb57f4180d3c47f8bb2d5f62777732`。本批是既有账号隔离实现的竞态补强，未提交、推送或更新 Docker。

## 结论与边界

延续服务端已认证 owner 的数据归属边界，补上浏览器传输、流式分发、Agent 生命周期和失效账号恢复入口的缺口。账号身份与模型提供商凭据继续分离；没有通过增加角色或权限标签代替数据归属检查。

浏览器任务固定绑定“账号 + 身份代次”，A→B→A 也不能恢复旧任务的权限。服务端已经接受的任务仍属于原账号：退出后允许原账号的后台任务完成，但不会转交新账号、自动确认共识或在浏览器重发。两种迟到结果处理分别验证，不把“页面丢弃旧结果”等同于“服务器删除旧任务”。

本批所有账号、目标、项目原文、对话和模型返回均为虚构。未读取、导入、保存、迁移或清理真实简历、已有账号记录、岗位记录或业务项目；未改变用户自动保存、模型选择或付费回退规则。无归属旧资料继续留在原位，未自动归给任何账号。

## 已复现并修复的缺口

| 场景 | 修复前可复现问题 | 本批修复 |
| --- | --- | --- |
| 账号已锁定，但组件仍挂载 | 忽略 AbortSignal 的传输仍能发起新的私有请求 | `ownedFetch` 在发出请求前校验身份代次与失效信号 |
| Alice 的拒绝响应迟到 | 读取 401/409 错误 body 期间切到 Bob，旧错误可锁住 Bob | 解码错误 body 后再次校验原身份，过期拒绝不再作用于新账号 |
| 克隆响应后延迟消费 | `Response.clone().json()` 可绕开原响应的迟到 body 检查 | clone 递归保留身份检查，异步 body 消费前后均核验 |
| 一批 SSE 含多个事件 | 首个回调同步切号后，同批后续事件仍能继续分发 | 每帧分发前后检查身份，结束或拒绝时取消 reader |
| 旧 Agent / A→B→A | 单凭账号 ID 或协作授权版本不能识别旧任务代次；初始记忆加载、上下文核对也可能迟到 | Agent 实例捕获不可复用的身份租约；加载、变更、flush、共享上下文、模型前后和历史复用均核验，任务信号联动账号失效 |
| 新注册账号在另一窗口换号后恢复 | 旧窗口已锁定，但仍是注册表单，无法直接登录原账号 | 注册成功及身份失效时退出注册模式；保持旧 App 隐藏、inert、挂载内容和原存储归属 |

上述问题使用失败断言或实际浏览器复现后修复；额外覆盖延迟初始加载及忽略取消的共识读取，确认身份切换后不会再提交模型调用。

## 验证矩阵

### 实际 HTTP 与并发

测试通过真实 HTTP、真实临时账号注册/登录/退出、临时磁盘记录和默认 owner 路由执行，不只检查模拟仓储。

- Alice/Bob 同时使用相同 workspace、记录 key、职业工作流 thread、project key 和回合幂等 key，分别只读到本人内容。
- 每账号对同一 revision=0 记录并发 8 次写入：各 1 次成功、7 次 409；两个账号的赢家互不影响。成长与连续记忆的同名 key 不互相覆盖。
- 两个项目理解任务分别捕获自己的原文和提示词；Bob 先完成，Alice 退出后才返回。旧 Alice cookie 为 401，Bob 读取或确认 Alice 会话均为 404；Alice 的迟到完成不改变 Bob 整份已保存会话。
- Alice 重新登录只能恢复并确认自己的结果。临时无归属旧记录 sentinel 在测试前后逐字相同。

### 浏览器与组件

使用独立 Playwright 会话、`identity-regression.localhost:5323`、临时 Host 5329；所有外部请求在浏览器上下文中拦截，没有访问正常开发页或真实数据服务。

- Alice 保存虚构目标，刷新后仍是 Alice；退出后注册 Bob，目标为空；Bob 保存自己的目标后，另一窗口回到 Alice，只恢复 Alice 的目标。
- 另一窗口换号使旧 Bob 窗口锁定；旧目标的 DOM 仍挂载且内容不变，不能在新身份下操作。
- 新注册 Carol 后另一窗口换到 Bob：旧 Carol 窗口正确显示登录表单，没有显示名称/重复注册入口；重新登录 Carol 后恢复 Carol 的目标。
- 组件回归额外验证：未发送的虚构输入是同一个 DOM 节点、内容未丢、父容器 hidden/inert，旧身份租约失效且原 App 存储 scope 未改为 Bob。
- 已目视检查截图：`output/playwright/memory-isolation-fixed-reconnect-20261103.png`、`output/playwright/memory-isolation-reconnected-carol-20261103.png`。截图是本次虚构示例，不是真实简历。

验收期间预期出现 Google 字体被拦截的控制台错误；停临时服务时出现连接断开提示，不代表模型或账号服务线上故障。三个测试标签、专用浏览器会话和自建 5323/5329 已关闭，端口无监听；仅移除了本轮创建的临时合成账号目录，截图保留。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| 隔离、Agent 生命周期、账号 HTTP 和并发核心回归 | 36/36；连续 10 轮，共 360 次执行通过 |
| 全量 `pnpm test` | 最终重跑 3628 项：3618 通过、0 失败、0 cancelled、10 既有环境跳过；约 155 秒 |
| `pnpm typecheck` | 13/13 任务通过 |
| `pnpm build` | 8/8 任务通过；既有地图依赖/大 chunk 提示未在本批处理 |
| 四个隔离测试文件的额外严格 TypeScript 检查 | 通过 |
| `pnpm lint` | 通过，`--max-warnings 0` |
| `pnpm memory:check`、`git diff --check` | 通过 |

补充修复注册恢复入口后的一轮全量中，既有 `first-run-guide-theme.test.ts` 的 8 个颜色断言均通过，但父测试在收尾阶段达到原有 25 秒超时，记为 1 cancelled。未改该测试或门槛；单独重查 9/9 通过（约 2.5 秒），随后停止其他重任务，以原有 4 并发完整重跑，最终全部通过，主题测试 9/9、父测试约 1.4 秒。超时根因未确定，不能把重跑当作根因修复。

核心复核命令：

```sh
pnpm exec tsx --test apps/web/tests/identity-boundary.test.ts apps/web/tests/identity-agent-tasks.test.ts apps/web/tests/identity-gate.test.tsx apps/web/tests/betterme-agent-kernel.test.ts apps/agent-host/tests/identity-concurrency.test.ts apps/agent-host/tests/identity-http.test.ts
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm memory:check
git diff --check
```

## 变更位置与保护范围

- 生产代码：`apps/web/src/lib/identity.ts`、`apps/web/src/services/agent-client.ts`、`apps/web/src/lib/betterme-agent/kernel.ts`、`apps/web/src/components/IdentityGate.tsx`。
- 回归：补充 `apps/web/tests/identity-boundary.test.ts`，新增 `apps/web/tests/identity-agent-tasks.test.ts`、`apps/web/tests/identity-gate.test.tsx`、`apps/agent-host/tests/identity-concurrency.test.ts`，共新增 10 项测试。
- 保留既有身份隔离与岗位采集等未提交改动：启动时 85 个已有脏文件的 SHA-256 核对结果为 78 个完全未变，7 个仅为本批 4 个生产文件、既有隔离测试和 2 个交接文件；另新增 3 个测试与本报告，无文件消失。暂存区为空，分支/HEAD 未变，不改凭据或用户数据。
- 完整既有方案与后续限制参见 `docs/reports/agent-identity-isolation-2026-11-02.md`。本批仍是本机单实例应用层隔离，不是 OS 沙箱、浏览器数据加密或公网 SaaS 多租户验收。安装级岗位索引、密码找回、旧资料明确归属迁移、跨浏览器同步和原生 CLI 的账号级进程/凭据隔离未扩展；账号模式 CLI 保持默认拒绝。

后续如需上线 SaaS，另行验证部署鉴权、数据库/向量检索全链路 tenant 约束、多进程持久化并发和运维密钥边界；本次没有代替这些工作，也没有改动现有真实资料来做验收。
