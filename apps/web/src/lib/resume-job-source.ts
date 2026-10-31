import { JobQueryResultSchema, normalizeSearchText, type JobSearchItem } from "@better-me/opportunities";
import { readAtlasConnectionSession } from "../components/atlas/connection-session";
import { readAtlasDevAutoConnectSuppressed, requestDevJobIndex } from "../components/atlas/dev-index-bootstrap";
import { readAtlasEnvelope } from "../components/atlas/snapshot-transport";
import { projectLocalOpportunities } from "../components/atlas/local-opportunities";
import { readOpportunityLibrary } from "./opportunities";
import { readRuntimeConnection } from "./runtime-connection";
import type { RecommendationPool, RecommendationProfile } from "./resume-job-recommendations";

export type RecommendationSource = { dataset: RecommendationPool; kind: "index" | "library"; bounded?: boolean; partial?: boolean; notice?: "index-unavailable" | "library-only" | "library-damaged" };

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
export async function readIndexRecommendationCandidates(endpoint: string, token: string, profile: RecommendationProfile, signal: AbortSignal): Promise<RecommendationSource> {
  const generic = /^(?:docker|git|linux|sql|kubernetes|k8s)$/i;
  const skills = [...profile.skills.filter(skill => !generic.test(skill)), ...profile.skills.filter(skill => generic.test(skill))];
  const terms = [...new Set((skills.length ? skills.slice(0, 3) : [...profile.tags, ...profile.roles.map(role => role.split(" / ")[0]!)]).map(term => term.slice(0, 100)))].slice(0, 3);
  if (!terms.length) return { dataset: recommendationPoolFromItems([]), kind: "index", bounded: true };
  const area = profile.locationAliases.length ? { workRegionGroups: [profile.locationAliases], ...(profile.countryCode ? { workCountryCodes: [profile.countryCode] } : {}) } : {};
  async function read(term: string, useArea: boolean) {
    const result = await readAtlasEnvelope(endpoint, token, { signal, maxBytes: 12 * 1024 * 1024 }, {
      path: "/api/v1/jobs/search", body: { search: { text: term, mode: "exact" }, ...(useArea ? area : {}), statuses: ["open", "unknown"], page: { limit: 60 } },
    });
    if (!result.supported) throw new Error("Job search unavailable");
    const parsed = JobQueryResultSchema.parse(result.value);
    signal.throwIfAborted();
    return parsed;
  }
  const normalizedTerms = new Set<string>();
  const distinctTerms = terms.filter(term => { const key = normalizeSearchText(term); if (normalizedTerms.has(key)) return false; normalizedTerms.add(key); return true; });
  const replies = await Promise.allSettled(distinctTerms.map(term => read(term, true)));
  signal.throwIfAborted();
  const successes = replies.flatMap(reply => reply.status === "fulfilled" ? [reply.value] : []);
  if (!successes.length) throw new Error("Job index unavailable");
  let items = successes.flatMap(reply => reply.items);
  let partial = successes.length !== replies.length;
  if (items.length < 3 && profile.locationAliases.length) {
    try { items = [...items, ...(await read(distinctTerms[0]!, false)).items]; }
    catch (error) { if (signal.aborted) throw error; partial = true; }
  }
  return { dataset: recommendationPoolFromItems(items), kind: "index", bounded: true, partial };
}

/** Requests read public jobs only; full FactBase objects are never accepted here. */
export async function readRecommendationSource(signal: AbortSignal, profile: RecommendationProfile): Promise<RecommendationSource> {
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
      return await readIndexRecommendationCandidates(identity.endpoint, identity.token, profile, signal);
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
