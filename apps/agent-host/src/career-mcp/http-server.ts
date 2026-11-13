import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createCareerMcpServer } from "./server.js";
import type { CareerMcpWorkspaceAdapter } from "./server.js";
import type { CareerMcpTokens } from "./grants.js";
import type { CandidateTwinService } from "../candidate-twin/service.js";

/** Mount only on a Host-owned endpoint. This is actual official StreamableHTTP,
 * not an unauthenticated substitute for the app's login or OAuth server. Each
 * request resolves a scoped opaque token afresh; no shared cross-owner session. */
export function createCareerMcpHttpHandler(options: { tokens: CareerMcpTokens; audience: string; workspace: CareerMcpWorkspaceAdapter; twin?: CandidateTwinService; allowedHosts: string[]; allowedOrigins: string[]; maxInputBytes?: number }) {
  const maxInput = options.maxInputBytes ?? 64_000;
  if (!options.allowedHosts.length || !Number.isSafeInteger(maxInput) || maxInput < 1 || maxInput > 256_000) throw new Error("invalid_mcp_http_config");
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const reject = (status: number, code: string) => { if (!response.headersSent) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: code })); } };
    if (!options.allowedHosts.includes(request.headers.host ?? "") || (request.headers.origin && !options.allowedOrigins.includes(request.headers.origin))) { reject(403, "mcp_origin_denied"); return; }
    if (request.method !== "POST") { reject(405, "mcp_method_not_allowed"); return; }
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "");
    if (!bearer) { reject(401, "mcp_authentication_required"); return; }
    let server: ReturnType<typeof createCareerMcpServer> | undefined, transport: StreamableHTTPServerTransport | undefined;
    try {
      const access = await options.tokens.resolve(bearer[1]!, options.audience);
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.byteLength; if (bytes > maxInput) { reject(413, "mcp_input_limit"); return; } chunks.push(buffer); }
      let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(400, "mcp_invalid_json"); return; }
      server = createCareerMcpServer({ access, workspace: options.workspace, twin: options.twin });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: options.allowedHosts, allowedOrigins: options.allowedOrigins });
      await server.connect(transport);
      response.setHeader("cache-control", "no-store");
      await transport.handleRequest(request, response, body);
    } catch { reject(401, "mcp_request_not_authorized_or_failed"); }
    finally { await server?.close().catch(() => {}); await transport?.close().catch(() => {}); }
  };
}
