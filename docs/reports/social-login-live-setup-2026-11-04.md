# 社交登录真实配置续接 · 2026-11-04

## 当前停点

**2026-11-05 最新停点：本人当次确认后，Microsoft `BetterMe Local Casdoor` 已实际注册成功，概述显示仅支持个人 Microsoft 账户；API 权限恰有一项委托 `User.Read`。客户端密码仍为 0，现停在“添加客户端密码”的最终添加前：说明已填，有效期为界面推荐的 180 天（6 个月），等待当次生成确认。** 尚未配置 Microsoft 精确本机回调或安装 provider，不能声称微软登录已接通。另一个用于准备清单的门户标签登录超时、官方重试一次仍失败；保留原已登录密钥表单，不重复注册。GitHub/Google 真实再登录在前轮已验证，原 BetterMe owner 仍待本人密码显式关联。Discord/QQ 本人登录、GitLab 本人邮箱验证、微信安全处理仍为独立停点。本轮未重测 Host，前轮目录 `ready`、GitHub/Google `available`；真实资料和正常服务未操作。

源码扩展及之前的合成验证见 [扩展报告](social-login-platform-expansion-2026-11-04.md)；部署边界见 [Casdoor 说明](../casdoor.md)。本次仅操作批准的外部应用和本机私有配置，没有改业务代码、运行旧资料迁移或读取真实简历。

## GitHub 已完成的轮换

1. 在本人已创建的 `BetterMe Local` OAuth App 生成替换 secret，没有再次创建 OAuth App。
2. 从一次性显示的界面在本机处理并写到私有临时配置，未打印新值。目标目录 0700、文件 0600，非符号链接；本机 Casdoor 管理 API 更新原 `betterme-github` provider，原应用仍保持暂停直到撤销结束。
3. 以只读 SQLite 精确读取目标 provider 的保存值，仅输出与替换文件一致的布尔结果。没有用会回显 actual/expected 的断言。
4. 按原 secret 的已掩码条目定位删除目标，确认“立即失效、无法撤销”的页面后执行本人已批准的删除。页面显示“客户端密钥已移除”，原条目消失，只剩替换条目；没有撤销用户 token 或删除应用。
5. 原子更新仓库外 `github.private.json`，保存无秘密的轮换回执，再恢复 `Can sign in=true`。管理员会话核对原 OIDC client/callback，空 Binding rule 保留。

后续正常 Host 目录实际返回 HTTP 200 / `ready`，GitHub `available`、微信/QQ/Google `not_configured`。3 个本机日志和最近相关审计行没有新 GitHub 原始 secret；私有配置/回执文件权限均为 0600。

## GitHub 真实授权准备与续接观察

独立新标签从本机 Casdoor 默认登录首页点击 GitHub，已进入 `https://github.com/login/oauth/authorize`，真实参数及同意页确认：

- 应用：`BetterMe Local`；回调 `http://127.0.0.1:18000/callback`。
- Scope：`read:user user:email`，只读个人资料与邮箱；没有仓库权限。
- 当时停在授权按钮前，随后本人明确批准只读身份授权。本轮续接读取时，该页已经在本机 `/apps`，显示当前统一身份和 BetterMe 统一账号应用；只读数据库确认 `betterme` 组织存在 GitHub 非空的身份。本轮没有再点击 GitHub 同意按钮，不能把未观察的中间操作归为本轮执行。

这次从 Casdoor 首页发起的流程不是 BetterMe 的有效原 owner 关联流程。即使供应商授权成功，也只能先作为 Casdoor 平台链路验证；不能声称已绑定原 BetterMe owner。正式关联仍由本人在原账号工作台核对本机密码后发起，不能按同邮箱/昵称自动合并，也不能用孤立回调创建并认领原空间。

一次直达 `/login/app-betterme` 被 Casdoor 当作组织路由并显示不存在；随后使用已配置的 issuer 根页面到默认 `/login`，可见 GitHub 按钮并成功进入上述官方授权页。没有改动登录路由或把这次测试地址错误当成产品故障。

## Google 已创建及新的诊断事件

本人本次确认后，已在独立 BetterMe Login 项目点击创建 `BetterMe Local Casdoor` Web OAuth client。成功模态和客户端列表均确认创建；精确回调为 `http://127.0.0.1:18000/callback`，JavaScript origins 为空、AI agent 选项未勾选，没有启用计费或添加 Gmail/Drive/电话 scope。

读取创建成功模态时，Google 将完整 secret 放在“复制到剪贴板”按钮的 accessible name。原先只隐藏 `Value:` 的控件摘要未能隐藏该名称，导致一次工具输出回显完整 secret。**这枚 Google secret 同样按已暴露处理，不能称“只在本机”。** 已立即告知本人，未安装该 secret 或创建 Google Casdoor provider，仅将非秘密客户端元数据及 `requiresSecretRotation=true` 保存到仓库外 0600 私有文件。

后续凭据页摘要改成控件编号/角色 + 固定标签白名单，未知标签一律省略，field value 全不输出；不输出完整按钮 accessible name。任何完整截图须先确认可见文本已掩码，不保存展示一次性 secret 的模态截图。新 GitHub 替换值没有出现在本轮工具输出。

此前停在该客户端的“添加客户端密钥”按钮前，没有安装暴露值。该停点已由下方本人再次确认的轮换完成；客户端本身不重复创建。

## 前阶段：Google 轮换完成，准备资料同意

1. 固定标签摘要先用合成 token 自检，确认按钮名称/字段值不会出现在输出。添加替换密钥后只在本机运行时解析，写入 0700 私有目录下 0600 临时文件并布尔核对；没有截图或输出新值。
2. 重新打开控制台后，按旧/新值的掩码后缀和各自创建条目区分目标。先停用初始密钥，再在该条目执行删除并确认；最新页面旧条目消失，只剩替换条目。截图 `google-key-rotated.jpg` 是掩码结果，不含新秘密。
3. 本机管理员会话新增 `betterme-google`，先保持 `Can sign in=false`，空 Binding rule；原 OIDC client、secret、回调保持一致。初次检查发现实际 API / SQLite 字段是复数 `scopes`，不是 `scope`；启用前已改为 `profile+email` 并从真实存储布尔核对。
4. 完成撤销后，将私有临时文件原子改为 `google.private.json`，保存不含秘密的轮换回执，客户端元数据 `requiresSecretRotation=false`；再启用 Google。五份私有配置/回执均 0600、非符号链接，3 个本机 Casdoor 日志均无当前 GitHub/Google 原始 secret，未跳过超大日志。
5. Host `/identity/providers?refresh=1` 实际 HTTP 200、服务 `ready`，GitHub / Google `available`，微信 / QQ `not_configured`。这是配置核验，不是 Google 供应商回调验收。
6. 从已登录 GitHub 统一身份的 Casdoor“我的账户”进入未绑定的 Google“绑定”，在官方 account chooser 选择本人已指定邮箱。当时停在仅列姓名/头像、邮箱的最终同意页，等待当次确认；该等待已由下文续接结果更新。不是按相同邮箱自动合并，也不是绑定原 BetterMe owner。

Google 控制台原标签重载曾停在加载状态，改用同一 Chrome 内的新标签打开已经观察到的同一客户端地址后恢复；没有改用原始网络、代理或其他浏览器绕过屏障。一次授权页 AX 读取超时后用受支持截图确认同意页，再读取到“继续”按钮；没有点击授权或操作密码/验证码。

## 本轮：双平台绑定与真实再次登录

1. 本人明确确认 Google 姓名、头像、邮箱授权及绑定当前 GitHub 统一身份。续接时页面已在 Casdoor `/account`，两个平台的行都显示“解绑”；没有再点击旧同意按钮，也不把未观察的中间点击归为本轮执行。
2. 只读 SQLite 确认 `betterme` 组织恰有一个 GitHub 非空主体，该同一记录 Google 也非空。主体指纹和结果只写仓库外 0600 私有回执，输出仅计数/布尔值，不输出账号 ID 或资料。
3. 只退出 Casdoor 会话，从真实登录页点击 Google。实际官方授权参数 `scope=profile email`、精确本机回调核对后，选择已批准邮箱，自动返回 Casdoor `/apps`；姓名/身份与绑定主体一致。没有增加电话、Gmail、Drive 权限。
4. 再次只退出 Casdoor，从 GitHub 按钮发起真实登录，观察到本机 `/callback`，随后回到同一统一身份的 `/apps`。当前替换密钥可完成实际登录，不再仅凭配置目录判断。
5. 两次再登录后只读复核唯一主体指纹未变、两个平台仍绑定，更新私有回执；Host 目录 HTTP 200 / `ready`，GitHub、Google `available`。

没有退出、刷新或修改原 BetterMe 工作台，尚未在原账号输入本机密码进行 OIDC 关联，也没有在正常 Host 用未关联身份登录来创建占用该主体的新 owner。**真实上游登录验证不等于原 BetterMe 资料空间已关联。** 下一步由本人原工作台设置发起显式关联，再验退出/平台登录的 owner 和资料一致性；密码不发聊天。

## 国外三家：真实开通准备与停点

本轮刷新了 [GitLab 官方 OAuth 应用说明](https://docs.gitlab.com/integration/oauth_provider/)、[Microsoft 官方应用注册说明](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)、[Discord 官方 OAuth2 说明](https://docs.discord.com/developers/topics/oauth2)。代码已有三家 exact type 与最小 scope 支持，不另加身份服务或伪造客户端。

| 平台 | 最近实际观察 | 下一步与边界 |
| --- | --- | --- |
| GitLab | 本人当次明确确认后，重新核对官方同意页应用 `GitLab.com`、scope 仅 `user:email`、回调 origin `https://gitlab.com`，已点击“授权 gitlabhq”。跳转后先加载，再显示“帮助我们确保 GitLab 的安全”的邮箱验证码页，目的邮箱在界面掩码。 | 本人直接在 GitLab 页面输入邮箱验证码并完成验证，验证码不发聊天；当前不是已接通 BetterMe。进入本人设置后准备自己的 OAuth 应用，应用登录 scope 用 `read_user`，精确回调为 `http://127.0.0.1:18000/callback`。若出现最终账号创建或客户端/密钥创建按钮，再按实际动作当次确认。 |
| Discord | 官方开发者页要求 Log In；进入 `/login`，显示本人登录/二维码方式，尚无开发者会话。没有读取或截图二维码凭据。 | 本人扫码/登录后继续准备应用；创建客户端及权限动作须当次确认，仅申请 `identify`，无 bot/服务器/消息权限。 |
| Microsoft | 本人当次确认后已点击注册并实际进入 `BetterMe Local Casdoor` 概述，支持个人 Microsoft 账户；真实权限表仅 Microsoft Graph (1) 下的委托 `User.Read`。客户端密码为 0，已准备 180 天（6 个月）添加表单，未提交。 | 需当次确认生成此期限的客户端密钥，新值仅本机；精确 `http://127.0.0.1:18000/callback` 仍待后续 manifest 配置。还未创建本机 provider 或进行真实微软登录；不加邮件/网盘/组织管理权限、不授予管理员同意、不建租户或开计费。 |

保留 Microsoft 待确认的密钥添加表单、GitLab 邮箱验证码页、Discord 登录页与 QQ 官方登录入口供本人继续。2026-11-05 在 QQ 公开页选择“网站应用→开始创建应用”，可见“开发者注册→创建应用→完善资料→提交审核”流程，仍要求本人登录，未进入真实应用表单、未提交开发者资料；不读取/截图扫码凭据。没有为这三家创建本机 provider，因此不制造三项可用入口。QQ 本人扫码/应用/域名及微信安全阻拦/资质边界不变。

## 2026-11-05：Microsoft 客户端已创建，密钥待当次确认

1. 在同一 Chrome 重新进入已知的官方 `entra.microsoft.com`。页面初期只有壳层，AX 曾超时；使用同一标签截图与只读可见 DOM 观察，随后导航和“应用注册”实际加载。没有跨浏览器、改系统设置、切换公司租户或反复重试；不将前轮超时永久当作当前状态，也不据此推断超时根因。
2. 从可见导航打开“应用注册→新注册”，填写显示名并选择仅 Microsoft 个人账号。本人当次确认创建长期 OAuth 客户端后，重新核对真实表单，只点击一次最终注册；页面实际进入同名应用概述，可见应用程序（客户端）ID、个人账户范围及添加凭据入口。没有选择工作/学校账号，也没有创建租户、订阅、计费或管理员同意操作。
3. 只读进入 API 权限，真实表格只有 Microsoft Graph (1) 下的一项委托 `User.Read`，无需管理员同意；没有 Mail/Files/Directory 权限。再进入证书和密码，真实客户端密码为 0，准备添加说明 `BetterMe local Casdoor 2026-11-05`，期限保留门户推荐的 180 天（6 个月）；没有点击最终“添加”，未生成 secret、写私有配置或新增 Casdoor provider。
4. [Microsoft 官方 loopback 限制](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#prefer-127001-over-localhost)要求 HTTP + `127.0.0.1` 使用应用 manifest，不能经回调文本框添加；因此注册时可选回调留空，不用 `localhost` 替换已配置 Casdoor origin。尝试在同一 Chrome 的独立标签打开已观察到的同一应用凭据地址来准备清单，该标签登录 `timed_out`，官方“再试一次”仅重试一遍仍失败；未打开清单、未配置回调，不换浏览器/原始网络绕过。原标签仍可操作，密钥侧栏取消会提示丢弃未保存编辑，已选择 Cancel 保留；不再为切页反复取消，先从当前密钥生成确认续接。
5. 前一阶段正常 Host `/identity/providers?refresh=1` 实际 HTTP 200，`service=ready`、统一入口可用；只有基础四项，GitHub/Google `available`，QQ/微信 `not_configured`。本次客户端创建轮没有重跑 Host 目录、供应商登录或扩展测试，也未启动/重启服务。

截图 `microsoft-registration-ready-2026-11-05.jpg` 为前阶段注册前表单；本次 `microsoft-client-created-2026-11-05.jpg` 为实际创建后的概述，`microsoft-secret-ready-2026-11-05.jpg` 为零密钥下的最终添加表单，均不含 secret。下一步先由本人当次确认生成 180 天密钥，再安全捕获、配置精确回调和暂停状态的本机 provider，核对后才启用并验证；不重复注册应用。

当前沙箱不允许直接写仓库外私有配置：密钥一旦生成，只保留在本机捕获运行时，不输出完整 AX/按钮名/字段值或一次性截图；如需文件桥接，使用沙箱允许的私有临时目录 0700/文件 0600，再经获批终端操作原子转入既定私有目录并布尔核验，不把 secret 插入工具参数或命令文本。现有私有目标若已存在先核对，不能无声覆盖。Discord 本人登录、GitLab 本人邮箱验证、QQ 本人登录及合规域名/审核、微信本人安全处理仍是独立门槛。

## 2026-11-04 续接：GitLab 只读邮箱授权已执行

本次本人已明确批准把 GitHub 邮箱交给 GitLab.com 用于登录。授权前通过真实页面控件和当前 URL 重新核对仅 `user:email`，没有 `repo`；授权按钮已启用后只点击一次。实际返回 GitLab 身份验证流程，截图最终显示邮箱验证码输入框和“验证您的电子邮件地址”，并提示未验证账户将在 3 天后被删除。只报告这个可见状态，不把授权成功当作账号已验证、OAuth 应用已创建或 BetterMe 登录已完成。

AX 读取一次超时后，使用同一 Chrome 标签的受支持截图确认邮箱验证页；没有换路由、另开浏览器或绕过验证，也没有求解 CAPTCHA、读取邮箱/OTP、重新发送验证码或点击邮箱验证提交。没有生成新密钥、改私有配置、操作原 BetterMe 页面/资料或重启正常服务。下一步由本人在现有 GitLab 页面完成邮箱验证；不再重复已完成的 GitHub 邮箱授权。

## 验证与保护范围

- 本机管理员 API 更新、目标 secret 存储一致性、空 Binding rule、GitHub 恢复启用及原 OIDC client/callback 核对通过；所有秘密比较只输出布尔值或固定错误。
- GitHub 与 Google 的真实再次登录均已由本轮发起并观察到 Casdoor 已登录应用页，唯一主体指纹未变。Google 初次同意的中间点击未观察，既有两家绑定结果已确认。
- Google 使用 profile/email 完成真实再登录，没有增加电话 scope；固定版本 People API 附带调用不再作为未验证登录阻断的猜测，但不据此声称未发出该内部请求。原 BetterMe owner 关联与其再次登录仍待本人密码证明。
- 代码本轮未改；之前的 20/20 定向、13/13 类型、8/8 构建与合成七平台结果只作为原扩展批次证据，本轮不冒充重新执行或真实供应商验收。
- 原 BetterMe 页未刷新/退出/重登，原 owner、简历、恢复档案、Agent 记录、模型选择与自动保存未操作；正常服务不重启。不提交、推送、新建分支或部署。
- QQ 仍需本人扫码、自有有效应用及合规公网域名/审核；微信门户安全阻拦由本人处理，不绕过。Microsoft 已有真实注册应用但尚无密钥/回调/provider，GitLab/Discord 尚未注册真实应用；均不伪造可用状态。

证据位于本次 Codex 可视化目录：前阶段 `github-key-rotated.jpg`、`google-client-created.jpg`、`google-secret-rotation-ready.jpg`、`github-real-consent-ready.jpg`、`google-key-rotated.jpg`、`github-casdoor-signed-in.jpg`、`google-identity-consent-ready.jpg`；双平台验证阶段 `google-github-same-identity.jpg`、`google-relogin-success.jpg`、`github-relogin-success.jpg`、`gitlab-github-email-consent-ready.jpg`；GitLab 续接 `gitlab-email-verification-required.jpg`；2026-11-05 `microsoft-registration-ready-2026-11-05.jpg`、`microsoft-client-created-2026-11-05.jpg`、`microsoft-secret-ready-2026-11-05.jpg`。下一步先从 Microsoft 当前添加密钥表单的当次确认续接；其他平台本人登录/验证分别保留，不重复既有授权、应用注册或轮换。
