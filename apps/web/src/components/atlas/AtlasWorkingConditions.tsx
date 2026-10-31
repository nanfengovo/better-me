import { useMemo } from "react";
import { extractWorkingConditions } from "./job-working-conditions";

export function AtlasWorkingConditions({ text, sourceUrl, observedAt, excerpt = false, compact = false }: {
  text: string; sourceUrl?: string; observedAt?: string; excerpt?: boolean; compact?: boolean;
}) {
  const claims = useMemo(() => extractWorkingConditions(text, { sourceUrl, observedAt, origin: excerpt ? "card-excerpt" : "job-text" }), [text, sourceUrl, observedAt, excerpt]);
  const conflicting = claims.some(claim => claims.some(other => claim.kind === other.kind && claim.value !== other.value));
  const label = claims.length ? `${claims.map(claim => claim.value).join(" · ")} · ${excerpt ? "卡片" : "岗位文本"}声明${conflicting ? " · 存在不同说法" : ""}` : "工作制度待披露";
  // Index cards are buttons: evidence disclosure belongs in the reading pane,
  // not an interactive details/link nested inside another interactive element.
  if (compact) return <span className="atlas-card-hint">{label}</span>;
  return <details className="atlas-working-conditions atlas-live-card-details">
    <summary>{label}</summary>
    <p>{excerpt ? "仅依据本轮卡片摘录，不是完整JD。" : "仅依据当前岗位文本，不代表劳动合同或实际执行情况。"}双休、工时、加班和远程分别核对；远程不代表任何地区都可受雇。社区955／996名单不会自动覆盖本岗位。</p>
    {claims.map(claim => <p key={`${claim.kind}:${claim.value}`}><strong>{claim.value}</strong> · 原句：{claim.quote}</p>)}
    {!claims.length && <p>未提取到明确声明；未知不等于996，也不等于双休八小时。</p>}
    {observedAt && <small>记录时间：{observedAt}（非制度生效或岗位发布时间）</small>}
    {sourceUrl && <p><a href={sourceUrl} target="_blank" rel="noreferrer">核对岗位来源</a></p>}
  </details>;
}
