import { hasAtlasServiceTarget } from "./backend-connection";
import { useEffect, useMemo, useRef, useState } from "react";
import { Database, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { AtlasDataset, SourceDefinition } from "@better-me/opportunities";
import type { SourceCandidate, SourceCandidateInspection, SourceDiscoveryPage, SourceRegistrationProposal } from "@better-me/source-adapters/browser-contracts";
import { JsonFieldMappingSchema } from "@better-me/source-adapters/browser-contracts";
import { useUiPreferences } from "../../lib/ui-preferences";
import { AtlasSourceServiceError, createAtlasSourceClient, parseAtlasSourceJson, type AtlasRegisterSource, type AtlasSourceList, type AtlasSourcePreview } from "./service-client";
import "./sources-panel.css";
import { CompanyCareersPanel } from "./CompanyCareersPanel";
import { SourceCatalogPanel } from "./SourceCatalogPanel";
import { sourceCatalogIdentity } from "./source-catalog";
import { AtlasSourceScanControls } from "./AtlasSourceScanControls";
import { useAtlasSourceScanRecovery } from "./source-scan-recovery";
import { useAtlasAggregateRecovery } from "./aggregate-recovery";
import { AtlasAggregateRecoveryControls } from "./AtlasAggregateRecoveryControls";

export type AtlasSourcesPanelProps = {
  endpoint: string;
  token: string;
  onSnapshot: (data: AtlasDataset) => void;
  onClose: () => void;
  disabled?: boolean;
};
type PendingWrite = { identity: string; key: string; registration?: AtlasRegisterSource };
const terms = (value: string) => [...new Set(value.split(/[,，;；\n]/).map((term) => term.trim()).filter(Boolean))];
const errorText = (error: unknown) => error instanceof Error ? error.message : "来源操作失败。请检查本机服务。";
const runnable = (source: SourceDefinition) => source.enabled && source.status === "active" && source.runtime.includes("local-service");

export function AtlasSourcesPanel({ endpoint, token, onSnapshot, onClose, disabled = false }: AtlasSourcesPanelProps) {
  const { t } = useUiPreferences();
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const [catalog, setCatalog] = useState<AtlasSourceList>({ sources: [], adapters: [] });
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [aggregateBusy, setAggregateBusy] = useState(false);
  const aggregateRecovery = useAtlasAggregateRecovery(endpoint, token);
  const aggregateLocked = aggregateRecovery.active || aggregateRecovery.entries.length > 0;
  const scanRecovery = useAtlasSourceScanRecovery(endpoint, token);
  const scanLocked = Boolean(disabled || scanBusy || aggregateBusy || aggregateLocked || scanRecovery.pending || scanRecovery.saved || scanRecovery.refreshOnly);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [roles, setRoles] = useState("");
  const [regions, setRegions] = useState("");
  const [companies, setCompanies] = useState("");
  const [maxRecords, setMaxRecords] = useState("100");
  const [maxPages, setMaxPages] = useState("1");
  const [preview, setPreview] = useState<{ sourceId: string; value: AtlasSourcePreview }>();
  const [jsonText, setJsonText] = useState("");
  const [configs, setConfigs] = useState<AtlasRegisterSource[]>([]);
  const [configIndex, setConfigIndex] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [discoverySourceId, setDiscoverySourceId] = useState("");
  const [query, setQuery] = useState("");
  const [discoveryLimit, setDiscoveryLimit] = useState("10");
  const [discovery, setDiscovery] = useState<{ sourceId: string; query: string; limit: number; page: SourceDiscoveryPage }>();
  const [sampleUrl, setSampleUrl] = useState("");
  const [inspection, setInspection] = useState<{ candidate: SourceCandidate; value: SourceCandidateInspection }>();
  const [proposal, setProposal] = useState<SourceRegistrationProposal>();
  const active = useRef<AbortController | null>(null);
  const pending = useRef(new Map<string, PendingWrite>());
  const source = catalog.sources.find((entry) => entry.sourceId === sourceId);
  const canEnumerate = source && runnable(source) && source.capabilities.includes("list-jobs") && Boolean(source.entryUrl)
    && (!["mapped-json", "github-json"].includes(source.adapterId) || JsonFieldMappingSchema.strip().safeParse(source.options ?? {}).success)
    && catalog.adapters.some((adapter) => adapter.adapterId === source.adapterId && adapter.version === source.adapterVersion && adapter.capabilities.includes("list-jobs"));
  const config = configs[configIndex];
  const discoverySources = catalog.sources.filter((entry) => entry.capabilities.includes("discover-sources") && runnable(entry));
  const usable = hasAtlasServiceTarget(endpoint, token);

  async function operation(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (active.current || scanLocked) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(label); setError(""); setNotice("");
    try { await action(controller.signal); }
    catch (failure) {
      if (active.current !== controller) return;
      if (controller.signal.aborted) setNotice(t("操作已取消。已提交的部分结果可能仍保留，请重新读取公开快照核对。", "Cancelled. Already committed results may remain; reload the public snapshot to check."));
      else setError(errorText(failure));
    } finally { if (active.current === controller) { active.current = null; setBusy(""); } }
  }
  const loadCatalog = async (signal: AbortSignal) => {
    const next = await client.list({ signal }); signal.throwIfAborted();
    setCatalog(next);
    setSourceId((previous) => next.sources.some((entry) => entry.sourceId === previous) ? previous : next.sources.find((entry) => entry.capabilities.includes("list-jobs"))?.sourceId ?? "");
    setDiscoverySourceId((previous) => next.sources.some((entry) => entry.sourceId === previous && runnable(entry) && entry.capabilities.includes("discover-sources")) ? previous
      : next.sources.find((entry) => runnable(entry) && entry.capabilities.includes("discover-sources"))?.sourceId ?? "");
  };
  useEffect(() => {
    const controller = new AbortController(); active.current?.abort(); active.current = controller; pending.current.clear();
    setCatalog({ sources: [], adapters: [] }); setSourceId(""); setDiscoverySourceId(""); setPreview(undefined);
    setDiscovery(undefined); setInspection(undefined); setProposal(undefined); setError(""); setNotice("");
    if (!usable) { active.current = null; setBusy(""); return () => controller.abort(); }
    setBusy("读取来源");
    void client.list({ signal: controller.signal }).then((next) => {
      controller.signal.throwIfAborted(); setCatalog(next);
      setSourceId(next.sources.find((entry) => entry.capabilities.includes("list-jobs"))?.sourceId ?? "");
      setDiscoverySourceId(next.sources.find((entry) => runnable(entry) && entry.capabilities.includes("discover-sources"))?.sourceId ?? "");
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(errorText(failure)); })
      .finally(() => { if (active.current === controller) { active.current = null; setBusy(""); } });
    return () => { controller.abort(); active.current?.abort(); active.current = null; };
  }, [client, usable]);

  function scopeInput() {
    const records = Number(maxRecords); const pages = Number(maxPages);
    if (!Number.isInteger(records) || records < 1 || records > 100_000 || !Number.isInteger(pages) || pages < 1 || pages > 1000) {
      throw new AtlasSourceServiceError("invalid-input", t("记录上限为 1–100000，页数为 1–1000 的整数。", "Use integer record limits from 1–100000 and page limits from 1–1000."));
    }
    return { scope: { roles: terms(roles), regions: terms(regions), companyNames: terms(companies) }, maxRecords: records, maxPages: pages };
  }
  async function registerConfig(signal: AbortSignal) {
    if (!config) return;
    const identity = JSON.stringify(["register", config]);
    if (!pending.current.has(identity)) {
      const snapshot = await client.snapshot({ signal }); signal.throwIfAborted();
      pending.current.set(identity, { identity, key: crypto.randomUUID(), registration: { ...config, expectedRevision: config.expectedRevision ?? snapshot.revision } });
    }
    const write = pending.current.get(identity)!;
    let receipt;
    try { receipt = await client.register(write.registration!, { signal, idempotencyKey: write.key }); }
    catch (failure) {
      // A definite version rejection wrote nothing; a transport timeout remains ambiguous.
      if (failure instanceof AtlasSourceServiceError && failure.code === "stale-version") { pending.current.delete(identity); setReviewed(false); }
      throw failure;
    }
    signal.throwIfAborted(); pending.current.delete(identity);
    setNotice(t(`来源已保存，索引版本 ${receipt.revision}。`, `Source saved at index revision ${receipt.revision}.`));
    await loadCatalog(signal);
    const snapshot = await client.snapshot({ signal }); signal.throwIfAborted(); onSnapshot(snapshot);
  }
  async function installCatalogSources(sources: SourceDefinition[], signal: AbortSignal) {
    let added = 0;
    for (const preset of sources) {
      signal.throwIfAborted();
      const source: SourceDefinition = { ...preset, enabled: true, status: "active" };
      const identity = JSON.stringify(["catalog-register", source]);
      if (!pending.current.has(identity)) {
        const snapshot = await client.snapshot({ signal }); signal.throwIfAborted();
        if (snapshot.sources.some((entry) => entry.sourceId === source.sourceId || sourceCatalogIdentity(entry) === sourceCatalogIdentity(source))) continue;
        pending.current.set(identity, { identity, key: crypto.randomUUID(), registration: { source, expectedRevision: snapshot.revision } });
      }
      const write = pending.current.get(identity)!;
      try { await client.register(write.registration!, { signal, idempotencyKey: write.key }); }
      catch (failure) {
        if (failure instanceof AtlasSourceServiceError && failure.code === "stale-version") pending.current.delete(identity);
        // Unknown receipts keep the exact configuration, revision and key for an explicit retry.
        throw failure;
      }
      signal.throwIfAborted(); pending.current.delete(identity); added++;
      await loadCatalog(signal);
      const snapshot = await client.snapshot({ signal }); signal.throwIfAborted(); onSnapshot(snapshot);
      setNotice(`已添加 ${added}/${sources.length} 个来源；尚未采集岗位。`);
    }
    setNotice(`已添加 ${added} 个来源，已有配置未覆盖。关闭来源工具后，主搜索可同时查询已启用来源。`);
  }
  function editJson(value: string) { setJsonText(value); setConfigs([]); setConfigIndex(0); setReviewed(false); }
  function checkJson() {
    setError(""); setNotice("");
    try { const parsed = parseAtlasSourceJson(jsonText); setConfigs(parsed); setConfigIndex(0); setReviewed(false); }
    catch (failure) { setConfigs([]); setError(errorText(failure)); }
  }
  function discover(cursor?: string) {
    void operation(t("发现来源", "Discover sources"), async (signal) => {
      const requestedQuery = cursor && discovery ? discovery.query : query.trim();
      const requestedSource = cursor && discovery ? discovery.sourceId : discoverySourceId;
      const limit = cursor && discovery ? discovery.limit : Number(discoveryLimit);
      const page = await client.discover(requestedSource, { provider: "github-repositories", query: requestedQuery, limit, ...(cursor ? { cursor } : {}) }, { signal });
      signal.throwIfAborted(); setDiscovery({ sourceId: requestedSource, query: requestedQuery, limit, page }); setInspection(undefined); setProposal(undefined);
    });
  }

  return <section className="atlas-sources-panel" aria-label={t("岗位来源工具", "Job source tools")} aria-busy={Boolean(busy || scanBusy || aggregateBusy)}>
    <header><div><span className="atlas-eyebrow">SOURCE TOOLS</span><h2><Database size={19} />{t("岗位来源工具", "Job source tools")}</h2></div>
      <button type="button" onClick={() => { active.current?.abort(); onClose(); }} aria-label={t("关闭来源工具", "Close source tools")}><X size={17} /></button></header>
    <p>{t("通过岗位后端管理来源、有限预览与手动刷新。岗位、招聘活动和公司线索分别保存；原始来源与覆盖范围会保留。", "Manage real sources, bounded previews and manual refreshes through the job backend. Jobs, campaigns and company leads retain their separate identity and provenance.")}</p>
    {!usable && <p role="status" className="atlas-sources-callout">{t("请先连接岗位后端；默认后端无需填写令牌，高级直连需有效服务地址与令牌。", "The default backend needs no token entry; advanced direct connections require a valid service address and token.")}</p>}
    <CompanyCareersPanel endpoint={endpoint} token={token} sources={catalog.sources} onProposal={editJson} onSelectSource={(id, companyName) => { setSourceId(id); const configuredName = catalog.sources.find((entry) => entry.sourceId === id)?.options?.companyName; setCompanies(typeof configuredName === "string" ? configuredName : companyName); setPreview(undefined); setNotice("已选择企业招聘来源。可继续填写岗位关键词与地区，预览后手动获取真实岗位。"); }} />
    {busy && <div role="status" className="atlas-sources-actions"><Loader2 size={15} className="animate-spin" /><span>{busy}</span><button type="button" onClick={() => active.current?.abort()}>{t("取消操作", "Cancel operation")}</button></div>}
    {error && <p role="alert" className="atlas-sources-error">{error}</p>}
    {notice && <p role="status" className="atlas-sources-callout">{notice}</p>}
    <SourceCatalogPanel installed={catalog.sources} busy={Boolean(busy || scanLocked)} connected={usable} onInstall={(sources) => void operation(t("添加来源", "Add sources"), (signal) => installCatalogSources(sources, signal))} />
    <div className="atlas-sources-actions">
      <button type="button" disabled={!usable || Boolean(busy || scanLocked)} onClick={() => void operation(t("读取来源", "Read sources"), loadCatalog)}><RefreshCw size={14} />{t("重新读取来源", "Reload sources")}</button>
      <button type="button" disabled={!usable || Boolean(busy || scanLocked)} onClick={() => void operation(t("读取公开快照", "Read public snapshot"), async (signal) => {
        const snapshot = await client.snapshot({ signal }); signal.throwIfAborted(); onSnapshot(snapshot); setNotice(t(`地图已读取 ${snapshot.jobs.length} 个规范岗位。`, `Map loaded ${snapshot.jobs.length} canonical jobs.`));
      })}>{t("更新地图快照", "Update map snapshot")}</button>
    </div>

    <details open><summary>{t("已保存来源与关注范围", "Saved sources and interests")} <span>{catalog.sources.length}</span></summary>
      <p className="atlas-sources-muted">{t("每个来源有自己的能力和抓取上限。关注条件只在已读取的记录内过滤，远程支持范围按实际返回显示。这里不代表 51、Boss、猎聘或 LinkedIn 全站搜索。", "Each source has its own capabilities and limits. Interests filter the fetched records; actual remote filter coverage is reported separately. These tools do not provide a whole-platform search of 51job, Boss, Liepin or LinkedIn.")}</p>
      <div className="atlas-sources-grid"><label>{t("岗位来源", "Job source")}<select value={sourceId} disabled={Boolean(busy || scanLocked)} onChange={(event) => { setSourceId(event.target.value); setPreview(undefined); }}>
        <option value="">{t("选择来源", "Select source")}</option>{catalog.sources.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.name} · {entry.enabled && entry.status === "active" ? t("已启用", "enabled") : entry.status}</option>)}</select></label>
        <label>{t("记录上限", "Record limit")}<input type="number" min="1" max="100000" value={maxRecords} disabled={Boolean(busy || scanLocked)} onChange={(event) => setMaxRecords(event.target.value)} /></label>
        <label>{t("刷新页数上限", "Refresh page limit")}<input type="number" min="1" max="1000" value={maxPages} disabled={Boolean(busy || scanLocked)} onChange={(event) => setMaxPages(event.target.value)} /></label>
        <label>{t("岗位关键词 · 逗号分隔", "Role terms · comma separated")}<input value={roles} disabled={Boolean(busy || scanLocked)} onChange={(event) => setRoles(event.target.value)} placeholder="TypeScript, 自动化" /></label>
        <label>{t("地区 · 逗号分隔", "Regions · comma separated")}<input value={regions} disabled={Boolean(busy || scanLocked)} onChange={(event) => setRegions(event.target.value)} placeholder="上海, Singapore" /></label>
        <label>{t("公司 · 逗号分隔", "Companies · comma separated")}<input value={companies} disabled={Boolean(busy || scanLocked)} onChange={(event) => setCompanies(event.target.value)} /></label>
      </div>
      {source && <div className="atlas-sources-source-info"><strong>{source.attribution.label}</strong><span>{source.sourceId} · {source.adapterId}@{source.adapterVersion} · {source.entityType}</span>
        {source.entryUrl && <a href={source.entryUrl} target="_blank" rel="noreferrer">{source.entryUrl}</a>}
        <span>{t("许可", "License")}: {source.attribution.license ?? t("待核实", "unknown")} · {t("使用范围", "Usage")}: {source.attribution.usage}</span>
        <span>{t("来源策略上限", "Source policy limits")}: {source.refreshPolicy.maxRecords} {t("条", "records")} / {source.refreshPolicy.maxPages} {t("页", "pages")} · {source.refreshPolicy.mode}</span>
        {source.attribution.notes && <p>{source.attribution.notes}</p>}
        {!runnable(source) && <p>{t("该来源未启用。可先在下方载入配置，核对后显式保存状态；不会自动启用。", "This source is not active. Load its configuration below, review it and explicitly save its state.")}</p>}
        {runnable(source) && !canEnumerate && <p>{t("当前配置未提供可列举岗位的端点或字段映射，可使用其已配置的来源发现能力。", "This configuration has no usable job-listing endpoint or mapping. Its configured source-discovery tools remain available.")}</p>}
        <button type="button" disabled={Boolean(busy || scanLocked)} onClick={() => editJson(JSON.stringify(source, null, 2))}>{t("载入配置供编辑", "Load configuration for editing")}</button>
      </div>}
      {!catalog.sources.length && !busy && <p>{t("本机索引中暂无来源。可在下方导入 config/sources 中的完整 JSON，或自行配置已安装适配器。", "No sources are registered. Import complete JSON from config/sources below, or configure an installed adapter.")}</p>}
      <div className="atlas-sources-actions"><button type="button" disabled={!usable || !canEnumerate || Boolean(busy || scanLocked)} onClick={() => void operation(t("预览一页", "Preview one page"), async (signal) => {
        const { maxPages: _pages, ...options } = scopeInput(); void _pages;
        const value = await client.preview(sourceId, options, { signal }); signal.throwIfAborted(); setPreview({ sourceId, value });
      })}>{t("预览一页 · 不写入", "Preview one page · no write")}</button>
      </div>
      <AtlasSourceScanControls endpoint={endpoint} token={token} sourceId={sourceId} canEnumerate={Boolean(usable && canEnumerate)} disabled={Boolean(busy) || disabled || aggregateLocked} scopeInput={scopeInput} onSnapshot={onSnapshot} onBusy={setScanBusy} />
      <AtlasAggregateRecoveryControls endpoint={endpoint} token={token} onSnapshot={onSnapshot} onBusy={setAggregateBusy} disabled={Boolean(busy || scanBusy || scanRecovery.pending || scanRecovery.saved || scanRecovery.refreshOnly)} />
      {preview && <div className="atlas-sources-result"><strong>{t("预览结果", "Preview result")} · {preview.sourceId}</strong>
        <p>{t("上游读取", "Upstream fetched")}: {preview.value.page.coverage.fetchedRecords} · {t("返回", "Returned")}: {preview.value.page.records.length} · {t("本地条件匹配", "Local matches")}: {preview.value.localMatchedRecords}</p>
        <p>{t("上游已应用条件", "Remote filters applied")}: {preview.value.page.coverage.appliedFilters.join(", ") || "—"} · {t("上游未应用条件", "Remote filters not applied")}: {preview.value.page.coverage.ignoredFilters.join(", ") || "—"}</p>
        <p>{preview.value.page.coverage.complete ? t("来源报告已完整列举", "Source reports complete enumeration") : t("本次仅覆盖部分记录", "Partial enumeration")} · {preview.value.page.stopReason ?? (preview.value.page.nextCursor ? t("仍有后续页", "More pages available") : "—")}</p>
        <ul>{preview.value.page.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        <ol>{preview.value.page.records.slice(0, 20).map((record, index) => <li key={index}><strong>{record.title}</strong> · {record.companyName ?? t("企业待核实", "Company unknown")} · {record.entityType}
          {record.url && <a href={record.url} target="_blank" rel="noreferrer">{record.url}</a>}</li>)}</ol>
        {preview.value.page.records.length > 20 && <p>{t("面板仅展示前 20 条，匹配数来自完整的这一页。", "Only the first 20 records are shown; match counts cover the entire fetched page.")}</p>}
      </div>}
    </details>

    <details><summary>{t("来源 JSON 配置", "Source JSON configuration")}</summary>
      <p className="atlas-sources-muted">{t("支持单个来源、{source, expectedRevision} 或来源数组。数组须逐项选择保存。JSON 只声明配置，不能安装适配器代码或保存真实密钥；仅支持本机已安装的适配器。", "Accepts one source, {source, expectedRevision}, or an array. Select and save array members individually. JSON contains configuration only; it cannot install adapter code or store actual credentials.")}</p>
      <p className="atlas-sources-muted">{t("已安装适配器", "Installed adapters")}: {catalog.adapters.map((adapter) => `${adapter.adapterId}@${adapter.version} (${adapter.remoteFilters.join(", ") || t("无远程条件", "no remote filters")})`).join(" · ") || "—"}</p>
      <label>{t("完整来源 JSON", "Complete source JSON")}<textarea rows={10} spellCheck={false} value={jsonText} disabled={Boolean(busy || scanLocked)} onChange={(event) => editJson(event.target.value)} /></label>
      <div className="atlas-sources-actions"><button type="button" disabled={!jsonText.trim() || Boolean(busy || scanLocked)} onClick={checkJson}>{t("检查 JSON", "Check JSON")}</button>
        {configs.length > 1 && <label>{t("本次保存项", "Source to save")}<select value={configIndex} disabled={Boolean(busy || scanLocked)} onChange={(event) => { setConfigIndex(Number(event.target.value)); setReviewed(false); }}>
          {configs.map((entry, index) => <option key={index} value={index}>{entry.source.name} · {entry.source.sourceId}</option>)}</select></label>}</div>
      {config && <div className="atlas-sources-result"><strong>{config.source.name}</strong><p>{config.source.sourceId} · {config.source.adapterId}@{config.source.adapterVersion} · {config.source.enabled ? t("将启用", "will be enabled") : t("保持禁用", "will stay disabled")} · {config.source.status}</p>
        <p>{config.source.entryUrl ?? "—"}</p><label className="atlas-sources-check"><input type="checkbox" checked={reviewed} disabled={Boolean(busy || scanLocked)} onChange={(event) => setReviewed(event.target.checked)} />{t("我已核对端点、来源使用范围和启用状态，并确认保存这一项。", "I reviewed the endpoint, usage conditions and enabled state, and confirm saving this source.")}</label>
        <button type="button" disabled={!usable || !reviewed || Boolean(busy || scanLocked)} onClick={() => void operation(t("保存来源", "Save source"), registerConfig)}>{t("保存所选来源", "Save selected source")}</button>
      </div>}
    </details>

    <details><summary>{t("发现更多 GitHub 来源", "Discover more GitHub sources")}</summary>
      <p className="atlas-sources-muted">{t("使用你配置的发现端点策略调用真实 GitHub 仓库搜索。结果只是待核实来源；仓库许可不代表链接的企业岗位正文许可。候选不会自动注册或启用。", "Search actual GitHub repositories through a configured discovery policy. Results remain unverified source candidates. A repository license does not license linked employers’ job content. Candidates are not registered or enabled automatically.")}</p>
      <div className="atlas-sources-grid"><label>{t("已启用的发现策略", "Active discovery policy")}<select value={discoverySourceId} disabled={Boolean(busy || scanLocked)} onChange={(event) => setDiscoverySourceId(event.target.value)}><option value="">{t("选择发现来源", "Select discovery source")}</option>
        {discoverySources.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.name}</option>)}</select></label>
        <label>{t("查询关键词", "Search query")}<input value={query} disabled={Boolean(busy || scanLocked)} onChange={(event) => setQuery(event.target.value)} placeholder="jobs internship location" /></label>
        <label>{t("每页候选 · 1–20", "Candidates per page · 1–20")}<input type="number" min="1" max="20" value={discoveryLimit} disabled={Boolean(busy || scanLocked)} onChange={(event) => setDiscoveryLimit(event.target.value)} /></label></div>
      {!discoverySources.length && <p>{t("尚无已启用的 discover-sources 来源。请先按服务文档配置精确 GitHub API / raw 文件端点策略并显式注册。", "No active discover-sources policy is configured. Follow the local service documentation to configure exact GitHub API and raw-file endpoint policies, then register it explicitly.")}</p>}
      <button type="button" disabled={!usable || !discoverySourceId || !query.trim() || Boolean(busy || scanLocked)} onClick={() => discover()}><Search size={14} />{t("搜索来源候选", "Search source candidates")}</button>
      {discovery && <div className="atlas-sources-result"><strong>{discovery.query}</strong><p>{discovery.page.observedAt} · {t("总匹配", "Total matches")}: {discovery.page.totalAvailable ?? "—"} · {discovery.page.partial ? t("部分结果", "Partial results") : t("当前页", "Current page")}</p>
        <ul>{discovery.page.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        <label>{t("抽样文件 URL · 可选，每次最多一项", "Sample file URL · optional, one per inspection")}<input type="url" value={sampleUrl} disabled={Boolean(busy || scanLocked)} onChange={(event) => setSampleUrl(event.target.value)} placeholder="https://raw.githubusercontent.com/owner/repository/branch/jobs.json" /></label>
        <ol className="atlas-source-candidates">{discovery.page.candidates.map((candidate) => <li key={candidate.candidateId}><strong>{candidate.repository?.fullName ?? candidate.homeUrl}</strong><span className="atlas-sources-badge">{t("待审核候选", "Candidate · needs review")}</span>
          <a href={candidate.homeUrl} target="_blank" rel="noreferrer">{candidate.homeUrl}</a><p>{candidate.repository?.description}</p><span>{t("仓库许可", "Repository license")}: {candidate.repository?.licenseSpdx ?? t("未知 · 待核实", "Unknown · verify")}</span>
          <ul>{candidate.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          <button type="button" disabled={Boolean(busy || scanLocked)} onClick={() => void operation(t("有限检查候选", "Inspect candidate"), async (signal) => {
            const value = await client.inspect(discovery.sourceId, { candidate, maxRecords: 30, ...(sampleUrl.trim() ? { sampleUrls: [sampleUrl.trim()] } : {}) }, { signal });
            signal.throwIfAborted(); setInspection({ candidate, value }); setProposal(undefined);
          })}>{t("有限检查 · 最多 3 文件 / 每份 30 条", "Inspect · up to 3 files / 30 records each")}</button></li>)}</ol>
        {discovery.page.nextCursor && <button type="button" disabled={Boolean(busy || scanLocked)} onClick={() => discover(discovery.page.nextCursor)}>{t("下一页候选", "Next candidate page")}</button>}
      </div>}
      {inspection && <div className="atlas-sources-result"><strong>{t("候选结构检查", "Candidate inspection")}: {inspection.candidate.repository?.fullName ?? inspection.candidate.homeUrl}</strong>
        <ul>{inspection.value.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        {inspection.value.samples.map((sample, index) => <article key={index}><a href={sample.url} target="_blank" rel="noreferrer">{sample.url}</a><p>{sample.format} · {sample.sampledRecords} {t("条抽样", "sample records")} · {sample.truncated ? t("已截断", "truncated") : t("本次样本", "sample")}</p>
          <p>{t("已识别字段", "Detected fields")}: {sample.fields.map((field) => field.path).join(", ") || "—"}</p><ul>{sample.warnings.map((warning, item) => <li key={item}>{warning}</li>)}</ul>
          <button type="button" disabled={Boolean(busy || scanLocked)} onClick={() => void operation(t("生成禁用提案", "Propose disabled source"), async (signal) => {
            const next = await client.propose({ candidate: inspection.candidate, sample, name: inspection.candidate.repository?.fullName ?? "Reviewed source candidate", maxRecords: 100 }, { signal });
            if (next.source.enabled || next.source.status !== "needs-review" || next.candidateId !== inspection.candidate.candidateId) throw new AtlasSourceServiceError("invalid-response", t("服务返回的提案未保持禁用待审核状态。", "The service proposal is not disabled and awaiting review."));
            signal.throwIfAborted(); setProposal(next); editJson(JSON.stringify(next.source, null, 2));
          })}>{t("生成禁用提案 · 不注册", "Propose disabled source · no registration")}</button>
        </article>)}
      </div>}
      {proposal && <div className="atlas-sources-result"><strong>{t("禁用提案已放入 JSON 编辑框", "Disabled proposal placed in JSON editor")}</strong><ul>{proposal.reviewRequired.map((item, index) => <li key={index}>{item}</li>)}</ul>
        <p>{t("展开“来源 JSON 配置”检查并显式保存。当前没有注册，也没有启用。", "Open Source JSON configuration to check and explicitly save it. Nothing has been registered or enabled.")}</p></div>}
    </details>
  </section>;
}
