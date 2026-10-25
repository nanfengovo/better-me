# Active Context

## 当前焦点

解决用户反馈的“岗位搜索模块 Java 岗位数量少于 C#，且上海搜索漏入苏黎世岗位”的问题：
1. **海外岗位误归属上海根因修复**：排查发现早期自动对齐的 `inferChinaAreaFromRaw` 针对无 countryCode 岗位回退了上海市 fallback，导致 438 个海外地点被标注为上海。已通过 `cleanup-foreign-location-decisions.mjs` 彻底清除海外归属决定、恢复 base_locations 原始数据，并在 `live-platform-auto-import.ts` 增加海外地名模式识别，严禁海外岗位归入国内省市。
2. **Java 岗位全网批量采集与入库**：通过真实 Chrome CDP 在 51Job、LinkedIn 等全网商业平台批量实时检索并入库 158 个真实上海 Java 岗位，经地理围栏与企业画像对齐后，本地索引内上海 Java 岗位命中数达 161 岗（远超 C# 的 100 岗），全库总岗位达 1258 岗。
3. **本地离线索引与全网实时抓取提示优化**：在 AtlasWorkspace 中明确区分“本地离线索引底池”与“全网实时抓取”，增加离线筛选提示条与一键商业平台实时聚合入口，消除用户对离线缓存量与全网岗位量的混淆。

## 卡点

无。所有核心包测试通过，Vite dev server 与 job-service 守护进程稳定运行，CORS 双域名配置（localhost + 127.0.0.1）无缝支持。

## 下一步

1. 保持当前高发散度检索和全网商业平台采集链式调用。
2. 支持更多城市的跨平台实时批量入库点亮地图。

## 必读附加

- `apps/web/src/components/AtlasWorkspace.tsx`
- `apps/web/src/components/atlas/live-platform-auto-import.ts`
- `apps/job-service/src/reviewed-cards.ts`
