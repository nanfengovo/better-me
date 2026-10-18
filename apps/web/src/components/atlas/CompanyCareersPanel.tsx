import { useEffect, useRef, useState } from "react";
import type { SourceDefinition } from "@better-me/opportunities";
import type { CompanyCareerDiscoveryResult } from "@better-me/source-adapters/browser-contracts";
import { createAtlasSourceClient } from "./service-client";

type Props = { endpoint: string; token: string; sources: SourceDefinition[]; onProposal: (text: string) => void; onSelectSource: (id: string, companyName: string) => void };
/** Discovery only prepares evidence and disabled proposals; the existing review flow owns registration. */
export function CompanyCareersPanel({ endpoint, token, sources, onProposal, onSelectSource }: Props) {
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [result, setResult] = useState<CompanyCareerDiscoveryResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const policies = sources.filter((source) => source.enabled && source.status === "active" && source.capabilities.includes("discover-sources"));
  const policy = policies.find((entry) => entry.sourceId === policyId) ?? policies[0];
  useEffect(() => { setResult(undefined); setError(""); setBusy(false); return () => { abort.current?.abort(); abort.current = null; }; }, [endpoint, token]);
  function invalidate() { abort.current?.abort(); abort.current = null; setBusy(false); setResult(undefined); setError(""); }
  async function discover() {
    if (!policy || abort.current) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setResult(undefined); setError("");
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const next = await createAtlasSourceClient(endpoint, token).discoverCompany(policy.sourceId, {
        companyName: company.trim(), ...(website.trim() ? { companyWebsite: website.trim() } : {}), maxPages: 3, limit: 10,
      }, { signal: controller.signal });
      controller.signal.throwIfAborted(); if (abort.current === controller) setResult(next);
    } catch (failure) {
      if (abort.current === controller) setError(controller.signal.aborted ? "发现已取消或超时；尚未注册来源。" : failure instanceof Error ? failure.message : "官网招聘入口发现失败。");
    } finally { clearTimeout(timer); if (abort.current === controller) { abort.current = null; setBusy(false); } }
  }
  return <details className="atlas-company-discovery"><summary>企业官网招聘 · 查找入口与已有来源</summary>
    <p>先匹配已登记企业，再按所选发现策略读取官网招聘链接。新入口保留原始证据，核对后才能注册；当前服务未配置网页搜索提供方时，陌生企业需要补充官网地址。</p>
    <form onSubmit={(event) => { event.preventDefault(); void discover(); }} className="atlas-sources-grid">
      <label>企业名称<input aria-label="发现企业名称" value={company} onChange={(event) => { invalidate(); setCompany(event.target.value); }} maxLength={240} required /></label>
      <label>企业官网（可选）<input aria-label="企业官网地址" type="url" value={website} onChange={(event) => { invalidate(); setWebsite(event.target.value); }} placeholder="https://企业官网域名" /></label>
      <label>发现访问范围<select aria-label="官网发现端点策略" value={policy?.sourceId ?? ""} onChange={(event) => { invalidate(); setPolicyId(event.target.value); }}>{policies.map((entry) => <option key={entry.sourceId} value={entry.sourceId}>{entry.name}</option>)}</select></label>
      <button type="submit" disabled={busy || !token.trim() || !policy || !company.trim()}>{busy ? "正在核对招聘入口…" : "查找企业招聘来源"}</button>
      {busy && <button type="button" onClick={() => abort.current?.abort()}>取消官网发现</button>}
    </form>
    {!policies.length && <p>请先注册启用 discover-sources 来源，并允许所需官网的精确主机与路径。</p>}
    {error && <p role="alert" className="atlas-sources-error">{error}</p>}
    {result && <div aria-label="企业官网发现结果">
      <p role="status">{result.companyName} · {({ "matched-existing": "找到已登记的企业招聘来源", "requires-company-website": "需要补充企业官网或配置网页搜索提供方", "needs-review": "发现招聘入口，等待核对", "no-candidates": "本次允许范围内未找到招聘入口" })[result.status]} · 已读 {result.visitedUrls.length} 页{result.partial ? " · 覆盖不完整" : ""}。尚未执行岗位搜索或注册新来源。</p>
      {result.matchedSources.map((entry) => <div key={entry.sourceId}><p>{entry.name} · {entry.enabled && entry.status === "active" ? "已启用，可在来源列表获取岗位" : "尚未启用"}{entry.entryUrl && <> · <a href={entry.entryUrl} target="_blank" rel="noreferrer">查看原始招聘来源</a></>}</p>{entry.enabled && entry.status === "active" && sources.find((source) => source.sourceId === entry.sourceId)?.capabilities.includes("list-jobs") && <button type="button" onClick={() => onSelectSource(entry.sourceId, result.companyName)}>使用此企业来源</button>}</div>)}
      {result.candidates.map((entry) => <div key={entry.candidate.candidateId}><a href={entry.candidate.homeUrl} target="_blank" rel="noreferrer">{entry.candidate.homeUrl}</a><p>{entry.entryKind} · 企业归属待核实</p>{entry.evidence.map((evidence, index) => <p key={index}>证据：<a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.sourceUrl}</a>{evidence.quote && <> · {evidence.quote}</>}</p>)}</div>)}
      {result.proposals.map((proposal) => <button key={proposal.candidateId} type="button" onClick={() => onProposal(JSON.stringify(proposal.source, null, 2))}>检查 {proposal.source.name} 禁用配置</button>)}
      {result.warnings.map((warning, index) => <p key={index} className="atlas-sources-muted">{warning}</p>)}
    </div>}
  </details>;
}
