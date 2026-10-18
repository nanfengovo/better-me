# 免费部署与持续交付

BetterMe 的简历工作台可以部署为静态网站。本仓库选用 **GitHub Pages + GitHub Actions**：沿用现有 GitHub 仓库，无需购买服务器，也无需在仓库填写云服务 API Token。

站点已上线：<https://nanfengovo.github.io/better-me/>。2026-10-18 [首次 Actions 运行](https://github.com/nanfengovo/better-me/actions/runs/39124587077)的质量、构建、部署三个任务全部成功，已完成公网 HTTP 与独立浏览器验收；具体样本和限制见 [上线记录](reports/github-pages-release-2026-10-18.md)。后续发布状态查看 [Actions](https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml)。

仓库首页右侧 **About → Website** 也指向该地址。需要在自己的电脑或服务器运行生产静态版时，可以使用仓库提供的 [Docker 配置](#docker-自托管)。

## 静态站点能使用哪些功能

| 能力 | GitHub Pages 上的行为 |
| --- | --- |
| 简历编辑、Fact 与简历视图、119 套版式、10 套简历主题 | 在浏览器运行 |
| 4 套工作台配色、浅色/深色、界面中英、简历中英字段 | 在浏览器运行；不会自动翻译本人内容 |
| 草稿、自动保存、历史、机会记录 | 保存在当前浏览器的 localStorage / IndexedDB，不包含云账户或跨设备同步 |
| PDF / Word / 图片 / 文本导入、离线规则解析 | 由浏览器处理；扫描件或图片的 AI 转录需要用户配置支持图片的模型 |
| PDF 打印、DOCX、Markdown、RenderCV YAML、JSON 备份 | 在浏览器生成或下载；各格式的排版范围见 README 与模板说明 |
| AI 分析、OCR、模型列表 | 用户自行配置服务地址、模型及 Key；浏览器直接请求服务商，受服务商 CORS、网络和额度限制；托管免费不等于模型推理免费 |
| 粘贴 JD、手动保存岗位与原链接、岗位截图识别 | 可以使用；截图识别仍需模型配置 |
| `/api/jd/extract`、`/api/jd/browser-session` | 静态站点不提供；岗位链接抓取与专用 Edge 接续需要本机 Vite 服务 |
| `/api/opportunities/source`、`/api/network/*` | 静态站点不提供；公司源读取、系统代理探测及本地服务选路需要本机服务 |

现有接口通过 Vite 的 `configureServer` / `configurePreviewServer` 提供。它们没有被打包进 `apps/web/dist`，也不是已部署的云函数。Windows 专用浏览器会话还依赖本机 Microsoft Edge、独立 profile 及人工验证窗口。需要完整本地能力时继续使用 `pnpm dev`，不要把 `vite preview` 当作公共生产服务器暴露。

从 `http://localhost:5173` 切换到 GitHub Pages 是更换浏览器 origin，原来的本地简历、历史和 API 配置不会自动搬过去。请先从原站导出 JSON 备份，在新站导入，再自行填写模型配置。清理站点数据或更换浏览器也可能清除本地保存；JSON 备份仍由用户保管。本机 Ollama 的 HTTP 地址在 HTTPS 站点下还受混合内容、CORS 和浏览器本地网络访问限制，不能把本地开发环境连通直接视为线上可用。

## 自动交付流程

工作流文件为 [ci-pages.yml](../.github/workflows/ci-pages.yml)。

```text
本地编辑 → git commit → git push origin main
                         ├─ Windows：安装锁定依赖 → memory 检查 → lint → types → 全量测试
                         ├─ Linux：安装锁定依赖 → workspace 构建 → Pages 子路径构建 → 上传产物
                         └─ Docker：多阶段构建 → 启动容器 → 健康 / HTTP / 授权副本检查
                                        三项都成功 → GitHub Pages 发布
```

**保存本地文件不会直接上线。** 只有提交并推送 `main`，或在 `main` 上手动执行工作流，才会发布。PR 执行质量检查和构建，合并进 `main` 后发布。检查失败时部署任务不会执行，已发布的旧站点继续服务。

Node 固定为 `24.15.0`；pnpm 从根 `package.json` 的 `packageManager` 读取当前 `11.9.0`，通过 `--frozen-lockfile` 安装。工作流只缓存 pnpm 内容存储，不缓存用户数据、API Key 或 `node_modules`。Actions 使用固定 commit SHA；升级时应核对对应上游版本并提交更新。

全量测试在 `windows-2025` 运行，因为现有测试包含合成 Edge 会话和 Windows 行为。Linux 任务验证生产构建；Docker 任务实际运行 Linux 镜像并检查静态服务，**不表示已在 Linux 运行全量产品测试或验证 Windows 原生浏览器功能**。CI 不访问真实招聘岗位、不进行真人登录/验证，也不替代 PDF 逐页视觉检查。

普通任务只有 `contents: read`；仅部署任务持有 `pages: write` 和 OIDC `id-token: write`。部署使用当前运行的构建产物，不接收其他 PR / fork 的产物；不使用 `pull_request_target`，不需要 PAT。构建产物保留 1 天，避免长期积累验收文件与存储。

## 首次启用 GitHub Pages

本仓库已完成以下设置与首次发布；这份步骤保留给复现、迁移或 fork 使用。

1. 打开仓库 **Settings → Pages → Build and deployment**，将 **Source** 设为 **GitHub Actions**。
2. 确认仓库允许 Actions 运行，所引用的固定 SHA 未被组织策略禁止。默认 `github-pages` environment 应允许 `main` 部署；如配置必需审批人，每次部署会停下来等待该审批，按需保留。
3. 将工作流提交并推送 `main`，或在 **Actions → CI and GitHub Pages → Run workflow** 中选择 `main`。
4. 确认三个验证任务及 **Deploy GitHub Pages** 均成功，打开任务输出的站点链接。
5. 在没有私人资料的浏览器环境检查页面、模板、明暗主题、刷新、导入、导出和 PDF worker 资源；再通过 JSON 备份迁移自己的内容。

默认项目路径由仓库名计算为 `/better-me/`，通过 Vite CLI 的 `--base` 编译所有入口、动态模块和 worker 路径。本地开发仍使用默认 `/`，不修改端口和本地服务。先执行完整 workspace 构建，再重新生成 Pages 路径的 Web 产物，因此不会误用 Turbo 中默认根路径的构建缓存。

如果以后改用自定义域名，或将仓库改为 `<owner>.github.io`，在 **Settings → Secrets and variables → Actions → Variables** 新增 `PAGES_BASE_PATH`，值为 `/`，再运行工作流。其他项目路径必须以 `/` 开始、以 `/` 结束，如 `/better-me/`。绑定自定义域名本身的 DNS 和 Pages 设置另行完成；默认 `github.io` 域名免费，不需要先买域名。

## 日常开发与恢复旧版本

```powershell
pnpm install --frozen-lockfile
pnpm dev

# 完成功能后本地验证
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# 明确选择本次文件，避免提交私人材料和本地产物
git add <本次功能文件>
git commit -m "feat: describe the completed feature"
git push origin main
```

建议将较大改动放在功能分支并创建 PR；检查通过、审阅后再合并。可在仓库规则中将三个验证任务设为必需检查；该规则是仓库管理设置，不会仅因加入工作流而自动生效。

需要撤回已发布改动时，优先对相关功能提交执行 `git revert <commit>`，检查后推送 `main`；工作流重新构建并发布回退版本，保留可审计历史。不要强推改写 `main`。回滚程序版本不会回滚访问者浏览器中的简历数据，修改数据 Schema 时仍应保持备份与向后兼容。

## Docker 自托管

Docker 交付生产静态工作台，与上方静态能力表一致。它使用根路径 `/`，与 Pages 的 `/better-me/` 构建分别生成；现有 Vite 本地插件和 Windows Edge 服务不随镜像运行。前端调用这些 `/api/*` 路径时得到明确的 `501` JSON，方便定位能力边界。

### 一条命令构建并启动

安装 Docker Engine 与 Compose v2+，或者启用 Linux containers 的 Docker Desktop，然后在仓库根目录执行：

```bash
docker compose up -d --build
docker compose ps
```

访问 <http://localhost:8080>；健康检查为 <http://localhost:8080/healthz>，模板分发说明为 <http://localhost:8080/legal/>。首次构建需要访问 Docker Hub 与 npm registry。后续修改源代码后重新执行 `docker compose up -d --build`，Docker 会按层复用构建缓存。

默认绑定 `127.0.0.1:8080`，可通过 `BETTER_ME_PORT` 改宿主机端口：

```powershell
# PowerShell
$env:BETTER_ME_PORT = '8081'
docker compose up -d --build
```

```bash
# Bash
BETTER_ME_PORT=8081 docker compose up -d --build
```

日志与停止：

```bash
docker compose logs --tail=100 web
docker compose down
```

Compose 不挂载宿主机源码、浏览器 profile、Key 或数据目录。文档、草稿和机会仍由访问者浏览器保存；历史在浏览器 IndexedDB 中。保持访问地址、端口和浏览器一致时，停止或重建容器不会主动清除这些浏览器资料；清理站点数据、更换设备或地址则需要独立 JSON 备份迁移，模型配置另行填写。

### 不使用 Compose

```bash
docker build --tag better-me:local .
docker run -d --name better-me-web -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 100 --restart unless-stopped better-me:local
```

`docker stop better-me-web` 停止，`docker rm better-me-web` 移除该容器；请按自己实际使用的容器名操作。Compose 会统一管理自身创建的容器，使用 Compose 时直接用 `docker compose down` 即可。

### 构建与运行设计

- **固定工具链与多阶段构建**：Node `24.15.0`、pnpm `11.9.0`、锁文件安装；Node 与 Nginx 基础镜像均固定版本和 manifest digest。最终镜像只包含 Nginx、生产产物与模板分发材料，不包含构建依赖或本机 Node 环境。
- **最小构建上下文**：`.dockerignore` 默认拒绝，只允许所需源码、配置与模板授权文件；`.agent-memory`、`.git`、本机 `node_modules`、备份、环境文件和浏览器目录不发送到 Docker 构建器。不要把私人数据或 Key 写入受版本控制的源码。
- **非 root 只读服务**：Nginx 用户运行，容器内监听 `8080`，临时写入仅在 `/tmp`；Compose 使用只读根文件系统、能力移除与 `no-new-privileges`。`/healthz` 是镜像内置健康检查。
- **浏览器资源**：HTML 重新验证，带哈希资源长期缓存，`.mjs` 使用 JavaScript MIME；缺失资源返回 404，应用页面路径刷新回退首页。该回退不代表产品已经有独立路由功能。
- **授权随分发保留**：`/legal/` 列出逐源 `LICENSE` / `NOTICE`、固定目录和当前适配源码；`/legal/dependencies/` 包含锁定生产依赖及传递依赖的完整许可、版权、来源与哈希清单，缺全文时构建失败。该集合保守包含服务器及可选依赖，不表示它们均在浏览器运行。Rick Osborne 的非商业限制继续有效；根项目整体许可证仍待维护者确定，容器化不改变这些条款。

当前实际验收以 Linux/amd64 为准；基础镜像 digest 支持多个架构，不等于已经验证 ARM 构建。镜像未推送 Docker Hub / GHCR，使用者从源码构建；基础镜像与依赖更新需要修改固定版本并重新验收。

### 更新与 CI 的关系

```bash
git pull --ff-only
docker compose up -d --build
```

GitHub Actions 的 Docker 任务调用 `node scripts/check-docker.mjs`，从干净 checkout 构建镜像、使用随机本地端口启动一次性容器，检查健康、非 root / 只读运行、JS/CSS/PDF worker MIME 与缓存、SPA 刷新、缺失静态资源、GET/POST `/api/*` 以及逐字节授权副本，最后清理它自己创建的容器。该脚本需要 Node 24 与可用 Docker daemon，本机也可执行。

主分支的质量、Pages 构建和 Docker 验收三项全通过才发布 Pages。这个流程**不会自动登录或更新你的 Docker 服务器**；自托管地址、凭据与发布目标尚未配置，先使用上述显式更新命令。若以后需要发布 GHCR 镜像与服务器自动更新，再增加独立目标、版本标签、最小权限和回滚步骤。

### 放到服务器或反向代理后面

服务器上的 Nginx / Caddy 可代理至该服务器 `127.0.0.1:8080`，对外提供自己的 HTTPS 域名；当前配置按域名根路径 `/` 服务。不要直接套用 Pages 的 `/better-me/` 产物，也不要在未重新构建并校验资源路径时挂到任意子目录。默认本机绑定便于本地使用；从另一台机器访问需要自行配置域名、TLS 与反向代理。

容器不提供云账号、数据库或模型额度，也不会把用户浏览器数据写到服务器上。首次迁移和更新前建议保存简历 JSON 与机会 JSON，避免将部署更新误认为资料备份。

## 其他免费方案及取舍

以下限制在 **2026-10-18** 查阅官方文档，后续可能调整；它们是免费层额度，并非永久无条件承诺。

| 方案 | 当前适用点 | 关键限制 / 与本仓库关系 |
| --- | --- | --- |
| **GitHub Pages + Actions（本仓库选用）** | 公开仓库静态站点；无需其他云账户；CI 成功后直接发布 | Pages 发布站点最多 1 GB、软带宽额度 100 GB/月；不适合作为商业 SaaS 托管；不运行现有 Node 接口。公开仓库的标准 Actions runner 分钟免费，大型 runner 与超额存储等另计 |
| Cloudflare Pages Free | 免费静态站点、`pages.dev`、预览部署；未来可替换 | 免费层 Git 集成构建 500 次/月、1 个并发构建、单文件 25 MiB；Functions 单独适用 Workers 限制。Git 集成默认随 push 构建，不会自动等待本仓库 Actions；要严格通过 CI 才发布，应选 Direct Upload 工作流，避免同时启用两套发布 |
| Vercel Hobby | 个人项目的静态 Vite 部署与 PR 预览 | Hobby 限个人非商业用途；有资源与部署额度。接入仓库不会自动把 Vite 本地插件变成云 API，也不能照搬带持久桌面窗口的 Edge 会话 |

免费静态站点适合当前公开演示和本地优先简历功能。若将来需要云同步、账号、多人访问、岗位后端或浏览器会话，应独立设计鉴权、存储和服务部署；这些能力不包含在这次 Pages 配置中。第三方模板继续各自适用 LICENSE / NOTICE，包括 Rick Osborne 的非商业限制。

## 官方依据

- [GitHub Pages 限制与使用范围](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub Actions 计费与免费用量](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub Pages 自定义 Actions 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Vite 静态部署及 GitHub Pages base](https://vite.dev/guide/static-deploy.html)
- [Cloudflare Pages 免费层限制](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Pages Direct Upload 与持续集成](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Vercel Hobby 范围](https://vercel.com/docs/plans/hobby)
