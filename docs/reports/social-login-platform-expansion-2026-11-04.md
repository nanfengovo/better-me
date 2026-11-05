# 社交登录扩展与本机开通进度 · 2026-11-04

后续更新：本人再次确认后已完成 GitHub 轮换/旧值撤销及 Google 客户端创建。当前 Google 新诊断事件、真实 GitHub 同意页和待办以 [真实配置续接](social-login-live-setup-2026-11-04.md) 为准；下文保留扩展批次当时的实现与验证证据。

## 当前结果

本轮将既有四渠道能力扩展到七家，继续复用 Casdoor → OIDC → 稳定 BetterMe owner。源码与隔离回归已经通过；**不把它描述为七家真实登录已完成**。真实 GitHub 配置已写入本机，但因一次诊断暴露而暂停入口等待密钥轮换；Google 品牌已由本人完成创建，Web 客户端表单准备完成、最终创建尚待当次确认。

原实现、旧资料恢复及历史全量测试分别保留在 [原实施报告](social-login-2026-11-04.md) 和 [恢复报告](confirmed-recovery-casdoor-2026-11-03.md)，不重跑迁移。配置入口见 [Casdoor 说明](../casdoor.md)，平台依据见 [公开官方调研](../research/social-login-platforms-2026-11-04.md)。

## 本轮源码

- 共享固定渠道枚举新增 Microsoft、GitLab、Discord；精确映射到当前固定版本 `AzureAD`、`GitLab`、`Discord`。
- Host 只在实际应用关联了可选 provider 时增加对应入口；保持原四家和旧四渠道响应兼容，不制造三枚未配置按钮。目录拒绝重复、缺基础渠道或未知 ID。
- Web 使用已有简单图标体系增加三家图标，保持原密码关联、退出前保护写入、固定授权 origin 和迟到代次保护。
- 新增契约、可选显示、错误映射/凭据缺失/停用、三个新入口的真实 HTTP 合成协议回归；没有提高或取消 10/min 生产限流。
- 独立 Casdoor 脚本扩展到七家虚构 provider；不访问本人安装库或真实社交平台。

没有增加认证服务/第三方依赖、重写 OAuth adapter、修改账号 owner 策略或按邮箱自动合并。代码位置：`packages/agent-contracts/src/social-login.ts`、`apps/agent-host/src/identity/social-login.ts`、`apps/web/src/components/CasdoorAccess.tsx` 及相应测试。

## 真实平台状态

| 平台 | 已观察 / 已配置 | 尚未完成 |
| --- | --- | --- |
| GitHub | 本人确认后已创建 BetterMe Local OAuth App；本人完成 2FA 后生成的 secret 仅保存本机私有配置，并通过本机管理员 API 建立 `betterme-github` provider。`read:user+user:email`，空 Binding rule；原 OIDC client/callback 和其他 provider 保留。 | 诊断暴露后的 secret 轮换、撤销旧 secret、重新启用，以及本人真实授权/原 owner 显式关联/再次登录。当前 `Can sign in=false`。 |
| Google | 独立 BetterMe Login 项目；本人已完成 OAuth 品牌创建并批准当前邮箱的支持/开发者联系用途。准备好 Web client `BetterMe Local Casdoor`，回调 `http://127.0.0.1:18000/callback`，未勾 AI agent、未配置额外 JS origins。 | 创建持久 OAuth 凭据的最后按钮待当次确认；本机 secret/provider、真实授权与原 owner 关联未完成。没有启用计费或扩大 Gmail/Drive/电话 scope。 |
| QQ | 官方流程、固定 adapter、scope 与域名约束已核对；QQ 互联本人扫码页保留。 | 本人扫码、开发者应用/审核以及满足要求的公网身份域名。当前 loopback 带端口不能登记为正式回调。 |
| 微信 | PC `WeChat`/`snsapi_login` 和 Mobile 区别已明确；保留现有接入代码。 | 本人处理先前门户安全阻拦，核对当前资质/应用审核并提供自有 AppID/Secret、合规授权回调域。未绕过阻拦。 |
| Microsoft / GitLab / Discord | 固定版本映射、前后端入口、合成 HTTP/真实 Casdoor 兼容与 UI 已验证。 | 本人对应开发者账号、持久客户端凭据、精确回调接受情况及真实授权；未创建这三家外部应用。 |

QQ 官方公开规则要求外网域名、回调不带端口或 localhost，并有网站/备案审核；国际域名另有申请渠道。微信最新主体/费用细则本次未独立核实，不把社区说法当当前规则。可行路径是本人拥有的合规应用 + 统一公网 Casdoor 身份域名；本轮没有购买域名、部署公网代理/隧道、借用共享 AppID 或扫码中转。

## 私密配置及诊断事件

私有目录位于仓库外 `~/Library/Application Support/BetterMe/agent/social-login/`（0700），`github.private.json` 和应用备份（0600），目标非符号链接。密钥不在源代码、前端构建环境或本报告中。Google secret 尚未生成。

第一次增量写入前检查发现 `/api/get-application` 的默认响应脱敏：回调/grant 可能为空，不能整对象保存。检查在写入前停止；随后使用已有本机管理员凭据建立独立 API 会话，验证真实 client/callback、写私有备份，再增添 provider/binding。没有改管理员密码或原浏览器会话。

写后回读时，provider secret 仍为掩码；不当使用带 expected/actual 的等值断言，令工具诊断回显了一次敏感值。**该 secret 按已暴露处理，不得继续视为“只放本机”。** 已通知本人、停止会回显秘密的检查，保持 provider 但将 `Can sign in` 设为 false 等待当次确认轮换。后续所有秘密比较只返回布尔值/固定错误码；不以 `assert.equal` 等打印秘密。

三个本机 Casdoor 日志文件检查未含该原始 secret；最近相关审计行也不含原始 secret，已观察到 `clientSecret` 掩码。仓库隐藏/可检索文件的原始值匹配数为 0。此检查不能撤销工具诊断中的暴露，故轮换仍为必要待办。正常公开 Host 目录在配置后曾返回 GitHub `available`；安全暂停后再次真实读取 HTTP 200 / service ready，GitHub 为 `disabled`，其余三家基础入口仍 `not_configured`。

轮换顺序：经当次确认生成替换 secret → 安全本机更新 provider/私有配置 → 撤销旧 secret → 读回掩码/非敏感状态及 scope → 再启用入口。GitHub 页面显示唯一 secret 暂不可删除，必须先生成替换值；本轮没有擅自再次生成或删除。

## 本轮验证

| 验证 | 结果与证据边界 |
| --- | --- |
| 合同构建 | `pnpm --filter @better-me/agent-contracts build` 通过。 |
| 定向自动回归 | `social-login.test.ts`、`social-login-http.test.ts`、`oidc-http.test.ts`、`oidc-identity.test.ts`、Web `social-login.test.tsx`：20/20 通过，0 失败/跳过。 |
| 类型 | `pnpm typecheck`：13/13 通过。 |
| 生产构建 | `pnpm build`：8/8 通过；既有地图模块外置与大 chunk 提示保留。 |
| Lint | `pnpm lint` 零警告通过。 |
| 真实 Casdoor 固定版本 | 仅复用已校验二进制/公开静态资源，全新临时 SQLite/证书/端口；7 个虚构配置目录与 OIDC 入口通过，临时进程/目录清理。不是七家供应商授权。 |
| 隔离浏览器 | 自建 5383/5389 + 签名虚构 IdP，七枚实际按钮/图标可见；Microsoft 入口的 `provider_hint` 为合成 Microsoft，取消后明确未切账号/未移动资料。未读取真实简历、未调用模型，测试标签已关闭，自建服务已终止清理。 |
| 本机配置 | 原 client/callback/grant 保留，空 Binding rule，公开目录真实读取与停用写后检查通过。没有用户真实社交登录、原 owner 关联或资料改动。 |

浏览器证据保存到本次 Codex 可视化目录：`social-seven-platforms-synthetic.jpg`（明确合成）；`github-rotation-ready.jpg`（已掩码的轮换页面）；`google-client-create-ready.jpg`（精确回调与最终创建按钮）。Google/GitHub/QQ 页面保留供本人确认/接手，原 BetterMe 工作页没有刷新或重登。

## 继续与发布边界

先完成 GitHub 轮换及 Google 客户端创建这两个持久凭据动作的当次确认；2FA、扫码和原 BetterMe 密码均由本人在官方/本机页面输入，不发聊天。已有资料必须先用原账号显式关联，再验退出后平台登录保持 owner；直接新主体登录会创建独立空白空间。

本轮仍在既有 `agent-os`，许多相关文件原已未跟踪，并有大量其他工作；没有整目录暂存、提交、推送、新建分支、部署、重启正常服务或改变真实简历/恢复档案。根全量测试本轮未重跑；不能用历史全量数字冒充本次结果。所有平台完成条件仍是有效应用 + 真实授权 + 显式关联 + 再次登录与隔离验收。
