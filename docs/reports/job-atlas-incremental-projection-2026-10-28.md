# 岗位地图：入库与后台补全增量投影验收

日期：2026-10-28。环境：macOS arm64、Node v26.7.0。全部规模测试使用合成岗位、独占临时 SQLite 和实际服务 / 计算 Worker；不采集真实招聘平台，不把测试数据导入用户库。

## 结论与交付边界

来源页准备、实际入库以及后台地区 / 企业补全的热路径，已从每批读取 / 校验 / 重放整库，改为只读取并处理本批影响到的依赖片段。共享公司、共享地点、跨源归并组和关联人工决策会进入同一个完整片段，未受影响岗位不会被重新投影或比较。

5000 / 15000 岗的相同实际服务 + Worker 场景，连续三批各 16 岗、等待自动补全并更新查询 / 列表 / 地图的总耗时，单轮前后对比为 **18.747 → 9.086 秒**、**41.113 → 20.838 秒**，约缩短 51.5% / 49.3%。最终完整数据与参考查询一致；首次基线后没有再次整库下载。

独立仓储规模测试中，两个库规模的每批入库均物化 2 行已有上下文，后台处理 16 项均物化 355 行，读取结果数量不随无关库规模增长。真实浏览器的两种规模也完成了自动入库 / 补全、切词、岗位点选和地图缩放，本轮采样没有超过 50ms 的主线程长任务。

这些是单轮合成样本，不是稳定吞吐 / 跨设备百分位保证。仍保留首次完整基线、旧查询算法、完整导出和人工操作的完整参考路径；未与首次基线分页、搜索查询索引或 UI / 动画合并实施。

## 实现拆分

| 独立职责 | 文件 | 行为 |
| --- | --- | --- |
| 纯公共表词汇与数量上限 | `apps/job-service/src/dataset-tables.ts` | 仅定义八类实体表和现有全局数组上限；投影不依赖同步协议、HTTP 或 UI。原同步契约继续导出相同名称。 |
| 来源反向依赖维护 | `apps/job-service/src/projection-dependencies.ts` | 与 `base_jobs` 原子维护公司、地点、薪资、listing 的来源岗位归属。由事实派生，不另建事实源。 |
| 事务内依赖片段 | `apps/job-service/src/projection-slice.ts` | 从本批实体 / 任务出发，按 ID 加载来源 / 公共行、归并组、证据、快照、地区 / 办公地址决策，返回闭合且经过严格校验的 current / base 片段。没有跨事务整库缓存。 |
| 来源页选取 | `apps/job-service/src/projection.ts` | `sourceProjectionSelection()` 使用与原投影相同的稳定 ID，选择来源、公司、listing、地点、薪资；既有历史快照按本页 listing 集合一次读取，继续复用相同内容版本。 |
| 写入与补全接线 | `repository.ts`、`reviewed-cards.ts`、`application.ts` | 复用原领域投影函数，只改变输入数据范围和写入范围，不复制合并 / 地区 / 办公规则。来源读取的 CAS 重试同样使用片段。 |

### 一致性与真实受影响范围

- 入库合并、哈希验证、有效决策重放、版本提升、公共行写入、派生依赖、别名、补全排队、revision 变更标记和幂等回执继续置于原事实事务。只删除明确受影响集合中投影消失的 canonical job，不扫描后删除无关岗位。
- 后台补全仍先耐久 claim 租约，再在工作事务读取一致片段；保留源指纹失效、取消、重试及失败回执。不改变后台任务调度，也不把补全等待重新塞回用户搜索请求。
- 企业补全使用同一**来源公司**的所有相关原始岗位，而非只查询归并后的可见 `jobs.company_id`。新增回归首先复现了同一公司的两个来源岗位被归入不同公司摘要后，冲突披露被错误当成单一候选的情况；内部依赖修复后仍保留未知结果。
- 共享地点 / 薪资 / listing 及归并组会扩展片段；其所有受影响岗位、地图版本和别名仍正确更新。办公地址失效事件在片段内只重放涉及的确认目标，原持久历史事件不被裁剪或重写。
- 不可变观察 / JD、人工覆盖、地图坐标真实性、全库实体数量上限均保持。即使仅验证片段，事务提交前仍检查全库数量上限，超限原子拒绝。
- 来源页历史地址 A → B → A、历史薪资复用、远程转稀疏刷新，与完整 `readProjectionSnapshot()` + `projectSourcePage()` 的结果逐项相等。

### SQLite V7

新增 `base_job_dependencies(job_id, kind, entity_id)` 及面向依赖目标的索引。它只服务写入投影的反向查找，不改变搜索 FTS / RTree、查询候选选择或排序。

V6 → V7 在同一事务从来源岗位重建这些边，不重写岗位事实，不改变公共 revision 或同步 epoch。迁移失败回滚表和 `user_version`；失败之后旧事实仍可重新打开。备份格式接受 V1–V7，派生边不作为事实备份，完整恢复时按来源岗位重建。原子写失败不会留下新来源岗位、公共行、同步游标或成功回执。

## 规模验证

### 1. 实际 SQLite 仓储的读取量

测试：`apps/job-service/tests/incremental-projection.test.ts`。先种入 5000 / 15000 岗，再各执行三批 × 16 新岗位入库，并单独处理该批的 16 项真实补全任务。

| 每批指标 | 5000 岗库（三批） | 15000 岗库（三批） |
| --- | ---: | ---: |
| 入库物化的已有 SQL 行 | 2 / 2 / 2 | 2 / 2 / 2 |
| 后台补全物化 SQL 行 | 355 / 355 / 355 | 355 / 355 / 355 |
| 入库耗时 | 30 / 31 / 29ms | 68 / 74 / 83ms |
| 16 项补全耗时 | 43 / 41 / 41ms | 103 / 89 / 91ms |
| 最终岗位数 | 5048 | 15048 |

计数通过真实 `DatabaseSync` 仓储边界观测：包括 `.all()` 返回的 ID / 决策 / 文档行，以及 `.get()` 的文档行；排除单个 revision / COUNT 等标量元数据。它衡量实际物化到 JS 的读取量，不是 SQLite 内部访问页数、扫描行数或返回 HTTP 的行数。不能据此宣称全部 SQL 都是 O(delta)。

最初 200 岗复现中，旧路径仅统计 `.all()` 就分别读到入库 2002 / 补全 2013 行；这些旧值未包含 `.get()` 文档，不与新计数直接计算减少百分比。最终更严格计数下，一岗入库为 2 行、一岗补全为 25 行。

单独启用压测后，该文件 10 项全部通过、0 失败 / 跳过，约 43.4 秒。日志：`output/atlas-streaming-preview/incremental-projection-materialization-scale.log`。

### 2. 实际服务 + HTTP + 浏览器计算 Worker 的前后对比

测试：`apps/web/tests/atlas-snapshot-sync-scale.test.ts`。改动前先运行一次，改动后用同一合成场景独立再跑一次。每个规模建立实际临时本机服务，建立完整同步基线后，三批各提交 16 岗并等待自动补全；写入期间并发切词查询、列表 / 地图 / 元数据计算，最后用完整导出和参考计算验明结果。

| 指标 | 5000 岗：改动前 → 后 | 15000 岗：改动前 → 后 |
| --- | ---: | ---: |
| 三批完整流程 | 18747 → 9086ms | 41113 → 20838ms |
| 首次基线字节 | 13096796 → 13096796 | 39468996 → 39468996 |
| 初次同步 | 2335 → 2478ms | 7476 → 7160ms |
| 后续同步字节合计 | 183009 → 129828 | 183009 → 147555 |
| 基线后同步次数 | 7 → 4 | 7 → 5 |
| 基线后整库回传 | 0 → 0 | 0 → 0 |
| 无变化响应 | 195 → 195 字节 | 195 → 195 字节 |
| 回传岗位行版本 | 96 → 48 | 96 → 64 |
| 调用方 10ms 定时器最大间隔 | 25 → 32ms | 43 → 59ms |
| 最终岗位 / C# 匹配 / 地图地点 | 5048 / 2524 / 1262，前后一致 | 15048 / 7524 / 3762，前后一致 |

改动后三次实际 HTTP 入库响应为 65 / 44 / 40ms 和 186 / 164 / 236ms；这些请求的输入都是 16 岗，不是完整首次种库。三次入库后同步耗时为 62 / 669 / 912ms 和 518 / 199 / 119ms，包含 Worker 队列等待、网络、校验及安装，不是纯 HTTP RTT。

补全更快后，部分入库与补全 revision 在下一次同步前已经共同提交，所以一次净增量可覆盖多个版本，回传版本数量下降。两种规模实际新增始终都是 48 个唯一岗位，完整导出逐项相等，并未丢失补全；协议与轮询策略没有为此改造。上述同步流量不含上传、补全状态响应和最终正确性导出。

每次独立开启压测均 1 项通过、0 失败 / 跳过。前 / 后测试文件总时长约 115.6 / 88.7 秒，包含首次种库、启动、初始化、正确性比较和清理，不等于表中三批计时。原始日志：`incremental-projection-before-scale.log`、`incremental-projection-after-scale.log`，均位于 `output/atlas-streaming-preview/`。

### 3. 真实浏览器与 MapLibre

独立预览直接使用当前源代码、实际 MapLibre WebGL 地图、真实 HTTP / SQLite 服务及页面 Worker。初次基线后采样，实际操作 TypeScript / C# 输入、岗位点选和地图放大 / 缩小。合成坐标与无网络瓦片的本地底图，不代表真实分散办公点、真实瓦片和所有设备的负载。页面只是验收夹具，不是产品 UI 改版。

| 浏览器指标 | 5000 岗 | 15000 岗 |
| --- | ---: | ---: |
| 三批完整流程 | 6899ms | 20298ms |
| 三次入库后同步 | 80 / 42 / 42ms | 119 / 116 / 114ms |
| 基线后同步字节 | 189537 | 171234 |
| 基线后整库下载 | 0 | 0 |
| 最终库内 / C# 匹配 / 当前页 | 5048 / 2524 / 30 | 15048 / 7524 / 30 |
| 最终可点办公地点 | 1262 | 3762 |
| 10ms 定时器最大间隔 / p95 | 24 / 11ms | 40 / 11ms |
| rAF 间隔 p95 / 最大值 | 9 / 10ms | 10 / 23ms |
| 超过 50ms 的长任务数 / 最长 | 0 / 0ms | 0 / 0ms |

两种规模分别记录 6 / 5 次 `delta` 加一次 `unchanged`，全部 HTTP 200。本轮 0 长任务仅指该采集窗口，不包括首次基线或正确性参考导出，不代表所有页面都零卡顿。Node 与浏览器回放是不同负载及调度，不能混合计算提升百分比；百分位是一次窗口内部采样，不是多轮性能分布。

产物位于 `output/atlas-streaming-preview/`：

- `incremental-projection-browser-5000.json`、`incremental-projection-browser-15000.json`：从实际页面显示的采样结果记录。
- `incremental-projection-browser-5000.png`、`incremental-projection-browser-15000.png`：C# 查询、最终列表及地图计数同屏。
- `incremental-projection-browser-15000-typescript.png`：另一关键词的最终结果，无来源坐标的样本不绘制办公点。
- `compute-server.ts`、`compute-smoke.tsx`、`compute.html`：独立临时库预览夹具。

验收后已关闭自建标签、停止自己启动的 5296 预览进程。进程退出后残留的两份测试目录，已核实 owner PID 为本轮自建且已退出、SQLite 无打开句柄后清理；只删除了可由夹具重建的合成库。截图、日志和 JSON 保留，用户岗位库与原浏览器页面没有作为清理目标。

## 正确性与最终回归

新增独立回归覆盖：一岗 / 大库有界读取、隐藏来源公司冲突、共享地点扇出更新及无关岗位不变、来源页历史等价、V6 迁移与 V7 恢复、迁移失败回滚、依赖写失败原子回滚 / 原键重试、全库数量上限。

| 批次 | 结果 | 日志（`output/atlas-streaming-preview/`） |
| --- | --- | --- |
| 最终 Job Service 全部测试 | 342 项，339 通过，0 失败，3 个显式规模压测跳过 | `incremental-projection-server-final.log` |
| Web 工作区 / 采集流水线 / 后台补全 / 同步相关回归 | 151 项，150 通过，0 失败，1 个显式压测跳过 | `incremental-projection-web-tests.log` |
| 最终 Web 客户端 / Worker / 同步聚焦回归 | 32 项，31 通过，0 失败，1 个显式压测跳过 | `incremental-projection-web-final.log` |
| 独立开启仓储 5000 / 15000 岗读取量压测 | 10 项，10 通过，0 失败 / 跳过 | `incremental-projection-materialization-scale.log` |
| 独立开启实际服务 + Worker 规模场景 | 前后各 1 项通过，0 失败 / 跳过 | `incremental-projection-before-scale.log`、`incremental-projection-after-scale.log` |

各批次存在重叠，不累加成独立测试总数。较广 Web 回归之后的纯表词汇拆分和历史片段批量读取已由最终全服务、最终 Web 聚焦回归、独立规模与浏览器回放覆盖。

最终 Job Service、Web、Web Node 三份 TypeScript `--noEmit --incremental false` 均通过；`git diff --check` 通过。没有运行全仓库测试、全仓 lint、生产构建、发布、提交或推送；没有重建正在监听的 workspace `dist`。

## 本机运行状态与保留限制

- 本轮没有重启原 5173 / 5178 / 5179 服务，没有刷新或操作原用户业务标签，避免打断采集或未保存简历。所有新逻辑与 V7 迁移均在独立测试库验证；原已加载的 5178 进程不会因为源码文件变化就自动切换这些代码，受控重启后才会使用新实现。
- 首次基线仍是完整快照，本次 15000 岗约 39.47 MB / 7.16 秒；首次基线分页不在本次范围。
- 独立查询线程和浏览器 Worker 的原查询 / 全局元数据 / 地图算法未改。本轮 15000 岗三批完整流程仍约 20–21 秒，不能把 100ms 级入库响应等同于所有环节完成。
- 反向依赖减少物化，但全局数量 COUNT、别名反查和部分决策 / 历史 SQL 仍可能扫描 ID 或历史表；没有宣称整个事务严格 O(delta)。实际同一公司、共享地点、历史链或归并组很大时，完整依赖片段也会相应变大。
- 人工归并 / 核对、全量备份 / 恢复 / 导出继续走完整参考路径。查询索引、首次初始化、地图提交 / GC profile、视觉与动画各是独立后续阶段。
- 未做真实平台采集、全站覆盖、弱设备或多轮稳定百分位验收；来源限制、原文与地图精度规则没有放宽。

## 复现

仓库根目录执行，性能场景应独立运行，不与类型检查 / 其他大测试并行争用 CPU：

```sh
pnpm exec tsx --test apps/job-service/tests/*.test.ts
pnpm exec tsx --test apps/web/tests/atlas-snapshot-sync.test.ts apps/web/tests/atlas-compute.test.ts apps/web/tests/atlas-client.test.tsx
BETTER_ME_PROJECTION_BENCH=1 pnpm exec tsx --test apps/job-service/tests/incremental-projection.test.ts
BETTER_ME_SCALE_BENCH=1 pnpm exec tsx --test apps/web/tests/atlas-snapshot-sync-scale.test.ts
pnpm exec tsc --noEmit --incremental false -p apps/job-service/tsconfig.json
pnpm exec tsc --noEmit --incremental false -p apps/web/tsconfig.json
pnpm exec tsc --noEmit --incremental false -p apps/web/tsconfig.node.json
```

浏览器临时预览：`node --import ./node_modules/tsx/dist/loader.mjs output/atlas-streaming-preview/compute-server.ts`，打开 `http://127.0.0.1:5296/output/atlas-streaming-preview/compute.html`。只使用其自动创建的临时库；结束后核实停止与清理，不改为真实库来跑合成入库。
