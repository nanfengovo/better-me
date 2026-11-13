import { adjudicateClaim, committeeDecisionJsonSchema, type CommitteeRoleReasoner, type CommitteeSnapshot, type CommitteeCitation, type RoleReasonerRequest } from "@better-me/core/career-intelligence";
import { LocalOllamaCompletionError, type LocalOllamaClient } from "../privacy/local-ollama.js";
import { PrivacyError } from "../privacy/types.js";
import { StudioError } from "./storage.js";

/** These records were returned by the core's bounded read tool. The model can
 * select a complete exact citation but cannot transcribe/invent its hash/lines.
 * This reduces syntax/transcription errors, not semantic hallucination. Core
 * still independently checks every citation, attribution and numeric claim. */
function readCitationCatalog(request: RoleReasonerRequest, snapshot: CommitteeSnapshot): CommitteeCitation[] {
  const encoded = request.prompt.split("\n").find(line => line.startsWith("YOUR_PRIOR_TURNS="))?.slice("YOUR_PRIOR_TURNS=".length);
  if (!encoded) return [];
  const turns = JSON.parse(encoded) as Array<{ kind: string; content: Array<Record<string, unknown>> }>;
  const citations: CommitteeCitation[] = [];
  for (const turn of turns) if (turn.kind === "evidence_results" && Array.isArray(turn.content)) for (const row of turn.content) {
    const evidence = snapshot.evidence.find(item => item.id === row["evidenceId"]);
    if (!evidence || !snapshot.authorization.evidenceIds.includes(evidence.id) || row["sourceHash"] !== evidence.sourceHash || row["excerptHash"] !== evidence.excerptHash
      || typeof row["startLine"] !== "number" || typeof row["endLine"] !== "number" || typeof row["excerpt"] !== "string") continue;
    const startLine = row["startLine"], endLine = row["endLine"];
    const quote = evidence.excerpt.split(/\r?\n/).slice(startLine - evidence.startLine, endLine - evidence.startLine + 1).join("\n");
    if (startLine < evidence.startLine || endLine > evidence.endLine || endLine < startLine || quote !== row["excerpt"] || !quote || quote.length > 6000) continue;
    citations.push({ evidenceId: evidence.id, sourceHash: evidence.sourceHash, excerptHash: evidence.excerptHash, startLine, endLine, quote });
  }
  return [...new Map(citations.map(citation => [JSON.stringify(citation), citation])).values()];
}
const exactObject = (value: object) => ({ type: "object", additionalProperties: false, required: Object.keys(value), properties: Object.fromEntries(Object.entries(value).map(([key, value]) => [key, { const: value }])) });

export type CommitteeModelDiagnostic = { role: RoleReasonerRequest["role"]; stage: RoleReasonerRequest["stage"]; turn: number;
  outcome: "completed" | "failed"; promptBytes: number; schemaBytes: number; inputPayloadBytes: number; outputBytes?: number; code?: string; boundary?: "wire" | "generated" | "context" };
const terminalTransportCodes = new Set(["local_generation_limit", "local_completion_rejected", "local_completion_safety_unavailable", "local_runtime_changed"]);
const isTerminalHardBoundary = (error: unknown) => error instanceof LocalOllamaCompletionError
  && ((error.code === "privacy_http_output_limit" && ["wire", "generated"].includes(error.boundary)) || (error.code === "invalid_local_completion" && error.boundary === "context"));
const diagnosticCodes = new Set(["local_input_limit", "privacy_cancelled", "local_model_verification_failed", "local_model_transport_failed", "invalid_local_completion", "local_model_missing_remote_or_changed", "local_model_requires_pinned_local_digest", "privacy_http_failed", "privacy_http_output_limit", "privacy_http_invalid_json", ...terminalTransportCodes]);

/** Finite literal suggestions, independently filtered through the SAME core
 * wording guard. An enum is not a support judgment or an authority grant.
 * At most four short candidates per claim; whole multi-page quotes never get
 * copied into every claim's schema. Final core checks remain authoritative. */
function extractiveCandidates(snapshot: CommitteeSnapshot, claimId: string, citations: CommitteeCitation[]): string[] {
  const claim = snapshot.claims.find(item => item.id === claimId)!;
  const relevantLiterals = citations.filter(citation => {
    const source = snapshot.evidence.find(item => item.id === citation.evidenceId);
    return source && !["inference", "job"].includes(source.provenance)
      && (source.provenance !== "user_statement" || citation.quote.includes(claim.text) || claim.text.includes(citation.quote));
  });
  const pool = [claim.text, ...relevantLiterals.flatMap(citation => [citation.quote, ...citation.quote.split(/\r?\n/)])];
  const reads = citations.map(citation => ({ evidenceId: citation.evidenceId, startLine: citation.startLine, endLine: citation.endLine }));
  const candidates: string[] = []; let characters = 0;
  for (const text of [...new Set(pool)].slice(0, 160)) {
    if (!text.trim() || text.length > 800 || characters + text.length > 1400) continue;
    const checked = adjudicateClaim(snapshot, claim, { claimId, support: "unknown", citations, counterCitations: [], risks: [], missing: [], questions: [], defense: [text] }, reads);
    if (!checked.sidecar.defense.includes(text)) continue;
    candidates.push(text); characters += text.length; if (candidates.length === 4) break;
  }
  return candidates;
}

/** Pure protocol preparation shared by the kernel and the legacy adapter. No
 * transport, budget, identity or business-write authority lives here. */
export function committeeModelRequest(request: RoleReasonerRequest, snapshot: CommitteeSnapshot, options: { allowEvidencePaging?: boolean } = {}) {
  const granted = snapshot.evidence.filter(item => snapshot.authorization.evidenceIds.includes(item.id));
    const initial = request.turn === 1 && granted.length > 0;
    const jsonSchema = committeeDecisionJsonSchema(request.role, snapshot.authorization.evidenceIds, initial ? "request_evidence" : "assessment");
    let prompt = request.prompt;
    if (initial) {
      const requests = granted.slice(0, 8).map(evidence => ({ evidenceId: evidence.id, startLine: evidence.startLine, endLine: Math.min(evidence.endLine, evidence.startLine + 79) }));
      jsonSchema["properties"] = { kind: { const: "request_evidence" }, requests: { type: "array", minItems: requests.length, maxItems: requests.length, prefixItems: requests.map(exactObject), items: { oneOf: requests.map(exactObject) }, uniqueItems: true } };
      prompt += `\nHOST_PROTOCOL_HINT=Read the selected authorized catalog now. Return exactly ${JSON.stringify({ kind: "request_evidence", requests })}. These are bounded read requests, not a claim decision.`;
    } else {
      const citations = readCitationCatalog(request, snapshot);
      const properties = jsonSchema["properties"] as Record<string, unknown>;
      const claims = properties["claims"] as { items: { properties: Record<string, unknown>; required: string[] } };
      const common = claims.items;
      // Definitions keep each exact read quote in ONE schema location. Claim
      // slots reference it, rather than multiplying giant quotes by claim count.
      const definitions: Record<string, unknown> = {};
      if (citations.length) definitions["readCitation"] = { oneOf: citations.map(exactObject) };
      const citationArray = { type: "array", maxItems: citations.length ? 20 : 0, items: citations.length ? { $ref: "#/$defs/readCitation" } : { type: "object" } };
      const catalog = snapshot.claims.map((claim, index) => {
        const candidates = extractiveCandidates(snapshot, claim.id, citations), claimProperties = { ...common.properties,
          claimId: { type: "string", const: claim.id }, citations: citationArray, counterCitations: citationArray,
          questions: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 1000 } },
          defense: { type: "array", maxItems: candidates.length ? 4 : 0, items: candidates.length ? { type: "string", enum: candidates } : { type: "string" } },
          ...(candidates.length ? { rewrite: { type: "string", enum: candidates } } : {}),
        };
        if (!candidates.length) delete (claimProperties as Record<string, unknown>)["rewrite"];
        definitions[`claim${index}`] = { type: "object", additionalProperties: false, properties: claimProperties, required: [...new Set([...common.required, "questions", "defense"])] };
        return { claimId: claim.id, candidates };
      });
      jsonSchema["$defs"] = definitions;
      const references = catalog.map((_, index) => ({ $ref: `#/$defs/claim${index}` }));
      properties["claims"] = { type: "array", minItems: references.length, maxItems: references.length, prefixItems: references, items: { oneOf: references } };
      prompt += `\nHOST_CITATION_CATALOG=${JSON.stringify(citations)}\nHOST_EXTRACTIVE_CANDIDATES=${JSON.stringify(catalog)}\nSelect only these exact citation objects already read by your role. Empty citations are required when no relevant read evidence exists. Return the exact role ${request.role}, and independently choose supported, partial, contradicted or unknown; the schema never decides support. Review summary, risks, missing information and concrete interview questions may be Chinese. For EVERY selected claim include at least one concrete follow-up question derived only from its actual wording and read evidence. Defense and optional rewrite are DIFFERENT: keep the original language, choose only an exact candidate for THAT claim, never translate, explain, concatenate, paraphrase or add ownership/metrics/deployment. A literal candidate is not proof; cite the relevant already-read evidence, otherwise leave defense empty and omit rewrite. Do not propose a rewrite merely to fill an optional field. Source code or a self-statement does not independently prove personal attribution. A source saying not deployed does not refute a claim limited to a synthetic local implementation; inspect actual function/type names rather than echoing a claim's names.`;
    }
    if (!jsonSchema["properties"]) throw new StudioError("committee_model_schema_unavailable", 503);
    if (!initial && options.allowEvidencePaging) {
      prompt += "\nHOST_EVIDENCE_PAGING=The complete authorized catalog remains available. If another exact passage is needed, return request_evidence with up to eight bounded ranges from that catalog instead of assessment. Do not infer unread content. All reads and extra model turns consume the same remaining root budget; leave unsupported claims unknown when evidence is insufficient.";
      return { prompt, jsonSchema: { anyOf: [jsonSchema, committeeDecisionJsonSchema(request.role, snapshot.authorization.evidenceIds, "request_evidence")] } };
    }
    return { prompt, jsonSchema };
}

export function createLocalCommitteeReasoner(client: LocalOllamaClient, snapshot: CommitteeSnapshot, options: { maxInputBytes?: number; maxOutputBytes?: number; maxActiveMs?: number;
  onDiagnostic?(event: CommitteeModelDiagnostic): void } = {}): CommitteeRoleReasoner {
  let terminalStop: PrivacyError | undefined;
  return async (request, signal) => {
    const { prompt, jsonSchema } = committeeModelRequest(request, snapshot);
    const sizes = { role: request.role, stage: request.stage, turn: request.turn, promptBytes: Buffer.byteLength(prompt), schemaBytes: Buffer.byteLength(JSON.stringify(jsonSchema)), inputPayloadBytes: Buffer.byteLength(JSON.stringify({ prompt, jsonSchema })) };
    const diagnostic = (event: CommitteeModelDiagnostic) => { try { options.onDiagnostic?.(event); } catch { /* Diagnostics confer no execution authority. */ } };
    try {
      if (terminalStop) throw terminalStop;
      const output = await client.complete({ prompt, jsonSchema, signal, budget: { maxInputBytes: options.maxInputBytes ?? 180_000, maxOutputBytes: options.maxOutputBytes ?? 48_000, maxActiveMs: options.maxActiveMs ?? 90_000 } });
      diagnostic({ ...sizes, outcome: "completed", outputBytes: Buffer.byteLength(output) }); return output;
    } catch (error) {
      if (error instanceof PrivacyError && (terminalTransportCodes.has(error.code) || isTerminalHardBoundary(error))) terminalStop = error;
      diagnostic({ ...sizes, outcome: "failed", code: error instanceof PrivacyError && diagnosticCodes.has(error.code) ? error.code : signal.aborted ? "privacy_cancelled" : "committee_model_call_failed", ...(error instanceof LocalOllamaCompletionError ? { boundary: error.boundary } : {}) });
      throw error;
    }
  };
}
