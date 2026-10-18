import { AtlasDatasetSchema, type AtlasDataset, type Evidenced } from "@better-me/opportunities";

const AS_OF = "2026-10-18T00:00:00.000Z";
const field = <T,>(value: T): Evidenced<T> => ({ value, method: "manual", verification: "unverified", evidence: [], revision: 0 });
// Entirely synthetic companies, jobs, disclosures and city centres. Never imports a user's resume or opportunity store.
const samples: Array<[string, string, string, number, number, string, string, string, number, number]> = [
  ["上海", "CN", "CN-SH", 31.23, 121.47, "北欧工业 · 示例企业", "SE", "自动化工程师 / Automation Engineer", 32, 48],
  ["北京", "CN", "CN-BJ", 39.90, 116.40, "国内科技 · 示例企业", "CN", "TypeScript 全栈工程师", 36, 60],
  ["深圳", "CN", "CN-GD", 22.54, 114.06, "美国研发 · 示例企业", "US", "AI 平台工程师", 45, 72],
  ["杭州", "CN", "CN-ZJ", 30.27, 120.16, "国内科技 · 示例企业", "CN", "后端开发工程师 / Backend Engineer", 30, 52],
  ["苏州", "CN", "CN-JS", 31.30, 120.58, "德国制造 · 示例企业", "DE", "工业软件工程师 / C++", 28, 42],
  ["南京", "CN", "CN-JS", 32.06, 118.80, "国有能源 · 示例企业", "CN", "电气自动化工程师", 22, 35],
  ["成都", "CN", "CN-SC", 30.57, 104.07, "法国研发 · 示例企业", "FR", "嵌入式软件工程师", 26, 40],
  ["武汉", "CN", "CN-HB", 30.59, 114.30, "国有能源 · 示例企业", "CN", "数据平台工程师", 24, 38],
  ["广州", "CN", "CN-GD", 23.13, 113.26, "香港商业 · 示例企业", "HK", "产品数据分析师", 25, 39],
  ["西安", "CN", "CN-SN", 34.34, 108.94, "未知控股 · 示例企业", "", "测试开发工程师", 20, 32],
  ["香港", "HK", "CN-HK", 22.32, 114.17, "香港商业 · 示例企业", "HK", "Software Engineer · 软件工程师", 48, 78],
  ["新加坡", "SG", "SG", 1.35, 103.82, "新加坡技术 · 示例企业", "SG", "Platform Engineer · 平台工程师", 60, 95],
  ["斯德哥尔摩", "SE", "SE", 59.33, 18.07, "北欧工业 · 示例企业", "SE", "Robotics Engineer · 机器人", 48, 70],
  ["柏林", "DE", "DE", 52.52, 13.40, "德国制造 · 示例企业", "DE", "Senior Backend Engineer · 后端", 55, 85],
  ["巴黎", "FR", "FR", 48.86, 2.35, "法国研发 · 示例企业", "FR", "Machine Learning Engineer · 算法", 52, 80],
  ["伦敦", "GB", "GB", 51.51, -0.13, "欧洲研究 · 示例企业", "GB", "Research Engineer · 研究工程师", 65, 110],
  ["西雅图", "US", "US-WA", 47.61, -122.33, "美国研发 · 示例企业", "US", "Distributed Systems Engineer · 分布式", 100, 160],
  ["纽约", "US", "US-NY", 40.71, -74.01, "美国研发 · 示例企业", "US", "Full Stack Engineer · 全栈", 95, 155],
  ["多伦多", "CA", "CA-ON", 43.65, -79.38, "加拿大技术 · 示例企业", "CA", "Data Engineer · 数据工程师", 60, 92],
  ["东京", "JP", "JP", 35.68, 139.69, "日本技术 · 示例企业", "JP", "Software Engineer · 软件工程师", 40, 70],
  ["悉尼", "AU", "AU", -33.87, 151.21, "澳洲技术 · 示例企业", "AU", "Cloud Engineer · 云平台", 58, 88],
  ["阿拉木图", "KZ", "KZ", 43.24, 76.89, "未知控股 · 示例企业", "", "Frontend Engineer · 前端", 25, 45],
];

export function createAtlasDemo(): AtlasDataset {
  const data: AtlasDataset = { schemaVersion: 1, revision: 1, sources: [{
    sourceId: "atlas-demo", name: "演示数据 · 非真实招聘", adapterId: "synthetic", adapterVersion: "1", capabilities: [], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "disabled", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["example.invalid"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: "演示数据 · 非真实招聘", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 1, requestsPerMinute: 1 },
  }], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
  samples.forEach(([city, country, region, latitude, longitude, company, controller, title, min, max], i) => {
    const id = `demo-${i}`, companyId = `demo-company-${samples.findIndex((s) => s[5] === company)}`;
    const evidence = [{ observationId: `${id}-observation`, sourceUrl: `https://example.invalid/demo/${i}`, observedAt: AS_OF, quote: "合成演示披露，不代表任何真实企业、薪资、控股来源或招聘事实。" }];
    if (!data.companies.some((c) => c.id === companyId)) data.companies.push({ id: companyId, names: [company], domains: [], parentCompanyIds: [], manualOverrides: [], ultimateControllers: controller ? { value: [{ name: company, jurisdictionCode: controller, kind: company.includes("国有") ? "state" : "private" }], evidence, method: "manual", verification: "verified", revision: 0 } : field([]) });
    data.locations.push({ id: `${id}-location`, raw: `${city}（演示城市中心）`, kind: "office", countryCode: country, regionId: region, city, coordinates: { latitude, longitude, coordinateSystem: "WGS84" }, precision: "city", verification: "unverified", provider: "synthetic-city-centre", evidence });
    data.compensations.push({ id: `${id}-salary`, raw: `演示：人民币 ${min}–${max} 万元 / 年，税前固定工资`, currency: "CNY", period: "year", min: min * 10_000, max: max * 10_000, tax: "gross", kind: "base", verification: "unverified", evidence });
    data.jobs.push({ id, companyId, title: field(title), description: `【合成演示岗位，非真实招聘】\n${title}\n工作地点：${city}。用于体验地图、搜索、薪资比较和企业配色。此内容不能用于真实岗位匹配或投递。`, locationIds: [`${id}-location`], compensationIds: [`${id}-salary`], listingIds: [`${id}-listing`], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: "unknown", revision: 0, updatedAt: AS_OF });
    data.listings.push({ id: `${id}-listing`, sourceId: "atlas-demo", sourceRecordId: id, canonicalUrl: evidence[0]!.sourceUrl, canonicalJobId: id, observationIds: [`${id}-observation`], firstDiscoveredAt: AS_OF });
    data.observations.push({ id: `${id}-observation`, listingId: `${id}-listing`, fetchedAt: AS_OF, result: "read", availability: "unknown", completeness: "detail", warnings: ["synthetic-demo"] });
  });
  return AtlasDatasetSchema.parse(data);
}
