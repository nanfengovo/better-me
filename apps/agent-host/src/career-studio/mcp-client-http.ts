import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CareerMcpClient, CareerMcpError, mcpCallInputHash, reviewedMcpServerHash } from "../career-mcp/index.js";
import type { ReviewedMcpServer, UntrustedMcpResult } from "../career-mcp/index.js";
import type { TwinAccess, TwinAuthStamp } from "../candidate-twin/index.js";
import { disclosureViolations, privacyDigest } from "../privacy/content-guard.js";
import type { StudioArtifactStore } from "./storage.js";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestKind = "career-mcp-manifest-preview", connectionKind = "career-mcp-connection", callKind = "career-mcp-call";
export type ConfiguredCareerMcpServer = { id: string; label: string; server: ReviewedMcpServer; /** Host must bump server.version when the credential account/scope changes. */ authorizationHeader?: () => Promise<string | undefined> };
type ManifestPreview = { id: string; auth: TwinAuthStamp; configurationId: string; configurationHash: string; server: ReviewedMcpServer; manifestHash: string; expiresAt: string; usedByConnection?: string };
export type StoredMcpConnection = { id: string; auth: TwinAuthStamp; configurationId: string; configurationHash: string; server: ReviewedMcpServer; manifestHash: string; expiresAt: string; phase: "connecting" | "connected" | "closed" | "failed" | "revoked"; remainingCalls: number; toolsetHash?: string; tools?: unknown[]; stoppedCode?: string };
export type StoredMcpCall = { id: string; auth: TwinAuthStamp; connectionId: string; kind: "tool" | "resource"; name: string; args: Record<string, unknown>; inputHash: string; toolsetHash: string; manifestHash: string; expiresAt: string; phase: "awaiting_consent" | "unknown" | "completed" | "stopped"; result?: UntrustedMcpResult; stoppedCode?: string };
export class McpClientHttpError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); this.name = "McpClientHttpError"; } }
const stamp = ({ ownerId, sessionId, sessionGeneration, authorizationGeneration }: TwinAccess): TwinAuthStamp => ({ ownerId, sessionId, sessionGeneration, authorizationGeneration });
const allStrings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(allStrings) : value && typeof value === "object" ? Object.values(value).flatMap(allStrings) : [];
const warning = "Remote MCP servers receive approved request data. Tool descriptions/results are untrusted; they cannot grant permissions, execute shell commands, or write a BetterMe Fact.";

/** UI integration for the official MCP client: server configuration is provided
 * ONLY by trusted Host configuration. HTTP can select/restrict it, never submit
 * executable/args/env, install a server, discover credentials or open a shell.
 * Manifest consent, connection, exact-call preview and exact-call consent are
 * separate operations. Connection state is not a task queue/business authority. */
export function createMcpClientHttp<OwnerAccess>(options: {
  ownerId: string; store: StudioArtifactStore;
  translateAccess(access: OwnerAccess): TwinAccess | Promise<TwinAccess>;
  getServerConfigurations(access: OwnerAccess): Promise<ConfiguredCareerMcpServer[]>;
  readBody(request: IncomingMessage): Promise<unknown>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
  maxConnections?: number;
}) {
  if (options.store.ownerId !== options.ownerId || !opaque.safeParse(options.ownerId).success || !Number.isSafeInteger(options.maxConnections ?? 5) || (options.maxConnections ?? 5) < 1 || (options.maxConnections ?? 5) > 20) throw new McpClientHttpError("invalid_mcp_client_http_config", 503);
  const clients = new Map<string, CareerMcpClient>(); let closed = false;
  const prefix = "/api/v1/agent/career-studio/mcp-client";
  async function access(ownerAccess: OwnerAccess): Promise<TwinAccess> {
    if (closed) throw new McpClientHttpError("mcp_client_http_closed", 503);
    let auth: TwinAccess; try { auth = await options.translateAccess(ownerAccess); } catch { throw new McpClientHttpError("mcp_owner_authorization_unavailable", 403); }
    if (auth.ownerId !== options.ownerId || !await auth.valid()) throw new McpClientHttpError("mcp_owner_authorization_changed", 403);
    return auth;
  }
  function get<T extends { auth: TwinAuthStamp }>(kind: string, id: string): T {
    if (!opaque.safeParse(id).success) throw new McpClientHttpError("invalid_mcp_artifact_id", 400);
    try { const record = options.store.get<T>(kind, id); if (!record || record.value.auth.ownerId !== options.ownerId) throw new McpClientHttpError("mcp_artifact_not_found", 404); return structuredClone(record.value); } catch (error) { if (error instanceof McpClientHttpError) throw error; throw new McpClientHttpError("mcp_client_storage_unavailable", 503); }
  }
  function put<T>(kind: string, id: string, value: T): void { try { options.store.put(kind, id, 0, value); } catch { throw new McpClientHttpError("mcp_client_storage_unavailable", 503); } }
  function mutate<T extends { auth: TwinAuthStamp }>(kind: string, id: string, change: (value: T) => void): T {
    try { const record = options.store.get<T>(kind, id); if (!record || record.value.auth.ownerId !== options.ownerId) throw new McpClientHttpError("mcp_artifact_not_found", 404); const value = structuredClone(record.value); change(value); return options.store.put(kind, id, record.revision, value).value; } catch (error) { if (error instanceof McpClientHttpError) throw error; throw new McpClientHttpError("mcp_client_storage_cas_or_unavailable", 503); }
  }
  async function configurations(ownerAccess: OwnerAccess) {
    await access(ownerAccess);
    let values: ConfiguredCareerMcpServer[];
    try { values = await options.getServerConfigurations(ownerAccess); } catch { throw new McpClientHttpError("mcp_host_configuration_unavailable", 503); }
    await access(ownerAccess);
    if (values.length > 50 || new Set(values.map(value => value.id)).size !== values.length || values.some(value => !opaque.safeParse(value.id).success || value.label.length > 200)) throw new McpClientHttpError("invalid_mcp_host_configuration", 503);
    return values;
  }
  async function configuration(id: string, ownerAccess: OwnerAccess) { const config = (await configurations(ownerAccess)).find(value => value.id === id); if (!config) throw new McpClientHttpError("mcp_host_server_not_configured", 404); return config; }
  async function listServers(ownerAccess: OwnerAccess) { return { servers: (await configurations(ownerAccess)).map(config => ({ id: config.id, label: config.label, transport: config.server.transport.kind, endpoint: config.server.transport.kind === "streamable-http" ? config.server.transport.endpoint : undefined, allowedTools: config.server.allowedTools, allowedResources: config.server.allowedResources })), warning }; }
  async function previewManifest(raw: unknown, ownerAccess: OwnerAccess) {
    const input = z.object({ serverId: opaque, allowedTools: z.array(opaque).max(50), allowedResources: z.array(z.string().min(1).max(2000)).max(50) }).strict().parse(raw), auth = await access(ownerAccess), config = await configuration(input.serverId, ownerAccess);
    if (new Set(input.allowedTools).size !== input.allowedTools.length || new Set(input.allowedResources).size !== input.allowedResources.length || input.allowedTools.some(name => !config.server.allowedTools.includes(name)) || input.allowedResources.some(uri => !config.server.allowedResources.includes(uri)) || (!input.allowedTools.length && !input.allowedResources.length)) throw new McpClientHttpError("mcp_selection_exceeds_host_allowlist", 403);
    const server = { ...structuredClone(config.server), allowedTools: input.allowedTools, allowedResources: input.allowedResources };
    const preview: ManifestPreview = { id: randomUUID(), auth: stamp(auth), configurationId: config.id, configurationHash: reviewedMcpServerHash(config.server), server, manifestHash: reviewedMcpServerHash(server), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    put(manifestKind, preview.id, preview);
    return { previewId: preview.id, manifest: preview.server, manifestHash: preview.manifestHash, expiresAt: preview.expiresAt, warning };
  }
  async function connect(raw: unknown, ownerAccess: OwnerAccess) {
    const input = z.object({ previewId: opaque, expectedManifestHash: hash, consent: z.literal(true), expiresAt: z.string().datetime(), maxCalls: z.number().int().min(1).max(1000) }).strict().parse(raw), auth = await access(ownerAccess), preview = get<ManifestPreview>(manifestKind, input.previewId);
    if (preview.usedByConnection || preview.expiresAt <= new Date().toISOString() || privacyDigest(preview.auth) !== privacyDigest(stamp(auth)) || preview.manifestHash !== input.expectedManifestHash || Date.parse(input.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > Date.now() + 3_600_000) throw new McpClientHttpError("mcp_manifest_consent_expired_changed_or_used", 403);
    for (const [id, client] of clients) if (Date.parse(get<StoredMcpConnection>(connectionKind, id).expiresAt) <= Date.now()) { mutate<StoredMcpConnection>(connectionKind, id, value => { value.phase = "closed"; }); await client.close(); clients.delete(id); }
    if (clients.size >= (options.maxConnections ?? 5)) throw new McpClientHttpError("mcp_connection_capacity", 429);
    const config = await configuration(preview.configurationId, ownerAccess);
    if (reviewedMcpServerHash(config.server) !== preview.configurationHash) throw new McpClientHttpError("mcp_host_configuration_changed", 409);
    const id = randomUUID(), connection: StoredMcpConnection = { id, auth: stamp(auth), configurationId: config.id, configurationHash: preview.configurationHash, server: preview.server, manifestHash: preview.manifestHash, expiresAt: input.expiresAt, phase: "connecting", remainingCalls: input.maxCalls };
    mutate<ManifestPreview>(manifestKind, input.previewId, value => { if (value.usedByConnection) throw new McpClientHttpError("mcp_manifest_already_claimed"); value.usedByConnection = id; });
    put(connectionKind, id, connection);
    const valid = async () => { try { const current = get<StoredMcpConnection>(connectionKind, id), latest = await configuration(current.configurationId, ownerAccess); return !closed && await auth.valid() && (current.phase === "connecting" || current.phase === "connected") && Date.parse(current.expiresAt) > Date.now() && privacyDigest(current.auth) === privacyDigest(stamp(auth)) && reviewedMcpServerHash(latest.server) === current.configurationHash; } catch { return false; } };
    let client: CareerMcpClient | undefined;
    try {
      client = await CareerMcpClient.connect({ server: preview.server, grant: { ...stamp(auth), manifestHash: preview.manifestHash, valid }, authorizationHeader: config.authorizationHeader });
      const review = await client.review();
      if (!await valid()) throw new McpClientHttpError("mcp_connection_authorization_changed", 403);
      mutate<StoredMcpConnection>(connectionKind, id, value => { if (value.phase !== "connecting") throw new McpClientHttpError("mcp_connection_state_changed"); value.phase = "connected"; value.toolsetHash = review.toolsetHash; value.tools = review.tools; });
      clients.set(id, client);
      return { connectionId: id, manifestHash: preview.manifestHash, toolsetHash: review.toolsetHash, tools: review.tools, selectedResources: preview.server.allowedResources, expiresAt: input.expiresAt, remainingCalls: input.maxCalls, trust: "untrusted_external_data", warning };
    } catch (error) { await client?.close(); try { mutate<StoredMcpConnection>(connectionKind, id, value => { value.phase = "failed"; value.stoppedCode = error instanceof CareerMcpError || error instanceof McpClientHttpError ? error.code : "mcp_connection_failed"; }); } catch { /* no fallback after failed persistence */ } throw error; }
  }
  async function connectionFor(id: string, ownerAccess: OwnerAccess) {
    const auth = await access(ownerAccess), connection = get<StoredMcpConnection>(connectionKind, id), client = clients.get(id);
    if (!client) throw new McpClientHttpError("mcp_restart_or_closed_requires_fresh_connection");
    if (connection.phase !== "connected" || Date.parse(connection.expiresAt) <= Date.now() || privacyDigest(connection.auth) !== privacyDigest(stamp(auth))) throw new McpClientHttpError("mcp_connection_authorization_expired_or_changed", 403);
    const config = await configuration(connection.configurationId, ownerAccess);
    if (reviewedMcpServerHash(config.server) !== connection.configurationHash) throw new McpClientHttpError("mcp_host_configuration_changed");
    return { auth, connection, client };
  }
  async function previewCall(raw: unknown, ownerAccess: OwnerAccess) {
    const input = z.object({ connectionId: opaque, kind: z.enum(["tool", "resource"]), name: z.string().min(1).max(2000), args: z.record(z.unknown()).default({}) }).strict().parse(raw), resolved = await connectionFor(input.connectionId, ownerAccess);
    if (Buffer.byteLength(JSON.stringify(input.args)) > resolved.connection.server.maxInputBytes || allStrings(input.args).some(text => disclosureViolations(text).length) || (input.kind === "tool" ? !resolved.connection.server.allowedTools.includes(input.name) : !resolved.connection.server.allowedResources.includes(input.name) || Object.keys(input.args).length > 0)) throw new McpClientHttpError("mcp_call_not_allowlisted_or_safe", 403);
    const review = await resolved.client.review();
    const call: StoredMcpCall = { id: randomUUID(), auth: stamp(resolved.auth), connectionId: resolved.connection.id, kind: input.kind, name: input.name, args: structuredClone(input.args), inputHash: mcpCallInputHash(input.kind, input.name, input.args), toolsetHash: review.toolsetHash, manifestHash: review.manifestHash, expiresAt: new Date(Math.min(Date.parse(resolved.connection.expiresAt), Date.now() + 300_000)).toISOString(), phase: "awaiting_consent" };
    put(callKind, call.id, call);
    return { previewId: call.id, connectionId: call.connectionId, kind: call.kind, name: call.name, args: call.args, inputHash: call.inputHash, toolsetHash: call.toolsetHash, manifestHash: call.manifestHash, expiresAt: call.expiresAt, warning };
  }
  async function call(raw: unknown, ownerAccess: OwnerAccess) {
    const input = z.object({ previewId: opaque, expectedInputHash: hash, expectedToolsetHash: hash, expectedManifestHash: hash, consent: z.literal(true) }).strict().parse(raw), saved = get<StoredMcpCall>(callKind, input.previewId), resolved = await connectionFor(saved.connectionId, ownerAccess);
    if (saved.phase !== "awaiting_consent" || Date.parse(saved.expiresAt) <= Date.now() || privacyDigest(saved.auth) !== privacyDigest(stamp(resolved.auth)) || saved.inputHash !== input.expectedInputHash || saved.toolsetHash !== input.expectedToolsetHash || saved.manifestHash !== input.expectedManifestHash) throw new McpClientHttpError("mcp_exact_call_consent_expired_changed_or_used", 403);
    const valid = async () => { try { const current = get<StoredMcpConnection>(connectionKind, saved.connectionId), latest = await configuration(current.configurationId, ownerAccess); return !closed && await resolved.auth.valid() && current.phase === "connected" && Date.parse(current.expiresAt) > Date.now() && privacyDigest(current.auth) === privacyDigest(saved.auth) && reviewedMcpServerHash(latest.server) === current.configurationHash; } catch { return false; } };
    const grant = { ...stamp(resolved.auth), manifestHash: saved.manifestHash, toolsetHash: saved.toolsetHash, operationId: saved.id, inputHash: saved.inputHash, valid, reserve: async () => {
      if (!await valid()) return false;
      let reserved = false;
      mutate<StoredMcpCall>(callKind, saved.id, value => { if (value.phase !== "awaiting_consent") return; value.phase = "unknown"; reserved = true; });
      if (!reserved) return false;
      mutate<StoredMcpConnection>(connectionKind, saved.connectionId, value => { if (value.phase !== "connected" || value.remainingCalls < 1) throw new McpClientHttpError("mcp_connection_quota_exhausted"); value.remainingCalls--; });
      return true;
    } };
    try {
      const result = saved.kind === "tool" ? await resolved.client.callTool({ name: saved.name, args: saved.args, grant }) : await resolved.client.readResource({ uri: saved.name, grant });
      if (!await valid()) throw new McpClientHttpError("mcp_call_late_result_not_authorized", 403);
      mutate<StoredMcpCall>(callKind, saved.id, value => { if (value.phase !== "unknown") throw new McpClientHttpError("mcp_call_state_changed"); value.phase = "completed"; value.result = result; });
      return { callId: saved.id, result, adopted: false };
    } catch (error) {
      try { mutate<StoredMcpCall>(callKind, saved.id, value => { value.stoppedCode = error instanceof CareerMcpError || error instanceof McpClientHttpError ? error.code : "mcp_call_failed"; if (value.phase !== "unknown") value.phase = "stopped"; }); } catch { /* Unknown claims are never released on failure. */ }
      throw error;
    }
  }
  async function read(raw: unknown, ownerAccess: OwnerAccess) {
    await access(ownerAccess); const input = z.object({ kind: z.enum(["connection", "call"]), id: opaque }).strict().parse(raw);
    if (input.kind === "connection") { const connection = get<StoredMcpConnection>(connectionKind, input.id); return { connection, continuation: clients.has(input.id) ? "available" : "fresh_connection_consent_required" }; }
    const saved = get<StoredMcpCall>(callKind, input.id); return { call: saved, continuation: saved.phase === "unknown" ? "unknown_outcome_no_replay" : saved.phase === "completed" ? "completed_no_replay" : clients.has(saved.connectionId) ? "available" : "fresh_connection_and_call_consent_required" };
  }
  async function disconnect(raw: unknown, ownerAccess: OwnerAccess) {
    const auth = await access(ownerAccess), input = z.object({ connectionId: opaque }).strict().parse(raw), connection = get<StoredMcpConnection>(connectionKind, input.connectionId);
    if (connection.auth.ownerId !== auth.ownerId) throw new McpClientHttpError("mcp_connection_owner_mismatch", 403);
    mutate<StoredMcpConnection>(connectionKind, connection.id, value => { value.phase = "closed"; });
    const client = clients.get(connection.id); clients.delete(connection.id); await client?.close(); return { disconnected: true };
  }
  return {
    prefix, listServers, previewManifest, connect, previewCall, call, read, disconnect,
    async handleOwner(request: IncomingMessage, response: ServerResponse, pathname: string, ownerAccess: OwnerAccess): Promise<boolean> {
      if (!pathname.startsWith(`${prefix}/`)) return false;
      response.setHeader("cache-control", "no-store");
      try {
        if (request.method !== "POST") throw new McpClientHttpError("mcp_client_method_not_allowed", 405);
        const route = pathname.slice(prefix.length + 1), body = await options.readBody(request);
        if (Buffer.byteLength(JSON.stringify(body) ?? "") > 256_000) throw new McpClientHttpError("mcp_client_input_limit", 413);
        const data = route === "servers" ? await listServers(ownerAccess) : route === "manifest-preview" ? await previewManifest(body, ownerAccess) : route === "connect" ? await connect(body, ownerAccess) : route === "call-preview" ? await previewCall(body, ownerAccess) : route === "call" ? await call(body, ownerAccess) : route === "read" ? await read(body, ownerAccess) : route === "disconnect" ? await disconnect(body, ownerAccess) : undefined;
        if (data === undefined) throw new McpClientHttpError("mcp_client_route_not_found", 404);
        options.sendJson(response, 200, data);
      } catch (error) { const code = error instanceof McpClientHttpError || error instanceof CareerMcpError ? error.code : error instanceof z.ZodError ? "invalid_mcp_client_input" : "mcp_client_operation_failed"; options.sendJson(response, error instanceof McpClientHttpError ? error.status : error instanceof z.ZodError ? 400 : 409, { error: code }); }
      return true;
    },
    async invalidateSession(sessionId: string): Promise<void> { for (const [id, client] of clients) { const connection = get<StoredMcpConnection>(connectionKind, id); if (connection.auth.sessionId !== sessionId) continue; mutate<StoredMcpConnection>(connectionKind, id, value => { value.phase = "revoked"; }); clients.delete(id); await client.close(); } },
    async close(): Promise<void> { closed = true; const pending = [...clients.values()]; clients.clear(); await Promise.allSettled(pending.map(client => client.close())); },
  };
}
