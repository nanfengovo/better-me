# 跨环境部署与统一登录 · 2026-11-05

## 交付范围

按本人确认保留本机账号、原 owner/资料目录与显式关联规则，补管理员统一身份部署。普通用户只选已开通的登录方式，不安装 Casdoor、不申请平台应用、不输入平台密钥。当前项目实际为 React/Node/TypeScript，不按早期粘贴的 ABP/Vue 假设重写。

- 开发 Host 与正式 Node/Docker runtime 共用 `local / auto / unified` 配置加载器，兼容原私有 JSON，支持服务端环境及 secret 文件；配置错误、上游离线不阻断原本机登录。
- 正式入口实际加载 OIDC；配置固定 HTTPS public origin，浏览器接受精确同源 runtime，反向代理 Host/Origin 严格核对，不从任意 forwarded header 推断回调。
- Web-only Compose 不依赖 Casdoor；额外 overlay 只挂本客户端 secret。另提供独立运营方身份 Compose、新目录初始化命令和 TLS 代理示例，普通用户不运行这些操作。
- 初始化只接受仓库外不存在的目录，0700/0600、独立随机密码/客户端密钥、首次生成专用签名证书、NewOnly 与持久卷；拒绝覆盖旧实例，不复制已有账号或平台凭据。
- 登录页仅展示当前可用渠道；未开通渠道不再显示为一排灰色主按钮。管理员可运行脱敏诊断，应用健康与身份就绪分开。

具体配置、权限、两层回调、备份和模式切换见 [唯一部署操作指南](../deployment-auth.md)。没有数据库 schema 或账号/资料迁移，没有按邮箱、手机号、昵称合并。

## 已观察的本地验收

| 验收 | 结果与边界 |
| --- | --- |
| 先红后绿 | 新配置加载、正式 HTTPS bootstrap、浏览器 HTTPS 接入、未开通/离线按钮五处先失败，再实现通过 |
| 登录部署专项 | 21/21，覆盖旧 JSON 不变、冲突/缺失安全诊断、secret 文件、HTTPS 与陌生 Host 拒绝、UI 与显式关联 |
| 真实正式 Node 入口 | 子进程、随机端口、全新临时目录；先注册合成本机账号再切统一模式，用户行/owner/合成资料字节保持；显式关联、上游离线及配置缺失后的本机登录均通过 |
| 真实 Casdoor v4.25.0 | 只复用已安装二进制及公开 Web；全新临时配置/库/签名密钥，真实授权码、PKCE、RS256/JWKS、显式关联与再次登录回同一合成 owner 通过；没有读取原 Casdoor 私有配置或账号库 |
| Compose 配置 | 实际 Docker Compose CLI 解析两个部署模板，secret 值不进入渲染配置；没有启动 daemon、下载或运行容器 |
| 完整测试 | 原工作区及保留远端032d023修改的隔离发布副本均为3817项：3807通过、0失败、10既有跳过；合并副本额外正式runtime9/9通过 |
| 类型/静态/构建 | 全量类型 13/13、零警告 lint、生产构建 8/8；额外脚本和测试 strict TypeScript 通过（使用仓库 Web 的 Bundler 解析规则） |
| 隔离浏览器 | 独立 `.localhost` 域名、专用浏览器会话及临时库；可用渠道筛选、取消安全页、本机注册/保存、GitHub 合成显式关联、Google 合成再次登录 owner/记录不变、身份离线本机登录、恢复入口通过；桌面浅色与 390×844 暗色截图实看，手机文档宽度等于视口390，无横向溢出。测试浏览器/服务和临时库已收尾 |

浏览器只使用自签名的虚构身份源，不是 GitHub/Google 供应商验收。一次离线文案定位写错导致测试等待超时，读回实际页面后用准确文案复验通过，产品并未故障；授权取消的 HTTP400 为预期拒绝页面，虚构 IdP 的 favicon404 不属于产品错误。截图仅在忽略的 `output/playwright/`，不把浏览器 profile、Cookie、真实资料或密钥提交。

## 复现入口

```sh
pnpm exec tsx --test apps/agent-host/tests/identity-deployment.test.ts apps/agent-host/tests/identity-bootstrap.test.ts apps/web/tests/runtime-gateway.test.ts apps/web/tests/runtime-identity-deployment.test.ts apps/web/tests/social-login.test.tsx
node --import tsx apps/agent-host/scripts/verify-identity-compose.ts
pnpm memory:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

已安装原生 Casdoor 的管理员可另运行 `node --import tsx apps/agent-host/scripts/verify-identity-deployment.ts /absolute/public/casdoor /absolute/public/web`，两个参数为已验证公开程序和包含构建页面的公开静态目录。仅生成/清理本次临时库，脚本不会下载程序或读取旧私有配置；缺少参数会安全拒绝。可选浏览器夹具见 [Casdoor 隔离验收说明](../casdoor.md)。

## 合并与发布边界

本人追加授权推送后，在独立发布副本获取远端 `agent-os`。核对远端 `032d023` 包含原分支新增的 Vite 预览 host、代理 Origin 和会话 Cookie 修复；它们完整保留，与本批代码没有文件冲突。正式 runtime 仍使用独立同源安全边界，不把开发预览代理当公网认证服务。

只纳入本功能代码、部署模板、测试、操作指南及本批交接片段；既有未发布 Microsoft 操作报告、旧渠道配置补充和其他并发发布回执仍留原工作区。没有新分支、强推、改 main、上传秘密、读取真实简历或迁移账号。运行中工作区不直接 pull/覆盖 Vite 配置，不刷新原页面或重启正常服务；合并结果在发布副本验证并正常推送原 `agent-os`。

CI 增加 Linux 部署 overlay 脱敏解析；实际 runtime 容器验收增加镜像内 `auth:check`，确认没有 Casdoor 也可本机使用。合并后全量、runtime9/9、类型13/13、构建8/8、零警告lint、额外strict及真实独立Casdoor/Compose配置复验均通过，发布清单恰有39路径，未命中真实token/私钥格式扫描。最终发布提交与该SHA的Windows/Linux/Docker CI以本批完成回执为准，不能用上次发布CI或本机配置解析代替。

## 未声称完成

本轮未启本机 Docker daemon，未部署公网身份服务器/TLS、注册域名或上传现有本机密钥；真实供应商回调/权限/审核/绑定仍是各自独立门槛。Microsoft 旧回调草稿、GitLab 验证码及 Discord/QQ 本人登录、微信资质/安全流程不因代码发布而完成；不要重建旧 issuer 或覆盖已有库来“开通”。

公网运营仍需管理员确定目标服务器、域名/TLS、受控 secret 注入、备份、限流防滥用与逐平台真实验收。跨环境部署基础补齐不等于所有社交平台已在线开通，也不自动把浏览器本地草稿搬到新域名。
