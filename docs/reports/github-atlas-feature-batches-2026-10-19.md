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
