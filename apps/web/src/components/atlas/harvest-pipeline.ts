import type { AtlasDataset } from "@better-me/opportunities";
import {
  runLivePlatformBatchSearch,
  type LiveBatchSearchReceipt,
} from "../../lib/platform-search-client";
import {
  type ChinaRegionSelection,
} from "./china-regions";
import {
  enrichSnapshotCompaniesAndOffices,
  type LivePlatformImportSummary,
} from "./live-platform-auto-import";
import type { createAtlasSourceClient } from "./service-client";

export type ClientPipelineStage =
  | "intent-expansion"
  | "platform-harvest"
  | "cas-ingestion"
  | "enterprise-intelligence"
  | "spatial-geocoding"
  | "completed";

export type ClientPipelineProgress = {
  stage: ClientPipelineStage;
  stageIndex: number;
  totalStages: number;
  message: string;
  stats?: Record<string, number | string>;
};

export type OpportunityHarvestClientPipelineOptions = {
  client: ReturnType<typeof createAtlasSourceClient>;
  keyword: string;
  region?: string;
  chinaSelection?: ChinaRegionSelection;
  enableWebSearch?: boolean;
  initialSnapshot?: AtlasDataset;
  depth?: "quick" | "standard" | "deep";
  maxPages?: number;
  signal?: AbortSignal;
  onCardsCommitted?: (snapshot: AtlasDataset, stats: { totalAdded: number; totalUpdated: number }) => void;
  onSnapshotAvailable?: (snapshot: AtlasDataset) => void;
};

/**
 * OpportunityHarvestChainedClientPipeline
 *
 * Formal 5-stage client-side chained execution pipeline:
 *
 * Stage 1: Dynamic Semantic Intent & Query Expansion (DomainTaxonomy)
 * Stage 2: Multi-Platform Concurrent Live Harvest (CDP / Multi-Page)
 * Stage 3: CAS Chunked Ingestion & Deduplicated Commit
 * Stage 4: Dynamic Enterprise Intelligence & Ownership Resolution (SOE/Foreign/JV/Private)
 * Stage 5: Dynamic Spatial Geocoding & Office Site Placement
 */
export class OpportunityHarvestChainedClientPipeline {
  private client: ReturnType<typeof createAtlasSourceClient>;
  private keyword: string;
  private region?: string;
  private chinaSelection?: ChinaRegionSelection;
  private enableWebSearch?: boolean;
  private depth?: "quick" | "standard" | "deep";
  private maxPages?: number;
  private signal?: AbortSignal;

  private listeners: Array<(p: ClientPipelineProgress) => void> = [];
  private domainSynonyms: string[] = [];
  private batchReceipt?: LiveBatchSearchReceipt;
  private currentSnapshot?: AtlasDataset;
  private summary?: LivePlatformImportSummary;
  private touchedJobIds = new Set<string>();
  private initialSnapshot?: AtlasDataset;
  private onCardsCommittedCallback?: (snapshot: AtlasDataset, stats: { totalAdded: number; totalUpdated: number }) => void;
  private onSnapshotAvailableCallback?: (snapshot: AtlasDataset) => void;

  constructor(options: OpportunityHarvestClientPipelineOptions) {
    this.client = options.client;
    this.keyword = options.keyword.trim();
    this.region = options.region?.trim();
    this.chinaSelection = options.chinaSelection;
    this.enableWebSearch = options.enableWebSearch;
    this.depth = options.depth;
    this.maxPages = options.maxPages;
    this.signal = options.signal;
    this.initialSnapshot = options.initialSnapshot;
    this.onCardsCommittedCallback = options.onCardsCommitted;
    this.onSnapshotAvailableCallback = options.onSnapshotAvailable;
    if (this.initialSnapshot) {
      this.currentSnapshot = this.initialSnapshot;
    }
  }

  onProgress(listener: (p: ClientPipelineProgress) => void): this {
    this.listeners.push(listener);
    return this;
  }

  private emit(
    stage: ClientPipelineStage,
    stageIndex: number,
    message: string,
    stats?: Record<string, number | string>,
  ): void {
    const event: ClientPipelineProgress = {
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

  /**
   * Stage 1: Dynamic Semantic Intent & Query Expansion
   */
  stage1_ExpandIntent(): this {
    const raw = this.keyword;
    const lower = raw.toLowerCase();
    const syns: string[] = [raw];

    if (/c#|\.net|csharp/i.test(lower)) {
      syns.push("C#", ".NET", "上位机", "WPF", "WinForms");
    } else if (/c\+\+|cpp/i.test(lower)) {
      syns.push("C++", "Qt", "嵌入式软件");
    } else if (/java/i.test(lower)) {
      syns.push("Java", "Spring Boot", "后端架构");
    } else if (/python/i.test(lower)) {
      syns.push("Python", "数据分析", "AI算法");
    } else if (/前端|frontend|react|vue/i.test(lower)) {
      syns.push("前端开发", "React", "Vue");
    }

    this.domainSynonyms = [...new Set(syns)];
    this.emit("intent-expansion", 1, `检索意图动态泛化：生成 ${this.domainSynonyms.length} 个技术同义词`, {
      synonyms: this.domainSynonyms.join(", "),
    });
    return this;
  }

  /**
   * Stage 2: Multi-Platform Concurrent Live Harvest
   */
  async stage2_HarvestLivePlatforms(): Promise<this> {
    if (this.domainSynonyms.length === 0) this.stage1_ExpandIntent();
    this.emit("platform-harvest", 2, `正在通过多路实时引擎采集全网平台（BOSS · 51 · 猎聘 · 领英）真实岗位...`);

    const t0 = Date.now();
    this.batchReceipt = await runLivePlatformBatchSearch(
      {
        keyword: this.keyword,
        ...(this.region ? { regionId: this.region } : {}),
        ...(this.chinaSelection?.districtCode ? { districtCode: this.chinaSelection.districtCode } : {}),
        depth: this.depth ?? "standard",
        maxPages: this.maxPages ?? (this.depth === "deep" ? 30 : 15),
      },
      this.signal,
    );
    console.log(`[pipeline] Stage 2 HarvestLivePlatforms took ${Date.now() - t0}ms`);

    const readyProviders = (this.batchReceipt?.results ?? []).filter(
      (r) => r.status === "ready" && r.cards.length > 0,
    );
    const totalFound = readyProviders.reduce((acc, r) => acc + r.cards.length, 0);

    this.emit("platform-harvest", 2, `全网实时抓取完成：${readyProviders.length} 个平台成功返回 ${totalFound} 个岗位`, {
      platforms: readyProviders.map((r) => `${r.platform}(${r.cards.length})`).join(", "),
      totalCards: totalFound,
    });
    return this;
  }

  /**
   * Stage 3: CAS Chunked Ingestion & Deduplicated Commit
   */
  async stage3_CommitReviewedCards(): Promise<this> {
    if (!this.batchReceipt) throw new Error("Harvest results not available.");
    const readyProviders = this.batchReceipt.results.filter(
      (r) => r.status === "ready" && r.cards.length > 0,
    );

    if (readyProviders.length === 0) {
      this.emit("cas-ingestion", 3, `无有效岗位需要提交。`);
      return this;
    }

    this.emit("cas-ingestion", 3, `正在对抓取到的真实岗位进行 CAS 原子提交入库...`);
    let snapshot = this.currentSnapshot ?? (await this.client.snapshot({ signal: this.signal }));
    let totalAdded = 0;
    let totalUpdated = 0;
    let unlockedUi = false;
    const touchedJobIds = new Set<string>();

    for (const providerResult of readyProviders) {
      if (this.signal?.aborted) break;
      // Commit all harvested cards across all pagination pages without artificial truncation
      const targetCards = providerResult.cards;
      for (let offset = 0; offset < targetCards.length; offset += 50) {
        if (this.signal?.aborted) break;
        const chunk = targetCards.slice(offset, offset + 50);
        try {
          const preview = await this.client.previewReviewedCards(
            {
              provider: providerResult.provider,
              pageUrl: providerResult.pageUrl,
              capturedAt: this.batchReceipt.capturedAt,
              cards: chunk,
              expectedRevision: snapshot.revision,
            },
            { signal: this.signal },
          );
          const receipt = await this.client.importReviewedCards(
            {
              provider: providerResult.provider,
              pageUrl: providerResult.pageUrl,
              capturedAt: this.batchReceipt.capturedAt,
              cards: chunk,
              expectedRevision: preview.expectedRevision,
              previewFingerprint: preview.previewFingerprint,
              reviewed: true,
            },
            { signal: this.signal, idempotencyKey: `pipeline-${crypto.randomUUID()}` },
          );
          snapshot = { ...snapshot, revision: receipt.revision };
          totalAdded += receipt.counts.newJobs;
          totalUpdated += receipt.counts.updatedJobs;
          for (const id of receipt.jobIds) {
            touchedJobIds.add(id);
            this.touchedJobIds.add(id);
          }

          // FAST-PATH: As soon as the first chunk commits, unlock UI immediately!
          if (!unlockedUi) {
            unlockedUi = true;
            try {
              if (totalAdded > 0 || totalUpdated > 0) {
                this.currentSnapshot = await this.client.snapshot({ signal: this.signal });
              }
              if (this.currentSnapshot) {
                this.onCardsCommittedCallback?.(this.currentSnapshot, { totalAdded, totalUpdated });
                this.onSnapshotAvailableCallback?.(this.currentSnapshot);
              }
            } catch (err) {
              console.error("[pipeline] fast-path snapshot unlock error:", err);
            }
          } else if (receipt.counts.newJobs > 0 || receipt.counts.updatedJobs > 0) {
            // Subsequent chunks brought new/updated jobs: update live data reactively
            try {
              this.currentSnapshot = await this.client.snapshot({ signal: this.signal });
              this.onSnapshotAvailableCallback?.(this.currentSnapshot);
            } catch {}
          }
        } catch (err) {
          console.error("[pipeline stage3 commit error]", err);
          try {
            snapshot = await this.client.snapshot({ signal: this.signal });
          } catch {}
        }
      }
    }

    if (!unlockedUi) {
      if (totalAdded > 0 || totalUpdated > 0 || !this.currentSnapshot) {
        this.currentSnapshot = await this.client.snapshot({ signal: this.signal });
      }
      if (this.onCardsCommittedCallback && this.currentSnapshot) {
        try {
          this.onCardsCommittedCallback(this.currentSnapshot, { totalAdded, totalUpdated });
        } catch (err) {
          console.error("[pipeline] onCardsCommittedCallback error:", err);
        }
      }
      if (this.onSnapshotAvailableCallback && this.currentSnapshot) {
        try {
          this.onSnapshotAvailableCallback(this.currentSnapshot);
        } catch {}
      }
    }
    const finalRevision = this.currentSnapshot?.revision ?? snapshot.revision;
    this.emit("cas-ingestion", 3, `CAS 数据提交完成：新增 ${totalAdded} 岗，更新 ${totalUpdated} 岗 (版本: ${finalRevision})`, {
      totalAdded,
      totalUpdated,
      revision: finalRevision,
    });
    return this;
  }

  /**
   * Stage 4 & 5: Dynamic Enterprise Intelligence & Spatial Placement
   */
  async stage4_and_5_EnrichAndGeocode(): Promise<LivePlatformImportSummary> {
    if (!this.currentSnapshot) {
      this.currentSnapshot = await this.client.snapshot({ signal: this.signal });
    }

    const readyProviders = (this.batchReceipt?.results ?? []).filter(
      (r) => r.status === "ready" && r.cards.length > 0,
    );
    const importedPlatforms = readyProviders.map(
      (r) => `${r.platform}(${r.cards.length}岗)`,
    );

    // Fast-path: If no new or updated jobs were touched, skip redundant full-dataset enrichment
    if (this.touchedJobIds.size === 0) {
      this.summary = {
        snapshot: this.currentSnapshot,
        importedPlatforms,
        loginRequiredPlatforms: (this.batchReceipt?.results ?? [])
          .filter((r) => r.status === "login_required")
          .map((r) => r.platform),
        verificationRequiredPlatforms: (this.batchReceipt?.results ?? [])
          .filter((r) => r.status === "verification_required")
          .map((r) => r.platform),
        totalCardsFetched: readyProviders.reduce((acc, r) => acc + r.cards.length, 0),
        totalAdded: 0,
        totalUpdated: 0,
        locationsConfirmed: 0,
        officeAddressesConfirmed: 0,
        companiesClassified: 0,
      };
      this.emit("completed", 5, `全网实时检索入库完成：数据已是最新，无新增企业需重新穿透。`);
      return this.summary;
    }

    this.emit("enterprise-intelligence", 4, `正在对新增岗位的关联企业进行动态穿透分析与性质核验...`);
    const enriched = await enrichSnapshotCompaniesAndOffices({
      client: this.client,
      snapshot: this.currentSnapshot,
      jobIds: this.touchedJobIds,
      enableWebSearch: Boolean(this.enableWebSearch),
      ...(this.chinaSelection ? { fallbackChinaSelection: this.chinaSelection } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
    });

    if (this.onSnapshotAvailableCallback && enriched.snapshot) {
      try {
        this.onSnapshotAvailableCallback(enriched.snapshot);
      } catch {}
    }

    this.emit("spatial-geocoding", 5, `正在核实办公园区精准坐标与 3D 地图落点...`, {
      officesConfirmed: enriched.officeAddressesConfirmed,
      companiesClassified: enriched.companiesClassified,
    });

    this.summary = {
      snapshot: enriched.snapshot,
      importedPlatforms,
      loginRequiredPlatforms: (this.batchReceipt?.results ?? [])
        .filter((r) => r.status === "login_required")
        .map((r) => r.platform),
      verificationRequiredPlatforms: (this.batchReceipt?.results ?? [])
        .filter((r) => r.status === "verification_required")
        .map((r) => r.platform),
      totalCardsFetched: readyProviders.reduce((acc, r) => acc + r.cards.length, 0),
      totalAdded: 0,
      totalUpdated: 0,
      locationsConfirmed: enriched.locationsConfirmed,
      officeAddressesConfirmed: enriched.officeAddressesConfirmed,
      companiesClassified: enriched.companiesClassified,
    };

    this.emit("completed", 5, `全链条流水线执行完毕：已穿透 ${enriched.companiesClassified} 家企业性质，标注 ${enriched.officeAddressesConfirmed} 个办公落点。`);
    return this.summary;
  }

  /**
   * Fluent end-to-end execution of all 5 stages in chained sequence
   */
  async execute(): Promise<LivePlatformImportSummary> {
    this.stage1_ExpandIntent();
    await this.stage2_HarvestLivePlatforms();
    await this.stage3_CommitReviewedCards();
    return await this.stage4_and_5_EnrichAndGeocode();
  }
}

/**
 * Convenient helper to run the 5-stage chained pipeline
 */
export async function executeOpportunityHarvestChainedPipeline(
  options: OpportunityHarvestClientPipelineOptions,
  onProgress?: (p: ClientPipelineProgress) => void,
): Promise<LivePlatformImportSummary> {
  const pipeline = new OpportunityHarvestChainedClientPipeline(options);
  if (onProgress) pipeline.onProgress(onProgress);
  return await pipeline.execute();
}
