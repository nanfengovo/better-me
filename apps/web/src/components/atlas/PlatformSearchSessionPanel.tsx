/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PlatformSearchRequest, PlatformSearchInput } from "@better-me/source-adapters/browser-contracts";
import { closeJdBrowserSession, focusJdBrowserSession, inspectJdBrowserSession, type JdBrowserSession, type JdBrowserSessionInspection } from "../../lib/jd-import";
import { startPlatformSearch, readPlatformSearch, cancelPlatformSearch, type PlatformSearchReceipt, type PlatformSearchCard } from "../../lib/platform-search-client";
import { createJdStartRequestId } from "../../lib/jd-start-request";
import { JdExtractionError } from "../../lib/jd-errors";
import { snapshotFailureMessage } from "../../lib/jd-capture-diagnostics";
import { SourcePublicationBadges } from "./JobSourceBadges";

type Props = { requests: PlatformSearchRequest[]; onReviewCard?: (card: PlatformSearchCard, capturedAt: string) => void;
  onIndexCard?: (card: PlatformSearchCard, receipt: PlatformSearchReceipt, provider: PlatformSearchRequest["provider"]) => void };
const labels: Record<PlatformSearchReceipt["status"], string> = {
  ready: "已读取当前页岗位卡片", empty: "原站当前页明确显示暂无结果", login_required: "原站需要登录，请在专用窗口完成后再次读取",
  verification_required: "原站需要人工验证，完成后可再次读取", unknown_layout: "尚未识别到可靠的岗位卡片，请核对页面是否加载完成",
  oversized: "当前页超过读取上限，未采用不完整内容", unsupported_page: "当前页面不属于本次搜索范围，请结束后重新搜索",
};
const snapshotLabels: Record<JdBrowserSessionInspection["snapshotState"], string> = {
  ready: "页面状态检查已完成，搜索结果仍需单独读取确认。",
  navigation_in_progress: "页面仍在跳转，请稍后再次检查；本次无法判断登录或访问验证状态。",
  failed: "本次未能检查当前页面，登录或访问验证状态尚未确认。",
  oversized: "当前页面超过状态检查上限，页面内容及登录或访问验证状态尚未确认。",
};
const pageLabels: Record<JdBrowserSessionInspection["pageState"], string> = {
  original_job: "当前窗口被识别为岗位详情页，请核对并返回本次搜索列表后读取。",
  platform_intermediate: "当前窗口处于平台中转、登录或验证页面，请在专用窗口核对后继续。",
  different_job: "当前页面与本次搜索范围不一致，请返回原搜索列表。",
  blank: "当前窗口是空白页，尚未取得搜索页面内容。",
  unknown: "尚未确认当前页面类型，请核对专用窗口中的搜索列表。",
};

/** One visible browser session, explicit read/close, no automatic applications or account actions. */
export function PlatformSearchSessionPanel({ requests, onReviewCard, onIndexCard }: Props) {
  const [provider, setProvider] = useState("liepin");
  const [session, setSession] = useState<JdBrowserSession>();
  const [scope, setScope] = useState<PlatformSearchRequest>();
  const [receipt, setReceipt] = useState<PlatformSearchReceipt>();
  const [inspection, setInspection] = useState<JdBrowserSessionInspection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ input: PlatformSearchInput; requestId: string }>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const operationAbort = useRef<AbortController | undefined>(undefined);
  const binding = useRef<typeof pending>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; operationAbort.current?.abort();
      if (binding.current) void cancelPlatformSearch(binding.current.input, binding.current.requestId, true).catch(() => {});
    };
  }, []);
  const plan = requests.find((entry) => entry.provider === provider) ?? requests[0];
  async function run(operation: (signal: AbortSignal) => Promise<void>, preserveSessionOnFailure = false) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const abort = new AbortController(); operationAbort.current = abort;
    const timer = setTimeout(() => abort.abort(new Error("本次读取超时。可重试恢复同一搜索，或结束本次请求。")), 55_000);
    try { await operation(abort.signal); } catch (cause) {
      if (mounted.current) {
        if (!preserveSessionOnFailure && cause instanceof JdExtractionError && cause.failure.code === "browser_session_expired") setSession(undefined);
        setError(cause instanceof Error ? cause.message : "读取未完成，请核对专用窗口。");
      }
    } finally { clearTimeout(timer); inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const read = (current: JdBrowserSession) => run(async (signal) => { setReceipt(undefined); const next = await readPlatformSearch(current, signal); if (mounted.current) setReceipt(next); });
  const inspect = (current: JdBrowserSession) => run(async signal => {
    setInspection(undefined);
    const next = await inspectJdBrowserSession(current, signal);
    if (mounted.current) setInspection(next);
  }, true);
  function start() {
    if ((!plan && !pending) || session) return;
    void run(async (signal) => {
      const launch = pending ?? { input: { provider: plan!.provider, keyword: plan!.keyword, ...(plan!.region ? { regionId: plan!.region.id } : {}) }, requestId: createJdStartRequestId() };
      binding.current = launch; setPending(launch);
      setReceipt(undefined); setInspection(undefined); if (!pending) setScope(plan);
      const current = await startPlatformSearch(launch.input, signal, launch.requestId);
      if (!mounted.current) return;
      setSession(current);
      const next = await readPlatformSearch(current, signal); if (mounted.current) setReceipt(next);
    });
  }
  const end = () => run(async () => {
    if (binding.current) await cancelPlatformSearch(binding.current.input, binding.current.requestId);
    else if (session) await closeJdBrowserSession(session.sessionId);
    binding.current = undefined;
    if (mounted.current) { setSession(undefined); setPending(undefined); setReceipt(undefined); setInspection(undefined); setScope(undefined); }
  });
  return <section className="atlas-platform-reader" aria-label="平台真实搜索列表工具">
    <strong>读取原站搜索结果</strong>
    <p>使用本机专用浏览器读取当前页，最多 50 张可见岗位卡片。需要登录或验证时，在窗口中完成后继续；可在原站翻页后再次读取。卡片摘要与完整 JD 分开，缺失薪资、地址坐标和发布时间保持未知。</p>
    <div className="atlas-platform-reader-actions">
      <select aria-label="读取岗位平台" disabled={busy || Boolean(pending)} value={scope?.provider ?? plan?.provider ?? ""} onChange={(event) => setProvider(event.target.value)}>
        {scope && !requests.some((request) => request.provider === scope.provider) && <option value={scope.provider}>{scope.platform} · 本次会话</option>}
        {!requests.length && <option value="">请先选择支持的地区</option>}
        {requests.map((entry) => <option key={entry.provider} value={entry.provider}>{entry.platform}</option>)}
      </select>
      <button type="button" disabled={busy || Boolean(session) || (!plan && !pending)} onClick={start}>{busy && !session ? "正在打开并读取…" : pending && !session ? "重试恢复本次搜索" : "搜索并读取当前页"}</button>
      {busy && <button type="button" onClick={() => operationAbort.current?.abort(new Error("已中止等待；启动结果未知时，请恢复或结束本次请求。"))}>取消本次等待</button>}
      {session && <>
        <button type="button" disabled={busy} onClick={() => void read(session)}>{busy ? "正在读取…" : "再次读取当前页"}</button>
        <button type="button" disabled={busy} onClick={() => void inspect(session)}>检查页面状态</button>
        <button type="button" disabled={busy} onClick={() => void run(async (signal) => { await focusJdBrowserSession(session, signal); })}>显示专用窗口</button>
      </>}
      {pending && <button type="button" disabled={busy} onClick={() => void end()}>{session ? "结束搜索会话" : "结束本次搜索请求"}</button>}
    </div>
    {busy && <p className="atlas-platform-reader-loading" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" />正在等待原站页面并核对可见卡片… 页面加载、身份与字段检查完成后会显示结果。</p>}
    {scope && <p className="atlas-small">本次搜索：{scope.platform} · {scope.keyword || "不限关键词"} · {scope.region?.name ?? "原站默认地区"}。上方筛选改变后，结束本次会话再发起新的搜索。</p>}
    {error && <p role="alert" className="atlas-platform-search-error">{error}</p>}
    {inspection && <div className="atlas-small" role="status" aria-label="搜索页面状态检查结果">
      <strong>上次页面状态检查</strong>
      <p>{snapshotLabels[inspection.snapshotState]}</p>
      <p>{pageLabels[inspection.pageState]}</p>
      {inspection.snapshotState === "ready" && <p>{inspection.gate === "login_required"
        ? "当前页面要求登录，请在专用窗口自行完成后再次读取当前页。"
        : inspection.gate === "verification_required"
          ? "当前页面要求访问验证，请在专用窗口自行完成后再次读取当前页。"
          : "本次未检测到登录或访问验证提示，搜索结果是否可读仍需再次读取确认。"}</p>}
      {inspection.snapshotFailure && <p>{snapshotFailureMessage(inspection.snapshotFailure)}</p>}
    </div>}
    {receipt && <div className="atlas-platform-reader-result" role="status">
      <strong>{labels[receipt.status]}{receipt.status === "ready" || receipt.status === "empty" ? ` · ${receipt.cards.length} 岗` : " · 岗位数量尚未确认"}</strong>
      <p>仅本次单页读取，未自动遍历全站。核对后可加入统一索引继续搜索，或预填机会库；缺少坐标的岗位仍列为待定位。</p>
      {receipt.warnings.map((warning, index) => <p className="atlas-small" key={index}>{warning}</p>)}
      <ul className="atlas-platform-card-list">{receipt.cards.map((card) => <li key={card.url}>
        <SourcePublicationBadges sourceLabel={card.platform} platform={card.platform} publishedRaw={card.publicationText} sourceUrl={card.url} link />
        <a href={card.url} target="_blank" rel="noopener noreferrer"><strong>{card.title}</strong></a>
        <span>{card.company || "雇主待核对"} · {card.locationText || "工作地点未披露"}</span>
        <span>{card.salaryText || "薪资未披露"}</span>
        <details><summary>查看实际读取的卡片原文</summary><pre>{card.cardText}</pre></details>
        {onReviewCard && <button type="button" onClick={() => onReviewCard(card, receipt.capturedAt)}>核对并收藏此岗位</button>}
        {onIndexCard && scope && <button type="button" disabled={!card.company?.trim()} title={!card.company?.trim() ? "雇主未披露，请先打开原文核对" : undefined} onClick={() => onIndexCard(card, receipt, scope.provider)}>核对并加入统一索引</button>}
      </li>)}</ul>
    </div>}
  </section>;
}
