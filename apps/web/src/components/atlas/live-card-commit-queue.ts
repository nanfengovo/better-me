import type { AtlasDataset } from "@better-me/opportunities";
import { reviewedCardIdentity } from "@better-me/source-adapters/browser-contracts";
import type { LiveBatchProviderResultClient } from "../../lib/platform-search-client";
import { groupLiveCardsForReviewedImport } from "./live-platform-import-utils";
import type { LivePlatformImportSummary } from "./live-platform-auto-import";
import type { createAtlasSourceClient } from "./service-client";
import type { HarvestBatchCheckpoint, HarvestCheckpoint, HarvestImportReceipt, HarvestPreparedImport } from "./harvest-checkpoint";

type Client = ReturnType<typeof createAtlasSourceClient>;
type Provider = LiveBatchProviderResultClient["provider"];
type Card = LiveBatchProviderResultClient["cards"][number];
type Batch = HarvestBatchCheckpoint & { bytes: number; released?: boolean };

export class HarvestCheckpointError extends Error {
  constructor(error: unknown) {
    super(`采集检查点保存失败，已停止后续提交，请恢复后重试：${error instanceof Error ? error.message : "本地持久化不可用"}`, { cause: error });
    this.name = "HarvestCheckpointError";
  }
}

export type LiveCommitStats = {
  totalAdded: number;
  totalUpdated: number;
  totalUnchanged: number;
  committedCards: number;
  /** No confirmed success receipt; transport ambiguity does not prove absence in storage. */
  failedCards: number;
  /** Accepted cards cancelled without a confirmed receipt, including admission waiters. */
  cancelledCards: number;
  pendingBatches: number;
  pendingCards: number;
};

export type LiveCardCommitResult = {
  snapshot?: AtlasDataset;
  stats: LiveCommitStats;
  touchedJobIds: ReadonlySet<string>;
  failures: LivePlatformImportSummary["importFailures"];
};

/**
 * A run-local, bounded single writer. enqueue waits for capacity, not for the
 * import itself. finish drains accepted batches and verifies the final snapshot.
 * An optional checkpoint owns durable evidence/command/receipt transitions;
 * the queue owns bounded scheduling and never invents a new ambiguous command.
 */
export class LiveCardCommitQueue {
  private readonly queue: Batch[] = [];
  private readonly seen = new Set<string>();
  private readonly restored = new Set<string>();
  private readonly providerCounts = new Map<Provider, number>();
  private readonly touched = new Set<string>();
  private readonly failures: LivePlatformImportSummary["importFailures"] = [];
  private readonly waiters = new Set<() => void>();
  private worker?: Promise<void>;
  private pendingBytes = 0;
  private snapshot?: AtlasDataset;
  private snapshotRead?: Promise<AtlasDataset>;
  private publication?: Promise<void>;
  private revision = 0;
  private lastSnapshotAt = 0;
  private published = false;
  private publishedRevision = -1;
  private snapshotAttempted = false;
  private checkpointFailure?: HarvestCheckpointError;
  private finishPromise?: Promise<LiveCardCommitResult>;
  private readonly counts: LiveCommitStats = { totalAdded: 0, totalUpdated: 0, totalUnchanged: 0, committedCards: 0, failedCards: 0, cancelledCards: 0, pendingBatches: 0, pendingCards: 0 };

  constructor(private readonly options: {
    client: Client;
    checkpoint?: HarvestCheckpoint;
    onCheckpointFailure?: (error: HarvestCheckpointError) => void;
    signal?: AbortSignal;
    onStats?: (stats: LiveCommitStats) => void;
    onSnapshot?: (snapshot: AtlasDataset, stats: LiveCommitStats) => void;
    maxPendingBatches?: number;
    maxPendingBytes?: number;
    snapshotIntervalMs?: number;
    now?: () => number;
  }) {
    if (!Number.isInteger(options.maxPendingBatches ?? 8) || (options.maxPendingBatches ?? 8) < 1
      || !Number.isFinite(options.maxPendingBytes ?? 8 * 1024 * 1024) || (options.maxPendingBytes ?? 8 * 1024 * 1024) < 1) {
      throw new Error("Commit queue capacity must be positive.");
    }
  }

  private stats(): LiveCommitStats { return { ...this.counts }; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private notify(): void {
    try { this.options.onStats?.(this.stats()); } catch { /* Observers cannot change commit ownership. */ }
  }
  private wake(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private checkCancelled(): void { this.options.signal?.throwIfAborted(); }

  assertHealthy(): void {
    this.checkCancelled();
    if (this.checkpointFailure) throw this.checkpointFailure;
  }

  stopAfterCheckpointFailure(error: unknown): HarvestCheckpointError {
    if (!this.checkpointFailure) {
      this.checkpointFailure = error instanceof HarvestCheckpointError ? error : new HarvestCheckpointError(error);
      try { this.options.onCheckpointFailure?.(this.checkpointFailure); } catch { /* The durability failure remains authoritative. */ }
    }
    this.wake();
    return this.checkpointFailure;
  }

  private async persist(operation: () => Promise<void>): Promise<void> {
    this.assertHealthy();
    try { await operation(); }
    catch (error) { throw this.stopAfterCheckpointFailure(error); }
  }

  private identity(provider: Provider, card: Card): string {
    return `${provider}\0${reviewedCardIdentity(card.url, provider)?.id ?? card.url}`;
  }

  private accountReceipt(batch: HarvestBatchCheckpoint, receipt: HarvestImportReceipt): void {
    this.revision = Math.max(this.revision, receipt.revision);
    this.counts.totalAdded += receipt.counts.newJobs;
    this.counts.totalUpdated += receipt.counts.updatedJobs;
    this.counts.totalUnchanged += receipt.counts.unchangedJobs ?? 0;
    this.counts.committedCards += batch.cards.length;
    for (const id of receipt.jobIds) this.touched.add(id);
  }

  /** Seed all identities before admitting unconfirmed commands into the writer. */
  async restore(batches: readonly HarvestBatchCheckpoint[]): Promise<void> {
    this.assertHealthy();
    const pending: HarvestBatchCheckpoint[] = [];
    for (const batch of batches) {
      if (this.restored.has(batch.id)) continue;
      this.restored.add(batch.id);
      for (const card of batch.cards) {
        const identity = this.identity(batch.provider, card);
        if (this.seen.has(identity)) continue;
        this.seen.add(identity);
        this.providerCounts.set(batch.provider, (this.providerCounts.get(batch.provider) ?? 0) + 1);
      }
      if (batch.receipt) this.accountReceipt(batch, batch.receipt);
      else pending.push(batch);
    }
    this.notify();
    for (const batch of pending) await this.admit(batch);
    if (this.counts.committedCards) this.requestPublication();
  }

  private async admit(batch: HarvestBatchCheckpoint): Promise<void> {
    this.assertHealthy();
    const bytes = new TextEncoder().encode(JSON.stringify({ pageUrl: batch.pageUrl, cards: batch.cards })).byteLength;
    if (bytes > (this.options.maxPendingBytes ?? 8 * 1024 * 1024)) {
      this.recordFailure(batch.platform, batch.pageUrl, batch.cards.length, new Error("岗位证据批次超过提交队列字节上限，未入库。"));
      return;
    }
    await this.reserveCapacity(bytes, batch.cards.length);
    this.queue.push({ ...batch, bytes });
    this.notify();
    this.startWorker();
  }

  private release(batch: Batch): void {
    if (batch.released) return;
    batch.released = true;
    this.counts.pendingBatches--;
    this.counts.pendingCards -= batch.cards.length;
    this.pendingBytes -= batch.bytes;
    this.wake();
  }

  private async reserveCapacity(bytes: number, cards: number): Promise<void> {
    while (this.counts.pendingBatches >= (this.options.maxPendingBatches ?? 8)
      || this.pendingBytes + bytes > (this.options.maxPendingBytes ?? 8 * 1024 * 1024)) {
      this.assertHealthy();
      await new Promise<void>((resolve) => {
        const wake = () => { this.waiters.delete(wake); this.options.signal?.removeEventListener("abort", wake); resolve(); };
        this.waiters.add(wake);
        this.options.signal?.addEventListener("abort", wake, { once: true });
        if (this.options.signal?.aborted) wake();
      });
    }
    this.assertHealthy();
    // Reserve in the same turn as the capacity check. Multiple producers may
    // otherwise all observe the same slot before their await continuations run.
    this.pendingBytes += bytes;
    this.counts.pendingBatches++;
    this.counts.pendingCards += cards;
  }

  async enqueue(input: { provider: Provider; platform: LiveBatchProviderResultClient["platform"]; cards: readonly Card[]; capturedAt: string; cardLimit: number }): Promise<void> {
    this.assertHealthy();
    const fresh: Card[] = [];
    let count = this.providerCounts.get(input.provider) ?? 0;
    for (const card of input.cards) {
      const key = this.identity(input.provider, card);
      if (this.seen.has(key) || count >= input.cardLimit) continue;
      this.seen.add(key);
      count++;
      fresh.push(card);
    }
    this.providerCounts.set(input.provider, count);
    if (!fresh.length) return;
    let chunks: ReturnType<typeof groupLiveCardsForReviewedImport<Card>>;
    try { chunks = groupLiveCardsForReviewedImport(fresh, input.provider); }
    catch (error) {
      this.recordFailure(input.platform, fresh[0]?.evidence.pageUrl ?? "", fresh.length, error);
      return;
    }
    let index = 0;
    try {
      for (; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        this.assertHealthy();
        const batch: HarvestBatchCheckpoint = { ...chunk, id: `batch-${crypto.randomUUID()}`, provider: input.provider, platform: input.platform, capturedAt: input.capturedAt };
        // Capture the canonical evidence before capacity waiting or any HTTP.
        if (this.options.checkpoint) await this.persist(() => this.options.checkpoint!.capture(batch));
        await this.admit(batch);
      }
    } catch (error) {
      if (this.options.signal?.aborted && !this.checkpointFailure) {
        this.counts.cancelledCards += chunks.slice(index).reduce((sum, chunk) => sum + chunk.cards.length, 0);
        this.notify();
      }
      throw error;
    }
  }

  private recordFailure(platform: Batch["platform"], pageUrl: string, cards: number, error: unknown): void {
    this.failures.push({ platform, pageUrl, cards, error: error instanceof Error ? error.message : "岗位卡片入库失败" });
    this.counts.failedCards += cards;
    this.notify();
  }

  private startWorker(): void {
    if (this.worker) return;
    // consume handles each failure locally; attach its finalizer immediately so
    // an aborted producer never leaves an unobserved rejection in the writer.
    this.worker = this.consume().finally(() => {
      this.worker = undefined;
      this.wake();
      if (this.queue.length) this.startWorker();
    });
  }

  private async readSnapshot(minimumRevision = this.revision): Promise<AtlasDataset> {
    this.assertHealthy();
    // CAS recovery and UI publication share a read. An older in-flight read may
    // need one fresh follow-up for CAS, but concurrent full downloads never fan out.
    for (let attempt = 0; attempt < 2; attempt++) {
      const shared = Boolean(this.snapshotRead);
      if (!this.snapshotRead) {
        const read = this.options.client.snapshot({ signal: this.options.signal }).then(snapshot => {
          if (!this.snapshot || snapshot.revision >= this.snapshot.revision) this.snapshot = snapshot;
          // A publication begun before the next commit must never roll back CAS.
          this.revision = Math.max(this.revision, snapshot.revision);
          return snapshot;
        }).finally(() => { if (this.snapshotRead === read) this.snapshotRead = undefined; });
        this.snapshotRead = read;
      }
      const snapshot = await this.snapshotRead;
      if (snapshot.revision >= minimumRevision) return snapshot;
      if (!shared || attempt === 1) throw new Error(`快照版本 ${snapshot.revision} 落后于提交版本 ${minimumRevision}。`);
    }
    throw new Error("未取得包含已提交岗位的快照。");
  }

  private async publishSnapshot(minimumRevision = this.revision, stats = this.stats()): Promise<void> {
    const snapshot = await this.readSnapshot(minimumRevision);
    this.lastSnapshotAt = this.now();
    this.published = true;
    this.publishedRevision = snapshot.revision;
    // Capture counters at request start: later receipts may not be in this view.
    try { this.options.onSnapshot?.(snapshot, stats); } catch { /* Keep a committed receipt authoritative. */ }
  }

  private requestPublication(): void {
    if (this.publication || this.options.signal?.aborted || this.checkpointFailure) return;
    if (this.snapshotAttempted && this.now() - this.lastSnapshotAt < (this.options.snapshotIntervalMs ?? 1_500)) return;
    this.snapshotAttempted = true;
    this.lastSnapshotAt = this.now();
    this.publication = this.publishSnapshot().catch(() => {
      // The final drain retries once and requires a current authoritative view.
    }).finally(() => { this.publication = undefined; });
  }

  private async commit(batch: Batch): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertHealthy();
      try {
        if (!batch.command) {
          if (!this.snapshot) await this.readSnapshot();
          this.assertHealthy();
          const input = { provider: batch.provider, pageUrl: batch.pageUrl, capturedAt: batch.capturedAt, cards: batch.cards, expectedRevision: this.revision };
          const preview = await this.options.client.previewReviewedCards(input, { signal: this.options.signal });
          this.assertHealthy();
          const command: HarvestPreparedImport = { input: { ...input, expectedRevision: preview.expectedRevision,
            previewFingerprint: preview.previewFingerprint, reviewed: true }, idempotencyKey: `pipeline-${crypto.randomUUID()}` };
          if (this.options.checkpoint) await this.persist(() => this.options.checkpoint!.prepare(batch.id, command));
          batch.command = command;
        }
        this.assertHealthy();
        // Only a definitive stale-version rejection can reach a new preview/key.
        // A recovered ambiguous command first uses its exact persisted body/key.
        const receipt = await this.options.client.importReviewedCards(batch.command.input,
          { signal: this.options.signal, idempotencyKey: batch.command.idempotencyKey });
        if (this.options.checkpoint) {
          // Even an abort after a successful HTTP response should durably save
          // that receipt; abort does not make an already committed write vanish.
          try { await this.options.checkpoint.confirm(batch.id, receipt); }
          catch (error) { throw this.stopAfterCheckpointFailure(error); }
        }
        this.accountReceipt(batch, receipt);
        this.release(batch);
        this.notify();
        // Immediate first paint; later writes publish coalesced snapshots rather
        // than making every tiny evidence block download and parse the full DB.
        this.requestPublication();
        return;
      } catch (error) {
        this.assertHealthy();
        const stale = error !== null && typeof error === "object" && "code" in error && error.code === "stale-version";
        if (!stale || attempt === 2) throw error;
        batch.command = undefined;
        await this.readSnapshot();
      }
    }
  }

  private async consume(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.shift()!;
      try {
        this.assertHealthy();
        await this.commit(batch);
      } catch (error) {
        if (this.options.signal?.aborted && !this.checkpointFailure) {
          if (!batch.released) this.counts.cancelledCards += batch.cards.length;
        } else this.recordFailure(batch.platform, batch.pageUrl, batch.cards.length, error);
      } finally {
        this.release(batch);
        this.notify();
        this.wake();
      }
    }
  }

  /** Waits for in-flight work even on cancellation; no new batch starts then. */
  finish(): Promise<LiveCardCommitResult> {
    return this.finishPromise ??= this.drain();
  }

  private async drain(): Promise<LiveCardCommitResult> {
    while (this.worker) await this.worker;
    await this.publication;
    this.assertHealthy();
    if (this.snapshot && (!this.published || this.publishedRevision < this.revision)) {
      // One bounded retry recovers a transient post-commit read without ever
      // replaying the already committed batch or enriching a stale snapshot.
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await this.publishSnapshot(); break; }
        catch (error) {
          this.checkCancelled();
          if (attempt === 1) throw new Error(`岗位已提交，但索引快照刷新失败（新增 ${this.counts.totalAdded} 岗、更新 ${this.counts.totalUpdated} 岗）：${error instanceof Error ? error.message : "未取得最新索引"}`, { cause: error });
        }
      }
    }
    return { snapshot: this.snapshot, stats: this.stats(), touchedJobIds: this.touched, failures: [...this.failures] };
  }
}
