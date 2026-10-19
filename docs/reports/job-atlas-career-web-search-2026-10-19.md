# 通用企业招聘入口搜索接线

日期：2026-10-19，Asia/Shanghai。状态：搜索provider及独立官网访问策略已实现、独立验证、正常推送并更新本机服务；远端构建／部署状态见下方工作流。这个批次扩展招聘来源发现能力，不增加私人岗位库的记录，也不代表已接通全网招聘搜索。

## 问题与结果

已有 `companies.discover-careers` 能匹配已登记企业，或读取明确官网中的招聘链接；虽然定义过搜索接口，正式本机服务此前没有注入提供方，Web 也要求先选择发现策略。因此陌生企业只有名称时，始终需要补充官网，不能继续查找招聘入口。

现在由宿主显式配置搜索提供方，Web、认证 HTTP 与未来 Agent 共用严格请求和结果契约。仅企业名称查询不需要已登记来源；填写官网或种子链接仍须指定已审核的端点策略。搜索线索返回原始查询和证据链接，可用标题／摘要片段保留在evidence.quote，企业归属保持待核实。提案默认禁用、待审核，发现过程不登记来源、不启用来源、不读取具体岗位、不修改索引。

## 提供方与配置

默认不配置网页搜索。CLI 提供两种显式选项：

```powershell
# 自行管理、允许 JSON 搜索的公开 HTTPS SearXNG 实例
pnpm --filter @better-me/job-service start --data-dir $jobDataDirectory --origin http://localhost:5173 --career-search searxng --career-search-endpoint https://search.your-domain.com/search

# 实验 HTML 提供方；可能被限流、验证或页面结构变化阻断
pnpm --filter @better-me/job-service start --data-dir $jobDataDirectory --origin http://localhost:5173 --career-search duckduckgo-html
```

`$jobDataDirectory` 按[服务启动说明](../../apps/job-service/README.md)设置为仓库外专用目录。示例域名需要替换为自己管理且可访问的服务。当前 SearXNG 配置仅允许公开 HTTPS 端点，不接受本机 HTTP、IP、用户信息、查询参数或 fragment，也不支持 API Key；私有实例鉴权与本机 Docker 路线尚未接入。

DuckDuckGo HTML 是显式开启的实验适配，不是官方搜索 API。其[非 JavaScript 页面说明](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript)并不构成第三方自动访问、嵌入或再分发授权；使用时需自行核对[条款](https://duckduckgo.com/terms)和[可接受使用政策](https://duckduckgo.com/acceptable-use)。SearXNG 使用其[JSON 搜索接口](https://docs.searxng.org/dev/search_api.html)，实例运营方仍需负责自身上游配置与访问权限。服务不会轮换公共实例、绕过挑战或自动切换搜索引擎。

## 共享工具和网页流程

- `companies.discovery-capabilities` / 认证 `GET /api/v1/companies/discovery-capabilities`：只返回是否配置、提供方 ID 和标签，不联网探测，不返回端点或凭据。
- `companies.discover-careers` / 认证 `POST /api/v1/companies/discover-careers`：名称查询可传 `{ request: { companyName } }`；明确官网或 seed 另需 `sourceId`。
- 在“来源工具 → 企业官网招聘”展开后才读取配置。未知、读取失败、未配置和已配置分别显示，支持明确重新读取。
- 仅填企业名可匹配已有来源；显式开启搜索后还可查陌生企业。结果分别显示搜索线索数与官网实际读取页数，不将它们当岗位数。
- “使用此企业来源”只选择已有来源；“检查禁用配置”只进入配置核对。注册、启用和手动获取岗位仍是后续独立操作。

关闭、取消、编辑输入、改变来源策略、重新读取能力或切换服务身份会使旧发现失效，迟到响应不能覆盖新选择。配置状态只表示宿主设置，不能代替本次网络成功。

## 官网发现访问策略独立注册

完整流程核对发现，旧注册工具对所有启用来源都要求list-jobs，因此纯官网访问策略不能正常启用。现新增已安装的`discovery-policy@1`，只声明`discover-sources`、实体为discovery-lead，配置为company-directory。注册按真实安装的发现能力校验；旧岗位采集器继续沿用原list-jobs检查，不修改已有来源或放宽端点权限。

[默认禁用配置示例](../../config/sources/company-career-discovery.example.json)仅包含占位主机和路径。本人替换并核对精确范围、明确启用／active、检查JSON并勾选保存后，可用于显式官网发现。策略本身不支持preview／sync，调用直接unsupported且无网络／无run；Web现有岗位能力筛选会排除它，不能当作新增可搜索来源。

另修正策略与企业同名、同域时提前命中自身的问题：只有明确discovery-policy身份排除在已登记招聘来源匹配外，旧HTML草案及其他来源保持原语义。现在实际官网读取不会被权限配置自身短路。搜索候选与新ATS提案仍待核对，不会自动采集。

## 请求和解析范围

搜索请求经既有受控公网 transport、DNS pin、预算和取消链。每次只读一页，最多 20 个线索，解析上限 2 MiB，提供方策略每分钟最多 6 请求，不自动翻页或访问结果目标。结果总是标记部分覆盖。

DDG 只接受预期结果锚点，并保守忽略脚本、惰性与隐藏节点；注释中的空结果字样不能当作搜索空结果。SearXNG 仅接受结构化 JSON，挑战 HTML、损坏结构或所有引擎失败不伪装成无结果。已识别的DDG挑战或HTTP401／403为 `needs-auth`、429为 `rate-limited`，SearXNG挑战HTML或结构改变为 `source-changed`；取消、超时和预算失败继续保留真实状态。

## 真实证据与限制

本轮曾取得 Siemens 的公开 DDG HTML 单页，后续用最终提供方解析器离线重放，得到 10 条线索，首条为 `https://jobs.siemens.com/`，标题和摘要能对应原页面。Siemens 不在静态来源目录。**这证明实际页面结构可解析，不是当前代码实时网络闭环成功，也未获取具体岗位。** 原响应与探针保存在忽略目录，公开仓库不分发搜索全文。

真正通过当前 `createCareerWebSearchProvider`、`discoverCompanyCareers` 与受控 transport 的 Grafana Labs 查询，实际返回 HTTP 202 挑战页。两次请求含一次 DoH，预算计入 14,574 字节，用时约 2.36 秒；工具正确返回 `needs-auth` 后停止，没有重试或换网络路径。不能将其称为成功发现官网。研究中的 SearXNG 公开实例分别限流或返回挑战，未获得可用 JSON，当前没有自管实例真实验收。

纯访问策略另做一次隔离Siemens官网应用探针：临时内存仓库通过正式sources.register显式登记限制策略到revision1，同名策略不被当作招聘来源（0网络）。唯一实际官网读取返回source-changed，transport未取得HTTP响应，随后停止，未重试／切路由。之后固定探针时钟，用此前保存的85,329字节官方HTML重放完整应用，结果为no-candidates／partial、访问1页，既有HTML锚点扫描上限导致截断；前后完整备份一致、1策略／0岗位。它不证明官网发现成功，通用HTML扫描覆盖仍需改进。

私人索引维持上一批 85 岗／revision59。此前真实 C# 文本查询全球 48 条／33 企业、严格国内 26 条／22 企业；这些不是本批新增，也不是适岗评分、全部在招或市场覆盖。原站 51JOB／BOSS、更多地区和完整 JD 继续分别验证。私人页面本轮没有新的浏览器目视验收。

## 验证与发布

仅包含本批16个Atlas文件的独立源码树 `5a81f137877b1e000156f91b23d0fb0ab39f778e`，从HEAD和暂存文件导出、离线冻结安装后，memory检查、types10/10、lint、2099/2099（失败／取消／跳过／todo均0）、build6/6通过。既有大chunk提示保留。provider独立14项及source-adapters196/196属于定向证据，不与全量数字相加。

测试时钟修复 `c1b3140` 与通用搜索功能 `d10bd5d` 已分别正常推送main，推送后远端SHA一致。对应[测试修复Actions](https://github.com/nanfengovo/better-me/actions/runs/39179754673)与[搜索功能Actions](https://github.com/nanfengovo/better-me/actions/runs/39179759591)分别执行质量、Linux构建、Docker和Pages。并行Career Agent／简历导入改动保留在工作树，没有纳入这两个提交。

完整SQLite备份及quick_check通过、确认没有运行中的采集后，已结束自有旧服务并在原5178恢复新版服务。新能力接口认证／默认未配置、无sourceId的已登记腾讯匹配与陌生合成企业缺官网结果均通过真实HTTP；无新增网络搜索。完整dataset／token哈希保持一致，85岗／revision59、全球48／33企业、国内26／22、上海25／21、浦东7／6、松江3／2再次核对，mappedJobs均0。本轮没有新的私人UI目视，不将接口验证当视觉通过。

独立访问策略批 `6fc3761` 正常推送main，8文件独立树`8fe214f7a25f72cf6d1a68039a630d993978b2d8`同样经离线冻结安装、memory检查、types10/10、lint、2109/2109（失败／取消／跳过／todo0）、build6/6。source-adapters200／job-service169为定向包证据，不相加到全量数字；独立审查29项也不相加。远端见[策略功能Actions](https://github.com/nanfengovo/better-me/actions/runs/39180336943)。

策略批再次完整备份／quick_check及空闲核对后，在原5178恢复新版服务；真实sources.list已报告discovery-policy只具备discover-sources，默认网页搜索继续关闭。认证能力读取、企业名匹配、dataset／token哈希和上述地区计数再次一致，没有向私人库登记测试策略或岗位。README／操作说明／规划及续聊记录单独整理；并行Career内容继续保留。

另将既有 `projection-repository.test.ts` 的两处仓库 fixture 注入固定时钟。原测试混用固定观察日期和真实 canonical 提交时间，随执行日期改变会在第三次 repeat-card 导入产生冲突；只固定测试时钟，不放宽生产版本检查。

## 后续

优先接入用户自行管理、实际可用的搜索服务，完成陌生企业→候选→人工核对→明确登记→有限岗位刷新实证。继续完善具体 ATS／官网适配与国内来源覆盖，保持搜索线索、招聘活动、卡片摘录、完整 JD 与已核实在招分别计量。当前提供方不等于可搜索所有企业或全平台岗位。

## 后续修复：大型 metadata 挡住静态招聘导航

保存的 Siemens 官网页面中，一个合法的13,802字符meta配置标签位于所有导航之前。原扫描器在普通标签8192偏移限制处停止，因此未到达后面的Job Search与All Jobs锚点；不能将这次无候选解释为企业没有招聘。

修复提交`02dc34f`仅为明确的opening meta提供最多65,536 UTF-16 code units的总标签长度扫描额度，通过引号状态找到真正的结束位置后直接跳过。metadata属性及其中伪链接不会形成候选，也不会进入真实锚点的证据文字；不建立新作用域。普通标签仍沿用原8192偏移限制（完整标签最多8193 code units），2MiB响应字节、10,000标签、2,000锚点、端点／页数和取消边界保持。未闭合或超限仍停止并报告partial。

对同一份保存的85,329字节官网HTML，通过完整application工具离线重放，现在得到needs-review／partial和6条待核对线索。其中只有以下两条是实际静态招聘导航：

- [Job Search](https://jobs.siemens.com/en_US/externaljobs/Home)
- [All Jobs](https://jobs.siemens.com/en_US/externaljobs/SearchJobs)

前文10条来自DDG搜索结果页，本节6条来自Siemens官网HTML，是不同输入，不能相加。其余4条是FAQ、公司文化、申请流程和无障碍支持说明，不能说成6个招聘入口或6个岗位。当前已无anchor-scan-limit警告；partial来自单页上限及跨域链接未跟随。全部提案仍禁用、待审、无岗位采集能力，前后完整备份一致，内存仓库只有1条访问策略、0岗位／企业／观察／正文快照。本次没有重新联网，不改变此前实时官网transport未取得HTTP和DDG挑战的结论；原响应及完整实证继续只保存在忽略目录。

独立2文件源码树`297ccc7df44eaf3735bad49ade189fecdeb15d0a`经冻结离线安装、memory检查、仓库types10/10、lint、source-adapters全部测试与企业发现host／policy测试合计223/223、source-adapters构建通过，失败／取消／跳过／todo均0。另有23项独立边界探针通过，不与旧2109全仓数字或本次223相加。没有重复未变的前端全量构建；远端工作流另做完整质量、Linux构建、Docker与Pages检查。官网hidden属性及CSS可见性尚未全面支持，不能把本次窄修宣称为完整DOM可见性解析。

本机服务再次在完整在线SQLite备份、quick_check=ok和无采集任务后更新，原85岗／revision59、dataset及token哈希保持。认证共享查询再次得到C#全球48／33企业、严格国内26／22、上海25／21、浦东7／6、松江3／2，mappedJobs均0。本轮未新增岗位、来源或办公坐标，没有新的私人页面目视。若旧页面仍显示腾讯一条，需确认数据视图是“本机采集索引”，首次显式连接后本标签页刷新会恢复；[操作说明](../job-atlas.md)已说明两个数据入口与来源获取的区别。

前四批`c1b3140`、`d10bd5d`、`6fc3761`与`22f40fe`的Windows质量、Linux构建、Docker和Pages均已完成success。最终文档运行见[Actions39180535027](https://github.com/nanfengovo/better-me/actions/runs/39180535027)；公开首页、主JS、Atlas与来源面板实际200，已核新能力接口、搜索配置文案和连接恢复代码，HTTP资源检查不替代UI目视。本次meta修复见[Actions39181034245](https://github.com/nanfengovo/better-me/actions/runs/39181034245)，检查进行中。并行Career Agent、简历导入、依赖／锁文件和私人索引未混入该修复或文档。
