import { useState } from "react";
import { ShieldCheck, Share2, PlugZap, LockKeyhole } from "lucide-react";
import type { TrustRequest } from "./CareerTrustPanel.contracts";
import { CareerTrustPublication } from "./CareerTrustPanel.publication";
import { CareerTrustMcp } from "./CareerTrustPanel.mcp";
import { CareerTrustPrivacy } from "./CareerTrustPanel.privacy";
import "./CareerTrustPanel.css";

export type CareerTrustPanelProps = { contextId: string; runtime: { model: string; modelDigest: string }; request: TrustRequest; contextRevision?: number };
export function CareerTrustPanel({ contextId, runtime, request }: CareerTrustPanelProps) {
  const [tab, setTab] = useState<"publication" | "mcp" | "privacy">("publication");
  const scope = `${contextId}:${runtime.model}:${runtime.modelDigest}`;
  const tabs = [{ id: "publication", label: "数字胶囊", Icon: Share2 }, { id: "mcp", label: "MCP 连接", Icon: PlugZap }, { id: "privacy", label: "隐私流水线", Icon: LockKeyhole }] as const;
  return <section className="career-trust-panel" aria-label="公开、连接与隐私控制台"><header className="ctr-heading"><div><span className="ctr-kicker"><ShieldCheck size={15} aria-hidden="true" />可信边界</span><h2>公开、连接与隐私</h2><p>先预览、再明确授权；未知保留未知。所有产物都不会绕过工作区正式采用规则。</p></div></header><div role="tablist" aria-label="信任工作流" className="ctr-tabs">{tabs.map(({ id, label, Icon }, index) => <button key={id} type="button" role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls={`ctr-${id}-panel`} id={`ctr-${id}-tab`} onClick={() => setTab(id)} onKeyDown={event => { const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined; if (next !== undefined) { event.preventDefault(); const value = tabs[next]!.id; setTab(value); document.getElementById(`ctr-${value}-tab`)?.focus(); } }}><Icon size={15} aria-hidden="true" />{label}</button>)}</div><div key={scope} className="ctr-panels"><div id="ctr-publication-panel" role="tabpanel" aria-labelledby="ctr-publication-tab" hidden={tab !== "publication"}><CareerTrustPublication contextId={contextId} request={request} /></div><div id="ctr-mcp-panel" role="tabpanel" aria-labelledby="ctr-mcp-tab" hidden={tab !== "mcp"}><CareerTrustMcp request={request} /></div><div id="ctr-privacy-panel" role="tabpanel" aria-labelledby="ctr-privacy-tab" hidden={tab !== "privacy"}><CareerTrustPrivacy contextId={contextId} runtime={runtime} request={request} /></div></div></section>;
}
