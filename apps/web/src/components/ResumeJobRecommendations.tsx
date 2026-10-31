/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { FactBase } from "@better-me/core";
import { ArrowUpRight, Bot, Check, ChevronDown, ExternalLink, Loader2, MapPin, RefreshCw, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { extractRecommendationProfile, recommendResumeJobs, type RecommendedJob, type RecommendationResult, type RecommendationProfile } from "../lib/resume-job-recommendations";
import { readRecommendationSource, type RecommendationSource } from "../lib/resume-job-source";
import type { DrawerJobContext } from "./JdMatchDrawer";
import "./resume-job-recommendations.css";

type State = { kind: "reading" | "ranking" | "cancelled" | "error" } | { kind: "ready"; result: RecommendationResult; source: RecommendationSource };
export type ResumeJobRecommendationsProps = {
  factBase: FactBase; currentFactBase?: FactBase; isStale?: boolean; requestId: number;
  onRefresh: () => void; onClose: () => void; onOpenAtlas: () => void; onAnalyze: (job: DrawerJobContext) => void;
  // Read-only seam shared by component tests; production always uses the actual Atlas source.
  loadSource?: (signal: AbortSignal, profile: RecommendationProfile) => Promise<RecommendationSource>;
};

export default function ResumeJobRecommendations({ factBase, currentFactBase, isStale, requestId, onRefresh, onClose, onOpenAtlas, onAnalyze, loadSource = readRecommendationSource }: ResumeJobRecommendationsProps) {
  const { t, locale } = useUiPreferences();
  const profile = useMemo(() => extractRecommendationProfile(factBase), [factBase]);
  // Persistence validates/clones imported facts. Compare matching evidence, not object identity
  // or save timestamps, so a successful import is not immediately called out as stale.
  const latestProfileKey = useMemo(() => JSON.stringify(extractRecommendationProfile(currentFactBase ?? factBase)), [currentFactBase, factBase]);
  const profileChanged = isStale ?? (latestProfileKey !== JSON.stringify(profile));
  const [state, setState] = useState<State>({ kind: "reading" });
  const [collapsed, setCollapsed] = useState(false);
  const [sameAreaOnly, setSameAreaOnly] = useState(false);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const cache = useRef<{ requestId: number; source: RecommendationSource } | null>(null);
  const titleId = `resume-job-recommendations-${requestId}`;
  const busy = state.kind === "reading" || state.kind === "ranking";

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    let timedOut = false;
    const timeout = setTimeout(() => { if (!abort.signal.aborted) { timedOut = true; abort.abort(); setState({ kind: "error" }); } }, 45_000);
    setState({ kind: cache.current?.requestId === requestId ? "ranking" : "reading" });
    void (async () => {
      const source = cache.current?.requestId === requestId ? cache.current.source : await loadSource(abort.signal, profile);
      abort.signal.throwIfAborted();
      cache.current = { requestId, source };
      setState({ kind: "ranking" });
      const result = await recommendResumeJobs(source.dataset, profile, { signal: abort.signal, sameAreaOnly });
      if (!abort.signal.aborted) setState({ kind: "ready", source, result });
    })().catch(() => { if (!abort.signal.aborted && !timedOut) setState({ kind: "error" }); })
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); abort.abort(); if (controller.current === abort) controller.current = null; };
  }, [profile, requestId, loadSource, sameAreaOnly, retry]);

  function stop() { controller.current?.abort(); setState({ kind: "cancelled" }); }
  function analyze(job: RecommendedJob) {
    onAnalyze({ id: job.id, title: job.title, company: job.company, description: job.description, location: job.location || undefined,
      salary: job.salary, sourceUrl: job.sourceUrl, sourcePlatform: job.sourcePlatform });
  }
  const status = busy ? t("正在匹配", "Matching") : state.kind === "ready" ? t(`${state.result.jobs.length} 个推荐`, `${state.result.jobs.length} recommendations`) : state.kind === "cancelled" ? t("已停止", "Stopped") : t("暂时未能读取", "Not available yet");
  const placeLabel = (job: RecommendedJob) => job.locationMatch === "same-area" ? t("同地区优先", "Preferred area")
    : job.locationMatch === "other-area" ? t("异地 · 请确认意愿", "Other area · check preference")
    : job.locationMatch === "unknown" ? t("地点待核实", "Location unknown") : t("未设置地点偏好", "No location preference");

  return <section className="resume-job-recs no-print" aria-labelledby={titleId}>
    <header className="rjr-heading">
      <span className="rjr-mark" aria-hidden="true"><Sparkles size={19} /></span>
      <div className="rjr-heading-copy"><span className="rjr-eyebrow">BETTERME / CAREER MATCH</span><h2 id={titleId}>{t("从你的经历，找到下一站", "Your experience. Your next move.")}</h2></div>
      <span className="rjr-state" role="status">{busy ? <Loader2 size={13} className="rjr-spinner" /> : state.kind === "ready" ? <Check size={13} /> : null}{status}</span>
      <button type="button" className="rjr-icon" aria-label={collapsed ? t("展开岗位推荐", "Expand recommendations") : t("收起岗位推荐", "Collapse recommendations")} aria-expanded={!collapsed} aria-controls={`${titleId}-body`} onClick={() => setCollapsed(value => !value)}><ChevronDown size={17} className={collapsed ? "" : "rjr-expanded"} /></button>
      <button type="button" className="rjr-icon" onClick={onClose} aria-label={t("关闭岗位推荐", "Close recommendations")}><X size={16} /></button>
    </header>
    <div id={`${titleId}-body`} hidden={collapsed}>
      <div className="rjr-profile"><span>{t("本次匹配画像", "Matching profile")}</span>
        {profile.roles.slice(0, 1).map(role => <b key={role}>{role}</b>)}
        {profile.location && <b><MapPin size={12} />{profile.location}</b>}
        {profile.skills.slice(0, 5).map(skill => <b key={skill}>{skill}</b>)}
        {profile.skills.length > 5 && <b>+{profile.skills.length - 5}</b>}
        {!profile.skills.length && !profile.roles.length && <span>{t("请先在简历中补充技术栈或目标岗位", "Add skills or a target role to your resume first")}</span>}
      </div>
      <div className="rjr-controls">
        <p><ShieldCheck size={13} />{t("本机匹配，不上传简历；同地区优先，不自动投递。", "Matched locally. No resume upload or automatic applications. Preferred area first.")}</p>
        {profile.location && <label><input type="checkbox" checked={sameAreaOnly} onChange={event => setSameAreaOnly(event.target.checked)} />{t("仅看同地区", "Preferred area only")}</label>}
      </div>
      {profileChanged && <div className="rjr-notice">{t("简历已更新，下面仍是上次画像的推荐。", "Your resume changed; these recommendations use the previous profile.")}<button type="button" onClick={onRefresh}>{t("按最新简历重选", "Match latest resume")}</button></div>}
      {busy && <div className="rjr-loading" aria-busy="true"><div className="rjr-loading-copy"><span className="rjr-pulse" aria-hidden="true" />{state.kind === "reading" ? t("正在读取真实岗位索引…", "Reading the real job index…") : t("正在对照技术栈、经历标签和地点…", "Comparing skills, experience tags and locations…")}<button type="button" onClick={stop}><Square size={11} />{t("停止", "Stop")}</button></div><div className="rjr-skeletons" aria-hidden="true">{[0, 1, 2].map(index => <div key={index}><i /><i /><i /></div>)}</div></div>}
      {state.kind === "ready" && <>
        {state.source.partial && <div className="rjr-notice">{t("部分候选查询暂未返回，已保留成功读取的岗位；可重新匹配补全。", "Some candidate queries did not return. Available jobs are preserved; refresh to retry.")}</div>}
        {state.source.notice && <div className="rjr-notice">{state.source.notice === "index-unavailable" ? t("岗位索引暂未连上，下面仅匹配已保存的机会库，不代表全网没有岗位。", "The index is unavailable. Only saved opportunities are matched, not the whole job market.") : state.source.notice === "library-damaged" ? t("机会库读取异常，原始数据已保留。请先在机会库处理后重试。", "The opportunity library could not be read. Its original data is preserved; check the library and retry.") : t("当前只使用机会库；演示岗位不参与推荐。可到岗位地图连接真实索引。", "Using your opportunity library only. Demo jobs are excluded. Connect a real index in the atlas.")}<button type="button" onClick={onOpenAtlas}>{t("查看岗位来源", "Check sources")}</button></div>}
        {state.result.jobs.length > 0 ? <div className="rjr-cards" key={`${requestId}-${sameAreaOnly}-${retry}`}>
          {state.result.jobs.map((job, index) => <article className="rjr-card" key={job.id} style={{ "--rjr-index": index } as CSSProperties}>
            <div className="rjr-card-top"><span className="rjr-number">0{index + 1}</span><span>{placeLabel(job)}</span></div>
            <h3>{job.title}</h3><p className="rjr-company">{job.company}</p>
            <p className="rjr-place"><MapPin size={12} />{job.location || t("来源未披露地点", "Location not disclosed")}</p>
            {job.salary && <p className="rjr-salary">{job.salary}</p>}
            <div className="rjr-reasons"><p><Check size={13} />{job.roleMatched ? t("岗位方向相符", "Role direction matches") : t("技术或经历标签相符", "Skills or experience tags match")}</p><div className="rjr-skill-chips">{[...job.matchedSkills, ...job.matchedTags].slice(0, 5).map(skill => <span key={skill}>{skill}</span>)}</div></div>
            <p className="rjr-check">{job.unmentionedSkills.length ? t(`还需核实：JD 提到 ${job.unmentionedSkills.join("、")}，简历暂未体现。`, `Check: the JD mentions ${job.unmentionedSkills.join(", ")}; your resume does not yet show evidence.`) : t("匹配依据为文本命中，年限、职责与完整要求仍需核对。", "Text evidence only. Check experience requirements and the complete JD.")}</p>
            <div className="rjr-source"><span>{job.sourcePlatform}</span><span>{job.status === "unknown" ? t("在招状态待核实", "Availability unverified") : t("来源标记在招 · 请复核", "Source marked open · verify")}</span></div>
            <div className="rjr-card-actions"><button type="button" onClick={() => analyze(job)}><Bot size={14} />{t("让 Agent 分析", "Analyze with Agent")}<ArrowUpRight size={13} /></button><a href={job.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={t(`查看 ${job.title} 的原始岗位`, `View original ${job.title} posting`)}><ExternalLink size={13} />{t("原文", "Source")}</a></div>
          </article>)}
        </div> : <div className="rjr-empty"><Sparkles size={24} /><h3>{t("暂时没有足够相关的岗位", "No sufficiently relevant jobs yet")}</h3><p>{sameAreaOnly ? t("可以取消“仅看同地区”，或到岗位地图补充来源。", "Try other areas or add job sources in the atlas.") : t("可先在简历里补充技术栈、经历标签与目标岗位，或到岗位地图获取更多岗位。", "Add skills, experience tags and a target role, or collect more jobs in the atlas.")}</p><button type="button" onClick={onOpenAtlas}>{t("去岗位地图找机会", "Explore the job atlas")}<ArrowUpRight size={13} /></button></div>}
        <footer className="rjr-footer"><span>{t(`已对照本轮 ${state.result.scanned.toLocaleString(locale)} 个候选 · ${state.result.candidates.toLocaleString(locale)} 个相关岗位`, `Compared ${state.result.scanned.toLocaleString(locale)} candidates · ${state.result.candidates.toLocaleString(locale)} relevant jobs`)} · {state.source.kind === "index" ? t("本机索引 · 关键词分批读取，非全网穷举", "Local index · keyword batches, not an exhaustive market search") : t("当前机会库", "Opportunity library")}</span><button type="button" onClick={onRefresh}><RefreshCw size={12} />{t("重新匹配", "Refresh matches")}</button></footer>
      </>}
      {(state.kind === "cancelled" || state.kind === "error") && <div className="rjr-empty"><h3>{state.kind === "cancelled" ? t("已停止，简历保持不变", "Stopped. Your resume is unchanged.") : t("岗位数据暂时读不到", "Job data is temporarily unavailable")}</h3><p>{state.kind === "cancelled" ? t("准备好后可重新匹配，也可以继续编辑简历。", "Restart when ready, or continue editing your resume.") : t("这不是没有合适岗位。请检查岗位地图的服务连接，或稍后重试。", "This does not mean there are no relevant jobs. Check the atlas connection or retry.")}</p><button type="button" onClick={() => { cache.current = null; setRetry(value => value + 1); }}>{t("重新匹配", "Try again")}</button><button type="button" onClick={onOpenAtlas}>{t("查看岗位地图", "Open job atlas")}</button></div>}
    </div>
  </section>;
}
