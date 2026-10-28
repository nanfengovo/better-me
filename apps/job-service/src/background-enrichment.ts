import { z } from "zod";
import { EntityIdSchema, TimestampSchema, type AtlasDataset, type Company, type JobLocation, type EvidenceRef } from "@better-me/opportunities";
import type { SourceNormalizationArea } from "./location-catalog.js";

export type BackgroundEnrichmentOptions = { actorScope?: string; limit?: number; signal?: AbortSignal };
export type BackgroundEnrichmentStatus = { revision: number; pending: number; running: number; completed: number; failed: number; nextRetryAt?: string };
export type BackgroundEnrichmentBatchResult = { processed: number; completed: number; failed: number; changedJobs: number; revision: number; status: BackgroundEnrichmentStatus };
export const ENRICHMENT_MAX_ATTEMPTS = 3;
export const BackgroundEnrichmentTaskSchema = z.object({
  id: EntityIdSchema, kind: z.literal("source-metadata-v1"), jobId: EntityIdSchema,
  actorScope: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["pending", "running", "completed", "failed"]),
  attempts: z.number().int().min(0).max(ENRICHMENT_MAX_ATTEMPTS),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  nextRetryAt: TimestampSchema.optional(), leaseId: EntityIdSchema.optional(), leaseExpiresAt: TimestampSchema.optional(),
  errorCode: z.enum(["planning-failed", "attempts-exhausted"]).optional(),
  result: z.object({ revision: z.number().int().nonnegative(), changedJobs: z.number().int().nonnegative() }).strict().optional(),
}).strict().superRefine((task, context) => {
  if (task.state === "running" ? !task.leaseId || !task.leaseExpiresAt : task.leaseId !== undefined || task.leaseExpiresAt !== undefined) context.addIssue({ code: "custom", message: "Only running tasks hold a complete lease." });
  if (task.state === "completed" && !task.result) context.addIssue({ code: "custom", message: "Completed tasks require a durable result." });
  if (task.nextRetryAt && (task.state !== "failed" || task.attempts >= ENRICHMENT_MAX_ATTEMPTS)) context.addIssue({ code: "custom", message: "Only retryable failures have a next retry." });
  if (task.state === "pending" && task.attempts >= ENRICHMENT_MAX_ATTEMPTS) context.addIssue({ code: "custom", message: "Exhausted attempts cannot remain pending." });
});
export type BackgroundEnrichmentTask = z.infer<typeof BackgroundEnrichmentTaskSchema>;
export type BackgroundEnrichmentPlan = { locations: JobLocation[]; companies: Company[] };

/** Only the origin job and its own source chain define a task's identity. */
export function backgroundEnrichmentSource(data: AtlasDataset, jobId: string): unknown {
  const job = data.jobs.find(value => value.id === jobId);
  if (!job) return null;
  const listingIds = new Set(job.listingIds);
  return { job, company: data.companies.find(value => value.id === job.companyId),
    locations: data.locations.filter(value => job.locationIds.includes(value.id)),
    listings: data.listings.filter(value => listingIds.has(value.id)),
    snapshots: data.snapshots.filter(value => value.id === job.selectedSnapshotId && listingIds.has(value.listingId)),
  };
}

function normalized(value: string) { return value.normalize("NFKC").trim().toLocaleLowerCase("en"); }
function stable(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sorted(value)])) : item;
  return JSON.stringify(sorted(value));
}
const CONTROLLER_RULE = "source-text:explicit-controller-label:v1";
function companyCandidate(data: AtlasDataset, companyId: string): Company | undefined {
  const company = data.companies.find(value => value.id === companyId);
  if (!company || company.ultimateControllers.verification === "verified" || company.ultimateControllers.method === "manual"
    || company.manualOverrides.some(value => value.field === "ultimateControllers")) return undefined;
  const previous = company.ultimateControllers;
  const ownedCandidate = previous.method === "parser" && previous.evidence.length > 0 && previous.evidence.every(value => value.selector === CONTROLLER_RULE);
  if (previous.value.length > 0 && !ownedCandidate) return undefined;
  const candidates = new Map<string, EvidenceRef[]>();
  for (const job of data.jobs.filter(value => value.companyId === companyId)) {
    const snapshot = data.snapshots.find(value => value.id === job.selectedSnapshotId && job.listingIds.includes(value.listingId) && value.text === job.description);
    const listing = snapshot && data.listings.find(value => value.id === snapshot.listingId && value.canonicalJobId === job.id);
    const observation = snapshot && data.observations.find(value => value.id === snapshot.observationId && value.listingId === snapshot.listingId && value.snapshotId === snapshot.id);
    if (!snapshot?.sourceUrl || !listing || !observation || !listing.observationIds.includes(observation.id)) continue;
    for (const match of snapshot.text.matchAll(/(?:^|[\n\r])[ \t]*((?:公司)?(?:实际控制人|最终控股方)[：:][ \t]*([^\n\r。；;]{1,120}))/gu)) {
      const name = match[2]!.trim();
      if (!name || /未知|不详|无实际控制人|待核实|未披露/u.test(name)) continue;
      const refs = candidates.get(name) ?? [];
      refs.push({ observationId: observation.id, sourceUrl: snapshot.sourceUrl, observedAt: observation.fetchedAt, selector: CONTROLLER_RULE, quote: match[1] });
      candidates.set(name, refs);
    }
  }
  if (candidates.size !== 1 && !ownedCandidate) return undefined;
  const candidate = candidates.size === 1 ? [...candidates.entries()][0] : undefined;
  // A company-name heuristic is not ultimate-control evidence. Only an exact,
  // owned current source disclosure becomes a candidate; conflicts stay unknown.
  const next = { value: candidate ? [{ name: candidate[0], kind: /国资委|国有资产监督管理委员会/u.test(candidate[0]) ? "state" as const : "unknown" as const }] : [],
    evidence: candidate?.[1].slice(0, 200) ?? [], method: "parser" as const, verification: candidate ? "unverified" as const : "unknown" as const, revision: previous.revision };
  if (stable({ ...previous, revision: 0 }) === stable({ ...next, revision: 0 })) return undefined;
  return { ...company, ultimateControllers: { ...next, revision: previous.revision + 1 } };
}
function sourceArea(location: JobLocation, areas: readonly SourceNormalizationArea[]): SourceNormalizationArea | undefined {
  const raw = normalized(location.raw);
  const tokens = new Set(raw.split(/[，,、;；/|·\s\-—]+/u).filter(Boolean));
  const matches = areas.filter(area => area.aliases.some(alias => tokens.has(normalized(alias))
    || /[市省]$/u.test(alias) && raw.includes(normalized(alias))));
  const cities = matches.filter(area => area.city);
  const distinctCities = new Map(cities.map(area => [`${area.region}:${area.city}`, area]));
  if (distinctCities.size > 1) return undefined;
  let found = [...distinctCities.values()][0] ?? (matches.length === 1 ? matches[0] : undefined);
  // 吉林 can denote either the province or its same-name city. Do not silently
  // pick the more precise interpretation without an explicit 市 suffix.
  const province = matches.find(area => !area.city && area.region === found?.region);
  if (found?.city && province && tokens.has(normalized(found.city).replace(/市$/u, "")) && !tokens.has(normalized(found.city))) found = province;
  if (!found || matches.some(area => area.region !== found.region)
    || location.countryCode && location.countryCode !== found.countryCode
    || location.region && normalized(location.region).replace(/[省市]$/u, "") !== normalized(found.region).replace(/[省市]$/u, "")
    || location.city && found.city && !found.aliases.some(alias => normalized(alias) === normalized(location.city!))) return undefined;
  return found;
}

/** Pure, conservative parsing. It never manufactures evidence, manual decisions or coordinates. */
export function planBackgroundEnrichment(data: AtlasDataset, current: AtlasDataset, jobId: string, areas: readonly SourceNormalizationArea[]): BackgroundEnrichmentPlan {
  const job = data.jobs.find(value => value.id === jobId);
  if (!job) return { locations: [], companies: [] };
  const locations: JobLocation[] = [];
  for (const location of data.locations.filter(value => job.locationIds.includes(value.id))) {
    const effective = current.locations.find(value => value.id === location.id);
    if (location.verification === "verified" || effective?.userResolution || effective?.officeResolution) continue;
    const area = sourceArea(location, areas);
    if (!area) continue;
    const next: JobLocation = { ...location, countryCode: location.countryCode ?? area.countryCode,
      region: location.region ?? area.region, regionId: location.regionId ?? area.regionId,
      ...(location.city || area.city ? { city: location.city ?? area.city } : {}),
      precision: ["unknown", "country", "region"].includes(location.precision) ? area.city ? "city" : "region" : location.precision,
      verification: "unverified", provider: location.provider ?? "source-text:china-catalog",
    };
    if (JSON.stringify(next) !== JSON.stringify(location)) locations.push(next);
  }
  const company = companyCandidate(data, job.companyId);
  return { locations, companies: company ? [company] : [] };
}

export function applyBackgroundEnrichment(data: AtlasDataset, plan: BackgroundEnrichmentPlan): AtlasDataset {
  const locations = new Map(plan.locations.map(value => [value.id, value]));
  const companies = new Map(plan.companies.map(value => [value.id, value]));
  return { ...data, locations: data.locations.map(value => locations.get(value.id) ?? value), companies: data.companies.map(value => companies.get(value.id) ?? value) };
}
