/** @jsxRuntime automatic */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, FileSearch, Loader2, X } from "lucide-react";
import { HttpUrlSchema, type SourceDefinition } from "@better-me/opportunities";
import { assessSourceScopeMatch, SourceScopeSchema, type SourceJobRecord, type SourceScopeMatch } from "@better-me/source-adapters/browser-contracts";
import type { OpportunitySeed } from "../OpportunityWorkspace";
import { useUiPreferences } from "../../lib/ui-preferences";
import { createAtlasSourceClient, type AtlasSourcePreview, type AtlasSourceScopeInput } from "./service-client";
import "./AtlasSourceCandidateReview.css";

export type AtlasSourceCandidateReviewProps = {
  endpoint: string;
  token: string;
  source: SourceDefinition;
  request: AtlasSourceScopeInput;
  onClose: () => void;
  onReview?: (seed: OpportunitySeed) => void;
};
type MatchStatus = SourceScopeMatch["status"];
type Filter = "all" | MatchStatus;
type Binding = { client: ReturnType<typeof createAtlasSourceClient>; source: SourceDefinition; request: AtlasSourceScopeInput };
type Operation = { binding: Binding; controller: AbortController };
const order: Record<MatchStatus, number> = { unknown: 0, matched: 1, excluded: 2 };

/** Stop waiting at cancellation even when a transport ignores its abort signal. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { void pending.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    void pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** Explicit one-page reading only. Neither preview nor opportunity prefill commits an index record. */
export function AtlasSourceCandidateReview({ endpoint, token, source, request, onClose, onReview }: AtlasSourceCandidateReviewProps) {
  const { t } = useUiPreferences();
  const headingId = useId();
  const sourceIdentity = JSON.stringify(source);
  const requestIdentity = JSON.stringify(request);
  const binding = useMemo<Binding>(() => ({ client: createAtlasSourceClient(endpoint, token),
    source: JSON.parse(sourceIdentity) as SourceDefinition, request: JSON.parse(requestIdentity) as AtlasSourceScopeInput,
  }), [endpoint, token, sourceIdentity, requestIdentity]);
  const active = useRef<Operation | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [result, setResult] = useState<{ binding: Binding; value: AtlasSourcePreview }>();
  const [failure, setFailure] = useState<{ binding: Binding; message: string }>();
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => () => { active.current?.controller.abort(); active.current = null; }, [binding]);
  const busy = operation?.binding === binding;
  const value = result?.binding === binding ? result.value : undefined;
  const error = failure?.binding === binding ? failure.message : undefined;
  const eligible = Boolean(token.trim()) && source.enabled && source.status === "active"
    && source.runtime.includes("local-service") && source.capabilities.includes("list-jobs");
  const classified = value?.page.records.map((record, index) => ({ record, index,
    status: assessSourceScopeMatch(record, value.localFilters).status,
  })).sort((a, b) => order[a.status] - order[b.status] || a.index - b.index) ?? [];
  const counts = { unknown: 0, matched: 0, excluded: 0 };
  for (const entry of classified) counts[entry.status]++;
  const labels: Record<Filter, string> = {
    all: t("全部记录", "All records"), unknown: t("待核对", "Needs review"),
    matched: t("已读字段命中", "Read fields match"), excluded: t("本次条件排除", "Excluded by this scope"),
  };
  function cancel() { active.current?.controller.abort(); active.current = null; setOperation(null); }
  function close() { cancel(); onClose(); }
  async function preview() {
    if (!eligible || active.current) return;
    const current = { binding, controller: new AbortController() };
    active.current = current; setOperation(current); setResult(undefined); setFailure(undefined); setFilter("all");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; current.controller.abort(); }, 60_000);
    try {
      const { maxPages: ignoredPages, ...input } = binding.request; void ignoredPages;
      const next = await abortable(binding.client.preview(binding.source.sourceId, input, { signal: current.controller.signal }), current.controller.signal);
      current.controller.signal.throwIfAborted();
      if (input.scope && JSON.stringify(SourceScopeSchema.parse(input.scope)) !== JSON.stringify(next.localFilters)) {
        throw new Error(t("预览条件与本次请求不一致，请重新读取。", "Preview filters do not match this request. Read again."));
      }
      if (active.current === current) setResult({ binding, value: next });
    } catch (problem) {
      if (active.current === current) setFailure({ binding, message: timedOut
        ? t("预览等待超过 60 秒，已停止等待；可以重新读取。", "Preview exceeded 60 seconds. Waiting stopped; you can read again.")
        : current.controller.signal.aborted ? t("预览已取消。", "Preview cancelled.")
          : problem instanceof Error ? problem.message : t("来源预览失败。", "Source preview failed.") });
    } finally {
      clearTimeout(timer);
      if (active.current === current) { active.current = null; setOperation(null); }
    }
  }
  function review(record: SourceJobRecord) {
    if (!value || !onReview || record.entityType !== "job-posting") return;
    const safeUrl = HttpUrlSchema.safeParse(record.url);
    onReview({ token: crypto.randomUUID(), title: [record.companyName, record.title].filter(Boolean).join(" · "),
      description: record.description ?? "", sourcePlatform: source.attribution.label, collectedAt: value.page.observedAt,
      ...(safeUrl.success ? { sourceUrl: safeUrl.data } : {}),
      ...(record.sourcePublishedAt ? { sourcePublishedAt: record.sourcePublishedAt } : {}),
      ...(record.sourcePublishedRaw ? { sourcePublishedText: record.sourcePublishedRaw } : {}),
    });
  }
  return <section className="atlas-source-review" aria-label={t("来源候选核对", "Review source candidates")} aria-labelledby={headingId} aria-busy={busy}>
    <header><div><p className="atlas-source-review-eyebrow">SOURCE CANDIDATES</p><h2 id={headingId}><FileSearch size={18} />{t("重新读取 · 核对来源候选", "Read again · review source candidates")}</h2><p>{source.attribution.label} · {source.sourceId}</p>
      <dl className="atlas-source-review-scope" aria-label={t("本次预览绑定条件", "Scope bound to this preview")}>
        <div><dt>{t("岗位关键词", "Role keywords")}</dt><dd>{binding.request.scope?.roles.join(" / ") || t("全部", "All")}</dd></div>
        <div><dt>{t("公司", "Companies")}</dt><dd>{binding.request.scope?.companyNames.join(" / ") || t("全部", "All")}</dd></div>
        <div><dt>{t("地区", "Regions")}</dt><dd>{binding.request.scope?.regions.join(" / ") || t("全部", "All")}</dd></div>
        {!!binding.request.scope?.countryCodes?.length && <div><dt>{t("国家 / 地区代码", "Country / region codes")}</dt><dd>{binding.request.scope.countryCodes.join(" / ")}</dd></div>}
      </dl></div>
      <button type="button" aria-label={t("关闭候选核对", "Close candidate review")} onClick={close}><X size={18} /></button></header>
    <p className="atlas-source-review-note">{t("点击后重新读取来源当前一页，不是上次同步回执的记录。待核对项未确认关键词命中；这里不会写入正式索引或地图，也不会自动选择城市。", "Click to read one current source page, not the records of the last sync receipt. Unresolved items are not confirmed keyword matches. This view does not write to the index or map or select a city.")}</p>
    <div className="atlas-source-review-actions"><button type="button" disabled={!eligible || busy} onClick={() => void preview()}>{busy && <Loader2 size={15} className="animate-spin" />}{t("重新预览一页 · 不写入", "Preview one current page · no write")}</button>
      {busy && <button type="button" onClick={cancel}>{t("取消预览", "Cancel preview")}</button>}</div>
    {!eligible && <p role="note">{t("需要已启用的本机岗位来源和访问令牌，才可读取预览。", "An enabled local job source and access token are required.")}</p>}
    {busy && <p role="status">{t("正在读取来源当前一页，最多等待 60 秒…", "Reading one current source page; waiting up to 60 seconds…")}</p>}
    {error && <p role="alert" className="atlas-source-review-error">{error}</p>}
    {value && <div className="atlas-source-review-result">
      <p className="atlas-source-review-observed">{t("本次重新读取时间", "Observed on this new read")}：<time dateTime={value.page.observedAt}>{value.page.observedAt}</time></p>
      <p>{t("来源已读", "Source fetched")} {value.page.coverage.fetchedRecords} · {t("本页返回", "Returned on this page")} {classified.length} · {value.page.coverage.complete ? t("来源报告完整列举", "Source reports complete enumeration") : t("本次覆盖有限", "Limited coverage")}{value.page.stopReason && ` · ${value.page.stopReason}`}{value.page.nextCursor && t(" · 仍有后续页，本面板不自动翻页", " · More pages exist; no automatic pagination")}</p>
      <div className="atlas-source-review-filters" role="group" aria-label={t("候选分类筛选", "Filter candidate classification")}>{(["all", "unknown", "matched", "excluded"] as const).map((status) => <button key={status} type="button" aria-pressed={filter === status} onClick={() => setFilter(status)}>{labels[status]} {status === "all" ? classified.length : counts[status]}</button>)}</div>
      {value.page.warnings.length > 0 && <ul className="atlas-source-review-warnings">{value.page.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div className="atlas-source-review-cards">{classified.filter((entry) => filter === "all" || entry.status === filter).map(({ record, index, status }) => {
        const safeUrl = HttpUrlSchema.safeParse(record.url);
        return <article key={index} data-match-status={status} className="atlas-source-review-card">
          <div className="atlas-source-review-card-meta"><strong className="atlas-source-review-classification">{labels[status]}</strong><span>{source.attribution.label}</span><span>{record.completeness === "detail" ? t("来源正文", "Source detail") : record.completeness === "excerpt" ? t("来源摘录", "Source excerpt") : t("来源线索", "Source lead")}</span></div>
          <h3>{record.title}</h3><p>{record.companyName ?? t("企业未披露", "Company not disclosed")}</p>
          <p className="atlas-source-review-location">{t("地点原文", "Original locations")}：{record.locations.map((location) => location.raw).join(" / ") || t("未披露", "Not disclosed")}</p>
          <p>{t("发布时间原文", "Original publication time")}：{record.sourcePublishedRaw ?? t("未披露", "Not disclosed")}</p>
          {record.sourcePublishedAt && <p>{t("已解析发布时间", "Parsed publication time")}：<time dateTime={record.sourcePublishedAt}>{record.sourcePublishedAt}</time></p>}
          {status === "unknown" && <p className="atlas-source-review-note">{t("要求尚未完整读取，不能据摘录确认命中或判定不匹配。", "Requirements have not been fully read. This excerpt cannot confirm a match or a non-match.")}</p>}
          {record.warnings.length > 0 && <ul className="atlas-source-review-warnings">{record.warnings.map((warning, item) => <li key={item}>{warning}</li>)}</ul>}
          {record.description ? <details><summary>{t("查看本次来源文本", "Read this source text")}</summary><div className="atlas-source-review-description">{record.description}</div></details> : <p>{t("本次来源未提供正文。", "This read did not provide description text.")}</p>}
          <div className="atlas-source-review-card-actions">{safeUrl.success ? <a href={safeUrl.data} target="_blank" rel="noopener noreferrer">{t("打开岗位原文", "Open original posting")}<ArrowUpRight size={13} /></a> : <span>{t("原文链接未提供", "No original link")}</span>}
            {onReview && record.entityType === "job-posting" && <button type="button" onClick={() => review(record)}>{t("核对后预填机会", "Prefill opportunity for review")}</button>}</div>
        </article>;
      })}</div>
      {!classified.length && <p>{t("本页没有返回记录，不代表来源没有相关岗位。", "No records returned on this page. This does not prove the source has no relevant jobs.")}</p>}
      {classified.length > 0 && !classified.some((entry) => filter === "all" || entry.status === filter) && <p>{t("本页没有此分类的记录。", "This page has no records in this classification.")}</p>}
      {onReview && <p className="atlas-source-review-note">{t("“预填机会”只进入人工核对草稿，尚未保存，也不会把未确认项写成规范岗位。", "Opportunity prefill opens a draft for human review. It is not a save or a canonical job import.")}</p>}
    </div>}
  </section>;
}

export default AtlasSourceCandidateReview;
