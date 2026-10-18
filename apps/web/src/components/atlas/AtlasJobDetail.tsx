/** @jsxRuntime automatic */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowUpRight, BookmarkPlus, Building2, FileSearch, MapPin, Navigation, X } from "lucide-react";
import { HttpUrlSchema, type AtlasDataset, type JobLocation, type JobSearchItem } from "@better-me/opportunities";
import { useUiPreferences, type UiTranslator } from "../../lib/ui-preferences";
import { AtlasListingBadges } from "./JobSourceBadges";
import type { AtlasListingPresentation } from "./presentation";
import { validMapFocus } from "./map-focus";
import "./AtlasJobDetail.css";

export type AtlasJobDetailProps = {
  item: JobSearchItem;
  data: AtlasDataset;
  demo: boolean;
  originalCurrency: boolean;
  presentations: readonly AtlasListingPresentation[];
  onClose: () => void;
  onLocate: (locationId?: string) => void;
  onSave: () => void;
  onAnalyze: () => void;
  /** Root owns city-candidate requests, their selection and their status. */
  children?: ReactNode;
};

function annual(value: NonNullable<JobSearchItem["salary"]>["originalAnnual"], t: UiTranslator, locale: string) {
  if (!value) return t("薪资待核实", "Salary not disclosed or comparable");
  const format = (amount?: number) => amount === undefined ? "?" : value.currency === "CNY"
    ? (amount / 10000).toFixed(1) : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount);
  const range = value.min !== undefined && value.min === value.max ? format(value.min) : `${format(value.min)}–${format(value.max)}`;
  return `${value.currency} ${range}${value.currency === "CNY" ? t(" 万", " × 10,000") : ""}${t(" / 年", " / year")}`;
}

function usableCoordinates(location: JobLocation) {
  return location.kind !== "remote-region" && location.precision !== "unknown" && location.coordinates?.coordinateSystem === "WGS84"
    && validMapFocus(location.coordinates) ? location.coordinates : undefined;
}

function locationPrecision(location: JobLocation, t: UiTranslator) {
  if (location.kind === "remote-region") return t("远程资格范围 · 非办公地点", "Remote eligibility region · not an office");
  if (!usableCoordinates(location)) return t("位置原文 · 尚未解析坐标", "Source location text · coordinates not resolved");
  const label = {
    country: t("国家级概略位置", "Country-level overview"), region: t("地区级概略位置", "Regional overview"),
    city: t("城市级估算 · 非办公地址", "Estimated city point · not an office address"),
    street: t("街道级估算 · 非精确办公地址", "Estimated street point · not an exact office address"),
    address: t("地址级坐标", "Address-level coordinates"), manual: t("手动设置位置", "Manually set location"),
    unknown: t("位置精度未说明", "Location precision unknown"),
  }[location.precision];
  return location.verification === "verified" ? label : `${label} · ${location.verification === "conflicting"
    ? t("来源有冲突", "conflicting sources") : t("待核实", "unverified")}`;
}

/** Presentation URLs must still belong to this job's listing and pass the shared URL contract. */
function sourcesForDetail(item: JobSearchItem, data: AtlasDataset, presentations: readonly AtlasListingPresentation[]) {
  return presentations.filter((presentation) => item.job.listingIds.includes(presentation.listingId)
    && item.sources.some((source) => source.listingId === presentation.listingId && source.sourceId === presentation.sourceId))
    .map((presentation) => {
      const listing = data.listings.find((entry) => entry.id === presentation.listingId && entry.sourceId === presentation.sourceId
        && (!entry.canonicalJobId || entry.canonicalJobId === item.job.id));
      const safe = listing?.canonicalUrl === presentation.url && HttpUrlSchema.safeParse(presentation.url).success;
      return { ...presentation, url: safe ? presentation.url : undefined };
    });
}

/** A non-modal reading pane. It never moves focus, locks the page or intercepts card clicks. */
export function AtlasJobDetail({ item, data, demo, originalCurrency, presentations, onClose, onLocate, onSave, onAnalyze, children }: AtlasJobDetailProps) {
  const { t, locale } = useUiPreferences();
  const titleId = useId();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [item.job.id]);
  const sources = sourcesForDetail(item, data, presentations);
  const snapshot = item.job.selectedSnapshotId ? data.snapshots.find((entry) => entry.id === item.job.selectedSnapshotId
    && entry.text === item.job.description && item.job.listingIds.includes(entry.listingId)) : undefined;
  const read = snapshot ? data.observations.find((entry) => entry.id === snapshot.observationId && entry.listingId === snapshot.listingId
    && (entry.result === "read" || entry.result === "partial") && (!entry.snapshotId || entry.snapshotId === snapshot.id)) : undefined;
  const primary = sources.find((entry) => entry.url && entry.listingId === snapshot?.listingId) ?? sources.find((entry) => entry.url);
  const completeness = snapshot && read ? snapshot.completeness === "lead" || read.completeness === "lead" ? "lead"
    : snapshot.completeness === "excerpt" || read.completeness === "excerpt" ? "excerpt" : "detail" : "unknown";
  const hasDescription = Boolean(item.job.description.trim());
  const salary = originalCurrency ? item.salary?.originalAnnual : item.salary?.cnyAnnual;
  const rawPay = data.compensations.filter((entry) => item.job.compensationIds.includes(entry.id)).map((entry) => entry.raw).filter(Boolean);
  if (item.salary?.raw && !rawPay.includes(item.salary.raw)) rawPay.unshift(item.salary.raw);
  const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames([locale], { type: "region" }) : undefined;
  const origins = item.color.classification.jurisdictions.map((code) => regionNames?.of(code) ?? code).join(" / ");
  const updated = Date.parse(item.job.updatedAt);
  const updatedLabel = Number.isFinite(updated) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(updated) : t("未披露", "Unknown");
  const status = item.job.status === "open" ? t("在招", "Open") : item.job.status === "closed" ? t("已关闭", "Closed") : t("待核验", "Unverified");

  return <aside id="atlas-job-detail" className="atlas-job-detail" aria-label={t("地图岗位详情", "Map job details")} aria-describedby={titleId} data-job-id={item.job.id}>
    <header className="atlas-job-detail-header">
      <div className="atlas-job-detail-eyebrow">{demo ? "SYNTHETIC DEMO / 非真实招聘" : "THE OPPORTUNITY / 岗位详情"}</div>
      <button type="button" className="atlas-job-detail-close" aria-label={t("关闭岗位详情", "Close job details")} title={t("关闭 · Esc", "Close · Esc")} onClick={onClose}><X size={19} /></button>
      <h2 id={titleId} title={item.job.title.value}>{item.job.title.value}</h2>
      <p className="atlas-job-detail-company"><Building2 size={14} /><span>{item.company.names[0]}</span></p>
    </header>

    <div ref={body} className="atlas-job-detail-body">
      <section className="atlas-job-detail-section atlas-job-detail-opening" aria-label={t("薪资与岗位原文", "Salary and original posting")}>
        <div className="atlas-job-detail-salary">{annual(salary, t, locale)}</div>
        {salary && <p className="atlas-job-detail-caption">{originalCurrency ? t("原币 · 税前固定年薪", "Original currency · annual gross base pay") : t("统一口径 · 人民币税前固定年薪", "Comparable annual gross base pay in CNY")}{item.salary?.estimated && t(" · 含估算", " · estimated")}</p>}
        {rawPay.length > 0 && <div className="atlas-job-detail-raw-pay">{rawPay.map((raw, index) => <p key={`${index}:${raw}`}>{raw}</p>)}</div>}
        {item.salarySelection === "ambiguous" && <p className="atlas-job-detail-caption">{t("多地或多种薪资披露，当前没有单一可比较金额。", "Multiple pay disclosures have no single comparable amount.")}</p>}
        {item.salary?.fx && <p className="atlas-job-detail-caption">{t("汇率", "Exchange rate")}：{item.salary.fx.provider} / {item.salary.fx.date}</p>}
        {!demo && primary?.url ? <a className="atlas-job-detail-original" href={primary.url} target="_blank" rel="noopener noreferrer">{t("打开岗位原文", "Open original job posting")}<ArrowUpRight size={17} /><small>{primary.label} · {new URL(primary.url).hostname}</small></a>
          : <p className="atlas-job-detail-source-missing">{demo ? t("演示内容没有真实招聘原文。", "Synthetic demo has no real job posting.") : t("当前来源尚未提供可核对的岗位原文链接。", "No verifiable original job link is available.")}</p>}
        <div className="atlas-job-detail-sources"><AtlasListingBadges presentations={sources} link={!demo} /></div>
      </section>

      <section className="atlas-job-detail-section" aria-label={t("岗位信息", "Job facts")}>
        <dl className="atlas-job-detail-facts">
          <div><dt>{t("控股来源", "Controller origin")}</dt><dd>{item.color.label}{origins && ` · ${origins}`}</dd></div>
          <div><dt>{t("在招状态", "Availability")}</dt><dd>{status}</dd></div>
          <div><dt>{t("工作方式", "Work mode")}</dt><dd>{{ "on-site": t("现场办公", "On-site"), hybrid: t("混合办公", "Hybrid"), remote: t("远程", "Remote"), unknown: t("未披露", "Not disclosed") }[item.job.workMode]}</dd></div>
          <div><dt title={t("记录更新不等于岗位发布时间", "Record update is not the publication date")}>{t("记录更新", "Record updated")}</dt><dd>{updatedLabel}</dd></div>
        </dl>
      </section>

      <section className="atlas-job-detail-section atlas-job-detail-locations" aria-label={t("工作地点", "Work locations")}>
        <h3><MapPin size={15} />{t("工作地点", "Work locations")}</h3>
        {item.locations.map((location) => {
          const coordinates = usableCoordinates(location);
          const query = coordinates ? `${coordinates.latitude},${coordinates.longitude}` : location.raw.trim();
          return <article className="atlas-job-detail-location" key={location.id}>
            <strong>{location.raw}</strong><small>{locationPrecision(location, t)}</small>
            <div className="atlas-job-detail-location-actions">{location.kind !== "remote-region" && <button type="button" onClick={() => onLocate(location.id)}><Navigation size={12} />{coordinates ? t("地图定位", "Locate on map") : t("查找城市位置", "Find city location")}</button>}
              {query && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`} target="_blank" rel="noopener noreferrer">Google {t("地图", "Maps")}<ArrowUpRight size={12} /></a>}
            </div>
          </article>;
        })}
        {!item.locations.length && <div className="atlas-job-detail-location"><p>{t("来源尚未提供结构化工作地点。", "The source has not provided a structured work location.")}</p><button type="button" onClick={() => onLocate()}><Navigation size={12} />{t("查找岗位位置", "Find job location")}</button></div>}
        {children}
      </section>

      <section className="atlas-job-detail-section atlas-job-detail-description" aria-label={t("岗位职责与要求", "Responsibilities and requirements")}>
        <div className="atlas-job-detail-section-heading"><h3>{t("岗位职责与要求", "Responsibilities & requirements")}</h3><span>{completeness === "detail" ? t("来源正文", "Source detail") : completeness === "excerpt" || completeness === "lead" ? t("来源摘录", "Source excerpt") : t("完整性未核实", "Completeness unknown")}</span></div>
        {hasDescription && completeness !== "detail" && <p className="atlas-job-detail-excerpt" role="note">{completeness === "excerpt" || completeness === "lead" ? t("当前正文为来源摘录，可能缺少任职要求；请打开岗位原文核对后再分析简历。", "This is a source excerpt and may omit requirements. Check the original posting before analyzing your resume.") : t("当前正文完整性尚未核实，请在岗位原文中核对职责与要求。", "Completeness has not been verified. Check responsibilities and requirements in the original posting.")}</p>}
        <div className="atlas-job-detail-copy">{hasDescription ? item.job.description : t("当前来源未提供岗位正文。", "The source has not provided a job description.")}</div>
      </section>
    </div>

    <footer className="atlas-job-detail-footer">
      <button type="button" className="atlas-job-detail-save" disabled={demo} onClick={onSave}><BookmarkPlus size={15} />{t("收藏到机会与投递", "Save to opportunities")}</button>
      <button type="button" className="atlas-job-detail-analyze" disabled={demo || !hasDescription} onClick={onAnalyze}><FileSearch size={15} />{t("用这份 JD 分析简历", "Analyze resume with this JD")}</button>
      {demo && <p>{t("演示内容仅供查看，连接真实索引后可进入求职流程。", "Demo content is read-only. Connect a real index to use career actions.")}</p>}
    </footer>
  </aside>;
}

export default AtlasJobDetail;
