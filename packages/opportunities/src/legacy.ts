import { AtlasDatasetSchema, HttpUrlSchema, type AtlasDataset, type EvidenceRef, type SourceDefinition } from "./schema.js";
import { deriveEntityId, normalizeSourceUrl } from "./identity.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_JOBS = 2_000;
const encoder = new TextEncoder();
type RecordValue = Record<string, unknown>;
export type LegacyImportErrorCode = "invalid-library" | "too-large" | "duplicate-id" | "unsafe-url" | "stale-version" | "service-rejected" | "invalid-binding";
const ERRORS: Record<LegacyImportErrorCode, string> = {
  "invalid-library": "旧机会库格式不正确，原数据未修改。", "too-large": "旧机会库超过迁移预览上限，原数据未修改。",
  "duplicate-id": "旧机会库包含重复岗位编号或来源，原数据未修改。", "unsafe-url": "旧机会库包含不安全或无效的公共链接，原数据未修改。",
  "stale-version": "机会库已变化，请重新生成迁移预览。", "service-rejected": "服务未确认导入成功，未建立浏览器关联。",
  "invalid-binding": "服务回执或浏览器关联不完整，未建立关联。",
};

/** Fixed messages never include values, property names, Zod issues or private record contents. */
export class LegacyImportError extends Error {
  readonly code: LegacyImportErrorCode;
  constructor(code: LegacyImportErrorCode) { super(ERRORS[code]); this.name = "LegacyImportError"; this.code = code; }
}
export type LegacyImportWarning = {
  code: "historical-import" | "unverified-company" | "unverified-availability" | "unlocated" | "unparsed-salary" | "manual-source" | "missing-description";
  jobIndex?: number;
  message: string;
};
export type LegacyPrivateBinding = { oldOpportunityId: string; jobId: string; listingId: string; snapshotId?: string };
export type LegacyImportPreview = {
  dataset: AtlasDataset;
  /** Browser-only values: send dataset alone to the index service. */
  privateBindings: LegacyPrivateBinding[];
  sourceRevision: number;
  sourceFingerprint: string;
  warnings: LegacyImportWarning[];
};
export type LegacyReferenceSidecar = {
  schemaVersion: 1;
  libraryRevision: number;
  libraryFingerprint: string;
  bindings: LegacyPrivateBinding[];
};
export type LegacyImportReceipt =
  | { ok: true; jobIds: string[]; snapshotIds: string[] }
  | { ok: false };

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new LegacyImportError("invalid-library");
  return value as RecordValue;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new LegacyImportError("invalid-library");
  return value;
}

const countryAliases: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["CN", ["CN", "中国", "中国大陆", "中国内地", "中华人民共和国", "China", "Mainland China", "People's Republic of China", "PRC"]],
  ["HK", ["HK", "香港", "中国香港", "香港特别行政区", "中国香港特别行政区", "Hong Kong", "Hong Kong SAR", "Hong Kong SAR China"]],
  ["MO", ["MO", "澳门", "中国澳门", "澳门特别行政区", "中国澳门特别行政区", "Macao", "Macau", "Macao SAR", "Macao SAR China"]],
  ["TW", ["TW", "台湾", "中国台湾", "台湾地区", "Taiwan"]],
  ["US", ["US", "USA", "美国", "美利坚合众国", "United States", "United States of America"]],
  ["GB", ["GB", "UK", "英国", "United Kingdom", "Great Britain"]],
  ["SG", ["SG", "新加坡", "Singapore"]], ["DE", ["DE", "德国", "Germany"]], ["FR", ["FR", "法国", "France"]],
  ["JP", ["JP", "日本", "Japan"]], ["CA", ["CA", "加拿大", "Canada"]], ["AU", ["AU", "澳大利亚", "Australia"]],
];
const countryAliasKey = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const legacyCountryCodes = new Map(countryAliases.flatMap(([code, aliases]) => aliases.map((alias) => [countryAliasKey(alias), code] as const)));

/** Exact, finite names from the explicitly saved country field only. Market, cities and brands are never inputs. */
export function resolveLegacyCountryCode(country: string): string | undefined {
  return legacyCountryCodes.get(countryAliasKey(country));
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new LegacyImportError("invalid-library");
  return value as T;
}

/** Inspect descriptors first: JSON.stringify must not execute an imported getter or toJSON hook. */
function safeLibraryText(input: unknown): string {
  let approximateBytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  function inspect(value: unknown, depth: number): void {
    if (++nodes > 250_000 || depth > 100) throw new LegacyImportError("too-large");
    if (value === undefined || value === null || typeof value === "boolean") return;
    if (typeof value === "string") approximateBytes += encoder.encode(value).byteLength;
    else if (typeof value === "number") { if (!Number.isFinite(value)) throw new LegacyImportError("invalid-library"); }
    else if (typeof value === "object") {
      if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) throw new LegacyImportError("invalid-library");
      if (!Array.isArray(value)) record(value);
      else if (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null) throw new LegacyImportError("invalid-library");
      ancestors.add(value);
      for (const key of Object.getOwnPropertyNames(value)) {
        if (Array.isArray(value) && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new LegacyImportError("invalid-library");
        approximateBytes += encoder.encode(key).byteLength;
        inspect(descriptor.value, depth + 1);
      }
      ancestors.delete(value);
    } else throw new LegacyImportError("invalid-library");
    if (approximateBytes > MAX_BYTES) throw new LegacyImportError("too-large");
  }
  inspect(input, 0);
  const serialized = JSON.stringify(input);
  if (!serialized) throw new LegacyImportError("invalid-library");
  if (encoder.encode(serialized).byteLength > MAX_BYTES) throw new LegacyImportError("too-large");
  return serialized;
}
async function hashText(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function timestamp(value: unknown, optional = false): string | undefined {
  if (optional && (value === undefined || value === "")) return undefined;
  const raw = text(value, 64, true);
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(raw);
  if (!dateParts) throw new LegacyImportError("invalid-library");
  const month = Number(dateParts[2]);
  const day = Number(dateParts[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(Number(dateParts[1]), month, 0)).getUTCDate()) throw new LegacyImportError("invalid-library");
  // Match the v1 library convention: timezone-less values are Asia/Shanghai.
  const qualified = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+08:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw}+08:00` : raw;
  if (!Number.isFinite(Date.parse(qualified))) throw new LegacyImportError("invalid-library");
  return new Date(qualified).toISOString();
}
function publicUrl(value: unknown): string | undefined {
  const raw = text(value, 8_000);
  if (!raw.trim()) return undefined;
  const urlText = raw.trim();
  if (!HttpUrlSchema.safeParse(urlText).success) throw new LegacyImportError("unsafe-url");
  const url = new URL(urlText);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const privateV4 = ipv4 && (Number(ipv4[1]) === 0 || Number(ipv4[1]) === 10 || Number(ipv4[1]) === 127
    || (Number(ipv4[1]) === 169 && Number(ipv4[2]) === 254)
    || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
    || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168));
  const privateV6 = host.includes(":") && (host === "::" || host === "::1" || /^(?:f[cd]|fe[89ab]|ff|::ffff:)/i.test(host));
  if (host === "localhost" || /\.(?:localhost|local|internal)$/.test(host) || privateV4 || privateV6) throw new LegacyImportError("unsafe-url");
  const parameterKeys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  for (const key of parameterKeys) {
    if (/^(?:api[_-]?key|access[_-]?token|token|secret|password|authorization|session(?:id)?|credential)$/i.test(key)) throw new LegacyImportError("unsafe-url");
  }
  return normalizeSourceUrl(urlText);
}

function parseHeader(input: unknown): { library: RecordValue; jobs: RecordValue[]; revision: number } {
  const library = record(input);
  if (library.schemaVersion !== 1 || !Number.isSafeInteger(library.revision) || (library.revision as number) < 0) throw new LegacyImportError("invalid-library");
  timestamp(library.updatedAt);
  if (!Array.isArray(library.jobs) || library.jobs.length > MAX_JOBS) throw new LegacyImportError("too-large");
  const jobs = library.jobs.map(record);
  const ids = jobs.map((job) => text(job.id, 150, true));
  if (new Set(ids).size !== ids.length) throw new LegacyImportError("duplicate-id");
  return { library, jobs, revision: library.revision as number };
}

/**
 * Non-destructive, explicit preview. No storage, HTTP, credentials or browser APIs are accessed.
 * Every public object below is constructed from named fields; application/materials/unknown keys
 * are never spread or copied. Ownership and current availability stay unverified on import.
 */
export async function previewLegacyImport(input: unknown): Promise<LegacyImportPreview> {
  try {
    const serialized = safeLibraryText(input);
    // Work from one captured JSON snapshot while async hashes are pending.
    const { jobs: oldJobs, revision } = parseHeader(JSON.parse(serialized) as unknown);
    const dataset: AtlasDataset = { schemaVersion: 1, revision: 0, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
    const privateBindings: LegacyPrivateBinding[] = [];
    const warnings: LegacyImportWarning[] = [{ code: "historical-import", message: "仅预览旧公共岗位字段；私人投递、联系人、材料及原机会库留在浏览器。导入时间不构成新的来源读取或在招核验。" }];
    const sources = new Map<string, SourceDefinition>();
    const seenUrls = new Set<string>();
    for (const [jobIndex, old] of oldJobs.entries()) {
      const oldId = text(old.id, 150, true);
      const company = text(old.company, 300, true).trim();
      const title = text(old.title, 500, true).trim();
      const description = text(old.description, 120_000);
      const sourceUrl = publicUrl(old.sourceUrl);
      const applicationUrl = publicUrl(old.applicationUrl);
      const discoveryUrl = publicUrl(old.discoveryUrl);
      const platform = text(old.sourcePlatform, 200, true).trim();
      const publisherType = choice(old.publisherType, ["company", "recruiter", "agency", "unknown"]);
      const market = choice(old.market, ["domestic", "overseas", "unknown"]);
      const workMode = choice(old.workMode, ["on-site", "hybrid", "remote", "unknown"]);
      const employmentType = choice(old.employmentType, ["social", "campus", "internship", "unknown"]);
      const status = choice(old.status, ["open", "closed", "unknown"]);
      const verificationMethod = choice(old.lastVerificationMethod ?? "unknown", ["source-read", "manual", "unknown"]);
      const collectedAt = timestamp(old.collectedAt)!;
      const firstDiscoveredAt = timestamp(old.firstDiscoveredAt)!;
      const updatedAt = timestamp(old.updatedAt)!;
      timestamp(old.createdAt);
      const lastVerifiedAt = timestamp(old.lastVerifiedAt, true);
      const sourcePublishedAt = timestamp(old.sourcePublishedAt, true);
      const sourceUpdatedAt = timestamp(old.sourceUpdatedAt, true);
      const sourcePublishedRaw = old.sourcePublishedText === undefined ? undefined : text(old.sourcePublishedText, 1_000);
      const sourceRecordId = old.sourceJobId === undefined ? undefined : text(old.sourceJobId, 300).trim() || undefined;
      const salaryRaw = text(old.salaryText, 2_000);
      const oldLocation = record(old.location);
      const country = text(oldLocation.country, 200).trim();
      const region = text(oldLocation.region, 200).trim();
      const city = text(oldLocation.city, 200).trim();
      if (!Array.isArray(old.remoteEligibleRegions) || old.remoteEligibleRegions.length > 100) throw new LegacyImportError("invalid-library");
      const remoteEligibleRegions = [...new Set(old.remoteEligibleRegions.map((value) => text(value, 240, true).trim()))];
      if (sourceUrl && seenUrls.has(sourceUrl)) throw new LegacyImportError("duplicate-id");
      if (sourceUrl) seenUrls.add(sourceUrl);
      const listingId = await deriveEntityId("listing", ["legacy-v1", oldId]);
      const jobId = await deriveEntityId("job", ["legacy-v1", oldId]);
      const companyId = await deriveEntityId("company", ["legacy-v1", oldId, company]);
      const contentHash = await hashText(description);
      const captureHash = await hashText(JSON.stringify({
        company, title, contentHash, sourceUrl, applicationUrl, discoveryUrl, platform, publisherType, market,
        workMode, employmentType, status, verificationMethod, collectedAt, firstDiscoveredAt, updatedAt,
        lastVerifiedAt, sourcePublishedAt, sourceUpdatedAt, sourcePublishedRaw, sourceRecordId, salaryRaw,
        country, region, city, remoteEligibleRegions,
      }));
      const observationId = await deriveEntityId("observation", [listingId, captureHash]);
      const snapshotId = description.trim() ? await deriveEntityId("snapshot", [listingId, observationId, contentHash]) : undefined;
      const sourceId = sourceUrl ? await deriveEntityId("source", ["legacy-v1", platform, new URL(sourceUrl).hostname]) : "manual-source";
      if (!sources.has(sourceId)) {
        sources.set(sourceId, {
          sourceId, name: sourceUrl ? platform : "本地手工来源", adapterId: "legacy-import", adapterVersion: "1",
          capabilities: [], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "needs-review",
          ...(sourceUrl ? { entryUrl: new URL(sourceUrl).origin } : {}), remoteFilters: [],
          endpointPolicy: { allowedHosts: [], allowedPathPrefixes: [], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
          attribution: { label: sourceUrl ? platform : "本地手工来源", usage: "unknown", requiresAttribution: true, notes: "旧机会库历史导入；来源能力及再使用范围尚未核验。" },
          refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 2_000, maxPages: 1, requestsPerMinute: 1 },
        });
      }
      const evidence: EvidenceRef[] = sourceUrl ? [{ observationId, sourceUrl, observedAt: collectedAt, selector: "legacy-v1/public-fields" }] : [];
      dataset.companies.push({ id: companyId, names: [company], domains: [], parentCompanyIds: [], ultimateControllers: { value: [], evidence: [], method: "manual", verification: "unknown", revision: 0 }, manualOverrides: [] });
      const locationIds: string[] = [];
      if (country || region || city) {
        const id = await deriveEntityId("location", [listingId, country, region, city]);
        locationIds.push(id);
        const countryCode = resolveLegacyCountryCode(country);
        dataset.locations.push({ id, raw: [country, region, city].filter(Boolean).join(" / "), kind: "unknown", ...(countryCode ? { countryCode } : {}), ...(region ? { region } : {}), ...(city ? { city } : {}), precision: "unknown", evidence, verification: "unverified" });
      }
      const compensationIds: string[] = [];
      if (salaryRaw.trim()) {
        const id = await deriveEntityId("compensation", [listingId, salaryRaw]);
        compensationIds.push(id);
        dataset.compensations.push({ id, raw: salaryRaw, period: "unknown", tax: "unknown", kind: "unknown", verification: "unverified", evidence });
        warnings.push({ code: "unparsed-salary", jobIndex, message: "薪资只保留原文；未猜测币种、金额、发薪月数或税前口径。" });
      }
      dataset.jobs.push({ id: jobId, companyId, title: { value: title, evidence, method: "manual", verification: "unverified", revision: 0 }, description, locationIds, compensationIds, listingIds: [listingId], ...(snapshotId ? { selectedSnapshotId: snapshotId } : {}), workMode, employmentType, remoteEligibleRegions, status: "unknown", revision: 0, updatedAt });
      dataset.listings.push({ id: listingId, sourceId, sourceRecordId: sourceUrl ? sourceRecordId ?? listingId : listingId, ...(sourceUrl ? { canonicalUrl: sourceUrl } : {}), ...(applicationUrl ? { applicationUrl } : {}), ...(discoveryUrl ? { discoveredViaUrls: [discoveryUrl] } : {}), canonicalJobId: jobId, observationIds: [observationId], firstDiscoveredAt, recordLastSeenAt: collectedAt });
      const observationWarnings = [
        "Historical legacy import; no network fetch or new availability verification was performed.",
        `Legacy recorded status=${status}; verification=${verificationMethod}; verificationTime=${lastVerifiedAt ?? "unknown"}.`,
        `Legacy source label: ${platform}; publisherType=${publisherType}; market=${market}. These labels do not verify ownership or work location.`,
      ];
      dataset.observations.push({ id: observationId, listingId, fetchedAt: collectedAt,
        ...(sourcePublishedRaw !== undefined ? { sourcePublishedRaw } : {}), ...(sourcePublishedAt ? { sourcePublishedAt } : {}),
        ...(sourceUpdatedAt ? { sourceUpdatedAt, sourceUpdatedRaw: text(old.sourceUpdatedAt, 64) } : {}),
        contentHash, ...(snapshotId ? { snapshotId } : {}), result: description.trim() ? "read" : "partial", availability: "unknown", completeness: description.trim() ? "excerpt" : "lead", rawText: description, warnings: observationWarnings });
      if (snapshotId) dataset.snapshots.push({ id: snapshotId, listingId, observationId, text: description, contentHash, createdAt: collectedAt, ...(sourceUrl ? { sourceUrl } : {}), extractionMethod: "manual", completeness: "excerpt" });
      privateBindings.push({ oldOpportunityId: oldId, jobId, listingId, ...(snapshotId ? { snapshotId } : {}) });
      warnings.push({ code: "unverified-company", jobIndex, message: "旧发布主体与读取方式不证明企业所有制或最终控股方，企业归属保留待核实。" },
        { code: "unverified-availability", jobIndex, message: "旧在招状态及核验时间只作历史观察，当前状态需重新核验。" },
        { code: "unlocated", jobIndex, message: "未补造行政编码或坐标；地点原文保留，暂不计算距离。" });
      if (!sourceUrl) warnings.push({ code: "manual-source", jobIndex, message: "该机会没有公开详情链接，使用本地手工来源与稳定记录编号，不补造 URL。" });
      if (!snapshotId) warnings.push({ code: "missing-description", jobIndex, message: "该机会没有 JD 正文，未创建虚构的内容快照。" });
    }
    dataset.sources = [...sources.values()];
    const validated = AtlasDatasetSchema.safeParse(dataset);
    if (!validated.success) throw new LegacyImportError("invalid-library");
    return { dataset: validated.data, privateBindings, sourceRevision: revision, sourceFingerprint: await hashText(serialized), warnings };
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError("invalid-library");
  }
}

/** Keep the v1 library byte-for-byte intact; attach confirmed references in a separate sidecar. */
export async function applyLegacyBindings<T>(library: T, options: {
  expectedRevision: number;
  expectedFingerprint: string;
  privateBindings: readonly LegacyPrivateBinding[];
  receipt: LegacyImportReceipt;
  previous?: LegacyReferenceSidecar;
}): Promise<{ library: T; references: LegacyReferenceSidecar }> {
  try {
    const serialized = safeLibraryText(library);
    const capturedLibrary: unknown = JSON.parse(serialized);
    const { jobs, revision } = parseHeader(capturedLibrary);
    if (revision !== options.expectedRevision || await hashText(serialized) !== options.expectedFingerprint) throw new LegacyImportError("stale-version");
    if (!options.receipt.ok) throw new LegacyImportError("service-rejected");
    if (!Array.isArray(options.receipt.jobIds) || !Array.isArray(options.receipt.snapshotIds) || !Array.isArray(options.privateBindings)) throw new LegacyImportError("invalid-binding");
    const acceptedJobs = new Set(options.receipt.jobIds);
    const acceptedSnapshots = new Set(options.receipt.snapshotIds);
    const oldIds = new Set(jobs.map((job) => text(job.id, 150, true)));
    const expected = await previewLegacyImport(capturedLibrary);
    const expectedBindings = new Map(expected.privateBindings.map((binding) => [binding.oldOpportunityId, binding]));
    const seen = new Set<string>();
    const bindings: LegacyPrivateBinding[] = [];
    for (const raw of options.privateBindings) {
      if (!raw || typeof raw !== "object" || typeof raw.oldOpportunityId !== "string" || !oldIds.has(raw.oldOpportunityId)
        || seen.has(raw.oldOpportunityId) || typeof raw.jobId !== "string" || !acceptedJobs.has(raw.jobId)
        || typeof raw.listingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(raw.listingId)
        || (raw.snapshotId !== undefined && (typeof raw.snapshotId !== "string" || !acceptedSnapshots.has(raw.snapshotId)))) throw new LegacyImportError("invalid-binding");
      const expectedBinding = expectedBindings.get(raw.oldOpportunityId);
      if (!expectedBinding || expectedBinding.jobId !== raw.jobId || expectedBinding.listingId !== raw.listingId || expectedBinding.snapshotId !== raw.snapshotId) throw new LegacyImportError("invalid-binding");
      seen.add(raw.oldOpportunityId);
      bindings.push({ oldOpportunityId: raw.oldOpportunityId, jobId: raw.jobId, listingId: raw.listingId, ...(raw.snapshotId ? { snapshotId: raw.snapshotId } : {}) });
    }
    if (seen.size !== jobs.length) throw new LegacyImportError("invalid-binding");
    const references: LegacyReferenceSidecar = { schemaVersion: 1, libraryRevision: revision, libraryFingerprint: options.expectedFingerprint, bindings };
    let referencesToReturn = references;
    if (options.previous) {
      if (options.previous.libraryRevision > revision) throw new LegacyImportError("stale-version");
      if (JSON.stringify(options.previous) === JSON.stringify(references)) referencesToReturn = options.previous;
    }
    // A caller may edit the live v1 object during async hashing; never bind that newer object.
    if (safeLibraryText(library) !== serialized) throw new LegacyImportError("stale-version");
    return { library, references: referencesToReturn };
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError("invalid-binding");
  }
}
