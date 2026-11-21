/** @jsxRuntime automatic */
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeSourceUrl } from "@better-me/opportunities";
import {
  DiscoverOfficialJobsInputSchema,
  type DiscoverOfficialJobsInput,
  type OfficialJobDiscoveryCandidate,
  type OfficialJobDiscoveryResult,
} from "@better-me/source-adapters/browser-contracts";
import { useUiPreferences } from "../../lib/ui-preferences";
import { AtlasSourceServiceError } from "./service-client";
import { createOfficialJobDiscoveryClient } from "./official-job-discovery-client";
import { AtlasDiscoveredSourceReview } from "./AtlasDiscoveredSourceReview";
import { sourceCatalogIdentity } from "./source-catalog";
import { getChinaProvinces, matchDisclosedChinaCities } from "./china-regions";
import { uniqueSkills, primaryResumeSkills } from "../../lib/resume-discovery-criteria";
import "./resume-discovery.css";

export interface AtlasResumeDiscoveryProps {
  endpoint: string;
  token: string;
  targetRole?: string;
  skills?: readonly string[];
  location?: string;
  preferLowTravel?: boolean;
  preferForeignEmployer?: boolean;
  autoSearchOnOpen?: boolean;
  onManageSources?: (company?: string, officialJobUrl?: string) => void;
  onCollected?: () => void;
}

function groupCandidates(candidates: OfficialJobDiscoveryCandidate[]) {
  const groups = new Map<string, OfficialJobDiscoveryCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.company?.trim().toLowerCase() || "";
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  return groups;
}

function jobIdentity(candidate: OfficialJobDiscoveryCandidate) {
  return candidate.company && candidate.jobId
    ? JSON.stringify([candidate.company.trim().toLowerCase(), candidate.jobId])
    : normalizeSourceUrl(candidate.url);
}

/** City and national searches may return different evidence handles for the same posting. */
function combineScopes(local: OfficialJobDiscoveryResult, national: OfficialJobDiscoveryResult): OfficialJobDiscoveryResult {
  const candidates: OfficialJobDiscoveryCandidate[] = [];
  const index = new Map<string, number>();
  for (const item of [...local.candidates, ...national.candidates]) {
    const url = normalizeSourceUrl(item.url), identity = jobIdentity(item);
    const position = index.get(url) ?? index.get(identity) ?? candidates.length;
    if (!candidates[position] || item.verification === "official-detail") candidates[position] = item;
    index.set(url, position); index.set(identity, position);
  }
  return {
    observedAt: national.observedAt, candidates,
    status: national.status === local.status ? local.status : "partial",
    warnings: [...new Set([...local.warnings, ...national.warnings])],
    queries: [...new Set([...local.queries, ...national.queries])],
    discovery: national.discovery ?? local.discovery,
  };
}

/** A new resume or service must begin with its own editable search and import receipts. */
export function AtlasResumeDiscovery(props: AtlasResumeDiscoveryProps) {
  const identity = JSON.stringify([props.endpoint, props.token, props.targetRole, props.skills, props.location,
    props.preferLowTravel, props.preferForeignEmployer]);
  return <DiscoverySession key={identity} {...props} />;
}

function DiscoverySession(props: AtlasResumeDiscoveryProps) {
  const { t, locale } = useUiPreferences();
  const [role, setRole] = useState(props.targetRole ?? "");
  const [region, setRegion] = useState(props.location ?? "");
  const primary = primaryResumeSkills(props.skills ?? []);
  const [main, setMain] = useState(primary.join(", "));
  const [secondary, setSecondary] = useState(props.skills?.filter(skill => !primary.includes(skill)).join(", ") ?? "");
  const [lowTravel, setLowTravel] = useState(Boolean(props.preferLowTravel));
  const [foreignEmployer, setForeignEmployer] = useState(Boolean(props.preferForeignEmployer));
  const [criteriaOpen, setCriteriaOpen] = useState(() => !role.trim() && !uniqueSkills(main).length);
  const [localResult, setLocalResult] = useState<OfficialJobDiscoveryResult>();
  const [nationalResult, setNationalResult] = useState<OfficialJobDiscoveryResult>();
  const [includeNational, setIncludeNational] = useState(false);
  const [onlyDisclosedEmployers, setOnlyDisclosedEmployers] = useState(false);
  const [searching, setSearching] = useState<"local" | "national" | "expanding">();
  const [collecting, setCollecting] = useState<string>();
  const [collected, setCollected] = useState<Record<string, string>>({});
  const [enabledSources, setEnabledSources] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const searchButton = useRef<HTMLButtonElement>(null);
  const openingSearchHandled = useRef(false);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const importKeys = useRef(new Map<string, string>());
  const client = createOfficialJobDiscoveryClient(props.endpoint, props.token);
  const result = useMemo(() => includeNational && nationalResult && localResult
    ? combineScopes(localResult, nationalResult) : localResult, [localResult, nationalResult, includeNational]);
  const leads = result?.candidates.filter(candidate => candidate.verification === "unverified-lead") ?? [];
  const groups = groupCandidates(result?.candidates.filter(candidate => !props.autoSearchOnOpen || candidate.verification === "official-detail") ?? []);
  const verifiedCount = result?.candidates.filter(c => c.verification === "official-detail").length ?? 0;
  const openCount = result?.candidates.filter(c => c.verification === "official-detail" && c.availability === "open").length ?? 0;
  const verifiedCompanies = [...groups.values()].filter(group => group.some(candidate => candidate.verification === "official-detail")).length;
  const hasCompanyEvidence = (candidates: OfficialJobDiscoveryCandidate[]) =>
    candidates.some(candidate => candidate.verification === "official-detail" && (candidate.employerGroup ||
      (candidate.employerNature === "foreign-disclosed" && candidate.employerNatureEvidence)));
  const disclosedCompanies = [...groups.values()].filter(hasCompanyEvidence).length;
  const originalCompanies = groupCandidates(localResult?.candidates.filter(c => c.verification === "official-detail") ?? []);
  const additionalCompanies = [...groups].filter(([key, candidates]) => !originalCompanies.has(key) && candidates.some(c => c.verification === "official-detail")).length;
  const showOwnershipFilter = props.autoSearchOnOpen && foreignEmployer && disclosedCompanies > 0 && disclosedCompanies < verifiedCompanies;
  const visibleGroups = [...groups].filter(([, candidates]) => !showOwnershipFilter || !onlyDisclosedEmployers || hasCompanyEvidence(candidates));
  const newlyDiscovered = (candidates: OfficialJobDiscoveryCandidate[]) => candidates.every(candidate => candidate.verification === "official-detail" && !!candidate.discoveryRound);
  if (foreignEmployer || result?.discovery) visibleGroups.sort(([, a], [, b]) =>
    (foreignEmployer ? Number(hasCompanyEvidence(b)) - Number(hasCompanyEvidence(a)) : 0) ||
    Number(newlyDiscovered(b)) - Number(newlyDiscovered(a)));
  const canWiden = useMemo(() => {
    const area = region.trim();
    return !!localResult && !!area && (matchDisclosedChinaCities({ countryCode: "CN", raw: area }).length > 0 ||
      getChinaProvinces().some(p => area === p.name || area === p.name.replace(/[省市]$/u, "")));
  }, [region, localResult]);
  const mainTerms = new Set(uniqueSkills(main).map(term => term.toLowerCase()));
  useEffect(() => () => { read.current?.abort(); write.current?.abort(); }, []);
  useEffect(() => {
    if (!props.autoSearchOnOpen || !props.token.trim()) return;
    let active = true;
    // A discarded mount must not send a public query. Submit through the same
    // button as a manual search, including its empty-input and connection checks.
    queueMicrotask(() => {
      if (!active || openingSearchHandled.current) return;
      openingSearchHandled.current = true;
      const button = searchButton.current;
      if (button && !button.disabled) button.form?.requestSubmit(button);
    });
    return () => { active = false; };
  }, [props.autoSearchOnOpen, props.token]);

  function stopRead() {
    read.current?.abort();
    read.current = null;
    setSearching(undefined);
  }
  function edit() {
    stopRead();
    setError(""); setNotice(""); setLocalResult(undefined); setNationalResult(undefined); setIncludeNational(false); setOnlyDisclosedEmployers(false);
  }
  async function discover(national: boolean, continueSearch = false) {
    openingSearchHandled.current = true;
    if (read.current || write.current || !props.token.trim()) return;
    const skills = uniqueSkills(main);
    const mainKeys = new Set(skills.map(s => s.toLowerCase()));
    const baseInput: DiscoverOfficialJobsInput = {
      role: role.trim(), skills,
      secondarySkills: uniqueSkills(secondary).filter(s => !mainKeys.has(s.toLowerCase())),
      ...(national ? { region: "中国" } : region.trim() ? { region: region.trim() } : {}),
      preferForeignEmployer: foreignEmployer, preferLowTravel: lowTravel,
    };
    const checked = DiscoverOfficialJobsInputSchema.safeParse(baseInput);
    if (!checked.success) {
      setCriteriaOpen(true);
      setError(t("请检查岗位方向、技能和地区，缩短过长内容并减少关键词。", "Review the role, skills and location. Shorten long entries and reduce the number of terms."));
      return;
    }
    const previous = national ? nationalResult : localResult;
    if (continueSearch && !previous?.discovery?.canContinue) return;
    if (national || continueSearch) { setError(""); setNotice(""); }
    else edit();
    const controller = new AbortController();
    read.current = controller; setSearching(continueSearch ? "expanding" : national ? "national" : "local");
    try {
      let accumulated = continueSearch ? previous : undefined;
      // Start with the regular search, then make independent, cancellable reads
      // using the host's continuation. Each completed round is reviewable.
      const automaticRounds = props.autoSearchOnOpen ? 2 : 0;
      const limit = continueSearch ? Math.max(1, automaticRounds) : 1 + automaticRounds;
      for (let index = 0; index < limit; index++) {
        const continuation = accumulated?.discovery;
        if (accumulated && !continuation?.canContinue) break;
        if (continuation) setSearching("expanding");
        const next = await client.discover({ ...checked.data, ...(continuation ? { continueDiscovery: continuation.sessionId } : {}) }, controller.signal);
        if (controller.signal.aborted || read.current !== controller) return;
        accumulated = accumulated ? combineScopes(accumulated, next) : next;
        if (national) { setNationalResult(accumulated); setIncludeNational(true); }
        else setLocalResult(accumulated);
        if (continuation && next.discovery?.newCompanies === 0 && next.discovery.pendingPages === 0) break;
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof AtlasSourceServiceError && failure.code === "stale-version") setError(t("发现任务已过期，请重新搜索。已显示的结果仍可查看。", "This discovery session expired. Start a new search; the results remain reviewable."));
        else setError(failure instanceof Error ? failure.message : t("搜索未完成，请重试。", "Search did not complete. Please retry."));
      }
    } finally {
      if (read.current === controller) { read.current = null; setSearching(undefined); }
    }
  }

  async function collect(candidate: OfficialJobDiscoveryCandidate) {
    const id = candidate.candidateId;
    const identity = jobIdentity(candidate);
    const url = normalizeSourceUrl(candidate.url);
    if (!id || candidate.verification !== "official-detail" || read.current || write.current || collected[identity] || collected[url]) return;
    let key = importKeys.current.get(id);
    if (!key) { key = crypto.randomUUID(); importKeys.current.set(id, key); }
    const controller = new AbortController();
    write.current = controller; setCollecting(id); setError(""); setNotice("");
    try {
      const receipt = await client.collect(id, key, controller.signal);
      controller.signal.throwIfAborted();
      const label = receipt.counts.newJobs > 0 ? t("已收录", "Collected") : t("已在索引中", "In index");
      setCollected(current => ({ ...current, [identity]: label, [url]: label }));
      setNotice(t(`${candidate.title} · ${label}`, `${candidate.title} · ${label}`));
      props.onCollected?.();
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof AtlasSourceServiceError && failure.code === "stale-version") {
        setError(t("本次岗位凭据已失效，请重新搜索并核对职位。", "This posting reference has expired. Search again to review the job."));
      } else {
        setError(failure instanceof Error ? failure.message : t("收录结果未确认，请核对索引。", "Collection is unconfirmed. Check the index."));
      }
    } finally {
      if (!controller.signal.aborted) setCollecting(undefined);
      write.current = null;
    }
  }

  const criteria = (
    <fieldset disabled={Boolean(collecting)} onChange={edit}>
      <div className="ard-inputs">
        <label>{t("目标岗位", "Target role")}<input maxLength={120} value={role} onChange={e => setRole(e.target.value)} placeholder={t("例如：后端工程师", "e.g. Backend Engineer")} /></label>
        <label>{t("工作地区", "Work location")}<input maxLength={120} value={region} onChange={e => setRegion(e.target.value)} placeholder={t("例如：上海", "e.g. Shanghai")} /></label>
        <label>{t("主技能", "Primary skills")}<input maxLength={500} value={main} onChange={e => setMain(e.target.value)} placeholder="C#, .NET" /></label>
        <label>{t("加分技能", "Additional skills")}<input maxLength={500} value={secondary} onChange={e => setSecondary(e.target.value)} placeholder="Python, Vue, React" /></label>
      </div>
      <small>{t("主技能和加分技能都可以调整，多项用逗号分开。", "Edit primary and additional skills as needed. Separate terms with commas.")}</small>
      <div className="ard-preferences">
        <label><input type="checkbox" checked={foreignEmployer} onChange={e => setForeignEmployer(e.target.checked)} />{t("偏好外企", "Prefer foreign-owned employers")}</label>
        <label><input type="checkbox" checked={lowTravel} onChange={e => setLowTravel(e.target.checked)} />{t("偏好少出差", "Prefer limited travel")}</label>
      </div>
    </fieldset>
  );
  const warnings = result?.warnings.map((warning, i) => <p className="ard-hint" key={i}>{warning}</p>);
  const termsSummary = [role.trim(), main.trim(), includeNational ? t("全国", "China") : region.trim()].filter(Boolean).join(" · ");
  const noTerms = !role.trim() && !mainTerms.size;
  const instructions = t("可以调整从简历带入的条件。公开搜索只使用下列条件。", "Review the terms to send to public search.");

  return <section className="atlas-resume-discovery" aria-label={t("按简历发现招聘公司", "Discover hiring companies from a resume")}>
    {!props.autoSearchOnOpen && <p className="ard-intro">{instructions}</p>}
    <form onSubmit={event => { event.preventDefault(); void discover(includeNational); }}>
      {props.autoSearchOnOpen ? <details className="rounded-lg border border-[var(--color-line)] px-3 py-2 [&[open]>*+*]:mt-2" open={criteriaOpen} onToggle={event => setCriteriaOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer">{t("调整搜索条件", "Adjust search terms")}{termsSummary && <span className="ard-hint"> · {termsSummary}</span>}</summary>
        <p className="ard-intro">{noTerms ? t("填写目标岗位或一项主技能即可搜索。", "Enter a target role or a primary skill to search.") : instructions}</p>
        {criteria}
      </details> : criteria}
      <div className="ard-actions" aria-live={props.autoSearchOnOpen ? "polite" : undefined}>
        <button ref={searchButton} type="submit" className="ard-primary" disabled={noTerms || !props.token.trim() || Boolean(searching || collecting)}>
          {searching === "expanding" ? t("Agent 正在探索更多官网…", "Agent is exploring more career sites…") : searching === "national" ? t("正在全国查找招聘公司…", "Searching across China…") : searching ? t("正在查找招聘公司…", "Searching for employers…") :
            props.autoSearchOnOpen && (result || error || notice) ? t("重新搜索", "Search again") : t("查找正在招聘的公司", "Find hiring companies")}
        </button>
        {searching && <button type="button" onClick={() => { stopRead(); setNotice(searching === "expanding"
          ? t("已暂停发现，已核对的公司和岗位可以继续查看。", "Discovery paused. Reviewed employers and jobs remain available.")
          : t("已取消搜索。", "Search canceled.")); }}>{searching === "expanding" ? t("暂停发现", "Pause discovery") : t("取消搜索", "Cancel search")}</button>}
      </div>
    </form>
    {!props.token.trim() && <p role="status">{t("请先连接本机岗位服务。", "Connect to the local job service first.")}</p>}
    {error && <p className="ard-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {result && <section className="ard-results" aria-label={t("公司与岗位搜索结果", "Company and job results")}>
      <header><strong>{result.status === "provider-unavailable" ? t("公开搜索暂不可用", "Public search is unavailable") :
        result.status === "partial" ? t("已返回部分结果", "Partial search results") : t("本次搜索结果", "Search results")}</strong>
        <time dateTime={result.observedAt}>{new Date(result.observedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en")}</time></header>
      <div className="ard-scope"><span>{includeNational ? t(`全国 · 含${region.trim()}结果`, `China · includes ${region.trim()} results`) :
        t(`搜索地区 · ${region.trim() || "不限地区"}`, `Search area · ${region.trim() || "All locations"}`)}</span>
        {canWiden && <button type="button" disabled={Boolean(searching || collecting)} onClick={() => {
          if (includeNational || (nationalResult && nationalResult.status !== "provider-unavailable")) setIncludeNational(!includeNational);
          else void discover(true);
        }}>{includeNational ? t(`只看${region.trim()}结果`, `Show only ${region.trim()} results`) :
          nationalResult && nationalResult.status !== "provider-unavailable" ? t("查看全国结果", "Show nationwide results") :
            t("扩大到全国找更多公司", "Find more employers across China")}</button>}
      </div>
      {result.discovery && <div className="ard-discovery-progress">
        <div><strong>{t("Agent 主动发现", "Agent discovery")}</strong><span className="ard-hint">
          {t(`已完成 ${result.discovery.round + 1} 轮 · 已访问 ${result.discovery.checkedPages} 个候选链接`, `${result.discovery.round + 1} rounds · ${result.discovery.checkedPages} candidate links visited`)}
        </span></div>
        <p className="ard-hint" role="status">{searching === "expanding" ? t("正在按简历关键词寻找此前未核对的招聘入口，结果会逐轮更新。", "Searching from resume terms for previously unreviewed hiring sites. Results update after each round.")
          : result.discovery.canContinue ? t(`本轮新增 ${result.discovery.newCompanies} 家公司 · 还有 ${result.discovery.pendingPages} 个已发现的链接待核对。`, `${result.discovery.newCompanies} new employers this round · ${result.discovery.pendingPages} discovered links to review.`)
            : t("本次探索已达到读取范围上限。", "This discovery session reached its reading limit.")}</p>
        {result.discovery.canContinue && <button type="button" disabled={Boolean(searching || collecting)} onClick={() => void discover(includeNational, true)}>{t("继续发现更多官网", "Keep discovering career sites")}</button>}
      </div>}
      {includeNational && nationalResult?.status === "provider-unavailable" && <p role="status">{t("全国搜索暂不可用，仍可查看原地区的结果。", "The nationwide search is unavailable. Your local results are still available.")}</p>}
      {includeNational && nationalResult?.status !== "provider-unavailable" && <p className="ard-hint" role="status">{additionalCompanies > 0
        ? t(`扩大范围后新增 ${additionalCompanies} 家已核对的公司。`, `The wider search found ${additionalCompanies} additional verified employers.`)
        : t("本轮全国搜索没有新增已核对的公司。", "This nationwide search found no additional verified employers.")}</p>}
      {result.candidates.length > 0 && <p>{props.autoSearchOnOpen
        ? t(`已核对 ${verifiedCompanies} 家公司、${verifiedCount} 个官网岗位，另有 ${result.candidates.length - verifiedCount} 条线索待核实。`,
          `${verifiedCount} verified postings from ${verifiedCompanies} employers and ${result.candidates.length - verifiedCount} unverified leads.`)
        : t(`已核对 ${verifiedCount} 个官网岗位，另有 ${result.candidates.length - verifiedCount} 条线索待核实。`,
          `${verifiedCount} verified employer postings and ${result.candidates.length - verifiedCount} unverified leads.`)}</p>}
      {result.discovery && verifiedCount > 0 && <p className="ard-hint">{t(`其中 ${openCount} 个岗位的招聘来源显示在招。`, `${openCount} postings are currently shown as open by their source.`)}</p>}
      {props.autoSearchOnOpen && foreignEmployer && verifiedCompanies > 0 && <div className="ard-ownership">
        <span>{t(`${disclosedCompanies} 家有企业背景资料`, `${disclosedCompanies} employers with company background information`)}</span>
        {showOwnershipFilter && <label><input type="checkbox" disabled={Boolean(collecting || searching)} checked={onlyDisclosedEmployers} onChange={event => setOnlyDisclosedEmployers(event.target.checked)} />
          {t("只看有企业背景资料的公司", "Only employers with background information")}</label>}
      </div>}
      {!props.autoSearchOnOpen && warnings}
      {result.status !== "provider-unavailable" && !groups.size && <p>{t("本轮还没有核对到官网岗位。可以调整岗位名称、技能或搜索地区。", "No official postings were verified. Try another title, skill or search area.")}</p>}
      {(result.queries.length > 0 || (props.autoSearchOnOpen && result.warnings.length > 0)) && <details>
        <summary>{props.autoSearchOnOpen ? t("搜索范围与关键词", "Search coverage and keywords") : t("查看实际搜索词", "View search queries")}</summary>
        {props.autoSearchOnOpen && warnings}
        {includeNational && localResult && nationalResult && <p className="ard-hint">{region} · {new Date(localResult.observedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en")}
          {" / "}{t("全国", "China")} · {new Date(nationalResult.observedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en")}</p>}
        {result.queries.length > 0 && <ul>{result.queries.map(query => <li key={query}>{query}</li>)}</ul>}
      </details>}
      {visibleGroups.map(([key, candidates]) => {
        const company = candidates[0]?.company;
        const official = candidates.find(candidate => candidate.verification === "official-detail");
        const website = candidates.find(c => c.verification === "official-detail" && c.companyWebsite)?.companyWebsite;
        const proposals = new Map(candidates.flatMap(c => c.verification === "official-detail" && !c.sourceId && c.sourceProposal
          ? [[sourceCatalogIdentity(c.sourceProposal), c.sourceProposal] as const] : []));
        const registered = candidates.some(c => c.sourceId) || [...proposals.keys()].some(identity => enabledSources.has(identity));
        const ownershipEvidence = candidates.find(c => c.verification === "official-detail" && c.employerNature === "foreign-disclosed" && c.employerNatureEvidence)?.employerNatureEvidence;
        const employerGroup = candidates.find(c => c.verification === "official-detail" && c.employerGroup)?.employerGroup;
        const compact = props.autoSearchOnOpen && verifiedCompanies > 1;
        const JobList = compact ? "details" : "div";
        return <section className="ard-company" key={key} aria-label={company || t("企业待核实", "Employer unverified")}>
          <header><h3>{company || t("企业待核实", "Employer unverified")}</h3>
            {newlyDiscovered(candidates) && <span className="ard-hint">{t("Agent 新发现", "Newly discovered")}</span>}
            {website && <a href={website} target="_blank" rel="noopener noreferrer" title={t("招聘方在来源中披露的公司网站", "Company website disclosed by the hiring source")}>{t("公司官网", "Company website")}</a>}
            {props.onManageSources && company && official && <button type="button" disabled={Boolean(collecting)} onClick={() => props.onManageSources?.(company, official.url)}>{registered ? t("管理已登记来源", "Manage registered source") : t("查看公司采集来源", "Review company source")}</button>}</header>
          {props.autoSearchOnOpen && official && !props.onManageSources && registered &&
            <p className="ard-hint">{t("公司来源已登记", "Company source registered")}</p>}
          {props.autoSearchOnOpen && official && !registered && !proposals.size &&
            <p className="ard-hint">{t("暂未找到可持续采集的公司来源，可单独收录岗位。", "A recurring company source is unavailable. Individual postings can be collected.")}</p>}
          {employerGroup && <p><a href={employerGroup.evidenceUrl} target="_blank" rel="noopener noreferrer">{employerGroup.name} · {t("集团总部", "Group headquarters")} · {employerGroup.headquarters}
            {employerGroup.evidenceKind === "public-entity" ? t(" · 公开资料", " · Public record") : ""}</a></p>}
          {ownershipEvidence ? <p>{t("招聘方自述企业属性", "Employer’s stated ownership")} · {ownershipEvidence}</p> :
            employerGroup ? <p className="ard-hint">{t("在华主体股权未核实", "Ownership of the Chinese entity is unverified")}</p> :
              foreignEmployer && <p className="ard-hint">{t("外企归属待核实", "Foreign ownership unverified")}</p>}
          <JobList className="ard-company-jobs">
          {compact && <summary>{t(`${candidates.length} 个官网岗位`, `${candidates.length} official postings`)}
            <span> · {candidates[0]?.title}</span>{candidates[0]?.location && <small>{candidates[0].location}</small>}</summary>}
          {candidates.map(candidate => {
            const isOfficial = candidate.verification === "official-detail";
            const id = candidate.candidateId;
            const savedLabel = collected[jobIdentity(candidate)] ?? collected[normalizeSourceUrl(candidate.url)];
            const mainMatches = candidate.matchedSkills.filter(s => mainTerms.has(s.toLowerCase()));
            const extraMatches = candidate.matchedSkills.filter(s => !mainMatches.includes(s));
            return <article key={candidate.url}>
              <h4><a href={candidate.url} target="_blank" rel="noopener noreferrer">{candidate.title}</a></h4>
              <p>{[candidate.location || t("地点待核实", "Location unverified"), !props.autoSearchOnOpen && candidate.jobId, isOfficial ? t("已核对职位原文", "Verified original posting") : t("搜索线索 · 官网待核实", "Search lead · official page unverified"),
                isOfficial && (candidate.availability === "open" ? t("来源显示开放", "Listed as open") : t("在招状态待核实", "Availability unverified"))].filter(Boolean).join(" · ")}</p>
              {!!mainMatches.length && <p>{t("命中主技能", "Primary matches")} · {mainMatches.join("、")}</p>}
              {!!extraMatches.length && <p>{t("命中加分技能", "Additional matches")} · {extraMatches.join("、")}</p>}
              {!!candidate.relatedSkills?.length && <p>{t("官网提到的相关技术", "Related technologies in the posting")} · {candidate.relatedSkills.join("、")}</p>}
              {(!props.autoSearchOnOpen || !isOfficial) && candidate.verificationEvidence && <p className="ard-hint">{candidate.verificationEvidence}</p>}
              {candidate.travelEvidence ? <p>{({
                "not-required": t("原文明确无需出差", "No travel stated"),
                "low-frequency": t("原文列明少量出差", "Limited travel stated"),
                required: t("原文有出差或驻场要求", "Travel or site work required"),
                mentioned: t("出差原文", "Travel evidence"), unknown: t("出差原文", "Travel evidence"),
              })[candidate.travel]} · {candidate.travelEvidence}</p> :
                lowTravel && <p className="ard-hint">{t("出差频率待确认", "Travel frequency unconfirmed")}</p>}
              {candidate.description && <details><summary>{t("查看岗位正文", "View role description")}</summary>
                <p className="ard-description">{candidate.description}</p>
                {candidate.discoveryEvidenceUrl && <p className="ard-hint"><a href={candidate.discoveryEvidenceUrl} target="_blank" rel="noopener noreferrer">{t("查看发现线索", "View discovery lead")}</a></p>}
                {props.autoSearchOnOpen && candidate.jobId && <p className="ard-hint">{t("职位编号", "Job ID")} · {candidate.jobId}</p>}
                {props.autoSearchOnOpen && isOfficial && candidate.verificationEvidence && <p className="ard-hint">{candidate.verificationEvidence}</p>}
              </details>}
              {isOfficial && id && <button type="button" disabled={Boolean(searching || collecting || savedLabel)} onClick={() => void collect(candidate)}>
                {savedLabel || (collecting === id ? t("正在收录…", "Collecting…") : t("收录这个岗位", "Collect this job"))}</button>}
            </article>;
          })}
          {Array.from(proposals, ([identity, proposal]) => <AtlasDiscoveredSourceReview key={identity} proposal={proposal}
            endpoint={props.endpoint} token={props.token} disabled={Boolean(searching || collecting)} alreadyEnabled={enabledSources.has(identity)}
            onBusy={busy => setCollecting(busy ? "source:" + proposal.sourceId : undefined)} onEnabled={() => {
              setEnabledSources(current => new Set([...current, identity]));
              props.onCollected?.();
            }} />)}
          </JobList>
        </section>;
      })}
      {props.autoSearchOnOpen && leads.length > 0 && <details className="ard-leads"><summary>{t(`待核实线索（${leads.length}）`, `Unverified leads (${leads.length})`)}</summary>
        <ul>{leads.map(lead => <li key={lead.url}><a href={lead.url} target="_blank" rel="noopener noreferrer">{lead.title}</a>
          <small>{lead.company || new URL(lead.url).hostname}{lead.location && ` · ${lead.location}`}</small></li>)}</ul>
      </details>}
    </section>}
  </section>;
}
