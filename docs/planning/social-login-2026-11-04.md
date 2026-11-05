# BetterMe 第三方社交登录设计 · 2026-11-04

状态：本地实现，协议、UI 与隔离 Casdoor 兼容性已验证；真实平台开通与逐渠道授权待办。四渠道基线见 [实施报告](../reports/social-login-2026-11-04.md)，后续七渠道扩展与真实配置停点见 [扩展报告](../reports/social-login-platform-expansion-2026-11-04.md)，部署操作见 [Casdoor 接入说明](../casdoor.md)。

## 选择：复用现有 Casdoor，不重建账号体系

用户期望用微信、QQ、GitHub、Google 的已有身份进入 BetterMe，并可把多个登录方式用于同一份职业资料。本仓库实际是 React 19 + Node/TypeScript，不是参考材料中的 ASP.NET Core + ABP + Identity + OpenIddict + Vue3。

既有 Casdoor v4.25.0 已通过 OIDC 授权码、PKCE 和签名 JWT 接入；BetterMe 的内部 owner、会话及私有数据隔离继续保留。本批在其上增加社交渠道发现、可解释状态、直接授权入口和已关联身份管理。平台适配、应用密钥与上游绑定由 Casdoor 负责，BetterMe 只信任经过验证的统一主体。

不引入另一套 Logto / Authing / Keycloak，不安装不适用于当前后端的 ASP.NET OAuth 中间件，也不逐家重写 OAuth。原因是复用现有用户映射与运维路径，避免两套账号迁移、同一邮箱误合并和重复管理平台密钥。后续按用户要求补充 [平台和开源比较](../research/social-login-platforms-2026-11-04.md)，仍保留这个边界。

```text
微信 / QQ / GitHub / Google / Microsoft / GitLab / Discord
            │ 平台 OAuth；平台回调指向 Casdoor /callback
            ▼
     Casdoor 统一身份（issuer + sub）
            │ OIDC Code + PKCE；JWT 签名/issuer/aud/nonce 校验
            ▼
     BetterMe Host → 稳定 owner → 原有私有工作空间
```

登录不是同时登录四个平台，也不保证首次无需操作。首次需在平台官方页面授权，微信可能扫码；以后是否直接返回取决于平台会话与策略。

## 用户路径

| 场景 | 交互与结果 |
| --- | --- |
| 登录页 | 固定展示微信、QQ、GitHub、Google；另外三家只在当前应用实际关联 provider 时展示。仅已启用且配置通过核对的入口可点击。统一账号密码放在「其他登录方式」，本机账号继续可用。 |
| 新外部身份首次登录 | 创建独立空白 owner；同名、同邮箱、同手机号不接管旧资料。已有资料的用户先用原账号登录再关联。 |
| 本机账号关联 | 工作台设置 →「登录方式与账号关联」→ 核对当前本机密码 → 选择平台 → 官方授权 → 返回原 owner；本机密码、原资料与历史继续保留。 |
| 已关联身份登录 | 无论使用哪个上游入口，只要 Casdoor 返回同一已关联统一主体，就进入同一 owner。不同平台尚未绑定到同一主体时不会自动合并。 |
| 管理第三方绑定 | 对当前已关联主体重新认证，精确核对原 owner / issuer / sub 后前往 Casdoor `/account`。没有本机密码的外部账号也能使用，不显示无法完成的密码表单。 |
| 离线、未开通、停用 | 按原因禁用按钮，提供重新检查；本机登录仍可用，不伪造授权成功。 |
| 取消、过期、换号或迟到回调 | 保留原账号与资料，显示失败说明；重新发起流程。旧流程不能切换后来的账号。 |

管理入口不新建关联、不更换 BetterMe 会话。用户在管理重认证时选错统一账号会被拒绝；不能利用管理操作把另一个人绑到当前 owner。BetterMe 不提供删除 owner 绑定的快捷 API；平台解除绑定由上游管理端处理，最后登录方式的保护与找回须在真实平台验收中单独核对。

## 渠道目录是一个薄适配层

`SocialLoginCatalogModule` 封装 Casdoor v4.25.0 的公开应用登录元数据接口 `/api/get-app-login`。请求携带固定 clientId、已配置回调及一次性协议参数，使 Casdoor 校验当前应用与回调，而不是调用需要管理员权限的 provider 列表。

- 客户端只提交固定枚举 `wechat | qq | github | google | microsoft | gitlab | discord`。新增映射精确为 Casdoor `AzureAD | GitLab | Discord`。Host 从经过核对的应用配置解析真实 provider 名称，作为 `provider_hint` 发起授权；客户端不能指定任意 provider、issuer、管理地址或回跳地址。
- 只投影四个基础渠道与已关联的可选渠道标识、标签、状态、注册能力和固定授权 origin。不返回 provider 原对象、Client ID/Secret、平台 token、邮箱、手机号或头像。契约兼容旧 Host 的四渠道响应，同时要求基础四家齐全、ID 不重复且没有未知渠道；上游错误转换为固定说明。
- 元数据读取限制 4 秒、256 KiB，不跟随重定向；核对返回 clientId，白名单匹配 OAuth 类型与 provider 名称。失败关闭快捷入口。
- 目录缓存 10 秒并合并并发读取，手动刷新与每次发起登录重新检查；管理员停用不会被浏览器旧目录绕过。
- 微信 Web 与微信内 Mobile 配置按浏览器上下文选择；微信内使用 Mobile 的第二组凭据，普通浏览器使用 Web 配置。只有不匹配版本时提示切换浏览器。

状态含义：`available` 仅表示当前应用配置可用，不表示凭据已被平台接受；`not_configured` 未开通或凭据不完整；`disabled` 管理员/组织停用；`unsafe_binding` 自动合并规则不安全；`unsupported_context` 微信环境不匹配；`unavailable` 统一服务离线或配置响应异常。

## 账号归属与安全约束

1. **统一主体是身份，平台资料不是 owner。** 保留原 `issuer + sub → owner` 映射；昵称、邮箱、手机号、模型账号/API Key 都不参与 BetterMe 自动认领。
2. **应用内所有启用 OAuth provider 的 `bindingRule` 必须显式为 `[]`。** 默认、null、Email、Phone 等规则均不接受；包括不在四个快捷按钮内的其他 OAuth provider。任一启用源仍允许自动合并时，所有快捷入口及统一登录均关闭，先修配置。
3. **`provider_hint` 不是身份来源证明。** 它影响上游界面/导航，不是 JWT 中受验证的实际平台断言。上游可能提供其他入口，因此不能只核对被点击的一个 provider。Host 最终只认证可信 Casdoor 主体，不声称能证明用户确实用了某个社交平台。
4. **关联和管理需当前 owner 的授权。** 关联继续验证原会话、预期 owner 和本机密码；管理验证原会话与已存在的精确主体绑定。新流程、退出或换号使旧回调失效。
5. **先保护已接受的写入再离开。** Web 等待既有退出前保护事件；身份代次改变时迟到的目录、授权地址或回调不生效。密码仅随关联请求使用，离开/失败后清空输入，不持久化到浏览器。
6. **认证不扩权。** 社交登录不会授予 GitHub 仓库读取、Agent 文件读取、模型套餐/API 计费、招聘平台采集或真实资料发送权限，也不提供跨浏览器简历同步。

信任前提是管理员控制的 Casdoor 与其平台配置；管理员事后更改合并规则、上游主动合并主体或账号恢复策略不能由 BetterMe 的一次目录检查完全约束。公网、多实例、域名与会话策略需单独部署验收。

## 接口与实现位置

| 接口 / 模块 | 职责 |
| --- | --- |
| `GET identity/providers[?refresh=1]` | 公开、脱敏、4–7 渠道能力目录；不证明用户身份。 |
| `GET identity/account` | 已认证且 owner 匹配后，只返回本机密码/当前统一身份是否关联。 |
| `POST identity/oidc/start` | `login / link / manage`，可选固定渠道；保留 state、nonce、PKCE、限流及固定回调。 |
| `GET identity/oidc/callback` | 校验一次性流程和签名证明；登录、显式关联、已关联管理分别执行。 |
| `packages/agent-contracts/src/social-login.ts` | 共享目录、状态与账号能力契约。 |
| `apps/agent-host/src/identity/social-login.ts` | 唯一 Casdoor 渠道适配器。 |
| `apps/web/src/components/CasdoorAccess.tsx` | 登录入口、关联表单、管理与失败反馈；不掌握平台秘密。 |

## 真实平台启用门槛

运维步骤集中在 [Casdoor 接入说明](../casdoor.md)。完成条件是每个平台分别取得有效应用/审核、配置精确 Casdoor 回调、关闭自动合并，并实际完成首次授权、再次登录、原账号关联、取消/停用及资料隔离验收。仅目录绿色、合成 JWT 或 HTTP 200 都不足以宣布四家真实登录可用。

原四渠道实现批次没有使用个人真实社交账号、修改已安装 Casdoor 的用户库或添加真实平台密钥；后续获本人授权的平台创建/本机配置及待办以扩展报告为准。没有提交、推送或部署；原运行服务未为本功能强制重启。

## 主要依据

- [Casdoor OAuth Provider 官方说明](https://casdoor.ai/docs/provider/oauth/overview/)：平台开发者应用、provider 配置与应用启用。
- [Casdoor v4.25.0 ProviderButtons 源码](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/components/auth/ProviderButtons.tsx)：`provider_hint`、平台入口与微信上下文。
- [Casdoor v4.25.0 AuthBackend 源码](https://github.com/casdoor/casdoor/blob/v4.25.0/web/src/backend/AuthBackend.ts)：公开且校验回调的登录应用接口。
- [Casdoor v4.25.0 ProviderItem 源码](https://github.com/casdoor/casdoor/blob/v4.25.0/object/provider_item.go)：自动绑定规则与渠道登录/注册开关。
- [微信接入说明](https://casdoor.ai/docs/provider/oauth/Wechat/)、[QQ 接入说明](https://casdoor.ai/docs/provider/oauth/Tencent/)、[GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)、[Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)。
