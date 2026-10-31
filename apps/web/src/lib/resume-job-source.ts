import { JobQueryResultSchema, normalizeSearchText, type JobSearchItem } from "@better-me/opportunities";
import { readAtlasConnectionSession } from "../components/atlas/connection-session";
import { readAtlasDevAutoConnectSuppressed, requestDevJobIndex } from "../components/atlas/dev-index-bootstrap";
import { readAtlasEnvelope } from "../components/atlas/snapshot-transport";
import { projectLocalOpportunities } from "../components/atlas/local-opportunities";
import { readOpportunityLibrary } from "./opportunities";
import { readRuntimeConnection } from "./runtime-connection";
import type { RecommendationPool, RecommendationProfile } from "./resume-job-recommendations";

export type RecommendationSource = { dataset: RecommendationPool; kind: "index" | "library"; bounded?: boolean; partial?: boolean; cached?: boolean; fetchedAt?: number;
  progress?: { completed: number; total: number }; notice?: "index-unavailable" | "library-only" | "library-damaged" };
export type RecommendationReadOptions = { onUpdate?: (source: RecommendationSource) => void; forceRefresh?: boolean; timeoutMs?: number; cacheTtlMs?: number };
// Page-memory only. Never persist the paired service credential or candidate pool.
const recentCandidates = new Map<string, RecommendationSource>();

export function recommendationPoolFromItems(items: JobSearchItem[]): RecommendationPool {
  const uniqueById = <T extends { id: string }>(values: T[]) => [...new Map(values.map(value => [value.id, value])).values()];
  return {
    jobs: uniqueById(items.map(item => item.job)), companies: uniqueById(items.map(item => item.company)), locations: uniqueById(items.flatMap(item => item.locations)), snapshots: [],
    listings: uniqueById(items.flatMap(item => item.sources.map(source => ({ id: source.listingId, sourceId: source.sourceId, canonicalUrl: source.url })))),
    sources: [...new Map(items.flatMap(item => item.sources.map(source => [source.sourceId, { sourceId: source.sourceId, name: source.label, adapterId: "public-search", attribution: { label: source.label } }] as const))).values()],
    compensations: uniqueById(items.flatMap(item => item.salaryCandidates.map(salary => ({ id: salary.compensationId, raw: salary.raw })))),
  };
}

/** Read a small candidate set rather than exporting megabytes of source history.
 * Only public search keywords and a disclosed city go to the paired loopback service,
 * never a resume, name, contact details, source document or model provider. */
export async function readIndexRecommendationCandidates(endpoint: string, token: string, profile: RecommendationProfile, signal: AbortSignal, options: RecommendationReadOptions = {}): Promise<RecommendationSource> {
  signal.throwIfAborted();
  const generic = /^(?:docker|git|linux|sql|kubernetes|k8s)$/i;
  const skills = [...profile.skills.filter(skill => !generic.test(skill)), ...profile.skills.filter(skill => generic.test(skill))];
  const terms = [...new Set((skills.length ? skills.slice(0, 3) : [...profile.tags, ...profile.roles.map(role => role.split(" / ")[0]!)]).map(term => term.slice(0, 100)))].slice(0, 3);
  if (!terms.length) return { dataset: recommendationPoolFromItems([]), kind: "index", bounded: true };
  const area = profile.locationAliases.length ? { workRegionGroups: [profile.locationAliases], ...(profile.countryCode ? { workCountryCodes: [profile.countryCode] } : {}) } : {};
  const cacheKey = JSON.stringify([endpoint, token, terms, area]);
  const cached = recentCandidates.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - (cached.fetchedAt ?? 0) < (options.cacheTtlMs ?? 0)) return { ...cached, cached: true };
  async function read(term: string, useArea: boolean) {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), options.timeoutMs ?? 12_000);
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    try {
    const result = await readAtlasEnvelope(endpoint, token, { signal: requestSignal, maxBytes: 12 * 1024 * 1024 }, {
      path: "/api/v1/jobs/search", body: { search: { text: term, mode: "exact" }, ...(useArea ? area : {}), statuses: ["open", "unknown"], page: { limit: 60 } },
    });
    if (!result.supported) throw new Error("Job search unavailable");
    const parsed = JobQueryResultSchema.parse(result.value);
    signal.throwIfAborted();
    return parsed;
    } finally { clearTimeout(timeout); }
  }
  const normalizedTerms = new Set<string>();
  const distinctTerms = terms.filter(term => { const key = normalizeSearchText(term); if (normalizedTerms.has(key)) return false; normalizedTerms.add(key); return true; });
  const successfulItems: JobSearchItem[] = [];
  let completed = 0;
  const publish = () => {
    if (!signal.aborted && successfulItems.length) options.onUpdate?.({ dataset: recommendationPoolFromItems(successfulItems), kind: "index", bounded: true,
      progress: { completed, total: distinctTerms.length }, fetchedAt: Date.now() });
  };
  const replies = await Promise.allSettled(distinctTerms.map(async term => {
    try { const reply = await read(term, true); successfulItems.push(...reply.items); return reply; }
    finally { completed++; publish(); }
  }));
  signal.throwIfAborted();
  const successes = replies.flatMap(reply => reply.status === "fulfilled" ? [reply.value] : []);
  if (!successes.length) throw new Error("Job index unavailable");
  let items = successes.flatMap(reply => reply.items);
  let partial = successes.length !== replies.length;
  if (new Set(items.map(item => item.job.id)).size < 3 && profile.locationAliases.length) {
    try { items = [...items, ...(await read(distinctTerms[0]!, false)).items]; }
    catch (error) { if (signal.aborted) throw error; partial = true; }
  }
  const source: RecommendationSource = { dataset: recommendationPoolFromItems(items), kind: "index", bounded: true, partial, fetchedAt: Date.now() };
  if (!partial && options.cacheTtlMs) {
    recentCandidates.delete(cacheKey); recentCandidates.set(cacheKey, source);
    while (recentCandidates.size > 4) recentCandidates.delete(recentCandidates.keys().next().value!);
  }
  return source;
}

/** Requests read public jobs only; full FactBase objects are never accepted here. */
export async function readRecommendationSource(signal: AbortSignal, profile: RecommendationProfile, options: RecommendationReadOptions = {}): Promise<RecommendationSource> {
  signal.throwIfAborted();
  const session = readAtlasConnectionSession();
  const suppressed = readAtlasDevAutoConnectSuppressed();
  let identity = session?.dataMode === "live" ? session : undefined;
  let unavailable = false;
  try {
    if (!identity && !session && !suppressed && (import.meta.env?.DEV || readRuntimeConnection())) {
      const bootstrap = await requestDevJobIndex(signal);
      signal.throwIfAborted();
      if (bootstrap?.ok) identity = { ...bootstrap, schemaVersion: 1, dataMode: "live" };
      else unavailable = true;
    }
    if (identity && !suppressed) {
      return await readIndexRecommendationCandidates(identity.endpoint, identity.token, profile, signal, { cacheTtlMs: 120_000, ...options });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    unavailable = true;
  }
  // Respect an explicitly disconnected index; never reconnect it behind the user's back.
  const captured = readOpportunityLibrary();
  const { dataset } = await projectLocalOpportunities(captured.library, { signal });
  signal.throwIfAborted();
  return { dataset, kind: "library", notice: captured.error ? "library-damaged" : unavailable ? "index-unavailable" : "library-only" };
}
