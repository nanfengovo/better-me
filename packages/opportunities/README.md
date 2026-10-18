# `@better-me/opportunities`

BetterMe 的共享 TypeScript 岗位领域与 M0 参考实现。UI、HTTP、后台任务和未来 Agent 使用相同的数据与业务契约；本包不依赖 React、地图 SDK、SQLite、LangChain 或 LangGraph。

**当前实现包含领域校验、纯值规则、内存查询、工具执行器和旧机会库迁移预览。** 本包尚不提供常驻后端、数据库、来源采集、平台搜索、三维地图或自动投递，也没有自动读取或迁移用户浏览器存储。内存查询的合成测试不代表任何招聘平台的实时覆盖或在招核验。

整体需求与 M0–M5 验收见[岗位地图架构](../../docs/planning/job-atlas-architecture-2026-10-18.md)，来源范围见[来源研究](../../docs/planning/job-atlas-sources-research-2026-10-18.md)，地图候选见[三维研究](../../docs/research/job-atlas-map-references-2026-10-18.md)。

## 领域契约

`src/schema.ts` 导出 Zod Schema 与同名 TypeScript 类型。所有领域对象采用显式字段，公共岗位域不包含个人 Fact、API Key、投递联系人、沟通、备注或简历材料。

| 对象 / Schema | 当前职责 |
| --- | --- |
| `AtlasDatasetSchema` / `AtlasDataset` | 一个版本化公共快照：sources、companies、jobs、locations、compensations、listings、observations、snapshots；检查重复 ID、悬空引用及所属关系 |
| `CompanySchema` | 企业名称、主体关系、带证据的最终控股方和可追溯人工修订；办公国家与控股来源分开 |
| `CanonicalJobSchema` | 规范岗位、岗位列表/地点/薪资引用及选定 JD 快照；工作方式、招聘类型和当前状态 |
| `SourceDefinitionSchema` / `SourceConfigSchema` | 来源能力、执行位置、配置、端点范围、署名/使用范围和刷新策略；只允许凭据引用，不保存实际密钥 |
| `SourceListingSchema` | 某一来源中的岗位记录、详情/申请/发现链接、首次发现和观察引用；无 URL 的手工记录可用稳定来源记录号 |
| `SourceObservationSchema` / `ObservationSchema` | 不可变的历史读取结果、原始时间、内容哈希、完整性及在招核验依据；读取失败不等于关闭 |
| `JdSnapshotSchema` | 不可变 JD 正文及哈希、观察归属、提取方式、完整性和原链接 |
| `JobLocationSchema` | 地点原文、标准地区、WGS84 坐标、原坐标系、精度与证据；远程允许地区不冒充办公室点 |
| `CompensationSchema` | 原币、上下限、计薪周期、税制、固定/奖金/股票、明确薪数和证据；可用 `locationIds` 绑定适用地点 |
| `createEvidencedSchema()` / `Evidenced<T>` | 值、来源观察、原句/selector、方法、核验状态及修订号；模型建议不能直接标成 verified |

`AtlasDatasetSchema.parse()` 同时执行字段和跨表校验。`validateAtlasDatasetReferences()` 可独立取得引用问题。Schema 通过表示结构一致，不证明来源内容真实、企业归属已核实、地图边界获授权或网络端点安全。

## 标识、薪资、距离与配色

```ts
import {
  deriveEntityId, normalizeSourceUrl,
  normalizeCompensation, salaryMetric,
  haversineKm, distanceToLocations,
  getDefaultCompanyColorConfig, exportCompanyColorConfig,
} from "@better-me/opportunities";

const listingId = await deriveEntityId("listing", ["example-source", "public-job-42"]);
const canonicalUrl = normalizeSourceUrl("https://jobs.example.com/42?utm_source=feed");

const distanceKm = haversineKm(
  { latitude: 31.2304, longitude: 121.4737, coordinateSystem: "WGS84" },
  { latitude: 30.2741, longitude: 120.1551, coordinateSystem: "WGS84" },
);

const editableColors = getDefaultCompanyColorConfig();
const colorsJson = exportCompanyColorConfig(editableColors);
```

`deriveEntityId()` 用有版本的结构化输入与 SHA-256 生成稳定 ID，依赖 Web Crypto；重复调用不会创建随机新 ID。`normalizeSourceUrl()` 清理已知追踪参数，保留岗位身份参数、重复参数和 SPA fragment，不替调用方猜测跨来源是否同岗。

`normalizeCompensation(compensation, options)` 返回 `originalAnnual`、可比时的 `cnyAnnual`、`reason`、`estimated`、假设及汇率日期。它不改原始薪资：

- 固定税前现金、明确币种和计薪周期、与原句或结构字段绑定的证据才进入统一比较；奖金、股票、税后和未知税制不会混入固定税前年薪。
- 月薪缺薪数时，默认不猜。显式 `allowMonthlyEstimate: true` 才可乘十二，并保留 `monthly-base-times-12` 假设；不会推断十三/十四薪。
- 非人民币通过传入的 `FxSnapshot` 换算，拒绝缺失、未来或过期汇率。没有可用汇率时仍保留原币年化值。
- `salaryMetric(normalized, "min" | "mid" | "max", currency)` 返回指定币种的比较数值；缺失的一侧保持未知。

`haversineKm()` 计算近似球面直线距离。`evaluateLocationDistance()` 给出不可计算的原因；`distanceToLocations()` 选择一个岗位中最近的可用办公室，保留地点与精度。GCJ-02/BD-09 不会自动当成 WGS84；国家/省中心、未知位置和远程范围不参与办公室距离。城市中心需显式 `allowCityEstimate: true`，结果标注估算。地理编码、坐标转换、家庭地址持久化及通勤路由待后续服务提供。

`classifyCompany()` / `resolveCompanyColor()` 只使用有证据且已核实的最终控股信息，并接续有效的人工修订；不从职位所在地、公司名字或网站域名推断企业归属。`getDefaultCompanyColorConfig()` 每次返回独立副本，配套 `CompanyColorConfigSchema`、`importCompanyColorConfig()` 和 `exportCompanyColorConfig()` 可校验/编辑/保存规则。预设包括北欧、德国/法国、其他欧洲、美国、新加坡/香港、国内国有与民营、共同控制及未知/冲突；规则优先级、国家/地区分组、颜色和图例均为配置数据。

## 统一查询参考实现

```ts
import {
  AtlasDatasetSchema, createJobQueryService,
  type AtlasDataset, type JobQueryInput,
} from "@better-me/opportunities";

export function createSnapshotSearch(publicInput: unknown) {
  let dataset: AtlasDataset = AtlasDatasetSchema.parse(publicInput);
  const service = createJobQueryService({ readSnapshot: async () => dataset });

  return {
    search: (query: JobQueryInput) => service.search(query, {
      now: "2026-10-18T00:00:00.000Z", // 示例固定日期；生产由可信执行环境提供
    }),
    replaceSnapshot(next: unknown) { dataset = AtlasDatasetSchema.parse(next); },
  };
}

// const first = await search.search({
//   search: { text: "后端 TypeScript", mode: "fuzzy" },
//   market: "domestic",
//   salary: { metric: "min", includeEstimates: false, includeUnknown: true },
//   sort: { field: "salary", direction: "desc" },
//   page: { limit: 30 },
// });
```

`JobQuerySchema` 提供中英文标准化、模糊/精确关键词、工作地区、所有制/控股国家、来源、招聘类型、工作方式、状态、人民币税前年固定薪资、直线距离、显式地图范围及稳定正反排序契约。`queryJobs(dataset, query, options)` 是对应的纯快照参考实现；`createJobQueryService(repository)` 注入 `readSnapshot()`，让 UI、HTTP 和未来工具共享同一实现。

`JobQueryResultSchema`、`JobSearchItemSchema` 和 `MapBucketSchema` 提供对应的运行时输出契约，包括嵌套领域、薪资/距离/颜色及图表计数校验。`createJobsSearchTool(service, resolveOptions?)` 已将相同 service 封装为可实际执行的 `jobs.search` 工具；`resolveOptions` 在可信 host 中解析私人 anchor、汇率及配置，映射陈旧游标、无效查询和未定位错误。

查询结果中：

- `queryId`、`snapshotVersion`、`asOf` 和 `normalizedQuery` 绑定本次查询。`asOf` 固定在当前 UTC 日期起点以保证同日换汇可复现。游标在条件、数据、相关配置或派生日期变化后失效，抛出 `JobQueryError("stale-cursor")`，不能接着混用另一快照的分页。
- `items` 为当前页；`totalJobs`、`companyCount`、`mapBuckets`、`facets` 等基于同一份完整筛选结果。一个多地点岗位计一个岗位、多个位置点。未知地点留在未定位统计中，是否参与地域筛选由查询显式控制。
- `salaryCandidates` 保留适用薪资及原币信息，`salarySelection` 区分 none/single/equivalent/ambiguous；互相不等的可比范围不会静默挑选最高的一条。`salaryLocationScope` 说明有无地点绑定。未知/歧义薪资与未知距离在正反排序中都放到末尾。
- `sources` 保留列表项的来源 ID、标签、原链接和 Listing ID。`sourceCoverage` 只描述已索引记录及其观察状态，不表示全站/全球覆盖，也不是一次上游枚举任务的完整回执。
- 距离只通过查询中的 `anchorRef` 引用私人参照点；真实坐标由可信 `QueryOptions.anchor` 注入，不回显到 `normalizedQuery` 或结果。家庭位置变化时调用方必须更新 ref，不将家庭地址交给模型或写公共岗位库。

这是内存扫描与聚合基线，用于固定口径和合成验收；大索引、数据库全文索引、持续刷新、跨源归并和性能工程仍需后续阶段实现。返回的数据桶可以被地图渲染器使用，本包不绘制二维或三维地图。

## 工具工厂与执行器

使用已有共享搜索工具可以直接注册：

```ts
import { createJobsSearchTool, createToolRegistry, type JobQueryService } from "@better-me/opportunities";

export function registerSearch(service: JobQueryService) {
  return createToolRegistry([createJobsSearchTool(service)]);
}
```

新增业务工具时使用同一个工厂和执行器。例如只输出明确计数字段的包装：

```ts
import { z } from "zod";
import {
  defineTool, createToolRegistry, JobQuerySchema,
  type createJobQueryService,
} from "@better-me/opportunities";

export function createCountRegistry(service: ReturnType<typeof createJobQueryService>) {
  const countTool = defineTool({
    name: "jobs.count",
    version: 1,
    description: "从相同岗位查询返回计数",
    effect: "read-index",
    inputSchema: JobQuerySchema,
    outputSchema: z.object({ totalJobs: z.number().int().nonnegative() }).strict(),
    async execute(query, context) {
      context.throwIfCancelled();
      const result = await service.search(query);
      context.throwIfCancelled();
      return { totalJobs: result.totalJobs };
    },
  });
  return createToolRegistry([countTool]);
}

// 此上下文由可信 UI/HTTP/任务执行器构造，不能由模型参数或来源正文填写。
// const result = await registry.execute("jobs.count", { market: "global" }, {
//   requestId: "request-42", actorScope: "local-ui:session-1",
//   signal: new AbortController().signal,
//   budget: { requests: 0, timeoutMs: 5000, bytes: 65536 },
//   allowedEffects: ["read-index"],
// });
```

`defineTool()` 校验工具名、版本、effect、实际 Zod 输入/输出 Schema 与 handler。`createToolRegistry()` 拒绝重名；`list()` 为可信适配层返回工具元数据和 Schema，`execute()` 返回 `ToolResult`，错误包含固定 `code` 与公开文案，不转发原始异常、原始输入或 Zod 错误值。

当前执行边界：

| 机制 | 已实现规则与调用方责任 |
| --- | --- |
| 副作用权限 | `read-index`、`external-read`、`local-write`、`external-action`；`allowedEffects` 必须由可信执行器决定。工具正文或输入中的同名字段不会授予权限 |
| 请求身份 | `requestId`、`actorScope` 从可信上下文提供；本包不实现用户认证、Origin 校验或 HTTP 会话 |
| 运行时校验 | 执行前/后校验 Zod 与 JSON；拒绝循环、函数、BigInt、Date、非有限数值、getter、symbol 和显式 undefined。应使用精确输出 Schema，避免把整个内部对象作为任意 record 输出 |
| 预算 | 请求数、超时和 UTF-8 JSON 字节上限；输入和返回先按字节计数，适配器需为每个实际请求/重试调用 `consumeRequests()`，并为接收内容调用 `consumeBytes()` |
| 超时与取消 | 传播 `AbortSignal`、`throwIfCancelled()` 并隔离迟到返回；同步阻塞和不协作的外部操作无法被 JavaScript 强制回滚，业务提交前仍需版本/取消检查 |
| 幂等 | local-write / external-action 必须有 `idempotencyKey`。同 actor + tool + key 合并并发执行，异输入拒绝，返回值与内部回执隔离；重复调用可单独取消等待，首次调用的 signal 仍拥有实际共享执行 |
| 回执寿命 | 最多 10,000 条**进程内**回执；成功、失败和不确定的中断结果均保留以避免盲目重复副作用。重建 registry 或重启会丢失回执，不能用它替代服务端事务与耐久幂等日志 |
| 可操作错误 | 包括 unsupported-capability、needs-auth、needs-human-verification、rate-limited、partial-result、source-changed、timeout、cancelled、stale-version、budget-exceeded 等；保留区分，不能统一变成空结果 |

执行器自身不访问网络或存储。声明 effect 不会使任意 handler 自动安全：适配器仍需正确记账，HTTP 服务需独立实施端点/DNS/重定向策略、凭据隔离、认证、事务、耐久任务与幂等。工具层不安装 Agent SDK，不自动投递或绕过平台人工验证。

## 旧机会库：先公共预览，再保留私人关联

```ts
import {
  previewLegacyImport, applyLegacyBindings,
  type AtlasDataset, type LegacyImportReceipt,
} from "@better-me/opportunities";

export async function importExplicitly(
  originalBrowserLibrary: unknown,
  importPublicDataset: (dataset: AtlasDataset) => Promise<LegacyImportReceipt>,
) {
  const preview = await previewLegacyImport(originalBrowserLibrary);

  // 只上传 dataset。privateBindings、sourceFingerprint 与原库留在浏览器。
  const receipt = await importPublicDataset(preview.dataset);
  const linked = await applyLegacyBindings(originalBrowserLibrary, {
    expectedRevision: preview.sourceRevision,
    expectedFingerprint: preview.sourceFingerprint,
    privateBindings: preview.privateBindings,
    receipt,
  });

  // linked.library === originalBrowserLibrary；v1 的 ID、时间、材料正文均未改写。
  // references 由调用方独立保存，不覆盖旧机会库或改动已采用的 JD/材料。
  return { library: linked.library, references: linked.references, warnings: preview.warnings };
}
```

`previewLegacyImport(input)` 是纯异步函数，只接受旧 v1 机会库形状，限制 4 MiB / 2,000 条、重复 ID/详情来源和安全链接。它不会访问 localStorage、IndexedDB、浏览器 profile、HTTP 或文件。用合成 fixture 验证以下边界：

- 公共投影逐字段构造，只提取岗位、公司、JD、来源/发现/申请链接、地点/薪资原文及历史时间/状态；不 spread 旧对象。个人投递阶段、联系人、通讯、材料、Fact、Key 和未知字段不会进入 `dataset` 或 warnings/errors。
- 没有详情 URL 时使用 `manual-source` 与稳定来源记录号，不伪造 URL；没有 JD 时不伪造内容快照。公司名称、人工读取和 source-read 均不证明控股来源，旧 open 状态不证明当前仍在招。
- 旧地点保留原文，不补行政编码或坐标；旧薪资不猜币种、税制、薪数或数值。原始 v1 对象包含的私人字段、所有 ID、原时间和逐字正文保持不变。
- `privateBindings` 在浏览器保存 oldOpportunityId ↔ jobId/listingId/snapshotId。`sourceFingerprint` 包含原库指纹，是私人并发保护信息；调用方不得把整个 preview 当成公共导入请求。
- `applyLegacyBindings()` 只在 revision 与整个原库 fingerprint 未变化、服务明确成功且确认了全部岗位/快照 ID 时建立独立 sidecar；还会重新核对 bindings，不接受伪造关联。预览始终基于同一捕获快照，绑定在异步哈希结束后再次检查原库，服务失败、处理中发生的并发编辑或不完整回执都拒绝，不清库。
- 传入相同 `previous` sidecar 时幂等复用。此 helper 不负责 HTTP 回执的真实性认证，也不写存储；UI 应在显式确认流程中调用，并独立保存 references，继续保留旧库备份与私人材料。

静态链接校验不是抓取授权。旧库预览拒绝可执行协议、URL 凭据、明显本机/私网地址和显式凭据查询参数；后续适配器发请求时仍要重新做网络策略校验。迁移预览成功不代表服务、数据库迁移或现有工作台接线已经完成。

## 验证

在仓库根目录运行：

```powershell
pnpm --filter @better-me/opportunities typecheck
pnpm --filter @better-me/opportunities build
pnpm exec tsx --test packages/opportunities/tests/*.test.ts
```

测试使用合成公共岗位和私人哨兵，覆盖领域引用、薪资/距离/配色、模糊查询与分页一致性、公共迁移隔离、revision/fingerprint/回执保护及工具权限/预算/取消/幂等。平台实时读取、真实用户数据、生产数据库、长时间采集、三维视觉和端到端私人工作台迁移均需要各自后续验收。
