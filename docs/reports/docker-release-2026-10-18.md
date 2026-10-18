# Docker 静态版与仓库入口 · 2026-10-18

本次交付将仓库 About Website 指向 <https://nanfengovo.github.io/better-me/>，增加可从源码构建的 Docker 生产静态版，并把启动、更新、停止及能力边界写入 README 和部署说明。

## 实现与发布批次

- `bacc82e`：多阶段 Dockerfile、默认拒绝的构建上下文、Compose、非 root Nginx、健康检查、资源与接口响应、模板及生产依赖许可分发。
- `d7bdf1f`：真实 Docker 构建和容器 HTTP 检查加入 Actions；质量、Pages 构建和 Docker 三项全部成功后才部署 Pages。
- 文档批次：README、部署说明、路线图及本报告；具体最终状态查看 [工作流](https://github.com/nanfengovo/better-me/actions/workflows/ci-pages.yml)。

新增容器验收的 [真实 Actions 运行](https://github.com/nanfengovo/better-me/actions/runs/39126393123) 对应 `d7bdf1f`，Windows 质量检查、Linux Pages 构建、Docker 构建运行及 Pages 部署四个任务全部成功。后续文档提交同样触发工作流，最新提交状态以 Actions 为准。

## 本机真实构建与容器

环境为 Windows Docker Desktop 的 Linux/amd64 引擎。固定 Node `24.15.0`、pnpm `11.9.0` 和 Nginx `1.30.6-alpine`，基础镜像使用固定版本与 manifest digest。

| 项目 | 实际结果 |
| --- | --- |
| 锁文件安装与生产构建 | 安装 257 个包，`pnpm build` 三个任务全部成功 |
| 最终本地镜像 | `better-me:local`；inspect 大小 29,834,978 字节，约 28.5 MiB |
| 本地镜像 ID | `sha256:ef593846b8bd947693e6968e6bb71b19e637585ac8fd609a69caf65c1565ef98` |
| BuildKit 实际上下文导出 | 263 个文件、2,458,222 字节；包含 93 个模板授权文件，无 memory、环境、备份、profile、测试、日志或本机 dist/node_modules |
| Nginx 配置 | 真实非 root、只读容器中 `nginx -t` 成功 |
| 实际 Compose 服务 | `127.0.0.1:8080`，健康，UID 101、只读根文件系统、临时 `/tmp`、移除全部 capability、禁止提权、PID 上限 100 |

Compose 默认只在本机提供网页，无资料卷、浏览器 profile 或服务器端用户数据库。没有操作原开发服务或其他已有容器。ARM 尚未实机验收；固定基础镜像支持多架构不能代替该验收。

## HTTP 与分发检查

`node scripts/check-docker.mjs --image better-me:local --skip-build` 对上述镜像执行 208 次 HTTP 请求，全部通过；它创建的随机一次性容器已清理，Compose 服务保留供本机使用。

- 健康检查、首页与深路径刷新；HTML 不缓存，带哈希资源使用一年 immutable 缓存。
- 5 个实际资源、2 个延迟 JS 模块、1 个 PDF worker；JavaScript、CSS、`.mjs` MIME 正确，应用引用指向已分发资源。
- 缺失静态资源返回 404；GET/POST `/api`、`/api/jd/extract`、`/api/network/status` 返回 501 JSON，说明需要本地服务。
- 96 个模板许可及目录文件、20 个适配源码逐字节匹配工作区；缺失许可路径为 404。
- 69 个生产依赖、71 个完整许可文件通过 HTTP 与 manifest SHA-256 校验。该集合是生产依赖超集，包含服务器和可选依赖，不能据此判断它们均在浏览器运行。

依赖许可收集从锁定 workspace 生产图生成；React、React DOM、lucide、docx、mammoth、pdfjs、zod 有必需覆盖检查。原包将完整许可放在 README 时保留原 README；明确缺独立许可文件的少数固定版本使用可追溯原文，遇到未知缺文包则构建失败。boolbase 1.0.0 的固定上游许可有 commit 与 SHA，且精确 `-text` 属性保证 Windows 自动换行不会破坏原文字节；暂存后以 `core.autocrlf=true` checkout 再校验 SHA 相同。

## 实际浏览器范围

在新 Docker 地址使用内置合成示例验证网页挂载、编辑部版式、暖调编辑部主题、藏蓝工作台和深色切换，手动保存并刷新后选择保留，纸张仍为 `rgb(255,253,248)`、正文 `rgb(41,39,37)`。JSON 下载实际生成文件并回读，确认 `templateId=editorial`、`themeId=editorial-warm`。浏览器捕获的 warn/error 日志为空。

额外的合成 PDF 文件导入被 Chrome 扩展的“允许访问文件网址”设置阻止，文件未进入应用，因此**本次没有完成 Docker 地址下的实际 PDF 文字提取**；未更改扩展权限。worker 资源和 MIME 的 HTTP 验证已完成，先前 Pages 的实际合成 PDF 验证见 [Pages 上线记录](github-pages-release-2026-10-18.md)，两项证据不混为同一次验收。下载事件监听超时后，已从实际下载文件核对结果，没有仅凭点击就声称下载成功。

截图、构建日志、上下文清单和本机回执留在 Git 忽略的本地验收目录，不分发用户资料。此轮没有重做全部模板长文打印、DOCX 逐页视觉、真实模型或招聘站验收。

## 使用与后续边界

```bash
docker compose up -d --build
# 打开 http://localhost:8080

# 更新
git pull --ff-only
docker compose up -d --build

# 停止
docker compose down
```

完整说明见 [README](../../README.md#docker-部署) 和 [Docker 自托管](../deployment.md#docker-自托管)。静态容器不提供现有 Node 岗位接口与 Windows 专用招聘浏览器；数据属于当前浏览器 origin，变更地址或端口应先备份迁移。镜像未发布 Docker Hub / GHCR，当前 CI 不更新未配置的远程 Docker 服务器。模板各自的许可、Rick Osborne 非商业限制和根项目整体许可证尚未选定的状态继续适用。

## 附录：岗位地图与来源工具分发复核 · 2026-10-18

本附录记录新增地图、来源工具及来源标签接线后的本机分发检查，保留前文历史结果。`pnpm build` 六个 workspace 任务全部成功；正常根路径产物和 `/better-me/` 子路径产物均通过 `node scripts/check-atlas-distribution.mjs <产物目录>`。公开地理目录精确包含 13 项，三份 GeoJSON 与其来源 manifest SHA-256 一致，独立 ESM MapLibre worker 为 518,806 字节且与锁定包原文件逐字节相同。

本次正常 `node scripts/check-docker.mjs --image better-me:atlas-sources-check` 在编译前被 Docker Hub frontend 匿名认证网络超时阻断。随后仅在 Git 忽略目录创建 Dockerfile 临时副本，省略第一行 `# syntax=docker/dockerfile:1`，其余正文与仓库文件一致；通过 `docker build --pull=false --file <临时副本> --tag better-me:atlas-sources-check .` 完成实际 Linux 构建。两个 digest 固定基础镜像、安装锁文件及全部构建步骤不变，仓库 Dockerfile、系统代理和 DNS 未改。这一结果不冒充正常 frontend 联网路径或远端 Actions 成功。

实际镜像 `sha256:9154b99c6ea48beb56eb12275fe36eeabcf81b1af4a704d2055f459e00004fb8`，`linux/amd64`，inspect 大小 31,122,064 字节。`node scripts/check-docker.mjs --image better-me:atlas-sources-check --skip-build` 在随机本机端口启动专用临时容器，**269/269 HTTP 请求通过**；UID 101、只读根文件系统、健康状态正确，完成后仅移除该检查容器。

- 18 个实际资源、8 个延迟模块、各 1 个 PDF / MapLibre worker；`.mjs` JavaScript MIME、缓存、缺失资源 404 与静态 `/api` 501 边界通过。
- 13 项公开地理文件按白名单逐字节校验，渲染 GeoJSON 对照 manifest SHA 校验。
- 96 项模板许可及目录文件、20 项改编源码逐字节相同；95 个生产依赖、97 份完整许可原文和 manifest SHA-256 全部通过 HTTP 校验。
- 来源工具作为独立延迟模块发布。Pages 构建的 9 个 JS chunk 均没有 `node:` import 或 Vite Node 外部模块占位；纯 `@better-me/source-adapters/browser-contracts` 不携带 Node transport。

起始检查快照覆盖 340 个构建相关文件，聚合 SHA-256 `5eea46cbf7c28e17722f7c663446dc64748fc3b3c1b9c8f2e4e62565ba370583`。检查结束快照 `23ea84813acc39da5dc58a4da252cfb4c847432c8f6049623fecb858147818d1`；期间 `JobSourceBadges.tsx` 和 `JdMatchModal.tsx` 有并行 UI 变更，前后逐文件 hash 单独留存，未因界面文案变更机械重做整个 Docker 验收。因此这里标注检查快照，不将其说成后续所有修改均已重新进入镜像。MapLibre 渲染源码 SHA-256 仍为 `f3cd266ef19ead9cb69fd4dfc57588a867134c5eb400717b2554078bb5e22fbc`。

命令、完整构建日志、初次 registry 失败日志、临时 Dockerfile、镜像 inspect、两次源码清单及容器前后清单保存在 Git 忽略的 `.agent-memory/.tmp/atlas-sources-distribution-2026-10-18/`。原 `agent-web-1`（本机 8080）与 SQL Server 容器 ID、镜像及端口保持相同。本轮只验证本机构建 / HTTP / 分发，不代表公网已经更新，也未重做实际浏览器视觉、在线地图可用性、全部模板打印或真实岗位覆盖。既有大 JS chunk 提示继续保留。

本附录现固定为**来源工具阶段的已验历史快照**。用户随后反馈搜索 / 筛选行为不足，已开始新的腾讯真实国内远程搜索、主搜索入口及覆盖范围提示修订；这些新改动尚未包含在上述 Pages / Docker 检查中。后续必须以新的定点源码检查记录为准，当前结果不称为整个岗位搜索目标的最终验收。
