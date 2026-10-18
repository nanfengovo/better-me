# 岗位来源 M1：适配器与受控请求有限实测

日期：2026-10-18。此报告覆盖新 `@better-me/source-adapters` 的传输、三个官网 ATS 协议和可配置 JSON / GitHub JSON 家族；不表示全国或全球岗位库已经建成，也不代替单岗在招核验、企业控制关系核验或实际求职投递。

## 默认 DNS 与本机环境

首次使用默认系统 DNS 运行手动公开样例探测时，Greenhouse、Lever、Ashby 和 GitHub 请求均在网络发送之前返回 `unsafe-endpoint`，源请求数为 0。随后只读 DNS 检查确认这台机器的网络将三个 ATS 域名解析为 `198.18.0.71`、`.72`、`.73`；这是代理 Fake-IP 的基准测试网段，不是可直接信任的公网目标。显式向 `1.1.1.1` 做系统 DNS 查询也得到同一结果。

实现没有放宽私网、metadata、环回、IP literal 或 `198.18.0.0/15` 的限制，没有更改系统 DNS / 代理 / 浏览器，也没有绕过 TLS 验证。默认传输仍使用系统 DNS，处于同样 Fake-IP 环境时会拒绝采集。

另外提供显式可选 `createGoogleDohResolver()`：固定 `https://dns.google/resolve`，以已知公网地址 `8.8.8.8` 做 TLS 连接 bootstrap，TLS hostname 仍是 `dns.google`，不允许重定向；仅查询源 hostname 的 A 记录，不发送完整源 URL、家庭地址、Cookie 或 Key。DNS 答复中的全部 A 地址必须为公网，源请求再使用已核地址固定连接并保持原源 hostname 的 TLS / Host。用户必须显式选择该 provider；这会将请求的源域名交给 Google，不能称作完全离线 DNS。

DNS HTTPS 请求与后续源请求一起计入同一请求 / 字节 / 时间 / 取消预算。默认 transport 不启用此 resolver；手动探测通过 `--doh` 明确选择。后续本机服务应在设置或 CLI 明确暴露 provider 选择，不能把本报告的显式 DoH 成功误写成默认系统 DNS 已恢复。

## 正式 resolver 的真实低请求探测

执行入口：

```powershell
pnpm exec tsx packages/source-adapters/tests/public-probe.ts --doh
```

脚本不属于自动 `*.test.ts` 测试；只读取公开的样例配置，不读取私人机会库、简历、Key、家庭位置或浏览器资料，也不保存或自动启用配置。单来源每次最多一个源 HTTP GET，另一个请求为显式 DoH 查询。

以下记录来自 13:28:31–13:28:45 UTC 左右的正式 resolver 探测。字节数包含相应 DNS JSON 与源响应。

| 协议 / 实际公开样例 | 请求数 | 接收字节 | 实际产物 | 范围与状态 |
| --- | ---: | ---: | --- | --- |
| Greenhouse / Duolingo | 2 | 763411 | 63 条岗位记录；首条 `Ad Sales Lead, Programmatic` | 本次配置 board 列举完成；不是所有 Greenhouse 公司搜索 |
| Lever / `leverdemo` 官方演示 | 2 | 13099 | 1 条演示记录；`Customer Success Manager` | 保留下一页 cursor，列举未结束；演示数据不能计入真实市场岗位 |
| Ashby / Linear | 2 | 402600 | 29 条岗位记录；首条 `Senior / Staff Fullstack Engineer` | 本次配置 board 列举完成；远程地区不生成办公室坐标 |
| GitHub JSON / xixicc2027 | 2 | 205459 | 上游数组 402 条，按预算处理首 100 条，22 条有效 discovery lead；首条 `中国航天科工` | 其余 78 条处理记录缺少稳定原始 URL / ID 或不满足字段 Schema 等，明确 partial；未处理的 302 条不宣称已适配 |

GitHub 样例是校招公司 / 活动 / 岗位方向清单。配置将公司名作为线索标题、`positions` 原始数组作为正文，保留公司与原始投递链接，不把一组方向拆成多个真实岗位。映射器接受有限 Unicode 字段路径，禁止表达式、任意 JavaScript、原型字段和 accessor。该仓库调研时未发现 LICENSE，公开样例保持 `enabled:false` / `status:needs-review`，使用范围仍需审核。

本报告中的抓取时间只是读取时间。所有返回记录的 `availability` 均为 `unknown`，没有因为 HTTP 200、列表出现、`isListed` 或文本看起来正常而写入 `availabilityVerifiedAt`。原始来源日期独立保留；没有时区或只有日期时保留原文，不补造精确 UTC 时间。没有调用投递端点。

Greenhouse / Lever / Ashby 样例保留原始官网岗位 URL 与字段 JSON 路径证据。Lever 的结构化工资保留币种、区间和计薪周期，但 API 未明确税制 / 固定与浮动构成时 `tax` / `kind` 保持未知；不自动当成可比的固定税前年薪。ATS 工作地区不用于推断企业最终控股方国家 / 地区。

## 已实现的传输与覆盖边界

- GET-only、HTTPS、精确 allow-host / 路径边界、拒绝凭据 URL、任意认证 / Cookie 请求头、私网 / metadata / 环回和 URL 编码路径绕过；每次重定向都重新检查 URL、全部 DNS 答案及预算，默认不跟随。
- 使用 Node HTTPS 固定已核公网地址，TLS hostname / Host 保持原始域名，避免校验后再次 DNS 解析。无 Cookie jar，不加载陌生源脚本。
- 流式读取 UTF-8，限制实际字节，不只信任 `Content-Length`；拒绝未处理的压缩编码和非法 UTF-8。响应过大、错误、超时或取消时关闭流。
- 源 / host 的内存滑动窗口 RPM 限流包含重定向；等待受取消和 timeout 控制。429 返回有限的 `retryAfterSeconds`，不自动重试。持久化刷新间隔由上层任务服务负责。
- 官网 ATS 与 mapped JSON 都显式报告 ignored / applied filters。它们按配置公司 / feed 拉取，不把本地关键词 / 地区条件伪装成远程全文搜索。
- 完整 board / feed 返回后再按处理预算截断时，网络字节和上游数组长度如实记录；`coverage.fetchedRecords` 是已接收数组长度，返回记录数与其分开。缺失 / 不合法行导致 partial，不能用不完整结果将旧岗位判为关闭。

有限自动测试覆盖公网地址、混合 DNS、每跳重定向、URL / 路径与 header 边界、流量和请求预算、429、悬停 DNS / 流超时取消、RPM 等待、正式 DoH bootstrap / 计账、ATS 字段与时间、远程资格地区、JSON 映射和 Schema 漂移。测试与上表真实接口观察是不同证据；合成测试不证明平台长期可用。

当前未完成并且不在本次公开探测中：招聘平台批量搜索、需要认证的来源、分页全量运行、长期节流恢复、所有真实字段组合、Markdown / CSV 列表采集、薪资税制补证、地理编码、企业控股核验、岗位实际在招核验以及三维地图最终视觉验收。更多来源发现与候选审核由独立 registry / discovery 工具扩展，不自动启动定时任务。
