import type { AtlasDataset } from "@better-me/opportunities";
import {
  runLivePlatformBatchSearch,
  type LiveBatchProviderResultClient,
  type LiveBatchSearchReceipt,
  type LiveBatchSearchStreamEvent,
} from "../../lib/platform-search-client";
import {
  type ChinaRegionSelection,
} from "./china-regions";
import {
  enrichSnapshotCompaniesAndOffices,
  type LivePlatformImportSummary,
} from "./live-platform-auto-import";
import { HarvestCheckpointError, LiveCardCommitQueue } from "./live-card-commit-queue";
import { HARVEST_PROVIDERS, type HarvestCheckpoint, type HarvestCheckpointSnapshot } from "./harvest-checkpoint";
import type { createAtlasSourceClient } from "./service-client";

const mergedStopReasonPriority: Record<LiveBatchProviderResultClient["coverage"]["stopReason"], number> = {
  error: 8,
  gate: 7,
  cancelled: 6,
  card_limit: 5,
  no_progress: 4,
  scroll_limit: 3,
  page_limit: 2,
  exhausted: 1,
};

/**
 * Merge sequential keyword captures without losing page evidence or claiming
 * that one query covered another query's pages. Each provider keeps a summed
 * budget across the queried terms and a hard card cap for the merged result.
 */
export function mergeLiveBatchSearchReceipts(
  receipts: readonly LiveBatchSearchReceipt[],
  queryTerms: readonly string[],
  failedTerms: readonly string[] = [],
  failedTermDetails: readonly { term: string; error: string }[] = [],
): LiveBatchSearchReceipt {
  if (receipts.length === 0) {
    return { capturedAt: new Date().toISOString(), results: [] };
  }

  const byProvider = new Map<LiveBatchProviderResultClient["provider"], LiveBatchProviderResultClient[]>();
  for (const receipt of receipts) {
    for (const result of receipt.results) {
      const current = byProvider.get(result.provider);
      if (current) current.push(result);
      else byProvider.set(result.provider, [result]);
    }
  }

  const results: LiveBatchProviderResultClient[] = [];
  for (const entries of byProvider.values()) {
    const first = entries[0]!;
    const cardLimit = first.coverage.cardLimit;
    const cardsByUrl = new Map<string, LiveBatchProviderResultClient["cards"][number]>();
    for (const entry of entries) {
      for (const card of entry.cards) {
        if (!cardsByUrl.has(card.url)) cardsByUrl.set(card.url, card);
      }
    }
    const uniqueCardCount = cardsByUrl.size;
    const cards = [...cardsByUrl.values()].slice(0, cardLimit);
    const rawCardCount = entries.reduce((total, entry) => total + entry.rawCardCount, 0);
    const pagesVisited = entries.reduce((total, entry) => total + entry.coverage.pagesVisited, 0);
    const pageLimit = entries.reduce((total, entry) => total + entry.coverage.pageLimit, 0);
    const scrollSteps = entries.reduce((total, entry) => total + entry.coverage.scrollSteps, 0);
    const scrollLimit = entries.reduce((total, entry) => total + entry.coverage.scrollLimit, 0);
    const capReached = uniqueCardCount > cardLimit;
    const stopReason = capReached
      ? "card_limit"
      : entries.every((entry) => entry.coverage.stopReason === "exhausted")
        ? "exhausted"
        : entries.reduce((best, entry) => (
          mergedStopReasonPriority[entry.coverage.stopReason] > mergedStopReasonPriority[best]
            ? entry.coverage.stopReason
            : best
        ), "exhausted" as LiveBatchProviderResultClient["coverage"]["stopReason"]);
    const warnings = [...new Set(entries.flatMap((entry) => entry.warnings))];
    if (queryTerms.length > 1) {
      warnings.push(`本平台串行检索 ${queryTerms.length} 个技术词并合并去重：${queryTerms.join("、")}`);
    }
    if (failedTerms.length > 0) {
      warnings.push(`以下技术词未完成实时读取：${failedTerms.join("、")}`);
      warnings.push(...failedTermDetails.map(({ term, error }) => `技术词 ${term} 读取失败：${error}`));
    }

    results.push({
      ...first,
      status: cards.length > 0 ? "ready" : first.status,
      cards,
      rawCardCount,
      warnings: [...new Set(warnings)],
      coverage: {
        ...first.coverage,
        pagesVisited,
        pageLimit,
        scrollSteps,
        scrollLimit,
        stopReason,
        partial: stopReason !== "exhausted",
      },
    });
  }

  return {
    capturedAt: receipts[receipts.length - 1]!.capturedAt,
    results,
  };
}

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

export type { LiveCommitStats } from "./live-card-commit-queue";

export type OpportunityHarvestClientPipelineOptions = {
  client: ReturnType<typeof createAtlasSourceClient>;
  checkpoint?: HarvestCheckpoint;
  keyword: string;
  region?: string;
  chinaSelection?: ChinaRegionSelection;
  enableWebSearch?: boolean;
  /** Keep enrichment available separately when capture should finish at commit. Default: true. */
  enrichAfterCommit?: boolean;
  initialSnapshot?: AtlasDataset;
  depth?: "quick" | "standard" | "deep";
  maxPages?: number;
  signal?: AbortSignal;
  onLiveResults?: (receipt: LiveBatchSearchReceipt, query: { keyword: string; region?: string; districtCode?: string }) => void;
  onLiveProgress?: (event: LiveBatchSearchStreamEvent, receipt: LiveBatchSearchReceipt, query: { keyword: string; region?: string; districtCode?: string }) => void;
  onCardsCommitted?: (snapshot: AtlasDataset, stats: { totalAdded: number; totalUpdated: number }) => void;
  onSnapshotAvailable?: (snapshot: AtlasDataset) => void;
};

/**
 * OpportunityHarvestChainedClientPipeline
 *
 * Five logical stages; harvesting and the single-writer commit queue overlap.
 * Enrichment is optional and begins only after an authoritative final snapshot.
 *
 * Stage 1: Dynamic Semantic Intent & Query Expansion (DomainTaxonomy)
 * Stage 2: Multi-Platform Concurrent Live Harvest (CDP / Multi-Page)
 * Stage 3: CAS Chunked Ingestion & Deduplicated Commit
 * Stage 4: Source-disclosed Administrative Areas & Automatic Company Classification
 * Stage 5: Location Status Summary (No Inferred Office Coordinates)
 */
export class OpportunityHarvestChainedClientPipeline {
  private client: ReturnType<typeof createAtlasSourceClient>;
  private keyword: string;
  private region?: string;
  private chinaSelection?: ChinaRegionSelection;
  private enableWebSearch?: boolean;
  private enrichAfterCommit: boolean;
  private depth?: "quick" | "standard" | "deep";
  private maxPages?: number;
  private signal?: AbortSignal;
  private callerSignal?: AbortSignal;
  private readonly checkpointFailureController = new AbortController();

  private listeners: Array<(p: ClientPipelineProgress) => void> = [];
  private domainSynonyms: string[] = [];
  private batchReceipt?: LiveBatchSearchReceipt;
  private currentSnapshot?: AtlasDataset;
  private summary?: LivePlatformImportSummary;
  // Keep the CAS commit counts across stages. Stage 4 builds the user-facing
  // summary after enrichment, so relying on its local counters would otherwise
  // report zero even when stage 3 already committed new or updated jobs.
  private committedAdded = 0;
  private committedUpdated = 0;
  private importFailures: LivePlatformImportSummary["importFailures"] = [];
  private touchedJobIds = new Set<string>();
  private commitQueue?: LiveCardCommitQueue;
  private checkpoint?: HarvestCheckpoint;
  private checkpointSnapshot?: HarvestCheckpointSnapshot;
  private checkpointInitialization?: Promise<void>;
  private readonly persistedProviderResults = new Map<string, string>();
  private frozenQueryTerms?: string[];
  private harvestHasErrors = false;
  private initialSnapshot?: AtlasDataset;
  private onCardsCommittedCallback?: (snapshot: AtlasDataset, stats: { totalAdded: number; totalUpdated: number }) => void;
  private onSnapshotAvailableCallback?: (snapshot: AtlasDataset) => void;
  private onLiveResultsCallback?: OpportunityHarvestClientPipelineOptions["onLiveResults"];
  private onLiveProgressCallback?: OpportunityHarvestClientPipelineOptions["onLiveProgress"];

  constructor(options: OpportunityHarvestClientPipelineOptions) {
    this.client = options.client;
    this.checkpoint = options.checkpoint;
    this.keyword = options.keyword.trim();
    this.region = options.region?.trim();
    this.chinaSelection = options.chinaSelection;
    this.enableWebSearch = options.enableWebSearch;
    this.enrichAfterCommit = options.enrichAfterCommit ?? true;
    this.depth = options.depth;
    this.maxPages = options.maxPages;
    this.callerSignal = options.signal;
    this.signal = options.checkpoint
      ? options.signal ? AbortSignal.any([options.signal, this.checkpointFailureController.signal]) : this.checkpointFailureController.signal
      : options.signal;
    this.initialSnapshot = options.initialSnapshot;
    this.onCardsCommittedCallback = options.onCardsCommitted;
    this.onSnapshotAvailableCallback = options.onSnapshotAvailable;
    this.onLiveResultsCallback = options.onLiveResults;
    this.onLiveProgressCallback = options.onLiveProgress;
    if (this.initialSnapshot) {
      this.currentSnapshot = this.initialSnapshot;
    }
  }

  onProgress(listener: (p: ClientPipelineProgress) => void): this {
    this.listeners.push(listener);
    return this;
  }

  private createCommitQueue(): LiveCardCommitQueue {
    return new LiveCardCommitQueue({
      client: this.client,
      checkpoint: this.checkpoint,
      onCheckpointFailure: error => { this.checkpointFailureController.abort(error); },
      signal: this.signal,
      onStats: (stats) => {
        this.committedAdded = stats.totalAdded;
        this.committedUpdated = stats.totalUpdated;
        this.emit("cas-ingestion", 3,
          `流式入库：新增 ${stats.totalAdded} 岗、更新 ${stats.totalUpdated} 岗；待提交 ${stats.pendingCards} 张卡片${stats.failedCards ? `，失败 ${stats.failedCards} 张` : ""}。`,
          { ...stats });
      },
      onSnapshot: (snapshot, stats) => {
        this.currentSnapshot = snapshot;
        try { this.onCardsCommittedCallback?.(snapshot, { totalAdded: stats.totalAdded, totalUpdated: stats.totalUpdated }); } catch { /* observer only */ }
        try { this.onSnapshotAvailableCallback?.(snapshot); } catch { /* observer only */ }
      },
    });
  }

  private async enqueueResult(result: LiveBatchProviderResultClient, capturedAt: string): Promise<void> {
    if (result.status !== "ready" || !this.commitQueue) return;
    await this.commitQueue.enqueue({ provider: result.provider, platform: result.platform, cards: result.cards, capturedAt, cardLimit: result.coverage.cardLimit });
  }

  private queryTerms(): string[] {
    if (this.frozenQueryTerms) return this.frozenQueryTerms;
    const maxQueryTerms = this.depth === "quick" ? 2 : this.depth === "deep" ? 6 : 3;
    return [...new Set(this.domainSynonyms.map(term => term.trim()).filter(Boolean))].slice(0, maxQueryTerms);
  }

  private async persistCheckpoint(operation: () => Promise<void>): Promise<void> {
    try { await operation(); }
    catch (error) { throw this.commitQueue?.stopAfterCheckpointFailure(error) ?? new HarvestCheckpointError(error); }
  }

  private initializeCheckpoint(): Promise<void> {
    if (!this.checkpoint) return Promise.resolve();
    return this.checkpointInitialization ??= (async () => {
      // Read the durable intent before expanding it: a changed taxonomy must
      // not silently change which queries a recovered run is responsible for.
      try { this.checkpointSnapshot = await this.checkpoint!.read(); }
      catch (error) { throw new HarvestCheckpointError(error); }
      if (!this.domainSynonyms.length) this.stage1_ExpandIntent();
      this.frozenQueryTerms = this.checkpointSnapshot.run.queryTerms ?? this.queryTerms();
      await this.persistCheckpoint(() => this.checkpoint!.initialize(this.frozenQueryTerms!, HARVEST_PROVIDERS));
      for (const value of this.checkpointSnapshot.providers) this.persistedProviderResults.set(`${value.term}\0${value.result.provider}`, JSON.stringify(value.result));
      this.commitQueue ??= this.createCommitQueue();
      this.batchReceipt = this.includeRecoveredCards(mergeLiveBatchSearchReceipts(
        this.checkpointSnapshot.providers.map(value => ({ capturedAt: value.capturedAt, results: [value.result] })), this.frozenQueryTerms,
      ));
      if (this.batchReceipt.results.length) this.publishLiveResults();
      await this.commitQueue.restore(this.checkpointSnapshot.batches);
    })();
  }

  private providerReadComplete(result: LiveBatchProviderResultClient | undefined): boolean {
    if (!result) return false;
    if (result.status === "empty") return result.coverage.stopReason === "exhausted" && !result.coverage.partial;
    return result.status === "ready" && !["error", "cancelled", "gate", "no_progress"].includes(result.coverage.stopReason);
  }

  /** Captured pages can outlive their stream's terminal provider message. */
  private includeRecoveredCards(receipt: LiveBatchSearchReceipt): LiveBatchSearchReceipt {
    if (!this.checkpointSnapshot?.batches.length) return receipt;
    const results = new Map(receipt.results.map(result => [result.provider, result]));
    for (const batch of this.checkpointSnapshot.batches) {
      const previous = results.get(batch.provider);
      const known = new Set(previous?.cards.map(card => card.url));
      const extra = batch.cards.filter(card => !known.has(card.url));
      if (!extra.length) continue;
      const warning = "保留上次已捕获的来源卡片；未完成的平台将重新读取查询，不恢复虚拟列表滚动位置。";
      results.set(batch.provider, previous ? {
        ...previous, status: "ready", cards: [...previous.cards, ...extra], rawCardCount: Math.max(previous.rawCardCount, previous.cards.length + extra.length),
        warnings: [...new Set([...previous.warnings, warning])],
      } : {
        provider: batch.provider, platform: batch.platform, pageUrl: batch.pageUrl, status: "ready", cards: [...extra], rawCardCount: extra.length,
        warnings: [warning], coverage: { pagesVisited: 0, pageLimit: this.maxPages ?? 5, scrollSteps: 0, scrollLimit: 0, cardLimit: 3000, stopReason: "cancelled", partial: true },
      });
    }
    return { ...receipt, results: [...results.values()] };
  }

  private async persistProvider(term: string, result: LiveBatchProviderResultClient, capturedAt: string): Promise<void> {
    await this.enqueueResult(result, capturedAt);
    if (!this.checkpoint) return;
    const key = `${term}\0${result.provider}`;
    const fingerprint = JSON.stringify(result);
    // SSE's final receipt repeats the same validated result with a server
    // timestamp. Preserve the first durable endpoint instead of rewriting it.
    if (this.persistedProviderResults.get(key) === fingerprint) return;
    await this.persistCheckpoint(() => this.checkpoint!.recordProvider({ term, result, capturedAt }));
    this.persistedProviderResults.set(key, fingerprint);
  }

  private publishLiveResults(): void {
    if (!this.batchReceipt) return;
    try {
      this.onLiveResultsCallback?.(this.batchReceipt, {
        keyword: this.keyword,
        ...(this.region ? { region: this.region } : {}),
        ...(this.chinaSelection?.districtCode ? { districtCode: this.chinaSelection.districtCode } : {}),
      });
    } catch (error) {
      console.error("[pipeline] onLiveResults callback error:", error);
    }
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
      } catch { /* Progress observers do not own the pipeline. */ }
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
    await this.initializeCheckpoint();
    if (this.domainSynonyms.length === 0) this.stage1_ExpandIntent();

    const t0 = Date.now();
    const queryTerms = this.queryTerms();
    const queryTermTotal = queryTerms.length;
    const receipts: LiveBatchSearchReceipt[] = [];
    const receiptIndexes = new Map<string, number>();
    const completedTerms = new Set<string>();
    const upsertReceipt = (term: string, receipt: LiveBatchSearchReceipt) => {
      const index = receiptIndexes.get(term);
      if (index === undefined) { receiptIndexes.set(term, receipts.length); receipts.push(receipt); }
      else receipts[index] = receipt;
    };
    for (const provider of this.checkpointSnapshot?.providers ?? []) {
      if (!queryTerms.includes(provider.term)) continue;
      const previous = receipts[receiptIndexes.get(provider.term) ?? -1];
      upsertReceipt(provider.term, { capturedAt: provider.capturedAt, results: [...(previous?.results ?? []), provider.result] });
    }
    const failedTerms: string[] = [];
    const failedTermDetails: Array<{ term: string; error: string }> = [];

    const providerOutcomeStats = () => {
      const providers = mergeLiveBatchSearchReceipts(
        receipts,
        queryTerms.slice(0, receipts.length),
        failedTerms,
        failedTermDetails,
      ).results;
      return {
        failedPlatforms: providers.filter((result) => result.status === "error" || result.coverage.stopReason === "error").length,
        blockedPlatforms: providers.filter((result) => result.status === "login_required" || result.status === "verification_required").length,
        partialPlatforms: providers.filter((result) => result.coverage.partial).length,
      };
    };

    // Stage 2 can run several synonym searches serially. Keep that progress
    // separate from the platform/page progress emitted by the SSE stream so a
    // completed platform is not mistaken for a completed overall harvest.
    const queryTermStats = (
      index: number,
      queryTerm: string,
      status: "queued" | "running" | "completed" | "failed" | "cancelled",
      extra: Record<string, number | string> = {},
    ): Record<string, number | string> => ({
      queryTermIndex: index,
      queryTermTotal,
      queryTerm,
      queryTermStatus: status,
      completedQueryTerms: completedTerms.size + failedTerms.length,
      failedQueryTerms: failedTerms.length,
      ...providerOutcomeStats(),
      ...extra,
    });

    this.emit(
      "platform-harvest",
      2,
      `实时采集已排队 ${queryTermTotal} 个技术词，等待平台回执...`,
      queryTermStats(0, "", "queued"),
    );

    for (const [index, queryTerm] of queryTerms.entries()) {
      this.signal?.throwIfAborted();
      this.commitQueue?.assertHealthy();
      const priorReceipt = receipts[receiptIndexes.get(queryTerm) ?? -1];
      const currentQueryResults = new Map(priorReceipt?.results.map(result => [result.provider, result]));
      const providers = HARVEST_PROVIDERS.filter(provider => !this.checkpoint || !this.providerReadComplete(currentQueryResults.get(provider)));
      if (!providers.length) {
        completedTerms.add(queryTerm);
        this.emit("platform-harvest", 2, `已恢复技术词 ${index + 1}/${queryTermTotal} 的已读平台回执：${queryTerm}（保留原有覆盖限制）。`,
          queryTermStats(index + 1, queryTerm, "completed"));
        continue;
      }
      this.emit(
        "platform-harvest",
        2,
        `正在实时检索技术词 ${index + 1}/${queryTermTotal}：${queryTerm}`,
        queryTermStats(index + 1, queryTerm, "running"),
      );
      try {
        const capturedAt = new Date().toISOString();
        let accumulatedReceipt = this.includeRecoveredCards(mergeLiveBatchSearchReceipts(receipts, queryTerms, failedTerms, failedTermDetails));
        const publishStreamProgress = async (event: LiveBatchSearchStreamEvent) => {
          this.commitQueue?.assertHealthy();
          // Numeric page/scroll progress must not re-merge every previously
          // captured card. Page cards travel separately on the progress event.
          if (event.type === "provider-result") {
            await this.persistProvider(queryTerm, event.result, capturedAt);
            currentQueryResults.set(event.result.provider, event.result);
            upsertReceipt(queryTerm, { capturedAt, results: [...currentQueryResults.values()] });
            accumulatedReceipt = this.includeRecoveredCards(mergeLiveBatchSearchReceipts(receipts, queryTerms, failedTerms, failedTermDetails));
          }
          const query = {
            keyword: this.keyword,
            ...(this.region ? { region: this.region } : {}),
            ...(this.chinaSelection?.districtCode ? { districtCode: this.chinaSelection.districtCode } : {}),
          };
          try {
            this.onLiveProgressCallback?.(event, accumulatedReceipt, query);
          } catch (error) {
            console.error("[pipeline] onLiveProgress callback error:", error);
          }
          if (event.type === "provider-progress" && event.cards?.length && this.commitQueue) {
            await this.commitQueue.enqueue({ provider: event.provider, platform: event.platform, cards: event.cards, capturedAt, cardLimit: event.cardLimit });
          }
        };
        const receipt = await runLivePlatformBatchSearch(
          {
            keyword: queryTerm,
            ...(this.checkpoint ? { providers: [...providers] } : {}),
            ...(this.region ? { regionId: this.region } : {}),
            ...(this.chinaSelection?.districtCode ? { districtCode: this.chinaSelection.districtCode } : {}),
            depth: this.depth ?? "standard",
            maxPages: this.maxPages ?? (this.depth === "deep" ? 50 : this.depth === "standard" ? 20 : 5),
          },
          this.signal,
          this.onLiveProgressCallback ? { onEvent: publishStreamProgress } : undefined,
        );
        for (const result of receipt.results) {
          await this.persistProvider(queryTerm, result, receipt.capturedAt);
          currentQueryResults.set(result.provider, result);
        }
        upsertReceipt(queryTerm, { capturedAt: receipt.capturedAt, results: [...currentQueryResults.values()] });
        completedTerms.add(queryTerm);
        if (this.checkpoint && providers.some(provider => !this.providerReadComplete(currentQueryResults.get(provider)))) this.harvestHasErrors = true;
        // Publish completed keyword captures immediately. Later synonym reads
        // can take minutes; their wait must not hide cards already captured.
        this.batchReceipt = this.includeRecoveredCards(mergeLiveBatchSearchReceipts(receipts, queryTerms, failedTerms, failedTermDetails));
        this.publishLiveResults();
        const cardsFetched = this.batchReceipt.results.reduce((total, result) => total + result.cards.length, 0);
        this.emit(
          "platform-harvest",
          2,
          `技术词 ${index + 1}/${queryTermTotal} 已完成：${queryTerm}`,
          queryTermStats(index + 1, queryTerm, "completed", { cardsFetched }),
        );
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (error instanceof HarvestCheckpointError) throw error;
        this.harvestHasErrors = true;
        failedTerms.push(queryTerm);
        const errorMessage = (error instanceof Error ? error.message : "实时读取失败，未返回明确错误信息。").slice(0, 1_000);
        failedTermDetails.push({ term: queryTerm, error: errorMessage });

        // Do not wait for all synonym searches before exposing the cards and
        // failure reason already known. The merged receipt carries the
        // warning for providers with cards; the progress stats carry it even
        // when this was the first/all failed query and no provider exists yet.
        this.batchReceipt = this.includeRecoveredCards(mergeLiveBatchSearchReceipts(receipts, queryTerms, failedTerms, failedTermDetails));
        this.publishLiveResults();
        const cardsFetched = this.batchReceipt.results.reduce((total, result) => total + result.cards.length, 0);
        this.emit(
          "platform-harvest",
          2,
          `技术词 ${index + 1}/${queryTermTotal} 读取失败：${queryTerm}`,
          queryTermStats(index + 1, queryTerm, "failed", { cardsFetched, queryTermError: errorMessage }),
        );
      }
    }
    if (receipts.length === 0) {
      const failedMessage = failedTermDetails.map(({ term, error }) => `${term}：${error}`).join("；");
      this.emit(
        "platform-harvest",
        2,
        `实时技术词检索全部失败${failedMessage ? `：${failedMessage}` : "。"}`,
        queryTermStats(queryTermTotal, queryTerms.at(-1) ?? "", this.signal?.aborted ? "cancelled" : "failed", {
          ...(failedMessage ? { queryTermError: failedMessage } : {}),
        }),
      );
      throw new Error(failedTerms.length > 0
        ? `实时技术词检索全部失败：${failedMessage}`
        : "实时技术词检索未返回结果。");
    }
    this.batchReceipt = this.includeRecoveredCards(mergeLiveBatchSearchReceipts(receipts, queryTerms, failedTerms, failedTermDetails));
    console.log(`[pipeline] Stage 2 HarvestLivePlatforms took ${Date.now() - t0}ms`);
    this.publishLiveResults();

    const readyProviders = (this.batchReceipt?.results ?? []).filter(
      (r) => r.status === "ready" && r.cards.length > 0,
    );
    const totalFound = readyProviders.reduce((acc, r) => acc + r.cards.length, 0);
    const providerResults = this.batchReceipt?.results ?? [];
    const coverageMessage = providerResults.map((r) =>
      `${r.platform} ${r.cards.length}岗 / ${r.coverage.pagesVisited}页${r.coverage.scrollSteps ? `·滚${r.coverage.scrollSteps}步` : ""} / ${r.coverage.stopReason}${r.coverage.partial ? "(部分)" : ""}`,
    ).join("；");
    const failedPlatforms = providerResults.filter((result) => result.status === "error" || result.coverage.stopReason === "error").length;
    const blockedPlatforms = providerResults.filter((result) => result.status === "login_required" || result.status === "verification_required").length;
    const partialPlatforms = providerResults.filter((result) => result.coverage.partial).length;
    const coverageOutcome = failedPlatforms > 0 || blockedPlatforms > 0 || partialPlatforms > 0
      ? `本轮平台读取已结束（部分覆盖：${failedPlatforms} 个失败、${blockedPlatforms} 个需登录/验证、${partialPlatforms} 个有预算或分页限制）`
      : "本轮平台读取已结束";

    this.emit("platform-harvest", 2, `${coverageOutcome}：${queryTermTotal} 个检索词已处理；${readyProviders.length} 个平台返回 ${totalFound} 张岗位卡片。${coverageMessage}`, {
      platforms: readyProviders.map((r) => `${r.platform}(${r.cards.length})`).join(", "),
      totalCards: totalFound,
      failedPlatforms,
      blockedPlatforms,
      partialPlatforms,
      ...queryTermStats(
        queryTermTotal,
        queryTerms.at(-1) ?? "",
        this.signal?.aborted ? "cancelled" : "completed",
        { cardsFetched: totalFound },
      ),
    });
    return this;
  }

  /**
   * Stage 3: CAS Chunked Ingestion & Deduplicated Commit
   */
  async stage3_CommitReviewedCards(): Promise<this> {
    if (!this.batchReceipt) throw new Error("Harvest results not available.");
    this.commitQueue ??= this.createCommitQueue();
    for (const result of this.batchReceipt.results) await this.enqueueResult(result, this.batchReceipt.capturedAt);
    const committed = await this.commitQueue.finish();
    this.currentSnapshot = committed.snapshot ?? this.currentSnapshot;
    this.importFailures = committed.failures;
    this.touchedJobIds = new Set(committed.touchedJobIds);
    this.committedAdded = committed.stats.totalAdded;
    this.committedUpdated = committed.stats.totalUpdated;
    this.emit("cas-ingestion", 3, `流式提交已排空：新增 ${this.committedAdded} 岗，更新 ${this.committedUpdated} 岗。`, {
      ...committed.stats,
      ...(this.currentSnapshot ? { revision: this.currentSnapshot.revision } : {}),
    });
    return this;
  }

  /**
   * Stage 4 & 5: Source Area Alignment, Company Classification & Location Status
   */
  async stage4_and_5_EnrichAndGeocode(): Promise<LivePlatformImportSummary> {
    if (!this.currentSnapshot) {
      this.currentSnapshot = await this.client.snapshot({ signal: this.signal });
    }

    const readyProviders = (this.batchReceipt?.results ?? []).filter(
      (r) => r.status === "ready" && r.cards.length > 0,
    );
    const platformCoverage = (this.batchReceipt?.results ?? []).map((result) => ({
      provider: result.provider, platform: result.platform, status: result.status,
      cardsCollected: result.cards.length, coverage: result.coverage,
      ...(result.error ? { error: result.error } : {}),
    }));
    const importedPlatforms = readyProviders.map(
      (r) => `${r.platform}(${r.cards.length}岗)`,
    );

    // Fast-path: If no new or updated jobs were touched, skip redundant full-dataset enrichment
    if (!this.enrichAfterCommit || this.touchedJobIds.size === 0) {
      this.summary = {
        snapshot: this.currentSnapshot,
        importedPlatforms,
        importFailures: this.importFailures,
        loginRequiredPlatforms: (this.batchReceipt?.results ?? [])
          .filter((r) => r.status === "login_required")
          .map((r) => r.platform),
        verificationRequiredPlatforms: (this.batchReceipt?.results ?? [])
          .filter((r) => r.status === "verification_required")
          .map((r) => r.platform),
        totalCardsFetched: readyProviders.reduce((acc, r) => acc + r.cards.length, 0),
        totalAdded: this.committedAdded,
        totalUpdated: this.committedUpdated,
        locationsConfirmed: 0,
        officeAddressesConfirmed: 0,
        companiesClassified: 0,
        platformCoverage,
      };
      this.emit("completed", 5, `本轮实时卡片处理完成：新增 ${this.committedAdded} 岗，更新 ${this.committedUpdated} 岗${this.importFailures.length ? `，${this.importFailures.length} 个证据块未能入库` : ""}；本轮未生成办公坐标${this.enrichAfterCommit ? "。" : "；企业与地区信息可另行补全。"}`,
        this.enrichAfterCommit ? undefined : { enrichmentSkipped: 1 });
      return this.summary;
    }

    this.emit("enterprise-intelligence", 4, `正在按来源原文对齐行政地区，并生成关联企业的自动分类...`);
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
      } catch { /* A view observer cannot invalidate an enrichment receipt. */ }
    }

    this.emit("spatial-geocoding", 5, `行政地区处理完成；办公坐标仍以来源披露或本人核对为准，本轮不推断办公点。`, {
      officesConfirmed: enriched.officeAddressesConfirmed,
      companiesClassified: enriched.companiesClassified,
    });

    this.summary = {
      snapshot: enriched.snapshot,
      importedPlatforms,
      importFailures: this.importFailures,
      loginRequiredPlatforms: (this.batchReceipt?.results ?? [])
        .filter((r) => r.status === "login_required")
        .map((r) => r.platform),
      verificationRequiredPlatforms: (this.batchReceipt?.results ?? [])
        .filter((r) => r.status === "verification_required")
        .map((r) => r.platform),
      totalCardsFetched: readyProviders.reduce((acc, r) => acc + r.cards.length, 0),
      totalAdded: this.committedAdded,
      totalUpdated: this.committedUpdated,
      locationsConfirmed: enriched.locationsConfirmed,
      officeAddressesConfirmed: enriched.officeAddressesConfirmed,
      companiesClassified: enriched.companiesClassified,
      platformCoverage,
    };

    this.emit("completed", 5, `本轮处理完成：新增 ${this.committedAdded} 岗，更新 ${this.committedUpdated} 岗；对齐 ${enriched.locationsConfirmed} 个行政地区、自动分类 ${enriched.companiesClassified} 家企业，本轮未生成办公坐标。`);
    return this.summary;
  }

  /**
   * Harvest and commit concurrently, drain, then optionally enrich.
   */
  async execute(): Promise<LivePlatformImportSummary> {
    this.commitQueue ??= this.createCommitQueue();
    try {
      await this.initializeCheckpoint();
      if (!this.domainSynonyms.length) this.stage1_ExpandIntent();
      await this.stage2_HarvestLivePlatforms();
      await this.stage3_CommitReviewedCards();
      const summary = await this.stage4_and_5_EnrichAndGeocode();
      this.signal?.throwIfAborted();
      if (this.checkpoint) await this.persistCheckpoint(() => this.checkpoint!.settle(this.harvestHasErrors || this.importFailures.length ? "needs-attention" : "completed"));
      return summary;
    } catch (error) {
      // Accepted SSE batches may already be writing even when a later stream
      // disconnects. Settle that one writer before releasing this run; cancelled
      // queues skip pending batches and never create orphaned rejections.
      try { await this.commitQueue.finish(); } catch { /* preserve the originating failure */ }
      if (this.checkpoint && !this.callerSignal?.aborted) {
        try { await this.persistCheckpoint(() => this.checkpoint!.settle("needs-attention")); }
        catch (checkpointError) { throw new AggregateError([error, checkpointError], `采集未完成，且恢复检查点无法更新：${checkpointError instanceof Error ? checkpointError.message : "持久化失败"}`, { cause: checkpointError }); }
      }
      throw error;
    }
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
