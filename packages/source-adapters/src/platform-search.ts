import { z } from "zod";
import catalogJson from "./platform-search-regions.json" with { type: "json" };
import { PlatformSearchProviderSchema, type PlatformSearchProvider, type PlatformSearchJobPlatform } from "@better-me/source-adapters/platform-job-identity";
export { PlatformSearchProviderSchema, type PlatformSearchProvider, type PlatformSearchJobPlatform } from "@better-me/source-adapters/platform-job-identity";

/** Pure request planning: no browser, transport, storage or platform session is accessed. */
const safeText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value), "Control characters and unpaired surrogates are not allowed.");
const regionKey = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(100);

/** Codes are platform-specific; their shape alone does not establish the real-world region. */
export const PlatformSearchRegionSchema = z.object({
  id: regionKey,
  name: safeText(120),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  aliases: z.array(safeText(200)).max(40),
  platforms: z.object({
    "51job": z.string().regex(/^\d{6}$/).optional(),
    boss: z.string().regex(/^10\d{7}$/).optional(),
    liepin: z.string().regex(/^\d{3}(?:\d{3})?$/).optional(),
    linkedin: safeText(240).optional(),
    seek: safeText(240).optional(),
    indeed: safeText(240).optional(),
    gradconnection: safeText(240).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "A region requires at least one platform mapping."),
}).strict().superRefine((region, context) => {
  if (region.countryCode !== "CN" && ["51job", "boss", "liepin"].some((provider) => provider in region.platforms)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["platforms"], message: "Domestic platform presets require an explicit CN region." });
  }
});
export type PlatformSearchRegion = z.infer<typeof PlatformSearchRegionSchema>;

function normalizedAlias(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export const PlatformSearchRegionsSchema = z.array(PlatformSearchRegionSchema).min(1).max(2000)
  .superRefine((regions, context) => {
    const names = new Map<string, string>();
    const codes = new Map<string, string>();
    regions.forEach((region, index) => {
      for (const value of [region.id, region.name, ...region.aliases]) {
        const key = normalizedAlias(value);
        const owner = names.get(key);
        if (owner !== undefined && owner !== region.id) context.addIssue({
          code: z.ZodIssueCode.custom, path: [index, "aliases"], message: "Region IDs, names and aliases must be unambiguous.",
        });
        names.set(key, region.id);
      }
      // Duplicate IDs must also fail when all labels happen to be identical.
      if (regions.findIndex((candidate) => candidate.id === region.id) !== index) context.addIssue({
        code: z.ZodIssueCode.custom, path: [index, "id"], message: "Region IDs must be unique.",
      });
      for (const [provider, value] of Object.entries(region.platforms)) {
        const key = `${provider}:${normalizedAlias(value)}`;
        const owner = codes.get(key);
        if (owner !== undefined && owner !== region.id) context.addIssue({
          code: z.ZodIssueCode.custom, path: [index, "platforms", provider], message: "A platform region value must identify a single configured region.",
        });
        codes.set(key, region.id);
      }
    });
  });

export const PlatformSearchReferenceSchema = z.object({
  provider: PlatformSearchProviderSchema,
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  }, "Reference must be a public HTTPS URL."),
  basis: z.enum(["official-city-catalog", "parameter-only", "official-response-title", "official-form"]),
  checkedAt: z.string().date(),
  note: safeText(1000),
}).strict();
export const PlatformSearchCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  references: z.array(PlatformSearchReferenceSchema).min(4).max(20).refine(
    (references) => new Set(references.map((reference) => reference.provider)).size === references.length,
    "Each platform requires exactly one public reference.",
  ),
  regions: PlatformSearchRegionsSchema,
}).strict();

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_PLATFORM_SEARCH_CATALOG = freezeDeep(PlatformSearchCatalogSchema.parse(catalogJson));
export const BUILTIN_PLATFORM_SEARCH_REGIONS: readonly PlatformSearchRegion[] = BUILTIN_PLATFORM_SEARCH_CATALOG.regions;

export const PLATFORM_SEARCH_PROVIDERS = freezeDeep([
  { id: "51job", name: "51JOB", regionFilter: "native-code", countryScope: "CN", resultMode: "external-search" },
  { id: "boss", name: "BOSS直聘", regionFilter: "native-code", countryScope: "CN", resultMode: "external-search" },
  { id: "liepin", name: "猎聘", regionFilter: "native-code", countryScope: "CN", resultMode: "external-search" },
  { id: "linkedin", name: "LinkedIn", regionFilter: "location-text", countryScope: "global", resultMode: "external-search" },
  { id: "seek", name: "Seek", regionFilter: "location-text", countryScope: "global", resultMode: "external-search" },
  { id: "indeed", name: "Indeed", regionFilter: "location-text", countryScope: "global", resultMode: "external-search" },
  { id: "gradconnection", name: "GradConnection", regionFilter: "location-text", countryScope: "global", resultMode: "external-search" },
] as const);

export type PlatformSearchErrorCode = "invalid-input" | "invalid-regions" | "unknown-region" | "unsupported-region";
const errors: Record<PlatformSearchErrorCode, string> = {
  "invalid-input": "平台搜索参数无效。",
  "invalid-regions": "平台地区配置无效；请分别配置平台地区代码，不要混用。",
  "unknown-region": "未找到该地区的明确映射；请先选择或配置地区。",
  "unsupported-region": "所选平台没有该地区的搜索映射；请改选地区或补充配置。",
};
export class PlatformSearchError extends Error {
  readonly code: PlatformSearchErrorCode;
  constructor(code: PlatformSearchErrorCode) {
    super(errors[code]);
    this.name = "PlatformSearchError";
    this.code = code;
  }
}

function parsedRegions(regions: readonly PlatformSearchRegion[]): readonly PlatformSearchRegion[] {
  if (regions === BUILTIN_PLATFORM_SEARCH_REGIONS) return regions;
  const result = PlatformSearchRegionsSchema.safeParse(regions);
  if (!result.success) throw new PlatformSearchError("invalid-regions");
  return result.data;
}

/** Exact aliases only. No inferred city, country, geographic proximity or cross-platform code conversion. */
export function resolvePlatformSearchRegion(
  input: string,
  regions: readonly PlatformSearchRegion[] = BUILTIN_PLATFORM_SEARCH_REGIONS,
): PlatformSearchRegion | undefined {
  const parsed = safeText(200).safeParse(input);
  if (!parsed.success) return undefined;
  const key = normalizedAlias(parsed.data);
  const region = parsedRegions(regions).find((candidate) => [candidate.id, candidate.name, ...candidate.aliases]
    .some((alias) => normalizedAlias(alias) === key));
  return region ? structuredClone(region) : undefined;
}

export function listPlatformSearchRegions(
  provider: PlatformSearchProvider,
  regions: readonly PlatformSearchRegion[] = BUILTIN_PLATFORM_SEARCH_REGIONS,
): PlatformSearchRegion[] {
  if (!PlatformSearchProviderSchema.safeParse(provider).success) throw new PlatformSearchError("invalid-input");
  return parsedRegions(regions).filter((region) => region.platforms[provider] !== undefined).map((region) => structuredClone(region));
}

export const PlatformSearchInputSchema = z.object({
  provider: PlatformSearchProviderSchema,
  keyword: z.string().trim().max(300).refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value), "Control characters and unpaired surrogates are not allowed."),
  regionId: regionKey.optional(),
  districtCode: z.string().regex(/^\d{6}$/).optional(),
}).strict();
export type PlatformSearchInput = z.infer<typeof PlatformSearchInputSchema>;
export type PlatformSearchRequest = {
  readonly kind: "external-platform-search";
  readonly provider: PlatformSearchProvider;
  readonly platform: PlatformSearchJobPlatform;
  readonly url: string;
  readonly keyword: string;
  readonly regionMode: "explicit" | "platform-default";
  readonly region?: {
    readonly id: string;
    readonly name: string;
    readonly countryCode: string;
    readonly providerValue: string;
    /** Structural validation does not verify arbitrary configured values against a live platform. */
    readonly basis: "official-city-catalog" | "official-response-title" | "parameter-only" | "official-form" | "configured-unverified";
  };
  readonly dataStatus: "not-collected";
  readonly nextAction: { readonly kind: "select-single-job-detail"; readonly platform: PlatformSearchJobPlatform };
  readonly warnings: readonly string[];
};

const endpoints: Record<PlatformSearchProvider, { platform: PlatformSearchJobPlatform; url: string; keywordParam: string }> = {
  "51job": { platform: "51JOB", url: "https://we.51job.com/pc/search", keywordParam: "keyword" },
  boss: { platform: "BOSS直聘", url: "https://www.zhipin.com/web/geek/job", keywordParam: "query" },
  liepin: { platform: "猎聘", url: "https://www.liepin.com/zhaopin/", keywordParam: "key" },
  linkedin: { platform: "LinkedIn", url: "https://www.linkedin.com/jobs/search", keywordParam: "keywords" },
  seek: { platform: "Seek", url: "https://www.seek.com.au/jobs", keywordParam: "keywords" },
  indeed: { platform: "Indeed", url: "https://www.indeed.com/jobs", keywordParam: "q" },
  gradconnection: { platform: "GradConnection", url: "https://gradconnection.com/jobs/", keywordParam: "q" },
};

/** Builds a launch request only. The caller chooses when to open it and when to read a single job. */
export function buildPlatformSearchRequest(
  input: PlatformSearchInput,
  regions: readonly PlatformSearchRegion[] = BUILTIN_PLATFORM_SEARCH_REGIONS,
): PlatformSearchRequest {
  const parsed = PlatformSearchInputSchema.safeParse(input);
  if (!parsed.success) throw new PlatformSearchError("invalid-input");
  const { provider, keyword, regionId, districtCode } = parsed.data;
  const catalog = parsedRegions(regions);
  const region = regionId === undefined ? undefined : catalog.find((candidate) => candidate.id === regionId);
  if (regionId !== undefined && !region) throw new PlatformSearchError("unknown-region");
  const providerValue = region?.platforms[provider];
  if (region && providerValue === undefined) throw new PlatformSearchError("unsupported-region");
  const endpoint = endpoints[provider];
  const url = new URL(endpoint.url);
  url.searchParams.set(endpoint.keywordParam, keyword);
  if (provider === "51job") url.searchParams.set("searchType", "2");
  if (provider === "boss" && districtCode) url.searchParams.set("multiBusinessDistrict", districtCode);
  if (providerValue !== undefined) {
    const regionParams: Record<PlatformSearchProvider, readonly string[]> = {
      "51job": ["jobArea"], boss: ["city"], liepin: ["city", "dq"], linkedin: ["location"],
      seek: ["where"], indeed: ["l"], gradconnection: ["location"],
    };
    regionParams[provider].forEach((param) => url.searchParams.set(param, providerValue));
  }
  const reference = BUILTIN_PLATFORM_SEARCH_CATALOG.references.find((candidate) => candidate.provider === provider)!;
  const builtin = BUILTIN_PLATFORM_SEARCH_REGIONS.find((candidate) => candidate.id === regionId);
  const basis = builtin?.countryCode === region?.countryCode && builtin?.platforms[provider] === providerValue
    ? reference.basis : "configured-unverified";
  const warnings = ["仅打开平台搜索页，尚未采集、导入或核实任何岗位；平台可能要求登录或人工验证。"];
  if (!region) warnings.push("未指定地区，平台可能采用其默认或上次选择的地区；这不代表全球或全国搜索。");
  if (region && basis === "parameter-only") warnings.push("该平台当前仅核对了搜索参数，地区代码尚需在打开的官方页面确认。");
  if (region && basis === "configured-unverified") warnings.push("当前地区来自自定义映射，仅校验了格式；请在官方页面核实对应地区。");
  if (region && (provider === "linkedin" || provider === "seek" || provider === "indeed" || provider === "gradconnection")) warnings.push("已提交地区文本；平台可能将其解析为自己的地区范围，请检查页面所选地点。");
  return freezeDeep({
    kind: "external-platform-search", provider, platform: endpoint.platform, url: url.toString(), keyword,
    regionMode: region ? "explicit" : "platform-default",
    ...(region && providerValue !== undefined ? { region: {
      id: region.id, name: region.name, countryCode: region.countryCode, providerValue, basis,
    } } : {}),
    dataStatus: "not-collected", nextAction: { kind: "select-single-job-detail", platform: endpoint.platform }, warnings,
  });
}
