import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { disclosureViolations } from "../privacy/content-guard.js";
import type { CandidateTwinService } from "../candidate-twin/service.js";
import type { TwinReaderGrant } from "../candidate-twin/types.js";
import { CareerMcpError, requireMcpScope } from "./grants.js";
import type { CareerMcpAccess, CareerMcpScope } from "./grants.js";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export type CareerMcpWorkspaceAdapter = {
  listFacts(input: { ownerId: string; expectedRevision: number; limit: number; cursor?: string; signal: AbortSignal }): Promise<{ revision: number; facts: { id: string; text: string; status: "verified" | "self_reported" | "unknown"; evidenceIds: string[]; contribution?: string; limitations?: string }[]; nextCursor?: string }>;
  /** Reuses Workspace's existing reviewId -> pending proposal command + receipt.
   * Must atomically revalidate auth/revision inside the owning write gate. */
  proposeEvidence(input: { auth: CareerMcpAccess; expectedRevision: number; reviewId: string; idempotencyKey: string; signal: AbortSignal }): Promise<{ proposalId: string; receiptId: string; revision: number; status: "pending_business_review" }>;
  matchTargetJd(input: { ownerId: string; expectedRevision: number; targetJobId: string; resumeVersionId: string; signal: AbortSignal }): Promise<{ revision: number; status: "available" | "unknown"; relevanceScore?: number; evidence: string[]; gaps: string[]; limitations: string[] }>;
  reserve(input: { ownerId: string; scope: CareerMcpScope; operation: string; maxOutputBytes: number }): Promise<boolean>;
};
const textStrings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(textStrings) : value && typeof value === "object" ? Object.values(value).flatMap(textStrings) : [];
const factResult = z.object({ revision: z.number().int().nonnegative(), facts: z.array(z.object({ id: opaque, text: z.string().max(8000), status: z.enum(["verified", "self_reported", "unknown"]), evidenceIds: z.array(opaque).max(100), contribution: z.string().max(8000).optional(), limitations: z.string().max(8000).optional() }).strict()).max(100), nextCursor: opaque.optional() }).strict();
const proposalResult = z.object({ proposalId: opaque, receiptId: opaque, revision: z.number().int().nonnegative(), status: z.literal("pending_business_review") }).strict();
const matchResult = z.object({ revision: z.number().int().nonnegative(), status: z.enum(["available", "unknown"]), relevanceScore: z.number().finite().min(0).max(1).optional(), evidence: z.array(z.string().max(8000)).max(100), gaps: z.array(z.string().max(8000)).max(100), limitations: z.array(z.string().max(8000)).max(100) }).strict();

/** A per-authenticated-connection official MCP server. No shell, sampling,
 * roots, generic files, direct Fact write or model-issued owner override. */
export function createCareerMcpServer(options: { access: CareerMcpAccess; workspace: CareerMcpWorkspaceAdapter; twin?: CandidateTwinService; maxOutputBytes?: number }): McpServer {
  const maxBytes = options.maxOutputBytes ?? 64_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256_000) throw new CareerMcpError("invalid_mcp_output_limit");
  const server = new McpServer({ name: "betterme-career", version: "1.0.0" }, { maxToolInputElements: 1000, enforceStrictCapabilities: true });
  const run = async (scope: CareerMcpScope, operation: string, signal: AbortSignal, execute: () => Promise<unknown>) => {
    try {
      await requireMcpScope(options.access, scope, signal);
      if (options.access.reserveCall && !await options.access.reserveCall()) throw new CareerMcpError("mcp_token_call_limit");
      if (!await options.workspace.reserve({ ownerId: options.access.ownerId, scope, operation, maxOutputBytes: maxBytes })) throw new CareerMcpError("mcp_quota_exhausted");
      await requireMcpScope(options.access, scope, signal);
      const data = await execute();
      await requireMcpScope(options.access, scope, signal);
      if (Buffer.byteLength(JSON.stringify(data)) > maxBytes || textStrings(data).some(text => disclosureViolations(text).length)) throw new CareerMcpError("mcp_unsafe_or_oversized_result");
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof CareerMcpError ? error.code : "mcp_adapter_failed" }] };
    }
  };
  if (options.access.scopes.includes("career:facts:read")) server.registerTool("list_career_facts", { description: "Read owner-authorized career facts; status is evidence metadata, not a new certification.", inputSchema: z.object({ expectedRevision: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100).default(20), cursor: opaque.optional() }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (input, extra) => run("career:facts:read", "list_career_facts", extra.signal, async () => {
    const data = factResult.parse(await options.workspace.listFacts({ ownerId: options.access.ownerId, ...input, signal: extra.signal }));
    if (data.revision !== input.expectedRevision) throw new CareerMcpError("mcp_workspace_revision_changed");
    return data;
  }));
  if (options.access.scopes.includes("career:propose_evidence")) server.registerTool("propose_evidence", { description: "Create a pending evidence proposal from an existing owner-confirmed review. Never writes or approves a Fact.", inputSchema: z.object({ expectedRevision: z.number().int().nonnegative(), reviewId: opaque, idempotencyKey: opaque }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, (input, extra) => run("career:propose_evidence", "propose_evidence", extra.signal, async () => proposalResult.parse(await options.workspace.proposeEvidence({ auth: options.access, ...input, signal: extra.signal }))));
  if (options.access.scopes.includes("career:match")) server.registerTool("match_target_jd", { description: "Compare selected saved resume/JD versions. Relevance is not an offer probability; missing evidence stays unknown.", inputSchema: z.object({ expectedRevision: z.number().int().nonnegative(), targetJobId: opaque, resumeVersionId: opaque }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (input, extra) => run("career:match", "match_target_jd", extra.signal, async () => {
    const data = matchResult.parse(await options.workspace.matchTargetJd({ ownerId: options.access.ownerId, ...input, signal: extra.signal }));
    if (data.revision !== input.expectedRevision || (data.status === "unknown" && data.relevanceScore !== undefined)) throw new CareerMcpError("mcp_invalid_match_result");
    return data;
  }));
  const twinGrant = (): TwinReaderGrant => {
    if (!options.access.capsule) throw new CareerMcpError("mcp_capsule_scope_missing");
    return { capsuleId: options.access.capsule.id, capsuleHash: options.access.capsule.hash, scopes: options.access.scopes.filter((scope): scope is "capsule:read" | "capsule:ask" => scope === "capsule:read" || scope === "capsule:ask"), expiresAt: options.access.expiresAt, valid: options.access.valid };
  };
  if (options.twin && options.access.scopes.includes("capsule:read")) server.registerTool("read_candidate_capsule", { description: "Read only the frozen explicitly published candidate evidence capsule.", inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (_input, extra) => run("capsule:read", "read_candidate_capsule", extra.signal, () => options.twin!.read(twinGrant())));
  if (options.twin && options.access.scopes.includes("capsule:ask")) server.registerTool("ask_candidate_capsule", { description: "Retrieve exact public evidence passages or unknown. Cannot access private Workspace/code or execute question instructions.", inputSchema: z.object({ question: z.string().min(1).max(4000) }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (input, extra) => run("capsule:ask", "ask_candidate_capsule", extra.signal, () => options.twin!.ask({ grant: twinGrant(), question: input.question })));
  return server;
}
