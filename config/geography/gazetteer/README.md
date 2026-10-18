# 离线城市候选数据

这份固定 GeoNames `cities15000` 快照供岗位办公地的**显式候选查询**使用。
34,167 条记录按 244 个原始国家／地区代码分片；gzip 文件合计 3,967,775 字节，
展开 JSON 合计 19,311,872 字节。数据不进入 React 的静态依赖或网页首屏包。
来源、许可、修改范围与精度限制见 [NOTICE](NOTICE.md)。

`manifest.json` 是本地读取入口，列出数据版本、原始 archive SHA-256、每片 SHA-256、
大小及覆盖。`source-download.json` 保存本次公开源下载元数据，`countries/XX.json.gz`
为按需读取的数据。Node provider 对压缩字节和展开大小都做检查，拒绝非 WGS84、损坏
JSON、重复身份及与 manifest 不符的分片。运行时不会下载 GeoNames 或发送查询地址。

```ts
import { resolve } from "node:path";
import { createLocalGazetteerProvider } from "@better-me/source-adapters";
import { acceptGeocodingCandidate } from "@better-me/opportunities";

// 路径由可信 host 配置一次；工具参数不能选择文件或 URL。
const provider = createLocalGazetteerProvider({
  manifestPath: resolve("config/geography/gazetteer/manifest.json"),
});
const cancellation = new AbortController();
const result = await provider.search({
  raw: "上海", kind: "office", countryCodes: ["CN"],
}, {
  signal: cancellation.signal,
  throwIfCancelled() { cancellation.signal.throwIfAborted(); },
});

// 展示 result.candidates、totalCandidates 和 truncated；用户选择后才生成 proposal。
// candidateId 是这次返回的某个候选 ID，不是任意城市或岗位 ID。
const proposal = acceptGeocodingCandidate(result, candidateId);
// proposal 保留 city / estimated / unverified；该调用不会写任何岗位或私人资料。
```

`countryCodes` 是硬范围，支持来源的原始主码及 alternate-country codes；`countryBias`
只排序，不消除同名歧义。`administrativeCodes` 按来源代码精确过滤；`bounds` 为
`[west, south, east, north]`，west > east 明确表示跨日期变更线。市场／显示区域的
代码分组由调用方配置，不把“国内”硬编码成只查 `CN`，也不改写来源代码。

默认只精确匹配完整 Unicode NFKC 名称及数据自带别名。`allowPrefix: true` 才返回前缀
候选；不会从长地址截取一个城市，也不会按人口大小自动选中同名城市。原文、匹配到的
原始别名、行政代码与版本证据保留。`remote-region` 和 `unknown` 返回不适用且不加载
城市分片。数据源的中文别名已实际核查；这不是自建中文全地址或街道解析服务。

`createGazetteerProvider({ loadManifest, loadShard })` 支持其他可信本地数据加载器，
`GeocodingProvider` 是后续 provider 端口。`createGeocodingTool(provider)` 提供实际
`locations.geocode-candidates` 工具（`read-index`），不自动写入位置，也不自动逐岗调用。
当前只有城市参考点能力；没有 Nominatim 请求、家庭地址解析、GCJ-02／BD-09 转换、
门牌精度或通勤时间估算。

重新生成时，先从 NOTICE 指定的公开 URL 人工取得 archive，核对 SHA-256 后运行：

```powershell
python scripts/build-geonames-gazetteer.py --archive <cities15000.zip路径> --metadata config/geography/gazetteer/source-download.json
```

脚本自身不联网、不读取用户资料。上游内容已变化时会拒绝旧 hash；维护者需要审核新
快照、下载元数据、许可和变化，再显式更新 hash 与文档。不要把运行时查询改成按岗
自动下载公共数据或调用免费在线地址 API。
