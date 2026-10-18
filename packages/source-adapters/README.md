# BetterMe 可配置岗位来源

`@better-me/source-adapters` 把显式安装的来源适配器、版本化 JSON 来源配置、受控网络传输和候选发现分开。适配器输出未核实的公开来源记录，由 [`job-service`](../../apps/job-service/README.md) 统一投影到 [`opportunities`](../opportunities/README.md) 领域；它不访问个人简历、Fact、投递材料或 API Key。

本包使用 Node.js 网络 API，供 Node **24.15.0+ 的 24.x 或 Node 26+** 本机服务使用。现有静态网页不会直接执行这些网络适配器，也不能因为接口存在就声称已实现所有招聘平台的聚合搜索。

## 已安装适配器

| `adapterId` / 版本 | 输入与覆盖 | 输出边界 |
| --- | --- | --- |
| `greenhouse` / `1` | 具体公司的官方公开 board；`options.boardToken`，可配 `companyName`。 | 保留岗位 ID、原链接、正文、地点原文和源时间；受数量限制，不提供 Greenhouse 全站搜索。 |
| `lever` / `1` | 具体公司的 Postings API board；支持 board 内 offset 分页。 | 保留原始地点、工作方式、正文和可用的薪资声明；未披露税制、固定工资组成时不自行补全。演示 board 不是市场数据。 |
| `ashby` / `1` | 具体公司的公开 job-board API。 | 远程资格区域单独保存，不制造办公室坐标；保留薪资原文与源时间。 |
| `mapped-json` / `1` | `entryUrl` 指定的 JSON 列表及有限字段路径映射。 | 默认 `discoveryOnly: true`；人工审核后才可配置为岗位记录。不能运行源仓库代码或自定义 JS。 |
| `github-json` / `1` | `raw.githubusercontent.com` 的具体 JSON 文件，使用相同有限映射。 | 强制 `discovery-lead`；不能用配置将目录、多个方向或招聘批次变成已核实单岗。 |

所有现有适配器的 `remoteFilters` 均为空；`roles`、`regions`、`companyNames` 关注条件会报告为上游未执行，应用层另做本地匹配。它们支持按具体 board / feed 列举，不承诺平台级全文搜索。51job、Boss、猎聘、LinkedIn 和公司官网的更多适配仍需通过同一契约接入，已有浏览器单岗读取能力没有在这里被冒充为平台搜索。

## 配置与注册

来源配置由 `@better-me/opportunities` 的 `SourceDefinitionSchema` 校验，包含稳定 `sourceId`、适配器 ID / 版本、实际能力、运行环境、实体类型、状态、端点策略、归属说明和刷新限制。没有可执行模块路径、shell 命令、CSS 或任意解析代码。

[`config/sources/examples.json`](../../config/sources/examples.json)提供多个结构不同的示例，全部默认 `enabled: false`、`status: "needs-review"`。示例不会在启动时自动下载；应核对当前来源条款、授权范围、链接、稳定岗位身份与请求范围后，由用户显式注册和启用。GitHub 等目录配置的领域类型为 `company-directory`，注册器将它匹配到适配器的 `discovery-lead` 输出。

有限 JSON 映射示意：

```json
{
  "recordsPath": "data.jobs",
  "idPath": "id",
  "titlePath": "title",
  "urlPath": "url",
  "companyPath": "company.name",
  "descriptionPath": "description",
  "locationsPath": "locations",
  "salaryTextPath": "salary",
  "publishedPath": "published_at",
  "updatedPath": "updated_at",
  "discoveryOnly": true
}
```

这些字段放在来源的 `options` 内，`entryUrl` 放在来源顶层。路径只允许有限的自有属性访问，例如 `data.jobs`；不支持通配符、表达式、括号脚本、原型遍历或 getter。`recordsPath: ""` 表示根数组。记录必须具备稳定 ID 或原始 URL，不能把数组下标当岗位身份；位置与工资文字保持原文，不自动猜坐标或工资数值。

代码注册器示意：

```ts
import {
  createSourceRegistry, createControlledSourceTransport,
  greenhouseAdapter, leverAdapter, ashbyAdapter,
  mappedJsonAdapter, githubJsonAdapter,
} from "@better-me/source-adapters";

const registry = createSourceRegistry([
  greenhouseAdapter, leverAdapter, ashbyAdapter,
  mappedJsonAdapter, githubJsonAdapter,
]);
const transport = createControlledSourceTransport();

// reviewedSource 经 SourceDefinitionSchema 校验，enabled=true 且 status=active。
// trustedContext 由可信 host 提供预算、取消信号、身份与 observedAt，不来自来源 JSON。
const result = await registry.list({
  source: reviewedSource,
  scope: { roles: ["TypeScript"], regions: [], companyNames: [] },
  context: trustedContext,
  transport,
});
```

`SourceRegistry.register()` 只安装可信代码适配器；重复 ID / 版本会拒绝。`describe()` 返回能力元数据。`resolve()` 检查启用状态、版本、能力、运行环境和实体类型，不能用来源 JSON 自行安装未知代码。`list()` 对输入及实际输出做运行时校验，检查记录上限、观察时间、实体类型、分页与过滤覆盖，避免适配器把部分结果声明为完整覆盖。

## 记录与覆盖契约

`SourceJobRecord` 保留 `entityType`、稳定源 ID / URL、雇主与标题、原文、地点、薪资、工作方式、远程资格、源时间、逐字段 evidence、完整度和 warnings。它是外部声明，不会成为个人职业事实。

`SourcePage` 包含 `records`、`observedAt`、可选 `nextCursor`、`coverage`、可选 `stopReason` 和 warnings。`coverage` 明确完整 / 部分覆盖、实际拉取记录数、上游执行 / 忽略的过滤条件；页数、记录数、预算、429、人工验证或来源错误导致的截断不能声称全量。`Retry-After`、取消和固定错误码会传回调用方，不记录原响应中的凭据或私人文本。

下载成功、原站 list 中出现、GitHub push 时间或 `isListed` 都不能单独证明当前在招。只有具备明确源依据的 availability 才能声明 `open` / `closed`；否则保持 `unknown`。源时间与服务拉取时间分别保存。当前解析器不推断企业控股来源、不地理编码、不将未提供的工资自动转换为可比税前年薪。

## 候选发现、抽样与提案

来源发现是通用工具，用户给出的仓库只是种子。导出函数与应用工具一一对应：

| 函数 | 输入 / 结果 |
| --- | --- |
| `discoverSourceCandidates(request, execution)` | `provider: "github-repositories"` 加 `query` 搜索仓库元数据，或 `provider: "seed-links"` 加 `seedUrls` 有限检查显式种子；返回 `needs-review` 候选、来源证据、部分覆盖与分页。 |
| `inspectSourceCandidate(request, execution)` | 输入 candidate，可选最多 3 个 `sampleUrls`、最多 100 条抽样；识别 JSON / CSV / Markdown 的有限字段、覆盖情况和候选映射。 |
| `proposeSourceRegistration(request)` | 输入 candidate、某个 sample、名称和记录限制；输出禁用的待审来源及必须核对的事项，不写入注册器。 |

实际网络请求仍需要一个显式启用、具备 `discover-sources` 能力的来源配置及它的端点策略；发现工具不能越过策略任意访问候选 URL。GitHub 搜索不自动克隆仓库、不运行项目代码，不因为 star、活跃度或仓库许可证就认定岗位内容可再分发。GitHub 结果上限、抽样上限、缺许可和缺稳定 ID 都保留为限制。

CSV / Markdown 当前用于抽样识别与提案。没有对应生产列表解析器时，提案保持待审，不能直接启用为已实现的来源。候选、清单、招聘活动和方向线索均不是已核实岗位，不计入正式岗位数量。

## 受控传输

`createControlledSourceTransport()` 提供 GET-only HTTPS 读取。它对主机 / 路径允许项、重定向每一步、DNS 结果、实际连接地址、响应流大小、总字节预算、请求预算、超时、取消与来源速率做检查。DNS 地址会固定到实际连接；私网、回环、云元数据、保留 / 文档 / Fake-IP 范围会拒绝，不能用公开域名跳入本地地址。

适配器不能透传 Cookie、Authorization 或任意请求头；当前只允许有限的内容协商 / 缓存条件请求头。来源 `secretRef` 仅是引用名，现有 job-service 发现它时返回需要认证，不会从 JSON 读取实际密钥。登录 / 验证码接续仍属于原有本机浏览器流程。

对于系统 Fake-IP 环境，可由可信 host 显式选择：

```ts
import { createControlledSourceTransport, createGoogleDohResolver } from "@better-me/source-adapters";

const transport = createControlledSourceTransport({ resolve: createGoogleDohResolver() });
```

该解析器使用固定的 `dns.google` HTTPS 服务与公网 TLS bootstrap；返回地址仍须符合公网策略。它把请求的来源主机名发送给 Google，不改系统 DNS。DNS HTTPS 和实际来源请求共享同一个请求 / 字节 / 取消 / 截止时间预算，因此一次来源读取至少需要两次请求额度。默认仍使用系统 DNS，不会自动退回放宽地址验证的模式。

`resolve` / `send` 的可注入接口供可信 host 和合成测试使用，不可从不可信来源 JSON 或普通 HTTP 请求中指定。模块没有系统代理修改、shell 执行、浏览器 profile 管理或任意网络代理 API。

## 验证与尚未完成的工作

仓库根 `pnpm test`、`pnpm lint` 和 `pnpm typecheck` 已覆盖本包。单独运行测试：

```powershell
pnpm exec tsx --test packages/source-adapters/tests/*.test.ts
pnpm --filter @better-me/source-adapters typecheck
```

自动化使用合成固定响应、受控连接与预算测试，不请求私人数据。`tests/public-probe.ts` 是显式真实来源检查辅助脚本，不是默认测试；有限样本检查不能外推全站长期可用或完整市场覆盖。

本包尚不包含地图渲染、地址解析 / 通勤服务、企业控股研究工具、自动跨源归并、定时调度、完整平台搜索、服务器身份认证或 LangChain / LangGraph Agent。扩展时应复用这些输入 / 输出 Schema、证据、覆盖与受控 transport，让 UI、HTTP 和未来 Agent 使用同一底座。
