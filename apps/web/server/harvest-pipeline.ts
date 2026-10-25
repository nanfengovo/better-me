import { z } from "zod";
import {
  runLiveBatchSearch,
  type LiveBatchSearchResult,
  type LiveBatchSearchInput,
} from "./jd-live-batch-search";
import {
  lookupCompanyIntelligenceBatch,
  type CompanyIntelligenceLookupResult,
} from "./company-intelligence";
import {
  classifyEnterpriseOwnershipAndOrigin,
  resolveEnterpriseOfficeAddress,
  type KnownOfficePoint,
} from "../src/components/atlas/company-intelligence-catalog";

export const HarvestPipelineInputSchema = z.object({
  keyword: z.string().trim().min(1).max(300),
  region: z.string().trim().max(120).optional(),
  platforms: z.array(z.enum(["51job", "liepin", "boss", "linkedin"])).optional(),
  enableWebSearch: z.boolean().optional().default(true),
  maxPagesPerPlatform: z.number().int().min(1).max(10).optional().default(2),
});

export type HarvestPipelineInput = z.infer<typeof HarvestPipelineInputSchema>;

export type HarvestPipelineStage =
  | "stage1-intent-expansion"
  | "stage2-platform-harvest"
  | "stage3-enterprise-intelligence"
  | "stage4-spatial-geocoding"
  | "stage5-cas-aggregation";

export type HarvestPipelineProgressEvent = {
  stage: HarvestPipelineStage;
  stageIndex: number;
  totalStages: number;
  message: string;
  stats?: Record<string, number | string>;
};

export type ExpandedSearchIntent = {
  rawKeyword: string;
  region: string;
  domainSynonyms: string[];
  platformQueries: Record<string, string[]>;
};

export type HarvestPipelineReceipt = {
  status: "success" | "partial" | "empty";
  capturedAt: string;
  intent: ExpandedSearchIntent;
  harvestResult: LiveBatchSearchResult;
  totalCardsFound: number;
  uniqueCompaniesFound: number;
  companyIntelligence: Record<string, CompanyIntelligenceLookupResult>;
  resolvedOffices: Record<string, KnownOfficePoint>;
  timings: Record<string, number>;
};

/**
 * Stage 1 Tool: Dynamic Semantic Intent & Query Expansion
 * Expands technical domain keywords into search synonyms without hardcoded companies.
 */
export class DomainTaxonomyTool {
  static expandIntent(keyword: string, region: string = "上海"): ExpandedSearchIntent {
    const raw = keyword.trim();
    const lower = raw.toLowerCase();
    const synonyms: string[] = [raw];

    if (/c#|\.net|csharp/i.test(lower)) {
      synonyms.push("C#", ".NET", "上位机", "WPF", "WinForms", "ASP.NET Core");
    } else if (/c\+\+|cpp/i.test(lower)) {
      synonyms.push("C++", "Qt", "嵌入式软件", "底层开发");
    } else if (/java/i.test(lower)) {
      synonyms.push("Java", "Spring Boot", "后端架构", "微服务");
    } else if (/python/i.test(lower)) {
      synonyms.push("Python", "数据开发", "AI算法", "自动化测试");
    } else if (/前端|frontend|react|vue/i.test(lower)) {
      synonyms.push("前端开发", "React", "Vue", "TypeScript");
    } else if (/golang|go语言/i.test(lower)) {
      synonyms.push("Golang", "Go后端", "分布式系统");
    } else if (/rust/i.test(lower)) {
      synonyms.push("Rust", "系统开发", "底层安全");
    }

    const uniqueSynonyms = [...new Set(synonyms)];
    const platformQueries: Record<string, string[]> = {
      "51job": uniqueSynonyms.slice(0, 4),
      liepin: uniqueSynonyms.slice(0, 3),
      boss: uniqueSynonyms.slice(0, 3),
      linkedin: uniqueSynonyms.slice(0, 2),
    };

    return {
      rawKeyword: raw,
      region,
      domainSynonyms: uniqueSynonyms,
      platformQueries,
    };
  }
}

/**
 * Stage 2 Tool: Multi-Platform Live Harvester
 * Concurrently triggers multi-platform search (Boss, 51Job, Liepin, LinkedIn).
 */
export class PlatformHarvestTool {
  static async harvest(
    input: LiveBatchSearchInput,
    signal?: AbortSignal,
  ): Promise<LiveBatchSearchResult> {
    return await runLiveBatchSearch(input, signal);
  }
}

/**
 * Stage 3 Tool: Dynamic Enterprise Intelligence & Ownership Resolution
 * Discovers company ownership (SOE, Foreign, JV, Private), country of origin, and headquarters.
 */
export class EnterpriseIntelligenceTool {
  static async enrichBatch(
    companyInputs: Array<{
      companyId?: string;
      companyName: string;
      cityHint?: string;
      rawLocation?: string;
      jobTexts?: string[];
      locationTexts?: string[];
    }>,
    enableWebSearch: boolean = true,
    signal?: AbortSignal,
  ): Promise<Record<string, CompanyIntelligenceLookupResult>> {
    if (companyInputs.length === 0) return {};
    const res = await lookupCompanyIntelligenceBatch(
      { items: companyInputs, enableWebSearch },
      signal,
    );
    return res.results;
  }
}

/**
 * Stage 4 Tool: Dynamic Spatial Geocoding & Office Placement
 * Resolves precise office street addresses and WGS-84 coordinates.
 */
export class SpatialGeocodingTool {
  static resolveOfficeCoordinates(
    companyId: string,
    companyName: string,
    rawLocation: string,
    jobTexts?: string[],
    knownPoint?: KnownOfficePoint,
  ): KnownOfficePoint | undefined {
    return (
      knownPoint ??
      resolveEnterpriseOfficeAddress({
        companyId,
        companyName,
        rawLocation,
        jobTexts,
      })
    );
  }
}

/**
 * OpportunityHarvestPipeline
 *
 * Chained 5-Stage Orchestration Pipeline:
 * Stage 1: Expand Intent & Platform Query Matrix
 * Stage 2: Concurrently Harvest Live Platforms
 * Stage 3: Dynamically Resolve Enterprise Intelligence & Ownership
 * Stage 4: Dynamically Geocode Office Sites & Spatial Placement
 * Stage 5: Commit & Aggregate Final Dataset Receipt
 */
export class OpportunityHarvestPipeline {
  private input: HarvestPipelineInput;
  private listeners: Array<(event: HarvestPipelineProgressEvent) => void> = [];
  private timings: Record<string, number> = {};

  // Chained intermediate state
  private intent?: ExpandedSearchIntent;
  private harvestResult?: LiveBatchSearchResult;
  private companyIntelligence: Record<string, CompanyIntelligenceLookupResult> = {};
  private resolvedOffices: Record<string, KnownOfficePoint> = {};

  constructor(input: HarvestPipelineInput) {
    this.input = HarvestPipelineInputSchema.parse(input);
  }

  onProgress(listener: (event: HarvestPipelineProgressEvent) => void): this {
    this.listeners.push(listener);
    return this;
  }

  private emit(
    stage: HarvestPipelineStage,
    stageIndex: number,
    message: string,
    stats?: Record<string, number | string>,
  ): void {
    const event: HarvestPipelineProgressEvent = {
      stage,
      stageIndex,
      totalStages: 5,
      message,
      ...(stats ? { stats } : {}),
    };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {}
    }
  }

  /** Stage 1: Dynamic Semantic Intent & Query Expansion */
  stage1_ExpandIntent(): this {
    const start = Date.now();
    this.intent = DomainTaxonomyTool.expandIntent(
      this.input.keyword,
      this.input.region || "上海",
    );
    this.timings["stage1_intent_expansion_ms"] = Date.now() - start;
    this.emit("stage1-intent-expansion", 1, `意图泛化完成：生成 ${this.intent.domainSynonyms.length} 个技术同义词`, {
      synonyms: this.intent.domainSynonyms.join(", "),
    });
    return this;
  }

  /** Stage 2: Multi-Platform Concurrent Live Harvest */
  async stage2_HarvestPlatforms(signal?: AbortSignal): Promise<this> {
    if (!this.intent) this.stage1_ExpandIntent();
    const start = Date.now();
    this.emit("stage2-platform-harvest", 2, `启动全网平台（BOSS · 51 · 猎聘 · 领英）多路实时并发抓取...`);

    this.harvestResult = await PlatformHarvestTool.harvest(
      {
        keyword: this.input.keyword,
        regionId: this.input.region,
      },
      signal,
    );
    this.timings["stage2_platform_harvest_ms"] = Date.now() - start;

    const totalCards = this.harvestResult.results.reduce((acc, r) => acc + r.cards.length, 0);
    this.emit("stage2-platform-harvest", 2, `多平台采集完成：共获取 ${totalCards} 个有效岗位卡片`, {
      totalCards,
      platforms: this.harvestResult.results.map((r) => `${r.platform}(${r.cards.length})`).join(", "),
    });
    return this;
  }

  /** Stage 3: Dynamic Enterprise Intelligence & Ownership Resolution */
  async stage3_ResolveEnterpriseIntelligence(signal?: AbortSignal): Promise<this> {
    if (!this.harvestResult) throw new Error("HarvestResult not ready. Execute stage2 first.");
    const start = Date.now();

    // Extract unique companies across all harvested cards
    const allCards = this.harvestResult.results.flatMap((r) => r.cards);
    const companyCardsMap = new Map<string, typeof allCards>();
    for (const card of allCards) {
      const c = card.company.trim();
      if (!c) continue;
      const list = companyCardsMap.get(c) ?? [];
      list.push(card);
      companyCardsMap.set(c, list);
    }

    const batchInputs = [...companyCardsMap.entries()].map(([companyName, cards]) => ({
      companyId: companyName,
      companyName,
      cityHint: this.input.region || "上海市",
      rawLocation: cards[0]?.locationText || "上海市",
      jobTexts: cards.slice(0, 3).map((c) => `${c.title} ${c.cardText}`),
      locationTexts: cards.map((c) => c.locationText).filter(Boolean) as string[],
    }));

    this.emit("stage3-enterprise-intelligence", 3, `启动企业性质穿透解析：共 ${batchInputs.length} 家用人单位`, {
      companyCount: batchInputs.length,
    });

    this.companyIntelligence = await EnterpriseIntelligenceTool.enrichBatch(
      batchInputs,
      this.input.enableWebSearch,
      signal,
    );
    this.timings["stage3_enterprise_intelligence_ms"] = Date.now() - start;

    let foreignCount = 0;
    let stateCount = 0;
    let jvCount = 0;
    let privateCount = 0;
    for (const intel of Object.values(this.companyIntelligence)) {
      if (intel.categoryLabel.includes("外企")) foreignCount++;
      else if (intel.categoryLabel.includes("央企") || intel.categoryLabel.includes("国企")) stateCount++;
      else if (intel.categoryLabel.includes("合资")) jvCount++;
      else privateCount++;
    }

    this.emit("stage3-enterprise-intelligence", 3, `企业穿透分析完成：外企 ${foreignCount} | 国企/央企 ${stateCount} | 合资 ${jvCount} | 民企 ${privateCount}`, {
      foreignCount,
      stateCount,
      jvCount,
      privateCount,
    });
    return this;
  }

  /** Stage 4: Dynamic Spatial Geocoding & Office Placement */
  stage4_GeocodeLocations(): this {
    if (!this.harvestResult) throw new Error("HarvestResult not ready.");
    const start = Date.now();
    const allCards = this.harvestResult.results.flatMap((r) => r.cards);

    for (const card of allCards) {
      const companyName = card.company.trim();
      if (!companyName || this.resolvedOffices[companyName]) continue;
      const intel = this.companyIntelligence[companyName];
      const office = SpatialGeocodingTool.resolveOfficeCoordinates(
        companyName,
        companyName,
        card.locationText || "上海市",
        [card.title, card.cardText],
        intel?.resolvedOffice ?? intel?.knownShanghaiAddress,
      );
      if (office) {
        this.resolvedOffices[companyName] = office;
      }
    }

    this.timings["stage4_spatial_geocoding_ms"] = Date.now() - start;
    this.emit("stage4-spatial-geocoding", 4, `办公地点与空间坐标解析完成：对齐 ${Object.keys(this.resolvedOffices).length} 家办公点`, {
      geocodedCount: Object.keys(this.resolvedOffices).length,
    });
    return this;
  }

  /** Stage 5: Final Aggregation & Pipeline Receipt Generation */
  stage5_AssembleReceipt(): HarvestPipelineReceipt {
    const totalCards = this.harvestResult ? this.harvestResult.results.reduce((acc, r) => acc + r.cards.length, 0) : 0;
    const receipt: HarvestPipelineReceipt = {
      status: totalCards > 0 ? "success" : "empty",
      capturedAt: new Date().toISOString(),
      intent: this.intent ?? DomainTaxonomyTool.expandIntent(this.input.keyword, this.input.region),
      harvestResult: this.harvestResult ?? { capturedAt: new Date().toISOString(), results: [] },
      totalCardsFound: totalCards,
      uniqueCompaniesFound: Object.keys(this.companyIntelligence).length,
      companyIntelligence: this.companyIntelligence,
      resolvedOffices: this.resolvedOffices,
      timings: this.timings,
    };

    this.emit("stage5-cas-aggregation", 5, `全链条流水线执行完毕：共发现 ${totalCards} 个真实岗位，穿透 ${receipt.uniqueCompaniesFound} 家企业`, {
      totalCards,
      companies: receipt.uniqueCompaniesFound,
    });
    return receipt;
  }

  /** Complete end-to-end execution of the 5-stage chained pipeline */
  async execute(signal?: AbortSignal): Promise<HarvestPipelineReceipt> {
    this.stage1_ExpandIntent();
    await this.stage2_HarvestPlatforms(signal);
    await this.stage3_ResolveEnterpriseIntelligence(signal);
    this.stage4_GeocodeLocations();
    return this.stage5_AssembleReceipt();
  }
}
