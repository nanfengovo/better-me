import { z } from "zod";
import type { HarvestBatchCheckpoint, HarvestCapturedBatch, HarvestCheckpoint, HarvestCheckpointSnapshot, HarvestJournal, HarvestPreparedImport, HarvestRunRecord } from "./harvest-checkpoint";
import {
  JournalBatchRowSchema, JournalCapturedBatchSchema, JournalCommandSchema, JournalProviderCheckpointSchema, JournalProviderRowSchema,
  JournalReceiptSchema, JournalRunInputSchema, JournalRunRowSchema, JournalScopeSchema,
} from "./harvest-journal-schema";

// Internal storage seam: the browser implementation waits for IDB oncomplete;
// isolated tests use an atomic memory adapter, not a second domain implementation.
export type JournalTable = "runs" | "batches" | "providers";
export type JournalTransaction = {
  get(table: JournalTable, id: string): Promise<unknown>;
  list(table: JournalTable, filter?: { index: "scope" | "runId"; value: string }): Promise<unknown[]>;
  put(table: JournalTable, row: { id: string }): Promise<void>;
  delete(table: JournalTable, id: string): Promise<void>;
};
export type JournalStorage = { transaction<T>(mode: "readonly" | "readwrite", work: (tx: JournalTransaction) => Promise<T>): Promise<T>; close(): void };
export class HarvestJournalError extends Error {
  constructor(readonly code: "closed" | "corrupt" | "conflict" | "limit" | "storage" | "unsupported", message: string) { super(message); this.name = "HarvestJournalError"; }
}
type RunRow = z.infer<typeof JournalRunRowSchema>;
type Limits = { runBytes?: number; totalBytes?: number; terminalRuns?: number };
const corrupt = () => new HarvestJournalError("corrupt", "采集恢复记录损坏或版本不受支持，未开始网络操作；请保留记录并检查应用版本。");
const conflict = (message: string) => new HarvestJournalError("conflict", message);
function parsed<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw corrupt();
  return result.data;
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const updatedAt = (run: HarvestRunRecord) => new Date(Math.max(Date.now(), Date.parse(run.updatedAt))).toISOString();
const batchKey = (runId: string, id: string) => JSON.stringify([runId, id]);
const providerKey = (runId: string, term: string, provider: string) => JSON.stringify([runId, term, provider]);
function evidence(batch: HarvestCapturedBatch) { return { provider: batch.provider, pageUrl: batch.pageUrl, capturedAt: batch.capturedAt, cards: batch.cards }; }
function matchingCommand(batch: HarvestCapturedBatch, command: HarvestPreparedImport) {
  const { expectedRevision: _revision, previewFingerprint: _fingerprint, reviewed: _reviewed, ...capture } = command.input;
  return same(evidence(batch), capture);
}
function terminalProvider(checkpoint: z.infer<typeof JournalProviderCheckpointSchema>) {
  const { status, coverage } = checkpoint.result;
  return status === "ready" && ["exhausted", "page_limit", "scroll_limit", "card_limit"].includes(coverage.stopReason)
    || status === "empty" && coverage.stopReason === "exhausted" && !coverage.partial;
}

export function createHarvestJournalAdapter(storage: JournalStorage, scope: string, limits: Limits = {}): HarvestJournal {
  parsed(JournalScopeSchema, scope);
  const runLimit = limits.runBytes ?? 64 * 1024 * 1024;
  const totalLimit = limits.totalBytes ?? 256 * 1024 * 1024;
  const terminalLimit = limits.terminalRuns ?? 3;
  let closed = false;
  function transaction<T>(mode: "readonly" | "readwrite", work: (tx: JournalTransaction) => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new HarvestJournalError("closed", "采集记录已关闭，请重新连接后再恢复。"));
    return storage.transaction(mode, work).catch((error: unknown) => {
      if (error instanceof HarvestJournalError) throw error;
      throw new HarvestJournalError("storage", "采集记录未能保存到浏览器，操作没有确认；请检查存储空间后重试。未保存的批次不会发送入库。");
    });
  }
  async function loadRun(tx: JournalTransaction, id: string, running = false) {
    const row = parsed(JournalRunRowSchema, await tx.get("runs", id));
    if (row.scope !== scope) throw corrupt();
    if (running && row.record.state !== "running") throw conflict("该轮采集已结束或已被新任务替代，不能继续写入。 ");
    return row;
  }
  function loadBatch(value: unknown, runId: string) {
    const row = parsed(JournalBatchRowSchema, value);
    const { command, receipt, ...capture } = row.data;
    parsed(JournalCapturedBatchSchema, capture);
    if (row.runId !== runId || row.id !== batchKey(runId, row.data.id) || row.bytes !== bytes(row.data)
      || (command && !matchingCommand(row.data, command)) || (receipt && !command)) throw corrupt();
    return row;
  }
  function loadProvider(value: unknown, runId: string) {
    const row = parsed(JournalProviderRowSchema, value);
    if (row.runId !== runId || row.id !== providerKey(runId, row.data.term, row.data.result.provider) || row.bytes !== bytes(row.data)) throw corrupt();
    return row;
  }
  async function snapshot(tx: JournalTransaction, row: RunRow): Promise<HarvestCheckpointSnapshot> {
    const batches = (await tx.list("batches", { index: "runId", value: row.id })).map(value => loadBatch(value, row.id));
    const providers = (await tx.list("providers", { index: "runId", value: row.id })).map(value => loadProvider(value, row.id));
    if (row.bytes !== bytes(row.record) + batches.reduce((sum, value) => sum + value.bytes, 0) + providers.reduce((sum, value) => sum + value.bytes, 0)
      || row.bytes > runLimit || batches.some(batch => !row.record.providers?.includes(batch.data.provider))
      || providers.some(provider => !row.record.queryTerms?.includes(provider.data.term) || !row.record.providers?.includes(provider.data.result.provider))) throw corrupt();
    return { run: row.record, batches: batches.map(row => row.data), providers: providers.map(row => row.data) };
  }
  async function saveRun(tx: JournalTransaction, previous: RunRow, record: HarvestRunRecord, delta = 0) {
    const row: RunRow = { ...previous, record, bytes: previous.bytes - bytes(previous.record) + bytes(record) + delta };
    const others = (await tx.list("runs")).map(value => parsed(JournalRunRowSchema, value)).filter(value => value.id !== row.id);
    if (row.bytes > runLimit || row.bytes + others.reduce((sum, value) => sum + value.bytes, 0) > totalLimit) {
      throw new HarvestJournalError("limit", "采集恢复记录已达到存储预算，未保存的新批次不会发送入库；已有待确认记录仍保留。 ");
    }
    await tx.put("runs", row);
  }
  async function updateBatch(tx: JournalTransaction, run: RunRow, data: HarvestBatchCheckpoint, previousBytes = 0) {
    const row = { id: batchKey(run.id, data.id), runId: run.id, bytes: bytes(data), data };
    await saveRun(tx, run, { ...run.record, updatedAt: updatedAt(run.record) }, row.bytes - previousBytes);
    await tx.put("batches", row);
  }
  function checkpoint(id: string): HarvestCheckpoint {
    return {
      id,
      read: () => transaction("readonly", async tx => snapshot(tx, await loadRun(tx, id))),
      resume: () => transaction("readwrite", async tx => {
        const run = await loadRun(tx, id);
        if (!["running", "needs-attention", "cancelled"].includes(run.record.state)) throw conflict("已完成或已被替代的采集不能继续。");
        const others = (await tx.list("runs", { index: "scope", value: scope })).map(value => parsed(JournalRunRowSchema, value));
        if (others.some(row => row.id !== id && row.record.state === "running")) throw conflict("同一连接已有另一轮采集正在执行，不能同时继续旧任务。");
        await snapshot(tx, run);
        if (run.record.state === "running") return;
        await saveRun(tx, run, { ...run.record, state: "running", updatedAt: updatedAt(run.record) });
      }),
      initialize(queryTerms, providers) {
        const plan = { queryTerms: [...queryTerms], providers: [...providers] };
        return transaction("readwrite", async tx => {
          const run = await loadRun(tx, id, true);
          const record = parsed(JournalRunRowSchema, { ...run, record: { ...run.record, ...plan } }).record;
          if (run.record.queryTerms && (!same(run.record.queryTerms, plan.queryTerms) || !same(run.record.providers, plan.providers))) throw conflict("恢复任务的检索词或平台计划与原记录不同，不能继续执行。");
          await saveRun(tx, run, { ...record, updatedAt: updatedAt(run.record) });
        });
      },
      capture(batch) {
        const data = parsed(JournalCapturedBatchSchema, batch);
        return transaction("readwrite", async tx => {
          const run = await loadRun(tx, id, true);
          if (!run.record.providers?.includes(data.provider)) throw conflict("请先冻结本轮检索词与平台计划，再保存采集批次。");
          const found = await tx.get("batches", batchKey(id, data.id));
          if (found !== undefined) {
            const { command: _command, receipt: _receipt, ...previous } = loadBatch(found, id).data;
            if (!same(previous, data)) throw conflict("同一采集批次标识不能覆盖不同来源证据。");
            return;
          }
          await updateBatch(tx, run, data);
        });
      },
      prepare(batchId, command) {
        const next = parsed(JournalCommandSchema, command);
        return transaction("readwrite", async tx => {
          const run = await loadRun(tx, id, true);
          const row = loadBatch(await tx.get("batches", batchKey(id, batchId)), id);
          if (!matchingCommand(row.data, next)) throw conflict("待入库命令与已保存来源证据不一致，未发送入库。");
          if (row.data.receipt) {
            if (!same(row.data.command, next)) throw conflict("已确认入库的命令不能修改。");
            return;
          }
          await updateBatch(tx, run, { ...row.data, command: next }, row.bytes);
        });
      },
      confirm(batchId, receipt) {
        const next = parsed(JournalReceiptSchema, receipt);
        return transaction("readwrite", async tx => {
          // Cancellation stops admission, not an already-sent server commit.
          // Preserve its late receipt without reviving the terminal run state.
          const run = await loadRun(tx, id);
          const row = loadBatch(await tx.get("batches", batchKey(id, batchId)), id);
          if (!row.data.command) throw conflict("尚未保存待发送命令，不能登记入库回执。");
          if (row.data.receipt) {
            if (!same(row.data.receipt, next)) throw conflict("已确认入库的回执不能替换。");
            return;
          }
          await updateBatch(tx, run, { ...row.data, receipt: next }, row.bytes);
        });
      },
      recordProvider(checkpoint) {
        const data = parsed(JournalProviderCheckpointSchema, checkpoint);
        return transaction("readwrite", async tx => {
          const run = await loadRun(tx, id, true);
          if (!run.record.queryTerms?.includes(data.term) || !run.record.providers?.includes(data.result.provider)) throw conflict("平台回执不属于本轮冻结计划。");
          const key = providerKey(id, data.term, data.result.provider);
          const found = await tx.get("providers", key);
          const previous = found === undefined ? undefined : loadProvider(found, id);
          if (previous && terminalProvider(previous.data) && !same(previous.data, data)) throw conflict("已保存的平台终态检查点不能被另一份回执覆盖。");
          const row = { id: key, runId: id, bytes: bytes(data), data };
          await saveRun(tx, run, { ...run.record, updatedAt: updatedAt(run.record) }, row.bytes - (previous?.bytes ?? 0));
          await tx.put("providers", row);
        });
      },
      settle(state) {
        if (!["completed", "needs-attention", "cancelled", "superseded"].includes(state)) return Promise.reject(corrupt());
        return transaction("readwrite", async tx => {
          const run = await loadRun(tx, id);
          if (run.record.state === state) return;
          if (run.record.state !== "running") throw conflict("已经结束的采集不能改写为另一种终态。");
          if (state === "completed" && (await snapshot(tx, run)).batches.some(batch => !batch.receipt)) throw conflict("尚有未确认入库批次，不能将本轮标记为已完成。");
          await saveRun(tx, run, { ...run.record, state, updatedAt: updatedAt(run.record) });
        });
      },
    };
  }
  return {
    scope,
    findResumable: () => transaction("readonly", async tx => {
      const runs = (await tx.list("runs", { index: "scope", value: scope })).map(value => parsed(JournalRunRowSchema, value))
        .filter(row => row.record.state === "running").sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || b.id.localeCompare(a.id));
      const latest = runs[0];
      if (!latest) return undefined;
      await snapshot(tx, latest);
      return checkpoint(latest.id);
    }),
    findRecoverable: () => transaction("readonly", async tx => {
      const latest = (await tx.list("runs", { index: "scope", value: scope })).map(value => parsed(JournalRunRowSchema, value))
        .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || b.id.localeCompare(a.id))[0];
      if (!latest || !["running", "needs-attention", "cancelled"].includes(latest.record.state)) return undefined;
      await snapshot(tx, latest);
      return checkpoint(latest.id);
    }),
    create(input) {
      const value = parsed(JournalRunInputSchema, input);
      return transaction("readwrite", async tx => {
        const existing = (await tx.list("runs", { index: "scope", value: scope })).map(value => parsed(JournalRunRowSchema, value));
        // Browser clocks can have reduced precision. Keep creation ordering
        // unambiguous so a completed newest run never exposes an older retry.
        const now = new Date(Math.max(Date.now(), ...existing.map(row => Date.parse(row.record.createdAt) + 1), ...existing.map(row => Date.parse(row.record.updatedAt)))).toISOString();
        for (const row of existing) {
          if (row.record.state !== "running") continue;
          const record = { ...row.record, state: "superseded" as const, updatedAt: now };
          const updated = { ...row, record, bytes: row.bytes - bytes(row.record) + bytes(record) };
          await tx.put("runs", updated); Object.assign(row, updated);
        }
        const terminal = existing.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt) || b.record.createdAt.localeCompare(a.record.createdAt) || b.id.localeCompare(a.id));
        for (const row of terminal.slice(terminalLimit)) {
          const old = await snapshot(tx, row);
          if (old.batches.some(batch => !batch.receipt)) throw new HarvestJournalError("limit", "旧采集仍有未确认入库证据，无法清理以创建新任务；记录保持不变，请先处理或备份。 ");
          for (const batch of old.batches) await tx.delete("batches", batchKey(row.id, batch.id));
          for (const provider of old.providers) await tx.delete("providers", providerKey(row.id, provider.term, provider.result.provider));
          await tx.delete("runs", row.id);
        }
        const record: HarvestRunRecord = { schemaVersion: 1, id: crypto.randomUUID(), scope, input: value, state: "running", createdAt: now, updatedAt: now };
        await saveRun(tx, { id: record.id, scope, record, bytes: bytes(record) }, record);
        return checkpoint(record.id);
      });
    },
    close() { if (closed) return; closed = true; storage.close(); },
  };
}
