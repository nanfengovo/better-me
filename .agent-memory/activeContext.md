# Active Context

## 当前焦点

2026-10-18：M1 本机 SQLite / HTTP / CLI、五来源适配器与手动刷新完成，1449 全量通过，功能92ce19f已推送；Actions39133633839执行中。下一步 M2 地理 / 归并 / 性能和 M3 实际三维原型。完整Goal保持active，网页与私人机会联动未完成。

## 卡点

- 五项已确认：本机自用并预留服务器；按关注范围手动刷新并预留定时；直线距离后续通勤；人民币税前年薪可切原币；按有证据的最终控股方分类、未知及人工修订。无需重问，完整口径见架构方案。
- 全球 3D 地球与国内 3D 地图是正式目标，替代旧“三维后置”建议。MapLibre + 按需 deck 为基线候选，国内造型与 R3F 原型对比后定；地理数据许可 / 坐标系 / 性能仍待实施验证。
- M1 API / 证据见 apps/job-service/README.md、packages/source-adapters/README.md、docs/reports/job-atlas-m1-2026-10-18.md。FTS5 / RTree 已建但查询仍完整候选扫描，不能声称规模加速；跨源归并、地理编码和 UI 待建。四平台单岗不等于平台搜索，feed刷新不等于在招核验。
- 新服务默认loopback5178、私有token与精确Origin，CLI要求显式目录；系统DNS实测Fake-IP会被拒，显式 --dns google-doh 成功且不改系统。临时真实HTTP/SQLite/GH两轮5岗10观察5快照通过；没有创建用户真实索引、定时任务或迁移个人数据。Windows companion 尚未接新服务。
- M0功能76a48e4及文档2e536c7已推送，前者Actions四任务success；M1提交与CI见新报告。Pages / 现有Docker仍静态版；本轮未动原5173 / 8080 / About。119模板及主题既有视觉范围见原报告。

## 下一步

1. 核对M1远端提交及CI；继续M2受证据地理编码 / 家庭anchor私有设置 / FX配置 / 企业修订 / 可撤销跨源归并与规模测量，不重构简历主库。持久回执只恢复run身份/当前状态，不完整重放HTTP warnings。
2. M3已并行准备固定Natural Earth地理资产（atlas/geo及处理脚本，未正式接入）；实际比较MapLibre globe与Three国家挤出后定渲染器，M4接现有工作台，M5稳定发布。正式3D / 视觉验收尚未完成，不标Goal complete。
3. 按功能验证、commit / push，README / ROADMAP 与报告同步；保留源证据与未覆盖项，不把研究样本外推全站可用。

## 必读附加

- docs/planning/job-atlas-architecture-2026-10-18.md
- packages/opportunities/README.md
- docs/reports/job-atlas-m0-2026-10-18.md
- apps/job-service/README.md
- packages/source-adapters/README.md
- docs/reports/job-atlas-m1-2026-10-18.md
- docs/reports/job-atlas-m1-source-probes-2026-10-18.md
- docs/planning/job-atlas-sources-research-2026-10-18.md
- docs/research/job-atlas-map-references-2026-10-18.md
- docs/ROADMAP.md
- docs/deployment.md（继续运行 / 部署时）
- docs/planning/job-skill-matching-loop-2026-10-17.md（继续岗位 / Fact 联动时）
- docs/reports/docker-release-2026-10-18.md、docs/reports/github-pages-release-2026-10-18.md（复核上次发布时）
