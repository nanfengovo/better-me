import { memo, useMemo } from "react";
import { ArrowUpRight, MapPin, Sparkles } from "lucide-react";
import type { AtlasDataset, JobSearchItem } from "@better-me/opportunities";
import { analyzeAiJobRelevance } from "./ai-job-relevance";
import { formatCardDistance, formatCardPlatform, formatCardPublication, formatCardSalaryRMB } from "./card-badges";
import { useUiPreferences } from "../../lib/ui-preferences";
import { AtlasListingBadges } from "./JobSourceBadges";
import type { AtlasListingPresentation } from "./presentation";

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
  item, presentListing, data, hasAnchor, keyword,
}: AtlasJobCardContentProps) {
  const { t } = useUiPreferences();
  // Keep these element identities while typing. Only the small keyword-rule badge
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
          {item.locations.map(location => location.officeResolution?.formattedAddress ?? location.streetAddress ?? (location.raw.trim() || location.city || location.region || t("地点待核实", "Location unverified"))).join(" / ") || t("地点待核实", "Location unverified")}
        </span>
        <span className={`atlas-job-salary ${salaryBadge.isNegotiable ? "is-negotiable" : "has-salary"}`} title={salaryBadge.tooltip}>
          {salaryBadge.label}
        </span>
        <div className="atlas-job-card-tags">
          {presentations.length ? <AtlasListingBadges presentations={presentations.slice(0, 1)} /> : <>
            <span className="atlas-badge-platform">{platformLabel}</span>
            <span className="atlas-badge-publication" title={pubBadge.tooltip}>{pubBadge.label}</span>
          </>}
          {presentations.length > 1 && <span>{t(`另 ${presentations.length - 1} 个来源见详情`, `${presentations.length - 1} more sources in details`)}</span>}
          {hasAnchor && <span className="atlas-badge-distance" title={distanceBadge.tooltip}>{distanceBadge.label}</span>}
        </div>
        <span className="atlas-card-hint">{item.locations.some(location => location.kind === "remote-region")
          ? t("远程适用范围，非办公地址；来源核验见详情", "Remote eligibility, not an office; source verification in details")
          : t("位置可能为城市估算，非已核验办公点；来源、精度及风险见详情", "Location may be a city estimate, not a verified office. See details for sources, precision and risks.")}</span>
      </>,
    };
  }, [item, presentListing, data, hasAnchor, t]);
  const aiRelevance = useMemo(() => analyzeAiJobRelevance(item.job, keyword, item.company.names[0]), [item.job, keyword, item.company.names]);
  return <>
    {content.heading}
    {aiRelevance.isPenetrated && <div className="atlas-ai-penetration-tag" title={aiRelevance.reason}>
      <span className="atlas-ai-badge-pill"><Sparkles size={11} className="atlas-ai-sparkle-icon" />{t("关键词规则命中", "Keyword rule match")}</span>
      <span className="atlas-ai-skill-text">{aiRelevance.extractedTechStack.join(" · ")}</span>
      {aiRelevance.highlightSnippet && <span className="atlas-ai-evidence-pill" title={aiRelevance.highlightSnippet}>{t("原文片段见详情", "Source excerpt in details")}</span>}
    </div>}
    {content.details}
  </>;
});
