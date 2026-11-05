# 第三方社交登录实施与验收 · 2026-11-04

## 结论

在现有 `agent-os` 实现微信、QQ、GitHub、Google 四个直接登录入口、服务端安全渠道目录、显式原账号关联和已关联统一身份管理。保留本机账号、稳定 owner、原 OIDC 验证和私有资料隔离，不引入另一套认证服务器或依赖。

**本地代码与协议链路完成；四家真实供应商授权未验收。** 本批没有使用真实社交账号或平台密钥，也没有修改已安装 Casdoor 用户库。真实开通仍需有效应用、审核、回调域名与逐渠道授权。设计见 [社交登录设计](../planning/social-login-2026-11-04.md)，管理员操作见 [Casdoor 说明](../casdoor.md)。

## 交付

- 登录页以平台名称与图标为入口，统一账号密码次级展开，本机登录继续可用。目录显示未开通、停用、离线、自动合并不安全或微信环境不匹配，未配置按钮不制造成功。
- Host 从当前 Casdoor 应用发现渠道，只输出白名单能力元数据；超时/大小/回调/应用身份核对、短缓存与每次启动重查。Client ID/Secret、上游原对象、个人资料和令牌不传 Web。
- 显式关联保留原 owner：重新核对本机密码，授权后不迁移/覆盖原记录。不按邮箱、手机号或昵称自动认领。
- 管理入口重新证明**已经关联**的精确主体，再跳转固定 Casdoor 账号中心；选错主体拒绝，不建立绑定、不替换 BetterMe 会话。外部-only 账号不被要求输入不存在的本机密码。
- 所有启用 OAuth 源必须显式关闭自动合并（`bindingRule: []`），包括四个按钮之外的源。`provider_hint` 只作界面提示，不当作实际平台的签名断言。
- 保留签名 JWT、issuer/audience/nonce/state/PKCE、当前会话/预期 owner、单次流程、换号/退出失效、限流和离开前写入保护；账号代次变化拒绝迟到导航。

## 自动验证

| 检查 | 最终结果 / 范围 |
| --- | --- |
| 定向身份/OIDC/社交服务与 Web 回归 | 30/30 通过，0 失败。覆盖四渠道、同 owner、跨账号拒绝、管理选错主体、外部-only 管理、原生密码校验、离开前保护、锁定恢复、旧代次与恶意授权 origin。 |
| 通用非浏览器回归 | 349 个文件，3649 项：3639 通过、0 失败、10 既有跳过，173.76 秒。 |
| `pnpm typecheck` | 13/13 任务成功。 |
| `pnpm build` | 最终 8/8 任务成功；既有 Atlas `node:fs/path/url` 浏览器 externalization 和大 chunk 警告仍在，没有改阈值或隐藏警告。 |
| `pnpm lint` | `--max-warnings 0` 通过，没有禁用 Hooks 依赖规则。 |
| 新增测试/夹具/脚本额外严格类型检查 | Host 工作目录下 `tsc --noEmit --strict` 通过，覆盖普通项目 tsconfig 未包含的测试及脚本。 |
| 文档交接与差异检查 | `pnpm memory:check`、`git diff --check` 通过，暂存区为空。 |

通用回归沿用根测试 glob 和 4 并发，但排除 4 个独立浏览器文件：`first-run-guide-theme.test.ts`、`jd-browser-session-edge.test.ts`、`jd-browser.test.ts`、`jd-verification-network-edge.test.ts`。它不是完整 `pnpm test` / CI / 跨平台结果；本功能的浏览器验收如下，不以 DOM 测试替代。

目录单测还覆盖：错误 clientId、无凭据、null/默认自动合并、额外不安全渠道、组织/应用停用、微信 Mobile/Web 选择、超大/异常响应、离线、缓存并发与启动时重读。原签名负例继续验证坏签名、issuer/audience/nonce/state、过期/重放及退出后迟到。

## 真实 Casdoor v4.25.0 兼容性

运行新增 `apps/agent-host/scripts/verify-social-casdoor.ts`，复用已校验安装的可执行文件与公开 Web 资源；配置、SQLite、RS256 证书、用户与动态端口全部放在自建临时目录。

- 实际 `/api/get-app-login` 返回经验证的当前应用；四个虚构 provider 被识别为已配置，响应不暴露秘密。
- 四个 OIDC start 均生成真实 Casdoor 的授权入口，带正确 `provider_hint`、state/nonce 与 S256 PKCE，入口页面/跳转兼容。
- 完成后仅清理自建子进程与临时目录，未读取或写入已安装账号库。
- 使用虚构平台凭据，**未调用真实微信/QQ/GitHub/Google 授权**；此项不能证明平台应用审核、密钥、二维码或供应商网络可用。

## 真实浏览器验收（合成身份）

使用独立 Playwright `betterme-social` 临时浏览器会话与 5383/5389，自建签名 OIDC 身份源、内存 checkpoint、独立账号和 owner 存储。没有读取正常浏览器 profile、真实简历、岗位或模型配置，没有调用模型/付费服务。

1. 创建合成本机 Alice，保存 Alice-only 职业记录；空密码点击 GitHub 关联被浏览器原生 required 阻止。
2. 核对合成本机密码后经 GitHub 入口关联 Synthetic Alice，返回原 owner 和原记录；退出，再从 Google 入口授权 Synthetic Alice，仍返回同一 owner 与原记录。
3. 管理重认证选择 Bob 返回明确拒绝页面；回到工作台仍是 Alice 与原记录。正确选择 Alice 到达合成账号中心，返回后原身份不变。
4. 退出，从 QQ 入口首次授权 Bob，得到不同 owner 和空白记录；界面显示第三方账号、本机密码未设置、统一身份已关联，仍可管理，没有无法完成的密码表单。
5. 微信入口取消授权返回清楚的未完成说明，不切换账号。离线时四按钮禁用、本机登录仍可用；恢复并单独停用 GitHub 时仅该入口停用，手动重新检查生效。
6. 1440×1000 桌面、390×844 与 320×640 小屏、明暗主题检查；小屏改为单列，四按钮均 48px，刷新为 44px。320/390 的页面宽度等于视口，无横向溢出，长页面可在登录区滚动。

截图为合成配置，不表示实际平台已开通，产物在 `output/playwright/social-login-desktop.png`、`social-login-mobile.png`、`social-login-dark.png`、`social-login-offline.png`。拒绝/取消回调预期 HTTP 400；早期夹具 favicon 404 已通过空 favicon 修正，最终登录页无意外运行时错误。

验收完成已关闭自己的浏览器会话，停止自己的 5383/5389/虚构 IdP，确认相关端口释放、自建临时目录已删除。没有关闭用户原页面或清空浏览器数据。

## 范围与保护

工作目录是既有 `better-me-agent-os`，分支仍为 `agent-os`，HEAD 保持 `1668ecfce4bb57f4180d3c47f8bb2d5f62777732`。没有暂存、提交、推送、创建分支、更新 Docker、重跑旧资料迁移或替用户关联真实账号。开始时有 139 条 dirty 状态，既有岗位/写作/能力规划改动不纳入本批。

本批 25 个路径：

- 契约：`packages/agent-contracts/src/index.ts`、`social-login.ts`。
- Host：`src/server.ts`、`src/identity/{service,oidc,social-login}.ts`；测试 `oidc-http.test.ts`、`social-login.test.ts`、`social-login-http.test.ts`、`fixtures/social-idp.ts`；脚本 `scripts/verify-social-casdoor.ts`。
- Web：`src/lib/identity.ts`、`src/components/{IdentityGate,CasdoorAccess}.tsx`、`identity.css`；测试 `social-login.test.tsx`、`social-login-preview.ts`、`ui-lab/social-login.{html,tsx}`。
- 文档：本报告、设计、`docs/casdoor.md` 与 `.agent-memory/{activeContext,progress,decisionLog}.md` 的短交接。

部分身份文件本来就在未跟踪目录，不能把整目录或 `git diff --stat` 当成本批新增；最终提交需按路径/差异人工分离既有内容。基线指纹检查只覆盖采样到的 137 个普通文件，不递归证明原未跟踪目录或私人数据不变。

最终基线读回：124/137 文件指纹一致，10个变化位于本批范围，另3个文档（`.agent-memory/projectbrief.md`、`CONTEXT.md`、`docs/planning/personal-career-os-2026-11-04.md`）在本轮期间变化；本批未写这3个文件，按并行/用户工作保留，不归入社交功能、不回退。没有基线文件缺失，也不声称所有无关指纹完全不变。3个交接文件本来混有其他工作，不能把其完整diff都当成本批。

运行现场只读收尾：正常 5178（PID 38562）与 5179（PID 80099）仍监听；5173 与 18000 未监听，原 5173 PID 已不存在，未从现有证据判断其退出原因，也未替用户重启/接管。源码/构建不等于当前正常 Host 已加载本批路由。后续体验需先保护原页面草稿，再按既有正常启动与 Casdoor 路径加载新代码；不得杀死未知服务以抢端口。

## 未完成边界

- 四家真实平台的有效应用、审核、域名/HTTPS、凭据、首次与再次授权及真实解绑/找回策略。
- 正常环境重启加载与发布/远端 CI；本批只在本地验证，没有生产发布结果。
- 公网 SaaS、多实例/反向代理专项安全、跨浏览器自动同步、密码找回、业务平台权限与邮件/短信供应商；这些不随社交登录自动交付。

下一步按 `docs/casdoor.md` 逐个平台在受保护管理端开通并执行真实验收，密钥不发聊天、不写 Git。已有资料的本人先使用原 BetterMe 账号，再显式关联，不能通过新建同名账号找回资料。
