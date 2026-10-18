# 国内招聘平台独立传输辅助进程

`domestic-route.ps1` 在 Windows 上管理独立的本机 Mihomo 进程，绑定物理网卡及独立 DNS，供 BetterMe 的 51job、BOSS、猎聘读取使用。AI 和其他应用继续采用各自网络设置。此说明区分通用脚本操作与当前浏览器核验器的本机适配条件。

公开整理前的完整启用及故障过程已逐字节备份到 Git 忽略的 `.agent-memory/.tmp/github-push-2026-10-18/public-docs-originals/scripts/README-domestic-route.md`。本地进程、出口选择和会话流水不随公开版本发布。

## 使用脚本

在仓库根目录运行只读状态检查：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\domestic-route.ps1 -Action Status
```

按实际物理网卡名称启动；`<物理网卡名称>` 是待替换的占位符：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\domestic-route.ps1 -Action Start -InterfaceName '<物理网卡名称>'
```

首次资产下载需要现有代理时，可显式添加 `-DownloadProxy http://127.0.0.1:7890`。这里是示例端口，须使用实际 HTTP/Mixed 代理；该选项只用于下载固定资产，不改变应用或系统代理。缓存存在时不访问下载地址，暂不接受带认证信息的下载代理。

停止本脚本拥有的进程：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\domestic-route.ps1 -Action Stop
```

也可使用 `pnpm network:domestic:start`、`pnpm network:domestic:status`、`pnpm network:domestic:stop`。关闭应用不会自动停止独立 helper；脚本未注册开机任务或系统服务。

`-InterfaceName` 可省略。脚本只从有 IPv4 默认路由且为 Up 的物理网卡中，按接口 metric 与路由 metric 之和选候选，同分按接口索引选择；这不证明每个网站均可达。切换网络后先 Stop，再用新接口 Start。默认端口 `17891`；脚本可用 `-Port` 指定 1024–65535 的空闲端口，但浏览器受管核验器目前只接受其固定端口，见下文。

## 固定资产与进程管理

首次 Start 将资产、配置、进程记录和日志保存在仓库根 `data/domestic-route/`，该目录被 `data/` 忽略，不应提交 Git。固定资产为：

- Mihomo `v1.19.32`，Windows amd64 compatible。
- [官方 ZIP](https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-amd64-compatible-v1.19.32.zip)。
- ZIP SHA-256：`974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0`。

下载写临时文件，校验成功后才改名。每次 Start 核对固定 ZIP 散列及 EXE 与 ZIP 唯一条目一致；已有缓存校验失败会报错，不静默覆盖或运行。当前二进制由首次运行脚本时下载，未在仓库分发；未来随产品分发须保留上游许可证及必要 NOTICE。

Start 先选择接口、用固定引擎 `-t` 校验配置，再隐藏启动独立进程并确认 listener 归属。端口被占用时，只有 EXE 路径和实际 Windows 参数都精确指向本仓库 helper 才报告已运行；其他占用者报错。Stop 也核对身份，不按进程名称批量结束其他 Mihomo 或代理。Status 只读，不下载、不建目录、不写配置、不启动或停止进程；`port-conflict` 表示端口被其他进程占用。

## 网络允许范围

helper 只监听 `127.0.0.1`，不启动 TUN、不设置系统代理、不开放外部控制器。DNS 引导、AliDNS DoH 与 `direct-nameserver` 绑定选定物理接口，不复用系统 fake-IP，不绕过 TLS 证书验证，失败不回退到系统 DNS。

三个招聘域族 `51job.com`、`zhipin.com`、`liepin.com` 允许 DIRECT，其余目标最终 REJECT。另为真实页面实际观察到的必要 CDN/验证资源加入精确主机规则。资源按平台使用；新增 51job、BOSS 组件要求 HTTPS、标准 443、无 URL 凭据，helper 同步采用精确 DOMAIN 与 DST-PORT 的 AND 规则。未开放云服务父域或任意其他租户。实际主机及端口规则以脚本模板和已审查的完整配置为准；部分早期招聘域族规则未限定端口，不能把整个 helper 描述为所有规则均只允许 443。

资源适配用于让网站正常加载原有组件。用户仍需在原网站自行登录或完成验证；软件不解验证码、不主动调用或重放私有接口。helper 连通、配置有效、活规则生效、资源请求完成及完整正文成功分别验收。Greenhouse、Lever、腾讯和 AI 请求应使用各自既有网络路径，不能将全软件手动代理统一设为此限制型 helper。

## 当前受管浏览器仅适配已审查的本机环境

`apps/web/server/jd-managed-browser-proxy.ts` 是只读核验器。目前只接受精确 `http://127.0.0.1:17891`，固定本仓库 EXE、完整配置散列、候选 manifest 路径、物理接口名称及索引条件，核对进程创建时间、精确命令、loopback 唯一 listener 的 owner 和前后文件身份。磁盘配置、manifest、接口条件、路径、端口或启动参数不匹配都会拒绝；当前不提供跨机器自动配置或任意代理信任功能。

**脚本能 Start 不等于 native 浏览器能通过受管核验。** 新 clone 不包含被忽略的本地 manifest、配置和进程记录，脚本也不会自动重建所有审查证据；其他电脑或网络变更需先完成独立适配和审查。不要复制另一台机器的活进程记录，也不要放宽 verifier 让检查通过。固定官方 EXE/ZIP 散列可公开，用于供应链校验；本机运行身份留在被忽略目录。

核验器不下载、不执行、不停止 helper，不写文件、不探测代理连通；它证明核验时的启动归属及未变的磁盘启动配置，不查询内存规则，也不逐包证明物理出口。EXE 散列只在文件身份不变时缓存，配置/记录/OS 进程和监听每次核对。helper 无控制器/热加载，任何配置或环境变更仍须重新审查。

managed 模式下，普通 Edge 的 iframe、worker、SW、WS 依赖现有 helper 允许范围和最终 REJECT。允许范围包含三个招聘域族，不能描述为单站隔离；它也不是所有协议/UDP 或整个浏览器进程的网络沙箱，更不等同于旧 Playwright 的 SW/WS 全禁实现。岗位正文仍须独立通过原来源、request/frame/loader、门槛、可见全文、稳定性和最终采用检查。

## 已验收结果与失败边界

2026-10-18 最终四岗实测：原 51job、BOSS、猎聘分别两次 393、3175、2263 字符，与此前成功基线全文一致；新增桌面 51job `166509900` 两次 313 字符一致。每组同会话、间隔超过 15 秒并精确关闭。新岗未独立原页逐字对照，不能证明全站长期覆盖。详情见 [岗位浏览器读取报告](../docs/reports/job-browser-reading-2026-10-17.md)。

此前补齐资源后仍出现网站验证失败，空资源错误列表和 HTTP 200 未被记为正文成功。原生 strict 本地实验也曾失败，未启用该方案；managed 本地实验覆盖指定 worker/iframe/HTTPS/WSS/HTTP 允许拒绝组合，不替代真实岗位验收。移动 51job 最终恢复已验 standard 路径，native 只选择精确桌面详情，read 失败不自动切引擎。

网站仍可能返回登录、验证码、空页、下线或访问限制。出现不支持的正文结构应保留明确失败，不能扩大允许域或关闭来源/可见性核验来冒充成功。日志及详细网络证据仅保存在本地忽略归档。
