# Docker 本机一键运行

默认 Docker 发行不再只是静态文件：一个容器内包含正式 Web 构建、Agent Host 和 SQLite 岗位服务，通过一个同源入口自动连接。它是个人电脑上的工作台，**不是可直接公开的多用户云服务**。

## 启动

需要 Docker Engine + Compose v2，或已启动的 Docker Desktop（Linux containers）。在包含此功能的源码分支根目录执行：

```sh
docker compose up -d --build --wait
```

打开 <http://127.0.0.1:8080/>。首次构建需要 Docker Hub 和 npm registry；后续构建复用缓存。没有发布预构建的 GHCR / Docker Hub 镜像。

Compose 自动创建专用 `better-me-data` 命名卷，容器以 node 用户运行。Agent 和岗位服务只监听容器内部 loopback；只把网页的 8080 映射到宿主机 `127.0.0.1`。令牌首次随机生成并持久保存，由同源启动脚本提供给页面；无需在界面复制服务令牌。

### 修改端口

```sh
# Bash / zsh
BETTER_ME_PORT=8081 docker compose up -d --build --wait
```

```powershell
$env:BETTER_ME_PORT = '8081'
docker compose up -d --build --wait
```

Origin 会随配置端口一起调整，不需要放宽 CORS。`localhost` 与 `127.0.0.1`、不同端口是不同浏览器存储空间；切换前从原地址导出 JSON 备份，在新地址导入。不要将卷内目录换成空目录来“修复”连接。

## 能力和边界

| 能力 | 默认 Docker runtime | `pnpm dev` / 宿主机 |
| --- | --- | --- |
| 简历、事实、模板、历史、导入导出 | 支持，数据在浏览器 | 支持 |
| 真实编辑器中的主动伴写 | 本地检查支持；模型追问需 AI 配置和同意 | 同左 |
| Agent Host、对话、工作流 | 自动启动；模型需单独配置 | 自动启动或复用 |
| SQLite 岗位索引、公开来源 API、入库和后台补全 | 支持，保存在卷内；网络/来源许可仍限制覆盖 | 支持 |
| 原站登录、验证码、专用 Chrome/Edge 窗口、扩展同步 | 不提供；使用粘贴 JD 或宿主机开发模式 | 依赖本机浏览器及人工完成验证 |
| 本机 Claude / Codex CLI | 镜像不安装、不冒充可用 | 取决于本机实际安装与授权 |
| 自动修改简历事实、自动投递、购买额度 | 不自动执行 | 不自动执行 |

旧的 `/api/jd/*`、`/api/network/*`、`/api/opportunities/*` 浏览器工具不是独立岗位服务的 `/api/v1/*`。容器对不支持的旧工具返回明确的 501 提示，不把它伪装成零岗位或已成功采集。容器模式也不会持续轮询浏览器扩展接口。

## 连接模型

模型不包含在镜像中，也不会自动下载或付费。在工作台「AI 配置」选择模型、地址及需要的凭据。分享或录屏前先检查是否含凭据。

Agent 请求中明确配置为 `http://localhost:11434` 或 `http://127.0.0.1:11434` 的本机 Ollama，会在网关转换为 `http://host.docker.internal:11434`；云服务或其他端口不会被擅自改写。Compose 配置了 host-gateway 映射，具体网络行为见 [Docker 宿主机连接文档](https://docs.docker.com/desktop/features/networking/networking-how-tos/)。

Ollama 必须已经在宿主机运行，并允许来自 Docker 网关的连接；只监听宿主机 127.0.0.1 的服务在部分 Linux 环境下不可达。不要为了连接把模型接口无保护地暴露公网。可使用环境变量 `BETTER_ME_OLLAMA_ENDPOINT` 明确指定容器可达的、自己信任的地址。

此转换只覆盖经 Agent Host 的请求；浏览器直接调用的模型列表、导入/OCR 等功能仍受所配地址的 CORS 与网络限制。宿主机模型不可达不代表岗位数据库损坏。

## 健康检查和自动恢复

```sh
docker compose ps
docker compose logs --tail=100 web
curl http://127.0.0.1:8080/healthz
```

正常返回 `{"mode":"full","status":"ok"}`。网关每 10 秒检查 Agent Host 和岗位 HTTP 服务，连续 3 次失败后有界关闭并退出；Compose 的 `restart: unless-stopped` 随后重新启动。健康检查自身不会让 Docker 自动重启，退出看门狗负责衔接；参见 [Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。

持久卷使用 SQLite 独占租约，进程崩溃后内核会释放。运行期 PID 目录锁放在临时文件系统，避免重建后旧 PID 造成永久“占用”。同时使用同一卷启动第二个工作台会安全失败，不强抢数据或杀死未知进程。

恢复不保证所有来源网络请求、外部模型或招聘网站自动变得可用；登录/验证码仍由用户处理。请保留原始来源回执，部分成功不等于完整覆盖。

| 现象 | 处理 |
| --- | --- |
| `Cannot connect to Docker daemon` / 找不到 docker.sock | 先打开 Docker Desktop 并确认引擎可用；这是启动应用之前的宿主机问题 |
| 基础镜像拉取或 npm 超时 | 检查 Docker 自身的代理/仓库网络，再执行原启动命令；不要替换成来源不明的镜像 |
| 端口占用 | 使用明确的 `BETTER_ME_PORT` 换端口，不强杀未知进程；先备份旧 Origin 的简历 |
| `unhealthy` / `recovering` | 查看本项目日志；等待看门狗恢复，持续失败再手动 `docker compose restart web` |
| Agent 在线但模型失败 | 核对 AI 配置、宿主机 Ollama、模型名或云服务额度；不要删除数据卷 |
| 422 / 部分岗位采集 | 查看业务回执、来源/执行预算；422 不统一等于 token 错误，更不等于数据丢失 |

## 数据、停止、更新和备份

| 位置 | 内容 | 备份方式 |
| --- | --- | --- |
| 当前浏览器 Origin | 简历、事实、草稿、历史、机会、模型配置 | 工作台导出 JSON；模型配置另行保管 |
| Docker 命名卷 `/data/jobs` | 岗位 SQLite、来源配置、岗位服务 token | 停止应用后备份完整卷 |
| `/data/agent` 与 `/data/agent.token` | Agent checkpoint、运行记录、凭据 | 同上；运行记录可能含发送过的简历片段，按私人数据保护 |

```sh
docker compose down
# down 保留命名卷；不要把 down --volumes 当作普通重启。
git pull --ff-only
docker compose up -d --build --wait
```

更新前先导出浏览器 JSON，再停止应用并通过 Docker Desktop 卷管理或自己的备份流程复制完整卷。不要在线只复制 SQLite 主文件而遗漏 WAL/配套文件。恢复必须保留卷内容与权限，并使用相容的程序版本；回滚镜像不等于回滚数据 schema。容器没有挂载原项目的私人数据库，既有宿主机数据不会自动迁移。

默认拒绝公网域名和第三方 Origin；不要仅把端口换成 `0.0.0.0` 后当作安全公网服务。多用户鉴权、TLS、密钥托管、审计与远程隔离需要单独设计。

## 静态模式与验证

仅需静态工作台时可显式构建保留的 Nginx 目标：

```sh
docker build --target static -t better-me:static .
docker run --rm -p 127.0.0.1:8080:8080 better-me:static
```

静态模式 `/healthz` 返回 `mode: static`，不会启动后台服务。两个目标都保留 `/legal/` 的模板和依赖许可证；缺少完整许可时构建失败。

```sh
pnpm test:runtime
node scripts/check-docker.mjs
node scripts/check-docker-runtime.mjs
```

后两项需要可用的 Docker daemon。完整运行验收使用随机独立 Compose 项目、端口和临时卷，检查同源鉴权、Agent/岗位 API、真实 SQLite 写入、进程崩溃重启以及重建持久化；只清理测试自己创建的项目和测试卷，不操作常用工作台数据。CI 已加入这两项，配置工作流不等于远端运行已经通过。实际本轮结果见 [验收记录](reports/docker-runtime-2026-10-30.md)。
