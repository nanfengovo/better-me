# Docker runtime 与发布素材验收 · 2026-10-30

## 结果与范围

在独立功能分支上完成默认完整运行镜像：Web、Agent Host、SQLite 岗位服务通过单一同源入口连接。保留显式 `static` 构建目标。当前机器的 Docker Desktop / Engine 29.2.1、Compose v5.1.0、Linux ARM64 实际构建与运行通过；未据此声称 Linux AMD64 或 Windows 已完成实机验收。

没有挂载或迁移原项目数据库、个人简历、模型 Key、浏览器 profile 或 Docker socket。常用的 5193 工作台及原工作树未用于测试。测试项目使用随机独立 Compose 名称、端口和新建卷；结束后只清理其自身项目与测试卷。

## 实际执行结果

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | 8 个 workspace 包构建通过；随后 Web 相关构建再次通过 |
| `pnpm typecheck` | 13 个任务 / 8 个包通过 |
| runtime、服务生命周期/HTTP、伴写、Agent 输出定向回归 | 合并运行 47/47 通过；runtime 单独再次运行 6/6 通过 |
| 新 runtime、连接读取、生命周期、bootstrap、Chrome 边界组件定向 ESLint | 通过 |
| `docker compose config --quiet`、脚本语法、`git diff --check` | 通过 |
| `node scripts/check-docker-runtime.mjs` | 实际 Compose 启动、鉴权/Origin、Agent/岗位 API、SQLite 写入、进程崩溃自动重启、重建持久化通过 |
| `node scripts/check-docker.mjs` | 静态镜像 411 次 HTTP 请求通过；60 个资源、32 个懒加载 chunk、PDF/MapLibre worker、13 份公开地理文件、96 份模板许可/元数据、20 份改编源码、185 项依赖及 197 份依赖许可文件 |
| 实际容器浏览器检查 | `127.0.0.1:18089` 打开现有简历模块及主动批注；Agent 待配置时显示待命、0 个本机 CLI；岗位索引自动连接 |

首次合并定向回归曾有一个图片预览用例未通过；该用例单独复跑以及随后完整 47 项组合复跑均通过。没有用单次失败隐藏为从未发生。

未声称全仓库 lint 通过：定向包含现有 `agent-client.ts` 时仍报告两处非本次连接修改引入的问题（`no-useless-assignment`、`preserve-caught-error`）。此轮只验证相关回归，不等于全仓库所有测试通过。远端 CI 是否运行及通过以 GitHub Actions 为准。

浏览器仍有现有的 `/favicon.ico` 404；没有把它描述为零 console 错误。它不影响此次页面、Agent 与岗位索引连接验证。

## 修复的实际启动问题

- Docker 构建上下文补齐地图 GeoJSON 与运行依赖，保留默认拒绝私人文件的白名单。
- 构建时对缺失完整许可证的确定版本依赖提供固定上游文本、哈希和来源说明，缺失或哈希变化仍使构建失败。
- 自定义公共端口下，Node `fetch` 未按预期覆盖 `Host`，曾导致服务可访问但健康状态误报。改用 `node:http` 设置明确的本地 Host；随机公共端口的真实 Compose 验收覆盖该回归。
- 持久卷持有独立内核 SQLite 租约，临时 PID 锁不跨容器保留。崩溃和重建无需删库、删 token 或强抢锁。

## 恢复与安全边界

已验证将本次测试容器中精确匹配的 runtime 进程 SIGKILL 后，由 `unless-stopped` 重启并恢复健康，原 SQLite 数据和两个 token 均保留。之后强制重建容器再次验证保留。

HTTP 看门狗每 10 秒检查内部两个服务，连续 3 次失败后退出，由 Docker 重启策略接续。没有另外对内部服务故障进行完整故障注入；进程崩溃恢复与网关健康状态转换有实际测试，但不等于任意挂死、网络或模型故障都已覆盖。Docker 引擎未启动属于应用之外的问题，不承诺容器能修复宿主机引擎。

只监听宿主机 loopback，容器非 root、只读根文件系统、移除 capabilities，不自动获取宿主机 CLI 或招聘网站登录态。模型服务需用户配置；本轮没有真实模型调用、付费操作、登录/验证码、真实招聘站点覆盖或真实地址采集验收。

## 图片和视频

更新三张真实模块截图和 97.4 秒 WebM 操作视频，见 [素材说明](../media/README.md) 与 [哈希清单](../media/manifest-20261030.json)。使用隔离浏览器中的示例内容，不是独立 HTML demo，也不含用户真实简历。

素材捕获时 Docker 引擎暂不可用，因此录制使用正式构建及同一 runtime 入口在宿主机独立端口运行。之后才完成上述真实容器验收，不能把先前录屏冒充容器运行录像。视频涵盖主动批注、补充事实、候选对照、Agent 边界及空岗位索引；另一次隔离操作验证采用与撤销，未包含在最终视频。

## 使用

```sh
docker compose up -d --build --wait
```

默认打开 <http://127.0.0.1:8080/>。端口、模型、备份和恢复见 [Docker 指南](../docker.md)。没有发布预构建 registry 镜像；此功能分支的源码可自行构建，推送分支不代表 main / Pages 已更新。
