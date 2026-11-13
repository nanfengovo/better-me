import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { intelligenceHash, type CommitteeReport, type ReplayCheckpoint } from "@better-me/core/career-intelligence";
import { CareerStudio, type StudioPublicationRecord } from "../src/career-studio/service.js";
import { createCareerStudioHttp } from "../src/career-studio/http.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import type { LocalCompletionRequest, LocalOllamaClient } from "../src/privacy/local-ollama.js";
import type { StudioContext, StudioContextInput, StudioOperation } from "../src/career-studio/contracts.js";
import type { createReplayFeedback } from "../src/career-studio/replay-feedback.js";
import type { CandidateCapsule, TwinPreview } from "../src/candidate-twin/types.js";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import { createStudioCommitteeHarness, committeeSchema } from "./fixtures/studio-committee.js";

type ReplayApi = ReturnType<typeof createReplayFeedback>;
type ReplayCreated = Awaited<ReturnType<ReplayApi["replayCreate"]>>;
type ReplayLoaded = Awaited<ReturnType<ReplayApi["replayGet"]>>;
type FeedbackIdentity = Awaited<ReturnType<ReplayApi["feedbackIdentity"]>>;
type FeedbackSaved = Awaited<ReturnType<ReplayApi["feedbackSave"]>>;
type FeedbackAnalyzed = Awaited<ReturnType<ReplayApi["feedbackAnalyze"]>>;
type RuleProposed = Awaited<ReturnType<ReplayApi["rulePropose"]>>;
type RuleApplied = Awaited<ReturnType<ReplayApi["ruleApply"]>>;
type RuleReverted = Awaited<ReturnType<ReplayApi["ruleRevert"]>>;
type RulesLoaded = Awaited<ReturnType<ReplayApi["runtimeRules"]>>;
type RuleExported = Awaited<ReturnType<ReplayApi["ruleExport"]>>;

const runtime = { model: "synthetic-http-local", modelDigest: "a".repeat(64) }, claimText = "实现本机单写者租约，保留失败恢复边界。";
const contextInput = (): StudioContextInput => ({ workspaceKey: "workspace-http", resumeId: "resume-http", sourceFingerprint: "b".repeat(64), consent: true,
  claims: [{ id: "claim-1", text: claimText, contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [], skillIds: ["sqlite"] }],
  jobs: [{ id: "job-1", company: "Synthetic Company", title: "Synthetic Engineer", description: "需要SQLite与评测能力。", sourceUrl: null, platform: "manual",
    capturedAt: new Date().toISOString(), firstSeenAt: null, lastSeenAt: null, publishedAt: null, availability: "unknown", verifiedAt: null,
    companyKey: "company-1", locationKey: null, roleKey: null, skillIds: ["sqlite", "evaluation"], salaryText: "未知" }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function protocolResponse(request: LocalCompletionRequest): string {
  request.signal.throwIfAborted();
  if (!request.prompt.includes("SELECTED_SNAPSHOT=")) return JSON.stringify({ kind: "analysis", summary: "公开只读分析：个人归属仍需自述确认。", artifact: { type: "evidence_summary", data: { observations: ["仅核对冻结内容"], unknowns: ["生产部署与独立作者未知"] } } });
  const selected = JSON.parse(request.prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!) as { claims: Array<{ id: string }>; evidenceCatalog: Array<{ id: string; startLine: number; endLine: number }> };
  const role = request.prompt.match(/Role=(\w+);/)![1]!, schema = committeeSchema(request);
  if (schema.properties.kind.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: selected.evidenceCatalog.map(item => ({ evidenceId: item.id, startLine: item.startLine, endLine: item.endLine })) });
  const citations = JSON.parse(request.prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!);
  return JSON.stringify({ kind: "assessment", role, summary: "只读合成证据核对，不是作者认证。", claims: selected.claims.map(claim => ({ claimId: claim.id, support: citations.length ? "supported" : "unknown", citations, counterCitations: [], risks: [], missing: [], questions: ["请解释个人参与和失败恢复边界。"], defense: [] })) });
}
async function setup(t: test.TestContext, complete: (request: LocalCompletionRequest) => Promise<string> = async request => protocolResponse(request)) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-studio-http-"))), sourceRoot = path.join(directory, "synthetic-project");
  await fs.mkdir(sourceRoot); const sourceFile = path.join(sourceRoot, "lease.ts"); await fs.writeFile(sourceFile, `// ${claimText}\nexport const singleWriterLease = true;\n`, { mode: 0o600 });
  const directories = new Map([["owner-a", path.join(directory, "private-a")], ["owner-b", path.join(directory, "private-b")]]), handlers = new Map<string, ReturnType<typeof createCareerStudioHttp>>();
  const harnesses = new Map<string, ReturnType<typeof createStudioCommitteeHarness>>();
  const states = new Map([["owner-a:session-a", true], ["owner-a:session-a2", true], ["owner-b:session-b", true]]), calls: LocalCompletionRequest[] = [];
  const readBody = async (request: IncomingMessage): Promise<unknown> => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); };
  // This fixture-only transport supplies a pre-authenticated owner/session.
  // It does not purport to test the enclosing application's cookie authenticator.
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    for (const handler of handlers.values()) if (await handler.handlePublic(request, response, pathname)) return;
    const owner = String(request.headers["x-fixture-owner"] ?? "owner-a"), session = String(request.headers["x-fixture-session"] ?? "session-a"), handler = handlers.get(owner);
    if (!handler) { response.writeHead(403).end(); return; }
    if (!await handler.handleOwner(request, response, pathname, { session, valid: async () => states.get(`${owner}:${session}`) === true })) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  const open = (ownerId: string) => {
    const client: LocalOllamaClient = { binding: async () => ({ id: "synthetic-http-binding", version: "synthetic-v1", location: "local", endpointFingerprint: "c".repeat(64), ...runtime }),
      complete: async request => { calls.push(request); return complete(request); } };
    const broker = new EvidenceBroker({ forbiddenRoots: [...directories.values()] });
    const harness = createStudioCommitteeHarness({ ownerId, directory: path.join(directories.get(ownerId)!, "tasks"), broker, studio: () => studio, complete: request => client.complete(request) });
    const studio: CareerStudio = new CareerStudio({ ownerId, directory: directories.get(ownerId)!, broker, localClient: () => client, committeeTasks: harness.tasks });
    harnesses.set(ownerId, harness);
    const handler = createCareerStudioHttp({ studio, ownerId, baseURL: origin, allowedOrigins: [origin], readBody,
      sendJson: (response, status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); } });
    handlers.set(ownerId, handler); return handler;
  };
  open("owner-a"); open("owner-b");
  t.after(async () => { for (const harness of harnesses.values()) await harness.close(); for (const handler of handlers.values()) await handler.close(); server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  const request = async <T = Record<string, unknown>>(route: string, body?: unknown, identity = { owner: "owner-a", session: "session-a" }) => {
    const response = await fetch(`${origin}/api/v1/agent/career-studio${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Fixture-Owner": identity.owner, "X-Fixture-Session": identity.session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() as T };
  };
  const createContext = async () => { const result = await request<{ context: StudioContext }>("/context/create", contextInput()); assert.equal(result.status, 200); return result.data.context; };
  const pin = async (contextId: string) => { const result = await request("/runtime/select", { contextId, runtime, consent: true }); assert.equal(result.status, 200); };
  const ownerAccess = { session: "session-a", valid: async () => states.get("owner-a:session-a") === true };
  const committee = async (body: unknown) => ({ status: 200, data: await harnesses.get("owner-a")!.start(body, ownerAccess) });
  return { request, createContext, pin, sourceRoot, sourceFile, calls, states, handlers, open, harnesses, committee, ownerAccess };
}
const committeeBody = (contextId: string, root: string, key: string) => ({ contextId, idempotencyKey: key, consent: true, runtime, claimIds: ["claim-1"], statements: [{ kind: "user_statement", label: "本人已确认原句", text: claimText }], code: [{ root, files: [{ path: "lease.ts", startLine: 1, endLine: 2 }] }] });
async function finished(fixture: Awaited<ReturnType<typeof setup>>, contextId: string, operationId: string) {
  for (let turn = 0; turn < 2000; turn++) { const result = await fixture.request<StudioOperation>("/operation/read", { contextId, operationId }); assert.equal(result.status, 200); if (result.data.status !== "running") return result.data; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error("bounded HTTP operation polling did not converge");
}

test("real HTTP composition binds context/runtime to owner/session and rejects unknown routes, sensitive data and forged scope fields", async t => {
  const fixture = await setup(t), context = await fixture.createContext(); await fixture.pin(context.id);
  assert.equal(context.ownerId, "owner-a"); assert.equal(context.session, "session-a");
  assert.equal((await fixture.request("/runtime/select", { contextId: context.id, runtime: { ...runtime, model: "other" }, consent: true })).status, 409);
  assert.equal((await fixture.request("/feedback/identity", { contextId: context.id }, { owner: "owner-b", session: "session-b" })).status, 409);
  assert.equal((await fixture.request("/feedback/identity", { contextId: context.id }, { owner: "owner-a", session: "session-a2" })).status, 409);
  assert.equal((await fixture.request("/context/create", { ...contextInput(), ownerId: "owner-b" })).status, 400);
  assert.equal((await fixture.request("/context/create", { ...contextInput(), claims: [{ ...contextInput().claims[0]!, text: "api_key = 'synthetic-secret-not-real'" }] })).status, 400);
  assert.equal((await fixture.request("/not-a-real-operation", {})).status, 404);
  assert.equal((await fixture.request("/context/create")).status, 405); assert.equal(fixture.calls.length, 0);
});

test("HTTP reads a kernel committee with exact citations; kernel retries never run the model twice", async t => {
  const fixture = await setup(t), context = await fixture.createContext(); await fixture.pin(context.id);
  const body = committeeBody(context.id, fixture.sourceRoot, "committee-http-1"), started = await fixture.committee(body);
  assert.equal(started.status, 200); assert.equal(started.data.status, "running");
  const done = await finished(fixture, context.id, started.data.id), report = done.output as CommitteeReport;
  assert.equal(done.status, "completed"); assert.equal(report.roles.length, 7); assert.equal(report.usage.modelCalls, 14); assert.equal(report.usage.toolCalls, 14);
  assert.equal(report.claims[0]!.support, "supported"); assert.ok(report.claims[0]!.citations.some(citation => citation.quote.includes("singleWriterLease")));
  assert.ok(fixture.calls.filter(call => /stage=independent/.test(call.prompt)).every(call => JSON.parse(call.prompt.match(/^PEER_FINDINGS=(.*)$/m)![1]!).length === 0));
  const before = fixture.calls.length, repeated = await fixture.committee(body);
  assert.equal(repeated.data.id, done.id); assert.equal(repeated.data.status, "completed"); assert.equal(fixture.calls.length, before);
  await assert.rejects(fixture.committee({ ...body, statements: [] }), /idempotency_conflict/);
});

test("HTTP typed replay forks exact checkpoint N with fresh authority, skips earlier analysis and preserves the original history", async t => {
  const fixture = await setup(t), context = await fixture.createContext(); await fixture.pin(context.id);
  const body = { contextId: context.id, consent: true, runtime, idempotencyKey: "replay-http-1", assumptions: "原假设：仅本地实现。",
    steps: [{ id: "resume-review", kind: "analysis", operation: "resume-review", input: {} }, { id: "job-gap-review", kind: "analysis", operation: "job-gap-review", input: {} }] };
  const created = await fixture.request<ReplayCreated>("/replay/create", body); assert.equal(created.status, 200); assert.ok("result" in created.data && created.data.result);
  assert.equal(created.data.result.status, "completed"); assert.equal(fixture.calls.length, 2);
  const original = await fixture.request<ReplayLoaded>("/replay/get", { contextId: context.id, runId: created.data.runId });
  assert.equal(original.status, 200); assert.equal(original.data.checkpoints.length, 5);
  const atN: ReplayCheckpoint = original.data.checkpoints[2]!; assert.equal(atN.analysisOutputs[0]!.stepId, "resume-review");
  const fork = await fixture.request<ReplayCreated>("/replay/fork", { contextId: context.id, consent: true, runtime, parentCheckpointId: atN.id, idempotencyKey: "fork-http-1", assumptions: "修正：设计尚未上线。" });
  assert.equal(fork.status, 200); assert.ok("result" in fork.data && fork.data.result); assert.equal(fork.data.result.status, "completed");
  assert.equal(fixture.calls.length, 3); assert.deepEqual(fork.data.result.executedSteps, ["job-gap-review"]); assert.deepEqual(fork.data.result.skippedAnalysisSteps, ["resume-review"]);
  assert.equal(fork.data.result.checkpoint.analysisOutputs[0]!.inherited, true);
  assert.notEqual(fork.data.result.checkpoint.lastAuthorityId, atN.lastAuthorityId);
  assert.ok(fork.data.result.checkpoint.forbiddenAuthorityIds.includes(atN.lastAuthorityId!));
  const after = await fixture.request<ReplayLoaded>("/replay/get", { contextId: context.id, runId: created.data.runId }); assert.deepEqual(after.data, original.data);
  const repeated = await fixture.request<ReplayCreated>("/replay/create", body); assert.equal(repeated.data.repeated, true); assert.equal(fixture.calls.length, 3);
  assert.equal((await fixture.request("/replay/create", { ...body, idempotencyKey: "effect-denied", steps: [{ id: "business-write", kind: "effect", operation: "apply-rule", input: {}, effectKey: "write" }] })).status, 400);
});

test("HTTP exact-version feedback flows through analysis, reviewed CAS rule application, actual runtime prompt loading, export and revert", async t => {
  const fixture = await setup(t), context = await fixture.createContext(); await fixture.pin(context.id);
  const identity = await fixture.request<FeedbackIdentity>("/feedback/identity", { contextId: context.id }); assert.equal(identity.status, 200); assert.equal(identity.data.versionBinding, "content_addressed_context");
  const asOf = new Date().toISOString(), noteText = "请解释本人负责的实现范围。", payload = { asOf,
    sources: [{ id: "application-source", hash: await intelligenceHash("user-imported-application-receipt"), capturedAt: asOf }, { id: "note-source", hash: await intelligenceHash(noteText), capturedAt: asOf }],
    events: [{ id: "application-event", applicationId: "application-http", resumeVersionId: identity.data.versionId, resumeContentHash: identity.data.contentHash, sourceId: "application-source", kind: "no_response", happenedAt: asOf, origin: "platform_receipt", receiptVerification: "host_verified", platformReceiptId: "untrusted-user-upload" }],
    notes: [{ id: "note-http", sourceId: "note-source", kind: "note", resumeVersionId: identity.data.versionId, resumeContentHash: identity.data.contentHash, applicationId: "application-http", happenedAt: asOf, text: noteText,
      verification: "unverified_transcript", originalAudioSourceId: null, originalAudioSha256: null, originalAudioDurationMs: null, timestampCorrectionMs: 0,
      segments: [{ id: "segment-http", startMs: 1080000, endMs: 1100000, text: noteText }], claimLinks: [{ segmentId: "segment-http", claimId: "claim-1", claimHash: identity.data.claims[0]!.hash, confirmedByUser: true, kind: "questioned", topic: "contribution" }] }] };
  const body = { contextId: context.id, consent: true, idempotencyKey: "feedback-http", payload };
  const saved = await fixture.request<FeedbackSaved>("/feedback/save", body); assert.equal(saved.status, 200); assert.equal(saved.data.snapshot.events[0]!.receiptVerification, "unverified");
  assert.equal(saved.data.snapshot.resumes[0]!.contentHash, context.sourceFingerprint); assert.equal(saved.data.snapshot.notes[0]!.verification, "unverified_transcript");
  const repeated = await fixture.request<FeedbackSaved>("/feedback/save", body); assert.equal(repeated.data.repeated, true);
  const wrong = structuredClone(body); wrong.idempotencyKey = "wrong-content"; wrong.payload.notes[0]!.resumeContentHash = "f".repeat(64); assert.equal((await fixture.request("/feedback/save", wrong)).status, 409);
  const analyzed = await fixture.request<FeedbackAnalyzed>("/feedback/analyze", { contextId: context.id, consent: true, feedbackId: saved.data.id }); assert.equal(analyzed.status, 200);
  assert.equal(analyzed.data.report.evolutionPatches.length, 1); assert.equal(analyzed.data.report.versions[0]!.unknownOutcomeApplications, 1); assert.match(analyzed.data.report.limitations.join(" "), /因果|causal|因果关系/);
  const proposal = await fixture.request<RuleProposed>("/rules/propose", { contextId: context.id, consent: true, feedbackId: saved.data.id, ruleSidecarId: "private-http-skill", target: "skill", initialContent: "原有用户确认规则。", patchIds: analyzed.data.report.evolutionPatches.map(patch => patch.id) });
  assert.equal(proposal.status, 200); assert.equal(proposal.data.sidecar.current.revision, 0); assert.equal(proposal.data.requiresExplicitConfirmation, true);
  const applyBody = { contextId: context.id, consent: true, proposalId: proposal.data.proposal.id, decisionId: "apply-http", expectedRevision: 0, confirmed: true };
  assert.equal((await fixture.request("/rules/apply", { ...applyBody, confirmed: false })).status, 400);
  const applied = await fixture.request<RuleApplied>("/rules/apply", applyBody); assert.equal(applied.status, 200); assert.equal(applied.data.runtimeOnly, true); assert.equal(applied.data.sidecar.current.revision, 1);
  const duplicateApply = await fixture.request<RuleApplied>("/rules/apply", applyBody); assert.equal(duplicateApply.data.repeated, true);
  const loaded = await fixture.request<RulesLoaded>("/rules/runtime", { contextId: context.id }); assert.equal(loaded.data.rules[0]!.sidecar.current.hash, applied.data.sidecar.current.hash);
  const replay = await fixture.request<ReplayCreated>("/replay/create", { contextId: context.id, consent: true, runtime, idempotencyKey: "replay-with-rule", assumptions: "保留未知", steps: [{ id: "resume-review", kind: "analysis", operation: "resume-review", input: {} }] });
  assert.equal(replay.status, 200); assert.ok("result" in replay.data && replay.data.result); assert.equal(replay.data.result.status, "completed");
  const modelInput = JSON.parse(fixture.calls.at(-1)!.prompt.slice(fixture.calls.at(-1)!.prompt.indexOf("\n") + 1)) as { reviewedRuntimeRules: RulesLoaded };
  assert.equal(modelInput.reviewedRuntimeRules.rules[0]!.sidecar.current.content, applied.data.sidecar.current.content);
  assert.equal((await fixture.request("/rules/export", { contextId: context.id, consent: true, ruleSidecarId: "private-http-skill", expectedRevision: 0, confirmed: true })).status, 409);
  const exported = await fixture.request<RuleExported>("/rules/export", { contextId: context.id, consent: true, ruleSidecarId: "private-http-skill", expectedRevision: 1, confirmed: true });
  assert.equal(exported.status, 200); assert.equal(exported.data.installed, false); assert.equal(exported.data.content, applied.data.sidecar.current.content); assert.equal(exported.data.sha256, applied.data.sidecar.current.hash);
  const reverted = await fixture.request<RuleReverted>("/rules/revert", { contextId: context.id, consent: true, ruleSidecarId: "private-http-skill", targetDecisionId: "apply-http", decisionId: "revert-http", expectedRevision: 1, confirmed: true });
  assert.equal(reverted.status, 200); assert.equal(reverted.data.sidecar.current.content, "原有用户确认规则。"); assert.equal(reverted.data.sidecar.current.revision, 2);
});

test("direct HTTP model operations require an explicitly pinned exact model and digest and cannot bypass pinning by forging request runtime", async t => {
  const fixture = await setup(t), context = await fixture.createContext();
  const bodies = [
    { route: "/simulation/start", body: { contextId: context.id, consent: true, runtime, idempotencyKey: "pin-check-simulation", plan: { id: "plan-pin", description: "补齐评测", hypotheticalFacts: [{ id: "hypothesis-pin", description: "新增本地评测", skillIds: ["evaluation"], contribution: "implementation" }], cost: { hours: 10, days: 14 }, sensitivities: [{ id: "conditional", realizationFraction: 1, transferability: 1 }] } } },
    { route: "/replay/create", body: { contextId: context.id, consent: true, runtime, idempotencyKey: "pin-check-replay", assumptions: "仅本地", steps: [{ id: "resume-review", kind: "analysis", operation: "resume-review", input: {} }] } },
  ];
  for (const item of bodies) {
    const unpinned = await fixture.request(item.route, item.body); assert.equal(unpinned.status, 422, `${item.route} must reject unpinned runtime`); assert.equal(unpinned.data.error, "explicit_local_runtime_required");
  }
  await fixture.pin(context.id);
  for (const item of bodies) for (const forgedRuntime of [{ ...runtime, model: "different-model" }, { ...runtime, modelDigest: "f".repeat(64) }]) {
    const forged = await fixture.request(item.route, { ...item.body, runtime: forgedRuntime }); assert.equal(forged.status, 422, `${item.route} must retain exact model+digest`); assert.equal(forged.data.error, "studio_runtime_mismatch_new_context_required");
  }
  assert.equal(fixture.calls.length, 0); assert.equal((await fixture.request("/runtime/select", { contextId: context.id, consent: true, runtime: { ...runtime, modelDigest: "f".repeat(64) } })).status, 409);
  for (const model of [runtime, { ...runtime, model: "forged" }]) {
    const retired = await fixture.request("/model", { contextId: context.id, consent: true, runtime: model, purpose: "architecture_question", payload: { question: "旧执行器不能恢复" }, idempotencyKey: "retired-model" });
    assert.equal(retired.status, 410); assert.equal(retired.data.error, "studio_model_moved_to_agent_tasks");
  }
  assert.equal(fixture.calls.length, 0);
});

test("retired committee HTTP is always 410 after authentication, never an alternate unpinned or forged generator", async t => {
  const fixture = await setup(t), context = await fixture.createContext(), body = committeeBody(context.id, fixture.sourceRoot, "retired-http");
  for (const input of [body, { ...body, runtime: { model: "forged", modelDigest: "f".repeat(64) } }, { unexpected: true }]) {
    const retired = await fixture.request("/committee/start", input);
    assert.equal(retired.status, 410); assert.equal(retired.data.error, "studio_committee_moved_to_agent_tasks");
  }
  await fixture.pin(context.id);
  assert.equal((await fixture.request("/committee/start", body)).status, 410);
  fixture.states.set("owner-a:session-a", false);
  assert.equal((await fixture.request("/committee/start", body)).status, 403);
  assert.equal(fixture.calls.length, 0); assert.deepEqual(await fixture.harnesses.get("owner-a")!.kernel.listTasks(), []);
});

test("HTTP cancellation persists its terminal outcome and rejects a late model response without automatic re-dispatch", async t => {
  const entered = deferred<void>(), release = deferred<void>(), fixture = await setup(t, async request => { entered.resolve(); await release.promise; return protocolResponse(request); });
  t.after(() => release.resolve());
  const context = await fixture.createContext(); await fixture.pin(context.id);
  const started = await fixture.committee(committeeBody(context.id, fixture.sourceRoot, "cancel-http")); assert.equal(started.status, 200); await entered.promise;
  const retired = await fixture.request("/operation/cancel", { contextId: context.id, operationId: started.data.id }); assert.equal(retired.status, 410);
  const cancelled = await fixture.harnesses.get("owner-a")!.pause(started.data.id, fixture.ownerAccess); assert.equal(cancelled.status, "paused");
  release.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
  const after = await fixture.request<StudioOperation>("/operation/read", { contextId: context.id, operationId: started.data.id }); assert.equal(after.status, 200); assert.equal(after.data.taskStatus, "paused"); assert.equal(after.data.output, undefined);
  assert.equal(fixture.calls.length, 1); const repeated = await fixture.committee(committeeBody(context.id, fixture.sourceRoot, "cancel-http")); assert.equal(repeated.data.taskStatus, "paused"); assert.equal(fixture.calls.length, 1);
});

test("HTTP capsule publication rejects a stale reviewed-source revision and serves only explicitly selected frozen fields with a separate capability", async t => {
  const fixture = await setup(t), context = await fixture.createContext(); await fixture.pin(context.id);
  const started = await fixture.committee(committeeBody(context.id, fixture.sourceRoot, "committee-for-publication"));
  const done = await finished(fixture, context.id, started.data.id), report = done.output as CommitteeReport;
  const review = { contextId: context.id, operationId: done.id, claimId: "claim-1", expectedClaimHash: report.claims[0]!.claimHash, disclosure: "publishable", review: { kind: "implementation", action: "我参与实现本地租约逻辑。", role: "参与实现，非独立作者认证", deployment: "仅本地，未上线" }, consent: true, idempotencyKey: "publication-review-1" };
  const first = await fixture.request<StudioPublicationRecord>("/publication/review", review); assert.equal(first.status, 200); assert.equal(first.data.fact.statement, claimText);
  assert.match(first.data.fact.contribution!, /本人自述/); assert.equal(JSON.stringify(first.data.fact).includes("export const"), false);
  const previewBody = { expectedWorkspaceRevision: 1, factIds: [first.data.id], selectedFields: ["statement", "contribution", "limitations"], displayName: "Synthetic Candidate", expiresAt: new Date(Date.now() + 120000).toISOString() };
  const old = await fixture.request<TwinPreview>("/twin/preview", previewBody); assert.equal(old.status, 200);
  const second = await fixture.request<StudioPublicationRecord>("/publication/review", { ...review, idempotencyKey: "publication-review-2" }); assert.equal(second.status, 200);
  const stale = await fixture.request("/twin/publish", { previewId: old.data.id, expectedPreviewHash: old.data.previewHash, consent: true }); assert.equal(stale.status, 403); assert.equal(stale.data.error, "twin_workspace_revision_changed");
  const preview = await fixture.request<TwinPreview>("/twin/preview", { ...previewBody, expectedWorkspaceRevision: 2 }); assert.equal(preview.status, 200);
  assert.equal((await fixture.request("/twin/publish", { previewId: preview.data.id, expectedPreviewHash: preview.data.previewHash, consent: true }, { owner: "owner-b", session: "session-b" })).status, 404);
  const published = await fixture.request<CandidateCapsule>("/twin/publish", { previewId: preview.data.id, expectedPreviewHash: preview.data.previewHash, consent: true }); assert.equal(published.status, 200);
  assert.equal(published.data.workspaceRevision, 2); assert.equal(published.data.facts.length, 1); assert.equal(published.data.facts[0]!.fields.statement, claimText);
  assert.deepEqual(Object.keys(published.data.facts[0]!.fields).sort(), ["contribution", "limitations", "statement"]); assert.equal(JSON.stringify(published.data).includes("singleWriterLease"), false);
  const issued = await fixture.request<{ token: string; capabilityUrl: string }>("/twin/token-issue", { target: "capsule", capsuleId: published.data.id, capsuleHash: published.data.hash, scopes: ["capsule:read", "capsule:ask"], expiresAt: new Date(Date.now() + 60000).toISOString(), maxCalls: 4 }); assert.equal(issued.status, 200);
  const url = new URL(issued.data.capabilityUrl); assert.equal(url.search, ""); assert.equal(url.pathname.includes("owner-a"), false);
  const shell = await fetch(url, { signal: AbortSignal.timeout(5000) }); const html = await shell.text(); assert.equal(shell.status, 200); assert.equal(html.includes(claimText), false); assert.equal(html.includes(issued.data.token), false);
  const page = await fetch(`${url.origin}${url.pathname}`, { headers: { Authorization: `Bearer ${issued.data.token}` }, signal: AbortSignal.timeout(5000) }); assert.equal(page.status, 200); assert.match(await page.text(), /实现本机单写者租约/);
  const unknown = await fetch(`${url.origin}${url.pathname}/ask`, { method: "POST", headers: { Authorization: `Bearer ${issued.data.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ question: "候选人的薪资是多少？" }), signal: AbortSignal.timeout(5000) }); assert.equal(unknown.status, 200); assert.equal((await unknown.json() as { unknown: boolean }).unknown, true);
  const revoked = await fixture.request("/twin/revoke", { capsuleId: published.data.id, expectedHash: published.data.hash }); assert.equal(revoked.status, 200);
  const after = await fetch(`${url.origin}${url.pathname}`, { headers: { Authorization: `Bearer ${issued.data.token}` }, signal: AbortSignal.timeout(5000) }); assert.equal(after.status, 403);
});

test("real authenticated Host keeps Career Studio storage lazy for legacy private records and creates it only for an explicit Studio request", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-studio-lazy-http-"))), identityDirectory = path.join(directory, "identities"), token = "synthetic-lazy-transport";
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: ["http://fixture.invalid"], checkpointer: new MemorySaver() as never,
    identityDirectory, runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "legacy-understanding"), chatGptDirectory: path.join(directory, "legacy-chatgpt"), runtimeDefinitions: [] });
  t.after(async () => { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise(resolve => setImmediate(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  const a = await registerTestIdentity(origin, token, "synthetic-lazy-a", "http://fixture.invalid"), b = await registerTestIdentity(origin, token, "synthetic-lazy-b", "http://fixture.invalid");
  const call = (ownerHeaders: Record<string, string>, route: string, body?: unknown) => fetch(`${origin}/api/v1/agent${route}`, { method: body === undefined ? "GET" : "POST", headers: { ...ownerHeaders, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: "http://fixture.invalid" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const aStudio = path.join(identityDirectory, "owners", a.principal.id, "career-studio-v1"), bStudio = path.join(identityDirectory, "owners", b.principal.id, "career-studio-v1");
  assert.equal((await call(a.headers, "/records/continuity?key=synthetic-legacy")).status, 200);
  assert.equal((await call(a.headers, "/records/continuity?key=synthetic-legacy", { expectedRevision: 0, value: { workspaceKey: "synthetic-legacy", revision: 1, messages: ["合成旧业务记录"] } })).status, 200);
  assert.equal((await call(b.headers, "/records/continuity?key=synthetic-legacy")).status, 200);
  await assert.rejects(fs.stat(aStudio), { code: "ENOENT" }); await assert.rejects(fs.stat(bStudio), { code: "ENOENT" });
  assert.equal((await call(a.headers, "/career-studio/feedback/identity", { contextId: "not-yet-selected" })).status, 409);
  assert.ok((await fs.stat(path.join(aStudio, "artifacts.sqlite"))).isFile()); await assert.rejects(fs.stat(bStudio), { code: "ENOENT" });
  const original = await call(a.headers, "/records/continuity?key=synthetic-legacy"); assert.equal(original.status, 200); assert.match(await original.text(), /合成旧业务记录/);
});
