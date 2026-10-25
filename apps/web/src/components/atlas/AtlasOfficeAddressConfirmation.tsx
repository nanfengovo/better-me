/** @jsxRuntime automatic */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Loader2, MapPin, Search, X } from "lucide-react";
import { HttpUrlSchema, OfficeAddressCandidatesInputSchema, PreviewOfficeConfirmationInputSchema,
  evaluateOfficeAddressCandidate,
  type AtlasDataset, type JobLocation, type OfficeAddressCandidatesResult, type OfficeAddressProposal,
  type OfficeAddressPreview, type OfficeAddressReceipt, type PreviewOfficeConfirmationInput,
  type ConfirmOfficeAddressInput, type RevokeOfficeAddressInput, type OfficeAddressCandidate } from "@better-me/opportunities";
import countries from "../../../../../config/geography/countries.json";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import "./AtlasOfficeAddressConfirmation.css";

export type AtlasOfficeAddressConfirmationProps = {
  endpoint: string; token: string; jobId: string; location: JobLocation; revision: number;
  onClose: () => void; onSnapshot: (data: AtlasDataset) => void;
  onCandidateFocus?: (candidate: OfficeAddressCandidate) => void;
  /** Prefills the query from a source address; sending it to a provider remains an explicit action. */
  prefillFromSourceAddress?: boolean;
};
type Draft = { country: string; formattedAddress: string; streetAddress: string; postalCode: string;
  latitude: string; longitude: string; coordinateMeaning: OfficeAddressProposal["coordinateMeaning"]; evidenceUrl: string; reason: string };
type Write = { kind: "confirm"; input: ConfirmOfficeAddressInput; key: string } | { kind: "revoke"; input: RevokeOfficeAddressInput; key: string };
const regionNames = new Intl.DisplayNames(["zh"], { type: "region" });
const meaning = { building: "楼宇", entrance: "入口", site: "园区／场地" };
const matchFieldLabels = { countryCode: "国家／地区", region: "省／州／地区", city: "城市", district: "区县", streetAddress: "街道与门牌", postalCode: "邮政编码" };
const matchStatusLabels = { match: "匹配", conflict: "冲突", unknown: "未知" };
function initial(location: JobLocation): Draft {
  const resolution = location.officeResolution;
  // City/region reference coordinates must never become the initial office point.
  const point = location.precision === "address" && location.kind === "office" ? location.coordinates : undefined;
  return { country: location.countryCode ?? "", formattedAddress: resolution?.formattedAddress ?? "",
    streetAddress: resolution?.streetAddress ?? location.streetAddress ?? "", postalCode: resolution?.postalCode ?? location.postalCode ?? "",
    latitude: point ? String(point.latitude) : "", longitude: point ? String(point.longitude) : "",
    coordinateMeaning: resolution?.coordinateMeaning ?? "building", evidenceUrl: resolution?.evidenceUrl ?? "", reason: "" };
}
function candidateDraft(proposal: OfficeAddressProposal, reason: string): Draft {
  return { country: proposal.countryCode, formattedAddress: proposal.formattedAddress, streetAddress: proposal.streetAddress,
    postalCode: proposal.postalCode ?? "", latitude: String(proposal.coordinates.latitude), longitude: String(proposal.coordinates.longitude),
    coordinateMeaning: proposal.coordinateMeaning, evidenceUrl: proposal.evidenceUrl, reason };
}

/** A different connection, job or full source location starts a separate, cancellable review. */
export function AtlasOfficeAddressConfirmation(props: AtlasOfficeAddressConfirmationProps) {
  return <OfficeAddressSession key={JSON.stringify([props.endpoint, props.token, props.jobId, props.location])} {...props} />;
}

function OfficeAddressSession({ endpoint, token, jobId, location, revision, onClose, onSnapshot, onCandidateFocus, prefillFromSourceAddress = false }: AtlasOfficeAddressConfirmationProps) {
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const queryHelpId = useId();
  const [draft, setDraft] = useState(() => initial(location));
  const [query, setQuery] = useState(() => prefillFromSourceAddress ? location.streetAddress ?? "" : "");
  const [queryLocality, setQueryLocality] = useState(() => prefillFromSourceAddress ? location.city ?? "" : ""), [queryPostalCode, setQueryPostalCode] = useState(() => prefillFromSourceAddress ? location.postalCode ?? "" : "");
  const [candidates, setCandidates] = useState<OfficeAddressCandidatesResult>();
  const [preview, setPreview] = useState<{ input: PreviewOfficeConfirmationInput; value: OfficeAddressPreview }>();
  const [reviewed, setReviewed] = useState(false), [revokeReviewed, setRevokeReviewed] = useState(false);
  const [pending, setPending] = useState<Write>(), [saved, setSaved] = useState<OfficeAddressReceipt>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const current = useRef<AbortController | null>(null), closed = useRef(false), section = useRef<HTMLElement>(null);
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const locked = busy || !!pending || !!saved;
  const eligible = location.kind === "office" && location.evidence.length > 0;
  const stalePreview = !!preview && preview.input.expectedRevision !== revision;
  const staleCandidates = !!candidates && candidates.revision !== revision;
  useEffect(() => {
    closed.current = false;
    section.current?.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    return () => { closed.current = true; current.current?.abort(); current.current = null; };
  }, []);
  function alive(signal: AbortSignal) {
    signal.throwIfAborted();
    if (closed.current || current.current?.signal !== signal) throw new Error("本次办公地址核对已关闭。");
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (closed.current || current.current || !eligible) return;
    const controller = new AbortController(); current.current = controller; setBusy(true); setError("");
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try { await action(controller.signal); }
    catch (problem) {
      if (current.current === controller && !closed.current) setError(controller.signal.aborted
        ? "已停止等待。提交中的写入可能已完成；请保留本面板并重试本次请求核对回执。"
        : problem instanceof Error ? problem.message : "本次办公地址核对未完成。");
    } finally { clearTimeout(timeout); if (current.current === controller) { current.current = null; setBusy(false); } }
  }
  function edit(update: Partial<Draft>) {
    if (locked) return;
    setDraft(value => ({ ...value, ...update })); setPreview(undefined); setReviewed(false); setRevokeReviewed(false); setError("");
  }
  function editQuery(value: string, field: "address" | "locality" | "postalCode") {
    if (locked) return;
    if (field === "address") setQuery(value);
    else if (field === "locality") setQueryLocality(value);
    else setQueryPostalCode(value);
    setCandidates(undefined); setError("");
  }
  const readCandidates = (external: boolean) => run(async signal => {
    const input = OfficeAddressCandidatesInputSchema.safeParse({ jobId, locationId: location.id, expectedRevision: revision,
      ...(external ? { query: query.trim(), ...(queryLocality.trim() ? { locality: queryLocality.trim() } : {}),
        ...(queryPostalCode.trim() ? { postalCode: queryPostalCode.trim() } : {}) } : {}) });
    if (!input.success) throw new Error("请先填写具体街道、楼宇或园区地址，再查询地址候选。");
    const result = await client.officeAddressCandidates(input.data, { signal }); alive(signal);
    if (input.data.expectedRevision !== latestRevision.current) { setError("索引已更新，已丢弃过期地址候选，请重新查询。"); return; }
    setCandidates(result);
  });
  const readPreview = () => run(async signal => {
    if (!draft.latitude.trim() || !draft.longitude.trim()) throw new Error("请填写本人核对的 WGS84 纬度和经度；不能使用城市中心代替办公地点。");
    const input = PreviewOfficeConfirmationInputSchema.safeParse({ jobId, locationId: location.id, expectedRevision: revision,
      proposal: { basis: "manual-user-confirmation", countryCode: draft.country, formattedAddress: draft.formattedAddress.trim(),
        streetAddress: draft.streetAddress.trim(), ...(draft.postalCode.trim() ? { postalCode: draft.postalCode.trim() } : {}),
        coordinates: { latitude: Number(draft.latitude), longitude: Number(draft.longitude), coordinateSystem: "WGS84" },
        coordinateMeaning: draft.coordinateMeaning, evidenceUrl: draft.evidenceUrl.trim() }, reason: draft.reason.trim() });
    if (!input.success) throw new Error("请核对国家、完整地址、街道门牌、有效 WGS84 坐标、HTTP(S) 依据链接及核对说明。");
    const result = await client.previewOfficeConfirmation(input.data, { signal }); alive(signal);
    if (input.data.expectedRevision !== latestRevision.current) { setError("索引已更新，已丢弃过期地址预览，请重新预览。"); return; }
    setPreview({ input: input.data, value: result }); setReviewed(false); setRevokeReviewed(false);
  });
  const refresh = () => run(async signal => {
    const data = await client.snapshot({ signal }); alive(signal);
    if (data.revision < Math.max(latestRevision.current, saved?.revision ?? 0)) throw new Error("尚未读取到当前或已保存的索引版本，请重试读取。");
    onSnapshot(data);
  });
  const commit = (kind: Write["kind"]) => run(async signal => {
    if (!pending && (kind === "confirm" ? !preview || !reviewed || stalePreview
      : !location.officeResolution || !revokeReviewed || !draft.reason.trim())) return;
    const write: Write = pending ?? (kind === "confirm"
      ? { kind, input: { ...preview!.input, previewFingerprint: preview!.value.previewFingerprint, reviewed: true }, key: `office-${crypto.randomUUID()}` }
      : { kind, input: { jobId, locationId: location.id, decisionId: location.officeResolution!.decisionId, expectedRevision: revision,
        reason: draft.reason.trim(), reviewed: true }, key: `office-revoke-${crypto.randomUUID()}` });
    setPending(write);
    let receipt: OfficeAddressReceipt;
    try { receipt = write.kind === "confirm" ? await client.confirmOfficeAddress(write.input, { signal, idempotencyKey: write.key })
      : await client.revokeOfficeAddress(write.input, { signal, idempotencyKey: write.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized", "conflict", "not-found"].includes(problem.code)) {
        alive(signal); setPending(undefined); setPreview(undefined); setReviewed(false); setRevokeReviewed(false);
      }
      throw problem;
    }
    alive(signal); setSaved(receipt); setPending(undefined);
    try { const data = await client.snapshot({ signal }); alive(signal);
      if (data.revision < Math.max(latestRevision.current, receipt.revision)) throw new Error("尚未读取到当前或写入后的版本。"); onSnapshot(data);
    } catch (problem) { alive(signal); throw new Error(`已保存到索引版本 ${receipt.revision}，页面刷新未完成。请重新读取索引。`, { cause: problem }); }
  });
  function close() { closed.current = true; current.current?.abort(); current.current = null; onClose(); }
  const mapsQuery = draft.formattedAddress.trim() || draft.streetAddress.trim() || location.raw;
  return <section ref={section} className="atlas-office-review" aria-label="核对并保存办公地址" aria-busy={busy}>
    <header><h3><MapPin size={16} />核对具体办公地址</h3><button type="button" aria-label="关闭办公地址核对" onClick={close}><X size={16} /></button></header>
    <p>来源地点原文：<strong>{location.raw}</strong></p>
    <p className="atlas-office-boundary">保存的是本人核对的地址与位置，始终标为待核实。城市分布参考不能直接升级成楼宇坐标；Google 地图链接只打开查询，不代表本系统已经核验。</p>
    {!eligible ? <p role="note">请先确认该地点是有来源证据的工作地点。远程资格范围与性质未明的地点不能保存为办公地址。</p> : <>
      <div className="atlas-office-candidate-tools"><label>具体地址查询<input aria-label="办公地址查询" maxLength={2000} disabled={locked} value={query} placeholder="输入来源披露的街道、门牌、楼宇或园区" onChange={event => editQuery(event.target.value, "address")} /></label>
        <div className="atlas-office-query-constraints">
          <label>限定城市（可选）<input aria-label="办公地址限定城市" maxLength={200} disabled={locked} value={queryLocality} placeholder="上海市 / New York" onChange={event => editQuery(event.target.value, "locality")} /></label>
          <label>限定邮编（可选）<input aria-label="办公地址限定邮编" maxLength={100} disabled={locked} value={queryPostalCode} placeholder="保留原文和前导零" onChange={event => editQuery(event.target.value, "postalCode")} /></label>
        </div>
        <p id={queryHelpId} className="atlas-small">城市填写地图使用的名称，邮编按原文填写。点击查询时，所填地址及限定条件会发送给地址服务核对；未匹配的结果不会成为办公地址候选。</p>
        {prefillFromSourceAddress && <p role="note">已预填岗位来源披露的地址。点击“查询地址候选”后才会发送给地址服务；候选只用于临时定位，仍需本人核对和确认。</p>}
        <div className="atlas-office-query-actions"><button type="button" disabled={locked} onClick={() => void readCandidates(false)}>读取地址来源与查询配置</button>
          <button type="button" disabled={locked || !query.trim()} aria-describedby={queryHelpId} onClick={() => void readCandidates(true)}><Search size={13} />查询地址候选</button></div>
      </div>
      {candidates && <div className="atlas-office-candidates" aria-label="办公地址候选">
        {candidates.status === "not-configured" && <p>宿主尚未配置地址查询服务，可继续手工填写并核对。</p>}
        {candidates.status === "manual-available" && <p>已读取来源地址。外部查询仅在填写具体地址并点击查询后执行。</p>}
        {candidates.status === "no-address-match" && <p>本次没有找到地址候选；不能据此判断岗位没有办公地址。</p>}
        {staleCandidates && <p role="status">索引已更新，请重新读取地址候选。</p>}
        {candidates.candidates.map(candidate => {
          const comparison = evaluateOfficeAddressCandidate(candidates.sourceLocation, candidate);
          return <article key={candidate.id}><strong>{candidate.proposal.formattedAddress}</strong><small>{candidate.attribution} · 估算候选 · 待核实</small>
          <section className="atlas-office-field-check" aria-label="地址字段核对">
            <header><strong>来源字段核对</strong><span>{comparison.matches} 项匹配 · {comparison.conflicts} 项冲突 · {comparison.unknowns} 项未知</span></header>
            <p>仅比较结构化字段；完整地址、原文和坐标不作为匹配证据。字段对照不代表办公地址已核实。</p>
            <dl><div className="atlas-office-field-check-head" aria-hidden="true"><dt>字段</dt><dd><span>来源岗位</span><span></span><span>地址候选</span><span>状态</span></dd></div>
              {comparison.fields.map(field => <div key={field.field} data-status={field.status}>
              <dt>{matchFieldLabels[field.field]}</dt>
              <dd><span>{field.sourceValue ?? "未知"}</span><span aria-hidden="true">→</span><span>{field.candidateValue ?? "未知"}</span><b>{matchStatusLabels[field.status]}</b></dd>
            </div>)}</dl>
          </section>
          <p>{meaning[candidate.proposal.coordinateMeaning]} · WGS84 {candidate.proposal.coordinates.latitude}, {candidate.proposal.coordinates.longitude}</p>
          <a href={candidate.evidenceUrl} target="_blank" rel="noopener noreferrer">查看候选出处<ArrowUpRight size={12} /></a>
          {onCandidateFocus && <button type="button" disabled={locked || staleCandidates} onClick={() => onCandidateFocus(candidate)}><MapPin size={13} />定位候选到地图</button>}
          <button type="button" disabled={locked || staleCandidates} onClick={() => edit(candidateDraft(candidate.proposal, draft.reason))}>填入表单，继续人工核对</button></article>;
        })}
        {candidates.warnings.map(warning => <p className="atlas-small" key={warning}>{warning}</p>)}
      </div>}
      <fieldset disabled={locked}><legend>本人核对的地址与坐标</legend>
        <label>国家／地区<select aria-label="办公地址国家地区" value={draft.country} onChange={event => edit({ country: event.target.value })}><option value="">请选择</option>{countries.countries.map(code => <option value={code} key={code}>{regionNames.of(code) ?? code} · {code}</option>)}</select></label>
        <label>完整办公地址<input aria-label="完整办公地址" maxLength={2000} value={draft.formattedAddress} onChange={event => edit({ formattedAddress: event.target.value })} /></label>
        <label>街道与门牌／楼宇<input aria-label="办公街道门牌" maxLength={1000} value={draft.streetAddress} onChange={event => edit({ streetAddress: event.target.value })} /></label>
        <label>邮政编码（可选）<input aria-label="办公地址邮编" maxLength={100} value={draft.postalCode} onChange={event => edit({ postalCode: event.target.value })} /></label>
        <div className="atlas-office-coordinate-grid"><label>WGS84 纬度<input aria-label="办公地址纬度" type="number" min="-90" max="90" step="any" value={draft.latitude} onChange={event => edit({ latitude: event.target.value })} /></label>
          <label>WGS84 经度<input aria-label="办公地址经度" type="number" min="-180" max="180" step="any" value={draft.longitude} onChange={event => edit({ longitude: event.target.value })} /></label></div>
        <label>坐标对应位置<select aria-label="办公坐标含义" value={draft.coordinateMeaning} onChange={event => edit({ coordinateMeaning: event.target.value as Draft["coordinateMeaning"] })}>{Object.entries(meaning).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>地址依据链接<input aria-label="办公地址依据链接" type="url" maxLength={4096} value={draft.evidenceUrl} placeholder="https://… 原岗位或可核对的地址出处" onChange={event => edit({ evidenceUrl: event.target.value })} /></label>
        <label>核对／撤销说明<textarea aria-label="办公地址核对说明" maxLength={500} value={draft.reason} placeholder="说明该具体地址与此岗位的关联，以及坐标核对依据。" onChange={event => edit({ reason: event.target.value })} /></label>
      </fieldset>
      <a className="atlas-office-maps" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`} target="_blank" rel="noopener noreferrer">在 Google 地图核对地址<ArrowUpRight size={13} /></a>
      {HttpUrlSchema.safeParse(draft.evidenceUrl).success && <a className="atlas-office-maps" href={draft.evidenceUrl} target="_blank" rel="noopener noreferrer">打开填写的地址依据<ArrowUpRight size={13} /></a>}
      {!saved && <button type="button" disabled={locked} onClick={() => void readPreview()}>预览办公地址变更</button>}
      {preview && !saved && <div className="atlas-office-preview"><h4>拟保存的本人地址确认</h4><p><strong>{preview.value.proposed.officeResolution?.formattedAddress}</strong></p>
        <p>{preview.value.proposed.countryCode} · {preview.value.proposed.streetAddress}{preview.value.proposed.postalCode && ` · ${preview.value.proposed.postalCode}`}</p>
        <p>WGS84 {preview.value.proposed.coordinates?.latitude}, {preview.value.proposed.coordinates?.longitude} · {meaning[preview.input.proposal.coordinateMeaning]} · 本人核对／待核实</p>
        <p>基于索引版本 {preview.input.expectedRevision}；来源原文和证据保留。</p>{preview.value.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {stalePreview && <p role="status">索引已更新，本预览已失效，请重新预览。</p>}
        <label><input type="checkbox" checked={reviewed} disabled={busy || !!pending || stalePreview} onChange={event => setReviewed(event.target.checked)} />我已核对岗位与具体办公地址的关联、坐标及出处，确认保存为本人核对且待核实的位置</label>
        <button type="button" disabled={busy || !!pending || !reviewed || stalePreview} onClick={() => void commit("confirm")}>确认保存办公地址</button>
      </div>}
      {location.officeResolution && !saved && <div className="atlas-office-revoke"><label><input type="checkbox" checked={revokeReviewed} disabled={busy || !!pending} onChange={event => setRevokeReviewed(event.target.checked)} />撤销当前这条办公地址确认，恢复上一条有效确认或来源／地区位置</label>
        <button type="button" disabled={busy || !!pending || !revokeReviewed || !draft.reason.trim()} onClick={() => void commit("revoke")}>撤销当前办公地址确认</button></div>}
      {pending && !saved && <button type="button" disabled={busy} onClick={() => void commit(pending.kind)}>重试本次地址写入 · 核对回执</button>}
      {busy && <p role="status"><Loader2 size={15} className="animate-spin" />正在处理办公地址请求…</p>}
      {saved && <p className="atlas-office-saved" role="status"><Check size={15} />已保存到索引版本 {saved.revision}。{saved.location.officeResolution ? "本人地址确认仍标为待核实。" : "已恢复有效的来源／地区位置。"}</p>}
      {error && <p role="alert" className="atlas-error">{error}</p>}
      <button type="button" disabled={busy || !!pending} onClick={() => void refresh()}>重新读取索引</button>
    </>}
  </section>;
}
