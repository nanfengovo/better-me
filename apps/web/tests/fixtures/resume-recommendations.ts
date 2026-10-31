import { FactBaseSchema } from "@better-me/core";
import { AtlasDatasetSchema, type AtlasDataset, type CanonicalJob } from "@better-me/opportunities";

export const fixtureResume = FactBaseSchema.parse({ schemaVersion: 1, updatedAt: "2026-10-31T00:00:00Z",
  profile: { displayName: { zh: "合成测试候选人" }, targetRoles: [{ zh: "后端开发工程师" }], location: { zh: "上海" } },
  experiences: [{ id: "test-exp", type: "work", org: { zh: "合成测试企业" }, title: { zh: "软件工程师" }, start: "2020-01", end: null,
    techStack: ["C#", ".NET", "Docker"], claims: [{ id: "test-claim", kind: "action", text: { zh: "开发仓储调度接口" }, tags: ["物流", "RCS"] }] }] });

type Spec = { id: string; title?: string; description: string; city?: string; country?: string; status?: CanonicalJob["status"]; url?: string };
export function recommendationDataset(specs: Spec[] = [
  { id: "local", title: ".NET 后端开发", description: "C# .NET Docker Redis 物流", city: "Shanghai" },
  { id: "other", title: ".NET 后端工程师", description: "C# .NET Docker", city: "北京" },
  { id: "tags", title: "RCS 软件工程师", description: "RCS 物流 Docker", city: "上海市" },
  { id: "java", description: "Java Spring", city: "上海" },
  { id: "closed", description: "C# .NET Docker", city: "上海", status: "closed" },
]): AtlasDataset {
  const at = "2026-10-31T00:00:00Z";
  const dataset: AtlasDataset = { schemaVersion: 1, revision: 1, sources: [], companies: [], locations: [], jobs: [], listings: [], compensations: [], observations: [], snapshots: [] };
  dataset.sources.push({ sourceId: "source-unit", name: "招聘来源", adapterId: "public-feed", adapterVersion: "1", capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: ["careers.company.org"], allowedPathPrefixes: ["/jobs/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "招聘来源", usage: "metadata", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 1, requestsPerMinute: 10 } });
  // All records here are synthetic; no fixture is seeded into a running app or index.
  for (const spec of specs) {
    dataset.companies.push({ id: `company-${spec.id}`, names: [`测试企业 ${spec.id}`], domains: [], parentCompanyIds: [], manualOverrides: [],
      ultimateControllers: { value: [], method: "manual", verification: "unknown", evidence: [], revision: 0 } });
    if (spec.city) dataset.locations.push({ id: `location-${spec.id}`, raw: spec.city, city: spec.city, countryCode: spec.country ?? "CN", kind: "office", precision: "city", verification: "unverified", evidence: [] });
    dataset.jobs.push({ id: spec.id, companyId: `company-${spec.id}`, title: { value: spec.title ?? "软件工程师", method: "manual", verification: "unverified", evidence: [], revision: 0 },
      description: spec.description, locationIds: spec.city ? [`location-${spec.id}`] : [], compensationIds: [], listingIds: [`listing-${spec.id}`], workMode: "on-site", employmentType: "social", remoteEligibleRegions: [], status: spec.status ?? "unknown", revision: 0, updatedAt: at });
    dataset.listings.push({ id: `listing-${spec.id}`, sourceId: "source-unit", canonicalJobId: spec.id, canonicalUrl: spec.url ?? `https://careers.company.org/jobs/${spec.id}`, observationIds: [], firstDiscoveredAt: at });
  }
  return AtlasDatasetSchema.parse(dataset);
}
