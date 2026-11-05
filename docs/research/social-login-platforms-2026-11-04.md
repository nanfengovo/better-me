# 社交登录平台与成熟实现调研（2026-11-04）

## 结论与证据边界

建议继续使用现有 **Casdoor → OIDC → BetterMe owner**，新增至多三个国外入口：Microsoft（Casdoor 类型 `AzureAD`）、GitLab（`GitLab`）、Discord（`Discord`）。这是基于版本源码、平台文档和当前架构的**工程建议**，不是三个平台已真实接通的验收结论。QQ/微信的主要缺口是本人拥有、满足平台规则的开发者应用、域名、资质/审核及真实授权，不是再换一个 OAuth 库。

本文只研究公开官方资料；没有登录平台、创建应用、生成/读取密钥、读取真实简历、修改 Casdoor 数据库或执行平台授权。`open.weixin.qq.com` 在先前浏览器访问中受到显式安全阻拦，本研究不打开该门户、不借助其他浏览器/路由/原始网络绕过它。微信公开开发文档本次无法读取；不能把社区文章当作其最新规则的替代凭据。

证据标记：

- **已核实（文档/源码）**：当前可读的官方资料明确陈述，或固定版本源码可直接看到。
- **源码推断/工程建议**：根据实现得出、尚未由真实平台授权验证的兼容性判断。
- **未验收/待核对**：本人的开发者账号权限、应用状态、控制台能否接受精确 URI、真实回调/账号关联和平台当前资质细则。

版本边界：Casdoor `v4.25.0` 的 GitHub tag 本次解析为 commit `528a0213f01caf70b9f41009cbf7b2f67bdd67ec`；下文 Casdoor 链接固定该 tag。该版本依赖 Goth `v1.82.0`。官方平台在线文档及其他项目 `main` 是 2026-11-04 的读取快照，不等于 Casdoor 已升级到这些项目的当前实现。[Casdoor tag](https://api.github.com/repos/casdoor/casdoor/git/ref/tags/v4.25.0)、[固定版本依赖](https://github.com/casdoor/casdoor/blob/v4.25.0/go.mod#L57)

## 一、三个新增入口：exact type、端点与最低权限

| BetterMe 入口 | Casdoor v4.25.0 exact type | 授权端点 | Token / 用户资料端点 | 建议 identity scope |
| --- | --- | --- | --- | --- |
| `microsoft` | `AzureAD`，不是 `Microsoft` | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`；指定 tenant 可替换 `common` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`；`https://graph.microsoft.com/v1.0/me` | 当前 Casdoor 路径用 `user.read`（Microsoft 文档写作 `User.Read`），只为当前用户资料 |
| `gitlab` | `GitLab`，注意大写 L | `https://gitlab.com/oauth/authorize` | `https://gitlab.com/oauth/token`；`https://gitlab.com/api/v4/user` | `read_user`；不索取仓库权限 |
| `discord` | `Discord` | 固定版本使用 `https://discord.com/api/oauth2/authorize`；当前官方文档展示 `https://discord.com/oauth2/authorize` | `https://discord.com/api/oauth2/token`；`https://discord.com/api/users/@me` | `identify`；确实需要邮箱才加 `email` |

类型与分派由 [Casdoor idp/provider.go](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/provider.go#L65) 确认；Microsoft/Discord 使用 [Casdoor Goth 桥](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/goth.go#L120)，GitLab 使用 [原生 adapter](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/gitlab.go#L44)。Microsoft 的 token/Graph 端点见 [Goth azureadv2](https://github.com/markbates/goth/blob/v1.82.0/providers/azureadv2/azureadv2.go#L12)，Discord 端点见 [Goth discord](https://github.com/markbates/goth/blob/v1.82.0/providers/discord/discord.go#L14)。平台权限含义分别见 [Microsoft Graph Get user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0#permissions)、[GitLab OAuth provider](https://docs.gitlab.com/integration/oauth_provider/#view-all-authorized-applications)、[Discord OAuth2 scopes](https://docs.discord.com/developers/topics/oauth2#shared-resources-oauth2-scopes)。

### 不要用 Goth 的默认 scopes 误报 Casdoor 实际授权范围

**已核实（源码）**：v4.25.0 的浏览器授权 URL 由 `web/src/auth/Provider.ts` 构造，而不是直接使用 Goth `BeginAuth` 的默认值。其默认值为 AzureAD `user.read`、GitLab `read_user+profile`、Discord `identify%20email`；非空的 `provider.scopes` 可以覆盖。该构造器把这些字符串直接放入 URL，所以 `+` / `%20` 是 scope 的 URL 分隔表示，不应把 `read_user+profile` 误判为一个不合法的单项权限。[固定版本授权构造器](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/auth/Provider.ts#L54)、[scopes 覆盖与 URI 构造](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/auth/Provider.ts#L414)

**工程建议**：管理员显式配置 GitLab 为 `read_user`、Discord 为 `identify`，并在真实跳转的 scope 参数和平台同意页再次核对。当前既有资料获取不需要 GitLab `api` / `read_repository`、Discord `guilds` / `connections` / `bot` / 消息权限，也不需要 Microsoft Mail/Files/Directory 业务权限。只请求 `identify` 时邮箱为空是正常情况；不能为了按邮箱自动合并账号而扩大权限。

Microsoft 还存在 exact type `MicrosoftOnline`，但本轮不把它映射成快捷入口：两种 adapter 都走微软 v2 端点；`AzureAD` 的 Casdoor 分支明确支持 tenant 参数，前端默认 `user.read` 与后端 Graph `/me` 一致；`MicrosoftOnline` 的前端默认是 `openid profile email`，而其 Goth 用户资料读取仍请求 Graph `/me`。因此优先 `AzureAD` 是**源码推断的兼容性选择**，不是宣称另一类型不受支持。[两种 Casdoor 分支](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/goth.go)、[MicrosoftOnline adapter](https://github.com/markbates/goth/blob/v1.82.0/providers/microsoftonline/microsoftonline.go)

### Microsoft：本机回调和账号/审核限制

- **已核实（文档）**：Microsoft 允许开发期 HTTP localhost 回调。其文档建议 IP literal `127.0.0.1`，但在门户 Redirect URI 文本框内不能直接添加 HTTP `127.0.0.1`；文档指定须使用 application manifest 的 `replyUrlsWithType`。因此当前 `http://127.0.0.1:18000/callback` 不是“随便在文本框填就一定成功”。localhost 的端口匹配另有例外，不应套用到所有主机。[Microsoft redirect URI 限制](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions)
- **工程建议**：Casdoor 是服务端 confidential client，上游应注册 **Web** 平台回调；不要因为 BetterMe 是 React 就把 Casdoor 的回调错误注册成 SPA。不能为规避控制台限制，未经重新配置/验证便改变现有 issuer origin 或混用 localhost/127.0.0.1。
- **已核实（文档）**：需有能注册应用的 Entra 账号/tenant 权限；若要同时支持个人微软账号和工作/学校账号，应选对应的 supported account types，与 Casdoor `common` 或指定 tenant 策略一致。[注册应用官方说明](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- **已核实（文档）**：publisher verification 和组织 user-consent policy 是另一层控制。不能保证所有企业租户仅凭 Client ID/Secret 就可登录；管理员可能要求同意。只读基本资料并不等于所有用户免审。[Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)
- **未验收**：本人是否具备注册权限、精确回调是否被该注册接受，以及个人/组织测试账号能否通过。

### GitLab：最直接的本机候选

**已核实（文档）**：GitLab 提供 user-owned OAuth 应用，创建时填写名称、Redirect URI 和 scopes，生成 Application ID/Secret；官方明确可使用 non-SSL URI，但推荐 SSL。原生 Casdoor adapter 固定指向 `gitlab.com`，不能据此宣称已支持任意自部署 GitLab。`read_user` 授予 `/user` 资料读取；OIDC `/oauth/userinfo` 是另一条需要 `openid` 的路径。[GitLab 创建/配置 OAuth 应用](https://docs.gitlab.com/integration/oauth_provider/)、[Casdoor GitLab 固定端点](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/gitlab.go)

**源码推断/工程建议**：当前 loopback `http://127.0.0.1:18000/callback` 有文档支持的 HTTP 条件，适合作开发注册候选；仍需在本人控制台登记、检查精确匹配并真实授权。官方 user-owned 流程没有列出网站上线/备案审核步骤，但这不能被扩大为账号无风控、所有环境免审的承诺。仅做登录，不需要 GitLab 代码读取或管理权限。

### Discord：基础身份简单，控制台精确回调仍待验收

**已核实（文档）**：OAuth2 首先注册 developer application 并取得 Client ID/Secret；`identify` 可调用 `/users/@me` 而不返回 email。只有部分高级 scopes 需要额外批准；本轮不请求它们。Discord 当前文档与 v4.25.0 使用的授权 URL 形式不同，不能因为文档更新就自行改写现有 Casdoor adapter。[Discord OAuth2 官方文档及官方源码](https://docs.discord.com/developers/topics/oauth2)、[文档仓库源文件](https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx)

**已核实但适用范围有限**：官方 Social SDK 文档明确演示 `http://127.0.0.1/callback` 的桌面 loopback 回调。它说明平台存在本机开发机制，但**不直接证明** Casdoor 这个 Web/confidential app 的 `http://127.0.0.1:18000/callback` 已被本人控制台接受，也不授权把 Casdoor 切成 public client。精确带端口 URI 的接受情况与真实授权在本轮仍为**未验收**。[Discord 官方 SDK 回调说明](https://discord.com/developers/docs/slayer-sdk/authentication.html)

## 二、保留 GitHub / Google：minimum identity scope 与后端需求

| 平台 | Casdoor v4.25.0 前端默认 scope | 后端需要的资料 | 本轮建议 |
| --- | --- | --- | --- |
| GitHub | `user:email+read:user` | `/user` 的稳定 `id`、login、name、avatar；公开 email 为空时再请求 `/user/emails`，选择已验证地址 | 保留 `read:user user:email`；不加 `repo`、`read:org` 等权限 |
| Google | `profile+email` | `/oauth2/v2/userinfo` 的 id、email、name、picture；后端对 email 为空直接报错 | 保留 `profile email`；不用 Gmail、Drive、联系人/手机号权限 |

**已核实（源码）**：以上默认 scope 来自 [Provider.ts](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/auth/Provider.ts#L54)，资料需求来自 [GitHub adapter](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/github.go#L194) 和 [Google adapter](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/google.go#L193)。GitHub 官方区分只读 profile / email 与能访问仓库的 `repo`；“最低到不能再低的任意实现”不等于“当前 adapter 兼容范围”，本轮不擅自删除其邮箱读取。[GitHub scope 官方定义](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)、[Google scope 官方列表](https://developers.google.com/identity/protocols/oauth2/scopes)

**需特别记录的源码风险**：v4.25.0 Google OAuth 普通路径在获取 email 后，无条件请求 People API `people/me?personFields=phoneNumbers`；前端只有开启相应扩展开关才附加 phone scope。不要为使该附带调用成功而悄悄扩大 consent；不要据“后端有电话字段”宣称用户同意提供电话。无电话权限时真实响应如何影响登录、是否存在网络/解析错误，需要真实授权测试；本研究不补手机号权限、不修改 adapter。[Google 资料读取实现](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/google.go#L226)、[前端条件 scope](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/auth/Provider.ts#L438)

## 三、QQ / 微信：真实开通缺口不能由换库解决

### QQ 互联：官方限制已经足以排除当前 loopback 作为正式回调

**已核实（官方文档）**：

1. 需要注册开发者、提交个人/公司基本资料并审核；再创建对应网站应用，取得该应用自己的 appid/appkey。创建文档也要求提交应用审核，不是拿到一段字符串就自动成为正式上线应用。[成为开发者](https://wiki.connect.qq.com/成为开发者/)、[创建应用](https://wiki.connect.qq.com/__trashed-2/)
2. QQ 回调要填接收 code 的完整 URL；域名和 path 必须与注册的保持一致，不能只填任意根域；可以用分号分隔多条。官方明确回调不能用**端口号或 localhost**，必须是外网可访问域名。因此 `http://127.0.0.1:18000/callback` / `http://localhost:18000/callback` 不满足该规则。[回调地址相关问题，第 2、3 节](https://wiki.connect.qq.com/回调地址常见问题及修改方法/)
3. 审核规范要求网站地址和回调地址完成工信部备案，填写信息一致；网站可访问、建设完整、QQ 登录入口和流程可用，并按官方 UI 规范展示。文档流程的最终状态是审核通过/已上线，不是本地创建 provider。[QQ 应用审核规范](https://wiki.connect.qq.com/网站审核规范/)
4. 官方创建应用页对“国际域名”另指向邮件申请审核；不能把大陆站点备案规则推论成“任何境外域名永远不可能”，也不能擅自假设个人已获该例外。[创建应用中的国际域名说明](https://wiki.connect.qq.com/__trashed-2/)、[官方联系/国际域名接入说明](https://wiki.connect.qq.com/开发者反馈/)

Casdoor exact type 为 `QQ`，浏览器默认 scope `get_user_info`，授权端点 `https://graph.qq.com/oauth2.0/authorize`。[固定版本源](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/auth/Provider.ts#L63)

**待用户提供/确认**：本人名下应用与已取得接口权限、可用于审核的域名/备案或适用国际域名处理、精确公网 Casdoor 回调、允许使用的测试账号。域名和部署是新决策；本研究不注册域名、不配置隧道、不借用陌生 AppID 或共享扫码中转。

### 微信：区分 PC 网站应用与微信内网页授权，不伪造最新资质核实

**已核实（实现/腾讯官方产品文档）**：PC 扫码路径的 Casdoor type 是 `WeChat`，scope `snsapi_login`，授权端点 `https://open.weixin.qq.com/connect/qrconnect`。微信内授权使用另一 scope `snsapi_userinfo` 及 Mobile 配置，不能拿任意公众号/小程序 ID 代替网站应用。腾讯 CloudBase 的官方集成指南同样要求提供开放平台申请的网站应用 AppID/Secret，并指出回调域名必须与网站应用授权回调域一致。[Casdoor 固定版本源码](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/auth/Provider.ts#L67)、[Casdoor 微信配置说明](https://casdoor.ai/docs/provider/oauth/Wechat/)、[腾讯 CloudBase 官方 React 集成指南](https://docs.cloudbase.net/recipes/add-auth-web-with-cloudbase-sdk)

**本次未能独立核实的最新规则**：微信开放平台的网站应用主体类型、开发者资质认证材料/费用/有效期、网站/登录能力审核状态及大陆/境外域名细则。公开微信[网站应用登录原始文档](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)本次读取失败，门户先前又受显式安全阻拦，因此本研究**不把网上常见的“企业认证、300 元/年、必须某种主体”等说法写成已核实当前事实**。不能以小程序、公众号测试号或 Casdoor 模拟 provider 冒充网站应用正式权限。

**工程判断**：本人仍须在安全允许、由本人接手的官方流程核对网站应用、资质/审核及授权回调域，并提供满足规则的身份域名；当前本机 loopback 没有本次官方资料证明可直接成为正式网站应用回调。阻拦不能通过换浏览器、代理访问门户、raw 请求或“免认证扫码中转”绕过。

### 为什么 OAuth 库/身份代理不能消除这些义务

OAuth 客户端库处理协议，Casdoor/Keycloak 这类身份代理把多家身份收敛到统一 OIDC；它们不是 QQ/微信应用的签发者或审核机构。平台绑定的 appid/client_id、secret、回调域/URI、应用类型、用户同意和平台权限依然存在。QQ 创建文档和 Discord OAuth2 起步文档均直接要求注册应用取得凭据；腾讯 CloudBase 自己的微信集成也仍要求用户填开放平台 AppID/Secret。故“换库即可不申请/不审核”不成立。[QQ 创建应用](https://wiki.connect.qq.com/__trashed-2/)、[Discord OAuth2 起步要求](https://docs.discord.com/developers/topics/oauth2#shared-resources)、[CloudBase 微信授权登录](https://docs.cloudbase.net/authentication-v2/method/wechat-login)

## 四、GitHub 上成熟思路：借鉴边界，暂不替换现有身份层

维护信息为本次 GitHub 官方 repository API 的只读快照：`pushed_at` 仅证明仓库有推送，不证明该 provider 最近已真实回归；未 archived 也不等于 SLA。许可证应与实际复用的版本一起保留 notices。

| 项目 | 本次维护/许可证核对 | 对 BetterMe 的可借鉴点与选择 |
| --- | --- | --- |
| Casdoor | 未归档；最近推送 `2026-11-03T17:11:03Z`；Apache-2.0 | 已有统一 OIDC、provider 管理与本机账号关联，新增 provider 白名单/配置成本最低；继续采用。当前实际固定 v4.25.0，不因远端主线更新就原地升级。 |
| Goth | 未归档；最近推送 `2026-02-11T05:06:29Z`；MIT | 是 Casdoor 实际复用的适配层；查看固定 v1.82.0 的 scope/端点和资料映射，比另写 Node provider 有效；不把维护活跃度夸大成近期所有 provider 都验证过。 |
| Auth.js（nextauthjs/next-auth） | 未归档；最近推送 `2026-07-22T19:42:19Z`；ISC | GitLab adapter 直接用 `read_user` + `/api/v4/user`，微软 provider展示独立 OIDC 类型/issuer 配置。可参考最小授权与稳定 subject，但引入它会增加另一套会话/账号关联迁移，本轮不替换 Casdoor。 |
| Better Auth | 未归档；最近推送 `2026-11-04T12:42:07Z`；MIT | 明确区分 Discord 稳定 `id` 与非唯一 username，微软处理 tenant/issuer/account subject。可借鉴字段与scope审核；其默认scope可能比当前需要宽，不原样照抄。 |

仓库与状态来源：[Casdoor API](https://api.github.com/repos/casdoor/casdoor)、[Goth API](https://api.github.com/repos/markbates/goth)、[Auth.js API](https://api.github.com/repos/nextauthjs/next-auth)、[Better Auth API](https://api.github.com/repos/better-auth/better-auth)。许可证来源：[Casdoor v4.25.0 LICENSE](https://github.com/casdoor/casdoor/blob/v4.25.0/LICENSE)、[Goth v1.82.0 LICENSE.txt](https://github.com/markbates/goth/blob/v1.82.0/LICENSE.txt)、[Auth.js LICENSE](https://github.com/nextauthjs/next-auth/blob/main/LICENSE)、[Better Auth LICENSE.md](https://github.com/better-auth/better-auth/blob/main/LICENSE.md)。

具体代码参照：[Auth.js GitLab](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/gitlab.ts)、[Auth.js Microsoft Entra ID](https://github.com/nextauthjs/next-auth/blob/main/packages/core/src/providers/microsoft-entra-id.ts)、[Better Auth Discord](https://github.com/better-auth/better-auth/blob/main/packages/core/src/social-providers/discord.ts)、[Better Auth Microsoft](https://github.com/better-auth/better-auth/blob/main/packages/core/src/social-providers/microsoft-entra-id.ts)。这两家的类型字符串不能直接当作 Casdoor 类型。

## 五、Apple 等暂缓原因

Apple 不是只加一个按钮：官方 Web 配置要求 Services ID 关联到已启用 Sign in with Apple 的 primary iOS/macOS/tvOS/watchOS App ID；回调必须 HTTPS + 域名，不能 IP/localhost。Casdoor 还将 Apple 回调改为 `/api/callback`，需要 Team ID、Key ID 和签名私钥生成 client secret，不能套普通 `/callback` 配置。对当前本机 Casdoor、尚待本人提供身份域名的阶段，准备成本高于上述三家，故暂缓，而非说 Casdoor 不支持 Apple。[Apple Web 配置要求](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)、[Apple 授权接口限制](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.)、[Casdoor Apple 分支](https://github.com/casdoor/casdoor/blob/v4.25.0/idp/goth.go#L98)

其余 Facebook、LinkedIn 等本轮不列为第四/第五推荐；没有用户需求与本人应用条件时，不为扩大按钮数量增加审核和维护范围。本研究未完成这些平台最新产品权限的专项核对，不声称它们不能接入。

## 六、可执行落地门槛与不能越过的安全边界

1. Host 入口白名单按 exact type 匹配；Microsoft 仅映射 `AzureAD`。新增三家仅在 `app-betterme` 实际关联对应 provider 时显示，不因 Casdoor“支持某类型”就展示可用按钮。
2. 按本仓库现有约束，每个启用 OAuth provider 都显式 `Binding rule=[]`，包括新增或非快捷渠道；不能按 email/phone/username 自动接管旧 owner。provider 配置完成只代表准备就绪，不代表平台真实授权验收通过。此项为仓库安全约束，见 [现有 Casdoor 说明](../casdoor.md)。
3. 两层回调分别核对：平台 → Casdoor 为其实际 origin 下 `/callback`；Casdoor → BetterMe 为 `/api/v1/agent/identity/oidc/callback`。Apple 为上游特殊 `/api/callback`，本轮不启用。不能把平台回调登记成 BetterMe 的 OIDC 回调。
4. Client Secret 只在本人控制的本机 Casdoor 或受保护部署 secret 保存；不发给模型、不进前端构建/聊天/Git。2FA、扫码、组织资质、费用、对外发布和创建外部应用由本人按当次授权处理。
5. 对每家真实测试：首次进入独立空白 owner；已有人必须先重认证显式关联；退出再平台登录保持原 owner；拒绝授权/重放/换号迟到回调失败；邮箱缺失不会触发错误合并；浏览器与日志没有 Secret/token。没有这组证据，状态只能写“源码支持/已配置/待真实验收”。

本文件为研究记录，不是平台开通回执。GitHub OAuth App 创建、Google 品牌表单、本人 2FA 等其他并行工作的状态应以主任务当次观察为准；本文不把它们推断为平台凭据已生成、provider 已启用或真实登录已成功。
