import { useUiPreferences } from "../lib/ui-preferences";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, BriefcaseBusiness, CalendarClock, Check, ChevronRight, ExternalLink, FileText, Globe2, LayoutList, MapPin, Plus, Search, SlidersHorizontal, Upload, X } from "lucide-react";
import {
  addOpportunity, deleteApplicationCommunication, deleteOpportunity, deleteOpportunityMaterial, emptyOpportunityLibrary, exportOpportunitiesCsv, exportOpportunityJson,
  importOpportunityJson, mergeOpportunityLibraries, queryOpportunities, readOpportunityLibrary,
  opportunityDateTimeInput, parseOpportunityDateTimeInput, recordApplicationCommunication, recordOpportunityMaterial, replaceCorruptOpportunityLibrary, saveOpportunityLibrary, summarizeOpportunities, updateApplication, updateOpportunity,
  type Opportunity, type OpportunityFilters, type OpportunityInput, type OpportunityLibrary, type OpportunityMaterial,
} from "../lib/opportunities";
import "./opportunities.css";
import { OpportunitySourcePanel } from "./OpportunitySourcePanel";
import { ApplicationCommunicationLog, ApplicationFollowups } from "./ApplicationFollowups";
import { useConfirm } from "./ConfirmationDialog";

export type OpportunitySeed = { token: string; title?: string; description: string; sourceUrl?: string; sourcePlatform?: string; collectedAt?: string };
type Props = {
  seed?: OpportunitySeed | null;
  onSeedConsumed: () => void;
  onOpenJd: () => void;
  onOpenNetworkSettings: () => void;
  getCurrentResumeMaterial: () => Omit<OpportunityMaterial, "id" | "createdAt">;
  onAnalyze: (job: Opportunity) => void;
  onCreateResume: (job: Opportunity) => void;
  linkedResumeNames: Record<string, string[]>;
};







export function downloadOpportunityFile(content: string, name: string, type = "application/json;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const inputDate = opportunityDateTimeInput;
const parseInputDate = parseOpportunityDateTimeInput;


type Draft = {
  company: string; title: string; description: string; sourceUrl: string; applicationUrl: string;
  discoveryUrl: string; sourcePlatform: string; sourceJobId: string; sourcePublishedText: string;
  market: Opportunity["market"]; workMode: Opportunity["workMode"]; status: Opportunity["status"];
  employmentType: Opportunity["employmentType"]; publisherType: Opportunity["publisherType"];
  country: string; region: string; city: string; remoteEligibleRegions: string; salaryText: string;
  sourcePublishedAt: string; sourceUpdatedAt: string; lastVerifiedAt: string; lastVerificationMethod: Opportunity["lastVerificationMethod"];
  applicationDeadlineText: string; applicationDeadlineDate: string;
};
function createDraft(job?: Opportunity, seed?: OpportunitySeed): Draft {
  return {
    company: job?.company ?? "", title: job?.title ?? seed?.title ?? "", description: job?.description ?? seed?.description ?? "",
    sourceUrl: job?.sourceUrl ?? seed?.sourceUrl ?? "", applicationUrl: job?.applicationUrl ?? "", discoveryUrl: job?.discoveryUrl ?? "",
    sourcePlatform: job?.sourcePlatform ?? seed?.sourcePlatform ?? "手动录入", sourceJobId: job?.sourceJobId ?? "", sourcePublishedText: job?.sourcePublishedText ?? "",
    market: job?.market ?? "unknown", workMode: job?.workMode ?? "unknown", status: job?.status ?? "unknown",
    employmentType: job?.employmentType ?? "unknown", publisherType: job?.publisherType ?? "unknown",
    country: job?.location.country ?? "", region: job?.location.region ?? "", city: job?.location.city ?? "", remoteEligibleRegions: job?.remoteEligibleRegions.join("、") ?? "",
    salaryText: job?.salaryText ?? "", sourcePublishedAt: inputDate(job?.sourcePublishedAt), sourceUpdatedAt: inputDate(job?.sourceUpdatedAt), lastVerifiedAt: inputDate(job?.lastVerifiedAt), lastVerificationMethod: job?.lastVerificationMethod ?? "unknown",
    applicationDeadlineText: job?.applicationDeadlineText ?? "", applicationDeadlineDate: job?.applicationDeadlineDate ?? "",
  };
}

export function OpportunityWorkspace({ seed, onSeedConsumed, onAnalyze, onCreateResume, onOpenJd, onOpenNetworkSettings, getCurrentResumeMaterial, linkedResumeNames }: Props) {
  const { t, locale } = useUiPreferences();
  const uiTextRef = useRef(t);
  uiTextRef.current = t;

const STAGES: Record<Opportunity["application"]["stage"], string> = { saved: t("已收藏", "Saved"), evaluating: t("待评估", "To evaluate"), preparing: t("准备中", "Preparing"), applied: t("已投递", "Applied"), interview: t("面试中", "Interviewing"), offer: "Offer", rejected: t("未通过", "Rejected"), withdrawn: t("已撤回", "Withdrawn") };
const MARKETS = { all: t("全部机会", "All opportunities"), domestic: t("国内", "China"), overseas: t("海外", "International"), unknown: t("地区待确认", "Market unconfirmed") } as const;
const MODES = { unknown: t("未提供", "Not provided"), "on-site": t("现场办公", "On site"), hybrid: t("混合办公", "Hybrid"), remote: t("远程", "Remote") } as const;
const JOB_STATUS = { open: t("开放", "Open"), closed: t("已关闭", "Closed"), unknown: t("待核验", "Unverified") } as const;
const EMPLOYMENT = { unknown: t("未分类", "Unclassified"), social: t("社招", "Experienced hires"), campus: t("校招", "Graduate hiring"), internship: t("实习", "Internship") } as const;
const PUBLISHERS = { unknown: t("未核实", "Unverified"), company: t("企业", "Company"), recruiter: t("猎头", "Recruiter"), agency: t("中介", "Agency") } as const;
function displayDate(value?: string) { return value ? locale === "en" ? new Date(value).toLocaleString("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : opportunityDateTimeInput(value).replace("T", " ") : t("未提供", "Not provided"); }
function locationText(job: Opportunity) { return [job.location.country, job.location.region, job.location.city].filter(Boolean).join(" · ") || t("地点待确认", "Location unconfirmed"); }

  const confirmAction = useConfirm();
  const [initial] = useState(readOpportunityLibrary);
  const [library, setLibrary] = useState(initial.library);
  const [error, setError] = useState(initial.error ?? "");
  const [notice, setNotice] = useState("");
  const [recoveryRaw, setRecoveryRaw] = useState(initial.recoveryRaw);
  const [conflict, setConflict] = useState(false);
  const [filters, setFilters] = useState<OpportunityFilters>({});
  const [board, setBoard] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => createDraft());
  const [formCollectedAt, setFormCollectedAt] = useState<string | undefined>();
  const [notes, setNotes] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [channel, setChannel] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactDetails, setContactDetails] = useState("");
  const [communicationDirty, setCommunicationDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pendingImport = useRef(false);
  const jobs = queryOpportunities(library, filters);
  const stats = summarizeOpportunities(jobs);
  const allStats = summarizeOpportunities(library.jobs);
  const selected = library.jobs.find((job) => job.id === selectedId);
  const followupDirty = !!selected && (notes !== selected.application.notes || nextAction !== selected.application.nextAction || nextActionAt !== inputDate(selected.application.nextActionAt) || channel !== selected.application.channel || contactName !== selected.application.contactName || contactDetails !== selected.application.contactDetails);
  useEffect(() => {
    if (!editing && !followupDirty && !communicationDirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect); return () => window.removeEventListener("beforeunload", protect);
  }, [editing, followupDirty, communicationDirty]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key?.includes("opportunit") || event.key === null) {
        setConflict(true); setError(uiTextRef.current("另一窗口更新了岗位库。请先复制未保存内容，再点击重新读取，避免覆盖。", "Another window updated the job library. Copy any unsaved content before reloading to avoid overwriting it."));
      }
    };
    window.addEventListener("storage", changed); return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (!seed) return;
    if (editing) { setNotice(uiTextRef.current("先保存或取消当前岗位编辑，再重新从 JD 保存。", "Save or cancel the current job edit before saving from the JD again.")); onSeedConsumed(); return; }
    setDraft(createDraft(undefined, seed)); setEditingId(null); setFormCollectedAt(seed.collectedAt); setEditing(true); setSelectedId(null); onSeedConsumed();
  }, [seed, editing, onSeedConsumed]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if ((editing || selected) && !node.open) node.showModal();
    else if (!editing && !selected && node.open) node.close();
  }, [editing, selected]);

  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!dialog.current?.open || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.shiftKey) return;
      event.preventDefault();
      const focusedForm = event.target instanceof Element ? event.target.closest("form") : null;
      const form = focusedForm && dialog.current.contains(focusedForm) ? focusedForm : dialog.current.querySelector<HTMLFormElement>("form.opportunity-form");
      if (form) form.requestSubmit();
      else dialog.current.querySelector<HTMLButtonElement>("[data-save-followup]")?.click();
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, []);

  function commit(next: OpportunityLibrary) {
    try { const saved = saveOpportunityLibrary(next); setLibrary(saved); setError(""); setNotice(t("已保存到此浏览器", "Saved in this browser")); return true; }
    catch (err) { const message = err instanceof Error ? err.message : t("岗位保存失败，请导出备份。", "Could not save the job. Export a backup."); setError(message); if (message.includes("另一个窗口")) setConflict(true); return false; }
  }
  async function canLeave() { return !(editing || followupDirty || communicationDirty) || await confirmAction(t("有未保存的岗位信息、跟进或沟通内容，确认放弃这些修改？", "Discard unsaved job details, follow-ups or communication notes?"), { title: t("未保存的求职记录", "Unsaved job search records"), confirmLabel: t("放弃修改", "Discard changes") }); }
  async function reload() {
    if (!await canLeave()) return;
    const result = readOpportunityLibrary(); setLibrary(result.library); setError(result.error ?? ""); setRecoveryRaw(result.recoveryRaw); setConflict(false); setEditing(false); setSelectedId(null);
  }
  function openJob(job: Opportunity) {
    setEditing(false); setSelectedId(job.id); setNotes(job.application.notes); setNextAction(job.application.nextAction); setNextActionAt(inputDate(job.application.nextActionAt)); setChannel(job.application.channel); setContactName(job.application.contactName); setContactDetails(job.application.contactDetails); setCommunicationDirty(false); setNotice("");
  }
  function openCreate() { setDraft(createDraft()); setEditingId(null); setFormCollectedAt(undefined); setSelectedId(null); setEditing(true); setNotice(""); }
  async function closeDialog() {
    if (!await canLeave()) return;
    setEditing(false); setSelectedId(null); setCommunicationDirty(false);
  }
  function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    try {
      const original = editingId ? library.jobs.find((job) => job.id === editingId) : undefined;
      const input: OpportunityInput = {
        company: draft.company, title: draft.title, description: draft.description, sourceUrl: draft.sourceUrl,
        applicationUrl: draft.applicationUrl, discoveryUrl: draft.discoveryUrl, sourcePlatform: draft.sourcePlatform,
        sourceJobId: draft.sourceJobId, sourcePublishedText: draft.sourcePublishedText,
        applicationDeadlineText: draft.applicationDeadlineText, applicationDeadlineDate: draft.applicationDeadlineDate,
        market: draft.market, workMode: draft.workMode, status: draft.status, employmentType: draft.employmentType, publisherType: draft.publisherType,
        location: { country: draft.country, region: draft.region, city: draft.city }, salaryText: draft.salaryText,
        remoteEligibleRegions: draft.remoteEligibleRegions.split(/[,，、\n]/).map((value) => value.trim()).filter(Boolean),
        sourcePublishedAt: parseInputDate(draft.sourcePublishedAt, original?.sourcePublishedAt), sourceUpdatedAt: parseInputDate(draft.sourceUpdatedAt, original?.sourceUpdatedAt), lastVerifiedAt: parseInputDate(draft.lastVerifiedAt, original?.lastVerifiedAt), lastVerificationMethod: draft.lastVerificationMethod,
        ...(formCollectedAt ? { collectedAt: formCollectedAt } : {}),
      };
      if (editingId) {
        const next = updateOpportunity(library, editingId, input);
        if (commit(next)) { setEditing(false); const job = next.jobs.find((item) => item.id === editingId); if (job) openJob(job); }
      } else {
        const result = addOpportunity(library, input);
        if (result.duplicate) { setError(t("这个来源链接已经收藏。为保护你刚填写的内容，当前表单仍保留；请取消后打开已有岗位，或改用另一个来源链接。", "This source link is already saved. Your form is kept. Cancel to open the existing job, or use a different source link.")); return; }
        if (commit(result.library)) { setEditing(false); openJob(result.job); }
      }
    } catch (err) { setError(err instanceof Error ? err.message : t("请检查岗位信息。", "Please check the job details.")); }
  }
  async function changeStage(job: Opportunity, stage: Opportunity["application"]["stage"]) {
    if (stage === job.application.stage) return;
    const confirmed = stage !== "applied" || !!job.application.submittedAt || await confirmAction(t("确认你已经在外部平台完成投递？打开申请链接或准备好简历不算已投递。", "Have you submitted the application on the external platform? Opening its link or preparing a resume does not count as applying."), { title: t("记录真实投递", "Record an actual application"), confirmLabel: t("我已完成投递", "I have submitted the application") });
    if (!confirmed) return;
    try { commit(updateApplication(library, job.id, { stage }, { submittedConfirmed: stage === "applied" })); }
    catch (err) { setError(err instanceof Error ? err.message : t("状态更新失败。", "Could not update the status.")); }
  }
  function saveFollowup(job: Opportunity) {
    try { if (commit(updateApplication(library, job.id, { stage: job.application.stage, notes, nextAction, nextActionAt: parseInputDate(nextActionAt, job.application.nextActionAt), channel, contactName, contactDetails }))) { setNotice(t("跟进记录已保存", "Follow-up saved")); } }
    catch (err) { setError(err instanceof Error ? err.message : t("跟进记录保存失败。", "Could not save the follow-up.")); }
  }
  async function importFile(file?: File) {
    if (!file || pendingImport.current) return;
    pendingImport.current = true;
    try {
      if (!await canLeave()) return;
      setEditing(false); setSelectedId(null); setCommunicationDirty(false);
      if (file.size > 4 * 1024 * 1024) throw new Error(t("文件超过 4MB，请拆分后再导入。", "This file exceeds 4 MB. Split it before importing."));
      const incoming = importOpportunityJson(await file.text());
      const current = readOpportunityLibrary();
      if (current.error) {
        if (current.recoveryRaw === undefined) throw new Error(current.error);
        if (!await confirmAction(t("当前机会库损坏。确认用这份有效备份恢复？原始损坏数据将另存为恢复副本，建议先下载原文。", "The opportunity library is damaged. Restore from this valid backup? The damaged data will be kept separately; download it first if possible."), { title: t("从备份恢复机会库", "Restore opportunity library"), confirmLabel: t("恢复有效备份", "Restore valid backup") })) return;
        const restored = replaceCorruptOpportunityLibrary(incoming, true); setLibrary(restored); setRecoveryRaw(undefined); setConflict(false); setError(""); setNotice(t("已从备份恢复，损坏原文已另存保护。", "Restored from backup. The damaged original is protected separately.")); return;
      }
      const merged = mergeOpportunityLibraries(current.library, incoming);
      if (commit(merged.library)) { setConflict(false); setNotice(t(`已合并 ${merged.added} 个岗位，保留 ${merged.duplicates} 个已有记录。`, `Merged ${merged.added} jobs and kept ${merged.duplicates} existing records.`)); }
    } catch (err) { setError(err instanceof Error ? err.message : t("岗位库导入失败，原数据未变。", "Could not import the job library. Existing data is unchanged.")); }
    finally { pendingImport.current = false; }
  }
  function exportJson() { try { downloadOpportunityFile(exportOpportunityJson(library), `better-me-opportunities-${new Date().toISOString().slice(0, 10)}.json`); } catch (err) { setError(String(err)); } }
  function importPublicJobs(inputs: OpportunityInput[]) {
    try {
      let next = library;
      let added = 0;
      for (const input of inputs) { const result = addOpportunity(next, input); next = result.library; if (!result.duplicate) added += 1; }
      if (commit(next)) { setNotice(t(`已收藏 ${added} 个岗位，保留 ${inputs.length - added} 个已有记录。请核对实际工作地点和市场。`, `Saved ${added} jobs and kept ${inputs.length - added} existing records. Review the actual work locations and markets.`)); return true; }
    } catch (err) { setError(err instanceof Error ? err.message : t("公开岗位导入失败，原数据未变。", "Could not import public jobs. Existing data is unchanged.")); }
    return false;
  }
  function exportCsv() { downloadOpportunityFile(exportOpportunitiesCsv(jobs), "better-me-opportunities.csv", "text/csv;charset=utf-8"); }
  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft((current) => ({ ...current, [key]: value })); }
  const distributions = new Map<string, number>();
  for (const job of jobs) { const place = locationText(job); distributions.set(place, (distributions.get(place) ?? 0) + 1); }

  return <section className="opportunity-workspace" aria-label={t("机会与投递工作区", "Opportunities and applications workspace")}>
    <input type="file" hidden ref={fileInput} accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void importFile(file); }} />
    <div className="opportunity-heading"><div><div className="studio-eyebrow">MAKE YOUR NEXT MOVE</div><h1>{t("机会与投递", "Opportunities & applications")}</h1><p>{t("让每个机会有出处，让每次跟进有下一步。", "Keep a source for every opportunity and a next step for every follow-up.")}</p></div><div className="opportunity-actions"><button className="studio-button" onClick={onOpenJd}><FileText size={14} />{t("导入 JD", "Import JD")}</button><button className="studio-button" onClick={() => fileInput.current?.click()}><Upload size={14} />{t("导入", "Import")}</button><button className="studio-button" onClick={exportJson}><ArrowDownToLine size={14} />{t("备份", "Back up")}</button><button className="studio-button primary" disabled={recoveryRaw !== undefined || conflict} onClick={openCreate}><Plus size={15} />{t("收藏岗位", "Save a job")}</button></div></div>
    {(error || notice) && <div role={error ? "alert" : "status"} className={`opportunity-notice ${error ? "error" : ""}`}><span>{error || notice}</span><button onClick={reload}>{t("重新读取", "Reload")}</button>{recoveryRaw !== undefined && <><button onClick={() => downloadOpportunityFile(recoveryRaw, "better-me-opportunities-recovery.txt", "text/plain;charset=utf-8")}>{t("下载损坏原文", "Download damaged original")}</button><button onClick={async () => { if (!await confirmAction(t("已下载或确认保留损坏原文？确认后会把当前空机会库写入，并把损坏数据另存为恢复副本。", "Have you downloaded or chosen to keep the damaged original? Confirmation saves an empty library and protects the damaged data separately."), { title: t("恢复空白机会库", "Create an empty opportunity library"), confirmLabel: t("建立空白库", "Create empty library"), danger: true })) return; try { const result = replaceCorruptOpportunityLibrary(emptyOpportunityLibrary(), true); setLibrary(result); setRecoveryRaw(undefined); setError(""); setNotice(t("已建立空白机会库，原始损坏数据已保留为恢复副本。", "An empty library was created. The damaged original is kept as a recovery copy.")); } catch (err) { setError(err instanceof Error ? err.message : t("恢复失败，原数据仍保留。", "Recovery failed. The original data is kept.")); } }}>{t("确认恢复空白库", "Create an empty library")}</button></>}</div>}
    <div className="opportunity-stats"><div><span>{t("当前岗位", "Current jobs")}</span><strong>{stats.total}</strong><small>{t("与下面的列表使用同一筛选", "Uses the same filters as the list below")}</small></div><div><span>{t("公司", "Companies")}</span><strong>{stats.companies}</strong><small>{t("按已保存的公司名称统计", "Based on saved company names")}</small></div><div><span>{t("面试中", "Interviewing")}</span><strong>{stats.stages.interview ?? 0}</strong><small>{t("由你记录实际进度", "Actual progress recorded by you")}</small></div><div><span>Offer</span><strong>{stats.stages.offer ?? 0}</strong><small>{t("保留自己的选择空间", "Keep your options open")}</small></div></div>
    <OpportunitySourcePanel onImport={importPublicJobs} disabled={conflict || recoveryRaw !== undefined} onOpenNetworkSettings={onOpenNetworkSettings} />
    <div className="opportunity-toolbar"><div className="opportunity-markets" aria-label={t("机会市场", "Job market")}>{Object.entries(MARKETS).map(([value, label]) => <button key={value} aria-pressed={(filters.market ?? "all") === value} className={(filters.market ?? "all") === value ? "active" : ""} onClick={() => setFilters((current) => ({ ...current, market: value as OpportunityFilters["market"] }))}>{label}<span>{value === "all" ? allStats.total : allStats.markets[value as keyof typeof allStats.markets] ?? 0}</span></button>)}</div><div className="opportunity-view-toggle"><button aria-label={t("岗位列表", "Job list")} aria-pressed={!board} className={!board ? "active" : ""} onClick={() => setBoard(false)}><LayoutList size={16} /></button><button aria-label={t("投递看板", "Application board")} aria-pressed={board} className={board ? "active" : ""} onClick={() => setBoard(true)}><SlidersHorizontal size={16} /></button></div></div>
    <div className="opportunity-filters"><label className="opportunity-search"><Search size={15} /><input aria-label={t("搜索公司、岗位和正文", "Search companies, jobs and descriptions")} placeholder={t("搜索公司、岗位、技能…", "Search companies, roles, skills…")} value={filters.search ?? ""} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></label><select aria-label={t("筛选投递阶段", "Filter application stage")} value={filters.stage ?? "all"} onChange={(event) => setFilters({ ...filters, stage: event.target.value as OpportunityFilters["stage"] })}><option value="all">{t("全部阶段", "All stages")}</option>{Object.entries(STAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label={t("筛选岗位状态", "Filter job status")} value={filters.status ?? "all"} onChange={(event) => setFilters({ ...filters, status: event.target.value as OpportunityFilters["status"] })}><option value="all">{t("全部开放状态", "All job statuses")}</option>{Object.entries(JOB_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label={t("筛选招聘类型", "Filter hiring type")} value={filters.employmentType ?? "all"} onChange={(event) => setFilters({ ...filters, employmentType: event.target.value as OpportunityFilters["employmentType"] })}><option value="all">{t("社招 / 校招 / 实习", "Experienced / graduate / internship")}</option>{Object.entries(EMPLOYMENT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="studio-button subtle" onClick={() => setFilters({})}>{t("清除筛选", "Clear filters")}</button><button className="studio-button" onClick={exportCsv}><ArrowDownToLine size={13} />{t("导出当前 CSV", "Export current CSV")}</button></div>
    <ApplicationFollowups jobs={jobs} onOpen={(job) => { void (async () => { if (await canLeave()) openJob(job); })(); }} />
    <div className="opportunity-content"><div className="opportunity-results">
      {!jobs.length ? <div className="opportunity-empty"><div><BriefcaseBusiness size={28} /></div><h2>{library.jobs.length ? t("没有符合筛选的岗位", "No jobs match these filters") : t("从一个值得关注的机会开始", "Start with an opportunity worth exploring")}</h2><p>{library.jobs.length ? t("调整市场、关键词或投递阶段，再看看。", "Adjust the market, keywords or application stage and try again.") : t("保存官网或招聘平台的岗位，记录来源、材料和跟进。不需要配置 AI。", "Save jobs from company sites or job platforms, with sources, materials and follow-ups. No AI configuration required.")}</p><button className="studio-button primary" onClick={library.jobs.length ? () => setFilters({}) : openCreate}>{library.jobs.length ? t("查看全部机会", "View all opportunities") : t("收藏第一个岗位", "Save your first job")}<ChevronRight size={14} /></button></div>
        : board ? <div className="opportunity-board" aria-label={t("按投递阶段分组", "Group by application stage")}>{Object.entries(STAGES).map(([stage, label]) => { const group = jobs.filter((job) => job.application.stage === stage); return <section key={stage} className="opportunity-column"><h2><span>{label}</span><small>{group.length}</small></h2>{group.map((job) => <button className="opportunity-board-card" key={job.id} onClick={() => openJob(job)}><small>{job.company}</small><strong>{job.title}</strong><span><MapPin size={12} />{locationText(job)}</span><em>{job.application.nextAction || t("添加下一步", "Add a next step")}</em></button>)}{!group.length && <p className="opportunity-column-empty">{t("暂无岗位", "No jobs yet")}</p>}</section>; })}</div>
          : <div className="opportunity-list">{jobs.map((job) => <article key={job.id} className="opportunity-row"><button className="opportunity-row-main" onClick={() => openJob(job)}><span className="company-initial">{job.company.slice(0, 1)}</span><span><small>{job.company}<i>·</i>{job.sourcePlatform}</small><strong>{job.title}</strong><span className="opportunity-row-meta"><MapPin size={12} />{locationText(job)}<i>·</i>{job.salaryText || t("薪资未披露", "Salary not disclosed")}<i>·</i>{MODES[job.workMode]}</span></span></button><div className="opportunity-row-side"><span className={`job-status ${job.status}`}>{JOB_STATUS[job.status]}</span><select aria-label={t(`${job.title} 投递阶段`, `${job.title} application stage`)} value={job.application.stage} disabled={conflict} onChange={(event) => changeStage(job, event.target.value as Opportunity["application"]["stage"])}>{Object.entries(STAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{job.sourcePublishedAt ? t(`发布 ${displayDate(job.sourcePublishedAt)}`, `Published ${displayDate(job.sourcePublishedAt)}`) : job.sourcePublishedText || t("发布时间未提供", "Publication time not provided")}</small>{job.applicationDeadlineDate && <small className="application-deadline-list">{t("截止", "Deadline")} {job.applicationDeadlineDate}</small>}</div></article>)}</div>}
      <p className="opportunity-coverage">{t("当前统计范围：你的岗位库；不是全网招聘数量。相同来源链接会提示重复，不会按“同公司 + 同标题”自动合并。", "Statistics cover your job library, not all online vacancies. Duplicate source links are flagged; matching company names and titles are not merged automatically.")}</p>
    </div><aside className="opportunity-context"><div className="opportunity-context-card"><Globe2 size={19} /><h2>{t("工作地点分布", "Job locations")}</h2><p>{t("与当前列表同步，按已填写的工作地点统计。", "Matches the current list and the work locations you entered.")}</p>{[...distributions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([place, count]) => <div className="opportunity-place" key={place}><span>{place}</span><strong>{count}</strong></div>)}{!jobs.length && <span className="opportunity-muted">{t("保存岗位后显示分布", "Locations appear after you save jobs")}</span>}<small>{t("远程允许地区在岗位详情中单独记录；不会把公司总部当作工作地点。", "Remote eligibility is recorded separately in job details; company headquarters are not assumed to be the work location.")}</small></div><div className="opportunity-context-card quiet"><h2>{t("一个清晰的求职节奏", "A clear job search routine")}</h2><ol><li>{t("收藏并核对原始 JD", "Save and review the original JD")}</li><li>{t("准备岗位专属简历", "Prepare a tailored resume")}</li><li>{t("到原平台完成申请", "Apply on the original platform")}</li><li>{t("记录结果与下一步", "Record outcomes and next steps")}</li></ol><p>{t("打开申请链接只会打开页面；已投递状态由你确认。", "An application link only opens the page. You confirm when the application is submitted.")}</p></div></aside></div>
    <dialog className="opportunity-dialog" aria-labelledby="opportunity-dialog-title" ref={dialog} onCancel={(event) => { event.preventDefault(); closeDialog(); }} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } }}>
      <div className="opportunity-dialog-header"><div><small>{editing ? "SAVE AN OPPORTUNITY" : selected?.company}</small><h2 id="opportunity-dialog-title">{editing ? editingId ? t("编辑岗位信息", "Edit job details") : t("收藏一个岗位", "Save a job") : selected?.title}</h2></div><button aria-label={t("关闭岗位详情", "Close job details")} className="studio-button icon-button" onClick={closeDialog}><X size={18} /></button></div>
      {error && <div role="alert" className="opportunity-form-error">{error}</div>}
      {!error && notice && <div role="status" className="opportunity-dialog-status">{notice}</div>}
      {editing ? <form className="opportunity-form" onSubmit={saveDraft}><div className="opportunity-form-grid"><label>{t("公司名称", "Company name")}<input required maxLength={200} value={draft.company} onChange={(event) => updateDraft("company", event.target.value)} /></label><label>{t("岗位名称", "Job title")}<input required maxLength={300} value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} /></label><label>{t("详情来源链接", "Job details source URL")}<input type="url" placeholder="https://…" value={draft.sourceUrl} onChange={(event) => updateDraft("sourceUrl", event.target.value)} /></label><label>{t("原始申请链接", "Original application URL")}<input type="url" placeholder={t("可与详情链接不同", "May differ from the details URL")} value={draft.applicationUrl} onChange={(event) => updateDraft("applicationUrl", event.target.value)} /></label><label>{t("来源平台", "Source platform")}<input value={draft.sourcePlatform} onChange={(event) => updateDraft("sourcePlatform", event.target.value)} /></label><label>{t("发布主体", "Publisher")}<select value={draft.publisherType} onChange={(event) => updateDraft("publisherType", event.target.value as Draft["publisherType"])}>{Object.entries(PUBLISHERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{t("工作市场", "Job market")}<select value={draft.market} onChange={(event) => updateDraft("market", event.target.value as Draft["market"])}><option value="unknown">{t("待确认", "Unconfirmed")}</option><option value="domestic">{t("国内", "China")}</option><option value="overseas">{t("海外", "International")}</option></select></label><label>{t("工作方式", "Work mode")}<select value={draft.workMode} onChange={(event) => updateDraft("workMode", event.target.value as Draft["workMode"])}>{Object.entries(MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{t("国家 / 地区", "Country / territory")}<input value={draft.country} onChange={(event) => updateDraft("country", event.target.value)} /></label><label>{t("省 / 州", "Province / state")}<input value={draft.region} onChange={(event) => updateDraft("region", event.target.value)} /></label><label>{t("工作城市", "Work city")}<input value={draft.city} onChange={(event) => updateDraft("city", event.target.value)} /></label><label>{t("远程允许工作地区", "Eligible remote regions")}<input placeholder={t("例如：加拿大、美国；未知请留空", "For example: Canada, US; leave blank if unknown")} value={draft.remoteEligibleRegions} onChange={(event) => updateDraft("remoteEligibleRegions", event.target.value)} /></label><label>{t("招聘类型", "Hiring type")}<select value={draft.employmentType} onChange={(event) => updateDraft("employmentType", event.target.value as Draft["employmentType"])}>{Object.entries(EMPLOYMENT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{t("薪资原文", "Salary as published")}<input placeholder={t("未披露请留空", "Leave blank if not disclosed")} value={draft.salaryText} onChange={(event) => updateDraft("salaryText", event.target.value)} /></label><label>{t("申请截止原文", "Deadline as published")}<input maxLength={2000} placeholder={t("例如：招满即止 / 10 月底前", "For example: until filled / by the end of October")} value={draft.applicationDeadlineText} onChange={(event) => updateDraft("applicationDeadlineText", event.target.value)} /></label><label>{t("明确截止日期", "Explicit deadline date")}<input type="date" value={draft.applicationDeadlineDate} onChange={(event) => updateDraft("applicationDeadlineDate", event.target.value)} /><small>{t("仅录入来源明确日期，不将原文推算成日期。", "Enter only dates explicitly stated by the source; do not infer a date from wording.")}</small></label></div><label>{t("岗位正文 / JD", "Job description / JD")}<textarea rows={7} value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder={t("粘贴职责、要求和限制，保留原文便于回看。", "Paste responsibilities, requirements and constraints; keep the original wording for review.")} /></label><details><summary>{t("来源链、发布时间与核验", "Sources, publication and verification")}</summary><p className="opportunity-muted">{t("时间按北京时间（Asia/Shanghai）填写，仅填写原文明确披露的信息；相对日期只保留原文。", "Enter times in Beijing time (Asia/Shanghai), using only information explicitly published. Keep relative dates as original text.")}</p><div className="opportunity-form-grid"><label>{t("发现渠道链接", "Discovery channel URL")}<input type="url" value={draft.discoveryUrl} onChange={(event) => updateDraft("discoveryUrl", event.target.value)} /></label><label>{t("来源岗位编号", "Source job ID")}<input value={draft.sourceJobId} onChange={(event) => updateDraft("sourceJobId", event.target.value)} /></label><label>{t("发布时间原文", "Publication time as written")}<input placeholder={t("例如：3 天前；不推造精确日期", "For example: 3 days ago; do not invent an exact date")} value={draft.sourcePublishedText} onChange={(event) => updateDraft("sourcePublishedText", event.target.value)} /></label><label>{t("原始发布时间", "Original publication time")}<input type="datetime-local" value={draft.sourcePublishedAt} onChange={(event) => updateDraft("sourcePublishedAt", event.target.value)} /></label><label>{t("平台更新 / 刷新时间", "Platform update / refresh time")}<input type="datetime-local" value={draft.sourceUpdatedAt} onChange={(event) => updateDraft("sourceUpdatedAt", event.target.value)} /></label><label>{t("岗位状态", "Job status")}<select value={draft.status} onChange={(event) => updateDraft("status", event.target.value as Draft["status"])}>{Object.entries(JOB_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{t("最近核验时间（修改后记为人工）", "Last verified (edits recorded as manual)")}<input type="datetime-local" value={draft.lastVerifiedAt} onChange={(event) => setDraft((current) => ({ ...current, lastVerifiedAt: event.target.value, lastVerificationMethod: "manual" }))} /></label></div></details><div className="opportunity-form-footer"><span>{t("仅保存你填写的信息，不会发起投递。", "Saves only what you entered; no application is submitted.")}</span><button type="button" className="studio-button" onClick={closeDialog}>{t("取消", "Cancel")}</button><button className="studio-button primary" disabled={conflict || recoveryRaw !== undefined} type="submit"><Check size={14} />{t("保存岗位", "Save job")}</button></div></form>
        : selected && <div className="opportunity-detail"><div className="opportunity-detail-actions">{(selected.applicationUrl || selected.sourceUrl) && <a className="studio-button primary" href={selected.applicationUrl || selected.sourceUrl} target="_blank" rel="noreferrer">{t("打开原申请页", "Open original application page")}<ExternalLink size={13} /></a>}<button className="studio-button" onClick={async () => { if (!await canLeave()) return; setCommunicationDirty(false); setEditingId(selected.id); setDraft(createDraft(selected)); setFormCollectedAt(undefined); setEditing(true); }}>{t("编辑信息", "Edit details")}</button><button className="studio-button" onClick={async () => { if (selected.description.trim()) { if (!await canLeave()) return; setCommunicationDirty(false); setSelectedId(null); onAnalyze(selected); } else setError(t("先编辑并补充 JD 正文，再进行匹配。", "Add the job description before running a match.")); }}><Search size={13} />{t("分析 JD", "Analyze JD")}</button><button className="studio-button" onClick={async () => { if (!await canLeave()) return; setCommunicationDirty(false); setSelectedId(null); onCreateResume(selected); }}><FileText size={13} />{t("创建岗位简历", "Create tailored resume")}</button></div><div className="opportunity-detail-badges"><span><MapPin size={13} />{locationText(selected)}</span><span>{MARKETS[selected.market]}</span><span>{MODES[selected.workMode]}</span><span>{selected.salaryText || t("薪资未披露", "Salary not disclosed")}</span></div>{(selected.applicationDeadlineDate || selected.applicationDeadlineText) && <p className="application-deadline"><CalendarClock size={14} /><span>{t("申请截止：", "Application deadline:")}{selected.applicationDeadlineDate || t("日期未明确", "Date unspecified")}{selected.applicationDeadlineText && t(` · 原文：${selected.applicationDeadlineText}`, ` · Original: ${selected.applicationDeadlineText}`)}</span></p>}{selected.workMode === "remote" && <p className="opportunity-remote">{t("允许工作地区：", "Eligible work regions:")}{selected.remoteEligibleRegions.join("、") || t("未提供，需要确认，不能据此视为全球远程", "Not provided; confirm eligibility before assuming worldwide remote work")}</p>}{linkedResumeNames[selected.id]?.length ? <p className="opportunity-linked">{t("岗位简历：", "Tailored resumes:")}{linkedResumeNames[selected.id]?.join("、")}</p> : null}<div className="opportunity-followup"><label>{t("投递阶段", "Application stage")}<select value={selected.application.stage} disabled={conflict} onChange={(event) => changeStage(selected, event.target.value as Opportunity["application"]["stage"])}>{Object.entries(STAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>{t("申请渠道（手动记录）", "Application channel (manual record)")}<input maxLength={500} value={channel} onChange={(event) => setChannel(event.target.value)} placeholder={t("例如：公司官网 / 内推 / BOSS", "For example: company website / referral / BOSS")} /></label><label>{t("联系人（手动记录）", "Contact (manual record)")}<input maxLength={500} value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder={t("例如：招聘负责人，未知可留空", "For example: hiring manager; leave blank if unknown")} /></label><label>{t("联系方式 / 备注", "Contact details / notes")}<input maxLength={2000} value={contactDetails} onChange={(event) => setContactDetails(event.target.value)} placeholder={t("只保存你主动填写的信息", "Only information you choose to enter is saved")} /></label><label>{t("下一步", "Next step")}<input maxLength={2000} value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder={t("例如：补项目说明 / 准备一面", "For example: add project details / prepare for first interview")} /></label><label>{t("跟进时间（北京时间）", "Follow-up time (Beijing time)")}<input type="datetime-local" value={nextActionAt} onChange={(event) => setNextActionAt(event.target.value)} /></label><label>{t("私人备注", "Private notes")}<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label><button className="studio-button" disabled={conflict} data-save-followup onClick={() => saveFollowup(selected)}><Check size={13} />{t("保存跟进", "Save follow-up")}</button><small>{t("保存后进入跟进队列；当前不发送后台提醒。", "Saved items appear in the follow-up queue. No background notifications are sent.")}</small></div><ApplicationCommunicationLog key={selected.id} job={selected} disabled={conflict} onDirtyChange={setCommunicationDirty} onRecord={(input) => { try { const saved = commit(recordApplicationCommunication(library, selected.id, input, { occurredConfirmed: true })); if (saved) setNotice(t("实际沟通已记录；投递阶段保持原记录。", "Communication recorded. The application stage is unchanged.")); return saved; } catch (err) { setError(err instanceof Error ? err.message : t("沟通记录保存失败。", "Could not save the communication record.")); return false; } }} onDelete={async (id) => { if (!await confirmAction(t("删除这条实际沟通记录？可先导出机会备份。", "Delete this communication record? You can export an opportunity backup first."), { title: t("删除沟通记录", "Delete communication record"), confirmLabel: t("删除记录", "Delete record"), danger: true })) return; try { commit(deleteApplicationCommunication(library, selected.id, id)); } catch (err) { setError(err instanceof Error ? err.message : t("删除失败。", "Deletion failed.")); } }} /><details><summary>{t("投递材料快照（", "Application material snapshots (")}{selected.materials.length} / 30）</summary><p className="opportunity-muted">{t("记录当前简历的 Markdown 内容。后续编辑或删除简历，不会改变这里的快照；PDF / Word 附件尚未保存。", "Keep the current resume as Markdown. Later resume edits or deletion do not change this snapshot. PDF / Word attachments are not saved.")}</p><button className="studio-button" disabled={conflict} onClick={async () => { try { const material = getCurrentResumeMaterial(); if (!await confirmAction(t(`记录《${material.resumeName}》作为这个岗位的材料快照？`, `Save “${material.resumeName}” as a material snapshot for this job?`), { title: t("保存当时的简历材料", "Save the current resume material"), confirmLabel: t("记录快照", "Save snapshot") })) return; commit(recordOpportunityMaterial(library, selected.id, material)); } catch (err) { setError(err instanceof Error ? err.message : t("快照失败。", "Could not save the snapshot.")); } }}><FileText size={13} />{t("记录当前简历快照", "Snapshot current resume")}</button>{selected.materials.map((material) => <div className="opportunity-material" key={material.id}><strong>{material.resumeName}</strong><small>{material.locale} · {displayDate(material.createdAt)}</small><div><button className="studio-button" onClick={() => downloadOpportunityFile(material.markdown, `better-me-material-${material.id}.md`, "text/markdown;charset=utf-8")}>{t("下载 MD", "Download MD")}</button><button className="studio-button" onClick={async () => { if (await confirmAction(t("删除这份材料快照？其他快照和简历保留。", "Delete this material snapshot? Other snapshots and resumes are kept."), { title: t("删除材料快照", "Delete material snapshot"), confirmLabel: t("删除快照", "Delete snapshot"), danger: true })) commit(deleteOpportunityMaterial(library, selected.id, material.id)); }}>{t("删除", "Delete")}</button></div><details><summary>{t("查看当时内容", "View saved content")}</summary><pre>{material.markdown}</pre></details></div>)}</details><h3>{t("原始岗位正文", "Original job description")}</h3><div className="opportunity-jd">{selected.description || t("尚未保存正文", "No description saved")}</div><details className="opportunity-provenance"><summary>{t("查看来源与时间记录", "View sources and timestamps")}</summary><dl><dt>{t("详情来源", "Details source")}</dt><dd>{selected.sourcePlatform} {selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">{t("原文", "Original source")}<ArrowUpRight size={12} /></a>}</dd><dt>{t("发布主体", "Publisher")}</dt><dd>{PUBLISHERS[selected.publisherType]}</dd><dt>{t("发现渠道", "Discovery channel")}</dt><dd>{selected.discoveryUrl ? <a href={selected.discoveryUrl} target="_blank" rel="noreferrer">{t("查看发现来源", "View discovery source")}</a> : t("未提供", "Not provided")}</dd><dt>{t("源岗位编号", "Source job ID")}</dt><dd>{selected.sourceJobId || t("未提供", "Not provided")}</dd><dt>{t("原始发布时间", "Original publication time")}</dt><dd>{displayDate(selected.sourcePublishedAt)}{selected.sourcePublishedText && t(`（原文：${selected.sourcePublishedText}）`, ` (Original: ${selected.sourcePublishedText})`)}</dd><dt>{t("平台刷新时间", "Platform refresh time")}</dt><dd>{displayDate(selected.sourceUpdatedAt)}</dd><dt>{t("首次发现时间", "First discovered")}</dt><dd>{displayDate(selected.firstDiscoveredAt)}</dd><dt>{t("本次采集时间", "Collected")}</dt><dd>{displayDate(selected.collectedAt)}</dd><dt>{t("最近核验时间与方式", "Last verification time and method")}</dt><dd>{displayDate(selected.lastVerifiedAt)} · {selected.lastVerificationMethod === "source-read" ? t("公开招聘接口读取", "Public recruitment API") : selected.lastVerificationMethod === "manual" ? t("人工记录", "Manual record") : t("方式未记录", "Method not recorded")} · {JOB_STATUS[selected.status]}</dd><dt>{t("记录的投递时间", "Recorded application time")}</dt><dd>{displayDate(selected.application.submittedAt)}</dd></dl></details><details><summary>{t("阶段变更记录", "Stage history")}</summary><ol className="opportunity-timeline">{selected.application.history.map((entry, index) => <li key={index}>{STAGES[entry.stage]}<span>{displayDate(entry.changedAt)}</span></li>)}</ol></details><button className="studio-button" onClick={async () => { if (await confirmAction(t("删除这个岗位及其投递记录、沟通日志、材料快照？可先导出机会库备份。", "Delete this job, application history, communication log and material snapshots? Export a library backup first if needed."), { title: t("删除岗位记录", "Delete job record"), confirmLabel: t("删除岗位", "Delete job"), danger: true }) && commit(deleteOpportunity(library, selected.id))) { setSelectedId(null); setCommunicationDirty(false); } }}>{t("删除岗位记录", "Delete job record")}</button></div>}
    </dialog>
  </section>;
}
