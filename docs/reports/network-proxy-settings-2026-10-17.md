# 网络与代理配置验收 · 2026-10-17

## 交付与范围

针对岗位分享链接无法访问的问题，新增本地服务的网络传输配置。入口位于侧栏 **网络**、JD 分享链接操作区、链接提取失败提示及公司招聘源读取失败提示。

支持三种模式：

| 模式 | 行为 |
|---|---|
| 自动检测（默认） | 按目标协议读取进程环境变量，其次采用 Windows 当前用户系统代理；未配置则直连 |
| 直接连接 | 本应用的岗位请求直接连接，便于对照排查 |
| 手动代理 | 指定无认证 HTTP/HTTPS 代理地址，通常使用代理软件的 HTTP 或 Mixed 端口 |

新增检测、使用候选、绕过地址、草稿连接测试和保存。检测展示来源与端口可达性；端口有响应不能证明它提供有效代理，常见端口候选不会自动接管路由。测试展示实际直连/代理路线、HTTP 状态、耗时和可读错误。测试与“使用此代理”只操作弹窗草稿，保存后才影响后续业务请求。

本配置作用于 Node 本地服务发起的 **岗位链接提取和公司公开招聘源读取**。AI、截图识别及浏览器打开外部链接仍使用浏览器和系统网络设置。未修改 Windows 系统代理、WinHTTP、代理软件规则、证书或系统安全设置。

## 本机实际诊断

- Windows 用户系统代理开启，地址为 `127.0.0.1:7890`，监听进程为 FlClashCore；WinHTTP 为 Direct，当前服务进程环境未发现 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY。
- 原岗位读取使用 Node 原生 fetch，没有读取 Windows 用户代理。浏览器能够访问外站不能证明 Node 的同一请求也使用该代理。
- 用户截图岗位链接 `https://msearch.51job.com/jobs/all/166761768.html`：原生 Node 直连出现 `ECONNRESET`；curl 直连超时，经本机代理仍发生 TLS 握手失败。
- 新代码从 Windows 配置自动选择 `http://127.0.0.1:7890`，实际 Greenhouse 连接测试返回 **HTTP 200**（最终桌面截图为 1337 ms；单次耗时不代表持续性能）。
- 新代码实际执行同一 51job 岗位提取仍失败，显示“通过代理 http://127.0.0.1:7890失败：连接被对端重置……本次没有回退到直接连接”。因此本批不能宣称该岗位已恢复，也不能把原因仅归于是否打开全局代理。
- 通过机会区 **查看公开岗位** 实际读取 Greenhouse 的 Duolingo 招聘源，返回 **63 个岗位**，只做预览，未收藏或写入岗位库。

## 实现

- `apps/web/server/network-proxy.ts`：本地配置读写、系统与环境检测、HTTP/HTTPS 代理传输、固定站点测试和 Vite dev/preview 中间件。
- `apps/web/src/lib/network-settings.ts`：共享配置类型、验证和浏览器 API helpers。
- `apps/web/src/components/NetworkSettingsModal.tsx` / `network-settings.css`：原生 dialog、模式与草稿、检测/测试/保存、恢复入口和响应式布局。
- `jd-extractor.ts` 与 `opportunity-sources.ts`：复用本地传输，在每次业务操作开始时拍配置/系统环境快照，保留原平台域名白名单、逐跳校验、HTTP 状态和请求限制。
- `App.tsx`、`JdMatchModal.tsx`、机会工作区/来源面板：入口和失败操作连接。岗位网络失败不再引导用户重新选择模型；在 JD 弹层上打开网络设置时保留输入。
- 新增 `undici ^7.30.1`。每条路线使用独立 dispatcher，不修改全局 fetch dispatcher；有界缓存、服务关闭时销毁连接资源。

本地接口为 GET/PUT `/api/network/settings`、GET `/api/network/detect`、POST `/api/network/test`。接口校验本机 socket/Host，写入校验同源 Origin 和 JSON 请求，并限制正文大小/读取时间。连通性测试只允许固定目标，不提供任意 URL 转发。

配置单独保存为仓库根 `data/network-settings.json`，原子替换；只保留模式、代理地址和绕过地址。该文件被 `data/` 忽略，不进入 Git、简历备份、Fact 或历史版本。同一工作区的本地服务共享这份配置。本批最终保存为 auto，手动地址为空，绕过为 `localhost,127.0.0.1,::1`。

## 浏览器验收

在独立 `[::1]:5175` 匿名演示来源验收，未覆盖 localhost:5173 的私人简历，未读取个人 SSOT，未调用 AI。

| 场景 | 结果 |
|---|---|
| 打开弹窗与自动检测 | 识别 Windows 系统代理 7890，显示来源和端口响应 |
| 使用此代理 | 切为手动草稿并填入正确地址，不直接保存 |
| 失效代理 | 事先确认 65534 无监听，测试草稿 `127.0.0.1:65534`，显示端口拒绝连接及不回退直连 |
| 取消草稿 | 取消后重开仍为 auto，失败代理未写入配置 |
| 保存与刷新 | 保存 auto，刷新后重开仍为 auto；实际文件内容和 Git 忽略均已核对 |
| 快捷键与关闭 | 弹窗内 Ctrl+S 保持弹窗，不触发底层简历保存；Escape 取消并将焦点还给入口 |
| JD 错误入口 | 51job 失败提示打开网络设置，取消返回后原链接仍在 |
| 桌面滚动 | 标题和底部操作固定，仅正文滚动；修复聚焦使整个 dialog 滚动的问题，外层 scrollTop 保持 0 |
| 手机 390×844 | 模式纵排，标题/保存按钮可见；内容区域 scrollWidth=clientWidth，无横向溢出；Escape 关闭及焦点恢复通过 |
| 实际招聘源业务 | Greenhouse/Duolingo 返回 63 条预览，收藏所选仍为 0 |
| 页面日志 | 本次匿名测试页 error/warn 均为空 |

临时浏览器尺寸已恢复，验收结束关闭临时页和服务；原 5173 服务保留。最终检查发现原服务前端虽已热更新，网络接口仍返回 HTML fallback；以相同字节重新保存 Vite 配置触发原进程加载新插件后，`http://localhost:5173/api/network/settings` 已返回 HTTP 200、`application/json` 和已保存的 auto 配置。未改端口、未重建私人数据或终止原服务。

截图留在仓库外：

- `<local-artifacts>/betterme-2026-10-17/network-proxy/desktop-detection.png`
- `<local-artifacts>/betterme-2026-10-17/network-proxy/desktop-connectivity.png`
- `<local-artifacts>/betterme-2026-10-17/network-proxy/mobile-detection.png`
- `<local-artifacts>/betterme-2026-10-17/network-proxy/51job-connection-reset.png`
- `<local-artifacts>/betterme-2026-10-17/network-proxy/greenhouse-63-preview.png`

## 自动检查

- 全量 `pnpm test` **264/264** 通过，新增 10 项网络回归；`pnpm lint`、`pnpm typecheck` 通过。
- 网络回归包含真实 HTTP CONNECT 访问不可解析目标以证明经过代理，并覆盖直连/绕过、代理失败不回退、提前取消/正文流取消、检测优先级与 PAC/SOCKS、操作快照、持久化/损坏 JSON、Host/Origin/请求体与固定测试目标限制。
- 最后 CSS 修复后重跑 `pnpm build` 通过（3/3）：入口 **646.83 kB / gzip 195.95 kB**，CSS **117.37 kB / gzip 23.30 kB**，导入 chunk **847.00 kB / gzip 261.06 kB**。仍有部分 chunk 大于 500 kB 的提示。
- 收尾 `pnpm memory:check` 与 `git diff --check` 通过。无新增 commit/push。

## 保留边界

- 目前支持无账号密码的 HTTP/HTTPS 代理。SOCKS、PAC-only、代理认证不支持；应使用代理软件 HTTP/Mixed 端口，不静默猜测协议或绕过证书。
- 已选代理连接失败不自动回退直连；网站返回 HTTP 403/429 等仍按平台响应处理。连通性成功不保证目标岗位无需登录、验证码或动态渲染，也不保证所有国内/海外站点均成功。
- 连接测试最长约 16 秒；关闭弹窗后前端取消并隔离旧结果，服务端已启动的测试可能继续至自身超时。
- 检测读取的是本地服务所在电脑。纯静态页面没有系统代理检测/转发服务；远程部署不能把服务器代理当成访问者本机代理。
- AI 和浏览器外部导航没有经过此 Node 代理设置；本批没有实现 AI 统一后端转发、全站抓取、自动投递或持续同步。
