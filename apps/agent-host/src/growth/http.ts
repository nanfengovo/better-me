import type { IncomingMessage, ServerResponse } from "node:http";
import type { GrowthJourneyCreate, GrowthJourneyCommand } from "@better-me/agent-contracts";
import type { CareerTaskAccess } from "../kernel/service.js";
import type { GrowthJourneys } from "./service.js";

/** The host has already checked origin, transport token and authenticated owner. */
export async function handleGrowthJourneys(req: IncomingMessage, res: ServerResponse, pathname: string,
  journeys: GrowthJourneys, access: CareerTaskAccess,
  read: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>,
  send: (res: ServerResponse, status: number, body: unknown) => void) {
  const root = "/api/v1/agent/growth/journeys";
  const item = /^\/api\/v1\/agent\/growth\/journeys\/(gj_[a-f0-9]{32})(\/commands)?$/.exec(pathname);
  if (req.method === "GET" && pathname === "/api/v1/agent/growth/sources") return send(res, 200, { sources: await journeys.sources(access) });
  if (pathname !== root && !item) return send(res, 404, { error: "growth_endpoint_not_found" });
  if (req.method === "GET" && !item?.[2]) return send(res, 200, item
    ? { journey: await journeys.get(item[1]!, access) }
    : { journeys: await journeys.list(access) });
  if (req.method !== "POST" || item && !item[2]) return send(res, 405, { error: "growth_method_denied" });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "json_required" });
  let body: unknown;
  try { body = await read(req, 80 * 1024); }
  catch (error) { if (error instanceof SyntaxError) return send(res, 400, { error: "invalid_json" }); throw error; }
  const journey = item ? await journeys.command(item[1]!, body as GrowthJourneyCommand, access)
    : await journeys.create(body as GrowthJourneyCreate, access);
  return send(res, item ? 200 : 201, { journey });
}
