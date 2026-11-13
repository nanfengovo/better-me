import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { StudioOperationSchema, type StudioContext, type StudioLocalRuntime, type StudioOperation } from "@better-me/agent-contracts/career-studio";
import type { CareerSimulationReport, CommitteeReport, JobForensicsReport } from "@better-me/core/career-intelligence";
import type { ResumeProposalTarget } from "@better-me/agent-contracts";
import { careerStudioError, type StudioRequest } from "../services/career-studio-client";
import { AgentTaskClientError } from "../services/agent-task-transport";
import type { SkillConstellationBinding } from "../lib/skill-constellation";
const AtlasSkillConstellation = lazy(() => import("./AtlasSkillConstellation"));

export interface CareerAnalysisPanelProps {
  kind: "committee" | "simulation" | "forensics" | "spatial";
  context: StudioContext; runtime: StudioLocalRuntime; request: StudioRequest;
  operation?: StudioOperation; onOperation(operation: StudioOperation): void;
  claimTargets: Record<string, ResumeProposalTarget>;
  spatialBinding?: SkillConstellationBinding; getSpatialBinding?(): SkillConstellationBinding;
  onApplyWording?(input: { targetRef: ResumeProposalTarget; originalText: string; proposedText: string }): Promise<{ ok: boolean; message?: string }>;
}
const operationSchema = StudioOperationSchema;
const roleLabels: Record<string, string> = { recruiter: "HR 漏斗", red_team: "魔鬼架构师", advocate: "候选人辩护人", adjudicator: "证据裁定人", independent: "独立审查", cross_review: "红蓝质询", final: "最终裁定" };
const supportLabels: Record<string, string> = { supported: "资料支持", partial: "部分支持", contradicted: "资料冲突", unknown: "证据未知" };
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
const metricReceiptProjection = z.object({ schemaVersion: z.literal(1), metric: z.enum(["declaredTransitionEntries", "evolutionDays", "testCoveragePercent"]), value: z.number().finite().nonnegative(), targetHash: sourceHash,
  method: z.string(), scope: z.string(), executionVerified: z.literal(false), hash: sourceHash, limitations: z.array(z.string()),
  inputs: z.array(z.discriminatedUnion("kind", [z.object({ kind: z.literal("broker_excerpt"), id: z.string(), path: z.string(), sourceHash, excerptHash: sourceHash, startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
    z.object({ kind: z.literal("git_capture_metadata"), repositoryId: sourceHash, commit: z.string(), committedAt: z.string(), hash: sourceHash })])) });
const badgeProjectionSchema = z.object({ badge: z.object({ id: z.string(), observation: z.object({ receipt: z.object({ id: z.string() }).passthrough(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), skillIds: z.array(z.string()) }).passthrough(), parameters: z.record(z.unknown()),
  mapping: z.array(z.object({ channel: z.string(), metric: z.string(), value: z.number().nullable(), rule: z.string() })) }).passthrough(),
  links: z.object({ links: z.array(z.object({ id: z.string(), badgeId: z.string(), jobId: z.string(), skillIds: z.array(z.string()), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90), strength: z.number().finite(), meaning: z.literal("explicit_skill_evidence_overlap_not_hiring_probability") })), excludedJobs: z.number().int().nonnegative(), limitations: z.array(z.string()) }),
  measurement: z.object({ schemaVersion: z.literal(1), targetHash: sourceHash, status: z.enum(["observed", "unknown", "stale", "cancelled"]), metricReceipts: z.array(metricReceiptProjection).max(3), unknowns: z.array(z.string()), limitations: z.array(z.string()) }).passthrough().optional(),
  rendered: z.object({ dataUrl: z.string().startsWith("data:image/png;base64,").max(12_000_000), receipt: z.object({ artifactHash: z.string(), renderer: z.string(), elapsedMs: z.number(), hardware: z.string() }).passthrough() }).optional(), limitations: z.array(z.string()) }).passthrough();
const input = (label: string, value: string, change: (v: string) => void, placeholder = "") => <label>{label}<input value={value} onChange={e => change(e.target.value)} placeholder={placeholder} /></label>;
const list = (rows?: readonly string[]) => rows?.length ? <ul>{rows.map((row, i) => <li key={`${i}-${row}`}>{row}</li>)}</ul> : <p className="cs-muted">未提供，不推断。</p>;

export function CareerAnalysisPanel(props: CareerAnalysisPanelProps) {
  const { kind, context, request, operation } = props;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [root, setRoot] = useState(""), [sourceFile, setSourceFile] = useState(""), [firstLine, setFirstLine] = useState("1"), [lastLine, setLastLine] = useState("60"), [statement, setStatement] = useState("");
  const [plan, setPlan] = useState(""), [skills, setSkills] = useState(""), [hours, setHours] = useState("28"), [days, setDays] = useState("14");
  const [url, setUrl] = useState(""), [publicSources, setPublicSources] = useState<Array<{ id: string; sourceUrl: string; sourceHash: string; capturedAt: string; text: string }>>([]);
  const [companyKey, setCompanyKey] = useState(""), [techSkills, setTechSkills] = useState("");
  const [publicationId, setPublicationId] = useState(""), [publications, setPublications] = useState<Array<{ id: string; statement: string }>>([]), [render, setRender] = useState(false);
  const [metricRoot, setMetricRoot] = useState(""), [transitionSelected, setTransitionSelected] = useState(false), [coverageSelected, setCoverageSelected] = useState(false), [metricConsent, setMetricConsent] = useState(false);
  const [transitionPath, setTransitionPath] = useState(""), [transitionFirst, setTransitionFirst] = useState("1"), [transitionLast, setTransitionLast] = useState("1");
  const [coverageFormat, setCoverageFormat] = useState("lcov"), [reportPath, setReportPath] = useState(""), [reportFirst, setReportFirst] = useState("1"), [reportLast, setReportLast] = useState("1");
  const [manifestPath, setManifestPath] = useState(""), [manifestFirst, setManifestFirst] = useState("1"), [manifestLast, setManifestLast] = useState("1");
  const [coverageSourcePath, setCoverageSourcePath] = useState(""), [coverageSourceFirst, setCoverageSourceFirst] = useState("1"), [coverageSourceLast, setCoverageSourceLast] = useState("1");
  const [reviewClaimId, setReviewClaimId] = useState(""), [reviewAction, setReviewAction] = useState(""), [reviewRole, setReviewRole] = useState(""), [deployment, setDeployment] = useState("");
  const [consent, setConsent] = useState(false), [wordingConfirm, setWordingConfirm] = useState<string[]>([]), [adoptAttempted, setAdoptAttempted] = useState<string[]>([]);
  const pendingCommittee = useRef<{ contextId: string; body: unknown } | undefined>(undefined);
  useEffect(() => { setError(""); setNotice(""); setConsent(false); setMetricConsent(false); }, [kind, context.id]);
  useEffect(() => { setConsent(false); }, [root, sourceFile, firstLine, lastLine, statement, props.runtime.model, props.runtime.modelDigest]);
  const run = async (execute: () => Promise<unknown>, saveOperation = false) => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { const result = await execute(); if (saveOperation) { const parsed = operationSchema.parse(result); if (parsed.contextId !== context.id) throw new Error("分析来源不匹配。"); props.onOperation(parsed); } }
    catch (cause) { setError(careerStudioError(cause)); } finally { setBusy(false); }
  };
  const base = () => ({ contextId: context.id, idempotencyKey: crypto.randomUUID(), consent: true, runtime: props.runtime });
  const startCommittee = () => run(async () => {
    const send = async (body: unknown) => {
      pendingCommittee.current = { contextId: context.id, body };
      try { const result = await request("/committee/start", body); pendingCommittee.current = undefined; return result; }
      catch (error) {
        if (error instanceof AgentTaskClientError && !["outcome_unknown", "studio_outcome_unknown_check_state"].includes(error.code)) pendingCommittee.current = undefined;
        throw error;
      }
    };
    if (pendingCommittee.current?.contextId === context.id) {
      return send(pendingCommittee.current.body);
    }
    const code = root.trim() ? [{ root: root.trim(), files: [{ path: sourceFile.trim(), startLine: Number(firstLine), endLine: Number(lastLine) }] }] : [];
    if (code.length && (!sourceFile.trim() || !Number.isSafeInteger(Number(firstLine)) || !Number.isSafeInteger(Number(lastLine)) || Number(lastLine) < Number(firstLine) || Number(lastLine) - Number(firstLine) >= 80)) throw new Error("请选择正序、最多80行的明确源码文件范围。");
    const statements = context.claims.filter(c => c.confirmedByUser).map(c => ({ kind: "user_statement", label: "本人已确认的陈述（非独立核验）", text: c.text }));
    if (statement.trim()) statements.push({ kind: "user_statement", label: "本次补充的本人陈述", text: statement });
    if (context.claims.length > 40 || statements.length > 20) throw new Error("本次最多选择40句、20份陈述；请重新明确选择资料，不会截取后发送。");
    const selected = { contextId: context.id, consent: true, runtime: props.runtime, claimIds: context.claims.map(c => c.id), statements, code, ...(context.jobs[0] ? { jobId: context.jobs[0].id } : {}) };
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(selected)));
    const body = { ...selected, idempotencyKey: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("") };
    return send(body);
  }, true);
  const startBadge = () => run(() => {
    const file = (path: string, first: string, last: string) => {
      const startLine = Number(first), endLine = Number(last);
      if (!path.trim() || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= 200) throw new Error("每个指标文件须选择明确路径和正序、最多200行的范围。");
      return { path: path.trim(), startLine, endLine };
    };
    if ((transitionSelected || coverageSelected) && (!metricConsent || !metricRoot.trim())) throw new Error("请明确选择指标资料目录，并单独确认只读这些文件范围。");
    return request("/badge/start", { contextId: context.id, publicationId, render, consent: true, idempotencyKey: crypto.randomUUID(),
      ...(transitionSelected || coverageSelected ? { metricSources: { root: metricRoot.trim(),
        ...(transitionSelected ? { transition: { file: file(transitionPath, transitionFirst, transitionLast), format: "json" } } : {}),
        ...(coverageSelected ? { coverage: { format: coverageFormat, report: file(reportPath, reportFirst, reportLast),
          ...(manifestPath.trim() ? { manifest: file(manifestPath, manifestFirst, manifestLast) } : {}), sources: [file(coverageSourcePath, coverageSourceFirst, coverageSourceLast)] } } : {}) } } : {}) });
  }, true);
  const committee = operation?.kind === "committee" && operation.output ? operation.output as CommitteeReport : undefined;
  const simulation = operation?.kind === "simulation" && operation.output ? operation.output as CareerSimulationReport : undefined;
  const forensics = operation?.kind === "forensics" && operation.output ? operation.output as JobForensicsReport : undefined;
  const parsedBadge = operation?.kind === "badge" && operation.output ? badgeProjectionSchema.safeParse(operation.output) : undefined;
  const badge = parsedBadge?.success ? parsedBadge.data : undefined;
  const publicationReview = async () => {
    if (!committee || !reviewClaimId || !reviewAction.trim()) return;
    const claim = committee.claims.find(c => c.claimId === reviewClaimId); if (!claim) return;
    await run(async () => { await request("/publication/review", { contextId: context.id, operationId: operation!.id, claimId: claim.claimId, expectedClaimHash: claim.claimHash,
      disclosure: "publishable", review: { kind: claim.contribution, action: reviewAction.trim(), role: reviewRole, deployment }, consent: true, idempotencyKey: crypto.randomUUID() }); setNotice("已保存可公开的证据核对记录；尚未发布分身。个人贡献仍标注为本人自述。"); });
  };
  return <section className="cs-analysis" aria-label={{ committee: "影子招聘委员会", simulation: "职业投资反事实推演", forensics: "岗位情报对账", spatial: "回执徽章与技能星图" }[kind]}>
    {kind === "committee" && <>
      <header><h2>影子招聘委员会</h2><p>4 个独立角色 → 红蓝交叉质询 → 证据裁定。只读所选片段，未证实的个人归属、指标和成果保持未知。</p></header>
      <div className="cs-form-grid">{input("授权源码目录（可选，绝对路径）", root, setRoot, "/明确选择的项目目录")}{input("目录内源码文件", sourceFile, setSourceFile, "src/service.ts")}{input("起始行", firstLine, setFirstLine)}{input("结束行（最多80行）", lastLine, setLastLine)}</div>
      <label>补充本人陈述或贡献边界<textarea value={statement} maxLength={24000} onChange={e => setStatement(e.target.value)} placeholder="明确本人做了什么、只是设计还是已实现、是否上线；不确定请写不知道。" /></label>
      <p className="cs-muted">本次最多审查40句、20份陈述。自述不等于独立核验，源码存在不等于本人创作或生产业绩。沿用当前工作区根预算，所有角色、修复与源码重读均计费；不足即停，不自动加额。</p>
      <label className="cs-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />确认仅授权以上目录中所选文件与行号，以及本次冻结资料，交由指定本地模型审查</label>
      <button type="button" disabled={!consent || busy || operation?.status === "running" || !context.claims.length} onClick={startCommittee}>开始有界抗压测试</button>
      {pendingCommittee.current?.contextId === context.id && <details><summary>上次创建回执待核对；再次开始只核对这份冻结资料，不发送当前改动</summary><pre>{JSON.stringify(pendingCommittee.current.body, null, 2)}</pre></details>}
      {committee && <div className="cs-report"><h3>抗压测试报告 · {committee.status === "completed" ? "流程完成" : "未完成，不能采用为通过"}</h3><p>{operation?.usage?.modelCalls ?? committee.usage.modelCalls}次实际模型调用 · {operation?.usage?.toolCalls ?? committee.usage.toolCalls}次实际工具调用 · {((operation?.usage?.elapsedMs ?? committee.usage.elapsedMs) / 1000).toFixed(1)}秒；整组总额度以工作区根账为准</p>
        {committee.issues?.some(issue => !issue.claimId) && <div><h4>本次流程与事实校验限制</h4>{list(committee.issues.filter(issue => !issue.claimId).map(issue => `${issue.code}：${issue.detail}`))}</div>}
        <details><summary>角色、交叉质询与裁定记录（{committee.roles.length}）</summary>{committee.roles.map((r, i) => <article key={i}><h4>{roleLabels[r.role]} · {roleLabels[r.stage]}</h4><p>{r.decision?.summary ?? r.error ?? "未返回完整意见"}</p>{list(r.issues.map(issue => `${issue.code}：${issue.detail}`))}</article>)}</details>
        {committee.claims.map(claim => <article className={`cs-claim cs-risk-${claim.riskLevel}`} key={claim.claimId}><h4>{supportLabels[claim.support]} · {claim.riskLevel === "high" ? "高风险" : claim.riskLevel === "medium" ? "需补证" : "低风险，不代表真实性认证"}</h4><blockquote>{context.claims.find(c => c.id === claim.claimId)?.text}</blockquote>
          {committee.issues?.some(issue => issue.claimId === claim.claimId) && <div><strong>本句事实与引用校验</strong>{list(committee.issues.filter(issue => issue.claimId === claim.claimId).map(issue => `${issue.code}：${issue.detail}`))}</div>}
          <strong>面试追问</strong>{list(claim.questions)}<strong>防守依据</strong>{list(claim.defense)}<strong>缺失与风险</strong>{list([...claim.risks, ...claim.missing])}
          <details><summary>精确引用与限制</summary>{claim.citations.map((c, i) => <div key={i}><p>{c.evidenceId} · 行 {c.startLine}–{c.endLine} · <code>{c.sourceHash.slice(0, 16)}</code></p><pre>{c.quote}</pre></div>)}{list(claim.limitations)}</details>
          {claim.rewriteProposal && <div className="cs-proposal"><h5>待审措辞提案（不自动修改事实）</h5><del>{claim.rewriteProposal.originalText}</del><ins>{claim.rewriteProposal.proposedText}</ins><label className="cs-check"><input type="checkbox" checked={wordingConfirm.includes(claim.claimId)} onChange={e => setWordingConfirm(e.target.checked ? [...wordingConfirm, claim.claimId] : wordingConfirm.filter(id => id !== claim.claimId))} />我已核对事实、数字与个人归属，仅批准这句措辞</label><button type="button" disabled={busy || !props.onApplyWording || !wordingConfirm.includes(claim.claimId) || adoptAttempted.includes(claim.claimId)} onClick={() => void run(async () => { const targetRef = props.claimTargets[claim.claimId]; if (!targetRef) throw new Error("缺少可写入的原句定位。"); setAdoptAttempted(previous => [...previous, claim.claimId]); const result = await props.onApplyWording!({ targetRef, originalText: claim.rewriteProposal!.originalText, proposedText: claim.rewriteProposal!.proposedText }); if (!result.ok) throw new Error(result.message ?? "措辞未保存。"); setNotice(result.message ?? "措辞已提交现有版本保存流程。请核对正式版本。"); })}>批准这一句到当前简历</button></div>}
        </article>)}
        {committee.status === "completed" && <fieldset><legend>独立审阅可公开陈述（尚未发布）</legend><label>仅可选择资料支持且贡献边界明确的句子<select value={reviewClaimId} onChange={e => setReviewClaimId(e.target.value)}><option value="">请选择</option>{committee.claims.filter(c => c.support === "supported" && ["implementation", "design"].includes(c.contribution)).map(c => <option key={c.claimId} value={c.claimId}>{context.claims.find(f => f.id === c.claimId)?.text.slice(0, 80)}</option>)}</select></label><label>本人实际贡献原话<textarea value={reviewAction} onChange={e => setReviewAction(e.target.value)} /></label><div className="cs-form-grid">{input("角色边界", reviewRole, setReviewRole)}{input("部署/未上线说明", deployment, setDeployment)}</div><p>公开记录不会包含私有源码原文，只保留来源版本核对说明。核对记录不是独立作者、生产规模或公司认可认证。</p><button type="button" disabled={busy || !reviewClaimId || !reviewAction.trim()} onClick={() => void publicationReview()}>确认这些文字可进入公开预览</button></fieldset>}
        {list(committee.limitations)}</div>}
    </>}
    {kind === "simulation" && <>
      <header><h2>职业路径反事实推演</h2><p>固定同一组 {context.jobs.length} 个岗位，只比较条件场景下的证据覆盖变化；不是市场分位数、Offer概率或已完成事实。</p></header>
      <label>计划完成的具体工程成果<textarea value={plan} maxLength={4000} onChange={e => setPlan(e.target.value)} placeholder="例如：补齐状态机竞态评测集，保留可复现脚本与失败样例。" /></label>
      <div className="cs-form-grid">{input("假设新增的明确技能编号（逗号分隔）", skills, setSkills, "evaluation, concurrency")}{input("投入小时", hours, setHours)}{input("投入天数", days, setDays)}</div>
      <p>基础层仅计已确认的本人陈述，权重0.5；未知贡献不计入。敏感性分别按 25%、60%、100% 的实现与迁移乘积计算。缺少在招观察、薪资口径、硬门槛时不会声称解锁高薪岗位。</p>
      <button type="button" disabled={busy || !context.jobs.length || !plan.trim() || !skills.trim() || operation?.status === "running"} onClick={() => void run(() => request("/simulation/start", { ...base(), plan: { id: crypto.randomUUID(), description: plan, hypotheticalFacts: [{ id: `hypothesis-${crypto.randomUUID()}`, description: plan, skillIds: skills.split(/[,，]/).map(s => s.trim()).filter(Boolean), contribution: "implementation" }], cost: { hours: Number(hours), days: Number(days) }, sensitivities: [{ id: "conservative", realizationFraction: 0.5, transferability: 0.5 }, { id: "middle", realizationFraction: 0.75, transferability: 0.8 }, { id: "conditional-complete", realizationFraction: 1, transferability: 1 }] } }), true)}>冻结岗位池并计算三种场景</button>
      {simulation && <div className="cs-report"><h3>证据覆盖敏感性</h3><p>基线平均覆盖：{simulation.baseline?.distribution.mean.toFixed(2) ?? "未知"}% · 条件提升范围：{simulation.sensitivityBounds ? `${simulation.sensitivityBounds.minMeanCoverageDelta.toFixed(2)}–${simulation.sensitivityBounds.maxMeanCoverageDelta.toFixed(2)} 个百分点` : "未知"}</p><div className="cs-table-scroll"><table><thead><tr><th>条件场景</th><th>平均覆盖变化</th><th>满足已知条件的新增岗位</th><th>每小时覆盖点</th><th>高薪证据缺失</th></tr></thead><tbody>{simulation.scenarios.map(s => <tr key={s.id}><td>{s.id}（假设）</td><td>+{s.meanCoverageDelta.toFixed(2)}</td><td>{s.conditionalUnlocks.length}</td><td>{s.roi.coveragePointsPerHour?.toFixed(3) ?? "未知"}</td><td>{s.salaryUnknownUnlocks.length}</td></tr>)}</tbody></table></div><details><summary>逐岗位条件与阻塞项</summary>{simulation.baseline?.jobs.map(j => <p key={j.jobId}>{context.jobs.find(job => job.id === j.jobId)?.title} · {j.coverage}% · {j.blockers.join("、") || "本次已知条件满足"}</p>)}</details>{list(simulation.unknowns)}{list(simulation.limitations)}</div>}
    </>}
    {kind === "forensics" && <>
      <header><h2>岗位情报对账</h2><p>对照挂出时间、在招观察和公开技术材料，给出有来源的异常信号。不能据此认定“HR刷KPI”“公司不招人”或“进去必做CRUD”。</p></header>
      <div className="cs-form-grid">{input("明确选择的公开HTTPS页面", url, setUrl, "https://公司官方技术博客/文章")}{input("与选定岗位对应的公司分组编号", companyKey, setCompanyKey, context.jobs[0]?.companyKey ?? "尚未选择")}{input("公开页面明确出现的技术编号（逗号分隔）", techSkills, setTechSkills)}</div>
      <label className="cs-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />同意仅以无登录、无Cookie的GET读取这个公开页面；不使用浏览器现有账号</label>
      <button type="button" disabled={busy || !url.trim() || !consent} onClick={() => void run(async () => { const result = z.object({ id: z.string(), sourceUrl: z.string(), sourceHash: z.string(), capturedAt: z.string(), text: z.string() }).passthrough().parse(await request("/sources/read", { contextId: context.id, url, purpose: "public_technical_evidence", consent: true })); setPublicSources(previous => [...previous, result]); })}>读取并保存本次公开观察</button>
      {publicSources.map(s => <details key={s.id}><summary>{s.sourceUrl} · {new Date(s.capturedAt).toLocaleString()} · {s.sourceHash.slice(0, 12)}</summary><pre>{s.text}</pre><p>该页面没有自动证明所选公司/部门或岗位；请自行核对分组与技术文本。</p></details>)}
      <button type="button" disabled={busy || !context.jobs.length || operation?.status === "running"} onClick={() => void run(() => request("/forensics/start", { contextId: context.id, idempotencyKey: crypto.randomUUID(), consent: true, publicObservations: companyKey.trim() && techSkills.trim() ? publicSources.map(s => ({ sourceId: s.id, companyKey: companyKey.trim(), scope: "company", departmentKey: null, skillIds: techSkills.split(/[,，]/).map(x => x.trim()).filter(Boolean) })) : [] }), true)}>对账冻结岗位观察</button>
      {forensics && <div className="cs-report"><h3>可解释信号，不是幽灵岗判决</h3>{forensics.signals.map((s, i) => <article key={i}><h4>{s.code} · {s.strength === "medium" ? "中等异常" : "弱信号"}</h4><p>{s.summary}</p>{list(s.uncertainty)}{s.sourceRefs.map(ref => <p key={ref.id}>{ref.url ? <a href={ref.url} target="_blank" rel="noreferrer">来源披露</a> : ref.id} · {ref.capturedAt} · {ref.hash.slice(0, 16)}</p>)}</article>)}{!forensics.signals.length && <p>所选观察没有产生规则信号；这不等于岗位真实在招。</p>}<h4>未知项</h4>{list(forensics.unknowns)}<h4>同岗归并建议（不自动改库）</h4>{forensics.mergeProposals.map(p => <p key={p.id}>待审：{p.memberObservationIds.join("、")}；原始记录仍分别保留。</p>)}{list(forensics.limitations)}</div>}
    </>}
    {kind === "spatial" && <>
      <header><h2>回执徽章与技能星图</h2><p>视觉只编码受信回执覆盖的观测，不以复杂度、行数或华丽程度推导能力、算力PoW或录用概率。</p></header>
      <button type="button" disabled={busy} onClick={() => void run(async () => { const result = z.object({ facts: z.array(z.object({ id: z.string(), statement: z.string() }).passthrough()) }).parse(await request("/publication/list", {})); setPublications(result.facts); })}>加载已审阅的公开核对记录</button>
      <label>选择本次资料的核对回执<select value={publicationId} onChange={e => setPublicationId(e.target.value)}><option value="">请选择</option>{publications.map(p => <option key={p.id} value={p.id}>{p.statement.slice(0, 100)}</option>)}</select></label>
      <fieldset><legend>可选：读取真实指标资料（不接受模型自报数字）</legend>
        <label className="cs-check"><input type="checkbox" checked={transitionSelected} onChange={e => { setTransitionSelected(e.target.checked); setMetricConsent(false); }} />读取显式JSON状态转换表，只计 state→event→字符串target 的声明条目</label>
        <label className="cs-check"><input type="checkbox" checked={coverageSelected} onChange={e => { setCoverageSelected(e.target.checked); setMetricConsent(false); }} />读取覆盖率报告与源码哈希绑定，不执行项目测试</label>
        {(transitionSelected || coverageSelected) && <>
          {input("指标资料目录（明确授权的绝对路径）", metricRoot, value => { setMetricRoot(value); setMetricConsent(false); }, "/明确选择的项目目录")}
          {transitionSelected && <div className="cs-form-grid">{input("转换表文件（JSON）", transitionPath, value => { setTransitionPath(value); setMetricConsent(false); }, "state-table.json")}{input("转换表起始行", transitionFirst, value => { setTransitionFirst(value); setMetricConsent(false); })}{input("转换表结束行（最多200行）", transitionLast, value => { setTransitionLast(value); setMetricConsent(false); })}</div>}
          {coverageSelected && <>
            <label>覆盖率格式<select value={coverageFormat} onChange={e => { setCoverageFormat(e.target.value); setMetricConsent(false); }}><option value="lcov">LCOV（所选 .txt 文件）</option><option value="cobertura">Cobertura（尚无解析器，保持未知）</option></select></label>
            <div className="cs-form-grid">{input("报告文件（仅broker原有允许的路径/扩展名）", reportPath, value => { setReportPath(value); setMetricConsent(false); }, "reports/line-hits.txt")}{input("报告起始行", reportFirst, value => { setReportFirst(value); setMetricConsent(false); })}{input("报告结束行（最多200行）", reportLast, value => { setReportLast(value); setMetricConsent(false); })}</div>
            <div className="cs-form-grid">{input("哈希绑定manifest文件（可选，缺少即未知）", manifestPath, value => { setManifestPath(value); setMetricConsent(false); }, "reports/source-binding.json")}{input("manifest起始行", manifestFirst, value => { setManifestFirst(value); setMetricConsent(false); })}{input("manifest结束行（最多200行）", manifestLast, value => { setManifestLast(value); setMetricConsent(false); })}</div>
            <div className="cs-form-grid">{input("覆盖率对应源码文件", coverageSourcePath, value => { setCoverageSourcePath(value); setMetricConsent(false); }, "src/service.ts")}{input("源码起始行", coverageSourceFirst, value => { setCoverageSourceFirst(value); setMetricConsent(false); })}{input("源码结束行（最多200行）", coverageSourceLast, value => { setCoverageSourceLast(value); setMetricConsent(false); })}</div>
            <details><summary>绑定清单格式与限制</summary><pre>{'{"protocol":"betterme.coverage-source-binding.v1","reportHash":"报告完整文件SHA256","files":[{"reportPath":"LCOV中原样SF路径","sourcePath":"所选目录内源码路径","sourceHash":"源码完整文件SHA256"}]}'}</pre><p>不猜文件名对应关系；缺少报告或源码版本绑定就保持未知。报告声明不是本轮执行认证，只计算所选片段里列明的DA行。不会放宽broker已有排除目录或扩展名策略。</p></details>
          </>}
          <p>每段最多200行，数据不会交给模型。JSON声明条目不是运行时复杂度；覆盖率报告可能是人工声明。未提供已授权Git提交采集回执时演进跨度保持未知。</p>
          <label className="cs-check"><input type="checkbox" checked={metricConsent} onChange={e => setMetricConsent(e.target.checked)} />授权只读以上明确文件与行号；同意展示来源哈希和未核实限制，不执行仓库代码或测试</label>
        </>}
      </fieldset>
      <label className="cs-check"><input type="checkbox" checked={render} onChange={e => setRender(e.target.checked)} />另外授权本机 Vork 有界渲染（最高300秒，首次编译可能较慢）</label>
      <button type="button" disabled={busy || !publicationId || operation?.status === "running" || (transitionSelected || coverageSelected) && !metricConsent} onClick={() => void startBadge()}>编译回执徽章{render ? "并实际渲染" : "（不生成图片）"}</button>
      {parsedBadge && !parsedBadge.success && <p role="alert">徽章产物结构未通过核对，没有创建三维场景。</p>}
      {badge && <div className="cs-report"><h3>{badge.badge.id}</h3>{badge.rendered ? <figure><img className="cs-badge" src={badge.rendered.dataUrl} alt="由本次核对回执编译并经Vork实际渲染的参数徽章" /><figcaption>实际 {badge.rendered.receipt.renderer} · {(badge.rendered.receipt.elapsedMs / 1000).toFixed(1)}秒 · GPU硬件未测量 · PNG {badge.rendered.receipt.artifactHash.slice(0, 16)}</figcaption></figure> : <p>目前仅编译场景，未渲染图片。</p>}<div className="cs-table-scroll"><table><thead><tr><th>视觉通道</th><th>观测</th><th>值</th><th>映射规则</th></tr></thead><tbody>{badge.badge.mapping.map(m => <tr key={m.channel}><td>{m.channel}</td><td>{m.metric}</td><td>{m.value ?? "未知，中性参数"}</td><td>{m.rule}</td></tr>)}</tbody></table></div>
      {badge.measurement && <details><summary>指标读取与测量回执（{badge.measurement.metricReceipts.length}）</summary><p>目标陈述哈希：<code>{badge.measurement.targetHash}</code>；这是回执绑定目标，不等于源码哈希。本轮未执行测试；报告/静态声明不认证真实运行、个人作者或工作量。</p>
        {badge.measurement.metricReceipts.map(receipt => <article key={receipt.hash}><h4>{receipt.metric} · {receipt.value}</h4><p>{receipt.method} · {receipt.scope}</p><p>测量回执：<code>{receipt.hash}</code></p>{receipt.inputs.map((ref, index) => <div key={index}>{ref.kind === "broker_excerpt" ? <><p>{ref.path} · 行 {ref.startLine}–{ref.endLine}</p><p>完整文件SHA256：<code>{ref.sourceHash}</code></p><p>所选片段SHA256：<code>{ref.excerptHash}</code></p></> : <p>已授权提交元数据：{ref.commit} · {ref.committedAt} · <code>{ref.hash}</code>；不证明连续工作时长。</p>}</div>)}{list(receipt.limitations)}</article>)}
        <h4>仍然未知</h4>{list(badge.measurement.unknowns)}{list(badge.measurement.limitations)}</details>}
      {props.spatialBinding && props.getSpatialBinding && <Suspense fallback={<p role="status">正在加载技能星图控件，尚未观察到三维渲染帧。</p>}><AtlasSkillConstellation binding={props.spatialBinding} getCurrentBinding={props.getSpatialBinding} badge={{ id: badge.badge.id, label: "本次已审阅实践", verificationReceiptId: badge.badge.observation.receipt.id, sourceHash: badge.badge.observation.sourceHash, skillIds: badge.badge.observation.skillIds }} links={badge.links.links} excludedJobs={badge.links.excludedJobs} limitations={badge.links.limitations} jobMetadata={context.jobs.map(j => ({ jobId: j.id, label: j.title, company: j.company }))} /></Suspense>}
      <p>排除 {badge.links.excludedJobs} 个未持久化、未索引、缺少精确办公室核对或没有技能交集的岗位。不会使用城市中心代替。</p>{list([...badge.limitations, ...badge.links.limitations])}</div>}
    </>}
    {operation && <div className="cs-operation" role="status"><span>{operation.status === "running" ? "本地有界分析运行中，可取消；刷新只读取状态" : `分析状态：${operation.taskStatus ?? operation.status}`}</span>{operation.errorCode && <code>{operation.errorCode}</code>}{operation.status === "running" && <button type="button" onClick={() => void run(async () => props.onOperation(operationSchema.parse(await request("/operation/cancel", { contextId: context.id, operationId: operation.id }))))}>取消本次分析</button>}
      {operation.id.startsWith("ct_") && <button type="button" disabled={busy} onClick={() => void run(async () => props.onOperation(operationSchema.parse(await request("/operation/read", { contextId: context.id, operationId: operation.id }))))}>核对原任务状态</button>}
      {operation.id.startsWith("ct_") && ["ready", "paused", "interrupted", "budget_exhausted", "failed"].includes(operation.taskStatus ?? "") && <button type="button" disabled={busy || !consent} onClick={() => void run(async () => props.onOperation(operationSchema.parse(await request("/committee/resume", { contextId: context.id, operationId: operation.id, runtime: props.runtime, consent: true }))))}>明确恢复原任务（沿用原预算）</button>}
    </div>}
    {busy && <p role="status">正在核对回执…</p>}{error && <p role="alert" className="cs-error">{error}</p>}{notice && <p role="status" className="cs-notice">{notice}</p>}
  </section>;
}
