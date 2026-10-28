# 实景三维地图供应商研究：Google / CesiumJS / MapTiler

研究日期：2026-10-29。范围：官方在线文档、供应商定价与许可；不是接入完成、实测覆盖或法律意见。没有申请账号/凭据、调用带 Key 的地图接口、启用计费、安装依赖、修改应用或操作当前浏览器页面。

## 1. 结论

**CesiumJS + Google Photorealistic 3D Tiles 是值得做独立验证的实景三维方案，但不能承诺它能解决上海的逼真建筑需求。** 应先验证目标地区覆盖和授权，再决定生产接入；不能把渲染引擎替换等同于数据精度升级。

- CesiumJS 引擎采用 Apache-2.0，Google 城市网格是另一套商业地图数据，二者许可不等同。[CesiumJS LICENSE](https://github.com/CesiumGS/cesium/blob/main/LICENSE.md)、[Google Tiles overview](https://developers.google.com/maps/documentation/tile/3d-tiles-overview)
- Google 当前国家覆盖表中，CN 的 `Map Tiles 2D / 3D` 为单个 `⬤`，而支持 3D 的国家显示 `⬤ / ⬤`；CN 的 `Maps JavaScript 3D` 为 `—`。**不能把第一个圆点读成中国有完整 3D 建筑覆盖。** 表头合并且不是街区级承诺，严谨结论是“不具备可据以承诺上海实景建筑的官方覆盖证据”，不是本轮已做 API 排查、证明上海每个角落绝对没有数据。[Google coverage](https://developers.google.com/maps/coverage)
- 针对适用的新/修改后的 EEA 账单项目，Google Map Tiles 的卫星 2D 和 Photorealistic 3D 不可用，官方明确将返回 403，并不只是“条款可能有差异”。[EEA Map Tiles changes](https://developers.google.com/maps/comms/eea/map-tiles)

## 2. 哪些是不同能力

| 能力 | 含义 | 不等同于 |
| --- | --- | --- |
| 卫星/航拍影像 | 地表二维影像 | 每栋楼都有立体外墙纹理 |
| 三维地形 | 高程形成地形起伏 | 城市楼宇网格 |
| 矢量拉伸楼宇 | 建筑轮廓按高度拉伸 | 摄影测量重建、真实窗户/屋顶/立面纹理 |
| Photorealistic 3D Tiles | 带高分辨率影像纹理的三维网格 | 可自由提取的建筑数据库或测绘精度保证 |

Google 说明 Map Tiles 的 Roadmap/Satellite/Terrain/Photorealistic 3D 是不同数据主题；3D Tiles 本身是 textured mesh。[Map Tiles overview](https://developers.google.com/maps/documentation/tile/overview)、[3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles)

Google 的 3D Maps 覆盖页进一步区分全球地形与仅蓝色区域覆盖的建筑/树木表面，不能因有卫星图、地球或地形就判为城市实景 3D。该页面对应 Maps JavaScript 3D，不应用它替代 Map Tiles 自身的可用性核验。[3D Maps coverage](https://developers.google.com/maps/documentation/javascript/3d/coverage)

## 3. 直接 Google 接入的费用与调用单位

Google 全球按量表当前列出 Photorealistic 3D Tiles：每月免费 1,000 个事件；首付费阶梯（至 100,000 事件）为每千次 USD 6，之后为 5.10 / 4.20 / 3.30 / 2.40。以实际账单地区、协议、SKU 和税费为准，不套用已失效的每月 USD 200 通用抵扣宣传。[Global pricing](https://developers.google.com/maps/billing-and-pricing/pricing)

计费单位的官方 GA 说明是 **root tile 请求**，类似地图会话；不是每移动一次鼠标，也不是每个岗位计费。[Google GA announcement](https://mapsplatform.google.com/resources/blog/build-immersive-maps-at-scale-with-photorealistic-3d-2d-and-street-view-tiles-now-in-ga/)

当前使用文档列出默认每天 10,000 次 root tileset 查询；同一根请求的限时会话供渲染器持续取瓦片，使用/计费页写至多三小时。日配额和月免费额是不同对象；渲染器瓦片还有每分钟速率限制，不能把“不按每张子瓦片收费”理解成无限吞吐。项目实际配额可能不同。[Usage and billing](https://developers.google.com/maps/documentation/tile/usage-and-billing)

仅作首阶梯算术示例，假设全部是符合该全球价格的当月 root 事件，不含其他地图功能、税、特殊合同或其他账户用量：

| 当月 root 请求 | 该 3D SKU 估算 |
| --- | --- |
| 1,000 | USD 0 |
| 5,000 | USD 24 |
| 15,000 | USD 84 |

这与“库中有 5,000 / 15,000 岗位”的渲染压力无直接对应关系。不同标签、反复创建 tileset、重新初始化、会话到期会影响 root 次数；复用正在使用的 Viewer/tileset 生命周期是工程优化，不是跨用户缓存地图内容的许可。

成本防线需按服务核对。Google Cloud 当前已有可强制暂停的 spend-cap budgets，但适用服务列表不含 Map Tiles；不能笼统说所有预算都只提醒，也不能把 Maps 的预算提醒当作硬停用保证。此场景仍需服务配额、请求准入与超限回退。[Spend cap eligible services](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps#eligible-services)

## 4. 凭据与三种接入路线必须分开

### A. 原生 CesiumJS + 自己的 Google Cloud 项目

Google 官方展示了 CesiumJS 直接加载 Map Tiles root URL 的方式；这一条路线**不要求另买 Cesium ion 商业订阅**。需要自己启用计费、Map Tiles API，使用 API Key 或适用 OAuth。[Google 3D Tiles example](https://developers.google.com/maps/documentation/tile/3d-tiles)、[Google setup](https://developers.google.com/maps/documentation/tile/get-api-key)

密钥不能提交 Git；放到 Vite 环境变量中不意味着它对浏览器用户保密。必须按实际产品验证限制组合。Google 的 security guidance 在 web service 产品清单中把 Map Tiles API 放在 IP restriction 一组，动态 IP 场景建议安全代理；同时 Google 有直接浏览器 Cesium 示例。**不据此断言 referrer 一定不支持，也不直接照抄 Maps JavaScript API 的网站限制结论。** 生产前需在选定调用路径、Key 和来源上做独立验证；不能为了“跑通”移除限制。[Google security product matrix](https://developers.google.com/maps/api-security-best-practices#recommended-application-and-api-restrictions)

如采用代理，必须另审身份校验、滥用防护、上游绝对子 URL、凭据泄露和缓存协议；代理不是取得额外数据权利的办法。本轮不选择或实现部署架构。

### B. CesiumJS + Cesium ion token

Cesium 当前的 Photorealistic quickstart 走 ion account/token 路线，不能将其前提误称为原生引擎强制要求。[Cesium tutorial](https://cesium.com/learn/cesiumjs-learn/cesiumjs-photorealistic-3d-tiles/)

ion 当前 Community 面向个人/非商业使用与评估，列有每月 1,000 Google root tiles；Commercial 个人计划 USD 149/月，组织外部集成另有销售/许可提示。选 ion 就按 ion 的套餐、token 和数据条款核算，不能和 Google 直连按量费混为同一份账单，也不能假定它规避地区限制。[Cesium ion pricing](https://cesium.com/platform/cesium-ion/pricing/)

### C. Google 自带 3D Maps JavaScript

若只是需要成熟相机、标记、线面和交互，也值得对照 Google 自带渲染器，而不预设必须 Cesium；它是不同产品，不是开源引擎。当前全球 Immersive Maps SKU 为每月免费 5,000 次地图加载，首阶梯 USD 7/千次。覆盖、许可、定制能力与费用都需单独评估，不套用 3D Tiles 的 1,000/USD 6。[Google 3D Maps product](https://mapsplatform.google.com/maps-products/3d-maps/)、[pricing](https://developers.google.com/maps/billing-and-pricing/pricing)

## 5. Google 数据许可的工程后果

根据 Map Tiles policy 的摘要，以下是实现检查项，不替代正式协议审阅：

- 显示 Google Maps 品牌及当视口数据的完整署名；Cesium 需启用屏幕 credits，不让工具条/面板盖住。
- 不做未获许可的预取、索引、离线包或持久缓存；遵守响应 Cache-Control/ETag。
- 不用瓦片做机器解释、图像识别或地理数据提取；不能把城市网格反推成企业地址库。
- 可以叠加自己独立取得的 3D 对象，但不能从 Google 瓦片描摹/提取生成；业务点与底图来源须清楚区分。

以上均来自 [Map Tiles policy](https://developers.google.com/maps/documentation/tile/policies)。因此 BetterMe 的岗位/地址证据仍必须独立取得；实景背景不是岗位办公点正确性的证据。

EEA 变化按**账单地址和项目状态**适用，不是只看终端用户身处欧洲。对适用项目，官方建议考虑 Maps JavaScript 的 3D Maps/卫星类型等不同产品作为替代，不能通过换 Cesium 实现消除 403。[EEA specific changes](https://developers.google.com/maps/comms/eea/map-tiles)

## 6. MapTiler：不能低估新能力，也不能高估现成数据

MapTiler 官方普通楼宇例子明确使用 `fill-extrusion` 和建筑高度，仍是矢量拉伸。[3D buildings example](https://docs.maptiler.com/sdk-js/examples/3d-buildings/)

它也支持外部 glTF/GLB 三维模型，包括摄影测量模型；新 GeoSplats 使用 WebGPU、用户上传的 PLY splats 与分层细节处理。**所以“MapTiler 不支持实景”不准确；“买了 MapTiler 就有全球 Google 式城市实景网格”也没有依据。** 仍需取得目标城市模型及许可。[3D module](https://docs.maptiler.com/sdk-js/modules/3d/)、[GeoSplats](https://docs.maptiler.com/guides/geosplats/)

当前 Cloud 计划为 Free / Flex / Custom；Flex USD 30/月。Free 适合测试、个人与非商业用途；Cloud 条款允许商业产品 R&D，但不是正式商业生产的免费许可。不同 sessions、3D sessions 和 API requests 配额不可互换；免费超额暂停，Flex 有额外流量费用与可设 spending limit。[Cloud pricing](https://www.maptiler.com/cloud/pricing/)、[Cloud terms](https://www.maptiler.com/terms/cloud/)

如果选择自托管，需另外核查数据与 Server 套餐；不是 Cloud 免费计划自动允许下载和离线发行。[On-prem pricing](https://www.maptiler.com/data/pricing/)

## 7. 对 BetterMe 的条件式选择

| 场景 | 候选方向 | 放行前检查 |
| --- | --- | --- |
| 海外覆盖城市，优先真实视觉 | CesiumJS + Google Tiles，或 Google 原生 3D Maps 对照 | 城市街区覆盖、账单地区、来源/模型坐标对齐、遮挡、首屏网络与设备负载 |
| 国内尤其上海为主 | 保留可用底图；评估许可清楚的国内影像/城市模型 | 不以海外样板画面代替本地验收，不承诺 Google 一键解决 |
| 个人/非商业小规模验证 | Google 直连免费额或合规 ion Community；按选定路线核算 | 开启计费/订阅需用户选择；预算预警不是硬停用额度 |
| 完全离线或可自由缓存 | CesiumJS + 许可明确的开源/自有数据 | 数据取得、托管、更新与精度成本，不只是引擎许可 |
| 当前架构低改动升级 | MapLibre/MapTiler 的卫星、地形、楼宇，或外部模型 | 与摄影测量画质期望有明确区别，避免把拉伸楼宇叫实景 |

建议独立验证先选一个官方确认支持的海外城市作正对照，再检查上海实际目标街区。分别验收：数据覆盖、坐标对齐、版权/凭据与预算、业务标记、硬件性能。未完成这些检查前只作 opt-in 体验，不替换工作地图默认模式。

## 8. 本轮未验证项

未请求任何带凭据的 root/子瓦片，未用公共示例 Key 调 API；没有测上海街区的真实 tileset 内容、当前网络稳定性、FPS/INP、GPU/内存或浏览器兼容性。官方国家表与覆盖页只能作为筛选依据，不是运行验收。也没有替用户判断其账单地区、商业资格或同意任何收费/条款。
