# 岗位分布图：地图与地球技术调研

核查及实施更新日期：2026-10-18（Asia/Shanghai）。**本文同时记录当前实现和早期研究，二者以下分开说明。** 当前正式工作台已接入 `maplibre-gl@6.15.0` 连续地图，支持全球地球 / 国内省域概览进入在线街道底图；此前 Three 展示方案未获用户认可，已退出正式入口。以下历史案例与官方页面的研究不等于这些方案均已安装或采用，在线文档与服务政策也可能继续更新。

整体目标、已确认范围与实施验收见 [架构方案](../planning/job-atlas-architecture-2026-10-18.md)；岗位获取与来源能力证据见 [信息源研究](../planning/job-atlas-sources-research-2026-10-18.md)。

## 当前实施状态与未完成范围

正式入口使用一套 MapLibre 镜头与地理数据图层，全球为 globe 点阵概览，国内为省域挤出概览，连续缩放后显示 OpenFreeMap 街道、地名和建筑数据。MVP Global 的 MIT 源码已用于核对点阵、光晕、有限标签、选中反馈和镜头交互的视觉方向；BetterMe 在 MapLibre 上实现这些设计，未把 COBE 的有限放大当作街道地图。Three 原型只保留为历史比较代码；deck.gl、R3F 和 Cesium 没有成为当前正式入口。

| 层次 | 当前已接入 | 仍需区分的边界 |
| --- | --- | --- |
| 地球 / 国内 / 街道 | 低缩放点阵地球、国内省域挤出、地图区域 / 岗位选择、位置聚焦及同一镜头连续缩放；切换工作台、主题或底图后恢复街道镜头 | 先前 Three 方案被用户拒绝；新实现不代表用户已认可或正式三维目标全部完成，仍需实际视觉与设备反馈。 |
| 底图与地址 | 可配置 OpenFreeMap 浅 / 深色、OSM 标准及离线概览，显示来源署名；Google Maps 为所选位置的官方外链 | 默认 OpenFreeMap `/planet` 原生瓦片最大 zoom 为 **14**，视图最大 **22 是矢量 overzoom**，不是新增 22 级实测数据或厘米精度。道路 / 建筑 / 门牌是否存在取决于源数据；没有内嵌 Google 地图或请求 Google 瓦片。 |
| 查询与显示 | 地图、总计、列表使用共享查询；关键词、地区、控股来源、性质、来源、薪资、直线距离、排序、分页、原币展示与可保存分类配色已接 UI | 列表分页和地图点选择不会把地图总计错误缩成当前页。当前 UI 在浏览器查询受限公共快照，尚未完成数据库查询下推或规模性能验收。 |
| 本机连接与私人接续 | loopback 公开快照连接、取消 / 失败状态、来源详情、JD 分析入口及私人机会预填已接 UI；连接 token 和家庭参照坐标仅在页面内存中 | 不是自动迁移或双主库同步；机会仍经现有编辑流程确认，JD / Fact 匹配的既有真实性约束继续生效。尚无来源采集 / 刷新管理与地图的完整 UI 闭环。 |
| 地理与归并底座 | M2 GeoNames 城市候选、可撤销 repository 归并和现有应用 / HTTP 兼容已落盘 | 城市候选不自动变成办公室地址；候选审核 / 归并审核 UI 与 HTTP 写入口、汇率配置、控股修订 UI、真实采集联动和规模测量仍待完成。 |

默认演示是明确标注的 **22 个全合成示例岗位**，企业、薪资、地点和控制方信息均用于功能演示，不能表述为真实岗位库、当前市场供给或在招核验。用户显式连接本机服务后才读取其公共索引，没有自动导入个人事实或创建采集任务。

当前集成回归为 **1493/1493**，失败 / 取消 / 跳过 / todo 均为 0；typecheck 10 项、build 6 项和 lint 通过；静态 Docker **267 次 HTTP**、Pages 子路径 **18 次 HTTP** 校验通过。这些结果证明对应代码与资源检查，不等于地图帧率、所有网络、真实岗位覆盖、用户视觉认可或整个工程目标完成。当前实现说明见 [地图实现说明](../../apps/web/src/components/atlas/prototypes/README.md)，数据范围见 [边界 NOTICE](../../apps/web/src/components/atlas/geo/NOTICE.md)，领域进展见 [M2 地名候选](../reports/job-atlas-m2-geocoding-2026-10-18.md) 与 [M2 归并](../reports/job-atlas-m2-reconciliation-2026-10-18.md)。

## 历史方案比较与取舍

早期以 **MapLibre globe / 地图投影，加按需 deck.gl 数据图层**作为基线候选，并研究 Three.js / React Three Fiber 的独立造型。此比较支持现在采用真实经纬度、统一镜头和外部街道数据的路线；按需 deck.gl 仅保留为未来数量实际需要时的扩展方向。

省份挤出效果、国家机位、聚合点遮挡和深绿色分类的明暗可读性仍需真实设备验证。旧 Three 原型没有满足用户要求，不继续以雕塑造型替代可进入详细地址的地图。当前在 MapLibre 中维护省域概览和街道层级，而不是同时维护两个正式主地图。

如果最终要求是明显独立于普通 GIS 的雕塑感玻璃省份、金属底座、影棚级布光，R3F 对全球球体和国内挤出地图的造型控制更强；代价是自己承担投影、地理拾取、标签避让、几何简化、聚合、LOD 和接近地面时的精度问题。可把它作为同一数据契约下的另一种展示适配器，不必同时引入多个长期维护的主地图。

Cesium 适合地形、地理椭球、真实建筑与 3D Tiles；当前岗位分布需求尚不需要以其重量和资源管线作为默认成本。COBE 适合克制的概览地球，不适合作为岗位级空间查询和城市下钻的基础。

## 用户指定的 MVP Global：源码核验

- 项目：[EstopaceMA/mvp-global](https://github.com/EstopaceMA/mvp-global)，在线参考：[Kazakhstan 页面](https://mvp-global-pi.vercel.app/?country=kazakhstan)。
- 核查 HEAD：`6bec7c7970eadc2372871829b242405f152cf972`。
- [MIT LICENSE](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/LICENSE)，版权 Mark Anthony Estopace。若后续移植实质代码，须保留许可与版权；个人档案和照片不是 MIT 代码许可自动覆盖的地图数据或素材。
- [package.json](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/package.json)：Next.js、React 19、TypeScript、COBE `^0.6.5`、d3-geo、topojson-client、Motion；不是 Cesium 或 Three.js 项目。

| 实际设计 | 源码证据与对 BetterMe 的含义 |
| --- | --- |
| 点阵地球 + 国家叠层 | [globe-view.tsx](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/src/components/globe/globe-view.tsx) 将国家点、标签与选中边界放在 SVG 叠层，逐帧与 COBE 投影对齐。注释明确：105 个国家点在 SVG 层中，绕开 COBE 0.6 的 64-marker 限制。不能据此推断数万岗位点也适合逐点 DOM。 |
| 几何与点击 | [globe-geometry.ts](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/src/lib/globe-geometry.ts) 自行实现投影、反投影、正面可见性、国家多边形包含判定。没有提供通用瓦片、地址解析或道路路径服务。 |
| 聚合与颜色 | 国家数量使用 `log1p` 缩放点半径和颜色；仅为国家级计数，并非岗位空间索引或视口聚类。BetterMe 的企业分类色不能直接套用其数量蓝色色带。 |
| 标签与移动端 | 前 7 个桌面 / 前 4 个移动端标签，选中优先，并做屏幕矩形碰撞检查。可以借鉴信息优先级，不能把阈值当成 BetterMe 已验证参数。 |
| 生命周期与降级 | [globe-client.tsx](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/src/components/globe/globe-client.tsx) 探测 WebGL、动态加载与错误边界；[ui/globe.tsx](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/src/components/ui/globe.tsx) 处理 context lost、资源销毁、页面隐藏暂停、DPR 上限、减少动态效果；[explorer.tsx](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/src/components/explorer.tsx) 失败后保留可用目录。 |
| 数据与筛选 | [directory.ts](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/src/lib/directory.ts) 做大小写/变音归一和 `includes` 多词匹配，同字段 OR、不同字段 AND；这不是错字容忍的模糊检索。用版本化快照，不能替代持续抓取与来源状态。 |
| 地理数据 | [ATTRIBUTION.md](https://github.com/EstopaceMA/mvp-global/blob/6bec7c7970eadc2372871829b242405f152cf972/public/geo/ATTRIBUTION.md) 明示 World Atlas 2 `countries-110m.json`（ISC 分发许可）、底层 Natural Earth（public domain）、Natural Earth 50m 国家元数据。110m 简化边界缺少部分小地区，因此另用点和选择器表示。 |

值得学习的是地球与侧栏共存、选中国家后相机聚焦、URL 筛选状态、桌面侧面板 / 移动底部面板、失败后仍能完成搜索。源码无法证明当前部署的 GPU 帧率、视觉完成度、色彩可读性或国内网络可用性，这些须以真实页面观察和设备测量为准。

## 国内立体地图：实际找到的项目

下表既列可研究的源码，也区分授权不足的视觉参考。不能把仓库公开或底层 Three.js 开源视为整个项目素材可任意再分发。

| 项目与入口 | 已核源码 / 许可 | 值得参考与限制 |
| --- | --- | --- |
| [dora-ljh/china-map-3d](https://github.com/dora-ljh/china-map-3d) · [在线预览](https://viz.lijihui.top/works/china-map-3d) | HEAD `99a4f6bce4eed2a25ca1259d9b45b757f74a9bf4`；[MIT](https://github.com/dora-ljh/china-map-3d/blob/99a4f6bce4eed2a25ca1259d9b45b757f74a9bf4/LICENSE)。React 19 + TS + R3F / Drei + Three + d3-geo。 | 三层玻璃省份、金属 matcap、接触阴影、相机入场、选中升起、省到市按需下钻；[mapConfig.ts](https://github.com/dora-ljh/china-map-3d/blob/99a4f6bce4eed2a25ca1259d9b45b757f74a9bf4/src/constants/mapConfig.ts) 已把视觉配置独立。适合做材质和交互分层参考，不是现成岗位地图。 |
| [Saitmob/3d-china-map](https://github.com/Saitmob/3d-china-map) | HEAD `7fce15224e0ad52b6675f7eed960016582133350`；根目录未见 LICENSE，`LICENSE` / `LICENSE.md` 原始链接均 404；Vue 2、Three `^0.136.0`、d3、Tween。 | [map.js](https://github.com/Saitmob/3d-china-map/blob/7fce15224e0ad52b6675f7eed960016582133350/src/components/Map/map.js) 是真实 GeoJSON → ExtrudeGeometry、PBR 材质、阴影、Sprite 点和 Raycaster 的示例；可研究效果，暂不移植代码/贴图/边界数据。旧 Vue / Three API 和逐帧全场景拾取也不适合作为 React 19 主工程直接复制。 |
| [AntV L7 官方立体面示例](https://github.com/antvis/L7/tree/master/site/examples/polygon/3d/demo) · [官方示例入口](https://l7.antv.antgroup.com/examples/polygon/3d/) | HEAD `6e3dbfe392b687231447088333da9b0efbfcae53`；[MIT LICENSE.md](https://github.com/antvis/L7/blob/6e3dbfe392b687231447088333da9b0efbfcae53/LICENSE.md)。TS 地理可视化引擎，示例为 JS。 | [floatmap.js](https://github.com/antvis/L7/blob/6e3dbfe392b687231447088333da9b0efbfcae53/site/examples/polygon/3d/demo/floatmap.js) 展示浙江范围悬浮省域/轮廓墙/文字；[polygon.js](https://github.com/antvis/L7/blob/6e3dbfe392b687231447088333da9b0efbfcae53/site/examples/polygon/3d/demo/polygon.js) 是深圳建筑挤出。适合验证国内底图与数据图层分离；样例使用高德底图和外部 alipayobjects GeoJSON，不代表底图服务或这些数据随 MIT 代码免费授权。官方示例入口本轮未单独视觉验收。 |
| [jiawanlong/Cesium-Examples](https://github.com/jiawanlong/Cesium-Examples) · [在线示例](https://jiawanlong.github.io/Cesium-Examples/) | README 明示原生 Cesium、允许直接使用；根目录未见完整独立 LICENSE，标准 LICENSE 链接 404。Cesium 引擎 Apache-2.0 不自动覆盖示例中全部资源。 | 国内 GIS 的影像/天地图、GeoJSON、聚合、二维三维切换、城市模型示例丰富，可作功能参考；本轮未逐项审许可和每个示例外部图层，不能整体打包进 BetterMe。 |

**实际视觉观察边界：**本轮已打开并截图 `viz.lijihui.top/works/china-map-3d`，看到白底挤出省份与阴影的材质方向，同时观察到画面边缘长条 / 撕裂伪影；地图标签和位置还需要核验。它不是已经验收的“高质量可直接交付”组件。其余国内案例核查了源码，未在浏览器逐个操作，也没有做这些项目的性能或完整响应式测试。

**dora 数据与效果的具体问题：**[geo.ts](https://github.com/dora-ljh/china-map-3d/blob/99a4f6bce4eed2a25ca1259d9b45b757f74a9bf4/src/graph/lib/geo.ts) 注释指向 DataV 边界，处理了 winding 和 fitSize 问题，并明确按省中心取景可能让远处岛屿出界。其 [MapScene.tsx](https://github.com/dora-ljh/china-map-3d/blob/99a4f6bce4eed2a25ca1259d9b45b757f74a9bf4/src/viz/MapScene.tsx) 会为缺少真实城市指标的情况生成 adcode 派生示例值和飞线；正式岗位地图必须移除这种合成回退，缺数据就标缺失。README 宣称 HDR / matcap 为 CC0，但本轮未找到逐素材原始出处和完整授权链；地图 GeoJSON 也未见独立许可证明，不能直接沿用。

## 渲染技术对比

| 技术 | 地球与国家视图 | 岗位规模 / TS React 适配 | 工程取舍 |
| --- | --- | --- | --- |
| MapLibre GL JS（BSD-3-Clause，含第三方许可） | 官方 globe、atmosphere、fill-extrusion；同一地图保留缩放/方向与图层模型，可进入国家和城市 | TS API，React 可用封装或生命周期适配；GeoJSON source 内置 cluster、矢量瓦片与视口按需加载 | 最贴近真实地址、点聚合、地区筛选的共用地图基础；艺术感的国内省份挤出仍需原型，不是开关即得到玻璃大屏。 |
| deck.gl（MIT） | 可与 MapLibre globe 同步；独立 `_GlobeView` 官方仍标 Experimental | 原生 React/TS、GPU Scatterplot / Hexagon / GeoJson / MVT 等图层；适合大量点的批量渲染 | 数据图层补强，而不是地址/道路服务。官方性能数字是示例环境，不是项目容量保证；只有实际量达到需要时引入，避免同时加载多套重引擎。 |
| Three.js + React Three Fiber（MIT） | 自建球体 / 球面贴图 / 国家多边形；同栈自建国内 ExtrudeGeometry | React 19 对应 R3F 9 的组合已有国内示例；点用 InstancedMesh / Points，避免一个岗位一个 DOM/复杂 Mesh | 最强造型控制；需要自己完成地理投影、LOD、聚合、标签、拾取和地图数据管线。适合作为经过视觉原型选定的展示适配器。 |
| CesiumJS（Apache-2.0，另含第三方许可） | 地理椭球、2D/3D morph、地形、地理精度、3D Tiles | TS API、React 生命周期桥接可行；大量点用 Primitive / Billboard / 聚合等策略 | 如果之后要真实城市建筑/地形有价值；岗位点与国家分布当前可用更轻方案。引擎许可与 Cesium ion 服务/第三方影像费用必须分开。 |
| ECharts GL（BSD-3-Clause） | `globe` / `geo3D` / `map3D` 图表系列；已核 [官方测试与示例](https://github.com/ecomfe/echarts-gl/tree/master/test) | 可由 React 管理实例，图表事件和色带方便；地图瓦片、地址能力要另接 | 适合统计视图、分布仪表板；不优先承担整个可下钻到企业办公点的空间工作台。示例中旧 world.js/CDN 也不能视为生产资源方案。 |
| COBE（MIT） | 轻量点阵地球；需要自建国家叠层 | React effect 管理 Canvas；适合国家聚合点 | 适合作为小型概览或封面；MVP Global 采用的版本有 native marker 数量边界，海量岗位不能逐项搬到 SVG 层。 |

官方核验入口：

- MapLibre：[地球 + 大气层](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-an-atmosphere/)、[矢量地球](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-vector-map/)、[地球挤出面](https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-fill-extrusion-layer/)、[点聚合](https://maplibre.org/maplibre-gl-js/docs/examples/create-and-style-clusters/)、[大 GeoJSON 优化](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/)、[LICENSE](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt)。早期官方页面示例使用 `maplibre-gl@6.14.0`；BetterMe 当前安装固定 `6.15.0`，实际接入与分发记录见上面的当前实施状态。
- deck.gl：[Mapbox/MapLibre 同步](https://deck.gl/docs/api-reference/mapbox/overview)当前明确写出“Maplibre's globe projection is fully supported”；[独立 GlobeView](https://deck.gl/docs/api-reference/core/globe-view)仍标 Experimental 且说明高缩放精度限制；[性能指南](https://deck.gl/docs/developer-guide/performance)、[LICENSE](https://github.com/visgl/deck.gl/blob/master/LICENSE)。两者不应混为“deck globe 一律实验”或“一律稳定”。
- R3F：[性能指南](https://docs.pmnd.rs/react-three-fiber/advanced/scaling-performance)强调 on-demand rendering、实例化、draw call 控制；[LICENSE](https://github.com/pmndrs/react-three-fiber/blob/master/LICENSE)。
- Cesium：[LICENSE](https://github.com/CesiumGS/cesium/blob/main/LICENSE.md)、[ion 定价](https://cesium.com/platform/cesium-ion/pricing/)。
- ECharts GL：[LICENSE](https://github.com/ecomfe/echarts-gl/blob/master/LICENSE)；COBE：[LICENSE](https://github.com/shuding/cobe/blob/main/LICENSE)。

## 地图数据、地址与通勤是三套能力

地图引擎通常不会免费提供地理编码、公司总部国别判断、招聘地址解析或路线矩阵。建议单独定义可替换的 `GeoProvider`：能力可包括 `geocode`、`reverseGeocode`、`routeMatrix`、服务区域、坐标系、精度、配额、缓存规则和供应商状态。地图渲染器只读取已规范化的空间数据与展示配置。

| 层次 | 候选与已核边界 | 对实现的约束 |
| --- | --- | --- |
| 全球概览边界 | Natural Earth 项目 [LICENSE.md](https://github.com/nvkelso/natural-earth-vector/blob/master/LICENSE.md) 明示 public domain；World Atlas [ISC LICENSE](https://github.com/topojson/world-atlas/blob/master/LICENSE) | 适合简化国家概览，不具备门牌精度；小地区可能只用点。需记录上游版本、处理步骤和来源。Natural Earth 官网 terms 本轮直取 HTTP 406，以上游仓库许可及 MVP Global 引用交叉核验，未假称官网页面读取成功。 |
| 中国省市边界 | 历史 DataV 样例未补齐数据授权链；当前实际使用固定版本 Natural Earth admin-1 派生的 34 个省级显示组，保留处理清单与许可；[标准地图服务系统](https://bzdt.ch.mnr.gov.cn/)是展示边界与标注核对入口 | 当前数据为概略展示，不是官方完整标准地图，源数据缺少完整南海诸岛 / 主张线图层；详见本地 NOTICE，不能声称完整或门牌精度。历史标准地图网站核查 TLS 失败，未读取其当时条款；也未直接移植 DataV 文件。 |
| 全球瓦片 | [OpenFreeMap](https://openfreemap.org/)公开实例 / 可自托管、无 API Key / 注册，当前已接入浅 / 深样式及可见 attribution | 当前原生最大 zoom 14，视图 overzoom 至 22；矢量边线清晰不表示出现额外测量细节。仍需中国网络与跨环境长期稳定性验证，不能保证外部免费服务永远不变。Google 目前仅外链，未内嵌。 |
| 自托管静态瓦片 | [PMTiles](https://docs.protomaps.com/pmtiles/)：通过 HTTP Range 按需读取归档，格式只读 | 可减少常驻瓦片服务需求，但底图数据许可、存储、带宽、Range/CORS、更新和地理数据制作仍有成本。GitHub Pages 的存在不能证明任意大瓦片档案都适合放进仓库。 |
| OSM 公共瓦片 | [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)禁止批量下载 / 预取 / 公共服务离线包，要求识别、署名、缓存 | OSM 数据开放不等于官方瓦片服务无限免费；禁止把免费公共端点当爬虫批量离线源。 |
| OSM 公共地理编码 | [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)为 absolute maximum 1 request/sec，要求识别与缓存，限制系统化批量检索，不允许客户端自动补全 | 不作为实时批量岗位地址解析的无限公共后端。少量手动查询与持续采集需要区分；允许自托管或选择适合的服务商，但都有运维/配额边界。 |
| 国内地址解析 / 路径 | [高德地理编码](https://lbs.amap.com/api/webservice/guide/api/georegeo)、[定价与升级](https://lbs.amap.com/upgrade)明确需要 Key、认证/用途相关免费配额和后续计费、QPS限制 | 可作为国内 provider 候选；开发者 Key 与地图服务授权独立于 BetterMe 免费托管。不能承诺所有用户免 Key / 无限量 / 商用免费。本轮尝试 directionlite URL 返回地理编码文档标题，故不把该地址作为已核路径 API 证据。 |
| 真正三维地形/建筑 | CesiumJS 可用独立来源；Cesium ion Community 定价页限制个人/非商业用途并列配额 | CesiumJS 开源免费和 ion 在线内容服务是不同许可与成本；本轮不把 ion 免费层作为未来商业版默认数据来源。 |

内部空间记录应保留 `coordinateSystem`、原坐标、规范坐标、解析来源、精度（国家/城市/街道/门牌/人工标点）、可信度和采集时间。WGS84、GCJ-02、BD-09 不能混用后直接计算距离；不要仅靠地图显示“差不多”就把未知坐标系当正确。岗位只给城市时，只能显示城市级位置和近似距离，不能生成精确办公楼位置。

“距家距离”默认可用本地球面直线距离计算，无需付费路线 API；必须标注直线距离与位置精度。通勤里程 / 驾车时长 / 公交时长需要另外的路线能力、方式与时间条件，不能用直线距离冒充。按通勤排序建议先用直线距离缩小候选，再对有限候选批量询价和缓存，避免每次拖地图对所有岗位发路线请求。

当前家庭参照点由用户输入 WGS84 坐标，保留在页面内存；连接 token 同样不写 localStorage。企业配色可单独保存到浏览器偏好。共享地图链接、公共快照与日志不得包含精确住址；未来若扩展持久家庭设置，应继续独立私人主库。地理编码和通勤服务发送哪些坐标应让用户看得见，供应商可替换。远程岗位不能定位到总部后假装是上班地址。

## 与工具 / Agent 适配的地图契约

地图模块按三组边界组织，供 TypeScript 应用与未来 LangChain / LangGraph 适配。共享查询和工具、离线地名候选及 MapLibre 展示适配已实现；在线通勤、候选审核写入及 Agent SDK 尚未接入：

1. `queryJobs` / `aggregateJobLocations`：同一规范查询给出岗位结果、去重计数、地区 / 企业类别聚合、未定位数、来源覆盖与新鲜度；输出与地图引擎无关。
2. `GeoProvider`：地址解析、位置纠正、距离与路线能力，独立处理配额、取消、缓存、坐标系和费用边界；Agent 不能因为要绘图就获得无限外部请求能力。
3. `MapRenderer`：消费 `AtlasSnapshot + Selection + ViewState + VisualTheme`，触发地区/岗位选择；不直接爬岗位、不判定企业国别、不保存第二份机会库。用户切换地球 / 国内、地图 / 列表时保留筛选和已选岗位。

全球/全国尺度以国家、省、市或网格聚合；放大后按视口逐级加载办公点。批量散点使用 GPU 图层或实例化，省市边界按需加载和简化；标签只保留选中、悬停和有限重要点。位置未知、仅城市级、远程岗位在列表中仍可见，并显式报告“当前地图已定位 X / 查询岗位 Y”，不能让未落点岗位静默消失。

地图点的企业分类颜色应来自统一、版本化规则配置，而不是渲染代码 `if country === ...`。企业最终控制方 / 总部国家（或地区）与岗位所在国家必须分开；证据未知用“待核实”与中性色，不能从语言、站点或品牌名猜国别。深绿到浅绿、国企黄、私企红可以作为用户要求的默认方案，需允许覆盖、排序优先级和新增类别。聚合点含多个类别时用分段 / 环图或可展开构成，不能只染多数类别后隐去其他岗位。颜色同时配文字、图例和形状，薪资高低不要再占用同一颜色通道。

## 后续实际验收与工程待办

- 在当前固定 MapLibre 与图层版本上继续核对 globe → 国内省域 / 城市 / 街道、选中与键盘操作、明暗、分页及列表一致性；保留跨源岗位数与多地点点数的独立口径，补更多真实来源样本。已有合成集成检查不能替代这些持续验收。
- 对可重复合成的 1k / 10k / 100k 点做数据加载、筛选延迟、GPU / 内存和帧率测量，结论只适用于实测设备；未测不声称“百万岗位流畅”。
- 桌面集显与移动设备上分档降低 DPR、阴影、玻璃透射与后处理；减少动态效果时停自动运镜，后台暂停，按需渲染，切页销毁 GPU 资源。
- WebGL/context lost/瓦片或边界请求失败时保留搜索与列表；“2D 地图”若仍依赖 WebGL，不能称其已覆盖无 WebGL 设备，需进一步退为 SVG 地区图 / 列表。
- 在真实中国网络分别验证瓦片、字体、边界、地理编码和路径服务；离线 / 无 Token 的静态能力与配置服务后的能力分别呈现。
- 用已核来源的边界和合成岗位核验坐标系、行政边界、标签、港澳台 / 南海诸岛表现；检验未知地址、城市级地址、多办公点、跨国远程岗位与家庭位置不外泄。

当前正式渲染路线已选 MapLibre 连续地图，历史源码和官方页面研究保留为取舍依据。已通过的代码 / HTTP 检查不构成规模性能、国内服务长期稳定性或地图数据完整性的结论，也不代表用户已认可新版视觉；整个工程目标仍在继续。
