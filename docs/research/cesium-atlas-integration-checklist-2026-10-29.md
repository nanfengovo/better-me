# CesiumJS 实景岗位地图接入复核清单

日期：2026-10-29。范围：官方文档与官方源码复核；为本轮实现提供检查项，不代表 SDK 已集成、上海实景已通过或供应商请求已成功。没有读取凭据、请求带凭据瓦片、启动服务、修改应用代码或操作用户页面/简历/岗位数据。

复用前期 [提供商研究](./photorealistic-map-providers-2026-10-29.md) 与 [渲染接入方案](../planning/job-atlas-photorealistic-map-2026-10-29.md)，以下重点是实现时容易遗漏的细节。官方 `main` 源码可能继续变化，实际实施须以锁定包版本的导出和 TypeScript 类型再核对。

## 1. Vite 与静态资源

- CesiumGS 官方最小 Vite 示例使用 `cesium/Build/Cesium` 中的 `ThirdParty`、`Workers`、`Assets`、`Widgets`，复制到一个专用静态前缀，并通过 `CESIUM_BASE_URL` 告知引擎路径；同时导入 widgets CSS。[官方示例](https://github.com/CesiumGS/cesium-vite-example)、[Vite 配置源码](https://github.com/CesiumGS/cesium-vite-example/blob/main/vite.config.js)
- BetterMe 有非根部署场景，专用前缀必须跟随实际 Vite `base`。根目录 `/cesium/` 本地可用不能证明 Pages 子路径和生产构建正确。这是对本项目的工程推论，需分别验证 dev 与 build/preview。
- 资源路由只读且只服务白名单目录；需防路径穿越、正确 MIME、404 不落到 HTML SPA shell。专用目录内按锁定依赖带出的 Workers/WASM 等资源整体复制，不能只挑开发时恰好访问过的几个文件。
- Viewer 与 CSS 应在进入实景模式时懒加载，不将 Cesium 引入默认 MapLibre 首屏；退出销毁 Viewer、事件订阅和 WebGL 资源。官方 Viewer 的 `destroy` 明确用于释放 WebGL 资源。[Viewer](https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html#destroy)

## 2. Google 直连与 ion 不可混淆

当前官方 `createGooglePhotorealistic3DTileset(apiOptions, tilesetOptions)` 源码显示：

1. 显式 `apiOptions.key`（或全局 `GoogleMaps.defaultApiKey`）存在时，创建 Google `v1/3dtiles/root.json` 的 Resource 并调用异步 `Cesium3DTileset.fromUrl`。
2. 两处 key 都未提供时，会改走 ion asset `2275207`，不是自动提供匿名免费 Google 数据。
3. 直接传 Google key 的路线不要求另设 ion token；但必须关闭 Viewer 默认影像/地理编码等可能使用其他服务的默认功能。
4. factory 将 Google 品牌 credit 加入 Resource，但不能因此遮住、删掉动态数据署名。

以上以 [factory 官方源码](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/createGooglePhotorealistic3DTileset.js) 与 [GoogleMaps 官方源码](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/GoogleMaps.js) 为依据。

**应用应在没有 key 时直接给出配置状态，不能调用 factory 再期待无凭据失败，也不能不经用户选择偷偷切 ion。** 不设置全局 key 可避免跨 Viewer/测试的隐式配置污染。Google 直连凭据放置位置、浏览器暴露和产品级限制仍需按实际部署验证，不把 Vite env 当成秘密保管库。

源码中有 `onlyUsingWithGoogleGeocoder` 提醒。不要仅为消除 warning 无条件声明该标志，也不要把已有第三方地理编码 UI 默认带入 Google 实景模式。若此模式没有地名搜索，禁用 Viewer geocoder；若将来引入地址搜索，需单独核对相应服务、条款、费用和数据披露。该限制提示来自官方源码；不以本清单代替法律许可审阅。

Google 自己的接入页仍含较早的同步构造示例；实施应使用安装包支持的现代异步 factory/fromUrl，不照搬旧版脚本。[Google 3D Tiles 接入](https://developers.google.com/maps/documentation/tile/3d-tiles)

## 3. 按需渲染、内存与业务点位

- 打开 `requestRenderMode`；若没有依赖模拟时间的效果，考虑 `maximumRenderTimeChange: Infinity`。更新点位、选中样式、可见性及 resize 后显式 `scene.requestRender()`。相机与瓦片加载已有自动渲染触发，不能在每个更新周期又无条件 requestRender，否则失去按需收益。[Scene](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#requestRenderMode)、[官方显式渲染说明](https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/)
- 当前 factory 默认给 Google tileset 配置约 **1.5 GiB cache + 1 GiB overflow**，大于普通 tileset 默认值。因此应用应按质量档明确传入 `cacheBytes` 和 `maximumCacheOverflowBytes`；不能以普通 tileset 默认 512 MiB 推断实际内存预算。`maximumScreenSpaceError` 越大，细节越低而性能通常越好。[factory 源码](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/createGooglePhotorealistic3DTileset.js)、[Cesium3DTileset](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- 大量业务地址优先少数 BillboardCollection，每个 collection 放多个 billboards；静态与高频变化数据可分组。使用 heightReference 或与 globe 深度测试时，BillboardCollection 需要 scene。[BillboardCollection](https://cesium.com/learn/cesiumjs/ref-doc/BillboardCollection.html)
- `HeightReference.CLAMP_TO_GROUND` 可涉及地形和 3D Tiles；官方特别要求摄影测量 tileset 开启 `enableCollision`，否则贴附可能不正确。当前 factory 已默认 true，仍需针对实际锁定版本核对。[HeightReference](https://cesium.com/learn/cesiumjs/ref-doc/global.html#HeightReference)、[tileset enableCollision](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html#enableCollision)
- `scene.clampToHeightMostDetailed` 会触发最精细 tiles 查询、原地修改传入坐标数组，可能返回 undefined，且要求 3D 模式和深度纹理支持。不要为全库每个岗位逐条运行；若确需贴附，仅用于有限可见/选中显示点，并保留原始 WGS84。表面高度只是显示策略，不能回写成岗位楼层或来源地址证据。[Scene clamp](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#clampToHeightMostDetailed)
- 5,000/15,000 岗压力测试必须同时记录去重后实际点位数；重叠岗位不应重复生成大量 DOM 标签。增量点位更新不能重新构造 Viewer/tileset 或拉走正在看 JD 的相机。

## 4. 署名与数据使用检查

Google 规定同时保留品牌与各显示瓦片的动态来源署名；Cesium 需开启 `showCreditsOnScreen: true`。品牌不能和 Cesium/业务 logo 相互遮盖，动态提供商信息不能替换成一条静态“Google Maps”。[Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies)

检查桌面/小屏、错误卡、地图控制条、分栏拖拽后，底部 credits 都可见。业务岗位来源与 Google 底图来源应明确分开。

不增加 Service Worker/IndexedDB 离线瓦片包，不做预取/索引/网格提取；HTTP 使用遵循响应缓存头与协议。地图可视化不等于有权从纹理/网格反推新的地址、建筑或高度数据库。[Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies)

## 5. 错误分类必须保留不确定性

官方 3D 错误文档明确指出错误可能被 renderer 吞掉；需要同时处理 factory rejection、tileFailed、renderError/上下文丢失，并在支持的错误对象上读取结构化状态码。不要把所有错误拼成可能带 key 的原始 URL/堆栈展示。[Google 3D errors](https://developers.google.com/maps/documentation/tile/error_handling)

| 可观察信号 | 可以说什么 | 不应武断下结论 |
| --- | --- | --- |
| 400 | 请求参数/凭据/session 无效，需核对配置 | 不一定只有 key 写错 |
| 403 | 服务拒绝访问；检查 key、启用状态、账户/地区适用性等 | 不直接判定为上海没覆盖，或保证更换 key 必能解决 |
| 429 | 额度或请求速率受限，停止密集重试并提示稍后重试/核对配额 | 不循环重建 root 造成更多请求 |
| 只有加载超时/网络失败 | 暂未成功取得场景，可能与网络/服务有关 | 不冒充有明确 HTTP 状态，也不判断无数据覆盖 |
| root 加载成功 / allTilesLoaded | 当前加载阶段已完成 | 不能因此宣布目标街区有摄影测量建筑 |
| WebGL/渲染异常 | 当前设备/浏览器未成功呈现，可回工作地图 | 不影响岗位搜索和已保存数据 |

EEA 相关 Google 文档明确有部分账户无法返回摄影测量内容；实际项目适用性不能仅凭终端 IP 判断。403 可能有多种来源，若没有服务端明确错误详情，只列检查项。[EEA 调整](https://developers.google.com/maps/comms/eea/map-tiles)

## 6. 上海覆盖：本轮没有实测，不可承诺

当前官方国家表中 CN 的 `Map Tiles 2D / 3D` 只有一个可用标记，且 `Maps JavaScript 3D` 为不可用；有明确 3D 标记的国家显示两个标记。因此没有足够官方证据承诺上海具备实景城市网格，不能用全球地形/卫星影像或海外演示代替上海验收。[官方覆盖表](https://developers.google.com/maps/coverage)

建议 UI 采用“覆盖待验证/加载中/访问失败”等有依据状态，除非已取得目标区域的可靠覆盖信号，否则不要自动报“此地区没有覆盖”。Google Maps JavaScript 的覆盖工具属于另一产品，不能单独作为 Map Tiles 的运行证明。[3D Maps 覆盖工具](https://developers.google.com/maps/documentation/javascript/3d/coverage)

凭据授权后独立验收：确认支持的海外正对照 → 上海实际目标街区 → 业务坐标与纹理位置对齐 → 不同视角/缩放 → 署名完整 → root/子瓦片请求与资源成本观察。没有凭据时仍可完成 SDK/资源路由/交互/故障回退和合成压力验证，但必须将真实摄影测量与成本验收明确保留为未完成项。

## 7. 实施验收分层

- **可离线/无凭据验证**：加载路径、生命周期、StrictMode/卸载竞态、无 key 不外呼、错误脱敏、状态投影、marker 增量/选择/聚焦、质量档与合成 5,000/15,000 岗压力。
- **需浏览器验证但不需 Google 数据**：真实 SDK/WebGL 能初始化、resize/全屏/销毁、默认无 ion/默认影像请求；生产子路径静态资源 MIME/Workers/WASM。
- **必须明确授权与有效数据源才能验证**：真实 Google root 与瓦片、上海覆盖/坐标对齐、冷/热场景耗时、Google 网络与 GPU/FPS、额度消耗与生产凭据限制。

本清单只验证文档和官方源码主张，不声称上述应用验收已经执行。本轮新增的只有此研究文件；没有改动业务数据或全局/项目记忆文件。
