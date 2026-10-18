# 国内岗位真实链接、独立出口与提取可靠性

日期：2026-10-17，Asia/Shanghai。

本报告记录独立出口与静态提取的前批结果。后续已经增加浏览器动态读取与人工登录/验证接续，最新代码、真实返回及剩余验收条件以 [浏览器读取验收](job-browser-reading-2026-10-17.md) 为准；下文“没有浏览器渲染管线”为当时停点。

用户提供的三个地址均被作为真实样本请求。当前已解决本机网络出口导致的连接中断，能收到三家平台的 HTTP 响应；尚未取得三份岗位正文，三平台稳定读取目标未通过验收。不能将本批自动检查、HTTP200、独立代理运行或错误提示改进当作采集成功。

## 真实样本与收到的内容

| 样本 | 独立物理通路的真实响应 | 已核对内容 | 应用内最终结果 |
| --- | --- | --- | --- |
| 51job `/jobs/all/166761768.html` | HTTP200，首次curl约2.27秒 | 92,975字节，存在4个`meta[name]`的`aliyun_waf_`前缀，未含岗位正文 | `verification_required / page`；显示网站要求访问验证 |
| BOSS 用户提供的 `/mpa/html/weijd/weijd-job/<token>` | HTTP200，首次curl约3.31秒 | 11,248字节，空`div#app`与SVG，引用前端weijd脚本；无JobPosting或职责节点 | `unsupported_page / page`；显示未找到可确认正文 |
| 猎聘 `/job/1984701079.shtml?mscid=wx_h5_001` | 移动页302到同岗www页，再302到`wow.liepin.com/t1012695/transit.html` | 观察到的中转页手动GET为200、1,342字节，只有脚本，无可见JD；不能据此定性验证码或登录 | `unsupported_page / http / 302`；说明脚本中转尚未返回正文 |

应用内三份链接已通过独立5175匿名来源再次提交并检查真实错误提示。保存的路线由本地服务使用，Mihomo日志实际出现三个目标的DIRECT请求。没有点击AI分析、OCR或收藏，没有覆盖localhost私人简历。

上述HTML不是“无返回”：返回内容与岗位正文是两个验收状态。BOSS初始HTML为空，暴露当前静态提取器缺少浏览器执行/动态数据获取能力；不能笼统归因于地址不真实、验证码或用户代理。51job只观察验证标记，不执行其验证代码。猎聘仅按已观察到的中转地址分类，不请求任意未知子域或执行中转脚本。

续查用户“真实地址为何拿不到返回”的问题：内置浏览器直接打开同一BOSS原始分享链接，实际报`net::ERR_CONNECTION_CLOSED`；这是沿用系统网络的浏览器通道，与后端已启用17891的HTTP200结果不同，不能相互替代。只读代码复核确认移动路径已识别，服务仍是初始HTML的fetch/Cheerio，没有浏览器运行时；BOSS选择器仅覆盖当前桌面`.job-sec-text`。未来正常浏览器读取还须让脚本及后续请求使用同一网络快照，观察真实移动DOM，再核验目标岗位，不能只添加选择器或把打开原页当作读取完成。本次没有新增浏览器读取代码，三站正文结论保持未通过。

## 本机网络原因与独立出口

只读核实FlClash处于global + TUN + fake-IP，系统DNS返回`198.18.0.0/15`范围。物理网卡以外还有FlClash默认路由。因此旧的Node direct与本机7890都可能经过相同TUN出口，不是独立物理路线。按原两路线的有界对照，51job/猎聘连接重置、BOSS建立连接超时，均未收到HTTP正文。不能在这个阶段猜测网站验证码。

用户明确不能切换规则模式，否则GPT断网。本批保留现有FlClash模式、TUN、配置与7890进程，没有刷新、停止或操纵其内部控制接口。

采用独立Mihomo进程：

- 官方固定`v1.19.32` Windows amd64 compatible ZIP，SHA256与GitHub官方release资产digest一致；值见辅助脚本。
- 仅监听`127.0.0.1:17891`；无TUN、系统代理或外部控制器。
- 绑定实际物理接口，DNS引导与AliDNS DoH同样绑定该接口，不采用系统fake-IP。
- 三个招聘域名族DIRECT，其余MATCH REJECT。保留TLS证书验证。
- 既有常规代理继续监听原端口；隔离实验只确认出站源地址与所选物理接口对应，实际接口身份及私人 IP 不随公开文档发布。

软件新增可选`domesticProxyUrl`。命中三站域名边界时优先使用独立代理，其他来源完全保留原auto/direct/manual配置。独立地址留空兼容旧文件。不能将全软件manual统一设17891，否则其他招聘官网会被helper拒绝。

## 进程持久管理

`scripts/domestic-route.ps1`与三个pnpm命令管理独立进程。官方二进制、配置、日志、ZIP和PID记录都留在Git忽略的`data/domestic-route/`；启动下载先验证ZIP，再验证EXE与ZIP条目一致。只缓存本地，不将二进制分发进仓库。

Start可指定物理接口；默认只在Up且有IPv4默认路由的物理适配器中，按接口metric与路由metric之和选择。同端口进程只有完整EXE路径和实际Windows参数都指向本helper才承认；其他占用者报错，不结束。Stop同样先核对身份，避免误停FlClash或其他代理。配置先用`-t`检查，隐藏启动后确认监听归本进程，失败只清理刚启动的本进程。

实际在隔离端口跑通Start → Status → Stop，结束本任务创建的实验进程后，用仓库脚本在默认端口启动并保留独立helper，既有常规代理继续运行。没有开机服务/任务；重启电脑后可运行`pnpm network:domestic:start`，切换物理网络后先stop再指定新接口start。保存独立地址不会自动启动helper。当前native受管核验另有固定本机接口与manifest条件，不是任意机器启动脚本后即自动通过，详见[脚本说明](../../scripts/README-domestic-route.md)。

本机PowerShell5中`Get-FileHash`不可用，脚本已改用.NET流式SHA256；机器脚本执行策略未变，pnpm仅给自身PowerShell子进程传执行选项。当前固定版本/单一DoH提供商、平台授权/动态内容仍是实际限制。

## 提取与客户端修复

- 用Cheerio DOM识别正文与真实属性，排除脚本/注释/模板/隐藏节点及推荐区；51job宽外壳还需要职责/要求证据，不把长度当正文证明。
- JSON-LD/canonical/目标岗位ID互相核对，多岗位或错配来源拒绝；未知详情路径需结构化来源和主标题共同支持。
- 新增真实BOSS移动分享路径；保留用户移动URL和tracking，不猜或改写桌面API。
- 中文句末分享标点与合法编码文字正确保留；BOM/header/meta与严格解码，不静默吞坏字节。
- 取消传递到上游与响应流；HTTP失败、连接失败、正文中断、主动取消分别处理。
- 401、403、429、下线、访问验证、来源不匹配、动态空页和本地服务错误分别指导。403不直接猜成验证码，只有网络/超时失败操作区引导代理。
- 实际51job WAF DOM标记明确归验证；猎聘已观察的严格中转地址归缺正文，不扩大抓取域名。

## 检查与界面验收

- 最终`pnpm test` **300/300**、lint、typecheck **5/5**、build **3/3**通过。
- 路由回归含真实本地CONNECT、域名冒充不命中、三种常规模式/绕过优先级、独立端口失效不使用常规代理；客户端覆盖旧配置/空值/地址限制/草稿测试与保存。
- 两次有意义的中途失败已修：TypeScript返回分支TS2366、PowerShell5缺Get-FileHash；最终检查使用修复后的代码。后续脚本网卡metric排序修正再次AST检查0错误，未改变Web构建。
- 生产入口654.89kB/gzip198.66，CSS117.67kB/gzip23.37，导入847.00kB/gzip261.06，DOCX394.50kB/gzip116.83；仍保留500kB chunk警告。
- 独立匿名来源保存后重开仍为独立17891+常规auto7890；原5173 `/api/network/settings`实测200 JSON且包含同一配置。
- 桌面与390×844界面检查：手机viewport390，document384，dialog client/scroll均371，无横向溢出；已恢复默认视口。
- 没有覆盖当前私人简历、读取私人SSOT、发送AI请求、提交Git或push。

仓库外证据目录：`<local-artifacts>/betterme-2026-10-17/recruitment-diagnostics/`。

关键截图为`domestic-proxy-desktop.png`、`domestic-proxy-mobile.png`、`51job-real-waf-guidance.png`、`boss-real-dynamic-guidance.png`、`liepin-real-transit-guidance.png`；检查日志为`final-*-verification.log`。原始网站响应/headers留在仓库外，不把脚本、验证数据或Cookie写入源码测试。

## 尚未完成

三平台稳定读取未通过。后续需要单独设计并验收正常浏览器执行/用户选择页面正文的获取路径，以及需要验证时的用户接续。当前服务没有浏览器渲染管线，不复用私人登录Cookie、不自动处理站点验证，也不能依靠静态HTML解析承诺任意移动分享页都能取得正文。粘贴/截图是可用入口，但不计作链接稳定读取完成。

导入语义准确性、原稿版式保真、逐字段证据与附件库等旧欠项继续保留，见原有报告。
