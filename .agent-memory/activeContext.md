# Active Context

## 当前焦点

2026-10-18：岗位地图 M0 共享领域 / 值规则 / 参考查询 / 实际工具 / 旧库迁移保护已实现，1343 全量回归通过；继续 M1 本机持久索引与可配置来源刷新。完整工程 Goal 保持 active，正式 3D 和产品联动尚未完成。

## 卡点

- 五项已确认：本机自用并预留服务器；按关注范围手动刷新并预留定时；直线距离后续通勤；人民币税前年薪可切原币；按有证据的最终控股方分类、未知及人工修订。无需重问，完整口径见架构方案。
- 全球 3D 地球与国内 3D 地图是正式目标，替代旧“三维后置”建议。MapLibre + 按需 deck 为基线候选，国内造型与 R3F 原型对比后定；地理数据许可 / 坐标系 / 性能仍待实施验证。
- M0 包及 API 见 packages/opportunities/README.md / docs/reports/job-atlas-m0-2026-10-18.md；内存扫描 / 校验 / 哈希是业务基线，不是持久索引或性能实现。统一查询已验，来源采集、跨源归并、3D 与现有 UI 联动待建。四平台单岗读取不等于平台搜索，feed刷新不等于在招核验。
- 既有 GitHub Pages 与 Docker 为静态版；独立 TS 岗位服务待建，Windows 浏览器 companion 留本机。家庭位置 / Key / 事实 / 草稿 / profile 不进 Git，来源刷新不能改私人投递材料。
- 上一批发布基线 f11569a，Actions 39126824044 四任务成功；本轮未操作 About、Docker localhost8080 或原5173。119模板 / 10简历主题 / 4工作台配色×明暗及既有验收边界见原报告。

## 下一步

1. M0功能76a48e4已推送，文档批次随本停点提交；核验CI后继续 M1 独立 TS 服务 / SQLite / 来源适配器与范围刷新，不先重构简历存储。家庭位置仅可信host注入，privateBindings不上传，真实用户迁移尚未触发。
2. M2 持久FTS / RTree与计量；M3 实际视觉 / 性能原型后定渲染器，M4 接现有工作台，M5 稳定与发布。M0工具回执仅进程内，正式服务需耐久事务回执 / 认证 / Origin / 网络策略。完整目标未完成，不标 Goal complete。
3. 按功能验证、commit / push，README / ROADMAP 与报告同步；保留源证据与未覆盖项，不把研究样本外推全站可用。

## 必读附加

- docs/planning/job-atlas-architecture-2026-10-18.md
- packages/opportunities/README.md
- docs/reports/job-atlas-m0-2026-10-18.md
- docs/planning/job-atlas-sources-research-2026-10-18.md
- docs/research/job-atlas-map-references-2026-10-18.md
- docs/ROADMAP.md
- docs/deployment.md（继续运行 / 部署时）
- docs/planning/job-skill-matching-loop-2026-10-17.md（继续岗位 / Fact 联动时）
- docs/reports/docker-release-2026-10-18.md、docs/reports/github-pages-release-2026-10-18.md（复核上次发布时）
