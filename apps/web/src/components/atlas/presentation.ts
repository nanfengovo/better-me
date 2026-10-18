import { TimestampSchema, type AtlasDataset, type JobSearchItem } from "@better-me/opportunities";
import catalog from "./presentation.json";

export type AtlasBadgeColors = { foreground: string; background: string; border: string };
export type AtlasPublicationStatus = "fresh" | "recent" | "older" | "unknown" | "review";
export type AtlasPresentationConfig = {
  schemaVersion: 1; timeZone: string;
  sourceRules: Array<{ id: string; sourceIds?: string[]; adapterIds?: string[]; platforms?: string[]; colors: AtlasBadgeColors }>;
  sourcePalette: AtlasBadgeColors[];
  publicationColors: Record<AtlasPublicationStatus, AtlasBadgeColors>;
};
const statuses: AtlasPublicationStatus[] = ["fresh", "recent", "older", "unknown", "review"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
function colors(value: unknown): value is AtlasBadgeColors {
  return object(value) && Object.keys(value).length === 3 && keys(value, ["foreground", "background", "border"])
    && Object.values(value).every((color) => typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color));
}
function validZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}
const normalized = (value: string) => value.normalize("NFKC").trim().toLowerCase();
/** Configuration accepts finite identifiers and hex colors, never declarations or job-supplied CSS. */
export function parseAtlasPresentationConfig(value: unknown): AtlasPresentationConfig {
  if (!object(value) || !keys(value, ["schemaVersion", "timeZone", "sourceRules", "sourcePalette", "publicationColors"])
    || value.schemaVersion !== 1 || !validZone(value.timeZone) || !Array.isArray(value.sourceRules) || value.sourceRules.length > 200
    || !Array.isArray(value.sourcePalette) || !value.sourcePalette.length || value.sourcePalette.length > 100 || !value.sourcePalette.every(colors)
    || !object(value.publicationColors) || Object.keys(value.publicationColors).length !== statuses.length
    || !statuses.every((status) => colors((value.publicationColors as Record<string, unknown>)[status]))) throw new Error("Invalid atlas presentation configuration.");
  const ids = new Set<string>();
  for (const rule of value.sourceRules) {
    if (!object(rule) || !keys(rule, ["id", "sourceIds", "adapterIds", "platforms", "colors"])
      || typeof rule.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(rule.id) || ids.has(rule.id) || !colors(rule.colors)
      || !["sourceIds", "adapterIds", "platforms"].some((key) => Array.isArray(rule[key]) && rule[key].length > 0)
      || ["sourceIds", "adapterIds", "platforms"].some((key) => rule[key] !== undefined && (!Array.isArray(rule[key]) || rule[key].length > 300
        || !rule[key].every((entry: unknown) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 240)))) throw new Error("Invalid atlas source-color rule.");
    ids.add(rule.id);
  }
  return structuredClone(value) as AtlasPresentationConfig;
}
const defaults = parseAtlasPresentationConfig(catalog);
export const getDefaultAtlasPresentationConfig = (): AtlasPresentationConfig => structuredClone(defaults);

export type AtlasSourceBadge = AtlasBadgeColors & { id: string; matchedBy: "sourceId" | "adapterId" | "platform" | "fallback" };
export function getAtlasSourceBadge(input: { sourceId: string; adapterId?: string; platform?: string }, config?: AtlasPresentationConfig): AtlasSourceBadge {
  const active = config ? parseAtlasPresentationConfig(config) : defaults;
  for (const [field, match] of [["sourceId", "sourceIds"], ["adapterId", "adapterIds"], ["platform", "platforms"]] as const) {
    const value = input[field];
    if (!value) continue;
    const rule = active.sourceRules.find((entry) => entry[match]?.some((candidate) => normalized(candidate) === normalized(value)));
    if (rule) return { ...rule.colors, id: rule.id, matchedBy: field };
  }
  let hash = 2166136261;
  for (const char of normalized(input.sourceId)) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  const index = hash % active.sourcePalette.length;
  return { ...active.sourcePalette[index]!, id: `source-palette-${index}`, matchedBy: "fallback" };
}

export type AtlasPublicationBadge = {
  label: string; status: AtlasPublicationStatus; precision: "instant" | "date" | "raw" | "unknown";
  colors: AtlasBadgeColors; timeZone: string; raw?: string; publishedAt?: string; calendarDate?: string;
  reason?: "future" | "invalid-date" | "unresolved-raw" | "not-disclosed" | "conflicting-publication";
  observationId?: string;
};
export type AtlasPublicationOptions = { now?: string | number | Date; timeZone?: string; config?: AtlasPresentationConfig };
type Calendar = { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number };
function calendar(at: number, timeZone: string): Calendar {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const number = (key: string) => Number(parts.find((part) => part.type === key)!.value);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute"), second: number("second"), millisecond: ((at % 1000) + 1000) % 1000 };
}
function monthDays(year: number, month: number): number {
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}
const dateLabel = (value: Pick<Calendar, "year" | "month" | "day">) => `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
const calendarKey = (value: Calendar) => `${dateLabel(value)}T${[value.hour, value.minute, value.second].map((part) => String(part).padStart(2, "0")).join(":")}.${String(value.millisecond).padStart(3, "0")}`;
function monthAfter(value: Calendar): Calendar {
  const year = value.year + (value.month === 12 ? 1 : 0), month = value.month === 12 ? 1 : value.month + 1;
  return { ...value, year, month, day: Math.min(value.day, monthDays(year, month)) };
}
function disclosedDate(raw: string): Calendar | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return undefined;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) return undefined;
  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}
function ordinal(value: Calendar): number {
  const date = new Date(0); date.setUTCFullYear(value.year, value.month - 1, value.day); date.setUTCHours(0, 0, 0, 0); return date.getTime() / 86_400_000;
}

/** Month threshold uses the displayed timezone's calendar, clamps month ends, and includes the anniversary.
 * Exact instants use elapsed hours/days; date-only disclosures use calendar days without inventing midnight.
 * Relative or timezone-free source text stays raw. Observation/update times are intentionally not inputs. */
export function formatAtlasPublication(input: { publishedAt?: string; publishedRaw?: string }, options: AtlasPublicationOptions = {}): AtlasPublicationBadge {
  const config = options.config ? parseAtlasPresentationConfig(options.config) : defaults;
  const timeZone = options.timeZone ?? config.timeZone;
  if (!validZone(timeZone)) throw new Error("Invalid publication display timezone.");
  if (typeof options.now === "string" && !TimestampSchema.safeParse(options.now).success) throw new Error("Publication reference strings require an explicit timezone.");
  const now = options.now === undefined ? Date.now() : options.now instanceof Date ? options.now.getTime() : typeof options.now === "number" ? options.now : Date.parse(options.now);
  if (!Number.isFinite(now)) throw new Error("Invalid publication reference time.");
  const raw = input.publishedRaw?.trim() || undefined;
  const base = { timeZone, ...(raw ? { raw } : {}) };
  const badge = (status: AtlasPublicationStatus, precision: AtlasPublicationBadge["precision"], label: string, extra: Partial<AtlasPublicationBadge> = {}): AtlasPublicationBadge => ({ ...base, status, precision, label, colors: { ...config.publicationColors[status] }, ...extra });
  const today = calendar(now, timeZone);
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = disclosedDate(raw);
    if (!date) return badge("review", "date", "发布时间待核对 · 日期无效", { reason: "invalid-date" });
    const extra = { calendarDate: raw };
    if (dateLabel(date) > dateLabel(today)) return badge("review", "date", `发布时间待核对 · ${raw}（未来日期）`, { ...extra, reason: "future" });
    if (dateLabel(today) >= dateLabel(monthAfter(date))) return badge("older", "date", `${raw} 发布（仅日期）`, extra);
    const days = ordinal(today) - ordinal(date);
    return badge(days === 0 ? "fresh" : "recent", "date", days === 0 ? "今天发布（仅日期）" : `${days} 天前发布（仅日期）`, extra);
  }
  const publishedAt = input.publishedAt ?? (raw && TimestampSchema.safeParse(raw).success ? raw : undefined);
  if (!publishedAt) return badge("unknown", raw ? "raw" : "unknown", raw ? `发布时间原文：${raw}` : "发布时间未知", { reason: raw ? "unresolved-raw" : "not-disclosed" });
  const at = Date.parse(publishedAt);
  if (!TimestampSchema.safeParse(publishedAt).success || !Number.isFinite(at)) return badge("review", "instant", "发布时间待核对 · 时间无效", { reason: "invalid-date" });
  const published = calendar(at, timeZone);
  const extra = { publishedAt, calendarDate: dateLabel(published) };
  if (at > now) return badge("review", "instant", `发布时间待核对 · ${dateLabel(published)}（未来时间）`, { ...extra, reason: "future" });
  if (calendarKey(today) >= calendarKey(monthAfter(published))) return badge("older", "instant", `${dateLabel(published)} 发布`, extra);
  const hours = Math.floor((now - at) / 3_600_000);
  if (hours < 1) return badge("fresh", "instant", "刚刚发布（不足 1 小时）", extra);
  if (hours < 24) return badge("fresh", "instant", `${hours} 小时前发布`, extra);
  return badge("recent", "instant", `${Math.floor(hours / 24)} 天前发布`, extra);
}

export type AtlasListingPresentation = { listingId: string; sourceId: string; label: string; url?: string; badge: AtlasSourceBadge; publication: AtlasPublicationBadge };
/** Each listing owns its publication history. Failed reads never replace source publication metadata. */
export function buildAtlasListingPresentations(data: AtlasDataset, item: JobSearchItem, options: AtlasPublicationOptions = {}): AtlasListingPresentation[] {
  return createAtlasListingPresenter(data, options)(item);
}
/** Build indexes once for one immutable dataset snapshot; suitable for a memoized results-list presenter. */
export function createAtlasListingPresenter(data: AtlasDataset, options: AtlasPublicationOptions = {}): (item: JobSearchItem) => AtlasListingPresentation[] {
  const sources = new Map(data.sources.map((source) => [source.sourceId, source]));
  const listings = new Map(data.listings.map((listing) => [listing.id, listing]));
  const observations = new Map(data.observations.map((observation) => [observation.id, observation]));
  const stableOptions = { ...options, now: options.now ?? Date.now(), ...(options.config ? { config: parseAtlasPresentationConfig(options.config) } : {}) };
  return (item) => item.sources.map((reference) => {
    const source = sources.get(reference.sourceId);
    const entry = listings.get(reference.listingId);
    const listing = entry && entry.sourceId === reference.sourceId && item.job.listingIds.includes(entry.id)
      && (!entry.canonicalJobId || entry.canonicalJobId === item.job.id) ? entry : undefined;
    const published = listing ? listing.observationIds.map((id) => observations.get(id)).filter((observation) => observation
      && observation.listingId === listing.id && (observation.result === "read" || observation.result === "partial")
      && (observation.sourcePublishedAt || observation.sourcePublishedRaw?.trim())).sort((a, b) => Date.parse(b!.fetchedAt) - Date.parse(a!.fetchedAt) || a!.id.localeCompare(b!.id)) : [];
    const latest = published[0];
    const publication = formatAtlasPublication({ publishedAt: latest?.sourcePublishedAt, publishedRaw: latest?.sourcePublishedRaw }, stableOptions);
    if (latest) publication.observationId = latest.id;
    const simultaneous = published.filter((observation) => Date.parse(observation!.fetchedAt) === Date.parse(latest?.fetchedAt ?? ""));
    const disclosures = new Set(simultaneous.map((observation) => {
      const raw = observation!.sourcePublishedRaw?.trim();
      if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return `date:${raw}`;
      const at = observation!.sourcePublishedAt ?? (raw && TimestampSchema.safeParse(raw).success ? raw : undefined);
      return at ? `instant:${Date.parse(at)}` : `raw:${raw}`;
    }));
    if (disclosures.size > 1) {
      publication.status = "review"; publication.reason = "conflicting-publication"; publication.label = "发布时间待核对 · 同次来源记录冲突";
      publication.colors = { ...(stableOptions.config ?? defaults).publicationColors.review };
    }
    return { listingId: reference.listingId, sourceId: reference.sourceId, label: source?.attribution.label ?? reference.label,
      ...(listing?.canonicalUrl ? { url: listing.canonicalUrl } : {}), badge: getAtlasSourceBadge({ sourceId: reference.sourceId, adapterId: source?.adapterId, platform: reference.label }, stableOptions.config), publication };
  });
}
