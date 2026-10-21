/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, History, Loader2, RefreshCw, X } from "lucide-react";
import { FxImportDraftSchema, fxReferenceAgeDays, MAX_FX_AGE_DAYS, type AtlasDataset, type FxState, type FxImportDraft, type FxImportPreview,
  type FxMutationReceipt, type FxReferenceSnapshot } from "@better-me/opportunities";
import { useUiPreferences } from "../../lib/ui-preferences";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import { atlasFxRecoveryScope, readAtlasFxRecovery, useAtlasFxRecovery, writeAtlasFxRecovery, type AtlasFxRecovery, type AtlasFxWrite } from "./fx-recovery";
import "./AtlasFxPanel.css";

export type AtlasFxPanelProps = {
  endpoint: string; token: string; data: AtlasDataset; state?: FxState; loading?: boolean; unsupported?: boolean;
  onSnapshot(snapshot: AtlasDataset): void; onClose(): void; onRetry(): void; onWritePending?(pending: boolean): void;
};
type Draft = { provider: string; sourceUrl: string; retrievedAt: string; raw: string; format: FxImportDraft["format"] };
const emptyDraft = (): Draft => ({ provider: "", sourceUrl: "", retrievedAt: "", raw: "", format: "eur-reference-json-v1" });
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 8 });

function SnapshotSummary({ snapshot, active, asOf }: { snapshot: FxReferenceSnapshot; active?: boolean; asOf?: string }) {
  const { t } = useUiPreferences();
  const stale = asOf && fxReferenceAgeDays(snapshot, asOf) > MAX_FX_AGE_DAYS;
  return <article className="atlas-fx-snapshot">
    <strong>{snapshot.fx.provider} · {snapshot.fx.date}{active && <span>{t("当前选择", "Selected")}</span>}</strong>
    <p>{t("本人导入的参考汇率，非官方薪资认证", "User-imported reference rates; not official salary verification")}{stale && ` · ${t("已超过30天，不参与人民币比较", "Over 30 days old; excluded from CNY comparison")}`}</p>
    <a href={snapshot.sourceUrl} target="_blank" rel="noopener noreferrer">{t("查看来源", "View source")}<ArrowUpRight size={12} /></a>
    <small>{t("读取时间", "Retrieved")}: {snapshot.retrievedAt}</small>
    <details><summary>{t("汇率、原文与内容指纹", "Rates, source text and fingerprint")}</summary><p>{t("方向：1 原币 = 人民币", "Direction: 1 unit of original currency = CNY")}</p>
      <dl>{Object.entries(snapshot.fx.ratesToCny).map(([currency, rate]) => <div key={currency}><dt>{currency}</dt><dd>{number(rate)}</dd></div>)}</dl>
      <small>SHA-256: {snapshot.contentHash}</small><pre>{snapshot.raw}</pre>
    </details>
  </article>;
}

export function AtlasFxPanel(props: AtlasFxPanelProps) {
  return <FxSession key={atlasFxRecoveryScope(props.endpoint, props.token)} {...props} />;
}
function FxSession({ endpoint, token, data, state, loading, unsupported, onSnapshot, onClose, onRetry, onWritePending }: AtlasFxPanelProps) {
  const { t } = useUiPreferences();
  const scope = atlasFxRecoveryScope(endpoint, token), client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const [draft, setDraft] = useState<Draft>(emptyDraft), [preview, setPreview] = useState<{ draft: FxImportDraft; value: FxImportPreview }>();
  const [reviewed, setReviewed] = useState(false), [activate, setActivate] = useState(false), [selection, setSelection] = useState("");
  const [activationReviewed, setActivationReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const recovery = useAtlasFxRecovery(endpoint, token);
  const current = useRef<{ controller: AbortController; kind: "read" | "preview" | "write" | "snapshot" } | null>(null);
  const closed = useRef(false), latest = useRef({ revision: data.revision, onSnapshot, onWritePending });
  latest.current = { revision: data.revision, onSnapshot, onWritePending };
  const available = !!state && state.revision === data.revision && !unsupported && !loading;
  const locked = busy || !!recovery.pending || !!recovery.saved;
  const stalePreview = preview?.value.expectedRevision !== data.revision;
  function remember(value: AtlasFxRecovery) { writeAtlasFxRecovery(scope, value); }
  useEffect(() => {
    closed.current = false;
    const savedRecovery = readAtlasFxRecovery(scope);
    if (savedRecovery.pending || savedRecovery.saved) latest.current.onWritePending?.(true);
    return () => { closed.current = true; current.current?.controller.abort(); current.current = null; };
  }, [scope]);
  useEffect(() => {
    if (current.current && !["write", "snapshot"].includes(current.current.kind)) current.current.controller.abort();
    setReviewed(false); setActivationReviewed(false);
  }, [data.revision]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  function alive(signal: AbortSignal) { signal.throwIfAborted(); if (closed.current || current.current?.controller.signal !== signal) throw new Error(t("本次汇率操作已关闭。", "This FX operation is closed.")); }
  async function run(kind: NonNullable<typeof current.current>["kind"], action: (signal: AbortSignal) => Promise<void>) {
    if (closed.current || current.current) return;
    const operation = { kind, controller: new AbortController() }; current.current = operation; setBusy(true); setError("");
    const timer = setTimeout(() => operation.controller.abort(), 25_000);
    try { await action(operation.controller.signal); }
    catch (problem) {
      if (!closed.current && current.current === operation) setError(operation.controller.signal.aborted
        ? operation.kind === "write" ? t("已停止等待，写入可能已完成。请核对本次汇率保存回执。", "Stopped waiting; the write may have completed. Recover this FX receipt.")
          : operation.kind === "snapshot" ? t("保存已确认，请重新读取索引，不要再次保存。", "Save confirmed. Reload the index; do not save again.")
            : t("读取已停止或索引已更新，请重试。", "Read stopped or index changed. Try again.")
        : problem instanceof Error ? problem.message : t("汇率操作未完成。", "FX operation did not complete."));
    } finally { clearTimeout(timer); if (current.current === operation) { current.current = null; setBusy(false); } }
  }
  function edit(field: keyof Draft, value: string) {
    if (locked) return; setDraft(previous => ({ ...previous, [field]: value })); setPreview(undefined); setReviewed(false); setError("");
  }
  const readReference = () => run("read", async signal => {
    const value = await client.fetchFxReference({ signal }); alive(signal);
    setDraft({ provider: value.provider, sourceUrl: value.sourceUrl, retrievedAt: value.retrievedAt, raw: value.raw, format: value.format }); setPreview(undefined); setReviewed(false);
  });
  const readPreview = () => run("preview", async signal => {
    if (!available) throw new Error(t("请先读取当前索引版本的汇率上下文。", "Load FX context for the current index first."));
    const parsed = FxImportDraftSchema.safeParse({ schemaVersion: 1, ...draft });
    if (!parsed.success) throw new Error(t("请填写来源名称、HTTPS出处、ISO读取时间与完整参考汇率JSON原文。", "Fill in provider, HTTPS source, ISO retrieval time and full reference-rate JSON."));
    const value = await client.previewFxImport({ draft: parsed.data, expectedRevision: data.revision }, { signal }); alive(signal);
    if (value.expectedRevision !== latest.current.revision) throw new Error(t("已丢弃旧版本预览，请重新读取后预览。", "Discarded an old preview. Reload and preview again."));
    setPreview({ draft: parsed.data, value }); setReviewed(false);
  });
  async function snapshot(signal: AbortSignal, revision: number) {
    const value = await client.snapshot({ signal }); alive(signal);
    if (value.revision < Math.max(revision, latest.current.revision)) throw new Error(t("尚未读取到已保存版本，请重试读取索引。", "The saved index version is not available yet. Retry loading."));
    latest.current.onSnapshot(value); remember({}); latest.current.onWritePending?.(false);
    setNotice(t(`汇率写入已确认，已读取索引版本 ${value.revision}；当前查询等待同版汇率后重新计算。`, `FX write confirmed and index revision ${value.revision} loaded. The query recalculates when matching FX context is ready.`));
    setPreview(undefined); setReviewed(false); setActivationReviewed(false);
  }
  const refresh = () => run("snapshot", signal => snapshot(signal, recovery.saved?.revision ?? data.revision));
  const commit = (kind: AtlasFxWrite["kind"]) => run("write", async signal => {
    if (!recovery.pending && (!available || (kind === "import" ? !preview || !reviewed || stalePreview : !activationReviewed))) return;
    const write: AtlasFxWrite = recovery.pending ?? (kind === "import"
      ? { kind, input: { draft: preview!.draft, expectedRevision: preview!.value.expectedRevision, previewFingerprint: preview!.value.previewFingerprint, reviewed: true, activate }, key: `fx-import-${crypto.randomUUID()}` }
      : { kind, input: { snapshotId: selection || null, expectedRevision: data.revision, reviewed: true }, key: `fx-activate-${crypto.randomUUID()}` });
    remember({ pending: write }); latest.current.onWritePending?.(true);
    let receipt: FxMutationReceipt;
    try { receipt = write.kind === "import" ? await client.importFxSnapshot(write.input, { signal, idempotencyKey: write.key })
      : await client.activateFxSnapshot(write.input, { signal, idempotencyKey: write.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized", "conflict", "not-found"].includes(problem.code)) {
        alive(signal); remember({}); setPreview(undefined); setReviewed(false); setActivationReviewed(false); latest.current.onWritePending?.(false); onRetry();
      }
      throw problem;
    }
    alive(signal); remember({ saved: receipt }); current.current!.kind = "snapshot";
    try { await snapshot(signal, receipt.revision); }
    catch (problem) { alive(signal); throw new Error(t(`已保存到版本 ${receipt.revision}，索引读取未完成。请重新读取索引，不要再次保存。`, `Saved at revision ${receipt.revision}; index reload failed. Reload the index; do not save again.`), { cause: problem }); }
  });
  return <section className="atlas-fx-panel" aria-label={t("参考汇率管理", "Reference FX management")} aria-busy={busy}>
    <header><div><span className="atlas-eyebrow">REFERENCE RATES / CNY</span><h2>{t("让跨币种比较，有据可查。", "Traceable comparisons across currencies.")}</h2></div><button type="button" aria-label={t("关闭汇率管理", "Close FX management")} onClick={onClose}><X size={18} /></button></header>
    <p>{t("汇率只用于统一比较税前固定年薪，原币及薪资原文保持。本人导入不代表官方认证；参考汇率不是实时成交价或结算价。", "Rates support comparison of gross fixed annual pay. Original salaries are retained. User imports are not official verification; reference rates are not real-time trading or settlement rates.")}</p>
    <div className="atlas-fx-current" aria-live="polite">{loading ? <p><Loader2 size={15} className="animate-spin" />{t("正在读取同版汇率…", "Loading matching FX context…")}</p>
      : available ? <><strong>{t(`索引版本 ${state.revision}`, `Index revision ${state.revision}`)}</strong><p>{state.context.activeSnapshot ? `${state.context.activeSnapshot.fx.provider} · ${state.context.activeSnapshot.fx.date}` : t("未启用外币汇率；保留人民币与原币披露。", "No FX snapshot enabled. CNY and original-currency disclosures remain available.")}</p></>
        : <p>{unsupported ? t("请升级岗位后端以使用汇率管理。当前保留人民币及原币能力。", "Upgrade the job backend for FX management. CNY and original currencies remain available.") : t("当前版本汇率尚未取得，旧汇率结果已隐藏。", "FX context for this index is unavailable. Old FX results are hidden.")}</p>}
      <button type="button" disabled={loading || busy || !!recovery.pending} onClick={onRetry}><RefreshCw size={13} />{t("重新读取汇率上下文", "Reload FX context")}</button>
    </div>
    <fieldset disabled={locked || !available}><legend>{t("导入带出处的参考快照", "Import a sourced reference snapshot")}</legend>
      <button type="button" onClick={() => void readReference()}>{t("读取公开参考汇率（Frankfurter）", "Read public reference rates (Frankfurter)")}</button>
      <small>{t("仅点击才由后端读取固定公开来源，读取后仍需预览与本人确认。也可在下方粘贴原始JSON。", "The backend reads a fixed public source only when clicked. Preview and explicit review are still required. You may also paste the original JSON below.")}</small>
      <div className="atlas-fx-fields"><label>{t("来源名称", "Provider")}<input aria-label={t("汇率来源名称", "FX provider")} value={draft.provider} maxLength={200} onChange={event => edit("provider", event.target.value)} placeholder="Frankfurter reference rates" /></label>
      <label>{t("原文出处", "Source URL")}<input type="url" aria-label={t("汇率原文出处", "FX source URL")} value={draft.sourceUrl} onChange={event => edit("sourceUrl", event.target.value)} placeholder="https://api.frankfurter.dev/v2/rates" /></label>
      <label>{t("实际读取时间（ISO 8601）", "Actual retrieval time (ISO 8601)")}<input aria-label={t("汇率读取时间", "FX retrieval time")} value={draft.retrievedAt} onChange={event => edit("retrievedAt", event.target.value)} placeholder="2026-10-21T08:00:00.000Z" /></label></div>
      <label>{t("原文格式", "Source format")}<select aria-label={t("汇率原文格式", "FX source format")} value={draft.format} onChange={event => edit("format", event.target.value)}><option value="eur-reference-json-v1">{t("EUR参考JSON对象（v1）", "EUR reference JSON object (v1)")}</option><option value="frankfurter-v2-eur-json-v1">{t("Frankfurter v2 EUR数组", "Frankfurter v2 EUR array")}</option></select></label>
      <label>{t("参考汇率JSON原文", "Original reference-rate JSON")}<textarea rows={7} aria-label={t("参考汇率JSON原文", "Original reference-rate JSON")} value={draft.raw} maxLength={262144} onChange={event => edit("raw", event.target.value)} placeholder={draft.format === "eur-reference-json-v1" ? '{"date":"YYYY-MM-DD","base":"EUR","rates":{"CNY":7.8,"USD":1.1}}' : '[{"date":"YYYY-MM-DD","base":"EUR","quote":"CNY","rate":7.8}]'} spellCheck={false} /></label>
      <small>{draft.format === "eur-reference-json-v1" ? t("格式：EUR为基准的对象，包含date与rates.CNY。", "Format: an EUR-base object containing date and rates.CNY.") : t("格式：EUR为基准的数组，每行包含date、base、quote与rate；所有行必须同日、币种不重复且包含CNY。", "Format: an EUR-base array of date, base, quote and rate; all rows must share one date, have unique quote currencies and include CNY.")} {t("汇率必须为正数。原文、公开来源筛选参数和SHA-256指纹一起保存。超过30天的快照可留档，但不参与人民币比较。", "Rates must be positive. Raw text, public source selectors and SHA-256 fingerprint are preserved. Snapshots older than 30 days may be archived but cannot support CNY comparison.")}</small>
      <button type="button" onClick={() => void readPreview()}>{t("预览汇率快照", "Preview FX snapshot")}</button>
    </fieldset>
    {preview && <div className="atlas-fx-preview"><h3>{t("待本人核对的换算预览", "Conversion preview for your review")}</h3><SnapshotSummary snapshot={preview.value.snapshot} asOf={state?.context.asOf} />
      {stalePreview && <p role="status">{t("索引已更新，本预览失效，请重新预览。", "The index changed. Preview again before saving.")}</p>}
      <label><input type="checkbox" disabled={locked || stalePreview} checked={activate} onChange={event => { setActivate(event.target.checked); setReviewed(false); }} />{t("保存后启用，重新计算列表、地图及统计", "Enable after saving and recalculate results, map and counts")}</label>
      <label><input type="checkbox" aria-label={t("确认已核对汇率出处日期与换算方向", "Confirm FX source, date and conversion direction reviewed")} disabled={locked || stalePreview} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{t("本人已核对出处、日期、原文与换算方向", "I reviewed the source, date, original text and conversion direction")}</label>
      <button type="button" disabled={locked || !reviewed || stalePreview || !available} onClick={() => void commit("import")}><Check size={14} />{t("确认保存汇率快照", "Confirm and save FX snapshot")}</button>
    </div>}
    {state && <div className="atlas-fx-history"><h3><History size={15} />{t(`已存快照（${state.snapshots.length}）`, `Saved snapshots (${state.snapshots.length})`)}</h3>
      <fieldset disabled={locked || !available}><legend>{t("明确切换或停用参考快照", "Explicitly select or disable a snapshot")}</legend><select aria-label={t("选择汇率快照", "Select FX snapshot")} value={selection} onChange={event => { setSelection(event.target.value); setActivationReviewed(false); }}><option value="">{t("停用外币换算", "Disable FX conversion")}</option>{state.snapshots.map(snapshot => <option value={snapshot.fx.id} key={snapshot.fx.id}>{snapshot.fx.provider} · {snapshot.fx.date} · {snapshot.fx.id.slice(-8)}</option>)}</select>
        <label><input type="checkbox" aria-label={t("确认切换或停用汇率", "Confirm FX selection or disabling")} checked={activationReviewed} onChange={event => setActivationReviewed(event.target.checked)} />{t("本人确认此选择，并重新计算当前岗位查询", "I confirm this selection and recalculation of the current query")}</label>
        <button type="button" disabled={!activationReviewed || (selection || null) === (state.context.activeSnapshot?.fx.id ?? null)} onClick={() => void commit("activate")}>{t("应用汇率选择", "Apply FX selection")}</button>
      </fieldset>{state.snapshots.map(snapshot => <SnapshotSummary key={snapshot.fx.id} snapshot={snapshot} active={snapshot.fx.id === state.context.activeSnapshot?.fx.id} asOf={state.context.asOf} />)}
    </div>}
    {recovery.pending && <div className="atlas-fx-pending" role="status"><p>{t("本次汇率写入结果尚未确认，保留原请求与幂等键；旧查询结果已隐藏。", "This write is unconfirmed. The original request and idempotency key are retained; old query results are hidden.")}</p><button type="button" disabled={busy} onClick={() => void commit(recovery.pending!.kind)}>{t("核对本次汇率保存回执", "Recover this FX save receipt")}</button></div>}
    {recovery.saved && <div className="atlas-fx-saved" role="status"><p>{t(`保存已确认，版本 ${recovery.saved.revision}；等待同版索引与汇率。`, `Save confirmed at revision ${recovery.saved.revision}; waiting for matching index and FX context.`)}</p><button type="button" disabled={busy} onClick={() => void refresh()}>{t("重新读取索引", "Reload index")}</button></div>}
    {busy && <button type="button" onClick={() => current.current?.controller.abort()}>{t("停止等待", "Stop waiting")}</button>}
    {notice && <p role="status" className="atlas-fx-notice">{notice}</p>}
    {error && <p role="alert" className="atlas-error">{error}</p>}
  </section>;
}
