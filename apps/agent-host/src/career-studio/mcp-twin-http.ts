import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CandidateTwinService, CandidateTwinError } from "../candidate-twin/index.js";
import type { CandidateCapsuleStore, TwinAccess, TwinAuthStamp, TwinReaderGrant, TwinWorkspaceAdapter } from "../candidate-twin/index.js";
import { CareerMcpError, CareerMcpTokens, createCareerMcpHttpHandler } from "../career-mcp/index.js";
import type { CareerMcpScope, CareerMcpWorkspaceAdapter } from "../career-mcp/index.js";
import { privacyDigest } from "../privacy/content-guard.js";
import { isLoopbackHost } from "../privacy/http-cloud.js";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.enum(["career:facts:read", "career:propose_evidence", "career:match", "capsule:read", "capsule:ask"]);
const previewSchema = z.object({ expectedWorkspaceRevision: z.number().int().nonnegative(), factIds: z.array(opaque).min(1).max(100), selectedFields: z.array(z.enum(["statement", "contribution", "design", "outcome", "limitations", "evidence", "diagram"])).min(1).max(7), displayName: z.string().min(1).max(200), privateTerms: z.array(z.string().min(2).max(500)).max(200).optional(), expiresAt: z.string().datetime() }).strict();
const publishSchema = z.object({ previewId: opaque, expectedPreviewHash: hash, consent: z.literal(true) }).strict();
const revokeSchema = z.object({ capsuleId: opaque, expectedHash: hash }).strict();
const tokenSchema = z.object({ target: z.enum(["capsule", "mcp"]), scopes: z.array(scopeSchema).min(1).max(5), capsuleId: opaque.optional(), capsuleHash: hash.optional(), expiresAt: z.string().datetime(), maxCalls: z.number().int().min(1).max(1000) }).strict();
const authStamp = ({ ownerId, sessionId, sessionGeneration, authorizationGeneration }: TwinAccess): TwinAuthStamp => ({ ownerId, sessionId, sessionGeneration, authorizationGeneration });

/** Fragment token never reaches an HTTP URL/referrer/access log. Only this
 * fixed trusted bootstrap reads it, then keeps it in closure memory. All actual
 * capsule data and Q&A requests use Authorization, no cookies/localStorage. */
function capabilityBootstrap(): { html: string; csp: string } {
  const script = `(()=>{const p=new URLSearchParams(location.hash.slice(1));const token=p.get('access_token');history.replaceState(null,'',location.pathname);const status=document.getElementById('status');if(!token){status.textContent='This page requires a valid shared capability link.';return}const headers={Authorization:'Bearer '+token};fetch(location.pathname,{headers,credentials:'omit',referrerPolicy:'no-referrer'}).then(async r=>{if(!r.ok)throw Error('unavailable');const doc=new DOMParser().parseFromString(await r.text(),'text/html');document.getElementById('content').replaceChildren(...Array.from(doc.body.childNodes));status.textContent='Frozen authorized evidence. Unknown questions stay unknown.';document.getElementById('ask').hidden=false}).catch(()=>{status.textContent='This capability expired, was revoked, reached its limit, or is unavailable.'});document.getElementById('ask').addEventListener('submit',async e=>{e.preventDefault();const output=document.getElementById('answer');output.textContent='Retrieving authorized evidence…';try{const r=await fetch(location.pathname+'/ask',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({question:document.getElementById('question').value}),credentials:'omit',referrerPolicy:'no-referrer'});if(!r.ok)throw Error('unavailable');const a=await r.json();output.textContent=a.unknown?'Unknown — no authorized evidence.':a.citations.map(c=>c.factId+' / '+c.field+': '+c.text).join('\\n\\n')}catch{output.textContent='Q&A unavailable: scope, expiry, revocation or call limit.'}})})();`;
  const digest = createHash("sha256").update(script).digest("base64");
  return { csp: `default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared candidate evidence capsule</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;overflow-wrap:anywhere}textarea{box-sizing:border-box;width:100%;min-height:5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{padding:.6rem 1rem}article{border-top:1px solid #ccd4e0}#answer{white-space:pre-wrap}</style></head><body><p id="status" role="status">Loading shared evidence…</p><main id="content"></main><form id="ask" hidden><label for="question">Ask about the published evidence</label><textarea id="question" maxlength="4000" required></textarea><button type="submit">Retrieve evidence</button><p id="answer" aria-live="polite"></p></form><script>${script}</script></body></html>` };
}

/** Owner-specific integration adapter. Mount handlePublic before global app
 * bearer auth, but it independently requires limited scoped opaque capability
 * tokens for data/MCP. Non-owned tags return false for multi-owner dispatch.
 * No identity store, business Fact write, real account or listener is created. */
export function createMcpTwinHttp<OwnerAccess>(options: {
  ownerId: string;
  workspace: TwinWorkspaceAdapter;
  mcpWorkspace: CareerMcpWorkspaceAdapter;
  capsuleStore: CandidateCapsuleStore;
  identityValid(stamp: TwinAuthStamp): Promise<boolean>;
  mayDelegate?(stamp: TwinAuthStamp, scopes: readonly CareerMcpScope[]): Promise<boolean>;
  translateAccess(access: OwnerAccess): TwinAccess | Promise<TwinAccess>;
  readBody(request: IncomingMessage): Promise<unknown>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
  baseURL: string;
  allowedOrigins?: string[];
}) {
  const base = new URL(options.baseURL);
  if (!opaque.safeParse(options.ownerId).success || base.username || base.password || base.search || base.hash || base.pathname !== "/" || (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHost(base.hostname)))) throw new CareerMcpError("invalid_mcp_twin_http_config");
  const ownerTag = privacyDigest({ domain: "betterme-public-owner-v1", ownerId: options.ownerId }).slice(0, 32);
  const ownerPrefix = "/api/v1/agent/career-studio/twin", publicPrefix = `/api/v1/agent/career-studio/public/${ownerTag}`;
  const service = new CandidateTwinService(options.workspace, options.capsuleStore);
  let closed = false;
  const tokens = new CareerMcpTokens({ valid: async stamp => !closed && stamp.ownerId === options.ownerId && await options.identityValid(stamp), mayDelegate: options.mayDelegate ?? (async (_stamp, scopes) => !scopes.includes("career:propose_evidence")) });
  const mcpPath = `${publicPrefix}/mcp`, mcpAudience = `${base.origin}${mcpPath}`;
  const mcpHandler = createCareerMcpHttpHandler({ tokens, audience: mcpAudience, workspace: options.mcpWorkspace, twin: service, allowedHosts: [base.host], allowedOrigins: options.allowedOrigins ?? [base.origin] });
  const error = (response: ServerResponse, caught: unknown) => {
    const code = caught instanceof CareerMcpError || caught instanceof CandidateTwinError ? caught.code : caught instanceof z.ZodError ? "invalid_mcp_twin_input" : "mcp_twin_request_failed";
    options.sendJson(response, /token|authorization|scope|revoked|closed/.test(code) ? 403 : /not_found|unknown/.test(code) ? 404 : /invalid|unsafe/.test(code) ? 400 : 403, { error: code });
  };
  const secureHeaders = (response: ServerResponse) => { response.setHeader("cache-control", "no-store"); response.setHeader("referrer-policy", "no-referrer"); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("x-frame-options", "DENY"); };
  const body = async (request: IncomingMessage): Promise<unknown> => { const data = await options.readBody(request); if (Buffer.byteLength(JSON.stringify(data) ?? "") > 256_000) throw new CareerMcpError("invalid_mcp_twin_input_limit"); return data; };
  const reader = async (request: IncomingMessage, capsuleId: string) => {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "");
    if (!bearer) throw new CareerMcpError("mcp_token_invalid");
    const audience = `${base.origin}${publicPrefix}/twin/${capsuleId}`, access = await tokens.resolve(bearer[1]!, audience);
    if (access.capsule?.id !== capsuleId || !access.reserveCall || !await access.reserveCall()) throw new CareerMcpError("mcp_token_capsule_or_call_limit");
    const grant: TwinReaderGrant = { capsuleId, capsuleHash: access.capsule.hash, scopes: access.scopes.filter((scope): scope is "capsule:read" | "capsule:ask" => scope === "capsule:read" || scope === "capsule:ask"), expiresAt: access.expiresAt, valid: access.valid };
    return grant;
  };
  return {
    service, ownerTag, ownerPrefix, publicPrefix, mcpPath,
    async handleOwner(request: IncomingMessage, response: ServerResponse, pathname: string, ownerAccess: OwnerAccess): Promise<boolean> {
      if (!pathname.startsWith(`${ownerPrefix}/`)) return false;
      secureHeaders(response);
      try {
        if (closed || request.method !== "POST") throw new CareerMcpError("mcp_twin_owner_method_denied");
        const access = await options.translateAccess(ownerAccess);
        if (access.ownerId !== options.ownerId || !await access.valid() || !await options.identityValid(authStamp(access))) throw new CareerMcpError("mcp_twin_owner_authorization_changed");
        const operation = pathname.slice(ownerPrefix.length + 1), data = await body(request);
        if (operation === "preview") { const parsed = previewSchema.parse(data); options.sendJson(response, 200, await service.preview({ ...parsed, access })); }
        else if (operation === "publish") { const parsed = publishSchema.parse(data); options.sendJson(response, 200, await service.publish({ ...parsed, access })); }
        else if (operation === "revoke") { await service.revoke({ ...revokeSchema.parse(data), access }); options.sendJson(response, 200, { revoked: true, limitation: "Downloaded copies remain outside online revocation." }); }
        else if (operation === "token-revoke") { const parsed = z.object({ tokenId: hash }).strict().parse(data); await tokens.revoke(parsed.tokenId, authStamp(access)); options.sendJson(response, 200, { revoked: true }); }
        else if (operation === "token-issue") {
          const parsed = tokenSchema.parse(data);
          if (parsed.target === "capsule" && parsed.scopes.some(scope => !scope.startsWith("capsule:"))) throw new CareerMcpError("invalid_capsule_token_scope");
          let capsule: { id: string; hash: string } | undefined;
          if (parsed.scopes.some(scope => scope.startsWith("capsule:"))) {
            const stored = parsed.capsuleId && await options.capsuleStore.read(parsed.capsuleId);
            if (!stored || stored.ownerId !== options.ownerId || stored.revokedAt || stored.capsule.hash !== parsed.capsuleHash || Date.parse(stored.capsule.expiresAt) <= Date.now()) throw new CareerMcpError("mcp_token_capsule_not_authorized");
            capsule = { id: stored.capsule.id, hash: stored.capsule.hash };
          }
          const capsulePath = capsule && `${publicPrefix}/twin/${capsule.id}`;
          if (parsed.target === "capsule" && !capsulePath) throw new CareerMcpError("invalid_capsule_token_scope");
          const audience = parsed.target === "mcp" ? mcpAudience : `${base.origin}${capsulePath}`;
          const issued = await tokens.issue({ auth: authStamp(access), scopes: parsed.scopes, audience, expiresAt: parsed.expiresAt, maxCalls: parsed.maxCalls, ...(capsule ? { capsule } : {}) });
          options.sendJson(response, 200, { ...issued, scopes: parsed.scopes, maxCalls: parsed.maxCalls, ...(parsed.target === "capsule" ? { capabilityUrl: `${audience}#access_token=${issued.token}` } : { mcpEndpoint: mcpAudience }) });
        } else { options.sendJson(response, 404, { error: "mcp_twin_operation_unknown" }); }
      } catch (caught) { error(response, caught); }
      return true;
    },
    async handlePublic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
      if (!pathname.startsWith(`${publicPrefix}/`)) return false;
      secureHeaders(response);
      if (pathname === mcpPath) { if (closed) options.sendJson(response, 403, { error: "mcp_twin_closed" }); else await mcpHandler(request, response); return true; }
      const relative = pathname.slice(publicPrefix.length), match = /^\/twin\/([A-Za-z0-9_.:-]{1,160})(\/ask)?$/.exec(relative);
      if (!match) { options.sendJson(response, 404, { error: "mcp_twin_public_path_unknown" }); return true; }
      try {
        if (closed) throw new CareerMcpError("mcp_twin_closed");
        if (!match[2] && request.method === "GET" && !request.headers.authorization) {
          const bootstrap = capabilityBootstrap(); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": bootstrap.csp }); response.end(bootstrap.html); return true;
        }
        const grant = await reader(request, match[1]!);
        if (match[2] && request.method === "POST") { const parsed = z.object({ question: z.string().min(1).max(4000) }).strict().parse(await body(request)); options.sendJson(response, 200, await service.ask({ grant, ...parsed })); }
        else if (!match[2] && request.method === "GET") { const exported = await service.exportStatic(grant); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); response.end(exported.html); }
        else throw new CareerMcpError("mcp_twin_public_method_denied");
      } catch (caught) { error(response, caught); }
      return true;
    },
    invalidateSession(sessionId: string): void { tokens.invalidateSession(sessionId); },
    close(): void { closed = true; },
  };
}
