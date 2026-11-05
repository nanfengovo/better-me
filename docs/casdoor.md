# 自部署 Casdoor 与旧资料恢复

BetterMe 将外部登录接到既有账号隔离层：Casdoor 证明身份，Host 将经过验证的 `issuer + sub` 映射为稳定的内部 owner。微信、QQ、GitHub、Google 等渠道由 Casdoor 管理；模型账号、API Key、昵称、邮箱或手机号都不能代替资源归属。设计与安全边界见 [社交登录设计](planning/social-login-2026-11-04.md)，本批证据见 [社交登录实施报告](reports/social-login-2026-11-04.md)。

## 已有本机账号：先关联，再使用统一登录

1. 用已有 BetterMe 本机账号进入工作台，核对「工作台设置」中的当前身份。
2. 展开「登录方式与账号关联」，重新输入当前本机账号密码，选择已开通的平台，再前往官方授权。也可使用「关联统一账号」。
3. 返回原工作台。关联保留原 owner、本机登录、简历和全部历史；随后可退出并使用登录页的对应平台按钮，或「其他登录方式」中的统一账号登录。

直接以未关联的 Casdoor 身份登录会创建独立空白空间，不会按同名、同邮箱或同手机号接管既有资料。一个外部身份已经归属其他 owner 时拒绝绑定；退出、换号或重新发起流程会使旧回调失效。原本机账号没有密码重置入口，不能用外部同名账号绕过密码核对。

已关联后可用「管理已绑定的第三方账号」重新验证原统一身份并进入 Casdoor 账号中心；外部账号不必设置本机密码才能管理。选择了未关联主体会被拒绝，不会切换 BetterMe 账号。上游添加/解除平台绑定和最后一种登录方式保护仍需本人核对，不直接删除 BetterMe 的 owner 映射。

## 本机启动

根目录 `pnpm auth:casdoor` 提供 `init [verified-release.tar.gz]`、`start` 和 `status`。原生安装器当前仅支持 macOS ARM64，固定 Casdoor v4.25.0 并校验官方 release 的 SHA256；其他系统按 [Casdoor 官方容器部署说明](https://casdoor.ai/docs/deployment/docker/)另行部署，不能直接使用该二进制。

新环境只初始化一次：

```sh
pnpm auth:casdoor init
pnpm auth:casdoor start
```

另一个终端运行正常 `pnpm dev`。已有安装只运行 `start` / `status`；`init` 会拒绝替换已有安装和 OIDC 配置。启动不会自动写入系统自启动项，也不会启动 Docker、接管已有端口或停止未知进程。

当前本机约定：

| 项目 | 位置 / 值 |
| --- | --- |
| Casdoor issuer | `http://127.0.0.1:18000`，仅 loopback |
| BetterMe 页面与回调 origin | `http://localhost:5173`，不与 `127.0.0.1:5173` 混用 |
| 回调路径 | `/api/v1/agent/identity/oidc/callback` |
| Casdoor 组织 / 应用 | `betterme` / `app-betterme` |
| Casdoor 私有根目录 | `~/Library/Application Support/BetterMe/casdoor/v4.25.0` |
| 首次管理员信息 | 上述目录的 `bootstrap-private.json`，仅在本机查看 |
| Host OIDC 配置 | `~/Library/Application Support/BetterMe/agent/oidc.json`，或 `BETTERME_OIDC_CONFIG` 指定路径 |

私有目录 0700、敏感文件 0600，随机管理员密码、客户端密钥与独立 RS256 证书不写入仓库或日志。管理员进入 Casdoor 根页面，选择 `built-in` 组织；业务注册属于 `betterme`，不是管理员注册。重启使用 `initDataNewOnly=true`，保留已新增用户、渠道和配置；SQLite 使用 WAL 与 busy timeout，避免并发登录写锁。未使用的 RADIUS 监听已禁用。

Host 在启动时读取配置。配置只由服务端保存，结构为 `issuer`、`clientId`、`clientSecret`、`callbackUrl`、`allowLoopbackHttp`；客户端密钥不出现在 Web 构建环境变量中。公开网络必须使用可信 HTTPS、固定域名和精确回调；`allowLoopbackHttp` 仅用于本机，不能使外部 HTTP 地址可用。反向代理、信任边界、账号数据库与部署运维仍须专项验收。

## 开通社交平台

本机初始安装只启用 Casdoor 用户名密码注册/登录。BetterMe 固定展示微信、QQ、GitHub、Google；Microsoft、GitLab、Discord 仅在当前应用实际关联了对应 provider 时展示。未配置、停用、环境不匹配或服务离线时显示原因并禁用；「已配置」不是平台真实授权验收成功。操作只在管理员端完成，不需要向 BetterMe Web 填平台密钥。固定版本类型、最小权限、平台条件与开源比较见 [平台调研](research/social-login-platforms-2026-11-04.md)，本机真实配置停点见 [扩展与配置报告](reports/social-login-platform-expansion-2026-11-04.md)。

1. 准备已开通的平台开发者应用，使用符合平台要求的公开 HTTPS 域名/回调。各平台要求以其官方控制台为准，不能假设本机 loopback 都受支持。
2. 在 Casdoor 创建 OAuth provider，并关联到 `app-betterme`。类型按下表精确填写；配置平台 Client ID/Secret，启用 `Can sign in`，按实际注册策略决定 `Can sign up`。
3. **所有启用 OAuth provider 的 Binding rule 显式设为 `[]`（空列表）**。包括其他非快捷渠道；不要保留默认、null、Email、Phone 或 Username 自动绑定。BetterMe 检测到任一启用源不满足时，关闭快捷及统一入口，先修配置。
4. 保存后在 BetterMe 点击「重新检查登录方式」。Host 重新核对当前应用、回调、开关与必要字段；每次发起登录也会重读，不凭旧按钮状态授权。
5. 逐平台完成下方真实验收后，再对用户宣布该渠道可用。

| 平台 | 准备与注意事项 |
| --- | --- |
| 微信 | [Casdoor 微信说明](https://casdoor.ai/docs/provider/oauth/Wechat/)：普通浏览器 PC 扫码的 Web 与微信内 Mobile 不是同一配置。按应用类型与审核要求配置，Mobile 使用第二组 ID/Secret；BetterMe 按 MicroMessenger 上下文选择，缺对应版本时禁用并提示。 |
| QQ | [Casdoor QQ 说明](https://casdoor.ai/docs/provider/oauth/Tencent/)：QQ 互联开发者应用与适合该应用的回调域名。 |
| GitHub | [GitHub 创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)：按实际部署填写 App URL 和回调，不额外索取仓库权限作为登录条件。 |
| Google | [Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)：Web 客户端、授权同意页、测试/发布状态与精确授权回调。Google 的 localhost 例外不代表其他平台也支持本机回调。 |

| 入口 | Casdoor v4.25.0 exact type | 本轮登录所需 scopes（配置字段为字符串） |
| --- | --- | --- |
| 微信 PC | `WeChat` | `snsapi_login`；微信内 Mobile 是另一配置 |
| QQ | `QQ` | `get_user_info` |
| GitHub | `GitHub` | `read:user+user:email`；没有仓库权限 |
| Google | `Google` | `profile+email`；不添加 Gmail、Drive 或电话权限 |
| Microsoft | `AzureAD`，不是 `Microsoft` | `user.read`；账号类型/tenant 须匹配 |
| GitLab | `GitLab` | `read_user`；不需要仓库权限 |
| Discord | `Discord` | `identify`；确有邮箱用途才另加 `email` |

Casdoor 管理 API 的配置字段为复数 `scopes`（SQLite 同名），不是 `scope`；未知字段可能被忽略。新增 provider 先保持暂停，保存后读回实际 `scopes`，再核对真实跳转与同意页，不能只根据提交体断言最低权限已经生效。

本机 GitHub/Google 的平台回调准备为 `http://127.0.0.1:18000/callback`。QQ 官方文档要求外网可访问域名，回调不能使用 localhost 或端口号，并有网站/备案审核要求；国际域名另有申请流程。微信网站应用仍需本人拥有的开放平台 AppID/Secret、满足规则的授权回调域及审核。平台主体、域名、费用或资质不能用共享 AppID、陌生扫码中转、伪造二维码或换库代替。准确出处和微信本次未能核实的细则见平台调研。

Microsoft 当前 loopback IP 的 HTTP URI 需要按官方 manifest 方式配置；Discord 带端口 Web 回调仍须本人控制台验证。Google 固定版本 adapter 有额外 People API 电话字段调用的兼容性风险，需真实授权观察；为绕过它扩大电话 scope 不属于本轮批准权限。

两层回调不要混用：

- **平台 → Casdoor**：平台控制台登记的回调为实际 Casdoor origin 下的 `/callback`，例如 `https://identity.example.com/callback`。
- **Casdoor → BetterMe**：`app-betterme` 允许的回调和 Host `callbackUrl` 为 `https://betterme.example.com/api/v1/agent/identity/oidc/callback`；本机约定仍为 `http://localhost:5173/api/v1/agent/identity/oidc/callback`。

`provider_hint` 只是上游入口提示，最终 JWT 证明 Casdoor 主体，不是某个具体社交平台的加密断言。必须信任并保护上游管理员与账号恢复策略，不能用联系信息自动合并来“找回”BetterMe 旧资料。

邮箱/手机仍在统一登录页由 Casdoor 管理：分别配置 [邮件 provider](https://casdoor.ai/docs/category/email/) 或 [短信 provider](https://casdoor.ai/docs/category/sms/)、发件地址/签名模板及验证注册策略。本批没有实现短信/邮件发送或供应商验收。

渠道密钥直接配置到本机 Casdoor 管理端或受保护的部署 secret，不粘贴到聊天，不交给 Agent 模型。每个渠道实际完成注册、验证码、回调、关联和再次登录后才标记验收通过。Casdoor 同一用户的多个登录方式返回同一内部主体；不同主体即使联系信息相同也不会由 BetterMe 自动合并。

真实渠道验收清单（每个启用平台分别执行，使用明确授权的测试账号）：

- 新外部身份首次授权进入独立空间；不读取或认领旧 owner 的简历、Agent 或会话。
- 原本机测试账号先核对密码关联，再退出用该平台登录，owner 与原测试记录保持一致。
- 同一统一主体绑定第二个平台后，经第二个平台登录仍是原 owner；不把两个未关联主体按邮箱合并。
- 取消/拒绝授权、过期、回调重放、停用和服务离线有明确反馈；旧会话/换号后的迟到回调不能生效。
- 管理重认证选错主体被拒绝，正确主体进入账号中心；核对平台解绑与最后登录方式保护/找回策略。
- 浏览器没有平台 Secret/token，日志没有令牌/真实资料；本次 scope 未额外索取 GitHub 仓库或其他业务权限。

### 本机密钥与管理员接口

平台私有配置放在仓库外 `~/Library/Application Support/BetterMe/agent/social-login/`：目录 0700，私有 JSON/备份 0600，核对不是符号链接。当前 agent 父目录不能被假定为 0700，应检查实际目标子目录。平台 secret 不进前端环境、Git、聊天或可打印的诊断。

Casdoor 的公开/默认脱敏管理响应不适合整对象保存：其中 `redirectUris`、`grantTypes` 可能为空、敏感字段可能为 `***`。变更应用应先用受保护的本机管理员会话读取、核对当前 OIDC client 与精确回调、保存私有备份，然后仅增改目标 provider/binding 并读回非敏感状态。不要把 HTTP 200 当作取得管理员权限，也不要把脱敏值写回。

秘密比较使用只返回布尔值的检查和固定错误码；`assert.equal(secretA, secretB)` 可能将 actual/expected 打印到异常中。出现任何诊断暴露时暂停该 provider 的 `Can sign in`，经本人当次确认生成替换 secret、更新本机 provider、撤销旧 secret 后再启用。日志核对只输出命中布尔值，不输出匹配行。

凭据页的按钮 accessible name 也可能包含完整 secret，即使画面显示为掩码；仅去掉 `Value:` 不足以脱敏。界面读取持留在本机、输出仅用控件编号/角色与固定安全标签白名单，未知名称省略。一次性密钥模态不截图；安全捕获后关闭/隐藏再保存掩码结果证据。最新真实配置、GitHub 已完成轮换及 Google 待办见 [真实配置续接](reports/social-login-live-setup-2026-11-04.md)。

## 恢复档案：追加，不替换

已确认归属的旧资料以不可变档案保存在目标 owner 私有目录。工作台设置的「恢复档案」提供所有已收录文档表示和完整项目会话；原当前简历及其默认草稿/历史不被替换。

- `?recovery=<archive>.<document>` 打开独立工作副本：owner 与档案共同隔离 localStorage/IndexedDB。首次打开用事务仅在不存在草稿时创建，之后保留用户自己的修改。原归档一直只读。
- `?recoverySession=<archive>.<session>` 只读展示原消息、选项、共识和错误记录，不运行任务。
- 历史 Agent 消息可查看；旧记忆不自动共享、旧文件授权撤销、旧任务不自动重跑。原始 Run/checkpoint 以原字节归档，不等于它们已经逐线程确权或成为可执行任务。
- 原始备份、选择性导出清单及迁移回执位于 BetterMe 数据目录的私有 `recovery` 子目录。模型 Key、Cookie、本机密码摘要和 ChatGPT 授权不随迁移复制。

没有公开的「认领全部旧数据」HTTP 接口。其他迁移需明确源、目标、归属确认，再做目标快照、结构/指纹核对、追加安装与读回回执。同一计划重试幂等，冲突拒绝；不要手动将旧 JSON 覆盖到活动 owner 文件。

## 验证与备份

常规回归为根目录 `pnpm test`。真实协议验收为：

```sh
pnpm --filter @better-me/agent-host test:casdoor:live
```

后者显式创建两个随机合成 Casdoor 账号，并使用临时 Host 目录、内存 checkpoint 和注入推理器；会留下合成账号与私有临时测试目录，不自动清理或删除账号。它验证真实授权码、PKCE、签名 JWT、稳定 owner、并发任务、退出后迟到结果及跨账号拒绝；不调用模型、不读取真实简历，也不验证 QQ/微信/邮件/短信供应商。

本批另有不碰已安装账号库的兼容性检查：

```sh
pnpm exec tsx apps/agent-host/scripts/verify-social-casdoor.ts /absolute/path/to/casdoor /absolute/path/to/casdoor/web
```

仅复用已校验安装的可执行文件与公开 Web 静态资源，新建临时 SQLite/配置/证书与动态端口，七个 provider 使用虚构凭据；检查真实 v4.25.0 公开目录、`provider_hint` 和授权入口，随后清理自建进程及目录。不会访问真实社交平台，不能替代上面的逐渠道授权。

UI 可选验收夹具 `pnpm exec tsx apps/web/tests/social-login-preview.ts` 只使用自建 5383/5389 与签名虚构身份源，必须先确认端口空闲；不用正常 5173/5179 或已有私有数据。退出脚本清理自建临时目录。

备份应覆盖 Host 的账号目录和恢复档案、浏览器原始草稿/版本、Casdoor 配置/证书及数据库。活动 SQLite 用一致性 `.backup` 或停服备份，不只复制 `.db` 而遗漏 WAL。私有备份按敏感用户数据保护；回退到原工作空间不需要删除任何档案。不要为排查空白账号而清空浏览器、重新导入 PDF 或重置简历。

本次实施与验收证据见 [确认恢复与 Casdoor 报告](reports/confirmed-recovery-casdoor-2026-11-03.md)。本机单实例隔离不等于 OS 沙箱、端到端加密、跨浏览器自动同步或公网 SaaS；岗位索引仍是安装级。
