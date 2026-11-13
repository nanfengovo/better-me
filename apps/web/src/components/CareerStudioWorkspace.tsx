import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { ShieldCheck, GitBranch, ScanLine, Swords, Orbit, Telescope, Boxes, Share2, History, Loader2 } from "lucide-react";
import type { ProjectedResume } from "@better-me/core";
import type { ResumeEditContext, ResumeProposalTarget } from "@better-me/agent-contracts";
import { StudioOperationSchema, type StudioContext, type StudioLocalRuntime, type StudioOperation, type StudioClaimSchema } from "@better-me/agent-contracts/career-studio";
import { captureIdentityLease } from "../lib/identity";
import { readOpportunityLibrary, type Opportunity } from "../lib/opportunities";
import { createCareerStudioClient, careerStudioError, type StudioRequest } from "../services/career-studio-client";
import { CareerAnalysisPanel } from "./CareerAnalysisPanel";
import { CareerEvidenceInbox } from "./CareerEvidenceInbox";
import { CareerJobObservationEditor, emptyCareerJobObservation, parseCareerJobObservation, type CareerJobObservationDraft } from "./CareerJobObservationEditor";
import { CareerArchitectureLab } from "./CareerArchitectureLab";
import { CareerLayoutPanel, type CareerLayoutFinalExportRequest } from "./CareerLayoutPanel";
import { CareerTrustPanel } from "./CareerTrustPanel";
import { CareerReplayFeedbackPanel } from "./CareerReplayFeedbackPanel";
import { createCareerArchitectureAdapters } from "../services/career-architecture-client";
import { createCareerLayoutModelAdapter } from "../services/career-layout-model";
import type { ArchitectureBinding, ArchitectureEvidence } from "../lib/architecture-lab";
import type { CareerLayoutAdoptionContext, CareerLayoutAdoptionReceipt } from "../lib/career-studio-layout";
import { sameLayoutScope, type LayoutCandidate, type LayoutScope } from "../lib/layout-compiler";
import "./CareerStudioWorkspace.css";

type Tab = "committee" | "simulation" | "layout" | "architecture" | "harvest" | "forensics" | "spatial" | "trust" | "replay";
type Claim = z.infer<typeof StudioClaimSchema>;
export interface CareerStudioWorkspaceProps {
  active: boolean; workspaceKey: string; resumeId: string; sourceFingerprint: string; resume: ProjectedResume; resumeEditContext?: ResumeEditContext;
  onApplyWording?(proposal: { targetRef: ResumeProposalTarget; originalText: string; proposedText: string }): Promise<{ ok: boolean; message?: string }>;
  onAdoptLayout?(candidate: LayoutCandidate, context: CareerLayoutAdoptionContext): Promise<CareerLayoutAdoptionReceipt>;
  onAdoptEvidence?(entryId: string, expectedReviewHash: string): Promise<{ versionId: string; statementId: string }>;
}
const tabs = [{ id: "committee", label: "抗压测试", detail: "01", icon: Swords }, { id: "simulation", label: "技能推演", detail: "02", icon: GitBranch }, { id: "layout", label: "排版闭环", detail: "03", icon: ScanLine },
  { id: "spatial", label: "证据星图", detail: "04", icon: Orbit }, { id: "architecture", label: "面试白板", detail: "05", icon: Boxes }, { id: "harvest", label: "高光收件箱", detail: "06", icon: Telescope },
  { id: "forensics", label: "岗位取证", detail: "07", icon: ShieldCheck }, { id: "trust", label: "公开与隐私", detail: "08–10", icon: Share2 }, { id: "replay", label: "回放与复盘", detail: "11–12", icon: History }] as const;
const client = createCareerStudioClient();
const canonicalId = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 130) || "selected";
const validDate = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const skillList = (value: string) => [...new Set(value.split(/[,，]/).map(s => s.trim()).filter(Boolean))].slice(0, 100);

export function CareerStudioWorkspace(props: CareerStudioWorkspaceProps) {
  const [tab, setTab] = useState<Tab>("committee"), [runtimes, setRuntimes] = useState<StudioLocalRuntime[]>([]), [runtime, setRuntime] = useState<StudioLocalRuntime>();
  const [context, setContext] = useState<StudioContext>(), [claims, setClaims] = useState<Claim[]>([]), [selected, setSelected] = useState<string[]>([]), [library, setLibrary] = useState<Opportunity[]>([]), [jobIds, setJobIds] = useState<string[]>([]), [jobSkills, setJobSkills] = useState<Record<string, string>>({});
  const [jobObservations, setJobObservations] = useState<Record<string, CareerJobObservationDraft>>({});
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [operations, setOperations] = useState<Record<string, StudioOperation>>({});
  const lifetime = useRef<AbortController>(new AbortController()), contextRef = useRef(context), latest = useRef(props), sessionGeneration = useRef(1);
  const adopting = useRef<{ contextId: string } | undefined>(undefined), pendingInvalidation = useRef<string | undefined>(undefined);
  const lease = useRef(captureIdentityLease()); latest.current = props; contextRef.current = context;
  const layoutSource = useRef<{ contextId: string; resume: ProjectedResume } | undefined>(undefined);
  const ownLayoutSave = useRef<{ sourceFingerprint: string; message: string } | undefined>(undefined);
  // The authorized context owns a frozen projection. In particular, an own CAS
  // save updates App props before its asynchronous version readback finishes;
  // forwarding that projection would remount the Panel and abort the receipt.
  // External changes still fail getScope immediately and revoke this context.
  if (layoutSource.current?.contextId !== context?.id) layoutSource.current = context
    ? { contextId: context.id, resume: JSON.parse(JSON.stringify(props.resume)) as ProjectedResume } : undefined;
  const architectureEvidence = useRef<{ contextId: string; evidence: ArchitectureEvidence[] } | undefined>(undefined);
  const architectureRuntime = useRef(runtime); architectureRuntime.current = runtime;
  if (architectureEvidence.current?.contextId !== context?.id) architectureEvidence.current = context ? { contextId: context.id,
    evidence: context.claims.map(claim => ({ id: claim.id, label: "本人选择的原句（自述，非独立源码证据）", excerpt: claim.text })) } : undefined;
  const fields = useMemo(() => props.resumeEditContext?.experiences.flatMap((e, ei) => e.claims.map((c, ci) => ({ id: `claim-${ei}-${ci}`, label: `${e.organization} · ${e.title}`, targetRef: c.targetRef, text: c.text, tags: c.tags }))) ?? [], [props.resumeEditContext]);
  const targets = useMemo(() => Object.fromEntries(fields.map(f => [f.id, f.targetRef])), [fields]);
  useEffect(() => { setClaims(fields.map(f => ({ id: f.id, text: f.text, skillIds: f.tags ?? [], contribution: "unknown", confirmedByUser: false, confirmedNumericTokens: [] }))); setSelected([]); setConsent(false); }, [fields]);
  const invalidate = useCallback(() => {
    adopting.current = undefined; pendingInvalidation.current = undefined;
    const previous = contextRef.current; lifetime.current.abort(); lifetime.current = new AbortController(); setContext(undefined); setOperations({}); setConsent(false);
    if (previous) void client.request("/context/revoke", { contextId: previous.id }).catch(() => {});
  }, []);
  useEffect(() => {
    const selectedContext = contextRef.current;
    if (selectedContext && (selectedContext.sourceFingerprint !== props.sourceFingerprint || selectedContext.resumeId !== props.resumeId || selectedContext.workspaceKey !== props.workspaceKey)) {
      if (adopting.current?.contextId === selectedContext.id) pendingInvalidation.current = selectedContext.id;
      else { invalidate(); setNotice(ownLayoutSave.current?.sourceFingerprint === props.sourceFingerprint
        ? `${ownLayoutSave.current.message} 旧分析授权已关闭，请重新选择新版本。`
        : "原稿已变化，旧分析授权已关闭；历史产物仍保留，不会自动应用旧结果。请重新选择资料。"); }
    }
  }, [props.sourceFingerprint, props.resumeId, props.workspaceKey, invalidate]);
  useEffect(() => {
    // Development StrictMode replays setup/cleanup while keeping refs. A retired
    // mount's controller is not the authorization of the replayed live mount.
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); const selectedContext = contextRef.current; if (selectedContext) void client.request("/context/revoke", { contextId: selectedContext.id }).catch(() => {}); };
  }, []);
  const run = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (cause) { setError(careerStudioError(cause)); } finally { setBusy(false); } };
  const scopedRequest: StudioRequest = useCallback(async (route, body, signal) => {
    lease.current.assert(); const selectedContext = contextRef.current;
    if (!selectedContext || selectedContext.ownerId !== lease.current.ownerId || selectedContext.sourceFingerprint !== latest.current.sourceFingerprint || selectedContext.resumeId !== latest.current.resumeId) throw new Error("资料已变化，请重新选择授权。");
    const token = lifetime.current.signal, result = await client.request(route, body, signal ? AbortSignal.any([token, signal]) : token);
    lease.current.assert(); if (token.aborted || contextRef.current?.id !== selectedContext.id || latest.current.sourceFingerprint !== selectedContext.sourceFingerprint) throw new Error("晚结果未采用：资料或授权已变化。");
    return result;
  }, []);
  const onOperation = useCallback((operation: StudioOperation) => { if (operation.contextId === contextRef.current?.id) setOperations(previous => ({ ...previous, [operation.kind]: operation })); }, []);
  useEffect(() => {
    if (!context || !props.active) return;
    const running = Object.values(operations).filter(o => o.status === "running"); if (!running.length) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { for (const operation of running) { const result = StudioOperationSchema.parse(await scopedRequest("/operation/read", { contextId: context.id, operationId: operation.id }, controller.signal)); if (!controller.signal.aborted) onOperation(result); } }
      catch (cause) { if (!controller.signal.aborted) setError(careerStudioError(cause)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    }; timer = setTimeout(() => void poll(), 1200); return () => { controller.abort(); clearTimeout(timer); };
  }, [context, operations, props.active, scopedRequest, onOperation]);
  const scope = useMemo<LayoutScope | undefined>(() => context ? { ownerId: context.ownerId, sessionGeneration: sessionGeneration.current, documentId: context.resumeId, revision: context.sourceFingerprint, contentHash: context.sourceFingerprint } : undefined, [context]);
  const getScope = useCallback((): LayoutScope => {
    lease.current.assert(); const current = contextRef.current; if (!current || current.resumeId !== latest.current.resumeId
      || (adopting.current?.contextId !== current.id && current.sourceFingerprint !== latest.current.sourceFingerprint && ownLayoutSave.current?.sourceFingerprint !== latest.current.sourceFingerprint)) throw new Error("排版授权已变化。");
    return { ownerId: current.ownerId, sessionGeneration: sessionGeneration.current, documentId: current.resumeId, revision: latest.current.sourceFingerprint, contentHash: latest.current.sourceFingerprint };
  }, []);
  const architectureBinding: ArchitectureBinding | undefined = scope && context ? { ownerId: scope.ownerId, sessionGeneration: scope.sessionGeneration, projectId: context.resumeId, revision: scope.revision, contentHash: scope.contentHash } : undefined;
  const getArchitectureBinding = useCallback((): ArchitectureBinding => { const current = getScope(), ctx = contextRef.current; if (!ctx) throw new Error("架构来源已失效。"); return { ownerId: current.ownerId, sessionGeneration: current.sessionGeneration, projectId: ctx.resumeId, revision: current.revision, contentHash: current.contentHash }; }, [getScope]);
  const getArchitectureEvidence = useCallback(() => { getArchitectureBinding(); const current = architectureEvidence.current;
    if (!current || current.contextId !== contextRef.current?.id) throw new Error("当前架构引用库存已失效。"); return current.evidence;
  }, [getArchitectureBinding]);
  const updateArchitectureEvidence = (evidence: readonly ArchitectureEvidence[]) => { getArchitectureBinding(); const current = contextRef.current;
    if (current) architectureEvidence.current = { contextId: current.id, evidence: evidence.map(item => ({ ...item })) };
  };
  const architecture = useMemo(() => context ? createCareerArchitectureAdapters({ contextId: context.id, workspaceKey: context.workspaceKey, runtime, request: scopedRequest,
    getCurrentBinding: getArchitectureBinding, getCurrentEvidence: getArchitectureEvidence, getCurrentRuntime: () => architectureRuntime.current }) : undefined, [context, runtime, scopedRequest, getArchitectureBinding, getArchitectureEvidence]);
  const layoutModel = useMemo(() => context && scope && runtime ? createCareerLayoutModelAdapter({ contextId: context.id, scope, runtime, getCurrentScope: getScope, getCurrentRuntime: () => runtime,
    request: async (body, signal) => { const result = z.object({ output: z.unknown(), contextId: z.string(), inputHash: z.string(), runtime: z.object({ model: z.string(), modelDigest: z.string() }).passthrough(), adopted: z.literal(false) }).parse(await scopedRequest("/model", body, signal)); return { ...result, output: result.output }; }, reviewUsesFreshContext: true }) : undefined, [context, scope, runtime, getScope, scopedRequest]);
  const finalExporter = useMemo(() => context ? async (request: CareerLayoutFinalExportRequest) => {
    const { createCareerFinalExporter } = await import("../services/career-final-export");
    return createCareerFinalExporter({ contextId: context.id, request: scopedRequest, getCurrentScope: getScope })(request);
  } : undefined, [context, scopedRequest, getScope]);
  const finishAdoption = (token: { contextId: string }) => {
    // A retired callback may finish after explicit reauthorization and a new
    // write. Its finally must not release that write's marker or revoke it.
    if (adopting.current !== token) return;
    adopting.current = undefined;
    if (pendingInvalidation.current === token.contextId) {
      pendingInvalidation.current = undefined;
      setTimeout(() => { if (contextRef.current?.id === token.contextId) invalidate(); }, 100);
    }
  };
  const adoptLayout = async (candidate: LayoutCandidate, adoptionContext: CareerLayoutAdoptionContext) => {
    if (!props.onAdoptLayout) throw new Error("未连接正式版本命令。");
    const selectedContext = contextRef.current, adoptionLease = lease.current;
    if (!selectedContext) throw new Error("排版采用授权已变化，未发出新的写入。");
    if (adopting.current?.contextId === selectedContext.id) throw new Error("当前范围已有采用正在回读，请先核对其结果，不会自动重复写入。");
    const adoptionToken = { contextId: selectedContext.id }; adopting.current = adoptionToken;
    try {
      adoptionLease.assert(); const receipt = await props.onAdoptLayout(candidate, adoptionContext); adoptionLease.assert();
      const currentScope = getScope();
      if (!receipt.versionId?.trim() || !sameLayoutScope(receipt.baseScope, adoptionContext.baseScope)
        || receipt.candidateFingerprint !== adoptionContext.candidateFingerprint
        || adopting.current !== adoptionToken || contextRef.current?.id !== selectedContext.id || latest.current.workspaceKey !== selectedContext.workspaceKey || latest.current.resumeId !== selectedContext.resumeId
        || (receipt.resultScope && (receipt.resultScope.ownerId !== adoptionContext.baseScope.ownerId
          || receipt.resultScope.sessionGeneration !== adoptionContext.baseScope.sessionGeneration || receipt.resultScope.documentId !== adoptionContext.baseScope.documentId))
        || (!sameLayoutScope(adoptionContext.baseScope, currentScope) && !(receipt.resultScope && sameLayoutScope(receipt.resultScope, currentScope)))) throw new Error("正式采用回执与当前版本不符。结果可能未知，请先查看版本历史，不会自动重试。");
      const message = `排版候选已写入并回读正式版本 ${receipt.versionId}。还须分别核对最终PDF和DOCX。`;
      ownLayoutSave.current = { sourceFingerprint: receipt.resultScope?.contentHash ?? adoptionContext.baseScope.contentHash, message };
      setNotice(message); return receipt;
    } catch (cause) {
      try { adoptionLease.assert(); if (contextRef.current?.id === selectedContext.id) setError(careerStudioError(cause)); } catch { /* A retired owner must not publish an old callback error into a new scope. */ }
      throw cause;
    } finally { finishAdoption(adoptionToken); }
  };
  const adoptEvidence = async (entryId: string, expectedReviewHash: string) => {
    if (!props.onAdoptEvidence) throw new Error("未连接正式证据归档命令。");
    const selectedContext = contextRef.current, adoptionLease = lease.current;
    if (!selectedContext) throw new Error("证据采用授权已变化，未发出新的写入。");
    if (adopting.current?.contextId === selectedContext.id) throw new Error("当前范围已有采用正在回读，请先核对其结果，不会自动重复写入。");
    const adoptionToken = { contextId: selectedContext.id }; adopting.current = adoptionToken;
    try {
      adoptionLease.assert(); const receipt = await props.onAdoptEvidence(entryId, expectedReviewHash); adoptionLease.assert();
      if (adopting.current !== adoptionToken || contextRef.current?.id !== selectedContext.id
        || latest.current.workspaceKey !== selectedContext.workspaceKey || latest.current.resumeId !== selectedContext.resumeId) throw new Error("证据归档回执所属范围已变化。结果可能未知，请先查看版本历史，不会自动重试。");
      return receipt;
    } finally { finishAdoption(adoptionToken); }
  };
  const createContext = async () => {
    const creationLease = captureIdentityLease(), creationSignal = lifetime.current.signal;
    lease.current = creationLease; creationLease.assert(); sessionGeneration.current++;
    const originalFingerprint = props.sourceFingerprint, originalResume = props.resumeId, originalWorkspace = props.workspaceKey;
    const assertCreationCurrent = () => {
      creationLease.assert();
      if (creationSignal.aborted || latest.current.sourceFingerprint !== originalFingerprint || latest.current.resumeId !== originalResume || latest.current.workspaceKey !== originalWorkspace) throw new Error("创建期间原稿或授权变化，未保留旧授权。");
    };
    const jobs = library.filter(j => jobIds.includes(j.id)).map(j => ({ id: canonicalId(j.id), title: j.title, company: j.company, description: j.description.slice(0, 50_000), sourceUrl: /^https?:\/\//.test(j.sourceUrl) ? j.sourceUrl : null,
      platform: j.sourcePlatform || "manual", capturedAt: validDate(j.collectedAt) ?? new Date().toISOString(), firstSeenAt: validDate(j.firstDiscoveredAt), lastSeenAt: validDate(j.lastVerifiedAt), publishedAt: validDate(j.sourcePublishedAt),
      availability: j.lastVerificationMethod === "source-read" && j.lastVerifiedAt ? j.status === "open" ? "active" as const : j.status === "closed" ? "closed" as const : "unknown" as const : "unknown" as const,
      verifiedAt: j.lastVerificationMethod === "source-read" ? validDate(j.lastVerifiedAt) : null, skillIds: skillList(jobSkills[j.id] ?? ""), salaryText: j.salaryText,
      ...parseCareerJobObservation(jobObservations[j.id] ?? emptyCareerJobObservation(), skillList(jobSkills[j.id] ?? "")) }));
    const result = await client.context({ workspaceKey: canonicalId(props.workspaceKey), resumeId: canonicalId(props.resumeId), sourceFingerprint: originalFingerprint, claims: claims.filter(c => selected.includes(c.id)), jobs, consent: true });
    try {
      assertCreationCurrent();
      await client.request("/runtime/select", { contextId: result.context.id, runtime, consent: true }, creationSignal);
      // Pinning is a separate asynchronous boundary. A source/owner change may
      // have happened while no active context existed for the invalidation effect.
      assertCreationCurrent();
      lifetime.current.abort(); lifetime.current = new AbortController(); ownLayoutSave.current = undefined; setOperations({}); setContext(result.context); setNotice("已创建限时只读快照。本地模型固定，修改原稿后须重新授权。");
    } catch (cause) {
      try { creationLease.assert(); await client.request("/context/revoke", { contextId: result.context.id }); } catch { /* A retired identity must not send its context under a new owner. */ }
      throw cause;
    }
  };
  return <div className="career-studio" data-testid="career-studio"><header className="cs-header"><div><span className="cs-eyebrow"><ShieldCheck size={14} /> CAREER EVIDENCE LAB</span><h1>职业演练与证据工作台</h1><p>从可核对的工程证据，到有边界的演练、决策与复盘。</p></div><div className="cs-boundary"><span className="cs-status-dot" />本地优先 · 冻结版本 · 独立采用</div></header>
    {notice && <p className="cs-notice" role="status">{notice}</p>}{error && <p className="cs-error" role="alert">{error}</p>}
    {!context ? <section className="cs-setup" aria-label="选择本次资料和权限"><h2>先选择本次范围</h2><p>只读所选要点和岗位。不传联系人、整份事实库、模型密钥或未授权源码；个人归属默认未知，数值不会自动得到认证。</p><div className="cs-form-grid"><button type="button" disabled={busy} onClick={() => void run(async () => { const models = await client.runtimes(); setRuntimes(models); if (!models.length) setNotice("没有发现可用的本地模型。云代理模型不视为本地，未自动安装或发起计费请求。"); })}>读取已安装的本地模型</button><label>明确选择本地模型<select value={runtime?.model ?? ""} onChange={e => { setRuntime(runtimes.find(r => r.model === e.target.value)); setConsent(false); }}><option value="">不自动选择</option>{runtimes.map(r => <option key={r.modelDigest + r.model} value={r.model}>{r.model} · {r.modelDigest.slice(0, 12)}</option>)}</select></label><button type="button" disabled={busy} onClick={() => void run(async () => { const read = readOpportunityLibrary(); if (read.error) throw new Error(read.error); setLibrary(read.library.jobs.slice(0, 200)); })}>读取当前账号的岗位池（不更改）</button></div>
      <details open><summary>简历要点 · 已选 {selected.length} / {claims.length}</summary><div className="cs-selection-list">{claims.map((claim, index) => <div className="cs-selection-row" key={claim.id}><label className="cs-check"><input type="checkbox" checked={selected.includes(claim.id)} onChange={e => setSelected(e.target.checked ? [...selected, claim.id] : selected.filter(i => i !== claim.id))} /><span><small>{fields[index]?.label}</small>{claim.text}</span></label>{selected.includes(claim.id) && <div className="cs-form-grid"><label>本人贡献边界<select value={claim.contribution} onChange={e => setClaims(previous => previous.map(c => c.id === claim.id ? { ...c, contribution: e.target.value as Claim["contribution"], confirmedByUser: false } : c))}><option value="unknown">未知，不计作本人已实现</option><option value="implementation">本人参与实现</option><option value="design">本人仅作设计</option><option value="not_mine">不是本人贡献</option></select></label><label>明确技能编号（逗号分隔）<input value={claim.skillIds.join(", ")} onChange={e => setClaims(previous => previous.map(c => c.id === claim.id ? { ...c, skillIds: skillList(e.target.value) } : c))} /></label><label className="cs-check"><input type="checkbox" checked={claim.confirmedByUser} disabled={claim.contribution === "unknown"} onChange={e => setClaims(previous => previous.map(c => c.id === claim.id ? { ...c, confirmedByUser: e.target.checked } : c))} />本人明确确认这条原话和所选贡献边界（自述，不是独立核验）</label></div>}</div>)}</div></details>
      {!!library.length && <details><summary>目标岗位池 · 已选 {jobIds.length} / {library.length}</summary>{library.map(job => <div className="cs-selection-row" key={job.id}><label className="cs-check"><input type="checkbox" checked={jobIds.includes(job.id)} onChange={e => setJobIds(e.target.checked ? [...jobIds, job.id] : jobIds.filter(id => id !== job.id))} /><span>{job.company} · {job.title}<small>采集：{job.collectedAt} · 在招状态保留原观察，不将导入当作验证</small></span></label>{jobIds.includes(job.id) && <><label>JD明确要求的技能编号（核对原文后填写）<input value={jobSkills[job.id] ?? ""} onChange={e => setJobSkills(previous => ({ ...previous, [job.id]: e.target.value }))} /></label><CareerJobObservationEditor skills={skillList(jobSkills[job.id] ?? "")} value={jobObservations[job.id] ?? emptyCareerJobObservation()} onChange={value => setJobObservations(previous => ({ ...previous, [job.id]: value }))} /></>}</div>)}</details>}
      <label className="cs-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />同意创建当前账号30分钟的冻结内容快照，供下面明确发起的分析使用；不授权自动投递、发布或事实写入</label><button type="button" className="cs-primary" disabled={busy || !consent || !runtime || !props.sourceFingerprint} onClick={() => void run(createContext)}>{busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}建立本次演练范围</button>
    </section> : <><div className="cs-snapshot-bar"><div><strong>只读快照已锁定</strong><span>{context.claims.length}句 · {context.jobs.length}岗 · {runtime?.model} · {context.sourceFingerprint.slice(0, 12)} · {new Date(context.expiresAt).toLocaleTimeString()}到期</span></div><button type="button" onClick={invalidate}>撤销本次范围并重新选择</button></div><nav className="cs-tabs" aria-label="职业实验能力">{tabs.map(({ id, label, detail, icon: Icon }) => <button type="button" key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}><Icon size={17} /><span>{label}</span><small>{detail}</small></button>)}</nav><main className="cs-content" key={context.id}>
      {runtime && ["committee", "simulation", "forensics", "spatial"].includes(tab) && <CareerAnalysisPanel key={tab} kind={tab as "committee" | "simulation" | "forensics" | "spatial"} context={context} runtime={runtime} request={scopedRequest} operation={operations[tab === "spatial" ? "badge" : tab]} onOperation={onOperation} claimTargets={targets} onApplyWording={props.onApplyWording}
        spatialBinding={{ ownerId: context.ownerId, sessionGeneration: sessionGeneration.current, contextId: context.id, revision: context.sourceFingerprint }} getSpatialBinding={() => { const current = getScope(), ctx = contextRef.current; if (!ctx) throw new Error("星图授权已失效。"); return { ownerId: current.ownerId, sessionGeneration: current.sessionGeneration, contextId: ctx.id, revision: current.revision }; }} />}
      {tab === "harvest" && runtime && <CareerEvidenceInbox runtime={runtime} request={scopedRequest} onAdoptEvidence={props.onAdoptEvidence ? adoptEvidence : undefined} />}
      {tab === "layout" && scope && layoutSource.current && <CareerLayoutPanel resume={layoutSource.current.resume} scope={scope} getCurrentScope={getScope} model={layoutModel} onAdopt={props.onAdoptLayout ? adoptLayout : undefined} exportFinalArtifact={finalExporter} finalOperationTimeoutMs={120_000} />}
      {tab === "architecture" && architectureBinding && <CareerArchitectureLab binding={architectureBinding} getCurrentBinding={getArchitectureBinding} evidence={architectureEvidence.current?.evidence ?? []}
        importEvidence={architecture && operations.committee?.status === "completed" ? (binding, signal) => architecture.importEvidence(binding, operations.committee!.id, signal) : undefined}
        onEvidenceInventoryChanged={updateArchitectureEvidence} interviewer={architecture?.interview} storage={architecture?.storage} onExport={artifact => { const blob = new Blob([artifact.text], { type: artifact.mime }), url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click(); URL.revokeObjectURL(url); }} />}
      {tab === "trust" && runtime && <CareerTrustPanel contextId={context.id} runtime={runtime} request={scopedRequest} />}
      {tab === "replay" && runtime && <CareerReplayFeedbackPanel contextId={context.id} runtime={runtime} request={scopedRequest} />}
    </main></>}
    <footer className="cs-footer">源码可证明实现存在，不自动证明作者、上线效果或个人贡献。分析、提案、发布与正式写入各有独立权限；未知结果不自动重试。</footer>
  </div>;
}
