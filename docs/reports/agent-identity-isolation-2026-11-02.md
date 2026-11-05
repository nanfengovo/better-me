# BetterMe 账号与 Agent 记忆隔离验收

日期：2026-11-02。工作树：`better-me-agent-os`，分支 `agent-os`。本批仅落实已授权的不同用户记忆隔离，不提交、不推送、不更新 Docker，不触碰业务项目或真实简历/岗位库。

## 归属与授权

- BetterMe 本机身份与 ChatGPT/模型账号分开。服务端生成 UUID，盐化 scrypt 密码派生；随机会话令牌只放 HttpOnly/SameSite=Strict Cookie，文件内只存摘要。有效期 8 小时，闲置 1 小时；登录限速和并发派生限制独立于模型。
- 除健康和身份引导外，Agent 私有路由都先核对服务端会话。`X-BetterMe-Owner` 仅防止同源多窗口竞争，不是凭据；工作区 ID、项目 ID、thread ID 和请求中的 ownerId 均不能授权访问其他人。
- 每位 owner 的项目理解/贡献、ChatGPT 凭据、Run、共识/对话/成长记录分目录。LangGraph thread 包含 owner 和 workflow kind 的散列；前端长期仓库捕获身份代次，私有记录使用 CAS。私有文件原子替换，POSIX 0700/0600，拒绝非普通文件/不安全权限/硬链接等。
- 浏览器简历、草稿、版本库、模型配置、项目对话输入按 owner 命名，不回退读取无归属旧 key。自动保存设置不改变、不强制开启，不把“保护草稿”冒充正式保存。
- 换号重新建立 JS 页面上下文，旧页锁定保留挂载草稿；旧 fetch body/流式事件被身份代次拒绝。退出先等待已接受的本地 Agent/成长写入，撤销服务端会话并关闭原账号的 SSE；已有项目理解任务仍归原账号，不自动重发或转给新账号。
- 源码 Broker 不允许读取 BetterMe 自己的私有账号/记忆目录，直接授权、父目录递归、搜索、缓存路径、单文件入口均受检查。无账号级进程/凭据隔离的 CLI 在默认账号模式拒绝执行（含原生理解，避免继承共享环境中的 API Key），不以换目录或白名单冒充多用户沙箱。

## 隔离浏览器实际验证

真实 Chrome、正常 `main.tsx → IdentityGate → App`，独立地址 `http://identity-regression.localhost:5323/`，隔离 Host 5329，只有临时数据目录。没有连接岗位服务，没有读取真实业务源码、真实简历或个人模型授权；项目理解由确定性测试 reasoner 回答，**不代表真实模型质量或真实付费权限已验收**。

1. 从界面创建合成 Alice/Bob 账号；同一默认工作区和示例项目 ID，不用手工更换 ID 来规避碰撞。
2. Alice 编辑合成 `ALICE-ONLY` 事实、确认统一目标，运行一轮项目理解，逐项确认共识入库。
3. 刷新正常编辑器：Alice 草稿、目标、共识恢复。
4. 退出后创建 Bob：没有 Alice 的共识和目标；模型配置也未继承 Alice 的测试配置。
5. Bob 保存独立 `BOB-ONLY` 目标；切回 Alice 后只恢复 Alice 原草稿、目标和共识。
6. 两个隔离标签页：旧 Bob 窗口编辑新草稿，另一窗口退出并登录 Alice。旧窗口显示“身份已过期或在另一窗口切换”，编辑器隐藏/不可操作；重新登录 Bob 后其草稿恢复，目标保持 Bob 自己的值。
7. 在隔离 origin 关闭自动保存并刷新：仍显示“自动保存关”，草稿继续被保护。没有操作正常 5173 页面的保存偏好。

截图位于忽略的验收输出目录 `output/identity-isolation-20261102/`：`alice-restored.jpg`、`bob-empty-consensus.jpg`、`old-window-locked.jpg`。两张隔离测试标签及自建 5323/5329 服务已关闭，监听确认消失；临时账号不用于用户日常数据。

## 自动化验证

- `identity-http.test.ts`：未登录拒绝、A/B 同 ID 隔离、伪造 owner、Origin 拒绝、跨账号会话/授权/模型目录/Run/thread 拒绝、CAS 冲突、退出撤销、凭据不明文、重建服务保留登录、闲置过期与限速。
- `identity-boundary.test.ts`：浏览器存储与版本库隔离、无归属旧记录不认领、捕获写入范围、迟到 headers/body/SSE 拒绝、备份跨账号拒绝、授权失效和错误不回退付费请求。
- 扩展 `understanding-evidence.test.ts` 验证私有账号文件不能从授权目录透出；原有 Host HTTP 测试改为真实合成身份注册，不使用认证旁路。
- 原生协议的旧单用户兼容性测试保留全部断言，并在其封闭夹具显式标注可信单用户嵌入；默认账号模式另测 403，未删除或跳过测试。

最终收尾结果：

- `pnpm test`：3618 项，3608 通过、0 失败、0 取消、10 项既有环境跳过；未新增跳过、删除测试或降低门禁。
- `pnpm typecheck`：13/13 任务通过。
- `pnpm build`：8/8 任务通过；保留既有 Atlas 浏览器内置模块与大 chunk 提示，不混入无关性能改造。
- `pnpm lint`：通过（零警告门禁）；`pnpm memory:check`、`git diff --check` 通过。
- 32 个既有岗位采集/报告脏文件与开工指纹逐一一致；暂存区为空。HEAD 仍为 `1668ecfce4bb57f4180d3c47f8bb2d5f62777732`，本批未提交或推送、没有远端新 CI 或 Docker 发布结果。

## 明确未做与升级边界

- **不自动迁移旧资料**：旧的无归属简历/Agent 记录/ChatGPT 授权仍在原位，不能把它们猜给第一个注册账号。新账号空白不是旧资料删除；后续需明确归属、预览和确认的迁移流程。
- 账号是本机单实例应用层边界，不是 OS 用户沙箱；共享浏览器的开发者工具、扩展和持有本机文件权限的人不受此机制防御。浏览器命名空间不是加密。跨浏览器简历同步、云端身份、密码找回、公网 SaaS、多进程共享文件写入尚未实现或验收。
- 岗位后台索引仍是安装级；本批未做岗位服务多租户改造，也未运行真实采集或清理旧数据库。
- 没有主动重启正常 5173 与 5178/5179 服务、刷新现有个人页面或操作真实业务服务。代码变更可能触发开发工具的自动重载；收尾三个端口均仍在监听。本轮没有用真实页面完成迁移、导入或保存。

## 实现参考

密码派生使用 [Node.js scrypt API](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。会话令牌、过期与 Cookie 约束参考 [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)，每次私有请求进行授权与默认拒绝参考 [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)。这些是设计参考，不等于独立安全审计或零风险保证。
