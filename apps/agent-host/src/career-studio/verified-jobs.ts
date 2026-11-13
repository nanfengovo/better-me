import { z } from "zod";
import { CanonicalJobSchema, CompanySchema, JobLocationSchema, CompensationSchema, SourceListingSchema,
  SourceObservationSchema, JdSnapshotSchema, SourceDefinitionSchema, JobQueryResultSchema, EntityIdSchema, RevisionSchema } from "@better-me/opportunities";
import { studioHash, StudioError } from "./storage.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** This schema is a Host-adapter return contract, not an HTTP authorization.
 * Neither this object nor browser-supplied coordinate flags are evidence unless
 * resolved by the independently registered read-only JobService adapter. */
export const VerifiedAtlasJobSchema = z.object({ jobId: EntityIdSchema, locationId: EntityIdSchema,
  sourceHash: hash, snapshotRevision: RevisionSchema, locationHash: hash,
  persisted: z.literal(true), indexed: z.literal(true), verification: z.literal("verified"),
  kind: z.literal("office"), precision: z.enum(["address", "manual"]),
  coordinates: z.object({ longitude: z.number().finite().min(-180).max(180), latitude: z.number().finite().min(-90).max(90), coordinateSystem: z.literal("WGS84") }).strict(),
}).strict();
export type VerifiedAtlasJob = z.infer<typeof VerifiedAtlasJobSchema>;
export type VerifiedJobResolver = (jobId: string, signal: AbortSignal) => Promise<VerifiedAtlasJob | undefined>;
export const JOB_AUTHORITY_ENDPOINT = "http://127.0.0.1:5178";

const detailSchema = z.object({ snapshotRevision: RevisionSchema, job: CanonicalJobSchema, company: CompanySchema,
  locations: z.array(JobLocationSchema).max(1000), compensations: z.array(CompensationSchema).max(100),
  listings: z.array(SourceListingSchema).max(1000), observations: z.array(SourceObservationSchema).max(10000),
  snapshots: z.array(JdSnapshotSchema).max(1000), sources: z.array(SourceDefinitionSchema).max(1000),
}).strict();
const result = <T extends z.ZodTypeAny>(value: T) => z.object({ ok: z.literal(true), requestId: z.string().min(1).max(150), value }).strict();

/** Reads must originate in a trusted Host adapter. Matching index membership,
 * persisted detail, identity, revision and exact office bytes are all required.
 * A city reference, a manual-area confirmation, or a client boolean never
 * becomes an office point. Multiple valid offices stay unknown rather than
 * silently choosing an arbitrary city or office. */
export function createVerifiedJobResolver(reads: {
  detail(jobId: string, signal: AbortSignal): Promise<unknown>;
  indexed(jobId: string, signal: AbortSignal): Promise<unknown>;
}): VerifiedJobResolver {
  return async (rawId, signal) => {
    const jobId = EntityIdSchema.parse(rawId); signal.throwIfAborted();
    try {
      const [rawDetail, rawIndex] = await Promise.all([reads.detail(jobId, signal), reads.indexed(jobId, signal)]);
      signal.throwIfAborted();
      const detail = detailSchema.parse(rawDetail), index = JobQueryResultSchema.parse(rawIndex);
      const matches = index.items.filter(item => item.job.id === jobId), item = matches[0];
      if (matches.length !== 1 || !item || detail.job.id !== jobId || detail.company.id !== detail.job.companyId
        || detail.snapshotRevision !== index.snapshotVersion || studioHash(detail.job) !== studioHash(item.job)
        || detail.job.workMode === "remote" || !detail.job.locationIds.length || !detail.job.listingIds.length
        || detail.job.locationIds.some(id => !detail.locations.some(location => location.id === id))) return undefined;
      const offices = detail.locations.filter(location => detail.job.locationIds.includes(location.id)
        && location.verification === "verified" && location.kind === "office" && ["address", "manual"].includes(location.precision)
        && location.coordinates?.coordinateSystem === "WGS84" && location.evidence.length > 0);
      if (offices.length !== 1) return undefined;
      const office = offices[0]!, indexedOffice = item.locations.find(location => location.id === office.id);
      if (!indexedOffice || studioHash(indexedOffice) !== studioHash(office)) return undefined;
      // Evidence must point into this persisted job's listing/observation chain,
      // not merely a syntactically valid unrelated source URL.
      if (!office.evidence.every(ref => detail.observations.some(observation => observation.id === ref.observationId
        && detail.job.listingIds.includes(observation.listingId) && detail.listings.some(listing => listing.id === observation.listingId
          && listing.observationIds.includes(observation.id) && detail.sources.some(source => source.sourceId === listing.sourceId))))) return undefined;
      const sourceHash = studioHash({ protocol: "betterme.verified-atlas-job.v1", snapshotRevision: detail.snapshotRevision,
        job: detail.job, office, observations: detail.observations.filter(observation => office.evidence.some(ref => ref.observationId === observation.id)) });
      return VerifiedAtlasJobSchema.parse({ jobId, locationId: office.id, sourceHash, snapshotRevision: detail.snapshotRevision,
        locationHash: studioHash(office), persisted: true, indexed: true, verification: "verified", kind: "office", precision: office.precision,
        coordinates: office.coordinates });
    } catch { signal.throwIfAborted(); return undefined; }
  };
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    || Number(response.headers.get("content-length") ?? 0) > 1_000_000 || !response.body) throw new StudioError("studio_job_authority_unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
      if (length > 1_000_000) throw new StudioError("studio_job_authority_response_budget"); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Fixed loopback, explicit separately configured token, no redirect, cookies,
 * proxy URL, mutation or environment discovery. This does not read token files
 * or existing browser credentials. Tests inject only the transport boundary. */
export function createLoopbackVerifiedJobResolver(config: { token: string; fetch?: typeof fetch }): VerifiedJobResolver {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(config.token)) throw new StudioError("studio_job_authority_token_required", 400);
  const fetcher = config.fetch ?? fetch;
  const request = async (route: string, signal: AbortSignal, body?: unknown) => {
    const response = await fetcher(`${JOB_AUTHORITY_ENDPOINT}${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: "error", credentials: "omit", cache: "no-store" });
    return responseJson(response, signal);
  };
  return createVerifiedJobResolver({
    detail: async (jobId, signal) => result(detailSchema).parse(await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, signal)).value,
    indexed: async (jobId, signal) => result(JobQueryResultSchema).parse(await request("/api/v1/jobs/search", signal,
      { jobIds: [jobId], statuses: ["open", "closed", "unknown"], page: { limit: 1 }, mapLevel: "location" })).value,
  });
}

/** A missing/failed resolver is explicitly unknown. Bounded context creation
 * never waits forever for an uncooperative DI adapter or accepts its late data. */
export async function resolveVerifiedAtlasJobs(jobIds: readonly string[], options: { resolve?: VerifiedJobResolver;
  isCurrent(): boolean | Promise<boolean>; signal?: AbortSignal; timeoutMs?: number }): Promise<{ jobs: VerifiedAtlasJob[]; unknownJobIds: string[]; limitations: string[] }> {
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 15000 || jobIds.length > 200 || new Set(jobIds).size !== jobIds.length) throw new StudioError("studio_job_authority_budget", 400);
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
  const jobs: VerifiedAtlasJob[] = [], pending = jobIds.slice(0, 50);
  const bounded = <T>(task: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const stop = () => reject(new StudioError("studio_job_authority_cancelled"));
    if (signal.aborted) { void task.catch(() => {}); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    task.then(value => { signal.removeEventListener("abort", stop); if (signal.aborted) stop(); else resolve(value); }, error => { signal.removeEventListener("abort", stop); reject(error); });
  });
  try {
    if (!await bounded(Promise.resolve().then(options.isCurrent))) throw new StudioError("studio_job_authority_stale");
    if (options.resolve) await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) { const id = pending.shift(); if (!id || signal.aborted) return;
        try { const raw = await bounded(options.resolve!(id, signal)); if (raw) { const parsed = VerifiedAtlasJobSchema.parse(raw); if (parsed.jobId === id && !signal.aborted) jobs.push(parsed); } } catch { /* Unavailable, malformed and timed out all remain unknown. */ }
      }
    }));
    if (!await bounded(Promise.resolve().then(options.isCurrent))) jobs.splice(0);
  } catch { jobs.splice(0); }
  if (signal.aborted) jobs.splice(0);
  const accepted = new Set(jobs.map(job => job.jobId));
  return { jobs, unknownJobIds: jobIds.filter(id => !accepted.has(id)), limitations: ["只接受独立Host岗位服务读回的持久化、同版本索引及有来源的verified办公室坐标；浏览器坐标及verified/persisted/indexed标志无权自证。",
    "每次最多核对50个岗位、4个并发和5秒默认总预算；超出、服务缺失、版本漂移、多办公室歧义或人工自述坐标保持未知。", "办公室观测不是岗位仍在招、公司认可、个人所在地或身份隔离的证明。"] };
}
