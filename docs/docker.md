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
| 项目理解、动态追问、共识确认与历史恢复 | 支持，独立会话持久保存在 `/data/agent/runs/understanding`；逐轮同意后调用配置模型 | 同左，支持显式授权的本机文本目录/文件 |
| 统一 Agent 侧栏、贡献认领、旁批候选、8 节协作教程 | 正式 Web 构建包含；教程不发模型请求、不改自动保存偏好 | 同左 |
| Agent 记录 JSON 备份与只读追加恢复 | 当前浏览器操作，不在 Docker 卷中 | 同左；不恢复文件授权、不重发任务 |
| Agent Host、对话、工作流 | 自动启动；模型需单独配置 | 自动启动或复用 |
| SQLite 岗位索引、公开来源 API、入库和后台补全 | 支持，保存在卷内；网络/来源许可仍限制覆盖 | 支持 |
| 原站登录、验证码、专用 Chrome/Edge 窗口、扩展同步 | 不提供；使用粘贴 JD 或宿主机开发模式 | 依赖本机浏览器及人工完成验证 |
| 本机 Claude / Codex CLI | 镜像不安装、不冒充可用 | 取决于本机实际安装与授权 |
| 自动修改简历事实、自动投递、购买额度 | 不自动执行 | 不自动执行 |

旧的 `/api/jd/*`、`/api/network/*`、`/api/opportunities/*` 浏览器工具不是独立岗位服务的 `/api/v1/*`。容器对不支持的旧工具返回明确的 501 提示，不把它伪装成零岗位或已成功采集。容器模式也不会持续轮询浏览器扩展接口。

### 项目理解的资料授权

现有简历伴写中的「先对齐项目理解」已包含在完整 runtime 镜像中。问题与选项由所选模型生成，支持自由纠正、不限制对话轮数；只有当前版本经过用户确认，才可按需作为术语背景交给伴写。会话不会自动写入简历或岗位库。

Docker 内填写的路径指**容器内路径**，不能直接读取宿主机的 `/Users/...`、虚拟机 C 盘或本机 Agent。默认 Compose 不挂载任何业务项目、个人资料或 CLI 登录态。需要读取宿主机文本材料时，先选择一个最小的、去敏后的专用目录，再由你自行在 Compose override 中添加明确的只读挂载，并在产品内逐个授权；不要挂载整个用户目录、Docker socket、密钥目录或个人浏览器。只读挂载不是发送模型的同意，取证仍需 Broker 校验和逐轮明确同意。

镜像不安装原生 Claude/Codex/Gemini CLI，不能把宿主机的安装或登录状态宣称为容器能力，也不会自动复制认证文件。宿主机原生 Agent 的严格适配范围与未验证能力见 [本轮功能记录](reports/project-understanding-2026-11-01.md)。

「模型与工具」分别展示推理来源与受控阅读工具，能力列表由当前容器的 Agent Host 返回。默认容器列表为空是正确状态，不会偷偷改用宿主机工具或付费 API。宿主机模式当前严格原生阅读适配为 Claude Code；其他已安装 CLI 不因被发现就能参与受控取证。

## 国内平台投递行动卡与手机边界

正式 Web 构建包含 BOSS、51job、猎聘的投递准备、本人核对、站内待办和本人回执，入口是「机会 → 岗位详情 → 国内平台 · 投递行动卡」。不依赖模型或设备桥接，runtime 与 static 均可使用。具体行为见[使用说明](domestic-delivery.md)。

行动卡、材料核对快照和回执随机会库保存在当前浏览器，不在 `/data` 卷里。升级前在原浏览器导出机会库 JSON；更换访问端口不会自动带走原资料。当前不提供手机采集、OpenCV 点击、后台推送或自动发简历，也不挂载 USB、ADB、宿主机浏览器与 Docker socket。

Compose 支持显式指定镜像名，便于独立验收不覆盖日常 `better-me:local` 标签：

```sh
BETTER_ME_IMAGE=better-me:delivery-check BETTER_ME_PORT=8082 \
  docker compose --project-name betterme-delivery-check up -d --build --wait
```

这个命令使用独立项目与独立数据卷，不迁移日常资料；8082 也是新的浏览器存储空间。确认端口空闲后再运行。常规更新保持原项目名与 origin，先备份再按下文步骤重建，不运行 `down --volumes`。

自动验收 `node scripts/check-docker-runtime.mjs` 默认使用随机独立镜像标签、项目、端口与临时卷，不覆盖普通工作台镜像；它只移除本次创建的测试容器和测试卷。

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
| 浏览器内当前简历的 Agent 空间 | 对话/共识索引、任务、成长事件；输入草稿与工具偏好也留在浏览器 | 侧栏「共识与进度 → 记忆保存、备份与恢复」下载记录；未发送草稿不含在记录备份中 |
| Docker 命名卷 `/data/jobs` | 岗位 SQLite、来源配置、岗位服务 token | 停止应用后备份完整卷 |
| `/data/agent` 与 `/data/agent.token` | Agent checkpoint、运行记录、凭据 | 同上；运行记录可能含发送过的简历片段，按私人数据保护 |
| `/data/agent/runs/understanding` | 项目理解的历史、授权、证据快照和共识确认，不含模型 Key | 随完整卷备份；撤销授权使共识失效，但不等于抹除审计历史或撤回提供商已收内容 |

```sh
docker compose down
# down 保留命名卷；不要把 down --volumes 当作普通重启。
git pull --ff-only
docker compose up -d --build --wait
```

需要追溯镜像版本时，可以在干净的发布快照内用 `VCS_REF=$(git rev-parse HEAD) docker compose up -d --build --wait` 构建；镜像的 `org.opencontainers.image.revision` 标签记录该值。不要从混有其他未提交改动的工作目录构建后将其称作已提交版本。

更新前先导出浏览器 JSON，再停止应用并通过 Docker Desktop 卷管理或自己的备份流程复制完整卷。不要在线只复制 SQLite 主文件而遗漏 WAL/配套文件。恢复必须保留卷内容与权限，并使用相容的程序版本；回滚镜像不等于回滚数据 schema。容器没有挂载原项目的私人数据库，既有宿主机数据不会自动迁移。

Agent 记录导入先预览、再追加为只读档案，不覆盖当前简历、岗位、目标或模型。旧共识未共享且需重新确认，源码授权不恢复，历史不自动发送给模型，也不恢复执行。浏览器断连可重连重试保存；多窗口版本冲突先保留并下载本页记录，不通过清数据或覆盖远端解决。浏览器 JSON 与 `/data/agent/runs/understanding` 的完整项目会话是两份不同备份，缺一不能声称完整迁移。

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

后两项需要可用的 Docker daemon。完整运行验收使用随机独立 Compose 项目、端口和临时卷，检查同源鉴权、Agent/岗位 API、项目理解会话与授权撤销、真实 SQLite 写入、进程崩溃重启以及重建持久化；不调用外部模型，不挂载宿主机业务资料。只清理测试自己创建的项目和测试卷，不操作常用工作台数据。CI 已加入这两项，配置工作流不等于远端运行已经通过。此前运行验收见 [验收记录](reports/docker-runtime-2026-10-30.md)，本次功能验收见 [项目理解记录](reports/project-understanding-2026-11-01.md)。
