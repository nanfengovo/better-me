import { useUiPreferences, type UiTranslator } from "../lib/ui-preferences";
import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Loader2, Search } from "lucide-react";
import type { OpportunityInput } from "../lib/opportunities";

type Result = { provider: "greenhouse" | "lever" | "tencent"; company: string; sourceUrl: string; observedAt: string; jobs: OpportunityInput[]; truncated: boolean };
type Props = { onImport: (jobs: OpportunityInput[]) => boolean; disabled?: boolean; onOpenNetworkSettings: () => void };

function boardSlug(value: string, provider: Result["provider"], t: UiTranslator) {
  const trimmed = value.trim();
  if (!trimmed.includes("://")) return trimmed;
  const url = new URL(trimmed);
  const hosts = provider === "greenhouse" ? ["boards.greenhouse.io", "job-boards.greenhouse.io"] : ["jobs.lever.co"];
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.port || url.username || url.password) throw new Error(t("请选择与招聘页链接相符的系统。Greenhouse 和 Lever 仅接受各自官方招聘页。", "Select the system matching the career page. Greenhouse and Lever accept only their own official career pages."));
  const slug = url.pathname.split("/").filter(Boolean)[0];
  if (!slug) throw new Error(t("招聘页链接中缺少公司标识。", "The career page URL has no company identifier."));
  return slug;
}

export function OpportunitySourcePanel({ onImport, disabled, onOpenNetworkSettings }: Props) {
  const { t } = useUiPreferences();
  const [provider, setProvider] = useState<Result["provider"]>("greenhouse");
  const [company, setCompany] = useState("");
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(0);
  useEffect(() => () => { operation.current += 1; controller.current?.abort(); }, []);
  function invalidate() { operation.current += 1; controller.current?.abort(); setBusy(false); setResult(null); setChecked([]); setError(""); setMessage(""); }
  async function load(event: React.FormEvent) {
    event.preventDefault(); invalidate();
    const id = operation.current;
    const request = new AbortController(); controller.current = request;
    setBusy(true);
    const timer = setTimeout(() => request.abort(), 25_000);
    try {
      const slug = provider === "tencent" ? "tencent" : boardSlug(company, provider, t);
      const response = await fetch("/api/opportunities/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, company: slug, ...(provider === "tencent" ? { keyword } : {}) }), signal: request.signal });
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(t("当前站点未提供岗位读取服务。可以先手工收藏原始链接和正文。", "Job reading is unavailable on this site. Save the original link and description manually."));
      const body = await response.json() as Result & { error?: string };
      if (id !== operation.current) return;
      if (!response.ok) throw new Error(body.error || t("招聘源暂时不可用，请打开原页查看。", "This job source is unavailable. Open the original page."));
      if (!Array.isArray(body.jobs) || body.jobs.length > 300 || typeof body.sourceUrl !== "string") throw new Error(t("招聘源返回格式异常，本次没有导入。", "The job source returned an invalid format. Nothing was imported."));
      setResult(body);
    } catch (err) { if (id === operation.current) setError(request.signal.aborted ? t("读取超时，可以稍后重试或手工收藏。", "Reading timed out. Try again later or save the job manually.") : err instanceof Error ? err.message : t("读取失败，未修改岗位库。", "Reading failed. The job library is unchanged.")); }
    finally { clearTimeout(timer); if (id === operation.current) setBusy(false); }
  }
  return <details className="opportunity-source-panel">
    <summary>{t("从公司公开招聘页发现机会", "Discover opportunities on public company career pages")} <span>{t("腾讯招聘 / Greenhouse / Lever", "Tencent Careers / Greenhouse / Lever")}</span></summary>
    <p>{t("先查看官网公开结果，再勾选收藏到机会库。国内官网试点目前为腾讯招聘。", "Preview public career page results, then select jobs to save. Tencent Careers is the current China pilot.")}</p>
    <form onSubmit={(event) => void load(event)}>
      <select aria-label={t("公司招聘系统", "Company hiring system")} value={provider} onChange={(event) => { invalidate(); setProvider(event.target.value as Result["provider"]); }}>
        <option value="greenhouse">Greenhouse</option><option value="lever">Lever</option><option value="tencent">{t("腾讯招聘官网", "Tencent Careers")}</option>
      </select>
      {provider === "tencent"
        ? <input aria-label={t("腾讯官网岗位关键词", "Tencent Careers keywords")} maxLength={80} value={keyword} placeholder={t("岗位关键词，例如：后台；留空查看首批结果", "Role keywords, such as backend; leave blank for initial results")} onChange={(event) => { invalidate(); setKeyword(event.target.value); }} />
        : <input aria-label={t("公司招聘页链接或标识", "Company career page URL or identifier")} required value={company} placeholder={provider === "greenhouse" ? t("https://job-boards.greenhouse.io/公司标识", "https://job-boards.greenhouse.io/company") : t("https://jobs.lever.co/公司标识", "https://jobs.lever.co/company")} onChange={(event) => { invalidate(); setCompany(event.target.value); }} />}
      <button className="studio-button" type="submit" disabled={busy || disabled}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}{busy ? t("读取中…", "Reading…") : t("查看公开岗位", "View public jobs")}</button>
    </form>
    {provider === "tencent" && <p>{t("单次仅读取官网搜索结果第 1 页，最多 100 条；可用关键词缩小范围。结果中的岗位职责为摘录，完整任职要求请到原岗位核对。未登录、未自动投递。", "Reads only the first search page, up to 100 jobs. Narrow results with keywords. Responsibilities are excerpts; check complete requirements on the original job page. No login or application is performed.")}</p>}
    {error && <div role="alert" className="opportunity-muted">{error} <button type="button" className="studio-button" onClick={onOpenNetworkSettings}>{t("网络与代理设置", "Network & proxy settings")}</button></div>}
    {message && <div role="status" className="opportunity-muted">{message}</div>}
    {result && <div className="opportunity-source-results">
      <div><strong>{t("返回", "Returned")} {result.jobs.length} {t("个岗位", "jobs")}{result.truncated ? t("（仅本次预览，来源仍有更多结果）", "(preview only; the source has more results)") : ""}</strong><a href={result.sourceUrl} target="_blank" rel="noreferrer">{t("查看公开来源", "View public source")}<ExternalLink size={12} /></a></div>
      <p>{result.provider === "tencent" ? t("国家和单个城市按官网字段保留；只有国家明确为“中国”时归入国内，其余市场请核对。官网的最后更新日期原文保留在职责摘录中，不作为原始发布日期。", "Country and city follow the official fields. Only an explicit China country value is classified as domestic; review other markets. The site's last update date stays in the description excerpt and is not treated as the original publication date.") : t("地点原文保留在 JD 中；市场、具体城市和远程资格请核对后填写。公司名称可能仍是招聘页标识。", "Original location wording stays in the JD. Review the market, city and remote eligibility before entering them. The company name may still be its career page identifier.")}</p>
      <div className="opportunity-source-select">
        <label><input type="checkbox" checked={result.jobs.length > 0 && checked.length === result.jobs.length} onChange={(event) => setChecked(event.target.checked ? result.jobs.map((_, index) => index) : [])} />{t("选择全部", "Select all")}</label>
        <button className="studio-button primary" disabled={!checked.length || disabled} onClick={() => { if (onImport(result.jobs.filter((_, index) => checked.includes(index)))) { setChecked([]); setMessage(t("已处理所选岗位。已有相同来源的记录会保留，不会覆盖投递进度。", "Selected jobs processed. Existing source records and application progress are kept.")); } }}><Download size={13} />{t("收藏所选", "Save selected")} {checked.length} {t("个", "items")}</button>
      </div>
      <div className="opportunity-source-jobs">{result.jobs.map((job, index) => <label key={job.sourceJobId ?? job.sourceUrl ?? index}>
        <input type="checkbox" checked={checked.includes(index)} onChange={(event) => setChecked((current) => event.target.checked ? [...current, index] : current.filter((value) => value !== index))} />
        <span><strong>{job.title}</strong><small>{job.company} · {job.sourcePlatform}{result.provider === "tencent" && job.location ? ` · ${[job.location.country, job.location.city].filter(Boolean).join(" / ") || t("地点待核对", "Location needs review")}` : ""}</small></span>
        {job.applicationUrl && <a href={job.applicationUrl} target="_blank" rel="noreferrer" aria-label={t(`查看 ${job.title} 原岗位`, `View original job: ${job.title}`)}><ExternalLink size={13} /></a>}
      </label>)}</div>
    </div>}
  </details>;
}
