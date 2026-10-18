/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, MapPin, X } from "lucide-react";
import { PreviewLocationConfirmationInputSchema, type AtlasDataset, type JobLocation, type LocationConfirmationPreview,
  type LocationConfirmationReceipt, type PreviewLocationConfirmationInput, type ConfirmLocationInput, type RevokeLocationConfirmationInput } from "@better-me/opportunities";
import countries from "../../../../../config/geography/countries.json";
import { getChinaProvinces, getChinaCities, getChinaDistricts, type ChinaRegionSelection } from "./china-regions";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import "./AtlasLocationConfirmation.css";

export type AtlasLocationConfirmationProps = {
  endpoint: string; token: string; jobId: string; location: JobLocation; revision: number;
  onClose: () => void; onSnapshot: (data: AtlasDataset) => void;
};
type Write = { kind: "confirm"; input: ConfirmLocationInput; key: string } | { kind: "revoke"; input: RevokeLocationConfirmationInput; key: string };
type Draft = { country: string; kind: NonNullable<JobLocation["kind"]>; china: ChinaRegionSelection; region: string; city: string; district: string; reason: string };
function initial(location: JobLocation): Draft {
  const basis = location.userResolution?.basis;
  return { country: location.countryCode ?? "", kind: location.kind ?? "unknown", china: basis?.kind === "china-catalog" ? {
    provinceCode: basis.provinceCode, cityCode: basis.cityCode, districtCode: basis.districtCode,
  } : {}, region: location.region ?? "", city: location.city ?? "", district: location.district ?? "", reason: "" };
}
const areaLabel = (location: JobLocation) => [location.countryCode, location.region, location.city, location.district].filter(Boolean).join(" / ") || "未确认行政范围";
const regionNames = new Intl.DisplayNames(["zh"], { type: "region" });

/** Local administrative confirmation only. Source evidence is immutable; this never creates office coordinates. */
export function AtlasLocationConfirmation({ endpoint, token, jobId, location, revision, onClose, onSnapshot }: AtlasLocationConfirmationProps) {
  const locationKey = JSON.stringify(location);
  const binding = useMemo(() => ({ client: createAtlasSourceClient(endpoint, token), jobId, location: JSON.parse(locationKey) as JobLocation }), [endpoint, token, jobId, locationKey]);
  const [draftState, setDraftState] = useState<{ binding: typeof binding; value: Draft }>();
  const draft = draftState?.binding === binding ? draftState.value : initial(binding.location);
  const [previewState, setPreview] = useState<{ binding: typeof binding; input: PreviewLocationConfirmationInput; value: LocationConfirmationPreview }>();
  const [pendingState, setPending] = useState<{ binding: typeof binding; write: Write }>();
  const [savedState, setSaved] = useState<{ binding: typeof binding; receipt: LocationConfirmationReceipt }>();
  const [confirmation, setConfirmation] = useState<typeof binding>();
  const [revocation, setRevocation] = useState<typeof binding>();
  const [operation, setOperation] = useState<typeof binding>();
  const [failure, setFailure] = useState<{ binding: typeof binding; message: string }>();
  const current = useRef<{ binding: typeof binding; controller: AbortController } | null>(null);
  const section = useRef<HTMLElement>(null);
  const preview = previewState?.binding === binding ? previewState : undefined;
  const pending = pendingState?.binding === binding ? pendingState.write : undefined;
  const saved = savedState?.binding === binding ? savedState.receipt : undefined;
  const busy = operation === binding;
  const error = failure?.binding === binding ? failure.message : "";
  const locked = busy || !!pending || !!saved;
  useEffect(() => {
    section.current?.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    return () => { current.current?.controller.abort(); current.current = null; };
  }, [binding]);
  function edit(update: Partial<Draft>) {
    if (locked) return;
    setDraftState({ binding, value: { ...draft, ...update } }); setPreview(undefined); setConfirmation(undefined); setRevocation(undefined); setFailure(undefined);
  }
  const alive = (signal: AbortSignal) => { signal.throwIfAborted(); if (current.current?.binding !== binding) throw new Error("核对范围已改变。"); };
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (current.current) return;
    const active = { binding, controller: new AbortController() }; current.current = active; setOperation(binding); setFailure(undefined);
    const timeout = setTimeout(() => active.controller.abort(), 25_000);
    try { await action(active.controller.signal); }
    catch (problem) {
      if (current.current === active) setFailure({ binding, message: active.controller.signal.aborted
        ? "已停止等待。已提交的写入可能完成；请重试本次请求核对回执。"
        : problem instanceof Error ? problem.message : "本次地点核对未完成。" });
    } finally { clearTimeout(timeout); if (current.current === active) { current.current = null; setOperation(undefined); } }
  }
  const refresh = () => run(async signal => { const data = await binding.client.snapshot({ signal }); alive(signal); onSnapshot(data); });
  const readPreview = () => run(async signal => {
    const area = draft.country === "CN" && draft.china.provinceCode ? { kind: "china-catalog" as const, ...draft.china } : {
      kind: "manual-area" as const,
      ...(draft.region.trim() ? { region: draft.region.trim() } : {}), ...(draft.city.trim() ? { city: draft.city.trim() } : {}), ...(draft.district.trim() ? { district: draft.district.trim() } : {}),
    };
    const parsed = PreviewLocationConfirmationInputSchema.safeParse({ jobId, locationId: location.id, expectedRevision: revision,
      proposal: { locationKind: draft.kind, countryCode: draft.country, area }, reason: draft.reason.trim() });
    if (!parsed.success) throw new Error("请选择国家／地区，并填写核对依据或说明；下级地区须先选择上级。");
    const value = await binding.client.previewLocationConfirmation(parsed.data, { signal }); alive(signal);
    setPreview({ binding, input: parsed.data, value }); setConfirmation(undefined);
  });
  const commit = (kind: Write["kind"]) => run(async signal => {
    if (!pending && (kind === "confirm" ? !preview || confirmation !== binding : !location.userResolution || revocation !== binding || !draft.reason.trim())) return;
    const write: Write = pending ?? (kind === "confirm" ? { kind, input: { ...preview!.input, previewFingerprint: preview!.value.previewFingerprint, reviewed: true }, key: `location-${crypto.randomUUID()}` }
      : { kind, input: { jobId, locationId: location.id, decisionId: location.userResolution!.decisionId, expectedRevision: revision, reason: draft.reason.trim(), reviewed: true }, key: `location-revoke-${crypto.randomUUID()}` });
    setPending({ binding, write });
    let receipt: LocationConfirmationReceipt;
    try { receipt = write.kind === "confirm" ? await binding.client.confirmLocation(write.input, { signal, idempotencyKey: write.key })
      : await binding.client.revokeLocationConfirmation(write.input, { signal, idempotencyKey: write.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized", "conflict", "not-found"].includes(problem.code)) {
        alive(signal); setPending(undefined); setPreview(undefined); setConfirmation(undefined); setRevocation(undefined);
      }
      throw problem;
    }
    alive(signal); setSaved({ binding, receipt }); setPending(undefined);
    try { const data = await binding.client.snapshot({ signal }); alive(signal); onSnapshot(data); }
    catch (problem) { alive(signal); throw new Error(`已保存到索引版本 ${receipt.revision}，页面刷新未完成。请重新读取索引。`, { cause: problem }); }
  });
  function close() { current.current?.controller.abort(); current.current = null; onClose(); }
  const chinaCities = getChinaCities(draft.china.provinceCode), chinaDistricts = getChinaDistricts(draft.china.provinceCode, draft.china.cityCode);
  return <section ref={section} className="atlas-location-review" aria-label="核对并保存岗位地区" aria-busy={busy}>
    <header><h3><MapPin size={16} />核对工作地区</h3><button type="button" aria-label="关闭地区核对" onClick={close}><X size={16} /></button></header>
    <p>来源地点原文：<strong>{location.raw}</strong></p><p>当前行政范围：{areaLabel(location)}</p>
    <p className="atlas-small">选择只保存为本机可撤销的地区确认，供国家／省市区筛选使用。原文与来源证据保留；不新增办公坐标。已有坐标会从本次地区确认中移除，撤销后恢复来源值。</p>
    <fieldset disabled={locked}>
      <label>地点性质<select aria-label="确认地点性质" value={draft.kind} onChange={event => edit({ kind: event.target.value as Draft["kind"] })}><option value="unknown">尚未确认性质</option><option value="office">工作地点（办公地址精度仍待核实）</option><option value="remote-region">远程资格范围（非办公地点）</option></select></label>
      <label>国家／地区<select aria-label="确认国家地区" value={draft.country} onChange={event => edit({ country: event.target.value, china: {}, region: "", city: "", district: "" })}><option value="">请选择</option>{countries.countries.map(code => <option value={code} key={code}>{regionNames.of(code) ?? code} · {code}</option>)}</select></label>
      {draft.country === "CN" ? <>
        <label>省级地区<select aria-label="确认省级地区" value={draft.china.provinceCode ?? ""} onChange={event => edit({ china: { provinceCode: event.target.value || undefined }, region: "", city: "", district: "" })}><option value="">仅确认国家</option>{getChinaProvinces().filter(entry => entry.catalogAvailable).map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></label>
        <label>城市<select aria-label="确认城市" disabled={!chinaCities.length} value={draft.china.cityCode ?? ""} onChange={event => edit({ china: { provinceCode: draft.china.provinceCode, cityCode: event.target.value || undefined } })}><option value="">不指定城市</option>{chinaCities.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></label>
        <label>区县<select aria-label="确认区县" disabled={!chinaDistricts.length} value={draft.china.districtCode ?? ""} onChange={event => edit({ china: { ...draft.china, districtCode: event.target.value || undefined } })}><option value="">不指定区县</option>{chinaDistricts.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></label>
        <small>2023 统计区划快照；部分末级为镇街／功能区。只确认原文有依据的范围。</small>
      </> : draft.country && !["HK", "MO", "TW"].includes(draft.country) ? <>
        <label>省／州／地区<input aria-label="确认省州地区" maxLength={300} value={draft.region} onChange={event => edit({ region: event.target.value })} /></label>
        <label>城市<input aria-label="确认城市名称" maxLength={300} value={draft.city} onChange={event => edit({ city: event.target.value })} /></label>
        <label>区县<input aria-label="确认区县名称" maxLength={300} value={draft.district} onChange={event => edit({ district: event.target.value })} /></label>
      </> : draft.country && <small>当前仅确认地区级范围，下级目录待补充。</small>}
      <label>核对依据或说明<textarea aria-label="地区核对说明" maxLength={500} value={draft.reason} placeholder="例如：已核对原岗位，披露上海浦东；未披露具体办公地址。" onChange={event => edit({ reason: event.target.value })} /></label>
    </fieldset>
    {!saved && <button type="button" disabled={locked} onClick={() => void readPreview()}>预览地区变更</button>}
    {preview && !saved && <div className="atlas-location-preview"><p>拟保存：<strong>{areaLabel(preview.value.proposed)}</strong></p><p>基于索引版本 {preview.value.expectedRevision}；不将用户确认标为来源已核实。</p>{preview.value.warnings.map(warning => <p key={warning}>{warning}</p>)}<label><input type="checkbox" checked={confirmation === binding} disabled={busy || !!pending} onChange={event => setConfirmation(event.target.checked ? binding : undefined)} />我已核对原岗位，确认保存上述地区选择</label><button type="button" disabled={busy || !!pending || confirmation !== binding} onClick={() => void commit("confirm")}>确认保存地区</button></div>}
    {location.userResolution && !saved && <div className="atlas-location-revoke"><label><input type="checkbox" checked={revocation === binding} disabled={busy || !!pending} onChange={event => setRevocation(event.target.checked ? binding : undefined)} />撤销当前这条地区确认，恢复上一条有效记录或来源值</label><button type="button" disabled={busy || !!pending || revocation !== binding || !draft.reason.trim()} onClick={() => void commit("revoke")}>撤销当前地区确认</button></div>}
    {pending && !saved && <button type="button" disabled={busy} onClick={() => void commit(pending.kind)}>重试本次地点写入 · 核对回执</button>}
    {busy && <p role="status"><Loader2 size={15} className="animate-spin" />正在处理地点请求…</p>}
    {saved && <p className="atlas-location-saved" role="status"><Check size={15} />已保存到索引版本 {saved.revision}。当前地区：{areaLabel(saved.location)}。</p>}
    {error && <p role="alert" className="atlas-error">{error}</p>}
    <button type="button" disabled={busy || !!pending} onClick={() => void refresh()}>重新读取索引</button>
  </section>;
}
