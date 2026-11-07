import { hasAtlasServiceTarget } from "./backend-connection";
import { useEffect, useRef, useState } from "react";
import type { SourceDefinition } from "@better-me/opportunities";
import type { CompanyCareerDiscoveryCapabilities, CompanyCareerDiscoveryResult } from "@better-me/source-adapters/browser-contracts";
import { createAtlasSourceClient } from "./service-client";

type Props = { endpoint: string; token: string; sources: SourceDefinition[]; onProposal: (text: string) => void; onSelectSource: (id: string, companyName: string) => void };
/** A changed local identity gets a fresh session; its pending reads cannot update the new one. */
export function CompanyCareersPanel(props: Props) {
  return <CompanyCareersSession key={JSON.stringify([props.endpoint, props.token])} {...props} />;
}

/** Discovery only prepares evidence and disabled proposals; the existing review flow owns registration. */
function CompanyCareersSession({ endpoint, token, sources, onProposal, onSelectSource }: Props) {
  const usable = hasAtlasServiceTarget(endpoint, token);
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [result, setResult] = useState<CompanyCareerDiscoveryResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<CompanyCareerDiscoveryCapabilities>();
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [capabilitiesBusy, setCapabilitiesBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const capabilitiesAbort = useRef<AbortController | null>(null);
  const policies = sources.filter(source => source.enabled && source.status === "active" && source.capabilities.includes("discover-sources")
    && source.runtime.includes("local-service") && !source.secretRef);
  const policy = policies.find(entry => entry.sourceId === policyId) ?? policies[0];
  const sourceIdentity = JSON.stringify(sources);
  useEffect(() => {
    abort.current?.abort(); abort.current = null; setBusy(false); setResult(undefined); setError("");
  }, [sourceIdentity]);
  useEffect(() => () => {
    abort.current?.abort(); abort.current = null;
    capabilitiesAbort.current?.abort(); capabilitiesAbort.current = null;
  }, []);

  function invalidate() {
    abort.current?.abort(); abort.current = null; setBusy(false); setResult(undefined); setError("");
  }
  function cancelDiscovery() {
    if (!abort.current) return;
    invalidate(); setError("发现已取消；尚未注册来源。");
  }
  function cancelCapabilities() {
    if (!capabilitiesAbort.current) return;
    capabilitiesAbort.current.abort(); capabilitiesAbort.current = null;
    setCapabilitiesBusy(false); setCapabilitiesError("搜索配置读取已取消，当前配置状态未知。");
  }
  async function readCapabilities() {
    if (!usable || capabilitiesAbort.current) return;
    invalidate(); setCapabilities(undefined); setCapabilitiesError(""); setCapabilitiesBusy(true);
    const controller = new AbortController(); capabilitiesAbort.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const next = await createAtlasSourceClient(endpoint, token).companyDiscoveryCapabilities({ signal: controller.signal });
      controller.signal.throwIfAborted();
      if (capabilitiesAbort.current === controller) setCapabilities(next);
    } catch (failure) {
      if (capabilitiesAbort.current === controller) setCapabilitiesError(controller.signal.aborted ? "搜索配置读取超时，当前配置状态未知。" : failure instanceof Error ? failure.message : "无法读取搜索配置。");
    } finally {
      clearTimeout(timer);
      if (capabilitiesAbort.current === controller) { capabilitiesAbort.current = null; setCapabilitiesBusy(false); }
    }
  }
  async function discover() {
    const hasWebsite = Boolean(website.trim());
    if (abort.current || capabilitiesAbort.current || !usable || !company.trim() || (hasWebsite && !policy)) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setResult(undefined); setError("");
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const next = await createAtlasSourceClient(endpoint, token).discoverCompany(hasWebsite ? policy!.sourceId : undefined, {
        companyName: company.trim(), ...(hasWebsite ? { companyWebsite: website.trim() } : {}), maxPages: 3, limit: 10,
      }, { signal: controller.signal });
      controller.signal.throwIfAborted(); if (abort.current === controller) setResult(next);
    } catch (failure) {
      if (abort.current === controller) setError(controller.signal.aborted ? "发现已取消或超时；尚未注册来源。" : failure instanceof Error ? failure.message : "官网招聘入口发现失败。");
    } finally { clearTimeout(timer); if (abort.current === controller) { abort.current = null; setBusy(false); } }
  }

  return <details className="atlas-company-discovery" aria-busy={busy || capabilitiesBusy} onToggle={(event) => {
    if (event.currentTarget.open) {
      if (!capabilities && !capabilitiesAbort.current) void readCapabilities();
    } else { cancelCapabilities(); cancelDiscovery(); }
  }}><summary>企业官网招聘 · 查找入口与已有来源</summary>
    <p>输入企业名先匹配已登记来源；配置网页搜索后可继续发现陌生企业的招聘入口。填写官网时只读取已授权范围。新入口保留原始证据，核对后才能注册。</p>
    <div aria-label="企业发现搜索配置">
      {capabilitiesBusy ? <p role="status">正在读取网页搜索配置…</p> : capabilities ? capabilities.webSearch.configured
        ? <p role="status">网页搜索已配置：{capabilities.webSearch.label}（{capabilities.webSearch.providerId === "duckduckgo-html" ? "实验 HTML 搜索" : capabilities.webSearch.providerId}）。此状态仅表示本机配置，尚未验证本次网络搜索。</p>
        : <p role="status">网页搜索未配置。仅输入企业名仍可匹配已登记来源；陌生企业需补充官网或配置搜索提供方。</p>
        : <p role="status">网页搜索配置状态未知。</p>}
      {capabilitiesError && <p role="alert" className="atlas-sources-error">网页搜索配置读取失败；当前配置状态未知。{capabilitiesError}</p>}
      <button type="button" aria-label="重新读取网页搜索配置" disabled={capabilitiesBusy || !usable} onClick={() => void readCapabilities()}>{capabilitiesBusy ? "正在读取搜索配置…" : capabilities || capabilitiesError ? "重新读取搜索配置" : "读取搜索配置"}</button>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); void discover(); }} className="atlas-sources-grid">
      <label>企业名称<input aria-label="发现企业名称" value={company} onChange={(event) => { invalidate(); setCompany(event.target.value); }} maxLength={240} required /></label>
      <label>企业官网（可选）<input aria-label="企业官网地址" type="url" value={website} onChange={(event) => { invalidate(); setWebsite(event.target.value); }} placeholder="https://企业官网域名" /></label>
      <label>发现访问范围<select aria-label="官网发现端点策略" disabled={!website.trim() || !policies.length} value={policy?.sourceId ?? ""} onChange={(event) => { invalidate(); setPolicyId(event.target.value); }}><option value="" disabled>选择已启用的官网访问范围</option>{policies.map(entry => <option key={entry.sourceId} value={entry.sourceId}>{entry.name}</option>)}</select></label>
      <button type="submit" disabled={busy || capabilitiesBusy || !usable || !company.trim() || (Boolean(website.trim()) && !policy)}>{busy ? "正在核对招聘入口…" : "查找企业招聘来源"}</button>
      {busy && <button type="button" onClick={cancelDiscovery}>取消官网发现</button>}
    </form>
    {!policies.length && <p>仅输入企业名可直接匹配已登记来源。填写官网时，请先注册并启用本机可用的发现策略，允许对应官网的精确主机与路径。</p>}
    {error && <p role="alert" className="atlas-sources-error">{error}</p>}
    {result && <div aria-label="企业官网发现结果">
      <p role="status">{result.companyName} · {({ "matched-existing": "找到已登记的企业招聘来源", "requires-company-website": "需要补充企业官网或配置网页搜索提供方", "needs-review": "发现招聘入口，等待核对", "no-candidates": "本次有限范围内未找到招聘入口" })[result.status]} · 官网实际读取 {result.visitedUrls.length} 页{result.partial ? " · 覆盖不完整" : ""}。尚未执行岗位搜索或注册新来源。</p>
      {result.search && <p>本次搜索线索 {result.search.resultCount} 条 · 搜索提供方：{result.search.label} · 查询：{result.search.query}。线索数量不代表岗位数量或已核实官网数量。</p>}
      {result.matchedSources.map(entry => <div key={entry.sourceId}><p>{entry.name} · {entry.enabled && entry.status === "active" ? "已启用，可在来源列表获取岗位" : "尚未启用"}{entry.entryUrl && <> · <a href={entry.entryUrl} target="_blank" rel="noreferrer">查看原始招聘来源</a></>}</p>{entry.enabled && entry.status === "active" && sources.find(source => source.sourceId === entry.sourceId)?.capabilities.includes("list-jobs") && <button type="button" onClick={() => onSelectSource(entry.sourceId, result.companyName)}>使用此企业来源</button>}</div>)}
      {Boolean(result.candidates.length || result.proposals.length) && <p>候选的企业归属仍待核实。提案保持禁用；检查配置不会注册、启用来源或采集岗位。</p>}
      {result.candidates.map(entry => <div key={entry.candidate.candidateId}><a href={entry.candidate.homeUrl} target="_blank" rel="noreferrer">{entry.candidate.homeUrl}</a><p>{entry.entryKind === "html" ? "网页入口，仍需确认岗位读取方式" : entry.entryKind} · 企业归属待核实</p>{entry.evidence.map((evidence, index) => <p key={index}>证据：<a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.sourceUrl}</a>{evidence.quote && <> · {evidence.quote}</>}</p>)}</div>)}
      {result.proposals.map(proposal => <button key={proposal.candidateId} type="button" onClick={() => onProposal(JSON.stringify(proposal.source, null, 2))}>检查 {proposal.source.name} 禁用配置</button>)}
      {result.warnings.map((warning, index) => <p key={index} className="atlas-sources-muted">{warning}</p>)}
    </div>}
  </details>;
}
