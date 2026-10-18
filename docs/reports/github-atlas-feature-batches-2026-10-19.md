# 岗位地图分功能交付

日期：2026-10-19。继承既有 main 与正常提交历史，保护并行简历、主题和研究成果，不改写已发布提交。

## 功能批次

| 批次 | 范围 | 暂存快照验证 |
| --- | --- | --- |
| 1 | 共享匹配、来源发现 / 腾讯、地名候选、归并与本机服务并发提交 | `0e3682d`；独立安装、types、lint、1555/1555 测试、build 通过 |
| 2 | 四平台单页搜索会话、API、可见快照、来源和时间标签 | `1ec9256`；独立安装、types、lint、1648/1648 测试、build 通过 |
| 3 | 连续三维地图、聚合进度、详情 / 原文 / 定位、应用联动和部署分发 | `48bc248`；独立安装、types、lint、1778/1778 测试、build 与地图分发通过 |
| 4 | README 两张独立合成截图、工具说明、路线图、验收和续聊指针 | `e12e6a3`；独立安装与 memory:check 通过；120 个本地文件 / 图片目标、9 个锚点与两图尺寸 / SHA 核对通过 |

每一功能批从 Git index 导出完整快照，独立安装冻结锁文件后检查；快照的 workspace 链接不指向后续未提交工作树。GeoNames 原始 `config/geography/gazetteer/SOURCE-README.txt` 与 Natural Earth 原始 `apps/web/src/components/atlas/geo/NATURAL-EARTH-LICENSE.md` 的原有空白完整保留，仅对这两个精确上游文件作差异空白检查例外。私人 SQLite / WAL、令牌、浏览器 profile、私人 SSOT 与 `.tmp` 均不发布。

最终共同产品工作树已有 1778/1778、types 10/10、lint、build 6/6、Pages 子路径 / 地理与 worker 分发、隔离 Docker 269 次 HTTP 检查通过；分批检查另行列出，不将数字累加。实际岗位和交互的有限证据及四站差异见 [聚合交互报告](job-atlas-aggregation-interaction-2026-10-19.md) 与 [平台报告](job-atlas-platform-search-2026-10-18.md)。研究、开发协作分工及用户澄清后的产品 Agent 场景文档仍是提案，没有将飞书、收件箱或自主 Agent 算成实现。

## 发布状态

四批已正常推送 `origin/main`，`git ls-remote` 核得远端为 `e12e6a319b6a178b347db59a8819f43ff5170146`，没有改写历史。25 项文档 / 截图变更的暂存隐私检查无违规；令牌、数据库与临时证据未进入索引。

对应 [GitHub Actions 39149227608](https://github.com/nanfengovo/better-me/actions/runs/39149227608) 已实际完成，Windows 质量、Linux Pages 构建、Docker 镜像 / HTTP 检查与 Pages 部署四任务均为 success。公网返回新版 JS / CSS，实际浏览器加载岗位地图、显式选择合成 22 岗、双击上海岗位后显示详情与定位高亮，所查错误日志为空。该公网验证不包含本机采集或四站额外范围；合成内容仍明确标记。

## 来源扩展三批与测试修复 · 2026-10-19

回应“搜索仍只有腾讯一条，来源太少”，在上述四批之后继续正常提交并推送：

| 提交 | 范围 | 独立检查 |
| --- | --- | --- |
| `4e98df0` | 已下载ATS数组额度内召回、腾讯详情超时保页、通用JSON feed映射与时间精度 | 独立冻结锁安装、types / lint / build、来源适配器127/127定向测试通过 |
| `f4903ae` | 猎聘新版可见根 / 标题 / 公司 / 地区、严格完整性与安全结构计数诊断 | 独立快照types / lint、相关浏览器测试与build通过 |
| `8ebda82` | 六项版本化来源目录、显式添加启用、候选核对、部分进度 / 429说明、临时城市查询与Docker精确目录分发 | 提交产品树与最终冻结树一致；最终全量1843/1843、types10/10、lint、build6/6及Docker271HTTP通过 |
| `1da8bcb` | 现有native TTL会话测试注入固定now / sleep，消除真实时钟推进1ms造成的边界抖动；仅测试2行，无产品计时变更 | 66/66目标测试、ESLint通过；已正常推送，新CI待跑 |

最终冻结产品树为 `8d1bf644e8a6648e28c3230cc422ac114c6cb48e`，40个本轮文件逐一核对快照Git blob，无差异。前两批18文件与最终树一致，最后22文件取冻结blob发布。未混入并行Career Agent、导入、包清单 / 锁文件或其Docker COPY / 白名单；相关并行内容仍留工作树。所有提交正常推送main，无force或历史改写。

最终1843项测试失败 / 取消 / 跳过 / todo均为0；Docker实际镜像构建、UID101非root、只读根目录与健康检查通过，271次HTTP覆盖13项地理资源、PDF / MapLibre worker、许可和静态API边界。构建既有大包提示仍保留。这些验证只覆盖该冻结Atlas树，不与此前1778或并行Agent回归相加。

本机实际可搜索来源3→9、索引37→49岗 / revision22、C#文本命中1→13岗 / 8家企业；六新源不是同轮全部完成，热更新取消、Duolingo超时及3600秒刷新间隔均保留真实状态。Intero原文与Hudl伦敦临时城市估算高亮已核对，猎聘独立C#上海当前页22卡、恢复5286工作树的正式主UI等待加载后明确再次读取22卡均通过；结果不自动入索引 / 地图。51JOB / BOSS、更多地区与卡片审核入索引闭环继续。详情与边界见[召回报告](job-atlas-candidate-recall-2026-10-19.md)。

收尾记录时，新远端状态为：[4e98df0 / Actions39153265664](https://github.com/nanfengovo/better-me/actions/runs/39153265664)与[f4903ae / Actions39153408986](https://github.com/nanfengovo/better-me/actions/runs/39153408986)均已success；[8ebda82 / Actions39153701727](https://github.com/nanfengovo/better-me/actions/runs/39153701727)的Windows质量检查失败，Linux构建与Docker成功，Pages skipped。失败仅为旧native TTL测试使用真实Date.now造成边界值599999与600000差1ms，不能将本轮Pages写为成功。

后续仅测试两行修复 `1da8bcb0c4cab439918dbba083db5a898ba5af25` 已正常提交推送，为现有测试注入固定now / sleep，产品计时不变；66/66目标测试与ESLint通过，新CI待跑。上文1843 / types10 / build6 / Docker271对应原产品验证树，不能声称是后续测试修复后的全量重跑。自有猎聘搜索会话已明确结束，原用户tab5已重新连接5178并恢复C#结果视图，49岗 / revision22、13个文本命中 / 8家企业与9个可搜索来源已再核对；截图只保存在Git忽略目录。 文档候选批次仍待独立检查 / 提交；整个岗位地图Goal保持active。

后续发布核对：`1da8bcb` 与最终文档批 `ad504ff` 已实际完成 Windows 质量、Linux 构建、Docker 和 Pages 四项 success；最终运行见 [Actions 39154486097](https://github.com/nanfengovo/better-me/actions/runs/39154486097)。上文失败和待跑状态是各自历史时点，不能继续作为最新发布状态。

## 首屏等待与卡片审核入统一索引 · 2026-10-19

| 提交 | 范围 | 验证与远端运行 |
| --- | --- | --- |
| `b1fbc6e` | unknown 布局固定 8 秒被动等待，保留门禁 / 取消 / 身份检查，避免 SPA 首屏过早返回 | 定向浏览器回归与最终独立产品检查通过；[Actions 39156486021](https://github.com/nanfengovo/better-me/actions/runs/39156486021) 的 Windows 质量 / Linux 构建 / Docker / Pages 四项已 success |
| `53b6be6` | 严格四平台审核契约、preview / import 工具与 HTTP、SQLite 耐久重试、完整 JD 保护、Web 明确预览 / 勾选 / 提交与实际刷新 | 提交树精确等于独立验证树 `3ec471651276cd661a8a4fccab860d8fe848045b`；[Actions 39156558283](https://github.com/nanfengovo/better-me/actions/runs/39156558283) 的 Windows 质量 / Linux 构建 / Docker / Pages 四项已 success |

25 个本批产品 / 测试文件从独立暂存区导出，冻结离线安装、typecheck 10/10、lint、1886/1886 测试、build 6/6 通过；失败 / 取消 / 跳过 / todo 均为 0。两个批次正常推送 main，没有 force 或历史改写。未混入 Career Agent / 导入、其依赖 / 锁文件、Docker 或共享文档中的并行内容。

真实本机服务更新前完成在线完整备份及 quick_check，重启后原 49 岗 / revision 22 保留。正式主 UI 猎聘 C# / 上海首读 22 卡，明确核对一张并提交后为 50 岗 / revision 23；清地区后 C#14 文本命中 / 9 家企业。该新增岗位的原文、来源摘录和待核实地点在统一列表详情可见；自有浏览器会话已结束。原文薪资专用字段未提取、结构化地点 / 地图点以及 51JOB / BOSS 等未验边界继续保留，详见 [审核入库报告](job-atlas-reviewed-cards-2026-10-19.md)。私人证据不发布，整个岗位聚合 Goal 仍 active。

## 薪资字段、可撤销地区与详情刷新 · 2026-10-19

| 提交 | 范围 | 验证与发布 |
| --- | --- | --- |
| `a6abdc6` | 猎聘精确薪资字段、急聘同级标签和完整标量保护，在线状态不当发布日期 | 薪资相关188/188；[Actions39158828029](https://github.com/nanfengovo/better-me/actions/runs/39158828029)质量／Linux构建／Docker／Pages成功 |
| `53503b3` | 共享地区预览／确认／撤销工具，SQLite V3来源基线与追加决议，Web明确确认和重试 | 提交树精确等于独立验证树 `0794ac47c673518209cc34d9730ec4de17819f60`；1914/1914、types10/10、lint、build6/6通过；[Actions39158987464](https://github.com/nanfengovo/better-me/actions/runs/39158987464)四项成功 |
| `d450d5d` | 地区变更后岗位退出当前条件时清除缓存详情／定位，保留面板外结果提示 | 冻结树 `2766ca4fcad777bdd503e3a4b3ce0c0ca4b6137d`；1916/1916、types10/10、lint、build6/6通过；工作台29/29专项通过，最终远端运行按后续Actions核对 |

最终1916项失败／取消／跳过／todo均为0，冻结离线安装通过；已有chunk体积提示保留。并行Career Agent／简历导入、依赖／锁文件、Docker白名单及其共享文档改动排除在产品树之外，原工作树成果保留。详情修复和本批文档为独立提交，按既有main正常推送，不force或重写历史。

真实猎聘C#／上海当前页22卡，目标15-30k明确审核后更新同岗，50岗／revision23→24；完整备份、V2克隆迁移与quick_check通过，地区确认到25、服务重启保留、明确撤销到26恢复来源未知字段，明确国内筛选排除。最终原页面恢复C#14文本命中／9企业，9个可抓取源保留；不生成坐标、不把来源数当本次成功来源数。来源范围、工具语义和用户操作见[地区与薪资报告](job-atlas-location-confirmation-2026-10-19.md)。51JOB／BOSS、更多地区／完整JD、规模与整体Goal继续。

## 官网协议、英文地点与加载诊断 · 2026-10-19

| 提交 | 范围 | 独立验证／远端检查 |
| --- | --- | --- |
| `6f967a3` | SmartRecruiters通用适配、服务注册、官网发现、Bosch目录与来源标签 | 冻结快照安装、types及相关定向测试通过；[Actions39163391393](https://github.com/nanfengovo/better-me/actions/runs/39163391393)的Linux构建／Docker成功，Windows既有Edge合成导航测试失败，Pages skipped |
| `2aa6936` | 版本化国内英文别名、父省消歧、原事实保持，Docker精确分发新JSON | 独立快照typecheck及地区12项通过；[Actions39163578591](https://github.com/nanfengovo/better-me/actions/runs/39163578591)的Windows质量／Linux构建／Docker／Pages四项success |
| `32186f7` | 原站HTTP／投影／加载阶段／有限资源失败诊断，样式与18项UI回归 | 最终产品树精确等于`857588e439e13d2a9130ab23228a6ceccc659dc0`；[Actions39163675586](https://github.com/nanfengovo/better-me/actions/runs/39163675586)的Windows质量／Linux构建／Docker／Pages四项success |

20文件源码冻结树`9203c15962e3c929ccc030cb73ab239e30317eb3`完成离线冻结安装、1965/1965测试（fail／cancel／skip／todo0）、types10/10、lint、build6/6；随后只补Docker两行JSON复制／白名单，得到最终22文件树`857588e439e13d2a9130ab23228a6ceccc659dc0`。最终树实际Docker构建、UID101、只读根目录、healthy与275次HTTP通过，包含13地理资源、96模板许可文件／20适配源文件、95依赖／97依赖许可文件。不把不同源码时点的验证数量相加，不把最终Docker复验说成重新执行全部测试。

真实主UI明确添加Bosch与同步：50岗／revision27→50岗／revision28→51岗／revision29，12配置／10可抓取源。`.NET`读取4候选、返回2有原链／2完整详情、匹配新增1条；国内全国3条／3企业、江苏苏州Bosch1条，原文／具体发布日期／来源标签／新标签跳转已核。首次超时后手动重试成功。最终原页恢复全球C#14文本命中／9企业，本批.NET不增加C#命中；无办公坐标。更多国内平台、地区、官网来源与规模覆盖仍继续，见[接入报告](job-atlas-smartrecruiters-2026-10-19.md)。

三批均正常推送main，没有force或历史改写；Career Agent／导入／依赖／锁文件及其Docker修改保留原工作树，私人数据库／令牌／备份／profile／实证截图不入仓库。

上一批发布补核：详情修复`d450d5d`及文档`0b69ce9`最终[Actions39159859168](https://github.com/nanfengovo/better-me/actions/runs/39159859168)的Windows质量、Linux构建、Docker和Pages四项均已success；上节待核查文字为其历史时点。

### 本轮C#刷新与测试收尾

随后在原工作台以全球 `C#` 明确刷新10个配置来源，9个返回回执、原始返回705条，实际新增10岗（Arbeitnow 3、Temporal官网7），最终为 **61岗 / revision33、C# 24个文本命中 / 13家企业**。另400条候选要求尚未读全，Bosch受3600秒刷新间隔拒绝、腾讯详情超时，仍保留部分覆盖。Temporal新增样本原文和回链已实际核对，C#是多种可选语言之一，不把24条当专职C#或个人适岗。原页披露的薪资与地点尚未完整映射到索引，当前仍有字段缺口。

新增Temporal样本[Staff Solutions Architect, Majors (Central)](https://jobs.ashbyhq.com/temporal/e8dc6efc-67da-4a5d-859c-85865d6ed21d)原文新标签已核对岗位标题、相同ID和正文；要求在Java／Golang／Python／C#／TypeScript等语言中至少一种。原页显示美国Central时区及多个地点、薪资和佣金区分，但本次API投影尚未把这些规范成国家、可比年薪或办公坐标，保持待补；不以标题中的Singapore或Central猜事实。原本机页面保持全球C#、无国家或城市限制；所有本轮来源等待已终结，61岗／revision33。

首批Windows失败日志仅显示分类unknown，没有记录snapshotState，未声称复现了确切瞬态。测试修复`1209042`只改既有Edge合成测试：在人工导航后有界等待公开navigation_in_progress结束，严格断言ready；ready未知、failed和oversized不重试，原分类／gate／URL／请求数／不导航断言保留。5/5定向及ESLint通过；独立最终树`ce36b767f8d2e4c49a6e49a4b7d3da44f436ce71`冻结安装、types10/10、lint和1965/1965全量（失败／取消／跳过／todo0）通过，未改生产代码，未重复未变的产品构建和Docker检查。该修复正常提交推送，后续[Actions39164275826](https://github.com/nanfengovo/better-me/actions/runs/39164275826)以实际运行结果为准。

产品第二批及最终产品第三批的Windows质量、Linux构建、Docker和Pages已分别全部success，最终产品运行见[Actions39163675586](https://github.com/nanfengovo/better-me/actions/runs/39163675586)。首批失败是历史记录，不能继续当作最新产品发布失败；测试收尾和文档提交的后续CI独立核对。Pages只更新静态程序，本机61岗位、来源配置、密钥与浏览器profile没有上传到GitHub或公共站点。

## Ashby 国家、远程地区与分项薪资 · 2026-10-19

功能`8c8d3479602284a83444aabbe0877ddd6be62252`已正常推送main；冻结产品树`a3c7c6d9509b4710a3ba7908195f3140c21a0f6a`仅6文件，1975/1975（失败／取消／跳过／todo0）、types10/10、lint和build6/6通过。[Actions39165884279](https://github.com/nanfengovo/better-me/actions/runs/39165884279)的Windows质量、Linux构建、Docker镜像／HTTP和Pages均success。本机未另建新Docker镜像，不引用上批275检查冒充本批。

独立真实服务／SQLite读取Temporal70条→C#7条，US＋Chicago／India筛选及完整分项薪资UI通过；原库61岗／rev33、C#24／13企业未改变，原服务停止重启被自动审批拒绝，备份及quick_check完成。并行Career Agent、导入、依赖／锁文件和Docker改动未混入；原本机私人库、凭据、profile和实证截图不公开，详见[Ashby字段报告](job-atlas-ashby-fields-2026-10-19.md)。

## 国内来源实采与完整详情 · 2026-10-19

Ashby文档`aa06e40`已正常推送，[Actions39173399390](https://github.com/nanfengovo/better-me/actions/runs/39173399390)四任务success。随后功能`3a56bc6939e174dd8e1ea855385393457d255c62`补齐jobs.read-detail的同版本locations／compensations／snapshotRevision；独立3文件树`86f43dc458556fea03b17bcfd65ba3bb72fd0533`冻结安装、types10/10、lint、job-service135/135（fail／cancel／skip／todo0）通过。[Actions39174077550](https://github.com/nanfengovo/better-me/actions/runs/39174077550)的Windows质量、Linux构建、Docker和Pages均success。未混入Career Agent或重用旧Docker数字。

原5178／5286均已停止、旧PID不存在后，先核61岗／schema3与完整备份，再恢复；同一受限招聘helper固定配置／binarySHA不变。真实猎聘24卡核对19条（18新增），LinkedIn上海50卡核对6条近月标题C#岗位（6新增），地区逐项确认，最终85岗／rev59、严格国内C#26／22企业、全球48／33企业。两精确会话均关闭；原服务更新后dataset／token哈希不变，新详情HTTP真实通过。原错误页浏览器观察被策略拒绝，未绕过，不称本轮UI目视验收。详细证据与边界见[国内来源报告](job-atlas-domestic-source-expansion-2026-10-19.md)。

## 标签页刷新恢复本机索引 · 2026-10-19

功能`7755cf17fdd449f1a435d1d836b2947577058a8d`已正常推送main，远端SHA已核对。仅5文件冻结产品树`514b0353c9ecca7f9e1671b07f15bc70b71aaf36`完成离线冻结安装、types10/10、lint、65/65定向回归（失败／取消／跳过／todo0）与build6/6；20项新增会话／React回归另经独立只读审查通过。远端质量、Linux构建、Docker及Pages以[Actions39175293892](https://github.com/nanfengovo/better-me/actions/runs/39175293892)的实际结果为准，本机未新建本批Docker。

修复每次刷新默认local／丢失成功连接而重新显示旧机会库的问题：仅明确成功连接后在当前标签页sessionStorage记loopback身份，刷新真实重读；失败仍live并提示重试，切视图／改资料／断开取消旧请求和核对面板，拒绝迟到快照覆盖，StrictMode与存储失败分别回归。旧页首次仍需连接，未自动读取私人凭据。85岗／rev59及26国内／48全球C#真实HTTP复查未变，无新办公坐标；本轮没有新私人索引UI目视。并行Career Agent成果保留，详见[国内来源报告](job-atlas-domestic-source-expansion-2026-10-19.md)。

## 跨来源岗位归并受审工具与界面 · 2026-10-19

工具`d40a7f50c9613955f8ebbc41fd17aa10446a63c4`、界面`4873aa87f51257b52a5b14a73d829517f44523fe`已正常推送main，最终产品树精确等于独立树`7e727e4ed84ba675300051a8e3bd97a6f60ae5bb`。16文件离线冻结安装、memory:check、types10/10、lint、2053/2053测试和build6/6全部通过；失败／取消／跳过／todo为0，独立审查72/72不相加。[Actions39177331005](https://github.com/nanfengovo/better-me/actions/runs/39177331005)的Windows质量、Linux构建、Docker／HTTP和Pages四任务均success。普通HTTP逐级核对首页、主JS、Atlas及归并动态面板200，入口、撤销预览及原key回执代码存在；这不代表新UI目视验收。没有复用旧Docker验证数字，构建原有chunk体积提示保留。

服务更新前完整SQLite备份／quick_check、0运行任务通过，原自有session结束并确认旧进程／监听已无后恢复同一5178；dataset／token哈希不变、恢复任务0。真实85岗／rev59、5对弱线索候选、0历史、首对同版本来源预览且前后库哈希不变；国内C#26／22企业、全球48／33企业等真实共享HTTP复查未变。未合并真实岗位／新增来源／办公坐标，无新私人页面UI目视。详见[归并报告](job-atlas-reconciliation-2026-10-19.md)。并行Career、导入、依赖／锁文件、Docker修改及私人资料均未混入发布，整个Goal active。
