# 岗位地图 M2：可撤销跨源归并与现有服务兼容

日期：2026-10-18。范围：共享纯规则、SQLite schema v2、repository 事务，以及现有采集 / 查询 / 详情 / 导出的兼容接线。人工归并写入目前为可信 repository API，没有新增 HTTP 写入路由或 UI；本报告不代表正式地图、私人联动或完整 M2/M3 已验收。

## 结果与行为

同公司名、同标题、平台记录号相同不会自动合并。共同具体申请链接或带各自来源观察证据的官网职位号构成强信号，但仍只输出候选；不同公司 ID 且无共同已核实法人时还要求人工确认企业身份。决策记录确认时的候选、冲突、身份、原因、时间及 revision，拒绝和撤销也以事件追加，不能修改原事件。

SQLite schema v2 在原 schema v1 上事务升级，保留原岗位 ID、listing、观察和不可变 JD。`base_jobs` 保存各来源原始投影，当前规范岗位由有效的人工合并边计算；被吸收的旧 ID 通过当前别名和追加式历史继续解析。嵌套合并可以逐边撤销，拆回的岗位保留各来源最新值。标量摘要采用最近有效合并所选目标来源，其他来源刷新不会静默替换人工选择；地点、薪资、listing 和远程资格保留为集合，冲突独立可查。

决策、当前岗位及索引、别名历史、来源任务失效和耐久回执在同一事务提交。陈旧版本与迟到来源结果拒绝写入，同身份 / 同工具 / 同键 / 同输入在重开后可重放；撤销只允许原决策身份，旧观察与 JD 不可原地修改。

## 现有应用与 HTTP 接线

`apps/job-service/src/application.ts` 的来源同步现在从 `readProjectionSnapshot()` 调用 `projectSourcePage()`，使来源刷新更新自己的原始岗位、listing 归属、最新 JD、地点与薪资；手动归并结果随后由 repository 统一投影。

搜索和公共导出继续使用 `readSnapshot()`，因此确认同岗只计一个规范岗位。详情先捕获同一公共快照，再用其 revision 调用 `resolveJobId()`，返回该快照中旧 ID 对应的规范岗位及全部来源。合并或撤销恰好发生在两次异步读取之间时，详情仍与已捕获快照一致。现有 HTTP 路由复用相同工具，无须修改认证、路由或错误协议。

人工归并方法包括 `mergeJobs`、`rejectMerge`、`revokeMerge`，写入参数包含 `expectedRevision`、`actorScope`、`idempotencyKey`；读取方法包括 `listMergeCandidates`、`listMergeDecisions`、`resolveJobId` 与 `readReconciliationConflicts`。接口细节见 [服务 README](../../apps/job-service/README.md) 和 [领域 README](../../packages/opportunities/README.md)。没有引入 LangChain / LangGraph SDK、新的公网权限、定时采集或私人数据主库。

## 备份与兼容

schema v2 完整仓库备份包含各来源原始岗位、不可变决策、别名历史及岗位版本高水位，还保留公共实体、任务、回执和线索。恢复前校验内容哈希、领域引用、决策端点 / 先后顺序 / 原身份、当前别名与规范投影一致性以及版本计数；无效备份不替换现有库。仍接受 v1 仓库备份并恢复为未归并岗位，持久 v1 SQLite 文件也可原位升级为 v2。

公共 `dataset/export` 是交换格式，只含当前规范岗位及公共来源证据，不包含可拆分原始投影或决策历史，不能替代完整备份。已合并的公共投影不能覆盖原始岗位以伪造来源所有权。私人收藏、投递、沟通和材料快照未被读取或改写；未来联动应继续保存原 `jobId` 和采用的 `snapshotId`。

## 验证证据

本轮在 Windows、Node 24.15.0 下使用临时 SQLite 文件与内存库，未读取真实用户索引、简历、Key 或浏览器 profile，也未操作原运行服务。

| 验证 | 结果与范围 |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test apps/job-service/tests/*.test.ts` | **74/74**，fail / cancelled / skipped / todo 均为 0。包含既有应用、HTTP、CLI、生命周期、投影、repository 及新增归并回归。 |
| `node node_modules/typescript/bin/tsc -p apps/job-service/tsconfig.json --noEmit` | 通过。 |
| `node node_modules/typescript/bin/tsc -p packages/opportunities/tsconfig.json --noEmit` | 归并 domain 完成时通过。 |
| ESLint | repository、repository-schema、reconciliation、application 和新 application-reconciliation 测试通过。 |
| 修改文件 `git diff --check` | 通过；仅既有 Windows LF/CRLF 提示。 |

`tests/reconciliation.test.ts` 的 8 个回归覆盖候选信号与坏证据、人工身份确认、规范单岗计数、全部来源与冲突、持久幂等重开、来源投影后拆回最新值、嵌套合并逐边撤销、拒绝及撤销、真实 SQL trigger 注入故障的整笔回滚、陈旧身份 / 迟到结果拒绝、v2 完整备份 / 错误决策与别名拒绝、v1 备份与实际持久 v1 SQLite 升级。

`tests/application-reconciliation.test.ts` 的 3 个回归进一步覆盖：

1. schema v2 库重开后，通过临时真实 loopback HTTP 用旧 ID 读取合并详情；刷新被吸收来源，仍只计一个岗位、保留全部观察 / JD；撤销后旧 ID 恢复该来源最新标题、正文、深圳地点与税前年薪 450000。所有名称、地址与工资均为合成 fixture。
2. 实际持久 schema v1 库升级后，原快照逐字段不变，既有应用详情 / 刷新可用，人工合并后旧 ID 与规范查询一致。
3. 在详情捕获快照与解析别名之间实际提交合并或撤销，返回该次捕获快照对应岗位，避免跨 revision 的 ID / 行混用。

候选发现与规范投影仍处理完整快照，FTS/RTree 查询下推、大规模性能、企业控股证据采集、真实来源长期运行、私人联动和地图视觉各自需要后续验收。该批不声称自动同岗判断、全平台市场覆盖或实际个人数据迁移完成。
