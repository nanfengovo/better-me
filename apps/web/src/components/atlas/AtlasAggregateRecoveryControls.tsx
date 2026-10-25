import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasDataset } from "@better-me/opportunities";
import { useUiPreferences } from "../../lib/ui-preferences";
import { createAtlasSourceClient } from "./service-client";
import { atlasAggregateRecoveryScope, beginAtlasAggregateRecovery, endAtlasAggregateRecovery, readAtlasAggregateRecovery, rejectAtlasAggregateRequest, saveAtlasAggregateReceipt, settleAtlasAggregateReceipt, settleAtlasAggregateRejection, useAtlasAggregateRecovery } from "./aggregate-recovery";

type Props = { endpoint: string; token: string; onSnapshot: (data: AtlasDataset) => void; onRefreshHealth?: (signal: AbortSignal) => Promise<void>; onBusy?: (busy: boolean) => void; disabled?: boolean };
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, failure => { signal.removeEventListener("abort", abort); reject(failure); });
  });
}
export function AtlasAggregateRecoveryControls(props: Props) {
  return <RecoverySession key={JSON.stringify([props.endpoint, props.token])} {...props} />;
}
function RecoverySession({ endpoint, token, onSnapshot, onRefreshHealth, onBusy, disabled = false }: Props) {
  const { t } = useUiPreferences(), scope = atlasAggregateRecoveryScope(endpoint, token);
  const state = useAtlasAggregateRecovery(endpoint, token), client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const current = useRef<AbortController | null>(null), closed = useRef(false);
  const latest = useRef({ onSnapshot, onRefreshHealth, onBusy }); latest.current = { onSnapshot, onRefreshHealth, onBusy };
  useEffect(() => { closed.current = false; return () => { closed.current = true; current.current?.abort(); latest.current.onBusy?.(false); }; }, []);
  async function recover() {
    if (disabled || closed.current || current.current) return;
    const owner = beginAtlasAggregateRecovery(scope); if (!owner) return;
    const controller = new AbortController(); current.current = controller; setBusy(true); setError(""); latest.current.onBusy?.(true);
    const timer = setTimeout(() => controller.abort(), 65_000), failures: string[] = [];
    try {
      const entries = readAtlasAggregateRecovery(scope).entries;
      for (const entry of entries) {
        controller.signal.throwIfAborted();
        if (entry.rejected || entry.receipt && entry.receipt.run.status !== "running") continue;
        try {
          await untilAborted(client.sync(entry.sourceId, entry.input, { signal: controller.signal, idempotencyKey: entry.key }).then(receipt => {
            // Save trusted replies even if this surface closes before displaying them.
            saveAtlasAggregateReceipt(scope, entry.key, receipt); return receipt;
          }), controller.signal);
        } catch (failure) {
          rejectAtlasAggregateRequest(scope, entry.key, failure);
          failures.push(`${entry.label}：${failure instanceof Error ? failure.message : t("回执未确认", "Receipt unconfirmed")}`);
        }
      }
      controller.signal.throwIfAborted();
      const confirmed = readAtlasAggregateRecovery(scope).entries.filter(entry => entry.rejected || entry.receipt && entry.receipt.run.status !== "running");
      if (confirmed.length) {
        const snapshot = await untilAborted(client.snapshot({ signal: controller.signal }), controller.signal); controller.signal.throwIfAborted();
        if (closed.current) return;
        latest.current.onSnapshot(snapshot);
        await latest.current.onRefreshHealth?.(controller.signal); controller.signal.throwIfAborted();
        for (const entry of confirmed) if (entry.rejected) settleAtlasAggregateRejection(scope, entry.key); else settleAtlasAggregateReceipt(scope, entry.key, entry.receipt!.run.runId);
      }
      if (failures.length) throw new Error(failures.join("；"));
    } catch (failure) {
      if (!closed.current) setError(controller.signal.aborted ? t("已停止等待，原请求和可信回执仍保留，可继续核对。", "Stopped waiting. Original requests and trusted receipts remain available for recovery.") : failure instanceof Error ? failure.message : t("回执同步未完成。", "Receipt synchronization incomplete."));
    } finally {
      clearTimeout(timer); endAtlasAggregateRecovery(scope, owner);
      if (current.current === controller) { current.current = null; if (!closed.current) { setBusy(false); latest.current.onBusy?.(false); } }
    }
  }
  if (!state.entries.length) return null;
  const pending = state.entries.filter(entry => !entry.rejected && (!entry.receipt || entry.receipt.run.status === "running"));
  return <section className="atlas-sources-callout" aria-label={t("聚合搜索回执恢复", "Aggregate search recovery")} aria-busy={busy}>
    <p role="status">{t("上一轮来源搜索仍需核对。关闭面板或修改条件会保留原请求，核对完成前暂停新采集；已收录岗位仍可浏览。", "The previous source search needs verification. Closing panels or changing filters retains its original requests. New collection is paused; indexed jobs remain available.")}</p>
    <ul>{state.entries.map(entry => <li key={entry.key}>{entry.label} · {entry.rejected ? t("原命令已明确拒绝，仅读取索引核对", "Original command rejected; index read only") : entry.receipt ? entry.receipt.run.status === "running" ? t("原扫描仍在运行", "Original scan still running") : t("可信回执已保存，仅读取索引", "Trusted receipt saved; index read only") : t("未收到最终回执，沿用原请求核对", "Final receipt missing; recover original request")}</li>)}</ul>
    <button type="button" disabled={disabled || state.active || busy} onClick={() => void recover()}>{pending.length ? t("核对原聚合搜索回执", "Recover original aggregate receipts") : t("重新读取聚合搜索索引", "Reload aggregate search index")}</button>
    {busy && <button type="button" onClick={() => current.current?.abort()}>{t("停止核对聚合搜索", "Stop aggregate recovery")}</button>}
    {error && <p role="alert" className="atlas-sources-error">{error}</p>}
  </section>;
}
