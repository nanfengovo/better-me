/** @jsxRuntime automatic */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, History, Loader2, WalletCards, X } from "lucide-react";
import {
  HttpUrlSchema, PreviewCompensationReviewInputSchema, normalizeCompensation, sameCompensationReviewValue, applyCompensationReviewConfirmation,
  type AtlasDataset, type Compensation, type CompensationReviewProposal, type CompensationReviewPreview,
  type CompensationReviewReceipt, type CompensationReviewReadResult, type ConfirmCompensationReviewInput,
  type PreviewCompensationReviewInput, type RevokeCompensationReviewInput, type EvidenceRef,
} from "@better-me/opportunities";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import "./AtlasCompensationReview.css";

export type AtlasCompensationReviewProps = {
  endpoint: string; token: string; data: AtlasDataset; jobId: string;
  onSnapshot: (data: AtlasDataset) => void; onClose: () => void;
};
type Field = CompensationReviewProposal["supports"][number]["field"];
type Draft = Record<Field, string> & { reason: string };
type SupportDraft = Partial<Record<Field, { document: string; quote: string }>>;
type EvidenceDocument = { id: string; label: string; text: string; reference: EvidenceRef; snapshotId?: string };
type Write = { kind: "confirm"; input: ConfirmCompensationReviewInput; key: string }
  | { kind: "revoke"; input: RevokeCompensationReviewInput; key: string };
type Operation = "read" | "preview" | "write" | "snapshot";
const fields: Field[] = ["min", "max", "currency", "period", "tax", "kind", "monthsPerYear", "hoursPerYear", "daysPerYear", "weeksPerYear"];
const labels: Record<Field, string> = { min: "薪资下限", max: "薪资上限", currency: "薪资币种", period: "薪资周期", tax: "税前税后口径", kind: "薪资组成",
  monthsPerYear: "每年保证发薪月数", hoursPerYear: "每年保证计薪小时", daysPerYear: "每年保证计薪天数", weeksPerYear: "每年保证计薪周数" };
const periods = { unknown: "未披露", hour: "每小时", day: "每日", week: "每周", month: "每月", year: "每年" };
const taxes = { unknown: "未披露", gross: "明确税前", net: "明确税后" };
const kinds = { unknown: "未披露", base: "固定／基本工资", bonus: "奖金", equity: "股票／股权", total: "总薪酬" };
const annualField = { hour: "hoursPerYear", day: "daysPerYear", week: "weeksPerYear", month: "monthsPerYear" } as const;
const numericFields = new Set<Field>(["min", "max", "monthsPerYear", "hoursPerYear", "daysPerYear", "weeksPerYear"]);
const emptyDraft = (): Draft => ({ min: "", max: "", currency: "", period: "unknown", tax: "unknown", kind: "unknown",
  monthsPerYear: "", hoursPerYear: "", daysPerYear: "", weeksPerYear: "", reason: "" });
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const same = sameCompensationReviewValue;
function scalar(compensation: Compensation, field: Field) {
  const value = compensation[field];
  if (field === "period") return periods[compensation.period];
  if (field === "tax") return taxes[compensation.tax];
  if (field === "kind") return kinds[compensation.kind];
  return value === undefined ? "未披露" : typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : value;
}
function reasons(compensation: Compensation) {
  const result: string[] = [];
  if (compensation.verification === "conflicting") result.push("来源金额存在冲突，需要分别核对。");
  if (compensation.verification === "unknown") result.push("尚未形成可用于比较的薪资披露依据。");
  if (!compensation.evidence.some(reference => reference.quote?.trim() || reference.selector?.trim())) result.push("缺少绑定具体披露段落或字段的证据。");
  if (compensation.kind !== "base") result.push(compensation.kind === "unknown" ? "未明确属于固定／基本工资。" : "奖金、股票和总薪酬不计入固定年薪比较。");
  if (compensation.tax !== "gross") result.push(compensation.tax === "net" ? "这是税后金额，不能当作税前金额。" : "原文未明确税前口径，不能按惯例推断。");
  if (compensation.min === undefined && compensation.max === undefined) result.push("缺少明确金额。");
  if (!compensation.currency) result.push("缺少明确币种。");
  if (compensation.period === "unknown") result.push("缺少明确计薪周期。");
  if (compensation.period === "month" && compensation.monthsPerYear === undefined) result.push("未披露每年保证发薪月数，不能把“最高几薪”作为保证。");
  if (compensation.period === "hour" && compensation.hoursPerYear === undefined) result.push("缺少每年保证计薪小时，不默认全职工时。");
  if (compensation.period === "day" && compensation.daysPerYear === undefined) result.push("缺少每年保证计薪天数。");
  if (compensation.period === "week" && compensation.weeksPerYear === undefined) result.push("缺少每年保证计薪周数。");
  const normalized = normalizeCompensation(compensation);
  if (!result.length && normalized.status !== "comparable") result.push(normalized.reason.startsWith("fx-")
    ? "已保留原币年薪；此面板没有可核对的有效汇率，人民币比较需另行提供同版汇率依据。" : "当前披露仍不满足固定税前年薪比较条件。");
  return result;
}
function SalaryStatus({ compensation }: { compensation: Compensation }) {
  const issues = reasons(compensation), normalized = normalizeCompensation(compensation);
  const amount = normalized.cnyAnnual ?? normalized.originalAnnual;
  return <div className="atlas-compensation-status">
    {amount && <p><strong>{amount.currency} {amount.min?.toLocaleString("zh-CN") ?? "未披露下限"} – {amount.max?.toLocaleString("zh-CN") ?? "未披露上限"}／年</strong>{normalized.cnyAnnual ? " · 可按税前固定工资比较" : " · 仅原币年薪"}</p>}
    {issues.length ? <ul aria-label="薪资不可比较原因">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p>当前披露具备人民币税前固定年薪比较条件；核对不等于雇主或官方认证。</p>}
  </div>;
}
function documents(data: AtlasDataset, listingId: string, source: Compensation): EvidenceDocument[] {
  const listing = data.listings.find(value => value.id === listingId);
  if (!listing) return [];
  const result: EvidenceDocument[] = [];
  const observationIds = new Set(listing.observationIds);
  const snapshots = new Map<string, AtlasDataset["snapshots"]>();
  for (const snapshot of data.snapshots) if (snapshot.listingId === listingId) snapshots.set(snapshot.observationId, [...(snapshots.get(snapshot.observationId) ?? []), snapshot]);
  for (const observation of data.observations.filter(value => value.listingId === listingId && observationIds.has(value.id)
    && value.result !== "failed" && value.result !== "needs-human").sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)).slice(0, 50)) {
    const original = source.evidence.find(value => value.observationId === observation.id);
    const sourceUrl = original?.sourceUrl ?? listing.canonicalUrl ?? listing.applicationUrl;
    const observedAt = original?.observedAt ?? observation.detailFetchedAt ?? observation.fetchedAt;
    if (observation.rawText?.trim() && sourceUrl) result.push({ id: `observation:${observation.id}`, label: `已存观察原文 · ${date(observation.fetchedAt)}`,
      text: observation.rawText, reference: { observationId: observation.id, sourceUrl, observedAt } });
    for (const snapshot of snapshots.get(observation.id) ?? []) {
      const url = snapshot.sourceUrl ?? sourceUrl;
      if (url) result.push({ id: `snapshot:${snapshot.id}`, label: `已存岗位正文 · ${date(snapshot.createdAt)}`, text: snapshot.text,
        reference: { observationId: observation.id, sourceUrl: url, observedAt }, snapshotId: snapshot.id });
    }
  }
  return result;
}

/** Reviews one current listing disclosure; connection and job changes cancel the old session. */
export function AtlasCompensationReview(props: AtlasCompensationReviewProps) {
  return <JobCompensationReview key={JSON.stringify([props.endpoint, props.token, props.jobId])} {...props} />;
}
function JobCompensationReview(props: AtlasCompensationReviewProps) {
  const job = props.data.jobs.find(value => value.id === props.jobId);
  const choices = props.data.compensations.filter(value => job?.compensationIds.includes(value.id));
  const [selected, setSelected] = useState(() => choices[0]?.id ?? "");
  const [open, setOpen] = useState(true);
  const compensationId = choices.some(value => value.id === selected) ? selected : choices[0]?.id ?? "";
  const listingIds = props.data.listings.filter(value => job?.listingIds.includes(value.id) && value.compensationIds?.includes(compensationId)).map(value => value.id).sort();
  const onClose = props.onClose;
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); setOpen(false); onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose, open]);
  function close() { setOpen(false); props.onClose(); }
  if (!open) return null;
  return <section className="atlas-compensation-review" aria-label="核对岗位薪资">
    <header><h3><WalletCards size={16} />核对岗位薪资</h3><button type="button" aria-label="关闭薪资核对" onClick={close}><X size={16} /></button></header>
    <p className="atlas-compensation-boundary">按已保存的来源原文逐项核对。保存的是本人核对，仍标为待核实，不代表雇主或官方认证；不会推断税前口径、保证月数、奖金或股票。</p>
    {!job || !choices.length ? <p role="note">当前岗位没有可核对的薪资披露，请先读取并保存原岗位的真实薪资原文。</p> : <>
      {choices.length > 1 && <label>选择薪资披露<select aria-label="选择薪资披露" value={compensationId} onChange={event => setSelected(event.target.value)}>{choices.map(value => <option key={value.id} value={value.id}>{value.raw}</option>)}</select></label>}
      <CompensationSession key={JSON.stringify([compensationId, listingIds])} {...props} compensationId={compensationId} />
    </>}
  </section>;
}
function CompensationSession({ endpoint, token, data, jobId, compensationId, onSnapshot }: AtlasCompensationReviewProps & { compensationId: string }) {
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const helpId = useId();
  const [review, setReview] = useState<CompensationReviewReadResult>();
  const [draft, setDraft] = useState(emptyDraft), [supports, setSupports] = useState<SupportDraft>({});
  const [preview, setPreview] = useState<{ input: PreviewCompensationReviewInput; value: CompensationReviewPreview }>();
  const [reviewed, setReviewed] = useState(false), [revokeReviewed, setRevokeReviewed] = useState(false);
  const [pending, setPending] = useState<Write>(), [saved, setSaved] = useState<CompensationReviewReceipt>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [openDocument, setOpenDocument] = useState(""), [historyLimit, setHistoryLimit] = useState(30);
  const current = useRef<{ controller: AbortController; kind: Operation } | null>(null), closed = useRef(false);
  const latestRevision = useRef(data.revision); latestRevision.current = data.revision;
  const source = review?.sourceCompensation ?? data.compensations.find(value => value.id === compensationId)!;
  // The parent snapshot drives current comparison, while the explicitly read review
  // remains unchanged as the basis of the user's in-progress edit and preview.
  const currentCompensation = data.compensations.find(value => value.id === compensationId) ?? source;
  const listing = review ? data.listings.find(value => value.id === review.listingId) : undefined;
  const sourceName = data.sources.find(value => value.sourceId === listing?.sourceId)?.attribution.label ?? "岗位原始来源";
  const evidenceDocuments = useMemo(() => review ? documents(data, review.listingId, review.sourceCompensation) : [], [data, review]);
  const visibleDocument = evidenceDocuments.find(document => document.id === openDocument) ?? evidenceDocuments[0];
  const locked = busy || !!pending || !!saved;
  const staleReview = !!review && review.revision !== data.revision;
  const stalePreview = !!preview && preview.input.expectedRevision !== data.revision;
  const shownFields = fields.filter(field => !["monthsPerYear", "hoursPerYear", "daysPerYear", "weeksPerYear"].includes(field)
    || annualField[draft.period as keyof typeof annualField] === field);
  useEffect(() => {
    closed.current = false;
    return () => { closed.current = true; current.current?.controller.abort(); current.current = null; };
  }, []);
  useEffect(() => {
    // A changed index never permits a late preview or read to become a new write.
    if (current.current && current.current.kind !== "snapshot") current.current.controller.abort();
  }, [data.revision]);
  function alive(signal: AbortSignal) {
    signal.throwIfAborted();
    if (closed.current || current.current?.controller.signal !== signal) throw new Error("本次薪资核对已关闭。");
  }
  async function run(kind: Operation, action: (signal: AbortSignal) => Promise<void>) {
    if (closed.current || current.current) return;
    const controller = new AbortController(); current.current = { controller, kind }; setBusy(true); setError("");
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try { await action(controller.signal); }
    catch (problem) {
      if (current.current?.controller === controller && !closed.current) setError(controller.signal.aborted
        ? current.current.kind === "write" ? "已停止等待，写入可能已完成。请保留本面板，核对本次保存回执。"
          : kind === "write" ? "保存回执已确认，索引读取已停止。请重新读取索引，不要再次保存。" : "索引已更新或已停止等待，请重新读取后继续核对。"
        : problem instanceof Error ? problem.message : "本次薪资核对未完成。");
    } finally { clearTimeout(timeout); if (current.current?.controller === controller) { current.current = null; setBusy(false); } }
  }
  function edit(field: keyof Draft, value: string) {
    if (locked) return;
    setDraft(previous => field === "period" ? { ...previous, [field]: value, monthsPerYear: "", hoursPerYear: "", daysPerYear: "", weeksPerYear: "" } : { ...previous, [field]: value });
    setPreview(undefined); setReviewed(false); setRevokeReviewed(false); setError("");
  }
  function editSupport(field: Field, update: Partial<{ document: string; quote: string }>) {
    if (locked) return;
    setSupports(previous => ({ ...previous, [field]: { document: "", quote: "", ...previous[field], ...update } }));
    setPreview(undefined); setReviewed(false); setRevokeReviewed(false); setError("");
  }
  const read = () => run("read", async signal => {
    const result = await client.readCompensationReview({ jobId, compensationId, expectedRevision: data.revision }, { signal }); alive(signal);
    if (result.revision !== latestRevision.current) throw new Error("索引已更新，已丢弃旧薪资依据，请重新读取。");
    const effective = data.compensations.find(value => value.id === compensationId);
    if (!same(result.current, effective)) throw new Error("薪资依据与当前页面不一致，请先重新读取索引。");
    setReview(result); setPreview(undefined); setReviewed(false); setRevokeReviewed(false); setSaved(undefined); setDraft(emptyDraft()); setSupports({});
  });
  function proposal(): CompensationReviewProposal {
    const values: Record<string, unknown> = { basis: "manual-evidence-review", period: draft.period, tax: draft.tax, kind: draft.kind };
    const references: CompensationReviewProposal["supports"] = [];
    for (const field of shownFields) {
      const value = draft[field].trim();
      if (!value || value === "unknown") continue;
      values[field] = numericFields.has(field) ? Number(value) : field === "currency" ? value.toUpperCase() : value;
      const support = supports[field], document = evidenceDocuments.find(entry => entry.id === support?.document), quote = support?.quote.trim();
      if (!document || !quote || !document.text.includes(quote)) throw new Error(`${labels[field]}需要选取本岗位已保存的来源，并逐字引用其中的真实原句。`);
      references.push({ field, reference: { ...document.reference, quote }, ...(document.snapshotId ? { snapshotId: document.snapshotId } : {}) });
    }
    values.supports = references;
    return values as CompensationReviewProposal;
  }
  const readPreview = () => run("preview", async signal => {
    if (!review || staleReview) throw new Error("请先读取当前版本的薪资依据与历史。");
    const parsed = PreviewCompensationReviewInputSchema.safeParse({ jobId, compensationId, expectedRevision: data.revision, proposal: proposal(), reason: draft.reason.trim() });
    if (!parsed.success) throw new Error("请检查金额范围、币种、周期、明确披露的年化参数与核对说明；未披露的字段请留空或选择未披露。");
    try { applyCompensationReviewConfirmation(review.sourceCompensation, { compensationId, sourceCompensation: review.sourceCompensation, proposal: parsed.data.proposal }); }
    catch (problem) {
      const field = problem instanceof Error ? problem.message.split(":")[1] : undefined;
      throw new Error(`${field && field in labels ? labels[field as Field] : "所填字段"}的引用原句没有明确支持所选值。请改用能明确说明该字段的原文，或保留未披露。`, { cause: problem });
    }
    const result = await client.previewCompensationReview(parsed.data, { signal }); alive(signal);
    if (result.expectedRevision !== latestRevision.current) throw new Error("索引已更新，已丢弃旧预览，请重新读取后预览。");
    if (!same(result.sourceCompensation, review.sourceCompensation) || !same(result.current, review.current) || result.listingId !== review.listingId)
      throw new AtlasSourceServiceError("invalid-response", "薪资预览的来源或当前值不一致，请重新读取依据。");
    setPreview({ input: parsed.data, value: result }); setReviewed(false); setRevokeReviewed(false);
  });
  async function snapshot(signal: AbortSignal, revision: number) {
    const next = await client.snapshot({ signal }); alive(signal);
    if (next.revision < Math.max(revision, latestRevision.current)) throw new Error("尚未读取到当前或已保存的索引版本，请重试读取。");
    onSnapshot(next);
  }
  const refresh = () => run("snapshot", signal => snapshot(signal, saved?.revision ?? data.revision));
  const commit = (kind: Write["kind"]) => run("write", async signal => {
    if (!pending && (kind === "confirm" ? !preview || !reviewed || stalePreview || staleReview : !review?.activeDecisionId || !revokeReviewed || staleReview || !draft.reason.trim())) return;
    const write: Write = pending ?? (kind === "confirm"
      ? { kind, input: { ...preview!.input, previewFingerprint: preview!.value.previewFingerprint, reviewed: true }, key: `salary-${crypto.randomUUID()}` }
      : { kind, input: { jobId, compensationId, decisionId: review!.activeDecisionId!, expectedRevision: data.revision, reason: draft.reason.trim(), reviewed: true }, key: `salary-revoke-${crypto.randomUUID()}` });
    setPending(write);
    let receipt: CompensationReviewReceipt;
    try { receipt = write.kind === "confirm" ? await client.confirmCompensationReview(write.input, { signal, idempotencyKey: write.key })
      : await client.revokeCompensationReview(write.input, { signal, idempotencyKey: write.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized", "conflict", "not-found"].includes(problem.code)) {
        alive(signal); setPending(undefined); setPreview(undefined); setReviewed(false); setRevokeReviewed(false);
      }
      throw problem;
    }
    alive(signal);
    if (receipt.compensation.raw !== source.raw || !source.evidence.every(reference => receipt.compensation.evidence.some(value => same(value, reference)))
      || !same(receipt.compensation.locationIds, source.locationIds) || write.kind === "confirm" && preview && !same(receipt.compensation, preview.value.proposed))
      throw new AtlasSourceServiceError("invalid-response", "保存回执中的来源原文、证据或适用地点发生变化，请沿用本次请求核对回执。");
    setSaved(receipt); setPending(undefined);
    if (current.current?.controller.signal === signal) current.current.kind = "snapshot";
    try { await snapshot(signal, receipt.revision); }
    catch (problem) { alive(signal); throw new Error(`已保存到索引版本 ${receipt.revision}，页面读取未完成。请重新读取索引，不要再次保存。`, { cause: problem }); }
  });
  return <div aria-busy={busy} className="atlas-compensation-session">
    <p>来源薪资原文{review && `（读取自索引版本 ${review.revision}）`}：<strong className="atlas-compensation-raw">{source.raw}</strong></p>
    <div className="atlas-compensation-current-status" aria-label="当前版本薪资比较状态"><p>当前索引版本 {data.revision} 的有效薪资</p><SalaryStatus compensation={currentCompensation} /></div>
    <button type="button" disabled={busy || !!pending} onClick={() => void read()}><History size={13} />读取薪资依据与历史</button>
    {review && <>
      <p className="atlas-compensation-provenance">{sourceName} · 索引版本 {review.revision}{listing?.canonicalUrl && HttpUrlSchema.safeParse(listing.canonicalUrl).success && <a href={listing.canonicalUrl} target="_blank" rel="noopener noreferrer">打开原岗位<ArrowUpRight size={12} /></a>}</p>
      {source.locationIds?.length ? <p>适用地点：{source.locationIds.map(id => data.locations.find(value => value.id === id)?.raw ?? "已移除地点").join("；")}</p> : <p>来源未限定到单独地点，本次不会补造办公室范围。</p>}
      <details className="atlas-compensation-current"><summary>查看读取时的来源字段与有效值（版本 {review.revision}）</summary><table><thead><tr><th>字段</th><th>来源披露</th><th>读取时有效值 · 版本 {review.revision}</th></tr></thead><tbody>{fields.map(field => <tr key={field}><th scope="row">{labels[field]}</th><td>{scalar(source, field)}</td><td>{scalar(review.current, field)}</td></tr>)}</tbody></table></details>
      <details className="atlas-compensation-evidence"><summary>查看可引用的已存原文（{evidenceDocuments.length} 份）</summary><p>显示最近 50 次成功或部分读取中的原文，历史版本的采集时间不代表岗位发布时间。</p>{visibleDocument && <><label>原文版本<select aria-label="查看薪资原文版本" value={visibleDocument.id} onChange={event => setOpenDocument(event.target.value)}>{evidenceDocuments.map(document => <option value={document.id} key={document.id}>{document.label}</option>)}</select></label><article><strong>{visibleDocument.label}</strong><a href={visibleDocument.reference.sourceUrl} target="_blank" rel="noopener noreferrer">查看出处<ArrowUpRight size={12} /></a><pre>{visibleDocument.text}</pre></article></>}</details>
      {!evidenceDocuments.length && <p role="note">当前没有可逐字引用的同来源观察或岗位正文。请先读取并保存真实原文，再核对字段；仅有链接不足以确认税前、固定工资或保证月数。</p>}
      {staleReview && <p role="status">索引已更新至版本 {data.revision}。本次核对保留版本 {review.revision} 的读取结果，未提交预览已失效；需继续编辑时，请重新读取薪资依据。</p>}
      <p id={helpId} className="atlas-compensation-help">金额以原币基本单位填写，例如 20k 填 20000。逐字段选取同一原岗位的已存观察／正文并引用原句；同一原句可分别支持多项。没有明确披露就保留未披露或留空。选择“税前”“固定工资”和保证计薪数量都需要原文明确支持。</p>
      <fieldset disabled={locked || staleReview || !evidenceDocuments.length} aria-describedby={helpId}><legend>本人按原文核对的薪资字段</legend>
        {shownFields.map(field => <div className="atlas-compensation-field" key={field}>
          <label>{labels[field]}{field === "period" || field === "tax" || field === "kind" ? <select aria-label={labels[field]} value={draft[field]} onChange={event => edit(field, event.target.value)}>{Object.entries(field === "period" ? periods : field === "tax" ? taxes : kinds).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
            : <input aria-label={labels[field]} type={numericFields.has(field) ? "number" : "text"} min={numericFields.has(field) ? "0" : undefined} step={numericFields.has(field) ? "any" : undefined} maxLength={field === "currency" ? 3 : undefined} placeholder={field === "currency" ? "CNY / USD / EUR" : "未披露则留空"} value={draft[field]} onChange={event => edit(field, event.target.value)} />}</label>
          {draft[field].trim() && draft[field] !== "unknown" && <div className="atlas-compensation-field-support">
            <label>{labels[field]}引用来源<select aria-label={`${labels[field]}引用来源`} value={supports[field]?.document ?? ""} onChange={event => editSupport(field, { document: event.target.value, quote: "" })}><option value="">请选择已保存的同岗原文</option>{evidenceDocuments.map(document => <option value={document.id} key={document.id}>{document.label}</option>)}</select></label>
            <label>{labels[field]}依据原句<textarea aria-label={`${labels[field]}依据原句`} maxLength={4000} rows={2} value={supports[field]?.quote ?? ""} placeholder="逐字摘录所选原文，不补写未披露信息" onChange={event => editSupport(field, { quote: event.target.value })} /></label>
          </div>}
        </div>)}
      </fieldset>
      <label>核对／撤销说明<textarea aria-label="薪资核对说明" maxLength={500} disabled={locked} rows={3} value={draft.reason} onChange={event => edit("reason", event.target.value)} placeholder="说明本次逐字段核对的依据或撤销原因。" /></label>
      {!saved && <button type="button" disabled={locked || staleReview || !evidenceDocuments.length} onClick={() => void readPreview()}>预览薪资变更</button>}
      {preview && !saved && <div className="atlas-compensation-preview"><h4>拟保存的本人薪资核对</h4><table><thead><tr><th>字段</th><th>当前值</th><th>拟保存值</th></tr></thead><tbody>{fields.map(field => <tr key={field}><th scope="row">{labels[field]}</th><td>{scalar(preview.value.current, field)}</td><td>{scalar(preview.value.proposed, field)}</td></tr>)}</tbody></table>
        <SalaryStatus compensation={preview.value.proposed} /><p>基于索引版本 {preview.input.expectedRevision}；原文、出处、岗位正文与适用地点保留。未填字段保存为未披露。</p>
        {preview.value.warnings.map(warning => <p key={warning}>{warning}</p>)}
        <details><summary>核对本次逐字段引用（{preview.input.proposal.supports.length} 项）</summary>{preview.input.proposal.supports.map(support => <blockquote key={support.field}><strong>{labels[support.field]}</strong><p>{support.reference.quote}</p><a href={support.reference.sourceUrl} target="_blank" rel="noopener noreferrer">查看出处<ArrowUpRight size={12} /></a></blockquote>)}</details>
        {stalePreview && <p role="status">索引已更新，本预览已失效，请重新读取后预览。</p>}
        <label className="atlas-compensation-check"><input type="checkbox" aria-label="确认本人已逐项核对薪资依据" checked={reviewed} disabled={busy || !!pending || stalePreview || staleReview} onChange={event => setReviewed(event.target.checked)} />我已逐项核对金额、币种、周期、税前与固定工资等原文依据，确认保存为本人核对、待核实的薪资披露</label>
        <button type="button" disabled={busy || !!pending || !reviewed || stalePreview || staleReview} onClick={() => void commit("confirm")}>确认保存薪资核对</button>
      </div>}
      {review.history.length > 0 && <details className="atlas-compensation-history"><summary>薪资核对历史（读取自版本 {review.revision}，共 {review.history.length} 条）</summary>{review.history.slice(-historyLimit).reverse().map(decision => <article key={decision.id}><strong>{decision.kind === "confirm" ? decision.id === review.activeDecisionId ? staleReview ? `读取时有效的本人核对 · 版本 ${review.revision}` : "当前有效的本人核对" : "历史本人核对" : decision.kind === "revoke" ? "本人已撤销核对" : "来源变化使核对失效"}</strong><time dateTime={decision.at}>{date(decision.at)}</time><p>{decision.kind === "invalidate" ? "来源披露已变化，先前核对不再用于当前计算。" : decision.reason}</p>{decision.kind === "confirm" && <details><summary>{decision.proposal.supports.length} 项字段依据 · 本人核对／待核实</summary>{decision.proposal.supports.map((support, index) => <blockquote key={`${support.field}:${index}`}><strong>{labels[support.field]}</strong><p>{support.reference.quote}</p><a href={support.reference.sourceUrl} target="_blank" rel="noopener noreferrer">查看历史出处<ArrowUpRight size={12} /></a><time dateTime={support.reference.observedAt}>原文采集：{date(support.reference.observedAt)}</time></blockquote>)}</details>}</article>)}{review.history.length > historyLimit && <button type="button" onClick={() => setHistoryLimit(value => value + 30)}>显示更早的薪资核对</button>}</details>}
      {review.activeDecisionId && !saved && <div className="atlas-compensation-revoke"><h4>撤销当前本人核对</h4><p>撤销后按后台记录恢复上一条仍有效的本人核对，或恢复来源披露；失效的历史不会重新生效。结果将通过重新读取索引更新到列表、地图和排序。</p>
        <label className="atlas-compensation-check"><input type="checkbox" aria-label="确认撤销当前薪资核对" disabled={busy || !!pending || staleReview} checked={revokeReviewed} onChange={event => setRevokeReviewed(event.target.checked)} />我已了解撤销影响，并填写真实撤销原因</label><button type="button" disabled={busy || !!pending || staleReview || !revokeReviewed || !draft.reason.trim()} onClick={() => void commit("revoke")}>撤销当前薪资核对</button>
      </div>}
    </>}
    {pending && !saved && <div className="atlas-compensation-pending"><p role="status">本次保存尚未收到可靠回执。原请求已保留，请先核对回执；不会用新内容重复保存。</p><button type="button" disabled={busy} onClick={() => void commit(pending.kind)}>核对本次薪资保存回执</button></div>}
    {saved && <p role="status" className="atlas-compensation-saved"><Check size={15} />已保存到索引版本 {saved.revision}。{saved.activeDecisionId ? "本人核对仍标为待核实。" : "已恢复来源披露或其他有效核对。"}</p>}
    {busy && <p role="status" className="atlas-compensation-busy"><Loader2 size={15} className="animate-spin" />正在处理薪资核对请求…</p>}
    {error && <p role="alert" className="atlas-error">{error}</p>}
    <button type="button" disabled={busy || !!pending} onClick={() => void refresh()}>重新读取索引</button>
  </div>;
}
