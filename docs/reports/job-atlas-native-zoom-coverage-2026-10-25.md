# 地图底图原生缩放覆盖提示

日期：2026-10-25

## 改动

地图读取经过固定 OpenFreeMap host/path 检查的矢量 TileJSON 后，保留全局或具备 building/house-number 图层的原生 `maxzoom`。相机超过该数据级别时，MapLibre 组件显示当前视图 zoom、底图声明的最高原生级别，并说明 overzoom 不会新增道路、建筑、门牌或岗位地址精度；缩回覆盖范围内提示消失。地图标题和无障碍标签改成“放大查看已有细节”，避免把相机上限表达为数据覆盖保证。

没有 TileJSON maxzoom 时不猜测、不显示该提示；TileJSON 字段失效时不阻止可用的建筑图层。只读网络核验见当前工作区的 OpenFreeMap `/planet` TileJSON，其原生 maxzoom 为 14；代码只依赖该实时元数据，不把此值硬编码为所有地图提供方的属性。

## 验证

- `atlas-basemap-capabilities.test.ts` 与 `atlas-map-renderer.test.tsx`：18/18 通过。覆盖有限 metadata 解析、无效 maxzoom、zoom 16.5 提示与缩回 zoom 14 后消失；岗位层、坐标和精度环保持工作。
- Web typecheck、目标 ESLint、目标 `git diff --check` 通过。
- 现有 `localhost:5173` 进程 PID 117364 未重启；Vite 模块端点 HTTP 200，返回修改后的 renderer、capability 与 Atlas workspace 源码。
- 未改岗位索引或 SQLite，没有为办公室生成新坐标。真实 MapLibre/WebGL GPU 的视觉验收仍需在当前工作台与目标设备实测；这项提示也不补足真实办公地址覆盖。

## 限制

提供方的 `maxzoom` 是瓦片数据元信息，不保证所有国家或城区的建筑／门牌实际完整；zoom 是地图相机层级，不是米级坐标精度证明。无原生元信息、离线轮廓和其他非矢量底图维持已有行为。
