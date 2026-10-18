# 三个原岗位的获取路径与会话期限核查

日期：2026-10-17，Asia/Shanghai。研究结论与后续产品修复、真实入口验收分别记录，具体能力以验收报告为准。

最终状态（2026-10-18 09:42）：原51job/BOSS/猎聘与新增桌面51job166509900均已完成各两次正文读取和精确关闭。移动51job采用已验standard，native只选择精确桌面详情，不因read失败自动切引擎。结果限四个样本和本次窗口，见[岗位验收报告](../reports/job-browser-reading-2026-10-17.md)。下文按原研究阶段保留，早期“未取得”“仍验证失败”“未采用native”均为当时结论，不代表最终停点。

历史状态（2026-10-18 08:35）：原三岗已于checkpoint47各两次正式成功；当时新增51job166509900人工滑动后仍验证失败，已加载超时保页和精确验证资源修复。该阶段不能以原三岗成功覆盖新岗失败；后续诊断与明确路由修复见文末。

早期三个验收目标为用户提供的原地址：

- [51job：166761768](https://msearch.51job.com/jobs/all/166761768.html)
- [猎聘：1984701079](https://m.liepin.com/job/1984701079.shtml?mscid=wx_h5_001)
- [BOSS：原移动分享链接](https://m.zhipin.com/mpa/html/weijd/weijd-job/02d03c8563d57f3b0nN-09i7E1BZ)

早期续验已改用各平台专用持久Edge：工具固定profile保存本站登录、基础Tab常驻，每岗新建子页，普通release不关闭Context。原5173接续HTTP入口中，51job同session的0/15/30秒三次取得相同393字符原岗全文/hash；猎聘首次取得同2263字符，15/30秒已blank，两次read均unsupported_page。前批native自动入口的两站成功记录继续有效，当时持久化尚未修复猎聘持续窗口。

BOSS新现场证实五个验证组件资源主机被工具限制后，仅补精确HTTPS443主机规则并实启独立17891 helper；随后同原分享的两次read仍422/verification_required，延后inspect明确gate，资源问题列表为空。该列表不含所有请求，不能由此声称五个资源都已HTTP成功或验证已通过。FlClash、系统网络及GPT既有通道保留。猎聘普通Edge加Playwright CDP仍在总10.548秒提交blank；被动Trace及精确自然响应的静态AST已关联官方CDN的控制台检测与enforcement调用链，但尚未确认真实运行命中了哪一支检测。不启Runtime的原生CDP目前仅纯本地原型中，未替换生产。历史响应、快照来源校验与最新正文证据见[验收报告](../reports/job-browser-reading-2026-10-17.md)；HTTP200、首页可读、合成测试或人工导入均不替代三原岗位的长期稳定验收。

## 官方接口与导出：尚无可证接入路径

本轮经独立17891通路实际取得[51job首页](https://www.51job.com/)、[猎聘首页](https://www.liepin.com/)、[BOSS首页](https://www.zhipin.com/)的HTTP200，并查看[51job官方帮助中心](https://help.51job.com/home.html)和[常见问题](https://help.51job.com/qa.html?from=b)。所读公开入口未发现个人求职者凭这三个原链接或岗位ID取得完整JD的API文档，也未核实对应的官方JD导出说明。猎聘品牌页、BOSS关于页本次未提供可供核实的静态说明。

**未发现不等于不存在**，以上不是全站或商业合作渠道的穷尽调查。企业发布、ATS同步接口也不能未经文档证明就视为读取任意招聘方岗位的接口；实际接入仍需官方说明、申请资格和授权范围。未猜测或调用私有接口。

51job帮助页有“未经51job同意，不得转载本网站之所有招聘信息及作品”的声明。公开可读不能据此推导为允许复制再分发；本次不对所有本地个人用途作法律结论。

## 当前页主动导出：可选研究，未实现或实站验收

本轮实时读取了career-ops-china的[工具说明](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/README.md)、[BOSS书签脚本](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/bookmarklets/boss-zhipin.js)、[本地收件服务器](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/jd-inbox-server.mjs)及[MIT许可证](https://github.com/shuheng-mo/career-ops-china/blob/main/LICENSE)。该模式无需扩展：用户在已打开的岗位页点书签，脚本读取当前DOM并发送localhost。上游说明明确要求先登录并看到完整JD，BOSS可能需要滚动完成加载；它不是免登录API。

不能原样采用：上游BOSS脚本修改复制事件和页面样式，从HR签名启发式推断公司，并发送整页innerText；收件服务器开放跨域写入，缺少本项目的owner、来源核对和采用确认约束。MIT许可不等于招聘平台内容的授权。

可选研究方向是用户在原站完整展开原岗位后，主动导出限定岗位容器的正文、原URL和采集时间，进入本地核对预览后才采用。下载小型JSON再导入可减少跨站写localhost的依赖；书签执行仍需验证CSP、浏览器权限、DOM和来源身份。若采用直接POST，还需验证CORS及本地网络访问限制。**当前没有实现此入口，也没有在这三条移动链接上运行上游脚本或验证兼容性。**

前提是用户当前页已经能显示完整原岗；验证页、空白页不会因导出动作变成JD。现有粘贴、截图OCR是人工辅助入口，不能记作稳定URL读取成功。不读取日常浏览器profile，不复制Cookie，不自动处理网站验证。

## freshContext与10分钟期限的实际影响（历史设计，已由持久架构覆盖）

[人工接续实现](../../apps/web/server/jd-browser-session.ts)此前在start创建会话时固定expires为当前时间加10分钟，并立即启动到期关闭定时器；启动、导航、扫码和排障均计入期限。旧版每次start调用browser.newContext，read/inspect不续期。关闭、到期、换岗重开或服务重启后，新context不继承认证。这描述的是持久架构实施前的代码，当前10分钟只约束岗位Tab，见文末最新架构与验收。

[Playwright官方newContext文档](https://playwright.dev/docs/api/class-browser#browser-new-context)明确说明不同context不共享Cookie和缓存。历史验收记录中多次到期也已造成重新打开会话，因此旧设计确实增加重复登录与验证成本，影响人工接续的连续性。

这不证明freshContext触发平台风控，也不证明它是猎聘空白的根因。本轮后续已按用户明确授权实现专用持久profile和Context复用，覆盖旧“不保存认证”取舍；不接管日常浏览器、不复制Cookie或自动完成验证。持久化后猎聘仍15/30秒blank，说明会话连续性改造本身不足以消除这次问题，不能宣称已查明唯一根因。

## 已下载公开脚本的有限空白行为核查

仅只读搜索仓库外 `<local-artifacts>/betterme-2026-10-17/public-dependency-review/` 中已有的main.js、app.js、sourcelogin-app.js、tlog-pc.js及manifest；未下载或运行脚本。未发现about:blank字面量、直接清空document.body/documentElement或document.open/write/close的明确语句。

存在普通的无内容呈现分支：app.js第6行的组件包装器在缺少component且未进入已捕获错误状态时渲染返回null的占位组件；捕获React错误时则显示“组件加载失败”，并以console.info记录。main.js第12行的主配置加载仅在返回flag为1时替换store并启动组件加载，所读片段没有对应的失败提示。它们说明无可见文字、无未处理脚本错误可以与未完成呈现同时发生；不能证明这次现场执行了这些分支，不能据此归因于某个请求，也不能解释或证明当前URL为about:blank。动态返回值、未下载依赖和内存执行路径不在本次证据范围内，三份原岗位验收状态不变。

## 本轮新增：脚本请求空白导航

一次正常manager匿名被动CDP观察已将导航类型收窄：原岗位5.255秒read成功2263字符，6.556秒主帧frameScheduledNavigation和frameRequestedNavigation均为scriptInitiated、精确about:blank，requested为currentTab；6.577秒主帧实际提交blank，没有对应HTTP主文档请求。6.925秒closeAll完成。之前11–12秒的晚检查不是首次空白时间，本次也不足以推出固定跳转时限。

只开启Page/Network事件，未启Debugger、注入、拦导航、读脚本栈/认证数据或追加重试。协议frameId只确定被导航目标，不能据此确定调用发起frame或具体脚本函数；也不能把scriptInitiated直接认定为反自动化、代理故障或账号限制。此结果不改变猎聘早期读取已成功、持续窗口未修复及51job/BOSS仍缺原岗全文的验收结论。去敏报告为仓库外recruitment-browser/liepin-passive-main-navigation-01.json，详见验收报告文末。

## 2026-10-17公开资料补查：GitHub实践与维护边界

本节整理本轮Google/GitHub公开检索后实际读取的GitHub README、源码片段、issues及官方文档；搜索结果用于定位资料，结论以链接中的原文及适用版本为限。资料研究没有运行第三方采集工具或复制其代码；产品原链接验收单独记录。开源项目的存在、截图、star数量及作者宣传均不替代这三个原链接的实站验收。

| 公开来源 | 本轮核实的事实 | 对本项目的适用范围 |
| --- | --- | --- |
| [eatmoreduck/boss-zhipin-scraper README：工作原理与会话](https://github.com/eatmoreduck/boss-zhipin-scraper/blob/master/README.md#L262) | 第262行说明只从包含“职位描述”的详情区取JD，body仅识别登录墙和导航；出现“登录查看完整内容”即停止，避免采纳截断正文、招聘者、公司介绍或推荐职位。第276行要求首次在专用浏览器手动登录；第278行区分未登录、样本为空、平台限制和响应异常，遇安全校验或环境异常停止。 | 支持正常会话、限定正文和完整性校验。它还使用持久专用profile及页面响应捕获；本项目后来按用户明确授权独立实现专用持久profile和受限被动响应后备，没有复制其代码或日常浏览器状态。作者称其“更稳定”不构成通用成功率证据。 |
| [BOSS issue #84：搜索列表右侧面板正文](https://github.com/eatmoreduck/boss-zhipin-scraper/issues/84) | 本轮读取时仍open。现有详情流程为每个岗位打开独立job_detail页面；列表右侧面板的“选中卡片、等待呈现、提取正文”尚属待实现功能。 | 同一平台有不同正文入口，列表字段不等于完整JD。该资料没有给出用户weijd移动分享链接的通过记录，不能据此改写为桌面详情或认定兼容。 |
| [BOSS issue #67：维护者对环境差异的结论](https://github.com/eatmoreduck/boss-zhipin-scraper/issues/67#issuecomment-5869717528) | Ubuntu/Xvfb用户报告后台页面收不到搜索响应；维护者在macOS多次实验未复现，未采纳改前台的修复，并要求失败时实际页面与精确版本证据。“后台可能落在验证页”仍为维护者提出的待验证假说。 | 不能把别的系统、浏览器或窗口设置的成功直接当作本机根因，更不能据此修改本项目参数后宣称稳定。 |
| [career-ops-china工具FAQ](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/README.md#L105) | 明确要求先登录BOSS、完整看到JD并拉到底后再捕获，说明详情可能懒加载。 | 支持以完整可见内容为采用前提。其README“唯一稳定方式”“失败率超过90%”等断言没有随文可核验测量，不能引用为行业事实。 |
| [career-ops-china猎聘正文容器](https://github.com/shuheng-mo/career-ops-china/blob/main/tools/bookmarklets/liepin.js#L47) | 选择器包括.job-intro-content、.job-describe-content、.content.content-word，文件注释说明部分详情未登录看不到完整JD。 | 仅为DOM变体线索，仍需当前可见页面、原岗位身份与完整性证据。上游还修改复制相关行为，研究选择器不等于采用这些操作。 |
| [hypier/scrapy-51job README](https://github.com/hypier/scrapy-51job/blob/master/README.md)、[51job正文选择器](https://github.com/hypier/scrapy-51job/blob/master/company_resume_51job/spiders/a51job.py#L112)、[猎聘正文选择器](https://github.com/hypier/scrapy-51job/blob/master/company_resume_51job/spiders/liepin.py#L102) | README标注BOSS“易被反爬”；历史代码分别取.bmsg.job_msg.inbox段落及.content.content-word。 | 说明职位正文与公司介绍应分开处理，但不证明旧选择器适用于当前页面、移动分享或本次具体岗位。 |

维护时间须区分。[hypier仓库元数据](https://api.github.com/repos/hypier/scrapy-51job)在本轮读取时updated_at为2026-10-02，pushed_at却为2020-09-10；不能把近期仓库元信息活动视为采集代码近期维护。[eatmoreduck仓库元数据](https://api.github.com/repos/eatmoreduck/boss-zhipin-scraper)则显示pushed_at为2026-10-14，许可证识别为MIT，但仍有上述未完成功能和环境差异。GitHub未为hypier仓库识别出许可证，不据此复制其代码；代码许可本身也不授予招聘平台内容的再分发权。

上述资料没有验证用户提供的BOSS `/mpa/html/weijd/weijd-job/<token>`、51job移动原链接及本次canonical别名组合。它们提供结构和会话处理线索，不是三原岗的验收替代物。本轮GitHub范围内仍未核实个人可以申请、按任意分享链接获取全文的官方文档、资格及授权路径；第三方关于“没有开放接口”的表述也不能升级为官方不存在接口的结论。普通网页内部请求被开源工具使用，不代表它已成为官方开放API。

## 2026-10-17公开资料补查：Playwright 1.64.1网络语义

本轮已只读核实项目实际安装playwright-core 1.64.1。以下采用官方文档、对应版本源码和官方issues；通用经验须先核对版本，不将旧issue直接套到当前安装版。

| 证据 | 已核实行为 | 本项目含义及边界 |
| --- | --- | --- |
| [Node fetch](https://nodejs.org/api/globals.html#fetch)、[Undici CORS说明](https://github.com/nodejs/undici#cors)、[Playwright APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext) | Node fetch基于Undici，服务端客户端不执行浏览器CORS检查和页面脚本；Playwright context.request可以共享浏览器context的cookie jar，独立request.newContext另行隔离。 | Node fetch、APIRequestContext和浏览器导航不是同一种请求。响应不同不能直接归因于代理；是否共享状态取决于实际实现。本项目没有因此导出或复制认证数据。 |
| [Route.fetch文档](https://playwright.dev/docs/api/class-route#route-fetch)、[1.64.1客户端源码](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/client/network.ts#L364)、[网络指南](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/network.md#L704) | route.fetch经context.request._innerFetch取得响应，再由fulfill提供给浏览器；continue则继续浏览器请求。 | 修改前动态路径fetch/fulfill与人工manager的continue有实现差异。本轮自动入口已改native；人工manager此前的同时间对照仍证明猎聘两路径都能早期成功、随后blank，不能把这次自动读取成功升级为持续窗口空白根因已修。 |
| [1.64.1通用路由重定向说明](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/network.md#L730)、[Page.route说明](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/api/class-page.md#L3749) | 官方契约将请求及其redirects视为一个单元，handler只收到原始请求，后续由浏览器自行跟随。fulfill一个3xx也不会在Chromium/Firefox中重新获得第二次拦截机会；WebKit拒绝该操作。通用指南不只针对page.route。 | 本机1.64.1/Edge155合成实验已确认：native continue和fetch(maxRedirects:0)后fulfill 302，两者都只拦entry，target已到达服务器却未进入target route。API选项只限制其自身跟随，不能声称浏览器context.route已逐跳检查全部redirect target；具体计数见下节。 |
| [BrowserContext request事件](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/api/class-browsercontext.md#L302)、[APIRequestContext.fetch](https://playwright.dev/docs/api/class-apirequestcontext#api-request-context-fetch)、[官方代理配置](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/network.md#L113) | request事件给出只读Request，abort属于Route；API fetch配合maxRedirects:0可由调用方控制自己的HTTP链；浏览器/context可显式配置代理。 | request事件不构成每跳联网前必然阻断。手工跟随再只fulfill最终body会改变最终URL、origin和相对资源语义，不能当作透明native导航替换。真正出站约束还须代理/出口执行；既有helper最终REJECT覆盖另一层，但它允许三个招聘平台域族，不等同于单站会话边界。 |
| [路由与HTTP cache](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/api/class-browsercontext.md#L1212)、[Service Worker指南](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/service-workers-js-python.md#L28)、[1.64.1 SW实现](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/browserContext.ts#L173) | 启用route会禁用HTTP cache；serviceWorkers:block改变SW注册能力，官方建议拦截网络时阻止可能由SW接管而漏过route的请求。 | 全部continue也不能称为完全等同日常浏览器。两产品路径都设置SW block，所以单凭共同选项不能解释两入口差异；尚无证据证明猎聘blank与SW有关。 |
| [官方headless说明](https://playwright.dev/docs/browsers#chromium-new-headless-mode)、[官方issue #33566](https://github.com/microsoft/playwright/issues/33566) | Chromium默认headless shell与Chrome/Edge的新headless存在已知行为差异，后者更接近正常浏览器，但不保证完全一致。 | 本项目Windows两入口均指定msedge channel，不能直接套默认headless shell建议。已观察51job自动入口在Node静态预检即WAF，尚未运行到launch；改headless不能解释这次已发生的失败。 |

官方问题记录同样需要收紧适用范围：

- [#43278：卸载阶段keepalive/sendBeacon漏过route](https://github.com/microsoft/playwright/issues/43278#issuecomment-6128141932)：维护者确认特定卸载导航下可能绕过page/context route并缺少正常request事件；issue closed时仍提到等待Chromium上游处理。它支持“资源列表为空不代表全部请求覆盖”，不证明本项目发生过该漏项或因此blank。
- [#43332：启用路由后跨域redirect丢Origin](https://github.com/microsoft/playwright/issues/43332#issuecomment-6150126695)及[v1.64.1发布说明](https://github.com/microsoft/playwright/releases/tag/v1.64.1)：该问题已列入1.64.1修复，不能仅凭旧issue重复添加参数或认定命中当前症状。
- [#42815：APIRequestContext redirect复用首跳proxy bypass](https://github.com/microsoft/playwright/issues/42815)与[1.64.1对应实现](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/fetch.ts#L356)：对应版本已逐跳计算代理和TLS选项。可据此认识API与浏览器链路不同，不能把旧缺陷当作当前安装版仍未修的事实。

## 本轮修复与验证停点

用户显式选择mode=browser时，启动前重复调用静态fetchPublicJd的源码已删除，两项定向回归及全量408/408、lint/typecheck/build通过，独立复核未发现该删除本身的阻塞回归。但原5173实际HTTP验收仍在1170ms返回422/verification_required，没有保存JD。静态客户端收到WAF不能预判实际浏览器页面结果，去掉该预判也不保证后续APIRequestContext文档获取成功；实际页面、原岗位身份、来源/导航一致性、正文稳定性及取消清理仍须校验。前文静态预检停止保留为修改前记录，自动入口尚未恢复。

随后只做一次正常manager对照：launch仅覆盖headless:true，其余Edge/代理/context/route/read保持真实产品。原51job166761768在约4.446秒返回393字符，标题/公司、原URL、全文与原可见manager基线逐字一致，hash为098c5ad5ff031db154cee4019ca4bae04cccb042142b486e5144d55b494b93f3；约4.707秒完成清理，Browser已断开且OS无临时Edge主进程。证据为仓库外recruitment-browser/51job-headless-native-manager-acceptance-01.json及对应original-jd。这个结果排除了headless本身阻止该样本读取的说法，支持单独比较正常浏览器文档请求与代传路径；不能据此认定某一剩余差异是唯一根因。

native自动入口现已完成：route只continue，实际主文档response检查HTTP、声明/实际2MiB及原始gate；按Request身份登记pending，公开waitForNavigation(commit)返回的Response必须匹配当前Request，并且响应检查完成，才采用可见快照。普通framenavigated或同文档导航不解除pending。独审发现的同URL请求body已完但未提交时旧DOM可能重新稳定的问题已补回归。检查属于采用前保护，无法承诺脚本执行前中止，也不将2MiB采用上限称作下载流量上限。最终415/415、lint/typecheck/build通过。原5173三站各一次HTTP验收：51job200/393字符与接续全文相同，猎聘200/2263字符与前批全文相同，BOSS422/verification_required。证据见验收报告文末；猎聘持续窗口blank及三站长期稳定仍未完成。

安装版重定向实证已完成。仓库外 `<local-artifacts>/betterme-2026-10-17/recruitment-browser/local-redirect-route-behavior-01.json` 记录Playwright 1.64.1、Edge 155.0.4283.45和两个不同本地端口；没有招聘站请求。两种模式均为entry route=1、target route=0、target服务器收到请求=1、最终HTTP200且提交target页面：

| 本地模式 | 关键事件 | 已证适用限制 |
| --- | --- | --- |
| native_continue | entry route执行continue，entry返回302；随后target request、服务器接收、HTTP200、主帧提交，未触发target route。 | context.route不会为这个浏览器重定向目标再调用handler，不能靠该回调声明逐跳请求均在联网前校验。 |
| fetch_zero_redirects_fulfill_3xx | entry route.fetch以maxRedirects:0先取得302，再fulfill；随后浏览器请求target，服务器收到并返回200，未触发target route。 | maxRedirects:0阻止API fetch自动跟随，但fulfill 3xx把后续导航交回浏览器，不补足逐跳拦截。 |

两种模式handlerErrors=0、eventsDropped=0，两个context、browser及entry/target服务器均已关闭。该本地合成结果证实当前安装版的具体route覆盖限制；没有证明真实招聘站发生了越界重定向，也没有因此完成产品出站边界修复。51job接续393字符成功、猎聘早期2263字符成功及持续blank、BOSS验证时点的七类资源诊断为空，继续分别记录。三个原岗位长期稳定读取仍未完成。

## 用户授权后的持久会话方案与新证据

用户明确要求浏览器复用并保留登录后，本项目独立实现各平台专用持久Context和固定 `data/recruitment-browser/<平台>/profile/`，基础空白Tab保活、每次岗位租约单独开子页。10分钟TTL、普通关闭、取消和读完仅释放岗位页；显式关闭招聘浏览器和服务退出关闭Context，磁盘登录保留。网络路线改变须明确关闭后重开；关闭失败继续跟踪并阻止profile争用。日常浏览器profile、私人Cookie导出、自动验证码均未纳入。该改造保证工具自己不在每岗结束时清空认证连续性，网站端的登录有效期及风控结果仍由网站决定。

工作台“浏览器读取”现走接续start→read，遇gate保留子页。BOSS另实现自然 `detail.json` 响应的被动后备，仅原岗ID、当前已提交文档和完整可见正文印证后采用，不主动访问私有API、不用隐藏响应填补不可见JD。生产路径不额外落盘认证DOM；浏览器按用户授权保留本站登录，与调试输出最小化是两个不同层面。

`recruitment-browser/persistent-originals-acceptance-01.json` 已验证同原URL、同session：51job在计划0/15/30秒三个观察点均HTTP200、393字，实际read完成约4.394/15.980/30.950秒，hash均 `098c5ad5ff031db154cee4019ca4bae04cccb042142b486e5144d55b494b93f3`，与原基线全文一致。猎聘首次read约4.918秒HTTP200、2263字、hash `f9fb8f42a43fa8e19f86a0f365b187a267ce9014a2cf96ab8eeb60e9b0d21ef7`；15/30秒均blank、read返回unsupported_page，不能把早期成功缓存成后续读取成功。持久化本身不足以解决本次blank，仍未确定具体发起脚本或唯一根因。

新BOSS现场实际拦截五个验证组件脚本主机，故仅为BOSS增加 `api.geetest.com`、`api.geevisit.com`、`static.geetest.com`、`monitor.geetest.com`、`static.geevisit.com` 的精确HTTPS443规则，helper同步精确DOMAIN+443，不开放父域或其他平台。候选 `20261017T095115672Z-boss-components` 已 `-t` 退出0并实启，活配置1369字节、SHA-256 `8e6e058ad96c76a3099656112aa38b1ed3ffa6fb054cbdfc1499fcb977a4e1d8`，原5173和FlClash 7890保留。只修复有现场依据的工具限制，不把组件加载等同验证通过。

`recruitment-browser/boss-components-live-check-01.json` 中新start为HTTP200，两次read仍422/verification_required。两次间隔脚本等待10秒，第二次记录约在开始后12.4秒，inspect明确访问验证、mainDocument=200、resources为空。不能由错误列表为空推出所有主机HTTP成功、按钮可用或完整JD已返回，也不能无新依据继续扩域。最新本地全量466/466、lint、typecheck5/5和build3/3通过，chunk体积警告保留；这些检查未完成三站长期稳定目标。普通官方Edge经spawn启动再附加CDP的有限原型另待记录真实结果，其新profile、原生窗口和CDP环境仍与当前生产持久profile存在差异，不能将任何单次对照直接认定为唯一根因或生产验收。

## 后续正式实现指针（23:08）

上述失败与标准持久架构是历史证据。后续BOSS/猎聘已接原生有限CDP、独立profile及受管helper，保留来源、loader和可见全文检查；不启Runtime求值。三个用户原岗位均已有正式全文成功，当前721项基线的51job/猎聘又通过两分钟及关闭重开两轮共10次全文一致回归，旧猎聘持续blank在这些测量中未重现。BOSS展开后3175字符旧正式成功有效，当前补丁另验折叠精确诊断。OS确认退出后才恢复旧租约；断CDP不自动丢归属。完整当前结果、失败留存和范围限制以`../reports/job-browser-reading-2026-10-17.md`末尾为准，仍不承诺多岗位或无限期稳定。

## 2026-10-18 08:35：51job验证失败诊断与native对照

当前失败样本是新桌面岗166509900；原成功51job166761768及原BOSS/猎聘checkpoint47没有新失败。新增两租户verify主机的正常资源支持并实际加载后，用户在同一页人工滑动仍显示“验证失败，请刷新”。08:35:37同SID inspect为verification_required、主HTTP200/计数1、scriptErrors0、resources[]。错误列表只收集失败项，不能还原每个验证请求的发送、返回和完成，也不能据此证明网站接受了验证。未取得站方WAF日志，拒绝原因仍未知。

本批此前已通过公开浏览器实际阅读[阿里云WAF 2.0日志字段说明](https://help.aliyun.com/zh/waf/web-application-firewall-2-0/user-guide/log-fields-supported-by-waf)。文档将request_traceid定义为WAF请求唯一标识，captcha_pass/captcha_strict_pass表示验证通过，sigchl_invalid_type涵盖签名缺失/无效、时间重放及sigchl_is_driver等原因。这是网站运营方可查的日志字段，不是本机浏览器可凭TraceID访问的诊断API；截图有TraceID仍不足以判断此次命中了哪个原因。公开文档说明存在WebDriver检测，不证明当前失败就是该检测。

独立只读审查确认51job当前已用launchPersistentContext、本机可见Edge、独立51job/profile、基础blank保活及每岗newPage/domcontentloaded，read/inspect不主动导航。BOSS/猎聘原生路径则spawn本机Edge、loopback调试端口、有限CDP/DOMSnapshot，不启Runtime或JS求值。当前安装Playwright1.64.1的默认chromiumSwitches没有enable-automation，不能套用旧版本常见参数解释本次失败；它确实启Runtime、utility world/Log及自动附加，使用调试pipe和更多默认功能开关。standard还显式block SW、route全请求和关闭WS；native managed依赖helper且未显式block SW。两者都禁HTTP缓存。差异存在，但同时改变多个条件，没有因果对照。

下一步有区分度的最小诊断是：在仍存活的同SID页上，先准备仅对已证精确验证主机的被动request/response/finished/failed链，记录固定类型、HTTP状态和相对时间；不保存query、headers、Cookie、body、验证码参数或响应正文。历史事件不能补回，HTTP200也不能单独表示业务通过。诊断就绪后才考虑一次正常人工验证，区分未发请求、传输失败、返回后仍失败、验证后导航失败；不能让用户无诊断地连续拖动。此项尚未实现。

native51job亦仅是未实现的工程对照，不能只扩大NativeJobPlatform类型：当前profile表达式是BOSS否则猎聘，必须改穷尽映射并新增独立51job-native；还须贯通工厂/router的backend归属、启动回执、close/stop/retry恢复和Vite开关。DOMSnapshot投影当前只留title/canonical/JSON-LD，没有保留提取器依赖的aliyun_waf_* META，新增平台须保留精确门槛标记或形成独立gate，避免把验证页当正文。保留来源/loader/HTTP校验、helper pin及各项隔离/超时保页/迟到/恢复回归；不得套用猎聘特例、误复用其profile或猜mobile别名。即使native后来成功，也不能据多个同时变化的条件认定WebDriver是唯一根因。详见jd-persistent-browser.ts、jd-native-liepin-browser.ts、jd-cdp-dom-snapshot.ts、jd-browser-session.ts、jd-session-router.ts与vite.config.ts。

本次只读审查未开页、未改生产代码或网络、未执行认证/验证码或新增实站测试。实际加载与测试证据仍以岗位报告read-timeout-preservation批次为准，目标active。

### 08:49实现与实测更新

上述有限事件链现已实现并在原::1:5173受控加载，1006项及独审/真实隔离Edge通过，52文件freeze绑定运行身份。当前同一新增51job166509900页已实际捕获三个初始化/上传/设备xhr的request→response200→finished，主请求1且gate仍存在，未读正文；等待本次一次正常人工验证结果再检查验证请求链。只记录固定host/type/本地序号/HTTP/相对时间，最多32请求/128事件；不解析或保存请求响应body/认证材料，不能判断返回体中的业务拒绝原因。实现补上了“空错误列表无法证明正常响应”的诊断缺口，未因此证明平台验证成功、WebDriver因果或native51job可用；native方案仍未实现。当前权威证据改指岗位报告文末verification-network-20261018批次，旧研究和失败历史保留。

### 08:58隔离native候选

native51job正在仓库外native-51job-candidate-20261018副本实现和独立审查，包含独立profile、明确opt-in路由、精确原岗身份、WAF门禁和有限传输诊断；目前未采用/加载，不能把旧“未实现”研究段误读成已正式交付。主生产52文件仍冻结，当前验证页同SID显式延至09:07:45.914，不为候选重开该页或改网络。此次用户图内请求时间08:30:47，证明旧验证失败而非新SID结果；当前08:57:31仍只有三个初始化请求，尚无实际新验证/正文证据。

### 09:12受控采用与待验边界

上述候选现已通过主1038项、lint/types/build和独审，按旧页权威结束→stop/OS核验→核身份停Vite→只拷11差异→主检查→一次启动的顺序加载。本地Vite/::1:5173、55文件freeze与helper未变证据见岗位报告顶部及native-51job-candidate-20261018/evidence/，独立activation-review只确认部署证据一致性。

正式原166761768首次native启动在岗位导航前停于Edge首次设置/同步，API browser_setup_required、无SID或正文；正在等待用户完成或跳过并复用原窗口。尚未取得native51job的原岗兼容或新增岗验证/正文结论，不把首次设置归因到51job验证码，也不由本地通过推断WebDriver因果或验证必过。

### 09:42实际修复与明确路由验收

用户已完成首次设置。本轮native移动原岗先实际出现frame_url_mismatch，修复HTTP不可变提交与同loader逻辑URL后进入投影，实际ARTICLE.jobinfoDesModule/BODY hidden及无关推荐clamp仍不支持。选择最小恢复：start前按精确来源URL让移动路径继续使用已成功standard，只让精确jobs.51job.com桌面详情使用native；旧SID及启动回执保留原后端，失败不自动切引擎。没有放宽全局visibility，移动scope/geometry WIP未采用。

最终原51job/BOSS/猎聘各两次393/3175/2263字符逐字等于47，新增桌面51job166509900两次313字符一致；四组同SID、>=15秒间隔及close200确认。新岗当前标题“船舶类电子电气调试工程师”，含4职责5要求；这次已实际读通此前失败的新样本，不再等待人工滑动。原47成功、当前四岗成功与所有中途失败分别保留，不能由有限实测证明检测机制的唯一因果或全站长期稳定。证据与检查见岗位报告顶部09:42最终验收。

公开整理前原文已逐字节备份至 Git 忽略的 `.agent-memory/.tmp/github-push-2026-10-18/public-docs-originals/docs/research/job-reading-access-paths-2026-10-17.md`。本文省略本机进程及分享追踪参数；公开岗位标识与研究出处保留，`<local-artifacts>` 仅表示未公开的本地证据位置。
