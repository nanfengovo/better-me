import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { disclosureViolations, privacyDigest } from "../privacy/content-guard.js";
import { isLoopbackHost } from "../privacy/http-cloud.js";
import { CareerMcpError } from "./grants.js";
import { createReviewedStdioTransport } from "./stdio.js";
import type { ReviewedStdioSpec } from "./stdio.js";
import type { TwinAuthStamp } from "../candidate-twin/types.js";

export type ReviewedMcpServer = {
  id: string; version: string;
  transport: { kind: "streamable-http"; endpoint: string; loopbackFixture?: boolean } | { kind: "stdio"; spec: ReviewedStdioSpec };
  allowedTools: string[]; allowedResources: string[];
  maxInputBytes: number; maxOutputBytes: number; maxActiveMs: number;
};
export const reviewedMcpServerHash = (server: ReviewedMcpServer): string => privacyDigest(server);
export type McpConnectionGrant = TwinAuthStamp & { manifestHash: string; valid(): Promise<boolean> };
export type McpCallGrant = McpConnectionGrant & {
  toolsetHash: string; operationId: string; inputHash: string;
  reserve(): Promise<boolean>;
};
export type UntrustedMcpResult = { trust: "untrusted_external_data"; manifestHash: string; toolsetHash: string; operationId: string; data: unknown };
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
const authStamp = ({ ownerId, sessionId, sessionGeneration, authorizationGeneration }: TwinAuthStamp) => ({ ownerId, sessionId, sessionGeneration, authorizationGeneration });

function safeJson(value: unknown, maxBytes: number): unknown {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new CareerMcpError("mcp_invalid_json_data"); }
  if (!encoded || Buffer.byteLength(encoded) > maxBytes || strings(value).some(text => disclosureViolations(text).length)) throw new CareerMcpError("mcp_unsafe_or_oversized_data");
  return JSON.parse(encoded) as unknown;
}

/** Official SDK client. Review/connection is separate from exact per-operation
 * permission. All external descriptions/results remain untrusted data. It has
 * no access to Workspace writes, model sampling, roots or shell tools. */
export class CareerMcpClient {
  private readonly client = new Client({ name: "betterme-career-host", version: "1.0.0" }, { capabilities: {}, enforceStrictCapabilities: true });
  private closeTransport: () => Promise<void> = async () => {};
  private connected = false;
  private readonly active = new Set<AbortController>();
  private readonly spec: ReviewedMcpServer;
  private constructor(spec: ReviewedMcpServer, private readonly connection: McpConnectionGrant) { this.spec = structuredClone(spec); }

  static async connect(input: { server: ReviewedMcpServer; grant: McpConnectionGrant; authorizationHeader?: () => Promise<string | undefined>; signal?: AbortSignal }): Promise<CareerMcpClient> {
    const spec = structuredClone(input.server);
    if (reviewedMcpServerHash(spec) !== input.grant.manifestHash || !/^[A-Za-z0-9_.:-]{1,160}$/.test(spec.id) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(spec.version) || spec.allowedTools.length > 50 || new Set(spec.allowedTools).size !== spec.allowedTools.length || spec.allowedTools.some(name => !/^[A-Za-z0-9_.:-]{1,160}$/.test(name)) || spec.allowedResources.length > 50 || new Set(spec.allowedResources).size !== spec.allowedResources.length || ![spec.maxInputBytes, spec.maxOutputBytes, spec.maxActiveMs].every(value => Number.isSafeInteger(value) && value > 0) || spec.maxInputBytes > 256_000 || spec.maxOutputBytes > 256_000 || spec.maxActiveMs > 600_000 || input.signal?.aborted) throw new CareerMcpError("mcp_server_review_invalid");
    const instance = new CareerMcpClient(spec, input.grant);
    await instance.authorized();
    let transport: Transport;
    if (spec.transport.kind === "stdio") {
      const sandbox = await createReviewedStdioTransport({ spec: spec.transport.spec, approvedSpecHash: privacyDigest(spec.transport.spec), maxMessageBytes: spec.maxOutputBytes });
      transport = sandbox.transport; instance.closeTransport = sandbox.close;
    } else {
      let endpoint: URL;
      try { endpoint = new URL(spec.transport.endpoint); } catch { throw new CareerMcpError("mcp_endpoint_invalid"); }
      const fixture = spec.transport.loopbackFixture === true && endpoint.protocol === "http:" && isLoopbackHost(endpoint.hostname);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !fixture)) throw new CareerMcpError("mcp_endpoint_invalid");
      const exactEndpoint = endpoint.href;
      transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { redirect: "error", credentials: "omit" },
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
        fetch: async (url, init = {}) => {
          if (new URL(url).href !== exactEndpoint) throw new CareerMcpError("mcp_endpoint_changed");
          await instance.authorized();
          const headers = new Headers(init.headers), authorization = await input.authorizationHeader?.();
          if (authorization) headers.set("authorization", authorization);
          await instance.authorized();
          if (typeof init.body === "string" && Buffer.byteLength(init.body) > spec.maxInputBytes) throw new CareerMcpError("mcp_input_limit");
          const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), ...(input.signal ? [input.signal] : []), AbortSignal.timeout(spec.maxActiveMs)]);
          const response = await fetch(exactEndpoint, { ...init, headers, signal, redirect: "error", credentials: "omit" });
          const declared = response.headers.get("content-length");
          if (declared && Number(declared) > spec.maxOutputBytes) { await response.body?.cancel(); throw new CareerMcpError("mcp_output_limit"); }
          if (!response.body) return response;
          let bytes = 0;
          const reader = response.body.getReader();
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try { const part = await reader.read(); if (part.done) { controller.close(); return; } bytes += part.value.byteLength; if (bytes > spec.maxOutputBytes) { await reader.cancel(); controller.error(new CareerMcpError("mcp_output_limit")); return; } controller.enqueue(part.value); } catch { controller.error(new CareerMcpError("mcp_transport_failed")); }
            },
            async cancel() { await reader.cancel(); },
          });
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
      });
      instance.closeTransport = () => transport.close();
    }
    try {
      const controller = new AbortController();
      const abort = () => { controller.abort(); void transport.close(); };
      input.signal?.addEventListener("abort", abort, { once: true });
      try { await instance.authorized(); if (input.signal?.aborted) controller.abort(); await instance.client.connect(transport, { signal: controller.signal, timeout: spec.maxActiveMs, maxTotalTimeout: spec.maxActiveMs }); } finally { input.signal?.removeEventListener("abort", abort); }
      await instance.authorized(); instance.connected = true;
      return instance;
    } catch { await instance.closeTransport(); throw new CareerMcpError(input.signal?.aborted ? "mcp_cancelled" : "mcp_connection_failed"); }
  }

  private async authorized(grant: McpConnectionGrant = this.connection): Promise<void> {
    let valid: boolean;
    try { valid = await this.connection.valid() && await grant.valid(); } catch { throw new CareerMcpError("mcp_authorization_unavailable"); }
    if (!valid || privacyDigest(authStamp(grant)) !== privacyDigest(authStamp(this.connection)) || grant.manifestHash !== reviewedMcpServerHash(this.spec)) throw new CareerMcpError("mcp_authorization_changed");
  }
  async review(signal?: AbortSignal): Promise<{ manifestHash: string; toolsetHash: string; trust: "untrusted_external_data"; tools: unknown[] }> {
    if (!this.connected) throw new CareerMcpError("mcp_client_closed");
    await this.authorized();
    try {
      const result = await this.client.listTools({}, { signal, timeout: this.spec.maxActiveMs, maxTotalTimeout: this.spec.maxActiveMs });
      if (result.nextCursor) throw new CareerMcpError("mcp_tool_catalog_limit");
      const tools = safeJson(result.tools.filter(tool => this.spec.allowedTools.includes(tool.name)), this.spec.maxOutputBytes) as unknown[];
      if (tools.length !== this.spec.allowedTools.length) throw new CareerMcpError("mcp_reviewed_tool_missing");
      await this.authorized();
      return { manifestHash: reviewedMcpServerHash(this.spec), toolsetHash: privacyDigest(tools), trust: "untrusted_external_data", tools };
    } catch (error) { if (error instanceof CareerMcpError) throw error; throw new CareerMcpError(signal?.aborted ? "mcp_cancelled" : "mcp_tool_catalog_failed"); }
  }

  private async invoke(input: { kind: "tool" | "resource"; name: string; args: unknown; grant: McpCallGrant; signal?: AbortSignal }): Promise<UntrustedMcpResult> {
    if (!this.connected || input.signal?.aborted) throw new CareerMcpError(input.signal?.aborted ? "mcp_cancelled" : "mcp_client_closed");
    if (input.kind === "tool" ? !this.spec.allowedTools.includes(input.name) : !this.spec.allowedResources.includes(input.name)) throw new CareerMcpError("mcp_operation_not_allowlisted");
    const args = safeJson(input.args, this.spec.maxInputBytes), inputHash = privacyDigest({ kind: input.kind, name: input.name, args });
    await this.authorized(input.grant);
    const catalog = await this.review(input.signal);
    if (input.grant.inputHash !== inputHash || input.grant.toolsetHash !== catalog.toolsetHash || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.grant.operationId)) throw new CareerMcpError("mcp_exact_call_consent_mismatch");
    let reserved: boolean;
    try { reserved = await input.grant.reserve(); } catch { throw new CareerMcpError("mcp_call_gate_unavailable"); }
    if (!reserved) throw new CareerMcpError("mcp_call_claimed_or_quota_exhausted");
    await this.authorized(input.grant);
    const controller = new AbortController(), abort = () => controller.abort(); this.active.add(controller);
    input.signal?.addEventListener("abort", abort, { once: true });
    const options = { signal: controller.signal, timeout: this.spec.maxActiveMs, maxTotalTimeout: this.spec.maxActiveMs, resetTimeoutOnProgress: false };
    try {
      if (input.signal?.aborted) controller.abort();
      const result = input.kind === "tool" ? await this.client.callTool({ name: input.name, arguments: args as Record<string, unknown> }, undefined, options) : await this.client.readResource({ uri: input.name }, options);
      await this.authorized(input.grant);
      if (controller.signal.aborted) throw new CareerMcpError("mcp_cancelled");
      const data = safeJson(result, this.spec.maxOutputBytes);
      if ((await this.review(controller.signal)).toolsetHash !== input.grant.toolsetHash) throw new CareerMcpError("mcp_toolset_changed");
      await this.authorized(input.grant);
      return { trust: "untrusted_external_data", manifestHash: catalog.manifestHash, toolsetHash: catalog.toolsetHash, operationId: input.grant.operationId, data };
    } catch (error) { if (error instanceof CareerMcpError) throw error; throw new CareerMcpError(controller.signal.aborted ? "mcp_cancelled" : "mcp_external_call_failed"); }
    finally { this.active.delete(controller); input.signal?.removeEventListener("abort", abort); }
  }
  callTool(input: { name: string; args: Record<string, unknown>; grant: McpCallGrant; signal?: AbortSignal }): Promise<UntrustedMcpResult> { return this.invoke({ ...input, kind: "tool" }); }
  readResource(input: { uri: string; grant: McpCallGrant; signal?: AbortSignal }): Promise<UntrustedMcpResult> { return this.invoke({ ...input, kind: "resource", name: input.uri, args: {} }); }
  /** Host calls on logout/revocation; no reconnect or replay follows. */
  async close(): Promise<void> { this.connected = false; for (const controller of this.active) controller.abort(); try { await this.client.close(); } finally { await this.closeTransport(); } }
}

export const mcpCallInputHash = (kind: "tool" | "resource", name: string, args: unknown): string => privacyDigest({ kind, name, args });
