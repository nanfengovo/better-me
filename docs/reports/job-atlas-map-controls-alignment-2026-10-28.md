# 岗位地图：控件遮挡与行政边界坐标修复

日期：2026-10-28。范围仅包含地图控件布局和行政边界显示坐标；不修改查询索引、采集任务、岗位/企业数据、简历、动画或服务生命周期。

## 结果与设计取舍

| Before | After | Why |
| --- | --- | --- |
| 全球/国内切换与行政区徽标分别绝对定位到地图左上角，真实浏览器重叠面积 3630 CSS px² | 独立正常文档流工具栏；地图画布在其下方开始，重叠面积 0 | 消除两个组件争用同一空间的结构问题 |
| 2D/3D、重置、旋转分散在浮层中，窄屏部分控件隐藏 | 三组控件统一到可换行工具栏，6 个按钮均至少 44px 高 | 保留全部操作、键盘切换和原来的回调行为 |
| 地址面板覆盖原生缩放/罗盘 | 地址入口在右上，原生导航在其下；面板右侧留出导航通道 | 打开面板时仍能操作地图 |
| 行政区徽标 11px，长名称与控件争用宽度 | 13px，限定宽度并允许换行；没有办公地址时释放更多宽度 | 保留地区名称及可读性，不靠截掉文字掩盖问题 |
| DataV 的 GCJ-02 边界直接交给 WGS84 地图 | 明确来源 CRS，在加载入口转换一次，缓存转换后的 WGS84 几何 | 修正坐标系错配，不使用 CSS 平移或手工贴岸 |

界面设计技能用于确定信息分区、44px 触达尺寸、窄屏换行和键盘行为；诊断流程先建立失败用例，再验证原因与修复。没有新增动画、定时器或依赖。

## 边界证据与限度

[DataV 官方地图数据说明](https://help.aliyun.com/en/datav/datav-7-0/user-guide/map-data-format-1)说明其地图数据使用 GCJ-02；[MapLibre LngLat 文档](https://maplibre.org/maplibre-gl-js/docs/API/classes/LngLat/)说明其经纬度使用 WGS84。

真实生产读取路径中的上海首个顶点：

- 原始 DataV：`[121.153743, 31.276646]`。
- 修正后：`[121.14917894727922, 31.278521729243856]`。
- 该样本点的坐标改变量约 482 米；这是公开模型的转换结果，不是实测精度认证。

九组已知 DataV 本地资产与在线 DataV 响应只在加载到显示缓存前转换。Natural Earth 的 WGS84 数据不转换，原始 12 个 GeoJSON 文件没有改变。转换保留多岛、孔洞、闭环、额外坐标维度、标识与非坐标元数据，并更新 `center`、`centroid` 和已有 bbox。复用缓存、切换主题不会产生二次偏移。

算法采用 DataV 文档所链接的 coordtransform 公开近似公式，固定版本与完整 MIT 许可已保留在 `geo/NOTICE.md`、`geo/COORDTRANSFORM-LICENSE.md` 及实现文件头部。

行政范围可能包含水域，不是海岸线数据。上海本地几何有 807 顶点，本次核对的 DataV 在线版本有 915 顶点；未替换版本、吸附海岸或承诺测绘精度。历史 DataV 下载版本和再分发许可记录仍缺失，已在数据 NOTICE 中单独说明。

## 浏览器验收

全部使用本轮独立 Chrome context、隔离合成 API、独立 Vite 5186；未连接用户浏览器上下文，未读取简历、真实岗位数据或调用采集/AI。

- 5000 岗合成数据：1451×1000、1451×1273、1024×1000、390×1000，浅色/深色均检查。页面无水平溢出；画布有效高度分别约 302、575、254、340px。
- 范围控件/行政徽标、行政徽标/地址入口、地址入口/原生导航、展开地址面板/原生导航：存在的各组交叠均为 0。
- 实际点击/键盘检查：全球/国内、2D/3D、复位、全球 3D 自动旋转与暂停、地址搜索、Escape 关闭；新疆长地区名与无办公地址状态可显示，不遮挡工具栏。
- 15000 岗合成数据最终显示上海匹配 7500 岗、3750 个来源地址，地址面板与导航无交叠，画布约 575px 高；没有 browser pageerror。
- **性能限制：**15000 样本首次等待地址入口的 20 秒断言超时，随后观察到完整渲染并完成上述操作；部分 5000 样本初次等待也超过原 6 秒阈值。本轮只确认布局与交互，不把这些结果称为首屏时延、FPS 或 INP 验收通过。首次就绪等待需独立排查，不与本次 CSS/坐标修复耦合。
- 独立 `tests/ui-lab/map-alignment.html` 使用真实 MapLibre 与生产边界服务，分别检查原始/转换后边界、上海西侧近景/全市范围、2D/3D；原始坐标按钮只存在于诊断页。

本轮证据目录：`/Users/feng/Documents/Private/简历/atlas-map-controls-s09Xrx/verification/`。

- `before-map.png`、`before-layout.json`：遮挡红证据。
- `after-map-controls.png`、`after-desktop-drawer.png`、`after-map-1024.png`、`after-map-390.png`、`after-narrow-dark.png`、`after-long-label-empty.png`：布局与状态。
- `boundary-raw-2d.png`、`boundary-wgs84-2d.png`、`boundary-wgs84-3d.png`：原始与转换后真实地图画面。
- `layout-qa.json`、`layout-15000.json`、`after-15000-map.png`：尺寸与大样本布局记录。

## 自动验证

先有红证据：三档完整 CSS cascade 的工具栏定位测试失败；上海真实 resolve 路径的转换参考测试失败。修复后转绿。

隔离 STAGE 的工作台/地图/边界定向回归 **121/121 通过**，无跳过，约 135.5 秒，包含：

```sh
node node_modules/tsx/dist/cli.mjs --test \
  apps/web/tests/atlas-workspace.test.tsx \
  apps/web/tests/atlas-map-renderer.test.tsx \
  apps/web/tests/atlas-map-frame.test.tsx \
  apps/web/tests/atlas-map-performance.test.tsx \
  apps/web/tests/admin-boundary-service.test.ts \
  apps/web/tests/admin-boundary-alignment.test.ts \
  apps/web/tests/boundary-geometry-normalization.test.ts \
  apps/web/tests/atlas-map-controls-layout.test.ts \
  apps/web/tests/atlas-map-toolbar.test.tsx
```

接入 MAIN 后，边界/布局/toolbar/view-controls/renderer/readability 的 **37/37 回归再次通过**；web `tsc --noEmit --incremental false` exit 0。隔离描边 fixture 还以显式加入测试文件的 TypeScript Program 和 ESLint 验证通过，避免只检查 `src` 的漏验。未宣称全仓测试或生产构建已通过。

## 主项目接入与数据安全

- 接入前 772 个已有源码文件哈希与本轮基线一致，没有覆盖并发用户修改。只应用明确列出的 15 个布局/边界/测试/出处文件，再新增本报告。
- 已有 Vite PID 83753（IPv4）和 29285（IPv6）继续运行；岗位服务 10262、Agent Host 34879 未重启。
- 复用已有 HMR 会话保护：当前 3 个浏览器 HMR 连接继续保留旧页面状态。接入触发的更新/全页刷新通知被阻止，没有操作用户页面或简历内容；新打开的页面读取新实现。
- 岗位服务仍健康：**5608 岗，revision 4135**。接入前后完整导出 SHA-256 相同：`5615ed3714b5d01473ed794a611ce7b70d5025709dd4ba52cb2f61ede5f5a092`，服务令牌哈希不变。
- 后台补全状态不变：completed 1633，pending/running/failed 均 0。
- 修改前已保存只读在线 SQLite 备份，`quick_check` 为 `ok`。没有恢复、清空或改写数据库。
- 主服务首页及新增 toolbar/CSS/坐标模块均返回 HTTP 200；没有为检查而刷新用户标签页。

体验入口仍为 `http://127.0.0.1:5173/?workspace=atlas`。应另开标签页体验新版，继续保留可能有未保存简历的旧标签页。
