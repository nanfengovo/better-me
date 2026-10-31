/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { FactBase } from "@better-me/core";
import { ArrowDown, ArrowUpRight, Bot, Check, ChevronDown, ExternalLink, Loader2, MapPin, RefreshCw, Sparkles, Square, X } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { extractRecommendationProfile, recommendResumeJobs, type RecommendedJob, type RecommendationResult, type RecommendationProfile } from "../lib/resume-job-recommendations";
import { readRecommendationSource, type RecommendationReadOptions, type RecommendationSource } from "../lib/resume-job-source";
import type { DrawerJobContext } from "./JdMatchDrawer";
import "./resume-job-recommendations.css";

type State = { kind: "reading" | "ranking" | "cancelled" | "error" }
  | { kind: "ready"; result: RecommendationResult; source: RecommendationSource; updating: boolean; stopped?: boolean };
export type ResumeJobRecommendationsProps = {
  factBase: FactBase; currentFactBase?: FactBase; isStale?: boolean; requestId: number;
  onRefresh: () => void; onClose: () => void; onOpenAtlas: () => void; onAnalyze: (job: DrawerJobContext) => void; onEditResume?: () => void;
  loadSource?: (signal: AbortSignal, profile: RecommendationProfile, options?: RecommendationReadOptions) => Promise<RecommendationSource>;
};

export default function ResumeJobRecommendations({ factBase, currentFactBase, isStale, requestId, onRefresh, onClose, onOpenAtlas, onAnalyze, onEditResume, loadSource = readRecommendationSource }: ResumeJobRecommendationsProps) {
  const { t, locale } = useUiPreferences();
  const profile = useMemo(() => extractRecommendationProfile(factBase), [factBase]);
  const latestProfileKey = useMemo(() => JSON.stringify(extractRecommendationProfile(currentFactBase ?? factBase)), [currentFactBase, factBase]);
  const profileChanged = isStale ?? (latestProfileKey !== JSON.stringify(profile));
  const [state, setState] = useState<State>({ kind: "reading" });
  const [collapsed, setCollapsed] = useState(false);
  const [sameAreaOnly, setSameAreaOnly] = useState(false);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const cache = useRef<{ requestId: number; source: RecommendationSource } | null>(null);
  const forceRefresh = useRef(false);
  const titleId = `resume-job-recommendations-${requestId}`;
  const busy = state.kind === "reading" || state.kind === "ranking" || (state.kind === "ready" && state.updating);

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    let publication = 0;
    const timeout = setTimeout(() => {
      abort.abort();
      setState(current => current.kind === "ready" ? { ...current, updating: false, source: { ...current.source, partial: true } } : { kind: "error" });
    }, 35_000);
    const publish = async (source: RecommendationSource, updating: boolean) => {
      const currentPublication = ++publication;
      const result = await recommendResumeJobs(source.dataset, profile, { signal: abort.signal, sameAreaOnly });
      if (!abort.signal.aborted && currentPublication === publication) setState({ kind: "ready", source, result, updating });
    };
    setState({ kind: cache.current?.requestId === requestId ? "ranking" : "reading" });
    void (async () => {
      const refresh = forceRefresh.current; forceRefresh.current = false;
      const source = cache.current?.requestId === requestId ? cache.current.source : await loadSource(abort.signal, profile, {
        forceRefresh: refresh, onUpdate: source => { void publish(source, true).catch(() => {}); },
      });
      abort.signal.throwIfAborted();
      cache.current = { requestId, source };
      await publish(source, false);
    })().catch(() => { if (!abort.signal.aborted) setState(current => current.kind === "ready" ? { ...current, updating: false, source: { ...current.source, partial: true } } : { kind: "error" }); })
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); abort.abort(); if (controller.current === abort) controller.current = null; };
  }, [profile, requestId, loadSource, sameAreaOnly, retry]);

  function stop() {
    controller.current?.abort();
    setState(current => current.kind === "ready" ? { ...current, updating: false, stopped: true, source: { ...current.source, partial: true } } : { kind: "cancelled" });
  }
  function refreshSource() { cache.current = null; forceRefresh.current = true; setRetry(value => value + 1); }
  function editResume() { setCollapsed(true); onEditResume?.(); }
  function analyze(job: RecommendedJob) {
    onAnalyze({ id: job.id, title: job.title, company: job.company, description: job.description, location: job.location || undefined,
      salary: job.salary, sourceUrl: job.sourceUrl, sourcePlatform: job.sourcePlatform });
  }
  const status = state.kind === "ready" ? t(`${state.result.jobs.length} 个推荐${state.updating ? " · 继续读取中" : ""}`, `${state.result.jobs.length} recommendations${state.updating ? " · updating" : ""}`)
    : busy ? t("正在匹配", "Matching") : state.kind === "cancelled" ? t("已停止", "Stopped") : t("暂时未能读取", "Not available yet");
  const placeLabel = (job: RecommendedJob) => job.locationMatch === "same-area" ? t("同地区", "Preferred area")
    : job.locationMatch === "other-area" ? t("异地 · 请确认意愿", "Other area · check preference")
    : job.locationMatch === "unknown" ? t("地点待核实", "Location unknown") : t("未设地点偏好", "No location preference");
  const dimensionLabel = { skills: t("技术", "Skills"), tags: t("经历标签", "Experience tags"), role: t("岗位方向", "Role direction"), location: t("地点", "Location") };

  return <section className="resume-job-recs no-print" aria-labelledby={titleId}>
    <header className="rjr-heading">
      <span className="rjr-mark" aria-hidden="true"><Sparkles size={18} /></span>
      <div className="rjr-heading-copy"><h2 id={titleId}>{t("简历岗位推荐", "Jobs for your resume")}</h2><span className="rjr-profile-summary">{[profile.roles[0], profile.location, ...profile.skills.slice(0, 3)].filter(Boolean).join(" · ")}</span></div>
      <span className="rjr-state" role="status">{busy ? <Loader2 size={13} className="rjr-spinner" /> : state.kind === "ready" ? <Check size={13} /> : null}{status}</span>
      <button type="button" className="rjr-edit" onClick={editResume}><ArrowDown size={13} />{t("继续编辑简历", "Continue editing")}</button>
      <button type="button" className="rjr-icon" aria-label={collapsed ? t("展开岗位推荐", "Expand recommendations") : t("收起岗位推荐", "Collapse recommendations")} aria-expanded={!collapsed} aria-controls={`${titleId}-body`} onClick={() => setCollapsed(value => !value)}><ChevronDown size={17} className={collapsed ? "" : "rjr-expanded"} /></button>
      <button type="button" className="rjr-icon" onClick={onClose} aria-label={t("关闭岗位推荐", "Close recommendations")}><X size={16} /></button>
    </header>
    <div id={`${titleId}-body`} hidden={collapsed}>
      <div className="rjr-controls"><p>{t("先显示已返回的岗位，不影响下方编辑。", "Available matches appear first. Keep editing below.")}</p>
        {profile.location && <label><input type="checkbox" checked={sameAreaOnly} onChange={event => setSameAreaOnly(event.target.checked)} />{t("仅看同地区", "Preferred area only")}</label>}
      </div>
      {profileChanged && <div className="rjr-notice">{t("简历已更新，下面仍是上次画像的推荐。", "Your resume changed; these use the previous profile.")}<button type="button" onClick={onRefresh}>{t("按最新简历重选", "Match latest resume")}</button></div>}
      {busy && <div className="rjr-loading-copy" aria-busy="true"><span className="rjr-pulse" aria-hidden="true" />{state.kind === "ready" && state.source.progress ? t(`已返回 ${state.source.progress.completed}/${state.source.progress.total} 路候选，正在补全…`, `${state.source.progress.completed}/${state.source.progress.total} candidate queries returned…`) : state.kind === "ranking" ? t("正在对照技术栈与地点…", "Comparing skills and location…") : t("正在读取真实岗位索引，可继续编辑简历…", "Reading the real job index. You can keep editing…")}<button type="button" onClick={stop}><Square size={11} />{t("停止", "Stop")}</button></div>}
      {state.kind === "ready" && <>
        {state.source.partial && <div className="rjr-notice">{state.stopped ? t("已停止补全，保留已返回的推荐。", "Stopped. Available matches are preserved.") : t("已显示可读取的岗位，部分查询暂未完成。", "Available jobs are shown; some queries did not finish.")}<button type="button" onClick={refreshSource}>{t("重新读取岗位", "Read jobs again")}</button></div>}
        {state.source.notice && <div className="rjr-notice">{state.source.notice === "index-unavailable" ? t("索引暂未连上，先匹配已保存的机会库。", "The index is unavailable. Using saved opportunities.") : state.source.notice === "library-damaged" ? t("机会库读取异常，原始数据已保留。", "The opportunity library could not be read; original data is preserved.") : t("当前仅匹配机会库；演示岗位不参与推荐。", "Using saved opportunities only; demo jobs are excluded.")}<button type="button" onClick={onOpenAtlas}>{t("查看岗位来源", "Check sources")}</button></div>}
        {state.result.jobs.length > 0 ? <div className="rjr-cards" key={`${requestId}-${sameAreaOnly}-${retry}`}>
          {state.result.jobs.map((job, index) => <article className="rjr-card" key={job.id} style={{ "--rjr-index": index } as CSSProperties}>
            <div className="rjr-card-top"><span className="rjr-match">{t("匹配度", "Match")} <strong>{job.match.percentage}<small>%</small></strong></span><span>{placeLabel(job)}</span></div>
            <h3 title={job.title}>{job.title}</h3><p className="rjr-company" title={job.company}>{job.company}</p>
            <p className="rjr-place"><MapPin size={12} />{job.location || t("地点未披露", "Location not disclosed")}{job.salary && <span className="rjr-salary">{job.salary}</span>}</p>
            <div className="rjr-skill-chips">{[...job.matchedSkills, ...job.matchedTags].slice(0, 4).map(skill => <span key={skill}>{skill}</span>)}</div>
            <details className="rjr-evidence"><summary>{t("匹配依据与待核实项", "Evidence & things to verify")}<ChevronDown size={12} /></summary>
              <dl>{job.match.dimensions.filter(dimension => dimension.weight).map(dimension => <div key={dimension.kind}><dt>{dimensionLabel[dimension.kind]} <small>{dimension.weight}%</small></dt><dd>{dimension.total ? `${dimension.matched}/${dimension.total}` : t("未披露", "Unknown")}</dd></div>)}</dl>
              <p>{job.unmentionedSkills.length ? t(`JD 还提到 ${job.unmentionedSkills.join("、")}，简历暂未体现；不等于你不会。`, `The JD also mentions ${job.unmentionedSkills.join(", ")}; your resume does not yet show evidence.`) : t("仍需核对年限、职责与完整要求。", "Check experience requirements and the complete JD.")}</p>
              <p>{job.sourcePlatform} · {job.status === "unknown" ? t("在招状态待核实", "Availability unverified") : t("来源标记在招 · 请复核", "Source marked open · verify")}</p>
            </details>
            <div className="rjr-card-actions"><button type="button" onClick={() => analyze(job)}><Bot size={14} />{t("让 Agent 分析", "Analyze with Agent")}<ArrowUpRight size={13} /></button><a href={job.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={t(`查看 ${job.title} 的原始岗位`, `View original ${job.title} posting`)}><ExternalLink size={13} />{t("原文", "Source")}</a></div>
          </article>)}
        </div> : <div className="rjr-empty"><h3>{t("暂时没有足够相关的岗位", "No sufficiently relevant jobs yet")}</h3><p>{sameAreaOnly ? t("可取消“仅看同地区”，或补充岗位来源。", "Try other areas or add job sources.") : t("可补充简历技术栈、标签与目标方向，或获取更多岗位。", "Add resume skills, tags, a target role, or more job sources.")}</p><button type="button" onClick={onOpenAtlas}>{t("去岗位地图找机会", "Explore the job atlas")}<ArrowUpRight size={13} /></button></div>}
        <footer className="rjr-footer"><span>{t(`已对照 ${state.result.scanned.toLocaleString(locale)} 个候选 · ${state.result.candidates.toLocaleString(locale)} 个相关`, `Compared ${state.result.scanned.toLocaleString(locale)} candidates · ${state.result.candidates.toLocaleString(locale)} relevant`)} · {state.source.cached ? t("复用近 2 分钟候选", "Recent candidates reused") : state.source.kind === "index" ? t("本机索引", "Local index") : t("机会库", "Saved opportunities")}</span><button type="button" disabled={busy} onClick={refreshSource}><RefreshCw size={12} />{t("更新岗位来源", "Refresh job sources")}</button></footer>
      </>}
      {(state.kind === "cancelled" || state.kind === "error") && <div className="rjr-empty"><h3>{state.kind === "cancelled" ? t("已停止，简历保持不变", "Stopped. Your resume is unchanged.") : t("岗位数据暂时读不到", "Job data is temporarily unavailable")}</h3><p>{t("这不是没有合适岗位。可以继续编辑，或检查来源后重试。", "This does not mean there are no matches. Keep editing or check sources and retry.")}</p><button type="button" onClick={refreshSource}>{t("重新匹配", "Try again")}</button><button type="button" onClick={onOpenAtlas}>{t("查看岗位地图", "Open job atlas")}</button></div>}
      <details className="rjr-method"><summary>{t("匹配说明 · 本机计算，不上传简历", "How matching works · local, no resume upload")}</summary>
        <p>{t("匹配度是文本证据分，不是录用概率。技术 55%、经历标签 15%、岗位方向 20%、地点 10%；按命中比例加权，未设置的画像维度不参与。技术项对照 JD 明确提到的技术，不判定必需性。同地区优先，仅覆盖本轮读取的候选，不代表全网。", "A text-evidence score, not a hiring probability: skills 55%, experience tags 15%, role 20%, location 10%. Weighted by evidence overlap; unset profile dimensions are excluded. JD technologies are not assumed mandatory. Preferred area first; this candidate set is not the whole market.")}</p>
        <div className="rjr-profile">{[...profile.skills, ...profile.tags].map(value => <b key={value}>{value}</b>)}</div>
      </details>
    </div>
  </section>;
}
