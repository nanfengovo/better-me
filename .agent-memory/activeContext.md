# Active Context

## 当前焦点

本地工作分支 `agent-os`（2026-10-20 从 `main` 的 `3f1faf4` 拉出）。后续 Agent OS 改动放在这条分支上。

2026-10-20 地图精度已落在 `agent-os`：搜索结果按已绘点收束视野。已核 WGS84 办公点单独标「办公楼」；街道坐标标「街道」；无办公确认的地址坐标标「地址坐标 · 非已核办公楼」；城市中心与城市参考标「城市估算」，最高缩放到城市级，不画成办公楼。没有坐标的来源街址不补点。合成演示国内搜「上海」落到约 20 km，详情为「城市估算 · 非办公地址」。真实索引仍是办公坐标 0，街址未解析；缺高德 Key 时到不了办公楼。

2026-10-20 本地开发页已自动连接岗位索引（`agent-os`）：Vite 只在开发服务代读 `~/Library/Application Support/BetterMe/job-atlas/service.token`，启动或复用 `http://127.0.0.1:5178`，Origin 同时允许 `http://127.0.0.1:5173` 与 `http://localhost:5173`。令牌只进当前标签页 sessionStorage。断开后本标签页不再自动连。公网静态页与 preview 仍手动连接。本机新数据目录当前是空索引 revision 0；开发服务已重启在 5173。

2026-10-19：来源换址28840e5、native可见地址V2 a21fc4a及文档321a110已按功能推送；产品Actions39214993602四任务success。18文件冻结caf30cd10b离线安装/memory/types10/lint/build6、2504/2504通过。真实猎聘19目标全部静态同岗读取，18份source地址经预览保存到89岗/rev85（9含道路编号），1份仅上海市未采用；JD/薪资与五组查询保持，office0，2次真实地址匹配0候选。原5178已更新PID68700/session22212，V4/快检/外键/token通过。用户无高德Key、要步骤，已写docs/amap-setup.md；现仅Nominatim，高德未接，坐标/展示存储许可需先适配。地图差量更新/空库两栏已发布；新GPU/布局未目视（URL拒绝未绕过）。Career dirty保留、整体Goal active。

## 卡点

- 网页搜索默认关闭；DDG真实遇挑战，SearXNG仍需可用自管HTTPS JSON实例，尚无实时陌生企业闭环。大型meta截断已修，官网hidden／CSS可见性判断仍不全面；线索不能当岗位。
- 51JOB安全投影空，BOSS曾遇验证；猎聘／LinkedIn仅有限当前页卡片摘录，更多国内地区／官网及完整JD继续，48文本命中不当个人适岗或全网覆盖。
- 真实89岗rev85，18份来源street字段（9道路编号），office仍0；2真实地址查询均0匹配。受审薪资字段、FX持久与Web同版接线、控股证据操作缺口已审查，未实现；规模性能继续。归并及行政确认保留；Temporal旧字段按原刷新间隔补，不自动重抓。
- 原错误标签页的自动浏览器观察被URL策略拒绝，未换方式绕过；本轮最新采集／筛选／详情通过HTTP，不称新UI目视已验。原5173／8080和并行Career Agent保留，私人库／备份／profile／实证不入Git。

## 下一步

1. 本批产品CI四任务success，完成最新文档/公网资源核对；接下来用户按docs/amap-setup.md准备Web服务Key，正式provider仍待坐标/展示使用方式适配。当前89岗rev85、source street18、office0，逐岗精确坐标仍是核心缺口。
2. 扩更多国内来源／地区、官网实际岗位协议与完整JD；保留平台人工验证与来源刷新间隔，不绕既有私人页面URL策略。
3. 依据薪资／FX／控股缺口报告先落受审薪资CNY闭环，再接带出处的同版FX和企业证据；原文、版本失效、幂等回执、撤销与地图列表统一投影必须保持。

## 必读附加

- docs/amap-setup.md（用户无Key需步骤；当前尚未接高德，不能写假参数）

- docs/reports/job-atlas-visible-office-evidence-2026-10-19.md（最新V2/换址、2504项、真实6地址/rev73/office0；其余旧报告数字为历史）
- .agent-memory/.tmp/atlas-visible-office-final-verified.json、.agent-memory/.tmp/visible-office-final-postcheck.json（本机最终验证）

- docs/reports/job-atlas-detail-address-review-2026-10-19.md（当前来源地址/批量计划/性能/真实覆盖缺口与发布）

- docs/reports/job-atlas-desktop-precision-2026-10-19.md（当前桌面稳定轨道、地址约束、156回归、实际合成UI和原服务更新）
- docs/reports/job-atlas-office-provider-real-2026-10-19.md（本轮真实HTTP、门牌格式修复、39隔离相关测试、原服务及邮编增强）
- docs/reports/job-atlas-salary-control-gap-2026-10-19.md（下一步薪资／FX／控股源码缺口及未实现范围）
- docs/reports/job-atlas-desktop-office-address-2026-10-19.md（本轮桌面三栏、V4办公地址、2332隔离回归、合成浏览器及原服务升级）
- docs/reports/job-atlas-jsonld-sources-2026-10-19.md（通用JSON-LD、2234隔离回归、实时timeout与原响应导入分开、Docker许可）
- docs/reports/job-atlas-city-references-2026-10-19.md（独立城市分布、2155隔离回归、87岗真实HTTP与发布范围）
- docs/reports/job-atlas-import-location-2026-10-19.md（入库成功后接续地区核对、96相关回归与合成真实应用联动）
- docs/reports/job-atlas-career-web-search-2026-10-19.md（provider／独立访问策略、2099／2109与meta修复223检查、真实挑战与未完成闭环）
- docs/reports/job-atlas-reconciliation-2026-10-19.md（七工具／受审UI／持久回执恢复、2053隔离验证与5对真实弱候选）
- docs/reports/job-atlas-domestic-source-expansion-2026-10-19.md（最新85岗／26国内C#／48全球文本、完整详情、服务恢复及135隔离回归）
- docs/reports/job-atlas-ashby-fields-2026-10-19.md（新字段、1975隔离回归／真实7条与原服务更新阻断）
- docs/reports/job-atlas-smartrecruiters-2026-10-19.md
- docs/reports/github-atlas-feature-batches-2026-10-19.md
- docs/reports/job-atlas-location-confirmation-2026-10-19.md
- docs/job-atlas.md、apps/job-service/README.md、docs/ROADMAP.md
