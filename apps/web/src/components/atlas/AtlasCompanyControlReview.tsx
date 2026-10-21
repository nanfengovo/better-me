/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, History, Loader2, RefreshCw, X } from "lucide-react";
import { CompanyControlReviewProposalSchema, effectiveCompanyControllers, resolveCompanyColor, sameCompanyControlReviewValue, type AtlasDataset, type Company,
  type CompanyColorConfig, type CompanyControlReviewProposal, type CompanyControlReviewReadResult, type CompanyControlReviewPreview,
  type CompanyControlReviewReceipt } from "@better-me/opportunities";
import { useUiPreferences, type UiTranslator } from "../../lib/ui-preferences";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";
import { atlasCompanyControlRecoveryScope, useAtlasCompanyControlRecovery, writeAtlasCompanyControlRecovery,
  type AtlasCompanyControlRecovery, type AtlasCompanyControlWrite } from "./company-control-recovery";
import "./AtlasCompanyControlReview.css";

export type AtlasCompanyControlReviewProps = {
  endpoint: string; token: string; data: AtlasDataset; jobId: string; companyId: string; colorConfig?: CompanyColorConfig;
  onSnapshot(snapshot: AtlasDataset): void; onClose(): void;
};
type Support = CompanyControlReviewProposal["supports"][number];
type DocumentDraft = CompanyControlReviewProposal["documents"][number];
type ControllerDraft = { name: string; kind: "state" | "private" | ""; jurisdictionCode: string };
type Draft = { documents: DocumentDraft[]; legalEntityName: string; parentCompanyName: string;
  status: CompanyControlReviewProposal["status"]; controlMode: CompanyControlReviewProposal["controlMode"];
  controllers: ControllerDraft[]; supports: Record<string, { documentIndex: number; quote: string }> };
const emptyDocument = (): DocumentDraft => ({ sourceUrl: "", retrievedAt: "", rawText: "" });
const emptyController = (): ControllerDraft => ({ name: "", kind: "", jurisdictionCode: "" });
const emptyDraft = (): Draft => ({ documents: [emptyDocument()], legalEntityName: "", parentCompanyName: "", status: "unknown", controlMode: "unknown", controllers: [emptyController()], supports: {} });
const supportKey = (field: Support["field"], controllerIndex?: number) => `${field}:${controllerIndex ?? ""}`;
function requiredSupports(draft: Draft): { field: Support["field"]; controllerIndex?: number }[] {
  const fields: { field: Support["field"]; controllerIndex?: number }[] = [{ field: "legalEntityName" }, { field: "status" }, { field: "controlMode" }];
  if (draft.parentCompanyName.trim()) fields.push({ field: "parentCompanyName" });
  if (draft.status === "resolved" && ["single", "joint"].includes(draft.controlMode)) draft.controllers.forEach((controller, controllerIndex) => {
    fields.push({ field: "controllerName", controllerIndex }, { field: "controllerKind", controllerIndex }, { field: "controllerControl", controllerIndex });
    if (controller.jurisdictionCode.trim()) fields.push({ field: "controllerJurisdiction", controllerIndex });
  });
  return fields;
}
function proposalFromDraft(draft: Draft): CompanyControlReviewProposal {
  return CompanyControlReviewProposalSchema.parse({ basis: "manual-evidence-review", documents: draft.documents,
    legalEntityName: draft.legalEntityName, ...(draft.parentCompanyName.trim() ? { parentCompanyName: draft.parentCompanyName } : {}),
    status: draft.status, controlMode: draft.status === "resolved" ? draft.controlMode : "unknown",
    controllers: draft.status === "resolved" && ["single", "joint"].includes(draft.controlMode) ? draft.controllers.map(controller => ({ name: controller.name, kind: controller.kind,
      ...(controller.jurisdictionCode.trim() ? { jurisdictionCode: controller.jurisdictionCode.trim() } : {}) })) : [],
    supports: requiredSupports(draft).map(reference => ({ ...reference, ...(draft.supports[supportKey(reference.field, reference.controllerIndex)] ?? { documentIndex: 0, quote: "" }) })),
  });
}
function supportLabel(field: Support["field"], t: UiTranslator): string {
  return { legalEntityName: t("实际雇主法定名称", "Employer legal name"), parentCompanyName: t("母公司名称", "Parent company name"),
    status: t("核对状态", "Review status"), controlMode: t("控制关系", "Control structure"), controllerName: t("控制方名称", "Controller name"),
    controllerKind: t("控制方性质", "Controller ownership"), controllerControl: t("最终控制关系", "Ultimate control relationship"), controllerJurisdiction: t("控制方来源国家／地区", "Controller origin") }[field];
}
function CompanySummary({ company, data, colorConfig }: { company: Company; data: AtlasDataset; colorConfig?: CompanyColorConfig }) {
  const { t } = useUiPreferences(), color = resolveCompanyColor(company, colorConfig), controllers = effectiveCompanyControllers(company);
  const parents = company.controlReview?.parentCompanyName ?? company.parentCompanyIds.map(id => data.companies.find(value => value.id === id)?.names[0]).filter(Boolean).join(" / ");
  return <><dl><div><dt>{t("实际雇主", "Employer")}</dt><dd>{company.legalEntity?.value ?? t("法定名称待核对", "Legal name unreviewed")}</dd></div>
    <div><dt>{t("母公司", "Parent")}</dt><dd>{parents || t("未确认", "Unconfirmed")}</dd></div>
    <div><dt>{t("最终控制方", "Ultimate control")}</dt><dd>{company.controlReview?.controlMode === "dispersed" ? t("股权分散／无实际控制人", "Dispersed ownership / no actual controller")
      : controllers.verification === "verified" ? controllers.value.map(value => `${value.name}${value.jurisdictionCode ? ` (${value.jurisdictionCode})` : ""}`).join(" / ") || t("未知", "Unknown") : t("待核实或存在冲突", "Unverified or conflicting")}</dd></div>
    <div><dt>{t("分类与颜色", "Classification")}</dt><dd><span style={{ borderInlineStart: `4px solid ${color.color}`, paddingInlineStart: 6 }}>{color.label} · {color.ownershipLabel}</span></dd></div></dl>
    {company.controlReview && <small className="atlas-company-review-marker">{t("本人核对，非发布机构认证", "Personally reviewed; not certified by the publisher")} · {company.controlReview.at}</small>}</>;
}
export function AtlasCompanyControlReview(props: AtlasCompanyControlReviewProps) {
  return <CompanySession key={JSON.stringify([props.endpoint, props.token, props.jobId, props.companyId])} {...props} />;
}
function CompanySession({ endpoint, token, data, jobId, companyId, colorConfig, onSnapshot, onClose }: AtlasCompanyControlReviewProps) {
  const { t } = useUiPreferences(), scope = atlasCompanyControlRecoveryScope(endpoint, token);
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const [record, setRecord] = useState<CompanyControlReviewReadResult>(), [draft, setDraft] = useState<Draft>(emptyDraft), [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ value: CompanyControlReviewPreview; proposal: CompanyControlReviewProposal; reason: string }>();
  const [reviewed, setReviewed] = useState(false), [revokeReviewed, setRevokeReviewed] = useState(false), [revokeReason, setRevokeReason] = useState("");
  const [busy, setBusy] = useState(false), [unsupported, setUnsupported] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [historyLimit, setHistoryLimit] = useState(20);
  const recovery = useAtlasCompanyControlRecovery(endpoint, token);
  const current = useRef<{ kind: "read" | "preview" | "write" | "snapshot"; controller: AbortController } | null>(null), closed = useRef(false);
  const latest = useRef({ revision: data.revision, onSnapshot }); latest.current = { revision: data.revision, onSnapshot };
  const parentCompany = data.companies.find(company => company.id === companyId);
  const available = record?.revision === data.revision && !unsupported;
  const locked = busy || Boolean(recovery.pending || recovery.saved);
  const stalePreview = !preview || preview.value.expectedRevision !== data.revision;
  function remember(value: AtlasCompanyControlRecovery) { writeAtlasCompanyControlRecovery(scope, value); }
  useEffect(() => { closed.current = false; return () => { closed.current = true; current.current?.controller.abort(); current.current = null; }; }, []);
  useEffect(() => { if (current.current && !["write", "snapshot"].includes(current.current.kind)) current.current.controller.abort(); setReviewed(false); setRevokeReviewed(false); }, [data.revision]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, [onClose]);
  function alive(signal: AbortSignal) { signal.throwIfAborted(); if (closed.current || current.current?.controller.signal !== signal) throw new Error(t("本次企业核对已关闭。", "This company review is closed.")); }
  async function run(kind: NonNullable<typeof current.current>["kind"], action: (signal: AbortSignal) => Promise<void>) {
    if (closed.current || current.current) return;
    const operation = { kind, controller: new AbortController() }; current.current = operation; setBusy(true); setError("");
    const timer = setTimeout(() => operation.controller.abort(), 25_000);
    try { await action(operation.controller.signal); }
    catch (problem) { if (!closed.current && current.current === operation) setError(operation.controller.signal.aborted
      ? operation.kind === "write" ? t("已停止等待，写入可能已完成。请核对本次企业保存回执。", "Stopped waiting; the write may have completed. Recover this company receipt.")
        : operation.kind === "snapshot" ? t("保存已确认。请重新读取索引，不要再次保存。", "Save confirmed. Reload the index; do not save again.") : t("读取已停止或索引已更新，请重新读取。", "Read stopped or index changed. Reload the record.")
      : problem instanceof Error ? problem.message : t("企业核对未完成。", "Company review did not complete.")); }
    finally { clearTimeout(timer); if (current.current === operation) { current.current = null; setBusy(false); } }
  }
  function edit(change: (previous: Draft) => Draft) { if (locked) return; setDraft(change); setPreview(undefined); setReviewed(false); setError(""); }
  const read = () => run("read", async signal => {
    try {
      const value = await client.readCompanyControlReview({ jobId, companyId, expectedRevision: data.revision }, { signal }); alive(signal);
      if (value.revision !== latest.current.revision) throw new Error(t("已丢弃旧版本企业记录，请重新读取。", "Discarded an old company record. Reload it."));
      setRecord(value); setHistoryLimit(20); setUnsupported(false); setPreview(undefined); setReviewed(false); setRevokeReviewed(false);
    } catch (problem) { if (problem instanceof AtlasSourceServiceError && problem.status === 404) { alive(signal); setUnsupported(true); setRecord(undefined); } throw problem; }
  });
  const readPreview = () => run("preview", async signal => {
    if (!available) throw new Error(t("请先读取当前版本的企业核对记录。", "Load the company review for this index first."));
    let proposal: CompanyControlReviewProposal;
    try { proposal = proposalFromDraft(draft); } catch { throw new Error(t("请补齐证据出处、ISO读取时间、原文、每个字段的逐字引用和控制关系。引用须出现在所选原文中。", "Complete source URLs, ISO retrieval times, original text, verbatim field citations and control structure. Each quote must occur in its selected document.")); }
    if (!reason.trim()) throw new Error(t("请填写本次核对说明。", "Describe the reason for this review."));
    const value = await client.previewCompanyControlReview({ jobId, companyId, expectedRevision: data.revision, proposal, reason }, { signal }); alive(signal);
    if (value.expectedRevision !== latest.current.revision) throw new Error(t("已丢弃旧版本企业预览，请重新读取。", "Discarded an old preview. Reload the record."));
    setPreview({ value, proposal, reason }); setReviewed(false);
  });
  async function snapshot(signal: AbortSignal, revision: number, receipt?: CompanyControlReviewReceipt) {
    const value = await client.snapshot({ signal }); alive(signal);
    if (value.revision < Math.max(revision, latest.current.revision)) throw new Error(t("尚未读取到已保存版本，请重新读取索引。", "The saved index version is not yet available. Reload the index."));
    if (receipt && value.revision === receipt.revision && (!sameCompanyControlReviewValue(value.companies.find(company => company.id === receipt.companyId), receipt.company)
      || receipt.affectedJobIds.some(id => !value.jobs.some(job => job.id === id && job.companyId === receipt.companyId))))
      throw new Error(t("索引与同版企业回执不一致，请重新读取索引。", "The index does not match the company receipt at this revision. Reload the index."));
    latest.current.onSnapshot(value); remember({}); setRecord(undefined); setPreview(undefined); setReviewed(false); setRevokeReviewed(false);
    setNotice(t(`企业记录已更新，索引版本 ${value.revision}。分类、颜色、列表、地图与统计按同一版本重新计算。`, `Company records updated at revision ${value.revision}. Classification, colors, results, map and counts use the same version.`));
  }
  const refresh = () => run("snapshot", signal => snapshot(signal, recovery.saved?.revision ?? data.revision, recovery.saved));
  const commit = (kind: AtlasCompanyControlWrite["kind"]) => run("write", async signal => {
    if (!recovery.pending && (!available || (kind === "confirm" ? stalePreview || !reviewed : !record?.activeDecisionId || !revokeReviewed || !revokeReason.trim()))) return;
    const write: AtlasCompanyControlWrite = recovery.pending ?? (kind === "confirm"
      ? { kind, key: `company-control-confirm-${crypto.randomUUID()}`, input: { jobId, companyId, proposal: preview!.proposal, reason: preview!.reason,
        expectedRevision: preview!.value.expectedRevision, previewFingerprint: preview!.value.previewFingerprint, reviewed: true } }
      : { kind, key: `company-control-revoke-${crypto.randomUUID()}`, input: { jobId, companyId, decisionId: record!.activeDecisionId!, expectedRevision: data.revision, reason: revokeReason, reviewed: true } });
    remember({ pending: write }); let receipt: CompanyControlReviewReceipt;
    try { receipt = write.kind === "confirm" ? await client.confirmCompanyControlReview(write.input, { signal, idempotencyKey: write.key }) : await client.revokeCompanyControlReview(write.input, { signal, idempotencyKey: write.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "idempotency-conflict", "invalid-input", "not-authorized", "conflict", "not-found"].includes(problem.code)) {
        alive(signal); remember({}); setRecord(undefined); setPreview(undefined); setReviewed(false); setRevokeReviewed(false);
      }
      throw problem;
    }
    alive(signal); remember({ saved: receipt }); current.current!.kind = "snapshot";
    try { await snapshot(signal, receipt.revision, receipt); } catch (problem) { alive(signal); throw new Error(t(`已保存到版本 ${receipt.revision}，索引读取未完成。请重新读取索引，不要再次保存。`, `Saved at revision ${receipt.revision}; index reload failed. Reload the index; do not save again.`), { cause: problem }); }
  });
  const citation = (field: Support["field"], controllerIndex?: number) => {
    const key = supportKey(field, controllerIndex), value = draft.supports[key] ?? { documentIndex: 0, quote: "" }, label = `${controllerIndex === undefined ? "" : `${t("控制方", "Controller")} ${controllerIndex + 1} · `}${supportLabel(field, t)}`;
    return <div className="atlas-company-support" key={key}><label>{label} · {t("证据文档", "Evidence document")}<select aria-label={`${label} · ${t("证据文档", "Evidence document")}`} value={value.documentIndex} onChange={event => edit(previous => ({ ...previous, supports: { ...previous.supports, [key]: { ...value, documentIndex: Number(event.target.value) } } }))}>{draft.documents.map((_, index) => <option key={index} value={index}>{t("文档", "Document")} {index + 1}</option>)}</select></label>
      <label>{t("逐字引用", "Verbatim quote")}<textarea rows={2} aria-label={`${label} · ${t("引用原句", "Verbatim quote")}`} value={value.quote} maxLength={20000} onChange={event => edit(previous => ({ ...previous, supports: { ...previous.supports, [key]: { ...value, quote: event.target.value } } }))} /></label></div>;
  };
  return <section className="atlas-company-review" aria-label={t("企业控股证据核对", "Company control evidence review")} aria-busy={busy}>
    <header><div><span className="atlas-eyebrow">COMPANY / EVIDENCE</span><h2>{t("核对企业，追溯控制来源。", "Review the company and trace its control.")}</h2><small>{parentCompany?.names[0] ?? companyId}</small><small>{t(`关联 ${data.jobs.filter(job => job.companyId === companyId).length} 个当前岗位`, `Linked to ${data.jobs.filter(job => job.companyId === companyId).length} current jobs`)}</small></div><button type="button" aria-label={t("关闭企业核对", "Close company review")} onClick={onClose}><X size={17} /></button></header>
    <p>{t("导入公开企业披露原文，逐字段引用后由本人明确确认。系统核对引用和版本，不自动认证原文含义、发行机构或企业性质。公司名称、注册地与品牌印象不能替代最终控制来源。", "Import public disclosures and cite each field before explicitly confirming. The system checks citations and versions; it does not certify meaning, publishers or ownership. Names, registered addresses and brand impressions are not proof of ultimate control.")}</p>
    <div className="atlas-company-current"><strong>{t(`当前索引版本 ${data.revision}`, `Current index revision ${data.revision}`)}</strong>{parentCompany && <CompanySummary company={parentCompany} data={data} colorConfig={colorConfig} />}
      <button type="button" disabled={locked} onClick={() => void read()}><RefreshCw size={13} />{t("读取企业核对记录", "Read company review records")}</button>{unsupported && <p role="status">{t("此后端尚不支持企业控股核对，请升级岗位后端。现有岗位查询仍可使用。", "This backend does not support company control review yet. Upgrade it; existing job search remains available.")}</p>}</div>
    <fieldset disabled={locked || !available}><legend>{t("公开证据原文", "Public evidence documents")}</legend>
      {draft.documents.map((document, index) => <div className="atlas-company-document" key={index}><strong>{t("文档", "Document")} {index + 1}</strong>
        {([['sourceUrl', t("公开出处 URL", "Public source URL")], ['retrievedAt', t("实际读取时间（ISO 8601）", "Actual retrieval time (ISO 8601)")]] as const).map(([field, label]) => <label key={field}>{label}<input aria-label={`${t("文档", "Document")} ${index + 1} · ${label}`} value={document[field]} maxLength={4096} onChange={event => edit(previous => ({ ...previous, documents: previous.documents.map((value, i) => i === index ? { ...value, [field]: event.target.value } : value) }))} /></label>)}
        <label>{t("完整原文", "Original disclosure text")}<textarea rows={5} aria-label={`${t("文档", "Document")} ${index + 1} · ${t("完整原文", "Original disclosure text")}`} value={document.rawText} maxLength={262144} onChange={event => edit(previous => ({ ...previous, documents: previous.documents.map((value, i) => i === index ? { ...value, rawText: event.target.value } : value) }))} /></label>
        {draft.documents.length > 1 && <button type="button" onClick={() => edit(previous => ({ ...previous, documents: previous.documents.filter((_, i) => i !== index), supports: Object.fromEntries(Object.entries(previous.supports).map(([key, reference]) => [key, reference.documentIndex === index ? { documentIndex: 0, quote: "" } : { ...reference, documentIndex: reference.documentIndex > index ? reference.documentIndex - 1 : reference.documentIndex }])) }))}>{t("删除文档并清除其引用", "Remove document and clear its citations")}</button>}
      </div>)}<button type="button" disabled={draft.documents.length >= 10} onClick={() => edit(previous => ({ ...previous, documents: [...previous.documents, emptyDocument()] }))}>{t("添加证据文档", "Add evidence document")}</button></fieldset>
    <fieldset disabled={locked || !available}><legend>{t("逐项核对", "Review each field")}</legend>
      <label>{t("实际雇主法定名称", "Employer legal name")}<input aria-label={t("实际雇主法定名称", "Employer legal name")} maxLength={500} value={draft.legalEntityName} onChange={event => edit(previous => ({ ...previous, legalEntityName: event.target.value }))} /></label>{citation("legalEntityName")}
      <label>{t("母公司名称（可留空）", "Parent company name (optional)")}<input aria-label={t("母公司名称", "Parent company name")} maxLength={500} value={draft.parentCompanyName} onChange={event => edit(previous => ({ ...previous, parentCompanyName: event.target.value }))} /></label>{draft.parentCompanyName.trim() && <>{citation("parentCompanyName")}<small>{t("引用应说明母子公司关系，不能仅包含公司名称。", "The quote should support the parent–subsidiary relationship, beyond naming the company.")}</small></>}
      <label>{t("核对状态", "Review status")}<select aria-label={t("企业核对状态", "Company review status")} value={draft.status} onChange={event => edit(previous => ({ ...previous, status: event.target.value as Draft["status"], controlMode: "unknown" }))}><option value="unknown">{t("证据不足／未知", "Insufficient evidence / unknown")}</option><option value="conflicting">{t("证据冲突", "Conflicting evidence")}</option><option value="resolved">{t("本人已查明控制关系", "Control structure personally reviewed")}</option></select></label>{citation("status")}
      <label>{t("控制关系", "Control structure")}<select aria-label={t("企业控制关系", "Company control structure")} disabled={draft.status !== "resolved"} value={draft.controlMode} onChange={event => edit(previous => ({ ...previous, controlMode: event.target.value as Draft["controlMode"], controllers: event.target.value === "single" ? previous.controllers.slice(0, 1) : previous.controllers }))}><option value="unknown">{t("未知", "Unknown")}</option><option value="single">{t("单一控制方", "Single controller")}</option><option value="joint">{t("共同控制", "Joint control")}</option><option value="dispersed">{t("股权分散／无实际控制人", "Dispersed ownership / no actual controller")}</option></select></label>{citation("controlMode")}
      {draft.status === "resolved" && ["single", "joint"].includes(draft.controlMode) && draft.controllers.map((controller, index) => <div className="atlas-company-controller" key={index}><strong>{t("控制方", "Controller")} {index + 1}</strong>
        <label>{t("名称", "Name")}<input aria-label={`${t("控制方", "Controller")} ${index + 1} · ${t("名称", "Name")}`} value={controller.name} maxLength={500} onChange={event => edit(previous => ({ ...previous, controllers: previous.controllers.map((value, i) => i === index ? { ...value, name: event.target.value } : value) }))} /></label>{citation("controllerName", index)}
        <label>{t("性质", "Ownership")}<select aria-label={`${t("控制方", "Controller")} ${index + 1} · ${t("性质", "Ownership")}`} value={controller.kind} onChange={event => edit(previous => ({ ...previous, controllers: previous.controllers.map((value, i) => i === index ? { ...value, kind: event.target.value as ControllerDraft["kind"] } : value) }))}><option value="">{t("请选择证据支持的性质", "Select evidenced ownership")}</option><option value="private">{t("私人控制", "Private control")}</option><option value="state">{t("国有控制", "State control")}</option></select></label>{citation("controllerKind", index)}
        {citation("controllerControl", index)}<small>{t("引用须支持此控制方最终控制实际雇主的关系。", "Cite evidence supporting this party's ultimate control of the employer.")}</small>
        <label>{t("来源国家／地区 ISO 代码（可留空）", "Origin ISO country / region code (optional)")}<input aria-label={`${t("控制方", "Controller")} ${index + 1} · ${t("来源国家代码", "Origin country code")}`} maxLength={2} value={controller.jurisdictionCode} onChange={event => edit(previous => ({ ...previous, controllers: previous.controllers.map((value, i) => i === index ? { ...value, jurisdictionCode: event.target.value.toUpperCase() } : value) }))} /></label>{controller.jurisdictionCode.trim() && citation("controllerJurisdiction", index)}
        {draft.controlMode === "joint" && draft.controllers.length > 1 && <button type="button" onClick={() => edit(previous => ({ ...previous, controllers: previous.controllers.filter((_, i) => i !== index), supports: {} }))}>{t("移除此控制方并重填引用", "Remove controller and reset citations")}</button>}
      </div>)}{draft.status === "resolved" && draft.controlMode === "joint" && <button type="button" disabled={draft.controllers.length >= 20} onClick={() => edit(previous => ({ ...previous, controllers: [...previous.controllers, emptyController()] }))}>{t("添加共同控制方", "Add joint controller")}</button>}
      <label>{t("核对说明", "Review reason")}<textarea rows={2} aria-label={t("企业核对说明", "Company review reason")} maxLength={500} value={reason} onChange={event => { setReason(event.target.value); setPreview(undefined); setReviewed(false); }} /></label>
      <button type="button" onClick={() => void readPreview()}>{t("预览企业控股核对", "Preview company control review")}</button></fieldset>
    {preview && <div className="atlas-company-preview"><h3>{t("待本人确认的企业投影", "Company projection for your confirmation")}</h3><CompanySummary company={preview.value.proposed} data={data} colorConfig={colorConfig} /><small>{t(`影响 ${preview.value.affectedJobIds.length} 个当前岗位；不更改岗位正文、薪资或办公室。`, `Affects ${preview.value.affectedJobIds.length} current jobs; job descriptions, pay and offices are retained.`)}</small>{preview.value.warnings.map((warning, index) => <small key={index}>{warning}</small>)}
      {stalePreview && <p role="status">{t("索引已更新，本预览失效，请重新读取并预览。", "The index changed. Reload and preview again.")}</p>}
      <label><input type="checkbox" aria-label={t("确认已逐项核对企业证据", "Confirm company evidence reviewed field by field")} checked={reviewed} disabled={locked || stalePreview} onChange={event => setReviewed(event.target.checked)} />{t("本人已逐项核对实际雇主、控制关系、性质和来源证据；此为本人核对，非发布机构认证。", "I reviewed the employer, control structure, ownership and origin evidence field by field. This is my review, not publisher certification.")}</label>
      <button type="button" disabled={locked || stalePreview || !reviewed || !available} onClick={() => void commit("confirm")}><Check size={13} />{t("确认保存企业核对", "Confirm and save company review")}</button></div>}
    {record && <div className="atlas-company-history"><h3><History size={14} />{t(`核对历史（${record.history.length}）`, `Review history (${record.history.length})`)}</h3>{record.history.slice(-historyLimit).reverse().map(decision => <article key={decision.id}><strong>{decision.kind === "confirm" ? t("本人确认", "Personal confirmation") : decision.kind === "revoke" ? t("已撤销", "Revoked") : t("来源变化使旧核对失效", "Source change invalidated prior review")}{decision.id === record.activeDecisionId && ` · ${t("当前生效", "Active")}`}</strong><small>{decision.at}</small>
      {"reason" in decision && <p>{decision.reason}</p>}{decision.kind === "confirm" && <details><summary>{t("查看当时的证据与引用", "View archived evidence and citations")}</summary>{decision.proposal.documents.map((document, index) => <div key={index}><a href={document.sourceUrl} target="_blank" rel="noopener noreferrer">{t("文档", "Document")} {index + 1}<ArrowUpRight size={12} /></a><small>{document.retrievedAt}</small><pre>{document.rawText}</pre></div>)}{decision.proposal.supports.map((support, index) => <blockquote key={index}>{supportLabel(support.field, t)} · {t("文档", "Document")} {support.documentIndex + 1}{support.controllerIndex !== undefined && ` · ${t("控制方", "Controller")} ${support.controllerIndex + 1}`}<br />{support.quote}</blockquote>)}</details>}</article>)}
      {record.history.length > historyLimit && <button type="button" onClick={() => setHistoryLimit(value => value + 20)}>{t("显示更早的核对历史", "Show earlier review history")}</button>}
      {record.activeDecisionId && <fieldset disabled={locked || !available}><legend>{t("撤销当前本人核对", "Revoke the active personal review")}</legend><label>{t("撤销说明", "Revocation reason")}<textarea rows={2} aria-label={t("企业撤销说明", "Company revocation reason")} value={revokeReason} maxLength={500} onChange={event => { setRevokeReason(event.target.value); setRevokeReviewed(false); }} /></label><label><input type="checkbox" aria-label={t("确认撤销企业核对", "Confirm company review revocation")} checked={revokeReviewed} onChange={event => setRevokeReviewed(event.target.checked)} />{t("本人确认撤销当前决议，并重新计算企业分类、颜色与筛选。", "I confirm revocation and recalculation of company classification, colors and filters.")}</label><button type="button" disabled={!revokeReviewed || !revokeReason.trim()} onClick={() => void commit("revoke")}>{t("撤销当前企业核对", "Revoke current company review")}</button></fieldset>}</div>}
    {recovery.pending && <div className="atlas-company-pending" role="status"><p>{t("本次企业写入尚未确认；原请求与幂等键保留，旧岗位查询已暂停。", "This company write is unconfirmed. The original request and idempotency key are retained; stale job queries are paused.")}</p><small>{recovery.pending.input.companyId}</small><button type="button" disabled={busy} onClick={() => void commit(recovery.pending!.kind)}>{t("核对本次企业保存回执", "Recover this company save receipt")}</button></div>}
    {recovery.saved && <div className="atlas-company-saved" role="status"><p>{t(`保存已确认，版本 ${recovery.saved.revision}；请读取最新索引。`, `Save confirmed at revision ${recovery.saved.revision}. Load the current index.`)}</p><button type="button" disabled={busy} onClick={() => void refresh()}>{t("重新读取索引", "Reload index")}</button></div>}
    {busy && <button type="button" onClick={() => current.current?.controller.abort()}><Loader2 size={13} className="animate-spin" />{t("停止等待", "Stop waiting")}</button>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
