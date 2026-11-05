# 统一登录：使用与部署

本批实现与隔离验收证据见 [交付报告](reports/deployment-auth-2026-11-05.md)；以下为操作指南，不把测试就绪当成生产渠道已开通。

## 普通用户

直接使用 BetterMe 本机账号，或选择部署方已开通的社交登录。无需安装 Casdoor、申请 OAuth 应用或填写平台密钥。身份服务离线时仍可使用原本机账号；只有外部登录方式的账号需等身份服务恢复，不会被自动分配替代身份。

已有资料先用原账号登录，再在「登录方式与账号关联」中核对本机密码并显式关联统一身份。不按相同邮箱、手机号或昵称合并。更换网站域名、浏览器或电脑不会自动搬运本地草稿、模型配置或账号资料。

## 部署管理员：选择模式

| 模式 | 设置 | 行为 |
| --- | --- | --- |
| 保持现有安装 | 不设置，默认 `auto` | 兼容原私有 `oidc.json`，不存在时使用本机账号；不改 issuer、owner 或资料目录 |
| 仅本机账号 | `BETTERME_AUTH_MODE=local` | 不读取 OIDC 密钥、不连接身份服务；保留原绑定和账号，不删除任何记录 |
| 在线统一身份 | `BETTERME_AUTH_MODE=unified` | 由管理员提供现有身份中心与本部署客户端；配置错误或上游离线仍保留本机登录 |

Web 开发入口和正式 Node/Docker runtime 使用同一配置加载器。静态 Pages 不含认证后端；临时预览域名也不自动获得平台授权。真实授权使用固定开发域名或正式 HTTPS 域名，不使用通配回调、共享 AppID 或公共扫码中转。

### 接入已经存在的身份中心（推荐）

继续使用原 Casdoor issuer、账号库与签名密钥；为每个 BetterMe 部署登记自己的客户端和精确回调。当前渠道目录适配 Casdoor v4.25.0 的公开应用目录，不宣称可直接替换任意 OIDC 产品。

两种配置来源二选一：

1. **现有私有 JSON**：设置 `BETTERME_OIDC_CONFIG=/absolute/private/oidc.json`，结构沿用 `issuer`、`clientId`、`clientSecret`、`callbackUrl`、`allowLoopbackHttp`。保持 0600 和单文件，禁止链接到公开或源码目录。
2. **部署环境 + secret**：设置下表中的非秘密配置，把客户端密钥通过 `_FILE` 或部署平台的服务端 secret 注入。不得混用 JSON 与字段配置，也不得同时设置密钥文本和密钥文件。

| 服务端变量 | 用途 |
| --- | --- |
| `BETTER_ME_PUBLIC_ORIGIN` | 精确 BetterMe origin，例如 `https://betterme.example.com`；不带路径、查询或凭据 |
| `BETTERME_OIDC_ISSUER` | 管理员控制的固定身份 issuer，例如 `https://identity.example.com` |
| `BETTERME_OIDC_CLIENT_ID` | 该 BetterMe 部署的 OIDC client ID |
| `BETTERME_OIDC_CLIENT_SECRET_FILE` | 私有文件或 secret mount 的绝对路径，推荐；只由后端读取 |
| `BETTERME_OIDC_CLIENT_SECRET` | 不支持文件挂载的平台可用服务端 secret 注入；不要写入命令行、示例或前端环境 |
| `BETTERME_OIDC_ALLOW_LOOPBACK_HTTP` | 仅隔离本机开发设 `true`；不会允许外网 HTTP |

字段配置根据 public origin 派生唯一回调 `/api/v1/agent/identity/oidc/callback`；JSON 配置若同时指定 public origin，两者必须一致。Host/反向代理请求头不会决定 issuer 或回调。

`auto` 模式的旧默认路径保持原样。新 Linux/Windows/macOS 部署请显式设置 `BETTERME_OIDC_CONFIG`，或使用字段配置，不依赖个人 Mac 目录。原生正式运行另设置私有 `BETTER_ME_DATA_DIR`，构建后执行 `node --import tsx apps/web/server/runtime-server.ts`；账号目录仍沿用该入口原位置，不与开发账号目录自动合并。

### Docker 接入现有身份服务

管理员在仓库外准备 `deployment.env`，只包含模式、public origin、issuer、client ID、**宿主机密钥文件路径**。密钥本身放在受保护的独立文件，不能放进该 env、Dockerfile/build args、VITE 变量或 Git。

```sh
docker compose --env-file /absolute/private/deployment.env -f compose.yaml -f compose.oidc.yaml config --quiet
docker compose --env-file /absolute/private/deployment.env -f compose.yaml -f compose.oidc.yaml up -d --build --wait
docker compose --env-file /absolute/private/deployment.env -f compose.yaml -f compose.oidc.yaml exec web node --import tsx apps/agent-host/scripts/check-identity.ts
```

`compose.oidc.yaml` 仅给 Web 容器挂载该客户端 secret，不启动或复制 Casdoor。默认网页端口仍绑定宿主机 loopback；由受控反向代理提供 HTTPS。示例见 `deploy/reverse-proxy.conf.example`，需管理员替换域名和证书路径，不能直接安装占位配置。

**文件权限**：Linux 文件型 Compose secret 保留宿主机文件所有权，不能靠 YAML 的 `uid/mode` 字段自动修正。应由管理员/secret manager 将实际挂载文件安全提供给容器 UID 1000（0400/0600，父目录受保护），不要改成全局可写或复制进镜像。Windows 使用受限 ACL，并从实际容器运行脱敏检查。Docker Desktop 的文件共享和权限映射以实际检查为准。[Docker 官方说明](https://docs.docker.com/reference/compose-file/services/#secrets)

非秘密 public origin 必须与代理保留的 Host 一致；网关拒绝陌生 Host/Origin 和任意跨站 API 请求，仅精确 GET OIDC 回调进入既有一次性 state/浏览器 Cookie/PKCE/签名验证。不要暴露开发 token 或直接使用 Vite 作为公网认证后端。

### 脱敏就绪检查

```sh
pnpm auth:check --config /absolute/private/oidc.json
```

不提供参数时使用服务端环境和原默认配置路径；本机模式可设置 `BETTERME_AUTH_MODE=local` 后执行。检查不写账号或配置，输出模式、配置来源、固定状态码和各渠道枚举，不输出密钥、client ID、provider 内部名字或个人资料。

常见结果：`local_only`、`oidc_configuration_missing`、`oidc_configuration_conflict`、`oidc_configuration_invalid`、`oidc_discovery_unavailable`、`oidc_discovery_invalid`、`oidc_catalog_unavailable`、`oidc_login_disabled`、`unified_ready`。非 ready 返回非零；应用基础健康与在线登录就绪分开，身份服务故障不会让本机账号跟着重启。

`unified_ready` 只代表发现/目录和至少一种统一登录方式可用，不是所有渠道已开通，也不是完整供应商登录验收。

## 运营方：可选新建身份中心

只有没有既有身份中心、且明确新建部署时执行。普通用户不执行本节。已有用户库不要运行初始化、换 issuer 或切空卷来修登录。

1. 准备管理员控制的两个固定 HTTPS origin、TLS/反向代理和一个**仓库外尚不存在的目录**，父目录须已存在。
2. 生成新安装配置：

   ```sh
   pnpm auth:identity:init --directory /absolute/NEW-private-identity --issuer https://identity.example.com --app-origin https://betterme.example.com
   ```

   命令仅创建该新目录（0700）和私有文件（0600）；拒绝已有目录、仓库内目录和 HTTP 公网地址。不下载程序、不启动服务、不打开原数据。生成随机管理员密码和不同客户端密钥，具体值只保存在私有文件，不打印；签名证书由 Casdoor 首次插入时独立生成，不使用共享私钥。若写入中断，保留该新目录供管理员检查，不自动覆盖重试。
3. 管理员按上文处理 UID/ACL，使 Casdoor UID 1000 只读访问 `conf/app.conf` 与 `init_data.json`，并妥善保管 `bootstrap.private.json`。不要把整个个人配置目录挂载进容器。
4. 独立部署身份中心：

   ```sh
   docker compose --env-file /absolute/NEW-private-identity/deployment.env -p betterme-identity -f deploy/identity/compose.yaml config --quiet
   docker compose --env-file /absolute/NEW-private-identity/deployment.env -p betterme-identity -f deploy/identity/compose.yaml up -d --wait
   ```

   固定 Casdoor v4.25.0；仅发布 loopback 18000，SQLite/WAL 与日志在独立命名卷 `/logs`，初始化 `NewOnly` 不覆盖已有对象。保持该 project/卷不变，不执行 `down -v`。正式供应链部署应再固定经验证的镜像摘要，升级须备份与回归。
5. 在发布域名之前核对管理员密码、专用证书及恢复策略；用自己拥有的应用配置各平台 provider，最小 scope、空 `Binding rule`，逐家完成回调、审核和真实授权。新生成实例没有预装任何可用社交 provider。
6. 按上节把 BetterMe 接到这个身份中心，运行脱敏检查，再使用专用测试账号验首次登录、原账号显式关联、重复登录、取消、重放、离线和跨账号拒绝。两个后端都要能通过所配置的 HTTPS issuer 访问同一身份服务；不要把 issuer 改成 Docker 内部别名来解决网络问题。

身份平台不能免除供应商开通。平台回调是 `https://identity.example.com/callback`；BetterMe 回调是 `https://betterme.example.com/api/v1/agent/identity/oidc/callback`，两层不能混填。配置要求和真实开通状态分别见 [Casdoor 操作](casdoor.md)、[平台研究](research/social-login-platforms-2026-11-04.md)。部署借鉴 [Casdoor 固定版本配置](https://github.com/casdoor/casdoor/blob/v4.25.0/conf/app.conf)、[证书初始化](https://github.com/casdoor/casdoor/blob/v4.25.0/object/cert.go) 和 [官方容器部署](https://casdoor.ai/docs/deployment/docker/)，没有重新实现 OAuth。

## 数据与上线范围

更改部署配置不迁移 owner、密码摘要、原绑定或资料；本轮没有数据库 schema 迁移。新身份服务会产生新的 `issuer + sub`，不能假定“换 URL”仍是同一个身份。现有外部-only账号先维护原身份服务；需要迁移时另做有备份、逐账号证明和回执的专项流程。不能按邮箱自动合并，也不能为了测试占用真实外部主体。

浏览器 origin 改变会改变本地草稿存储空间。服务端账号/Agent 数据、浏览器草稿/版本、身份库/证书分别备份；配置回退不需要删库或覆盖旧文件。在线身份服务会处理身份资料，但不会因此自动上传简历、迁移模型密钥或继承原生工具权限。

本交付包含跨环境配置、HTTPS 同源网关、可选管理员部署和隔离验收，不替代公网防滥用、灾备、账号找回、容量/多实例及真实供应商资质验收。没有现成域名、TLS、目标服务器与生产凭据时，代码就绪不能称线上统一登录已开通。
