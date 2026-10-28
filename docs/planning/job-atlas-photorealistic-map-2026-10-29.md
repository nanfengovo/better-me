# 岗位地图实景 3D：引擎与数据分离的接入建议

日期：2026-10-29。状态：**技术研究与待确认方案，未接入、未替换当前地图、未启用计费。**

目标不是增加装饰性立体效果，而是让用户理解真实办公地点、周边环境和城市空间。当前项目仍按已经确认的本机自用、国内为主并探索海外的定位评估；不重新假设它是公开招聘网站。

## 1. 当前实现究竟是什么

本轮源码核对：

- `apps/web/src/components/AtlasWorkspace.tsx:67` 懒加载主地图 `MapLibrePrototype`，不是 `ThreePrototype`。
- `apps/web/src/components/atlas/prototypes/MapLibrePrototype.tsx:144-179` 对矢量底图中带 `height/render_height` 的建筑轮廓执行 fill-extrusion；它不是带航拍纹理的城市摄影测量网格。
- 国内概览仍有 Natural Earth 省域挤出和自定义配色，视觉立体不代表实测地形。
- `ThreePrototype` 是保留的几何/材质对照原型；继续精修它不能获得真实城市街区数据。
- 当前地图、列表和统计共同消费 opportunities 查询；`MapBucket`、真实来源坐标、同址聚合、选中岗位和聚焦事件已有可复用契约。
- 主地图包为 MapLibre 6.15.0，另有 Three 0.186.1；当前 Web 依赖没有 CesiumJS。

因此用户对“实景质感不足”的判断成立，准确的改进方向是**引入合规实景数据 + 成熟地理渲染引擎**，不是继续画更多立体图形。

## 2. 选择结论与前置门槛

建议优先验证 **CesiumJS + Google Photorealistic 3D Tiles** 作为可选的实景探索模式，不立即替换所有工作地图。

CesiumJS 是 Apache-2.0 开源引擎，不是 Google 的免费数据服务；Google 提供的摄影测量网格和纹理有独立的凭据、计费与许可。官方直接支持兼容的 3D Tiles renderer，CesiumJS 是其中之一。[Cesium 源码与许可](https://github.com/CesiumGS/cesium)、[Google 接入说明](https://developers.google.com/maps/documentation/tile/3d-tiles)

必须先通过以下门槛：

1. **地区覆盖**：Google 官方覆盖表中 CN 的 Map Tiles 2D/3D 列仅显示一个可用标记，Maps JavaScript 3D 为不可用；其他支持 3D 的国家有两个标记。该表不支持承诺上海拥有实景建筑。地形/二维影像覆盖不等于建筑网格覆盖；后续需按目标城市、街区用官方覆盖工具和授权后的实际显示验证。[官方覆盖表](https://developers.google.com/maps/coverage)、[实景覆盖工具说明](https://developers.google.com/maps/documentation/javascript/3d/coverage)
2. **成本与身份**：官方价格表目前是每月 1,000 个免费计费事件，首档之后每千次 6 美元；需要启用计费并认证。依据根 tileset 请求/会话测量，而非按岗位数或鼠标移动次数理解费用。不把免费额度当离线、免账户或永久免费承诺。[价格](https://developers.google.com/maps/billing-and-pricing/pricing)、[用量与配额](https://developers.google.com/maps/documentation/tile/usage-and-billing)
3. **账户适用性**：符合 EEA 新建/变更项目条件的账户不可请求该摄影测量数据，可能返回 403，而不是只有显示条款不同；需看实际账单地址和协议。[EEA 调整](https://developers.google.com/maps/comms/eea/map-tiles)
4. **网络/GPU**：从实际使用设备验证网络、瓦片显示延迟、WebGL 与内存，不以开发机编译成功代替体验验收。
5. **许可与安全**：保留来源署名，禁用自建离线下载/持久缓存，不提取网格作为新的地址、建筑或高度数据库。应用自有业务点位不是 Google 生成的事实。[Map Tiles 政策](https://developers.google.com/maps/documentation/tile/policies)

如果国内仍为主，这些前置项比先安装 SDK 更重要。没有覆盖时要清楚显示“此地区暂无实景建筑覆盖”，提供工作地图，而非用拉高的色块冒充实景。

供应商、费用、许可和 MapTiler 替代数据的完整研究见 [提供商研究](../research/photorealistic-map-providers-2026-10-29.md)。本文件只是待实施设计，不是法律合规结论。

## 3. 产品体验：两个用途，不把实景变成阻塞

| 模式 | 主要用途 | 行为 |
| --- | --- | --- |
| 工作地图 | 搜索、筛选、岗位分布、看 JD | 保留清晰矢量图和现有岗位/列表联动；不依赖 Google Key |
| 实景探索 | 查看某个办公地址和周边城市环境 | 选用 Cesium 实景 renderer；明确数据来源、可用性与加载状态 |
| 无实景/加载失败回退 | 地区不支持、鉴权、配额、网络或 GPU 故障 | 保留岗位列表与已选岗位，说明具体原因，允许切回工作地图 |

暂不新增一个名为“卫星”的按钮但没有对应许可数据。二维卫星是独立产品能力，不能假设拥有 3D Tiles 额度就拥有全部二维影像服务。

列表、详情、采集可以先展示，实景渐进加载。用户阅读 JD 时不自动环绕旋转；仅主动“查看周边”时改变相机，尊重 reduced-motion。主要文字和交互继续由工作台 UI 承担；真实城市纹理不会自动解决小字体、信息密度或面板重叠。

## 4. Module 与 Seam：只替换渲染，不重做岗位域

```text
同一岗位库 / revision / 查询索引
                │
       同一查询结果与真实地点
          ┌─────┴─────┐
        岗位列表      地图呈现 Module
        JD / 统计     ├─ MapLibre Adapter：工作地图
                      └─ Cesium Adapter：实景探索
```

这是真实存在的两种 Adapter 差异，不提前创造通用插件平台。复用 `AtlasPrototypeProps` 中业务意义稳定的部分，将渲染 Implementation 放在同一个 Seam 后面。

需要保留的 Interface 不变量：

- 输入地点仍是带来源、精度与岗位 ID 的 WGS84 坐标；renderer 只能呈现，不能改变核实状态或写库。
- 选中地点/岗位、同址选择、聚焦、视野变化和错误事件保持业务语义一致。
- 同一个 query/revision 生成的列表和地图结果必须一致；地图就绪不是列表查询的前提。
- 后台增量更新不得重新创建 Viewer，也不得自动把阅读中的相机拉回搜索范围；复用现有 framingKey 一次构图规则。
- 现有 MapLibre `zoom` 不能未经定义就当 Cesium 相机高度。公共聚焦用坐标和范围表达，按 Adapter 做高度/朝向转换；各自的原生相机快照仅由各自恢复。
- 现有 `AtlasMapGeometry` 有 MapLibre GeoJSON 样式特征，不能原样当 Cesium primitives。共享业务点位/精度/同址分组，而不是让 Cesium 回读并解析 MapLibre 的圈层样式。

不改查询索引、后台入库、补全和 revision 同步；不把引擎迁移同 Agent 重构或 UI 动画绑在一起。

## 5. Cesium 接入要点

### 生命周期和数据

- 独立懒加载 chunk；按锁定版本配置 Workers、Assets、Widgets、WASM 的静态资源路径与生产 MIME。
- 一次进入实景创建一个 Viewer；增量更新地点图层，选中高亮仅改必要属性。退出/隐藏释放或暂停资源，避免两个重型场景长期同时运行。
- React StrictMode、面板拖拽/resize、主题变化、采集事件不能导致重复初始化与重复 root 请求。首次创建、重试、切换来源、会话到期都要有可观察的请求次数。
- 使用当前异步 tileset factory，并核对本地安装类型，不直接复制 Google 文档内旧版本的构造函数示例。Google 直连与 Cesium ion 代管是两条不同认证/计费路径，先明确所选路径；原始 Cesium 引擎不要求所有用户购买 ion 服务。[官方 renderer 指南](https://developers.google.com/maps/documentation/tile/use-renderer)、[Cesium tileset 文档](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)

### 画质与性能

- 使用按需渲染，显式处理 simulation time 导致的重绘；有实际数据或相机变化时 requestRender，而非默认全天 60 FPS 循环。[Scene](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html#requestRenderMode)
- 对拖动和静止分别调节 LOD；从屏幕误差、DPR、GPU tile 内存和 overflow 预算做质量档位，不默认开启高成本阴影、环境遮蔽和后处理。[Tileset LOD 与内存](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- 大量点位优先批量 primitives/billboards、视域内显示和有限标签，不给每个岗位创建 React DOM，也不把同址多个岗位重复画成多个楼。
- 位置对齐另验：经纬度顺序、来源 CRS、行政线精度、视角遮挡与模型表面不是同一问题。现有 GCJ-02/WGS84 的显式转换链路独立保留；不能为“看起来贴住楼”改动真实岗位坐标。
- 场景贴地/抬升仅是显示策略，不从 Google 网格反推并存储办公地址、楼层、高度或建筑轮廓。

### 凭据、成本和隐私

- Key 不进 Git、不写入公开示例，不让用户把 Key 发到聊天里。浏览器可见的 Key 不是秘密；`VITE_*` 也不是凭据保管库。
- Map Tiles 官方安全建议以产品为准，不能照搬 Maps JavaScript 的网站 referrer 限制就宣称安全。需要验证直连浏览器、受控代理或 ion 的实际身份/限制；不建通用 URL 代理。[Map Tiles 设置](https://developers.google.com/maps/documentation/tile/get-api-key)、[安全指引](https://developers.google.com/maps/api-security-best-practices)
- 设置配额和预算通知，但不把通知说成绝对不会扣费。若研究 spend-cap，需核对 Map Tiles 是否在支持清单；当前不能据其他 Cloud 产品支持就推断 Maps 同样支持。[Cloud spend caps](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
- 不使用 Service Worker/IndexedDB 保存 Google 瓦片，不批量预取。正常 renderer 的在用内存和协议缓存遵循实际条款与响应头，不混淆为“允许离线缓存”。
- 场景请求会向供应商披露被浏览区域等必要信息；不额外发送岗位 JD、简历、岗位库或家庭地址用于外部地理编码。若引入地址搜索，要另审 geocoder 许可、数据披露与费用。

## 6. 分阶段实现与验收

| 独立切片 | 交付 | 门槛 |
| --- | --- | --- |
| A. 供应商验证 | 目标城市/街区、账户可用性、凭据路径、样本画面与请求计数 | 无授权不请求付费内容；上海不足则不以海外样图冒充通过 |
| B. 渲染 Seam | 现有地图保持可用，新增独立 Cesium Adapter 与就绪/故障回退 | 不改岗位域、索引、同步与现有用户数据；无 Key 时当前体验不退化 |
| C. 业务联动 | 同一地点选择、真实地址标记、同址岗位选择、详情聚焦 | 图/列表/统计同一查询；切图不丢岗位、不修改坐标、后台更新不抢相机 |
| D. 画质和性能验收 | 不同设备质量档、加载体验、错误分类、成本观测 | 用 5,000 / 15,000 岗样本测试，同时分别记录实际点位数，不能把岗位数当网格负载或计费事件 |

性能验收应固定相同设备、网络、城市、视口与操作脚本，对比冷/热加载、首次可用场景时间、INP/输入与筛选延迟、帧时间 p95、长任务、CPU/GPU 内存、下载量、root 请求数。包含采集增量期间搜索、看 JD、拖动分栏、地图移动和切换引擎。

另外独立模拟：无 Key、Key 被拒、EEA/地区限制、配额耗尽、断网、WebGL context lost、快速切换/卸载、重复初始化。技术失败与无实景覆盖不能都显示成笼统“地图失败”。

上述是未来验收计划：本轮没有运行 Cesium、发起 tileset 请求、测量 FPS/INP 或验证真实城市场景。

## 7. 本轮操作边界

仅阅读项目、研究官方文档并新增方案记录；没有安装 SDK、写入 Key、创建云项目、启用计费、更换主地图、刷新原页、重启本地服务或操作岗位/简历数据。方案不写入已拍板决策或记忆文件，等待按覆盖与成本作选择。
