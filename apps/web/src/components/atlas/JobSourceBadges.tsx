/** @jsxRuntime automatic */
import type { CSSProperties } from "react";
import { HttpUrlSchema } from "@better-me/opportunities";
import { useUiPreferences } from "../../lib/ui-preferences";
import { formatAtlasPublication, getAtlasSourceBadge, type AtlasBadgeColors, type AtlasListingPresentation, type AtlasPresentationConfig, type AtlasPublicationBadge } from "./presentation";
import "./job-source-badges.css";

export type SourcePublicationBadgesProps = {
  sourceLabel: string;
  sourceId?: string;
  adapterId?: string;
  platform?: string;
  publishedAt?: string;
  publishedRaw?: string;
  now?: string | number | Date;
  timeZone?: string;
  config?: AtlasPresentationConfig;
  sourceUrl?: string;
  link?: boolean;
  className?: string;
};

// Only finite color values can reach inline styles, including for callers supplying presentations.
function badgeStyle(colors: AtlasBadgeColors): CSSProperties {
  return Object.fromEntries(Object.entries({ color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border })
    .filter(([, color]) => /^#[0-9a-fA-F]{6}$/.test(color)));
}

function publicationLabel(publication: AtlasPublicationBadge, english: boolean): string {
  if (!english) return publication.label;
  if (publication.reason === "conflicting-publication") return "Publication time needs review · conflicting source records";
  if (publication.reason === "invalid-date") return "Publication time needs review · invalid date";
  if (publication.reason === "future") return `Publication time needs review · ${publication.calendarDate ?? ""} (future date)`;
  if (publication.precision === "unknown") return "Publication time unknown";
  if (publication.precision === "raw") return `Publication text: ${publication.raw ?? ""}`;
  const suffix = publication.precision === "date" ? " (date only)" : "";
  if (publication.status === "older") return `Published ${publication.calendarDate}${suffix}`;
  if (publication.label.startsWith("今天")) return `Published today${suffix}`;
  if (publication.label.startsWith("刚刚")) return "Just published (less than 1 hour)";
  const number = /^(\d+)/.exec(publication.label)?.[1];
  if (number) {
    const unit = publication.label.includes("小时") ? "hour" : "day";
    return `Published ${number} ${unit}${number === "1" ? "" : "s"} ago${suffix}`;
  }
  return publication.label;
}

function PublicationBadge({ publication }: { publication: AtlasPublicationBadge }) {
  const { locale, t } = useUiPreferences();
  const label = publicationLabel(publication, locale === "en");
  const details = [label, publication.publishedAt && t(`来源时间：${publication.publishedAt}`, `Source timestamp: ${publication.publishedAt}`),
    publication.raw && t(`来源原文：${publication.raw}`, `Source text: ${publication.raw}`),
    t(`显示时区：${publication.timeZone}`, `Display timezone: ${publication.timeZone}`)].filter(Boolean).join("\n");
  const props = { className: "job-publication-badge", style: badgeStyle(publication.colors), title: details,
    "data-publication-status": publication.status, "data-publication-precision": publication.precision };
  const dateTime = publication.reason === "invalid-date" ? undefined : publication.publishedAt ?? publication.calendarDate;
  return dateTime ? <time {...props} dateTime={dateTime}>{label}</time> : <span {...props}>{label}</span>;
}

function ListingBadges({ presentation, link = false }: { presentation: AtlasListingPresentation; link?: boolean }) {
  const { t } = useUiPreferences();
  const safeUrl = link && HttpUrlSchema.safeParse(presentation.url).success ? presentation.url : undefined;
  const sourceProps = { className: "job-source-badge", style: badgeStyle(presentation.badge),
    "data-source-id": presentation.sourceId, title: t(`岗位来源：${presentation.label}`, `Job source: ${presentation.label}`) };
  return <span className="job-source-publication" data-listing-id={presentation.listingId}>
    {safeUrl ? <a {...sourceProps} href={safeUrl} target="_blank" rel="noopener noreferrer">{presentation.label}</a>
      : <span {...sourceProps}>{presentation.label}</span>}
    <PublicationBadge publication={presentation.publication} />
  </span>;
}

/** A single source's publication disclosure, independent of collection, update and verification times. */
export function SourcePublicationBadges({ sourceLabel, sourceId, adapterId, platform, publishedAt, publishedRaw,
  now, timeZone, config, sourceUrl, link = false, className }: SourcePublicationBadgesProps) {
  const id = sourceId ?? platform ?? sourceLabel;
  return <span className={["job-source-badges", className].filter(Boolean).join(" ")}>
    <ListingBadges link={link} presentation={{ listingId: id, sourceId: id, label: sourceLabel, url: sourceUrl,
      badge: getAtlasSourceBadge({ sourceId: id, adapterId, platform: platform ?? sourceLabel }, config),
      publication: formatAtlasPublication({ publishedAt, publishedRaw }, { now, timeZone, config }) }} />
  </span>;
}

/** Render each listing separately; publication facts must never be borrowed from another source. */
export function AtlasListingBadges({ presentations, link = false, className }: {
  presentations: readonly AtlasListingPresentation[]; link?: boolean; className?: string;
}) {
  return <span className={["job-source-badges", className].filter(Boolean).join(" ")}>
    {presentations.map((presentation) => <ListingBadges key={`${presentation.sourceId}:${presentation.listingId}`} presentation={presentation} link={link} />)}
  </span>;
}
