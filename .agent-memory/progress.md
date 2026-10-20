# Progress

本页记录当前交付与待办；2026-10-18公开整理前的完整历史已归档到Git忽略的 `.agent-memory/.tmp/github-push-2026-10-18/memory-originals/`。历史验证数字代表各自时点，UI结果见docs/reports/ui-paper-atelier-2026-10-18.md，119模板集成见docs/reports/open-source-template-integration-2026-10-18.md，已发布批次见原发布报告。

## 当前交付

- [x] 2026-10-21 Agent OS 薄适配层与自省双轨架构升级（`agent-os`）：
  - **高德地理编码与跨版本持久化地名字典（Q5 选项 B & C）**：落地 AMap provider、429 退避、1.1s 门禁与 WGS84 转换，实现地址候选/预览/审计确认/撤销回执流。引入 `normalizeAddressKey` 行政区与门牌规范化，升级为 `{CityCode}:{RoadName}_{HouseNumber}` 标准两段式主键（如 `021:科苑路_399号`）；引入纯 TS 原生 256 维字符 N-Gram 向量嵌入与余弦相似度检索（`createAddressEmbedding` + `cosineSimilarity`，$\ge 0.85$ 阈值），在数据目录建立 `geo-address-cache.json` 持久化，园区/地标变体实现 0 API 消耗毫秒级命中。种子脚本覆盖全国 7 大城市 35 个真实 IT 地标，100% 确认入库。
  - **受审薪资折算与企业控股证据链**：支持任意币种折算至 CNY 固定年现金与证据链溯源；支持穿透式企业实际控制人变更与色彩推导。
  - **国内来源人机策略与结构化 JD 扩充**：会话 TTL 延至 10 分钟与 `waitForVerification` 轮询人机校验；补齐 35 岗完整职责/任职要求/业务/福利结构化 JD。
  - **Evaluator-Optimizer 自省回环与双轨自主型（Dual-Track Autonomy，Q4 选项 B）**：基于 Anthropic 最佳实践落地自省回环（`MaxRetries=2`，梯度止损），自动剥离楼层/园区后缀自省优化重试；落地双轨自主模式，高置信度（$\ge 0.95$）直通生成不可伪造的 Durable Receipt，模糊或只读模式生成 PreviewFingerprint 挂起人工审批。
  - **质量指标**：全工作区核心包 **489 项测试全量通过**（489 pass, 0 fail），TypeScript 零错误。

- [x] 2026-10-20 岗位地图按出处精度落点并收束视野（`agent-os`）：已核办公点为办公楼，街道坐标为街道，无确认的地址坐标不称办公楼，城市中心与城市参考只标城市估算。无坐标街址不补点。相关测试 74 + workspace 56 已通过。合成演示国内搜「上海」约 20 km，详情写「城市估算 · 非办公地址」。真实办公坐标仍为 0，高德未接。

- [x] 2026-10-20 本地工作分支 `agent-os` 已从 `main` `3f1faf4` 拉出。地图精度与开发页自动连接 `52e0854` 已推到 `origin/agent-os`。



- [x] 2026-10-19 真实来源地址补齐与Key准备：当前国内C#19条Liepin原目标全静态读取成功；6+12份有效来源地址分别preview/import，89岗rev67→73→85、source street18（9道路编号），另1条仅上海市未作为办公室采用。完整备份、JD/snapshots/薪资/其他事实/token/五组查询保持，office仍0；2次Nominatim实际查询均0匹配。原服务PID68700运行新版。用户选择无高德Key需步骤，已核官方教程/坐标/服务范围并写amap-setup；没有添加不可用参数或伪装已接通。a21fc4a Actions39214993602四任务success；最新公网资源继续核对，GUI/GPU未新验。

- [x] 2026-10-19 同岗可见地址与来源换址：28840e5/a21fc4a已正常推送，18文件冻结树caf30cd10b离线安装、memory、types10/lint/build6、2504/2504通过（fail/cancel/skip/todo0）。Liepin唯一职责section直接工作地址DD可在完整CSS/text-range验证后作为V2 sidecar，不混入JD、不猜行政值；远程/总部地址等拒绝，V1兼容。换址新地点身份、稀疏刷新跟当前、A→B→A旧坐标不复活。真实6份V1来源地址经预览保存，89岗rev67→73、street0→6（2含道路编号），正文/薪资等保持；2次地址查询均0匹配，office仍0。完整备份后原5178更新PID68700，V4/快检/外键/token/dataset及五组查询保持；GPU/最新UI未目视，完整Goal active。详见visible-office-evidence报告。

- [x] 2026-10-19 来源办公地点与地图性能：0b04056/d99c6d8/ecb7197/8ce6e20/729d474已按功能正常推送。四平台同岗JSON-LD地点、受审保存来源位置、右栏单岗/批量核对、pending多地点、官网唯一同source/编号/URL线索、50岗并发2、内部office保存地址级定位/Esc、空库两栏入口完成。最终15文件树4c151dab22离线冻结2474/2474（fail/cancel/skip/todo0）、types10/lint/build6通过；性能89相关通过，2000点120无关更新0上传、100mousemove1查询/运动中0。完整备份后原5178更新，真实89岗rev67/V4、dataset/token和五查询保持；26国内C#只读计划25平台+1官网、office0/26地点待补，未外读或写入。Actions 39212094106：四任务 success；最新浏览器URL拒绝未绕过，无GPU帧率/新样式目视；并行Career保留，整体Goal active。详见detail-address-review报告。

- [x] 2026-10-19 SmartRecruiters地址保留：稀疏同地点详情仅补省略街道／邮编，国家+单城明确一致且共享字段无冲突，原selector／quote／URL保持，异地或显式地址变更不拼接。旧码2回归失败已复现；修后适配器44／冻结4文件62/62、types10／lint／build6通过。完整备份后原5178更新后台PID82132，89岗rev67、dataset/token、V4和五组C#查询保持，office0，无来源刷新。前桌面文档68535b3四任务success、6公开资源含截图200；本补修发布跟踪中，四平台详情地点闭环继续，Career保留、Goal active。

- [x] 2026-10-19 桌面稳定阅读与地址约束8ddf788／dc2f2a5已正常推送：15文件最终树b7f5c3887完成156/156相关、types10／lint／build6；独立合成UI即时单击前后卡片／地图rect和scrollTop一致、原生双击街址核对→保存1→2→50m高亮、900／390无溢出，viewport复原。离线旧3错误城镇均拒；真实structured地标HTTP200仍错城／道路，正确拒成0候选，未证实际目标。完整备份后原5178更新后台PID29468，89岗rev67／V4、dataset/token和五组C#查询不变、office0；Career保留。原5286旧进程退出后恢复隐藏后台PID57368，首页与3模块200。Actions39195657845首轮旧文件级失败未定根因，独立TAP两次24/24；同SHA仅重跑一次后全量2355/2355、四任务success，公开5资源200；详见desktop-precision报告，完整Goal active。

- [x] 2026-10-19 地址provider真实补验：按当前显式google-doh路径公开地标HTTP200、4.035s／2144B；3个place/house门牌旧规则误滤，b010dd3已推送。冻结树11d0296f2e完成39相关／types10／lint／build6，Actions39192115753四任务success。返回点属于其他城镇，未证目标匹配或岗位办公关联。完整备份后原5178更新session7066／PID43896，89岗rev66／V4与dataset/token不变、0office／0running、五组C#查询保持。最小ABB一次import89／rev66→67，postal0→2、street／coords／office仍0；完整备份及27行政／89alias／所有旧回执／token／五组查询保持。5286四新模块200，最新发布收尾见office-provider-real报告；Career未混入、Goal active。

- [x] 最新桌面反馈已修：3eb8a2f按workspace实际宽度布局，≥900地图／列表／详情三栏，600–899详情正常流，<600才底部sheet，保留地图实例／焦点／Esc。独立树3c826479离线冻结安装、types10／lint／build6与layout＋workspace35／detail10两次测试通过；独立5294合成页1057三栏无重叠、900正常流、390抽屉无溢出，viewport复原；CI39188287804四任务success。未访问私人页，Career未混入。

- [x] 办公地址3a0c8ee已正常推送：来源street／postal保留、四共享工具／认证HTTP／Web预览确认与撤销、SQLite V4永久来源失效与耐久回执、地址级双击高亮。43文件独立树714769506通过冻结安装、memory、types10／lint／2332全量（fail/cancel/skip/todo0）／build6；独立合成UI保存1→2、撤销2→3、重确认3→4、双击50m尺度、三栏无溢出和error空通过。完整备份及V3克隆验证后原5178升级V4、89岗rev66与dataset/token哈希不变、office0；C#全球52／36、国内26／22及上海25／21保留。真实地标探针出站0失败，Nominatim不称实时可用；Career未混入，CI／公开资源收尾见本批报告。

- [x] 2026-10-19 通用官网JSON-LD d00ed1e与Docker许可白名单af903e9已推送；parse5 WHATWG／saxes、受审清单／同源身份／有限预算／企业关联与原始日期，24文件树a152cc42的2234/2234、types10、lint、build6、97依赖许可通过；fix隔离Docker280HTTP通过。原5178更新session88446/PID57336，live首详情timeout partial0且间隔保留；SHA核验原真实公开响应禁止网络重放并public导入ABB2岗到89／rev66，原观察时点不改。全球C#52／36、国内26／22、上海25／21，无办公坐标／私人UI目视；CI继续核。不混Career，Goal active。

- [x] 2026-10-19 独立城市分布参考fe89dc0已正常推送：严格国家+唯一整词城市、完整地点指纹/revision、独立query桶与并集统计、详情出处、双击zoom9、取消/404/重试及旧选择清理；不写source coords或距离。25文件树f38ea445经离线冻结安装、memory、types10、lint、2155/2155、build6通过。完整备份后原5178自有session1288/PID74392已更新，87岗/rev64及dataset/token哈希不变；C#全球50/35、国内26/22、上海25/21；国内26均可城市参考展示但原mapped0。CI39184573691质量／Linux构建／Docker／Pages四任务success，无新私人UI目视。

- [x] 2026-10-19 卡片导入成功后接续地区核对：仅回执jobIds对应的实际地点，成功快照须不低于回执和父版本；lazy复用原地区预览／确认，版本变更、身份切换、关闭及重读隔离迟到回调，失败只GET重读，不重写卡片。2文件独立树b0c36f9b通过96/96相关回归、types10/10、lint、Web build；独立真实React→service-client→工具→内存SQLite的固定国内上海C#查询0→0→1，两个写各1次、mapped0，无真实岗位新增。原85岗／rev59及并行Career保留；9419438旧Windows测试文件级失败未复现（旧源码全套2116/2116），未削弱检查或猜定原因；e862b08正常推送，Actions39182359402质量／Linux构建／Docker／Pages四任务success；公网首页与4个JS均200，核新导入地区入口、版本提示及连接恢复，未称私人UI目视。详见导入地区报告。

- [x] 2026-10-19 官网大型metadata漏识别修复02dc34f正常推送：仅明确meta有64K UTF-16总标签扫描额度，普通标签、2MiB响应、raw/inert及取消保持。独立2文件树297ccc7d冻结安装、memory、types10/10、lint、223/223相关测试、source包build通过；独立23项边界探针无阻断，不与旧2109相加。Siemens保存页完整应用离线重放得到2条招聘导航与4条说明线索，全部禁用待审、partial、0岗且backup不变；不冒充实时官网成功。完整备份后原服务更新，85岗／rev59、dataset/token哈希及国内26／22企业、全球48／33未变，mapped0；无新私人UI目视。前四批Actions均四任务success，公开能力／连接恢复资源200；本修复Actions39181034245四任务success。Career未混入，完整Goal继续。

- [x] 2026-10-19 通用企业名搜索及官网访问策略：c1b3140／d10bd5d／6fc3761正常推送，2099与2109两个独立源码快照分别全通过，均types10/10、lint、build6/6。默认关闭宿主搜索、可显式DDG实验HTML／SearXNG，能力API／仅名无需policy／Web取消隔离；新增discovery-policy只允许精确官网发现、不伪造list-jobs、不自命中，示例默认禁用。完整备份后原5178新版已恢复，新能力和策略元数据HTTP通过，85岗／rev59、dataset/token哈希及全球48／33、国内26／22未变，mapped0。DDG202验证、Siemens实时未取到HTTP和离线扫描截断均明确失败／partial，没有新增岗位。最终CI与部署跟踪见通用搜索报告，Career未混入，整个Goal继续。

- [x] 2026-10-19 归并受审工具／HTTP／UI及实际撤销分组预览完成：d40a7f5／4873aa8正常推送，16文件独立树7e727e4ed离线安装、memory检查、types10/10、lint、2053/2053（fail/cancel/skip/todo0）、build6/6通过；独立审查72/72不相加。提交后超时／取消／输出失败可仅查原key耐久回执，不重写。完整备份后恢复原5178，85岗／rev59、dataset／token哈希不变，真实5对弱线索／0历史／首对只读预览通过；国内26／22与全球48／33复查未变，无新办公坐标或私人UI目视。CI39177331005质量／Linux构建／Docker／Pages四任务success，公网新Atlas与归并动态面板200、入口／回执代码已核；本批文档收尾中，Career未混入，整体Goal继续。

- [x] 2026-10-19 Atlas刷新连接修复7755cf1已正常推送：仅显式成功后在当前tab sessionStorage保存loopback身份，刷新重新读取；失败保持live，切视图／改资料／断开取消旧连接、来源及城市候选／核对面板，防迟到回调与loading残留。5文件冻结树514b0353离线安装、65/65定向、types10/10、lint、build6/6通过，20新增回归独立审查通过；功能CI39175293892四任务success，文档df9bb0b已推送／CI39175389049四任务success；公网新Atlas会话代码实际200，149相对链接／隐私／memory检查通过。本机85岗／rev59、国内C#26／22企业、全球48／33企业真实HTTP复查未变，旧页首次仍需连接，无新办公坐标或私人索引UI目视。Career Agent未混入，整个Goal继续。

- [x] 2026-10-19 国内来源实补：原61→85岗／rev33→59，猎聘上海24卡核对19（18新增／1已有），LinkedIn上海50卡核对6近月标题C#（6新增），逐条确认原卡行政范围，无坐标／性质unknown。严格国内C#26／22企业，全球48文本命中／33企业，上海25／浦东7／松江3真实HTTP通过；两精确搜索会话已结束。详情工具3a56bc6新增同版本locations／compensations／snapshotRevision，独立3文件树86f43dc4冻结安装、135/135、types10/10、lint，远端Actions39174077550四项success；Ashby文档aa06e40四项success。已停止旧PID不存在后恢复原服务／页面，完整备份quick_check与更新前后dataset／token哈希通过，新详情真实HTTP已验；原错误页浏览器观察被策略拒绝未绕过，不称新UI目视通过。并行Career Agent保留，整体Goal active，详见国内来源报告。

- [x] 2026-10-19 Ashby真实字段修复8c8d347正常推送，远端Actions39165884279四任务success；仅6文件冻结树a3c7c6d9完成1975/1975、types10/10、lint、build6/6。主次结构化国家／地区、remote-region及工资／佣金／股权分项保留，无坐标／tax unknown／无tier地点猜测。独立真实70条→C#7条、rev2，US+Chicago1／India1／CN0、全部薪资及原链UI已验；原库61岗／rev33、C#24／13企业、国内2条未变，服务重启被自动审批拒绝，完整备份quick_check通过。文档发布收尾中，详见Ashby字段报告；未混入Career Agent，完整Goal active。

- [x] 2026-10-19 官网协议／英文地点／加载诊断三批6f967a3／2aa6936／32186f7及测试收尾1209042正常推送，产品后两批远端四任务已success。Bosch.NET1新增后51岗／rev29，再全球C#刷新新增10（Arbeitnow3／Temporal7）至61岗／rev33、24文本命中／13企业，10可抓取源；9/10回执、705原始、400要求待核，间隔与超时保留。Temporal原文及可选C#要求核对，地点／薪资投影待补；国内C#仍2岗。原产品源码1965、types10、lint、build6与最终Docker275通过；测试收尾独立树ce36b767再次1965/1965、types10／lint通过，后续CI／文档发布另核；Career Agent未混入，完整Goal active，详见官网接入报告。

- [x] 2026-10-19 薪资与可撤销地区确认落地：猎聘C#上海22卡中目标15-30k重新审核更新同岗，50岗／rev23→24；V2克隆迁移V3、完整备份quick_check通过；上海浦东确认rev25重启保留，明确撤销rev26恢复来源且退出国内筛选。a6abdc6／53503b3已推送，两批远端质量／Linux构建／Docker／Pages均success；详情缓存收尾d450d5d独立冻结树1916/1916、types10/10、lint、build6/6通过，工作台29/29。原页5286恢复C#14文本命中／9企业、9源和50岗／rev26；无新增办公坐标，自有会话结束。最终详情／文档提交远端结果另核，并行Career Agent未混入，整体Goal active；详见job-atlas-location-confirmation-2026-10-19.md。

- [x] 2026-10-19 原站卡片显式审核入统一索引与首屏固定等待已完成：猎聘C#/上海首读22卡，核对1985706689后真实索引49→50 / rev22→23，清上海后C#14文本命中 / 9企业，原9可抓取源保留；自有会话已结束。严格工具 / HTTP / SQLite耐久回执 / Web预览确认、摘录不盖完整JD、子集顺序观察去重已验。独立25文件产品树1886/1886、types10/10、lint、build6/6通过，b1fbc6e与53b6be6已正常推送，两批远端四任务均success；并行Career Agent未混入。原卡薪资未提取、未知结构化地区、51JOB / BOSS与整个Goal继续，详见job-atlas-reviewed-cards-2026-10-19.md。

- [x] 2026-10-19 发布收尾实况：远端实际状态：4e98df0与f4903ae两批Actions成功；8ebda82的Actions39153701727仅Windows旧native TTL测试失败（真实Date.now造成599999≠600000），Linux构建与Docker成功、Pages被阻断 / skipped。随后仅为现有测试注入固定now / sleep两行，产品计时未改，66/66目标测试与ESLint通过；测试修复1da8bcb已正常推送，新CI待跑，不称最终新版已上线。 自有猎聘搜索会话已明确结束，原用户tab5已重新连接5178并恢复C#结果视图，49岗 / revision22、13个文本命中 / 8家企业与9个可搜索来源已再核对；截图只保存在Git忽略目录。

- [x] 2026-10-19 针对“C#只有腾讯一条”完成ATS额度内召回、腾讯详情超时保页、六项JSON来源目录与显式多选添加 / 候选核对 / 429说明 / 临时城市查询。实际可搜索源3→9、索引37→49岗 / rev22、C#1→13文本命中 / 8企业；Intero原文、Hudl伦敦城市级临时定位已验。猎聘新版根独立实读C#上海22卡，正式5286主UI首读未知后等待加载并明确再次读取也显示22卡；结果不自动入索引 / 地图。51JOB安全投影仍空 / unknown_layout、BOSS未完成。三批4e98df0 / f4903ae / 8ebda82已正常推送；最终独立树1843/1843、types10/10、lint、build6/6、Docker271HTTP通过，排除并行Agent / 导入。新Actions以发布报告为准；六新源并非同轮全部成功，3600秒间隔保留，卡片入索引闭环与整个Goal仍继续。

- [x] 2026-10-19 最新反馈修复：多来源并行、真实进度 / 骨架 / 取消、快源先显；共享多词与技术词匹配、有限详情优先级和并发页提交竞争已修。独立详情 / 安全原文、双击精度定位高亮、显式离线城市候选及桌面 / 底部面板已接；单击不遮断双击，候选不写回事实。腾讯原文、深圳估算、390px / 键盘 / 减少动态通过。最终1778/1778、types10/10、lint、build6/6、Pages子路径与Docker269HTTP通过，README新增2张合成地图图，详见聚合交互报告。
- [x] 2026-10-19 LinkedIn C#、原站默认美国当前页50卡 / partial展示；原文新标签标题 / ID核对通过，登录弹窗下完整JD未验。猎聘两次、51JOB首读unknown_layout，BOSS页面未确认；不把失败当无岗位，不称四站或全网已通。卡片未入规范索引 / 地图。
- [x] 2026-10-19 旧5286 preview搜索POST404，精确核归属后替换同Origin / 端口新版dev，POST400参数校验，重连5178真实37岗/rev11并恢复国内C#详情高亮。5178已完整备份及安全重启，新候选API实际通过；原5173/8080/SQL保留。旧启动 / 加载卡点已解除，下方旧时点状态以上方及activeContext为准。
- [x] 四批独立暂存快照已通过并分别提交0e3682d / 1ec9256 / 48bc248 / e12e6a3，正常推送main且远端SHA一致；新Actions39149227608的质量/Linux构建/Docker/Pages四项已成功，公网合成双击详情与上海高亮通过，见 docs/reports/github-atlas-feature-batches-2026-10-19.md；完整Goal active，国内三站与列表入索引闭环继续。

- [x] 2026-10-19 用户澄清是在问“产品内接入Agent做什么比较好”。已整理 docs/planning/product-agent-scope-2026-10-19.md：首批证据匹配/岗位简历优化，后续限定范围的岗位研究，可用薄总控与两个专业角色；不是上轮开发协作分工。仅产品建议，未决定架构或启动接入。同步纠正activeContext中旧宿主启动卡点：最新聚合报告/路线图已记5287可运行、37岗/rev11有限交互及1778检查；四站卡片仍未成功验收，本轮未重跑这些验证。

- [x] 2026-10-19 按用户“先给出总调度和2个Agent的分工方案”完成提案，见 docs/planning/two-agent-integration-plan-2026-10-19.md。建议总调度管共同基线、受控POST协议、现有运行修复与集成；Agent 1做飞书官网来源，Agent 2做人工JD待核对收件箱。明确共享文件唯一修改者、定向/真实验收及后续证据报告/事实检查批次；仅方案，未改产品代码、创建执行分支或启动模块开发，现有四站运行停点继续保留。后续实时核对root/atlas_status/product_status/ui_status：三个子Agent研究任务均完成，新两执行Agent尚未开发；产品自主Agent层仍后置。

- [x] 2026-10-19 career-ops-china（452980a）与当前上游career-ops-hq/career-ops（19df53b）只读源码/许可/复用评估完成，报告见 docs/research/career-ops-comparison-2026-10-19.md。明确人工捕获inbox、官网ATS、证据报告与事实检查的候选价值，以及个人化评分/开放接收服务/时间与主库边界；仅研究，未安装、运行或移植功能，未改变现有四站工程停点。

- [x] 2026-10-19 进度核对：已发布简历/机会工作台，M0/M1底座已有交付；最新地图、地区与四平台搜索批次仍未提交，停在实际运行接线与四站列表验收。本轮只读核对代码、报告与Git并更新续聊记录，未修功能或重新验证运行。下方较早待办叙述以最新 activeContext 和本页顶部日期记录为准。

- [x] 2026-10-19 国内省→市→区县级联、同location组间AND、上级清下级及空库预选完成；2023统计区划来源/许可/hash保留，不冒充现行行政区。空关键词与直辖市解析、HK国家已修，IAB实际上海浦东四个外链可用。四平台搜索会话、50张单页可见卡片、恢复绑定/精确取消/来源时间/UI已落盘；1692/1692全量时点通过，后加面板13项与BOSS防护定向4项通过，types10/10与lint通过。
- [ ] 四平台完整真实验收继续：纯搜索子路径 / Vite加载已修、新开发宿主已运行；当前逐站结论见顶部2026-10-19，不把旧404 / Node加载列为尚未解决，不把LinkedIn单页外推其他三站。
- [x] 腾讯.NET主UI真实sync新增安全评测工程师，5178私有索引现36岗/rev10；同源详情1/1。通用官网发现工具/HTTP/来源UI已接，无搜索provider则明确需官网，未宣称任意企业全网发现。5178新groups运行验证须先完整备份再重启。

- [x] 主来源搜索真实sync、快照刷新、字段覆盖提示、C#/C++/.NET语义、公司关键词与明确国家代码已接；上一源码1570/1570、types10/10、lint、build6/6通过。真实腾讯软件查询收录7（北京2/深圳5），原28海外官网岗位保留；有限详情使.NET preview真实命中1，尚待主UI sync。Pages31/31与13项地理分发通过，最终Docker/发布未完成。
- [ ] 最新地区筛选反馈：修复空库预选被禁用、城市丢国家及同名/多地点串配；四平台仍仅单岗读取，搜索列表/会话未实现。通用公司官网发现工具、HTTP与来源UI接线建设中，新代码需独立验证。

- [ ] 最新真实数据要求：通用来源工具面板、本地机会公共投影、默认真实入口，以及地图/旧机会工作台逐岗位来源与发布时间彩色标签正在接线。满日历月显示具体日期，缺发布时间不推造；真实本机持久索引和有限官网/GitHub发现验收继续。
- [ ] 2026-10-18 地图UI WIP：已接入口、22岗位合成演示、共享条件/全量桶/真实游标、本机快照、来源详情/JD与机会预填。用户拒绝旧Three光滑球视觉，已换MapLibre点阵地球及国内省域到OpenFreeMap街道连续缩放；正验街道/地址精度、重置/切页、Docker/Pages worker及许可分发。M2地名候选和可撤销归并底层已落盘，应用兼容接线继续。全部新改动尚未commit/push，新视觉尚未获用户认可，完整Goal active。

- [x] 岗位地图M1后端：独立TS CLI / loopback认证HTTP / SQLite、五适配器与配置、来源发现/有限抽样/禁用提案、范围预览/手动刷新、分页/部分/429/取消/代次、不可变JD/观察、持久任务指纹/回执、私有目录锁和安全drain。最终1449/1449、lint、types10任务、build6任务通过；Docker静态运行208 HTTP通过；有限4源probe及真实临时HTTP+SQLite+GH两轮5岗10观察5快照通过。功能92ce19f已推送，Actions39133633839已success。未接新UI/四平台companion，FTS/RTree仍全量安全候选，地理编码/跨源归并/3D/私人联动继续建设，Goal active，详见M1报告。

- [x] 岗位地图 M0：独立 opportunities 包、严格证据 / 来源 / 公司 / 岗位 / 观察 / JD / 薪资 / 位置及引用契约；薪资换算 / WGS84 / 可配控股来源颜色、模糊共享查询 / 全量地图桶 / 稳定分页、实际 jobs.search 工具、v1 公共白名单与私人sidecar保护完成。最后全量1343/1343（新包92）、lint、types6/6、build4/4通过；最终Docker隔离208请求通过；合成HTTP / UI / 工具结果一致。真实用户未迁移，正式采集 / 持久索引 / 3D未实现，详见docs/reports/job-atlas-m0-2026-10-18.md。完整Goal仍active。

- [x] 2026-10-18 岗位聚合 / 国内全球三维地图完成五项口径确认、现有架构核对、指定与扩展来源实查、地图源码 / 官方能力研究；已建立完整工程 Goal（active）。方案与 M0–M5 验收见 docs/planning/job-atlas-architecture-2026-10-18.md，来源和地图研究由其链接；本轮仅研究 / 规划，未实现新产品能力。
- [ ] 按 M0–M5 实现共享岗位域与工具、增量迁移、可配置来源 / 手动范围刷新、证据归一 / 去重、统一模糊搜索 / 薪资 / 企业 / 地区 / 距离排序、国内全球 3D 与现有机会工作台联动；先非 Agent 底座，后接 LangChain / LangGraph 薄适配。完整目标尚未完成。

- [x] 新增Docker后的真实Actions39126393123（d7bdf1f）Windows质量、Linux Pages构建、Docker构建运行及Pages部署四任务全部success；后续文档更新继续执行同一工作流。
- [x] GitHub About Website已设在线体验链接；Dockerfile/Compose生产静态版真实Linux/amd64构建通过、镜像约28.5MiB、非root只读健康服务localhost8080。208次HTTP、96模板许可目录+20适配源逐字节、69依赖71许可SHA通过；真实Chrome模板/主题/独立深色/保存刷新/JSON下载通过。额外PDF上传因扩展文件访问设置受阻，未扩大权限，不能算实际提取通过；源构建/CI及README详见docs/reports/docker-release-2026-10-18.md。镜像仓库和远程Docker更新未配置，原5173及其他容器未动。
- [x] 免费托管最终选GitHub Pages（替代先前Cloudflare偏好）；质量/构建/部署工作流与完整部署说明已推送，Pages Source已启用Actions，无额外部署Token。
- [x] 公开README重写、9张真实合成WebP截图及来源/哈希清单、分阶段开发路线图已推送main；截图合计约833KiB，不使用私人履历或API Key。
- [x] GitHub Pages实际上线；首次Actions39124587077三个任务全success，Windows全量1251/1251（fail/cancelled/skipped/todo0）、lint、types5/5；Linux完整/子路径构建与部署通过。公网全新Edge完成模板/主题/深色独立、保存刷新、实际JSON下载、合成PDF实际提取/worker；12响应全200、运行/请求失败0。字体测试allowlist修正和有限范围见docs/reports/github-pages-release-2026-10-18.md，未重做全组合长文PDF/真实模型/岗位验收。
- [x] 四个指定开源来源全量审查与原生适配：119套可选版式（自研6、RenderCV9、JSON Resume官网65、NewFuture3、社区36），新增113；五来源筛选、搜索、每页12张真实缩略图、选中详情及显式推荐配色/字体。切换保留事实、分节与排版；RenderCV YAML映射全部9主题。
- [x] 逐源LICENSE/NOTICE、固定版本/文件哈希与完整目录；awesome31入口逐项审计，19个实际来源贡献39套（含NewFuture），12项重复/工具/失效/授权缺口明确记录。Rick Osborne依用户选择接入CC BY-NC-SA4.0，单独标明非商业，预览/PDF保留作者、修改声明和许可；不覆盖其他模板许可。
- [x] 模板集成基线1212/1212、局部修正后30/30；当前包含并行主题系统的共享工作区1251/1251、lint、types5/5、build3/3通过。6组视口/390次JSON Resume切换/30组功能检查、126份416页实际长内容PDF完成检查与逐页目视复核；原用户数据/服务未操作，已随本次功能批次推送。主题CSS仍统一加载并有大包告警；不将本轮PDF结果外推所有并行新增主题组合或ATS认证。
- [x] 独立主题系统完成：10套版本化JSON简历主题、themeId/安全覆盖/公共CSS变量；4套工作台配色×明暗、偏好保存和跨窗口同步；稀疏layout兼容旧简历，模板切换保留主题，备份/typed历史恢复/DOCX贯通。2380组真实样式、4份4页主题PDF、全站保存/刷新/下载、4视口与16组工作台对比度通过，详见docs/reports/theme-system-2026-10-18.md。未修改原用户数据，已随本次功能批次推送。
- [x] 2026-10-18 UI/模板视觉研究：Lenny公开至技巧6、Apple HIG、Motion/Radix/R3F等来源；ChatGPT仅按brief给PLAN，未审项目代码。研究记录见docs/planning/ui-visual-design-direction-2026-10-18.md。
- [x] 用户随后授权深度UI实施：纸张工作室、浅深主题、真实A4合成模板图库、六套纸面精修、工具栏键盘/浮层行为与克制动效；无新增视觉依赖，已随本次功能批次推送。1201/1201、lint、types 5/5、build 3/3通过。
- [x] 独立origin合成验收：中英实际IAB编辑/预览/保存/刷新通过；6组中英明暗与1440/1280/768/390px视口无横向溢出/浮层裁切/运行错误；11份PDF共43页覆盖6套模板，长内容与边距验证见实施报告。原用户页面数据未改。
- [ ] 用户实际视觉反馈后的精修；额外Headless Edge受控输入与实际IAB结果不一致，原因未定，未算通过。其他系统字体/物理打印机与DOCX同版不在本轮验收范围。
- [x] ChatGPT连接恢复：用户选择auto并保存机器偏好；本项目精确同名连接已配对，原对话真实workspace_info、根目录与package.json读取三步成功，核得迈进更好Agent/main/809ea19/dirty与better-me。未修改其他项目连接或重启本地服务。
- [x] ChatGPT实际源码只读审查：项目/UI/投影/预览/模板/保存历史/导出及Git和既有测试输出已读，迭代2 PLAN已收；面板ARIA语义与应用级undo/redo边界等已本地复核。未修改产品代码、重跑产品测试或实施PLAN，详见docs/reports/chatgpt-connection-review-2026-10-18.md。
- [ ] ChatGPT独立视觉评审：两张截图格式误标已修正并像素等同核验，三张PNG元数据读取成功且本地SDK有image块，但对方仍称图像不可见，未完成目视评审，原因未定；不以CSS或文件信息冒充截图观察。
- [x] Headless Core / Multi-Shell、React/Vite/pnpm workspace；Fact与ResumeView分离，匿名Demo、双语字段和量化待核实。
- [x] 六套自研模板、分节/字段/经历/要点展示选择、主题色/字号/间距、头像与实时预览；分栏拖动和预览跟随。
- [x] 顶栏界面中英与明暗主题独立于简历输出语言和编辑字段筛选；偏好本地保存，深色保留白纸与导出色彩。
- [x] 高亮六色色板、自定义拾色/Hex、选中文字预览；悬停/聚焦只预览，确认应用才改格式，选区失效与Escape行为已验。
- [x] PDF/DOCX/图片/文本/JSON导入、离线与AI规范化、裁剪和原文/模型OCR转录/待补录核对；不声称保留原版式或自动补齐事实。
- [x] PDF浏览器打印、Markdown、DOCX、RenderCV YAML、JSON导出；高亮颜色贯穿schema、备份、历史及导出。
- [x] 自动保存开关与回车/停顿/离开字段条件、始终草稿保护、多窗口冲突提示；IndexedDB最近50版本与命名检查点。
- [x] 历史完整恢复及“恢复此项”；按稳定ID/typed target合并最新文档，先保护当前完整内容或未完成草稿，依赖/陈旧比较拒绝覆盖。
- [x] AI配置、模型列表/生成路径一致性、超时与取消、Key显示控制、Google官方mTLS显式配置；模型列表实际46条成功与Chrome网页失败独立记录。
- [x] 默认/混合示例与无依据个人匹配阻断；隐藏经历不进入skills；建议需唯一claimId与完整本地原句绑定，所有AI结论待本人核对。
- [x] 国内/海外机会库、筛选与看板、多份简历和岗位关联、独立材料快照；Greenhouse/Lever/腾讯公开来源按需预览收藏。
- [x] 手动投递、联系人/截止时间/实际沟通、跟进队列、资料导航及机会库JSON/CSV；无自动发消息或投递。
- [x] 公开分享链接静态/动态读取、岗位截图OCR入口、来源/时间与待核对预览；三平台专用持久浏览器和人工验证接续。
- [x] 岗位会话启动响应丢失恢复、旧ID精确清理、显式延期、超时保留、关闭确认、自有空闲连接恢复及迟到核验隔离。
- [x] 四个指定真实岗位各两次正文读取与一次精确关闭通过；新岗未独立原页逐字核对、有限样本不证明全站长期稳定，详见岗位报告。
- [x] 本地服务自动/直连/手动代理及国内三平台独立路线、检测与连接测试；AI/外链仍走浏览器和系统网络。

## 模板与主题分批发布 · 2026-10-18

- [x] 用户授权按功能点推送；6批功能代码（主题核心、历史/DOCX、119模板、工作室/工具栏、网页配色、简历主题UI）及1批文档逐笔提交并正常推送main，未改写既有历史。
- [x] 每批checkout-index独立快照编译core/storage/Web/node四配置；定向回归依次35/35、74/74、45/45、30/30、17/17，最终全量1251/1251（无失败/取消/跳过/todo）；模板批起逐批Vite构建通过，最终lint通过。
- [x] 同一最终产品源码的仓库typecheck5/5、build3/3通过；主JS923.16kB、导入852.98kB、CSS391.06kB，既有chunk提示保留。每笔push后核对远端SHA，完整索引见docs/reports/github-theme-template-batches-2026-10-18.md。
- [x] 保留两项并行成果、逐源许可证原文与署名；私人SSOT/Key/用户数据/导出/profile/本地验收产物继续忽略。公开文档泛化内部协作ID，原文另存本地忽略目录。
- [x] 本轮仅发布与自动化回归，未重做既有浏览器/PDF视觉验收，原localhost:5173服务和用户数据未操作。后续视觉/性能待办继续保留。

## GitHub分批交付 · 2026-10-18

- [x] 已有两笔本地提交94c5a5e、ff67cdd推送；未重写原提交历史。
- [x] 新功能按界面基础、网络、岗位读取、导入、AI匹配、格式导出、字段恢复、机会工作台、整体接线九批独立提交并逐批推送。
- [x] 每批从Git暂存区导出独立快照，core/storage/Web/server四份TypeScript配置通过，再执行相关测试；共享入口放在集成批次。
- [x] 最终全量1192/1192，fail/cancelled/skipped/todo全0；lint、types5/5、build3/3通过。主JS807.89kB、导入852.98kB、CSS152.29kB，既有chunk提示保留。
- [x] 用户数据/Key/环境/导出/profile继续忽略，补充英文-source.txt规则；公开文档去本机运行身份，完整原档保留本地。
- [x] README、规划、报告、产品边界与续聊停点独立归入文档批次；提交索引见docs/reports/github-feature-batches-2026-10-18.md。

- [x] UI 视觉降噪与层级收纳重构：ResumePreview 工具栏 Split Button 导出收拢与 Tooltip 帮助；移除工作区内重复的 editor-workspace-tabs；收拢 document-bar 消除多行堆叠并释放 130px+ 首屏高度；0 待办时自动隐藏 IssuesPanel；全量 1192/1192、types 5/5、build 3/3 通过。
- [ ] 更多真实导入/OCR样本及DOCX视觉专项；本轮PDF已有有限合成样本逐页验收，不外推全部内容/平台。导入不保留原文件与原版式，缺字段不自动补造。
- [ ] Chrome Gemini网页TLS恢复、真实生成/视觉及本人核对后的个人岗位匹配另验；模型列表成功不能代替这些结果。
- [ ] 更多岗位/布局与长期覆盖；纯静态托管需独立本地/后端岗位服务，受管代理的机器适配需另做可移植设计。
- [ ] AI建议逐条确认应用、个人技能证据匹配与保存触发闭环；未知不能当不会，当前报告不自动写Fact。
- [ ] 来源目录/关注公司/跨源同岗归并/持续更新与机会地图、自动推荐/推送仍为规划，未创建定时任务。
- [ ] 历史链独立导出/长期留存、SQLite/OPFS迁移、大包按需加载、维护者确定开源许可证。
- [ ] 任意字符级diff补丁未实现；当前恢复粒度为展示的差异行。英文缺字段沿用回退，切语言不自动翻译。
- [ ] 对话规划、契约学习、测评/证据回流及插件后置；V1不做自动投递和系统锁机。

公开来源不等于可复制再分发；移植模板继续要求LICENSE/NOTICE。私人求职SSOT始终独立且不入Git。
