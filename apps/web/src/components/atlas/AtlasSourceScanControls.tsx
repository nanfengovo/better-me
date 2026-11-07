import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AtlasDataset } from "@better-me/opportunities";
import type { SourceScanProgress, SourceSyncResult } from "@better-me/source-adapters/browser-contracts";
import { useUiPreferences } from "../../lib/ui-preferences";
import { AtlasSourceServiceError, createAtlasSourceClient, type AtlasSourceScopeInput } from "./service-client";
import { atlasSourceScanRecoveryScope, readAtlasSourceScanRecovery, useAtlasSourceScanRecovery, writeAtlasSourceScanRecovery, type AtlasSourceScanMode, type AtlasSourceScanWrite } from "./source-scan-recovery";
import { atlasAggregateRecoveryScope, readAtlasAggregateRecovery } from "./aggregate-recovery";

type Props = { endpoint: string; token: string; sourceId: string; canEnumerate: boolean; disabled: boolean;
  mode?: "jobs" | "discovery-leads"; label?: string;
  scopeInput: () => AtlasSourceScopeInput; onSnapshot: (data: AtlasDataset) => void; onRefreshHealth?: (signal: AbortSignal) => Promise<void>;
  onLeadsChanged?: () => void; onBusy: (busy: boolean) => void };
export function AtlasSourceScanControls(props: Props) {
  return <ScanSession key={JSON.stringify([props.endpoint, props.token, props.sourceId, props.mode])} {...props} />;
}
function ScanSession({ endpoint, token, sourceId, canEnumerate, disabled, mode = "jobs", label, scopeInput, onSnapshot, onRefreshHealth, onLeadsChanged, onBusy }: Props) {
  const { t } = useUiPreferences(), scope = atlasSourceScanRecoveryScope(endpoint, token);
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const recovery = useAtlasSourceScanRecovery(endpoint, token);
  const [progress, setProgress] = useState<{ sourceId: string; value: SourceScanProgress | null }>();
  const [receipt, setReceipt] = useState<SourceSyncResult>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const current = useRef<AbortController | null>(null), closed = useRef(false);
  const progressGeneration = useRef(0);
  const latest = useRef({ sourceId, onSnapshot, onRefreshHealth, onLeadsChanged, onBusy }); latest.current = { sourceId, onSnapshot, onRefreshHealth, onLeadsChanged, onBusy };
  const scan = progress?.sourceId === sourceId ? progress.value : undefined;
  const locked = Boolean(recovery.pending || recovery.saved || recovery.refreshOnly);
  useEffect(() => { closed.current = false; return () => { closed.current = true; current.current?.abort(); current.current = null; latest.current.onBusy(false); }; }, []);
  useEffect(() => {
    if (!sourceId || !canEnumerate) return;
    const controller = new AbortController();
    const generation = progressGeneration.current;
    void client.readScanProgress({ sourceId }, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted && !closed.current && progressGeneration.current === generation) setProgress({ sourceId, value: value.progress });
    }).catch(() => { /* Explicit progress read exposes unavailable/older backends. */ });
    return () => controller.abort();
  }, [client, sourceId, canEnumerate]);
  function alive(signal: AbortSignal) { signal.throwIfAborted(); if (closed.current || current.current?.signal !== signal) throw new Error("Scan panel closed."); }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (current.current || closed.current) return;
    progressGeneration.current++;
    const controller = new AbortController(); current.current = controller; setBusy(true); latest.current.onBusy(true); setError(""); setNotice("");
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try { await action(controller.signal); }
    catch (failure) { if (!closed.current && current.current === controller) setError(controller.signal.aborted
      ? mode === "discovery-leads"
        ? t("已停止等待，已采集的线索可能保留。请核对原采集回执。", "Stopped waiting; collected leads may remain. Recover the original collection receipt.")
        : t("已停止等待，已提交的页面可能保留。请核对原扫描回执。", "Stopped waiting; committed pages may remain. Recover the original scan receipt.")
      : failure instanceof Error ? failure.message : t("扫描未完成。", "Scan did not complete.")); }
    finally { clearTimeout(timeout); if (current.current === controller) { current.current = null; setBusy(false); latest.current.onBusy(false); } }
  }
  async function refresh(signal: AbortSignal, target: string, operationMode: AtlasSourceScanMode) {
    // A trusted terminal receipt needs reads only. A failed index read must never
    // issue a second refresh or continue command with a fresh key.
    const snapshot = await client.snapshot({ signal }); alive(signal);
    if (operationMode === "jobs") latest.current.onSnapshot(snapshot);
    let progressUnavailable = false;
    try {
      const next = await client.readScanProgress({ sourceId: target }, { signal }); alive(signal);
      setProgress({ sourceId: target, value: next.progress });
    } catch (failure) {
      // Older services can confirm a normal from-head refresh without exposing
      // resumable scans. The trusted receipt and new index already settled it.
      if (!(failure instanceof AtlasSourceServiceError && failure.status === 404)) throw failure;
      alive(signal); progressUnavailable = true; setProgress({ sourceId: target, value: null });
    }
    await latest.current.onRefreshHealth?.(signal); alive(signal);
    if (operationMode === "discovery-leads") latest.current.onLeadsChanged?.();
    writeAtlasSourceScanRecovery(scope, {});
    setNotice(operationMode === "discovery-leads"
      ? progressUnavailable ? t(`线索采集回执与已保存线索已同步（版本 ${snapshot.revision}），扫描进度接口暂不可用。`, `Lead receipt and saved leads synchronized (revision ${snapshot.revision}); scan progress is unavailable.`)
        : t(`线索采集回执与已保存线索已同步（版本 ${snapshot.revision}）。`, `Lead receipt and saved leads synchronized (revision ${snapshot.revision}).`)
      : progressUnavailable ? t(`回执和索引已同步（版本 ${snapshot.revision}），扫描进度接口暂不可用。`, `Receipt and index synchronized (revision ${snapshot.revision}); scan progress is unavailable.`)
        : t(`扫描回执与索引已同步（版本 ${snapshot.revision}）。`, `Scan receipt and index synchronized (revision ${snapshot.revision}).`));
  }
  async function execute(write: AtlasSourceScanWrite, signal: AbortSignal, operationMode: AtlasSourceScanMode) {
    writeAtlasSourceScanRecovery(scope, { mode: operationMode, pending: write });
    let result;
    try { result = write.kind === "refresh"
      ? await client.sync(write.sourceId, write.input, { signal, idempotencyKey: write.key })
      : await client.continueSync(write.input, { signal, idempotencyKey: write.key }); }
    catch (failure) {
      if (failure instanceof AtlasSourceServiceError && ["invalid-input", "stale-version", "idempotency-conflict", "not-authorized", "conflict", "not-found"].includes(failure.code)) {
        alive(signal); writeAtlasSourceScanRecovery(scope, { mode: operationMode, refreshOnly: write.sourceId });
      }
      throw failure;
    }
    alive(signal);
    if (result.run.status === "running") {
      setNotice(operationMode === "discovery-leads"
        ? t("线索采集仍在执行。可稍后核对同一回执，不会自动启动新批次。", "Lead collection is still running. Recover the same receipt later; no new batch starts automatically.")
        : t("原扫描仍在执行。可稍后核对同一回执，不会自动启动新批次。", "The original scan is still running. Recover the same receipt later; no new batch starts automatically.")); return;
    }
    setReceipt(result); writeAtlasSourceScanRecovery(scope, { mode: operationMode, saved: result });
    await refresh(signal, write.sourceId, operationMode);
  }
  function start(kind: AtlasSourceScanWrite["kind"]) { void run(async signal => {
    const aggregate = readAtlasAggregateRecovery(atlasAggregateRecoveryScope(endpoint, token));
    if (aggregate.active || aggregate.entries.length) return;
    if (readAtlasSourceScanRecovery(scope).pending || readAtlasSourceScanRecovery(scope).saved || readAtlasSourceScanRecovery(scope).refreshOnly) return;
    const options = scopeInput();
    const write: AtlasSourceScanWrite = kind === "refresh" ? { kind, sourceId, input: options, key: `scan-refresh-${crypto.randomUUID()}` }
      : { kind, sourceId, key: `scan-continue-${crypto.randomUUID()}`, input: { sourceId, fromRunId: scan!.runId, expectedProgressVersion: scan!.version, maxRecords: options.maxRecords, maxPages: options.maxPages } };
    await execute(write, signal, mode);
  }); }
  const recover = () => void run(async signal => {
    const saved = readAtlasSourceScanRecovery(scope);
    const operationMode = saved.mode ?? mode;
    if (saved.pending) await execute(saved.pending, signal, operationMode);
    else if (saved.saved || saved.refreshOnly) await refresh(signal, saved.saved?.run.sourceId ?? saved.refreshOnly!, operationMode);
  });
  const scopeText = scan ? [...(scan.scope.roles ?? []), ...(scan.scope.regions ?? []), ...(scan.scope.companyNames ?? []), ...(scan.scope.countryCodes ?? [])].join(" · ") : "";
  const leadsMode = mode === "discovery-leads";
  return <div className="atlas-source-scan" aria-label={label ?? (leadsMode ? t("公司目录线索采集", "Company-directory lead collection") : t("来源扫描进度", "Source scan progress"))} aria-busy={busy}>
    <div className="atlas-sources-actions">
      <button type="button" disabled={disabled || busy || locked || !canEnumerate} onClick={() => start("refresh")}>{leadsMode ? t("采集线索 / 更新已保存线索", "Collect leads / refresh saved leads") : t("手动刷新并更新地图", "Refresh and update map")}</button>
      <button type="button" disabled={disabled || busy || locked || !canEnumerate || !scan?.canContinue} onClick={() => start("continue")}>{leadsMode ? t("继续采集线索", "Continue lead collection") : t("继续上次扫描", "Continue last scan")}</button>
      <button type="button" disabled={disabled || busy || !sourceId} onClick={() => void run(async signal => {
        const value = await client.readScanProgress({ sourceId }, { signal }); alive(signal); setProgress({ sourceId, value: value.progress });
      })}>{leadsMode ? t("读取线索采集进度", "Read lead collection progress") : t("读取扫描进度", "Read scan progress")}</button>
      {busy && <><Loader2 size={15} className="animate-spin" /><button type="button" onClick={() => current.current?.abort()}>{t("停止等待扫描", "Stop waiting for scan")}</button></>}
    </div>
    <p className="atlas-sources-muted">{leadsMode
      ? t("采集从清单开头开始；继续时沿用已保存的线索采集位置和关注条件。只处理本批记录与页数上限，不会把线索加入岗位或地图。", "Collection starts from the beginning of the reviewed list. Continue uses its saved lead position and interests. Each run is bounded and leads remain outside jobs and maps.")
      : t("刷新从头开始；继续扫描继承已保存的关注条件，只使用上方的本批记录与页数上限。修改关键词后请从头刷新，不会自动采集全部页面。", "Refresh starts from the beginning. Continue inherits saved interests and only uses the batch record/page limits above. Refresh for changed interests. Full enumeration never starts automatically.")}</p>
    {scan && <div className="atlas-sources-result"><strong>{leadsMode ? t("已保存线索采集进度", "Saved lead collection") : t("已保存扫描", "Saved scan")}: {scan.state}</strong><p>{leadsMode ? t("原采集条件", "Original collection scope") : t("原关注条件", "Original interests")}: {scopeText || t("未设置条件", "No interests set")}</p>
      <p>{leadsMode ? t("累计尝试条目", "Cumulative attempted entries") : t("累计尝试记录", "Cumulative attempted records")}: {scan.attemptedRecords} · {t("已处理页", "Processed pages")}: {scan.pages} · {scan.updatedAt}</p>
      <p>{scan.state === "exhausted" ? t("来源报告本次清单已到末尾，不代表全网覆盖。", "The source reports the end of this enumeration; this is not whole-market coverage.") : scan.state === "truncated" ? t("当前适配器没有可继续的分页位置，本次仍是部分覆盖。", "No resumable cursor is available; coverage remains partial.") : scan.state === "invalidated" ? `${t("进度已失效，请从头刷新", "Progress invalidated; refresh from the beginning")}: ${scan.invalidatedReason}` : scan.state === "retry-page" ? t("上一页读取不完整，继续时会重读该页并去重。", "The previous page was incomplete. Continue retries that page with deduplication.") : t("仍有待读取记录，可显式继续下一批。", "More records remain. Continue explicitly for the next batch.")}</p>
    </div>}
    {receipt && <div className="atlas-sources-result"><strong>{leadsMode ? t("线索采集回执", "Lead collection receipt") : t("刷新回执", "Refresh receipt")}: {receipt.run.status}</strong><p>{receipt.run.runId} · {receipt.run.sourceId}</p>
      <p>{leadsMode ? t("本批读取线索", "Leads read this batch") : t("本批读取记录", "Batch fetched records")}: {receipt.run.summary?.leads ?? "—"} · {t("页数", "Pages")}: {receipt.run.summary?.pages ?? "—"}{!leadsMode && <> · {t("新增岗位", "Jobs added")}: {receipt.run.summary?.added ?? "—"}</>}</p>
      {receipt.sourceError && <p>{receipt.sourceError.code}</p>}<ul>{receipt.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
    {locked && <div className="atlas-sources-callout" role="status"><p>{leadsMode ? t("线索采集结果待同步。关闭面板仍保留原请求，暂不启动其他刷新。", "Lead collection needs synchronization. The original request survives closing this panel; further refreshes are paused.") : t("扫描结果待同步。关闭面板仍保留原请求，暂不启动其他刷新。", "Scan results need synchronization. The original request survives closing this panel; further refreshes are paused.")}</p>
      <button type="button" disabled={busy} onClick={recover}>{recovery.pending ? leadsMode ? t("核对原线索采集回执", "Recover original lead receipt") : t("核对原扫描回执", "Recover original scan receipt") : leadsMode ? t("重新读取线索采集进度", "Reload lead collection progress") : t("重新读取扫描与索引", "Reload scan and index")}</button></div>}
    {error && <p className="atlas-sources-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
