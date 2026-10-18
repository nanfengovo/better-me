# AI 配置连接修复与两条代理路径核对

日期：2026-10-18，Asia/Shanghai。

## 当前结果

后续实际修复已完成：将本机浏览器中已保存的 Gemini Base URL 明确改为 `https://generativelanguage.mtls.googleapis.com/v1beta/openai/`，保留原 Key、模型 `gemini-3.1-flash-lite` 和其余配置。原弹窗两次返回 46 个真实模型标识，CDP 两次记录 `GET /v1beta/models` 的 HTTP 200；保存后关闭重开，确认地址及模型持久化，并再次读通。独立后台新页面也从保存配置读取 46 个模型，随后关闭，没有干预用户原页面正在进行的岗位操作。生成与视觉能力没有调用或验收。

第一次备用端点浏览器读取曾 20 秒超时；启用被动网络诊断后的下一次和保存重开后的读取均成功，不隐去首次超时，也不宣称长期稳定。Key 始终为 password，未提取到工具输出或证据文件；成功截图在仓库外 `<local-artifacts>/betterme-2026-10-18/ai-connection/ai-config-models-success.png`。

核心仅精确支持两个 Google 官方 HTTPS 主机，列表和生成均保留配置中的实际主机及版本；没有新增自动重试、中转或静默换地址。备用端点的官方依据为 Google 的 [ModelServiceClient](https://github.com/googleapis/google-cloud-python/blob/main/packages/google-ai-generativelanguage/google/ai/generativelanguage_v1beta/services/model_service/client.py) 的 `DEFAULT_MTLS_ENDPOINT`，由同目录包的 [_compat.py](https://github.com/googleapis/google-cloud-python/blob/main/packages/google-ai-generativelanguage/google/ai/generativelanguage_v1beta/_compat.py) 将 `*.googleapis.com` 映射为 `*.mtls.googleapis.com`。现场无凭据 GET 返回 Google JSON `403/PERMISSION_DENIED` 身份检查，OPTIONS 返回 HTTP 200 且允许 localhost 的 `x-goog-api-key`；这些预检与后续真实 Key 列表成功分别记录。早期 HEAD 404 不能代表该 GET 接口不存在；无凭据 GET 脚本曾误提取 CONNECT 200 为最终状态，因此该次只确认 JSON403，真实浏览器 HTTP200 有独立 CDP 记录。

新增 mTLS 双版本及五种地址后缀、header/no-Key-URL、相似主机等回归；最终相关六文件 87/87、core AI client 18/18，lint、types 5/5、build 3/3 通过，保留既有 chunk 提示。独立 mock 矩阵 40 个官方组合及 5 个对照、90 个请求通过；这些均不替代上面的真实列表证据。

## Gemini 网页仍失败：与 API 列表分开验收

用户在本轮排查过程中首次发现 Chrome `https://gemini.google.com/app` 打不开并提供截图。已绑定其现有 Chrome 标签页，只读确认 `chrome-error://chromewebdata/` 中的 `ERR_CONNECTION_CLOSED`。没有排查前该网页的成功或失败基线，不能倒推故障起始时间或归因于临时节点切换。

本轮曾通过 Computer Use 对现有代理做有限出口对照，Gemini API 主域均 CONNECT200 后约 3.2 秒 TLS 断开；临时对照结束后恢复原选择。用户随后自行调整出口，Agent保留其选择，没有再次覆盖。系统代理/TUN、系统 DNS/路由、招聘 helper及其配置未改。具体出口名称与切换流水仅保存在本地忽略归档。

在用户最终选择的出口下，无凭据 `GET https://gemini.google.com/app` 经既有代理得到 CONNECT200、3.235秒 curl35、最终HTTP000，与其 Chrome 错误一致。普通 Google 与官方 mTLS API 可达，Gemini/AI Studio主域失败；未发现 Google/Gemini 专用 hosts、NRPT、nameserver-policy 或过滤项，`sniffer.enable=false`。同公开 Google IP、同代理下，仅正常 TLS 主机名/SNI改变即可出现主域握手失败、www.googleapis.com正常证书/HTTP404的差异，不能将该404称为Gemini成功。

普通系统DNS及显式UDP DNS仍返回Fake-IP；固定公开IPv4且保留SNI/证书仍失败，不能简单归因IPv6或Fake-IP错误。单独socket设置 `IP_UNICAST_IF` 并绑定实际物理接口的对照在TCP阶段8秒超时，未到TLS/HTTP；没有抓包，不能绝对排除更低层过滤，也不能把一般“无显式代理”称为物理直连。

网页的当前故障已定位到HTTPS建立阶段，但未精确确定断开发生在本机驱动、FlClash、节点或上游。没有证据证明7890/17891代理循环；本次配置备用API地址不会改变Chrome网页地址。网页恢复仍待能连通其主域的出口或进一步明确的分流/失败原因证据。

## 前一阶段结果（历史，主域未恢复）

用户指出 AI 配置的模型列表显示 `Failed to fetch`，并怀疑两处代理冲突。本轮已修应用请求、取消、错误展示和弹窗布局；Google Gemini / AI Studio 的真实网络连接仍未恢复，不能报告模型列表或生成调用成功。

当前页面 `http://localhost:5173/?verify=pdf-import-final` 已热更新。真实读取失败为 `net::ERR_CONNECTION_CLOSED`；更新后展示中文连接诊断，保留当前自定义模型。未自动保存或更换模型配置。

## 两条路径

| 使用场景 | 实际选择规则 | 当前核对 |
| --- | --- | --- |
| AI 模型列表、生成与图片识别 | 浏览器直接请求所选服务商，不读取岗位网络设置 | 既有系统代理及 global / TUN 开启；普通 Fake-IP 路由可能由 TUN 接管 |
| 51job、BOSS、猎聘岗位读取 | 本地服务按三家精确域与子域选择国内独立代理 | `127.0.0.1:17891`，helper 绑定已审查物理接口，独立 DNS redir-host，TUN 关闭 |
| 其他岗位来源 | 本地服务的常规连接设置 | 根配置及实际 `/api/network/settings` 均为 `mode=direct`；不等于绕过操作系统 TUN |

根配置为 `data/network-settings.json`；复核运行 API 与磁盘内容一致。首次无凭据诊断时常规设置为 auto / Windows 代理，后续配置为 direct；两个时点分别保留，不将旧快照当当前配置。`apps/web/data/network-settings.json` 不存在，独立脚本须使用仓库根路径。该配置属于被 Git 忽略的本机状态，公开仓库不包含实际网络设置。

代码未将 Gemini 交给 17891；也没有证据证明两代理在应用层循环或串联。helper 配置明确将接口与 DNS 绑定已审查物理接口；本轮无活跃招聘出站请求，未声称已逐包验证其物理出口。

## 现场网络证据

所有对照请求均未携带 API Key、简历或生成内容。

- 浏览器原模型列表请求：`ERR_CONNECTION_CLOSED`，没有可读 HTTP 响应。
- Gemini models 与 AI Studio：显式使用现有 7890 时，CONNECT 成功后 TLS 握手失败；Node 现有网络 runtime 同样连接重置。
- 未显式配置 HTTP 代理的 Gemini 对照仍失败；由于 TUN 开启，该路径不能称为物理直连。
- Google 首页与 GitHub 返回 200；OpenAI / DeepSeek 无凭据 models 接口返回 401，证明这些通道能完成 TLS。无凭据 401 不是模型鉴权成功。
- 不能据握手失败判断 Key、模型、具体地区或节点策略；手动填模型也不能修复同一主机上的生成连接。

未修改 FlClash、系统代理、DNS、路由或招聘 helper。FlClash 控制器未启用，没有找到可证明具体节点拒绝原因的运行日志。

## 应用修复

- Gemini 原生模型列表仅识别精确 Google HTTPS 主机及支持的版本路径，尊重自定义兼容 Base URL。生成与列表使用一致的官方主机判定，不向自定义网关强加 Google 专属路径。
- 官方模型列表改用 `x-goog-api-key` 请求头，Key 不再进入请求 URL。
- 网络异常显示“未收到可读取的服务商响应”及网络、代理、地址、跨域排查提示；HTTP 状态与服务商拒绝信息分开保留。错误中的实际 Key 和 URL token 脱敏。
- 弹窗关闭、外部配置切换、卸载均中止列表请求，版本隔离阻止迟到结果污染新弹窗；主动取消与原 20 秒超时区分。
- 刷新模型列表保留用户当前模型，由用户显式更换；Key 默认隐藏、关闭重开恢复隐藏。
- 修复长模型名导致选择框和右侧操作溢出；补充输入标签与结果状态语义。
- 两个配置弹窗都说明：岗位代理不控制 AI，岗位选择“直接连接”也不改变 AI 的浏览器 / 系统代理与 TUN。

## 验证与未完成项

最终核心客户端及相关 AI 导入、真实 React 组件回归合计 79/79 通过（零失败、跳过、取消）；全项目类型检查 5/5、lint、构建 3/3 通过。测试使用合成凭据和 mock fetch，不替代真实 Gemini 连接验收。独立审查指出的自定义网关生成路径不一致已修复并新增回归；构建保留既有大 chunk 提示。

最终浏览器模型列表仍返回 `ERR_CONNECTION_CLOSED`，preflight 与 fetch 均未取得 HTTP 响应；界面明确显示中文失败，模型仍为用户当前自定义值，Key 为 password。默认 1697px 视口下 dialog 的 clientWidth 与 scrollWidth 均为 511，无横向溢出。脱敏截图保存在仓库外 `<local-artifacts>/betterme-2026-10-18/ai-connection/ai-config-network-result.png`。

本历史阶段的主域失败后来通过用户显式采用官方 mTLS API 地址恢复了真实模型列表，见报告顶部；Gemini / AI Studio 网页主域与生成权限仍需独立验证。调整出口前保留已验收的岗位专用链路。四岗真实读取与关闭验收仍有效，详见 [岗位读取报告](job-browser-reading-2026-10-17.md)。

公开整理前原文已备份至 Git 忽略的 `.agent-memory/.tmp/github-push-2026-10-18/public-docs-originals/docs/reports/ai-connection-repair-2026-10-18.md`；`<local-artifacts>` 为本地证据占位符，不包含公开附件或真实 API Key。
