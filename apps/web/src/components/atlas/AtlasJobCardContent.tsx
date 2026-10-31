import { memo, useMemo } from "react";
import { ArrowUpRight, MapPin, Sparkles } from "lucide-react";
import type { AtlasDataset, JobSearchItem } from "@better-me/opportunities";
import { analyzeAiJobRelevance } from "./ai-job-relevance";
import { formatCardDistance, formatCardPlatform, formatCardPublication, formatCardSalaryRMB } from "./card-badges";
import { AtlasListingBadges } from "./JobSourceBadges";
import type { AtlasListingPresentation } from "./presentation";
import { AtlasWorkingConditions } from "./AtlasWorkingConditions";

export type AtlasJobCardContentProps = {
  item: JobSearchItem;
  presentListing?: (item: JobSearchItem) => AtlasListingPresentation[];
  data?: AtlasDataset | null;
  hasAnchor: boolean;
  keyword: string;
  countryName: (code: string) => string;
};

/** Reading content only. Selection and click/double-click ownership stay in the
 * workspace; control toggles must not reconstruct unchanged card JSX. */
export const AtlasJobCardContent = memo(function AtlasJobCardContent({
  item, presentListing, data, hasAnchor, keyword, countryName,
}: AtlasJobCardContentProps) {
  // Keep these element identities while typing. Only the small AI-match badge
  // depends on the raw keyword; salary, disclosure and address do not.
  const content = useMemo(() => {
    const presentations = presentListing?.(item) ?? [];
    const platformLabel = formatCardPlatform(item);
    const pubBadge = formatCardPublication(item, presentations, data);
    const distanceBadge = formatCardDistance(item, hasAnchor);
    const salaryBadge = formatCardSalaryRMB(item);
    return {
      heading: <>
        <span className="atlas-company-line">
          <i style={{ background: item.color.color }} />
          {item.company.names[0]}
          <ArrowUpRight size={14} />
        </span>
        <strong>{item.job.title.value}</strong>
      </>,
      details: <>
        <span className="atlas-job-meta">
          <MapPin size={12} />
          {item.locations.map(location => location.officeResolution?.formattedAddress ?? location.streetAddress ?? (location.raw.trim() || location.city || location.region || "地点待核实")).join(" / ") || "地点待核实"}
        </span>
        <span className={`atlas-job-salary ${salaryBadge.isNegotiable ? "is-negotiable" : "has-salary"}`} title={salaryBadge.tooltip}>
          {salaryBadge.label}
        </span>
        <div className="atlas-job-card-tags">
          <span className="atlas-job-classification" style={{ borderColor: `${item.color.color}66` }}>
            <i style={{ background: item.color.color }} />
            {item.color.label} {item.color.classification.jurisdictions.map(countryName).join(" / ")}
          </span>
          <span className="atlas-badge-platform" title={`来源平台：${platformLabel}`}>{platformLabel}</span>
          <span className="atlas-badge-publication" title={pubBadge.tooltip}>{pubBadge.label}</span>
          <span className="atlas-badge-distance" title={distanceBadge.tooltip}>{distanceBadge.label}</span>
        </div>
        <AtlasListingBadges presentations={presentations} />
        <span className="atlas-card-hint">{item.locations.some(location => location.kind === "remote-region") ? "远程适用地区，不是办公地址"
          : item.locations.some(location => location.coordinates && ["address", "street", "manual"].includes(location.precision)) ? "已有街道／地址级坐标 · 来源与核对状态见详情"
            : item.locations.some(location => location.streetAddress) ? "已披露街道地址 · 坐标待核实" : "办公地址待补全 · 城市／区域不作为办公点"}</span>
        <AtlasWorkingConditions text={item.job.description} compact />
        {!!item.mapReferences?.length && <span className="atlas-card-hint">城市分布参考 · 城市估算，非办公地址</span>}
        <span className="atlas-card-hint">单击查看详情 · 右侧按钮定位地图</span>
      </>,
    };
  }, [item, presentListing, data, hasAnchor, countryName]);
  const aiRelevance = useMemo(() => analyzeAiJobRelevance(item.job, keyword, item.company.names[0]), [item.job, keyword, item.company.names]);
  return <>
    {content.heading}
    {aiRelevance.isPenetrated && <div className="atlas-ai-penetration-tag" title={aiRelevance.reason}>
      <span className="atlas-ai-badge-pill"><Sparkles size={11} className="atlas-ai-sparkle-icon" />AI 穿透命中</span>
      <span className="atlas-ai-skill-text">{aiRelevance.highlightSkillText}</span>
      {aiRelevance.highlightSnippet && <span className="atlas-ai-evidence-pill" title={aiRelevance.highlightSnippet}>任职要求明确</span>}
    </div>}
    {content.details}
  </>;
});
