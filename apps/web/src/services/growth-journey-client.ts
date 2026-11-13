import { z } from "zod";
import {
  GrowthJourneyCommandSchema,
  GrowthJourneyCreateSchema,
  GrowthJourneySchema,
  GrowthJourneySummarySchema,
  GrowthSourceSchema,
  type GrowthJourney,
  type GrowthJourneyCommand,
  type GrowthJourneyCreate,
  type GrowthJourneySummary,
  type GrowthSource,
} from "@better-me/agent-contracts";
import { agentOrigin, captureIdentityLease, IdentityBoundaryError, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";

export class GrowthJourneyClientError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "GrowthJourneyClientError"; }
}

export type GrowthJourneyClientOptions = { fetch?: typeof fetch; baseUrl?: string };

/** Authenticated projection of the owner Host. Reads never advance a journey and
 * writes are sent once with caller-provided idempotency keys. */
export function createGrowthJourneyClient(options: GrowthJourneyClientOptions = {}) {
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    const lease = captureIdentityLease(); lease.assert();
    if (!lease.ownerId) throw new GrowthJourneyClientError("请先登录 BetterMe；没有读取或创建成长记录。", "identity_required");
    const origin = (options.baseUrl ?? agentOrigin()).replace(/\/$/, ""), timeout = AbortSignal.timeout(45_000);
    const response = await ownedFetch(`${origin}/api/v1/agent/growth${path}`, {
      method: body === undefined ? "GET" : "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: "application/json", Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, options.fetch ?? globalThis.fetch);
    const payload: unknown = await response.json().catch(() => undefined); lease.assert();
    if (!response.ok) {
      const parsed = z.object({ error: z.string().max(240) }).safeParse(payload);
      throw new GrowthJourneyClientError(parsed.success ? parsed.data.error : `成长记录请求失败（HTTP ${response.status}）。`, parsed.success ? parsed.data.error : "growth_request_failed");
    }
    return { payload, ownerId: lease.ownerId };
  }
  function assertOwner<T extends { ownerId: string }>(value: T, ownerId: string) {
    if (value.ownerId !== ownerId) throw new IdentityBoundaryError();
    return value;
  }
  async function sources(signal?: AbortSignal): Promise<GrowthSource[]> {
    const { payload } = await request("/sources", undefined, signal);
    return z.object({ sources: z.array(GrowthSourceSchema) }).strict().parse(payload).sources;
  }
  async function list(signal?: AbortSignal): Promise<GrowthJourneySummary[]> {
    const { payload, ownerId } = await request("/journeys", undefined, signal);
    const rows = z.object({ journeys: z.array(GrowthJourneySummarySchema) }).strict().parse(payload).journeys;
    return rows.map(row => assertOwner(row, ownerId));
  }
  async function get(id: string, signal?: AbortSignal): Promise<GrowthJourney> {
    const { payload, ownerId } = await request(`/journeys/${encodeURIComponent(id)}`, undefined, signal);
    const journey = z.object({ journey: GrowthJourneySchema }).strict().parse(payload).journey;
    if (journey.id !== id) throw new GrowthJourneyClientError("成长记录标识不匹配，未采用返回内容。", "invalid_response");
    return assertOwner(journey, ownerId);
  }
  async function create(input: GrowthJourneyCreate, signal?: AbortSignal): Promise<GrowthJourney> {
    const { payload, ownerId } = await request("/journeys", GrowthJourneyCreateSchema.parse(input), signal);
    return assertOwner(z.object({ journey: GrowthJourneySchema }).strict().parse(payload).journey, ownerId);
  }
  async function command(id: string, input: GrowthJourneyCommand, signal?: AbortSignal): Promise<GrowthJourney> {
    const { payload, ownerId } = await request(`/journeys/${encodeURIComponent(id)}/commands`, GrowthJourneyCommandSchema.parse(input), signal);
    const journey = z.object({ journey: GrowthJourneySchema }).strict().parse(payload).journey;
    if (journey.id !== id) throw new GrowthJourneyClientError("成长记录标识不匹配，未采用返回内容。", "invalid_response");
    return assertOwner(journey, ownerId);
  }
  return { sources, list, get, create, command };
}

export type GrowthJourneyClient = ReturnType<typeof createGrowthJourneyClient>;
export const defaultGrowthJourneyClient = createGrowthJourneyClient();
