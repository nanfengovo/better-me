import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  classifyEnterpriseOwnershipAndOrigin,
  resolveEnterpriseOfficeAddress,
  type EnterpriseIntelligenceResult,
  type KnownOfficePoint,
} from "../src/components/atlas/company-intelligence-catalog";
import { getNetworkFetch } from "./network-proxy";

export const CompanyIntelligenceLookupInputSchema = z.object({
  companyId: z.string().trim().max(240).optional(),
  companyName: z.string().trim().min(1).max(300),
  cityHint: z.string().trim().max(120).optional(),
  rawLocation: z.string().trim().max(500).optional(),
  jobTexts: z.array(z.string().max(10_000)).max(20).optional(),
  locationTexts: z.array(z.string().max(1_000)).max(20).optional(),
  enableWebSearch: z.boolean().optional(),
});

export const CompanyIntelligenceBatchInputSchema = z.object({
  items: z.array(CompanyIntelligenceLookupInputSchema).min(1).max(100),
  enableWebSearch: z.boolean().optional(),
});

export type CompanyIntelligenceLookupResult = EnterpriseIntelligenceResult & {
  companyName: string;
  resolvedOffice?: KnownOfficePoint;
  webSearchSnippet?: string;
  sourceMethod: "cache" | "live-web-search" | "structured-card" | "catalog-heuristic";
};

type CachedCompanyRecord = {
  controllers: EnterpriseIntelligenceResult["controllers"];
  categoryLabel: string;
  reason: string;
  updatedAt: string;
  officesByCity: Record<string, KnownOfficePoint>;
};

const COUNTRY_SNIPPET_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string; label: string }> = [
  { pattern: /德国(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于德国|德资/i, code: "DE", label: "外企 · 德国控股" },
  { pattern: /法国(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于法国|法资/i, code: "FR", label: "外企 · 法国控股" },
  { pattern: /美国(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于美国|纳斯达克|纽交所|美资/i, code: "US", label: "外企 · 美国控股" },
  { pattern: /日本(?:独资|外企|总部|跨国|株式会社|企业|集团)|总部位于日本|日资|日企/i, code: "JP", label: "外企 · 日本控股" },
  { pattern: /瑞士(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于瑞士|瑞资/i, code: "CH", label: "外企 · 瑞士控股" },
  { pattern: /瑞典(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于瑞典/i, code: "SE", label: "外企 · 瑞典控股" },
  { pattern: /芬兰(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于芬兰/i, code: "FI", label: "外企 · 芬兰控股" },
  { pattern: /丹麦(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于丹麦/i, code: "DK", label: "外企 · 丹麦控股" },
  { pattern: /挪威(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于挪威/i, code: "NO", label: "外企 · 挪威控股" },
  { pattern: /英国(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于英国|英资/i, code: "GB", label: "外企 · 英国控股" },
  { pattern: /荷兰(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于荷兰/i, code: "NL", label: "外企 · 荷兰控股" },
  { pattern: /意大利(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于意大利/i, code: "IT", label: "外企 · 意大利控股" },
  { pattern: /西班牙(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于西班牙/i, code: "ES", label: "外企 · 西班牙控股" },
  { pattern: /比利时(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于比利时/i, code: "BE", label: "外企 · 比利时控股" },
  { pattern: /奥地利(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于奥地利/i, code: "AT", label: "外企 · 奥地利控股" },
  { pattern: /爱尔兰(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于爱尔兰/i, code: "IE", label: "外企 · 爱尔兰控股" },
  { pattern: /新加坡(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于新加坡/i, code: "SG", label: "外企 · 新加坡控股" },
  { pattern: /韩国(?:独资|外企|总部|跨国|株式会社|企业|集团)|总部位于韩国|韩资/i, code: "KR", label: "外企 · 韩国控股" },
  { pattern: /加拿大(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于加拿大/i, code: "CA", label: "外企 · 加拿大控股" },
  { pattern: /澳大利亚(?:独资|外企|总部|跨国|公司|品牌|企业|集团)|总部位于澳大利亚|澳资/i, code: "AU", label: "外企 · 澳大利亚控股" },
  { pattern: /港资|香港(?:独资|控股|上市|总部)|总部位于香港/i, code: "HK", label: "外企/港资 · 中国香港控股" },
  { pattern: /台资|台湾(?:独资|控股|上市|总部)|总部位于台湾/i, code: "TW", label: "台资 · 中国台湾控股" },
];

const STREET_ADDRESS_REGEX =
  /(?:([\u4e00-\u9fa5]{2,6}(?:新区|区|县|市)))?([\u4e00-\u9fa5A-Za-z0-9]{2,14}(?:路|大道|街|弄|道)\d{1,5}号[\u4e00-\u9fa5A-Za-z0-9\-—()（）#号楼栋座室大厦广场中心科技园软件园产业园]{0,22})/;

function getCacheFilePath(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "BetterMe",
    "job-atlas",
    "company-intelligence-cache.json",
  );
}

let memoryCache: Record<string, CachedCompanyRecord> | undefined;

function loadCache(): Record<string, CachedCompanyRecord> {
  if (memoryCache) return memoryCache;
  const file = getCacheFilePath();
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        memoryCache = raw as Record<string, CachedCompanyRecord>;
        return memoryCache;
      }
    }
  } catch {}
  memoryCache = {};
  return memoryCache;
}

function saveCache(): void {
  if (!memoryCache) return;
  const file = getCacheFilePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(memoryCache, null, 2), "utf8");
  } catch {}
}

async function queryWebSnippet(query: string, signal?: AbortSignal): Promise<string> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&ensearch=0`;
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(4000)])
    : AbortSignal.timeout(4000);
  try {
    const fetcher = await getNetworkFetch();
    const res = await fetcher(url, { headers, signal: timeoutSignal });
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 8000);
  } catch {
    return "";
  }
}

async function geocodeAddressDynamic(
  city: string,
  addressOrCompany: string,
  signal?: AbortSignal,
): Promise<{ latitude: number; longitude: number } | undefined> {
  const q = `${city} ${addressOrCompany}`.trim();
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(3200)])
    : AbortSignal.timeout(3200);
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
    const fetcher = await getNetworkFetch();
    const res = await fetcher(url, {
      headers: { "User-Agent": "BetterMe-OpportunityAtlas/1.0" },
      signal: timeoutSignal,
    });
    if (res.ok) {
      const data = (await res.json()) as {
        features?: Array<{ geometry?: { coordinates?: [number, number] } }>;
      };
      const coords = data.features?.[0]?.geometry?.coordinates;
      if (
        coords &&
        typeof coords[0] === "number" &&
        typeof coords[1] === "number" &&
        Math.abs(coords[1]) <= 90 &&
        Math.abs(coords[0]) <= 180
      ) {
        return {
          latitude: Number(coords[1].toFixed(5)),
          longitude: Number(coords[0].toFixed(5)),
        };
      }
    }
  } catch {}
  return undefined;
}

function extractStreetFromTexts(
  texts: readonly string[],
  cityHint: string,
): { district?: string; streetAddress: string; formattedAddress: string } | undefined {
  for (const text of texts) {
    const match = STREET_ADDRESS_REGEX.exec(text);
    if (match && match[2]) {
      const district = match[1];
      const street = match[2];
      const prefix = cityHint || "上海市";
      const formatted = district
        ? `${prefix.endsWith("市") ? prefix : `${prefix}市`}${district} · ${street}`
        : `${prefix} · ${street}`;
      return {
        ...(district ? { district } : {}),
        streetAddress: district ? `${district}${street}` : street,
        formattedAddress: formatted,
      };
    }
  }
  return undefined;
}

export async function lookupCompanyIntelligence(
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<CompanyIntelligenceLookupResult> {
  const input = CompanyIntelligenceLookupInputSchema.parse(rawInput);
  const companyKey = input.companyName.trim().toLowerCase();
  const rawLoc = input.rawLocation?.trim() || input.locationTexts?.[0]?.trim() || input.cityHint?.trim() || "上海市";
  const cityKey = (input.cityHint?.trim() || rawLoc.slice(0, 6) || "上海市").toLowerCase();
  const cache = loadCache();
  const cached = cache[companyKey];

  const base = classifyEnterpriseOwnershipAndOrigin({
    companyName: input.companyName,
    jobTexts: input.jobTexts,
    locationTexts: input.locationTexts,
  });

  const isFallbackHeuristic = base.reason.includes("工商企业注册名称");
  let result: EnterpriseIntelligenceResult = cached
    ? {
        controllers: cached.controllers,
        categoryLabel: cached.categoryLabel,
        reason: cached.reason,
      }
    : base;
  let sourceMethod: CompanyIntelligenceLookupResult["sourceMethod"] = cached
    ? "cache"
    : isFallbackHeuristic
      ? "catalog-heuristic"
      : "structured-card";

  let webSearchSnippet: string | undefined;
  const shouldSearchWeb =
    input.enableWebSearch !== false &&
    (!cached || (!cached.officesByCity[cityKey] && !base.knownShanghaiAddress));

  if (shouldSearchWeb && isFallbackHeuristic) {
    const snippet = await queryWebSnippet(
      `"${input.companyName}" 企业性质 外企 国企 合资 办公地址 ${input.cityHint ?? "上海"}`,
      signal,
    );
    if (snippet) {
      webSearchSnippet = snippet.slice(0, 500);
      if (/中外合资|合资企业|合资公司/.test(snippet)) {
        const matchedForeign = COUNTRY_SNIPPET_PATTERNS.find((s) => s.pattern.test(snippet));
        result = {
          controllers: [
            { name: `${input.companyName}（中方合资股东）`, jurisdictionCode: "CN", kind: "joint" },
            {
              name: `${input.companyName}（外方合资股东）`,
              jurisdictionCode: matchedForeign?.code ?? "US",
              kind: "joint",
            },
          ],
          categoryLabel: "中外合资 · 共同控制",
          reason: `联网公开企业信息检索核实：中外合资企业（${matchedForeign?.label ?? "外方合资"}）。`,
        };
        sourceMethod = "live-web-search";
      } else {
        for (const spec of COUNTRY_SNIPPET_PATTERNS) {
          if (spec.pattern.test(snippet)) {
            result = {
              controllers: [
                {
                  name: `${input.companyName} (${spec.label}母公司)`,
                  jurisdictionCode: spec.code,
                  kind: "private",
                },
              ],
              categoryLabel: spec.label,
              reason: `联网公开企业信息检索核实：${spec.label}。`,
            };
            sourceMethod = "live-web-search";
            break;
          }
        }
      }
      if (sourceMethod !== "live-web-search") {
        if (/中央企业|国务院国资委|央企子公司|央企控股/.test(snippet)) {
          result = {
            controllers: [
              {
                name: "国务院国有资产监督管理委员会 / 中央国有企业集团",
                jurisdictionCode: "CN",
                kind: "state",
              },
            ],
            categoryLabel: "央企 · 国有控股",
            reason: "联网公开企业信息检索核实：属于中央企业或央企控股子公司。",
          };
          sourceMethod = "live-web-search";
        } else if (/国有企业|国有控股|国资委控股|国有独资/.test(snippet)) {
          result = {
            controllers: [
              {
                name: `${input.companyName}（国有资产监督管理机构控股）`,
                jurisdictionCode: "CN",
                kind: "state",
              },
            ],
            categoryLabel: "国企 · 国有控股",
            reason: "联网公开企业信息检索核实：属于国有控股企业。",
          };
          sourceMethod = "live-web-search";
        }
      }
    }
  }

  // Resolve office address: check cache -> extracted street from JD/web snippet -> dynamic geocoder -> catalog resolver
  let resolvedOffice: KnownOfficePoint | undefined = cached?.officesByCity?.[cityKey];
  if (!resolvedOffice) {
    const candidateTexts = [
      rawLoc,
      ...(input.locationTexts ?? []),
      ...(input.jobTexts ?? []),
      ...(webSearchSnippet ? [webSearchSnippet] : []),
    ];
    const extractedStreet = extractStreetFromTexts(candidateTexts, input.cityHint ?? "上海市");
    if (extractedStreet && input.enableWebSearch !== false) {
      const geocoded = await geocodeAddressDynamic(
        input.cityHint ?? "上海市",
        extractedStreet.streetAddress,
        signal,
      );
      if (geocoded) {
        resolvedOffice = {
          district: extractedStreet.district ?? "浦东新区",
          streetAddress: extractedStreet.streetAddress,
          formattedAddress: `${extractedStreet.formattedAddress}（${input.companyName}）`,
          latitude: geocoded.latitude,
          longitude: geocoded.longitude,
        };
      }
    }
    if (!resolvedOffice) {
      resolvedOffice = resolveEnterpriseOfficeAddress({
        companyId: input.companyId || input.companyName,
        companyName: input.companyName,
        rawLocation: rawLoc,
        jobTexts: candidateTexts,
      });
    }
  }

  // Update persistent cache
  cache[companyKey] = {
    controllers: result.controllers,
    categoryLabel: result.categoryLabel,
    reason: result.reason,
    updatedAt: new Date().toISOString(),
    officesByCity: {
      ...(cached?.officesByCity ?? {}),
      ...(resolvedOffice ? { [cityKey]: resolvedOffice } : {}),
    },
  };
  saveCache();

  return {
    companyName: input.companyName,
    ...result,
    ...(resolvedOffice ? { resolvedOffice } : {}),
    ...(webSearchSnippet ? { webSearchSnippet } : {}),
    sourceMethod,
  };
}

export async function lookupCompanyIntelligenceBatch(
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<{ results: Record<string, CompanyIntelligenceLookupResult> }> {
  const input = CompanyIntelligenceBatchInputSchema.parse(rawInput);
  const results: Record<string, CompanyIntelligenceLookupResult> = {};
  const concurrency = 6;
  let index = 0;

  async function worker() {
    while (index < input.items.length) {
      if (signal?.aborted) break;
      const current = input.items[index++]!;
      const key = current.companyId || current.companyName;
      try {
        results[key] = await lookupCompanyIntelligence(
          {
            ...current,
            enableWebSearch: input.enableWebSearch ?? current.enableWebSearch ?? true,
          },
          signal,
        );
      } catch {}
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.items.length) }, () => worker()),
  );
  return { results };
}
