import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CareerStudio } from "../src/career-studio/service.js";
import { EvidenceBroker } from "../src/understanding/evidence-broker.js";
import type { LocalCompletionRequest, LocalOllamaClient } from "../src/privacy/local-ollama.js";
import type { StudioAccess, StudioContext, StudioContextInput, StudioOperation } from "../src/career-studio/contracts.js";
import type { CommitteeReport } from "@better-me/core/career-intelligence";
import type { VerifiedJobResolver } from "../src/career-studio/verified-jobs.js";
import { createStudioCommitteeHarness, committeeSchema } from "./fixtures/studio-committee.js";

const runtime = { model: "synthetic-protocol-client", modelDigest: "a".repeat(64) };
const access: StudioAccess = { session: "session-a", valid: async () => true };
const claimText = "实现本机单写者租约，避免并发重复接纳。";
const input = (): StudioContextInput => ({ workspaceKey: "workspace-a", resumeId: "resume-a", sourceFingerprint: "b".repeat(64), consent: true,
  claims: [{ id: "claim-1", text: claimText, skillIds: ["sqlite"], contribution: "implementation", confirmedByUser: true, confirmedNumericTokens: [] }],
  jobs: [{ id: "job-1", title: "Synthetic Engineer", company: "Synthetic Company", description: "需要SQLite与评测。", sourceUrl: null, platform: "manual", capturedAt: new Date().toISOString(),
    firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: new Date().toISOString(), publishedAt: null, availability: "unknown", verifiedAt: null,
    companyKey: "company-1", locationKey: "office-1", roleKey: "engineer", skillIds: ["sqlite", "evaluation"], salaryText: "未知" }] });
type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(t: test.TestContext, complete?: (request: LocalCompletionRequest) => Promise<string>, resolveVerifiedJob?: VerifiedJobResolver) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-studio-service-"))), sourceRoot = path.join(directory, "synthetic-project"), privateRoot = path.join(directory, "private-studio");
  await fs.mkdir(sourceRoot); const sourceFile = path.join(sourceRoot, "service.ts");
  await fs.writeFile(sourceFile, `// ${claimText}\nexport const singleWriterLease = true;\n`, { mode: 0o600 });
  const studios: CareerStudio[] = [], calls: LocalCompletionRequest[] = [];
  const client: LocalOllamaClient = { binding: async () => ({ id: "synthetic-local", version: "synthetic-v1", location: "local", endpointFingerprint: "c".repeat(64), model: runtime.model, modelDigest: runtime.modelDigest }),
    complete: async request => { calls.push(request); return complete ? complete(request) : protocolResponse(request); } };
  const broker = new EvidenceBroker({ forbiddenRoots: [privateRoot] });
  const harnesses = new Map<CareerStudio, ReturnType<typeof createStudioCommitteeHarness>>();
  const open = (ownerId = "owner-a") => {

    const harness = createStudioCommitteeHarness({ ownerId, directory: path.join(privateRoot, "tasks"), broker, studio: () => studio, complete: request => client.complete(request) });
    const studio: CareerStudio = new CareerStudio({ ownerId, directory: privateRoot, broker, localClient: () => client, committeeTasks: harness.tasks, ...(resolveVerifiedJob ? { resolveVerifiedJob } : {}) });
    harnesses.set(studio, harness); studios.push(studio); return studio;
  };
  const studio = open();
  t.after(async () => { for (const harness of harnesses.values()) await harness.close(); for (const opened of studios) opened.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const committee = async (body: unknown, selected: StudioAccess) => {
    const { contextId, runtime: chosen } = body as { contextId: string; runtime: typeof runtime };
    if (!studio.store.get("context-runtime", contextId)) studio.store.put("context-runtime", contextId, 0, { runtime: chosen, session: selected.session });
    return harnesses.get(studio)!.start(body, selected);
  };
  return { directory, sourceRoot, sourceFile, privateRoot, open, studio, calls, broker, committee, harnesses, harness: harnesses.get(studio)! };
}
/** Exercises the actual Host prompt/tool protocol, never reads expected assertions or bypasses its citation schema. */
function protocolResponse(request: LocalCompletionRequest): string {
  request.signal.throwIfAborted();
  const selected = JSON.parse(request.prompt.match(/^SELECTED_SNAPSHOT=(.*)$/m)![1]!) as { claims: Array<{ id: string }>; evidenceCatalog: Array<{ id: string; startLine: number; endLine: number }> };
  const role = request.prompt.match(/Role=(\w+);/)![1]!;
  const schema = committeeSchema(request);
  if (schema.properties.kind.const === "request_evidence") return JSON.stringify({ kind: "request_evidence", requests: selected.evidenceCatalog.slice(0, 8).map(item => ({ evidenceId: item.id, startLine: item.startLine, endLine: item.endLine })) });
  const citations = JSON.parse(request.prompt.match(/^HOST_CITATION_CATALOG=(.*)$/m)![1]!);
  return JSON.stringify({ kind: "assessment", role, summary: "仅核对本次授权证据；不是独立作者认证。", claims: selected.claims.map(claim => ({ claimId: claim.id, support: citations.length ? "supported" : "unknown", citations,
    counterCitations: [], risks: [], missing: [], questions: ["请解释明确认领的个人贡献与失败恢复边界。"], defense: [] })) });
}
const committeeBody = (contextId: string, fixture: Fixture, key = "committee-1") => ({ contextId, idempotencyKey: key, consent: true, runtime, claimIds: ["claim-1"],
  statements: [{ label: "本人确认的贡献自述", kind: "user_statement", text: claimText }], code: [{ root: fixture.sourceRoot, files: [{ path: "service.ts", startLine: 1, endLine: 2 }] }] });
async function finished(studio: CareerStudio, contextId: string, operationId: string): Promise<StudioOperation> {
  for (let turn = 0; turn < 400; turn++) {
    const operation = await studio.operation({ contextId, operationId }, access);
    if (operation.status !== "running") return operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("synthetic studio operation did not converge within bounded polling");
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("context selection is owner/session/content-bound, rejects sensitive/duplicate input and stays a selected snapshot", async t => {
  const fixture = await setup(t), { studio } = fixture;
  const created = await studio.createContext(input(), access);
  assert.equal(created.context.ownerId, "owner-a"); assert.equal(created.context.session, access.session); assert.equal(created.claimHashes["claim-1"]?.length, 64);
  assert.match(created.limitations.join(" "), /不是业务库版本回执/);
  await assert.rejects(studio.getContext(created.context.id, { ...access, session: "other-session" }), /studio_context_stale/);
  await assert.rejects(studio.getContext(created.context.id, { ...access, valid: async () => false }), /studio_interaction_invalid/);
  await assert.rejects(studio.createContext({ ...input(), claims: [input().claims[0], input().claims[0]] }, access), /duplicate_studio_input/);
  const sensitive = input(); sensitive.claims[0]!.text = "api_key = 'synthetic-credential-not-a-real-secret'";
  await assert.rejects(studio.createContext(sensitive, access), /studio_sensitive_or_large_input/);
  assert.throws(() => fixture.open("owner-b"), /studio_owner_mismatch/);
});

test("committee facade uses real bounded EvidenceBroker excerpts and four independent model roles, not a fixed completed report", async t => {
  const fixture = await setup(t), context = (await fixture.studio.createContext(input(), access)).context;
  const pending = await fixture.committee(committeeBody(context.id, fixture), access);
  assert.equal(pending.status, "running");
  const operation = await finished(fixture.studio, context.id, pending.id), report = operation.output as CommitteeReport;
  assert.equal(operation.status, "completed", operation.errorCode); assert.equal(report.status, "completed");
  assert.equal(report.roles.length, 7); assert.equal(report.usage.modelCalls, 14); assert.equal(report.usage.toolCalls, 14);
  assert.equal(report.claims[0]!.support, "supported");
  assert.ok(report.claims[0]!.citations.some(citation => citation.quote.includes("singleWriterLease")));
  const snapshot = (await fixture.harness.kernel.describeStudioCommittee(pending.id, access)).snapshot;
  const source = snapshot.evidence.find(item => item.provenance === "source")!;
  assert.equal(source.startLine, 1); assert.equal(source.endLine, 2); assert.equal(source.sourceHash.length, 64);
  const firstCalls = fixture.calls.filter(call => /stage=independent/.test(call.prompt));
  assert.equal(firstCalls.length, 8);
  for (const call of firstCalls) assert.deepEqual(JSON.parse(call.prompt.match(/^PEER_FINDINGS=(.*)$/m)![1]!), []);
  const before = fixture.calls.length, repeated = await fixture.committee(committeeBody(context.id, fixture), access);
  assert.equal(repeated.id, operation.id); assert.equal(repeated.status, "completed"); assert.equal(fixture.calls.length, before);
  await assert.rejects(fixture.committee({ ...committeeBody(context.id, fixture), claimIds: [] }, access));
  await assert.rejects(fixture.committee({ ...committeeBody(context.id, fixture), statements: [] }, access), /idempotency_conflict/);
});

test("unchecked personal contribution cannot be promoted by source code or model agreement", async t => {
  const fixture = await setup(t), selected = input(); selected.claims[0]!.confirmedByUser = false;
  const context = (await fixture.studio.createContext(selected, access)).context, pending = await fixture.committee(committeeBody(context.id, fixture), access);
  const operation = await finished(fixture.studio, context.id, pending.id), report = operation.output as CommitteeReport;
  assert.equal(report.claims[0]!.support, "unknown");
  assert.equal(report.claims[0]!.contribution, "unknown");
  assert.ok(report.issues.some(issue => issue.code === "personal_contribution_unknown"));
});

test("cancellation and late responses never turn an in-flight model result into an adopted completed operation", async t => {
  const started = deferred<void>(), release = deferred<void>();
  const fixture = await setup(t, async request => { started.resolve(); await release.promise; return protocolResponse(request); });
  const context = (await fixture.studio.createContext(input(), access)).context, pending = await fixture.committee(committeeBody(context.id, fixture), access);
  await started.promise;
  await assert.rejects(fixture.studio.cancel({ contextId: context.id, operationId: pending.id }, access), /studio_committee_controls_moved_to_agent_tasks/);
  const cancelled = await fixture.harness.pause(pending.id, access);
  assert.equal(cancelled.status, "paused"); release.resolve();
  await new Promise(resolve => setTimeout(resolve, 15));
  const after = await fixture.studio.operation({ contextId: context.id, operationId: pending.id }, access);
  assert.equal(after.taskStatus, "paused"); assert.ok(!after.output);
});

test("source revision changes during kernel dispatch reject adoption of old code", async t => {
  let file = "", changed = false;
  const fixture = await setup(t, async request => {
    const output = protocolResponse(request);
    if (!changed) { changed = true; await fs.writeFile(file, "// different source version\nexport const unrelated = false;\n", { mode: 0o600 }); }
    return output;
  }); file = fixture.sourceFile;
  const context = (await fixture.studio.createContext(input(), access)).context, pending = await fixture.committee(committeeBody(context.id, fixture), access);
  const operation = await finished(fixture.studio, context.id, pending.id);
  assert.notEqual(operation.status, "completed"); assert.equal(operation.errorCode, "studio_source_changed");
  const report = operation.output as CommitteeReport; assert.equal(report.status, "failed"); assert.equal(report.claims[0]!.support, "unknown");
});

test("kernel and SQLite restart revoke old context, preserve interrupted task and never replay models", async t => {
  const started = deferred<void>(), release = deferred<void>();
  const fixture = await setup(t, async request => { started.resolve(); await release.promise; return protocolResponse(request); });
  const context = (await fixture.studio.createContext(input(), access)).context, pending = await fixture.committee(committeeBody(context.id, fixture), access);
  await started.promise; await fixture.harness.close(); fixture.studio.close(); const calls = fixture.calls.length, restarted = fixture.open();
  assert.equal(restarted.store.get<StudioContext>("context", context.id)!.value.revoked, true);
  assert.equal(restarted.store.get("operation", pending.id), undefined, "new tasks never gain a second SQLite execution record");
  const resumedKernel = fixture.harnesses.get(restarted)!.kernel;
  assert.equal((await resumedKernel.readTask(pending.id)).status, "interrupted");
  await assert.rejects(restarted.getContext(context.id, access), /studio_context_stale/);
  release.resolve(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(fixture.calls.length, calls);
  assert.equal((await resumedKernel.readTask(pending.id)).status, "interrupted");
});

test("retired direct committee executor rejects generation without model calls or artifacts", async t => {
  const fixture = await setup(t), context = (await fixture.studio.createContext(input(), access)).context;
  await assert.rejects(fixture.studio.committee(committeeBody(context.id, fixture), access), error => error instanceof Error && "status" in error && error.status === 410);
  assert.equal(fixture.calls.length, 0); assert.deepEqual(await fixture.harness.kernel.listTasks(), []);
  assert.equal(fixture.studio.store.list("operation", 100).length, 0);
});

test("retired committee generation preserves complete legacy history without a new task or SQLite rewrite", async t => {
  const fixture = await setup(t), context = (await fixture.studio.createContext(input(), access)).context;
  const at = new Date().toISOString(), legacy: StudioOperation = { id: "d".repeat(64), contextId: context.id, kind: "committee", inputHash: "e".repeat(64),
    status: "completed", startedAt: at, updatedAt: at, output: { historicalText: "  历史完整记录😀\r\n不代表当前采用授权。\r\nTAIL  " } };
  fixture.studio.store.put("operation", legacy.id, 0, legacy);
  const before = JSON.stringify(fixture.studio.store.get("operation", legacy.id));
  assert.deepEqual(await fixture.studio.operation({ contextId: context.id, operationId: legacy.id }, access), legacy);
  assert.deepEqual((await fixture.studio.history({ contextId: context.id }, access)).operations, [legacy]);
  await assert.rejects(fixture.studio.committee(committeeBody(context.id, fixture), access), /studio_committee_moved_to_agent_tasks/);
  assert.equal(JSON.stringify(fixture.studio.store.get("operation", legacy.id)), before);
  assert.deepEqual(await fixture.harness.kernel.listTasks(), []); assert.equal(fixture.calls.length, 0);
});

test("simulation uses frozen explicit skills/self-report weight, cannot unlock unknown salaries or job availability", async t => {
  const fixture = await setup(t), context = (await fixture.studio.createContext(input(), access)).context;
  const plan = { id: "two-week-evals", description: "补齐评测。", hypotheticalFacts: [{ id: "hypothesis-eval", description: "假设完成评测", skillIds: ["evaluation"], contribution: "implementation" }], cost: { days: 14, hours: 28 },
    sensitivities: [{ id: "full", realizationFraction: 1, transferability: 1 }] };
  const pending = await fixture.studio.simulation({ contextId: context.id, idempotencyKey: "simulation-1", consent: true, runtime, plan }, access);
  const operation = await finished(fixture.studio, context.id, pending.id), report = operation.output as { baseline: { distribution: { mean: number } }; scenarios: Array<{ distribution: { mean: number }; conditionalUnlocks: string[]; highSalaryConditionalUnlocks: string[] }> };
  assert.equal(operation.status, "completed"); assert.equal(report.baseline.distribution.mean, 25); assert.equal(report.scenarios[0]!.distribution.mean, 75);
  assert.deepEqual(report.scenarios[0]!.conditionalUnlocks, []); assert.deepEqual(report.scenarios[0]!.highSalaryConditionalUnlocks, []);
  assert.equal(fixture.calls.length, 0, "deterministic coverage is not faked as a model run");
});

test("forensics preserves missing salary/activity/availability and only groups explicit bound company-role-location", async t => {
  const fixture = await setup(t), selected = input(); selected.jobs.push({ ...selected.jobs[0]!, id: "job-2", companyKey: null, platform: "another-board" });
  const context = (await fixture.studio.createContext(selected, access)).context;
  const pending = await fixture.studio.forensics({ contextId: context.id, idempotencyKey: "forensics-1", consent: true, publicObservations: [] }, access);
  const operation = await finished(fixture.studio, context.id, pending.id), report = operation.output as { signals: Array<{ code: string; sourceRefs: unknown[]; uncertainty: string[] }>; unknowns: string[]; mergeProposals: unknown[]; limitations: string[] };
  assert.equal(operation.status, "completed"); assert.deepEqual(report.mergeProposals, []);
  assert.ok(report.unknowns.includes("unresolved_job_binding:job-2")); assert.ok(report.unknowns.includes("salary_unknown:job-1"));
  assert.ok(report.unknowns.includes("availability_unknown:job-1")); assert.match(report.limitations.join(" "), /not proof of a ghost job/);
  assert.ok(report.signals.every(signal => signal.sourceRefs.length > 0 && signal.uncertainty.length > 0));
  assert.doesNotMatch(JSON.stringify(report), /45h|合规核验通过|社区已交叉核验/);
});

test("publication review revalidates source versions after committee completion before creating any publishable evidence record", async t => {
  const fixture = await setup(t), created = await fixture.studio.createContext(input(), access), context = created.context;
  const pending = await fixture.committee(committeeBody(context.id, fixture), access), operation = await finished(fixture.studio, context.id, pending.id);
  assert.equal(operation.status, "completed");
  await fs.writeFile(fixture.sourceFile, "// source changed after completion\nexport const noLongerSame = false;\n", { mode: 0o600 });
  await assert.rejects(fixture.studio.publicationReview({ contextId: context.id, operationId: operation.id, claimId: "claim-1", expectedClaimHash: created.claimHashes["claim-1"], disclosure: "publishable",
    review: { kind: "implementation", action: "本人实现租约接纳。", role: "开发者", deployment: "未提供上线证据。" }, consent: true, idempotencyKey: "publish-1" }, access), /stale|changed|source/);
  assert.equal(fixture.studio.store.list("publication-review").length, 0);
});

test("publication/badge do not fabricate source truth, engineering metrics or an independent authorship certificate", async t => {
  const fixture = await setup(t), created = await fixture.studio.createContext(input(), access), context = created.context;
  const pending = await fixture.committee(committeeBody(context.id, fixture), access), operation = await finished(fixture.studio, context.id, pending.id);
  const publication = await fixture.studio.publicationReview({ contextId: context.id, operationId: operation.id, claimId: "claim-1", expectedClaimHash: created.claimHashes["claim-1"], disclosure: "publishable",
    review: { kind: "implementation", action: "本人实现租约接纳。", role: "开发者", deployment: "未提供上线证据。" }, consent: true, idempotencyKey: "publish-safe" }, access);
  assert.match(publication.fact.contribution ?? "", /本人自述，非独立作者认证/); assert.match(publication.fact.limitations ?? "", /不证明生产规模、独立真实性/);
  assert.ok(publication.fact.evidence?.every(item => !item.summary.includes("singleWriterLease")), "raw private code is not published");
  const badgePending = await fixture.studio.badge({ contextId: context.id, publicationId: publication.id, render: false, consent: true, idempotencyKey: "badge-safe" }, access);
  const badgeOperation = await finished(fixture.studio, context.id, badgePending.id), output = badgeOperation.output as { badge: { mapping: Array<{ value: unknown }>; parameters: { facets: number; ior: number } }; limitations: string[] };
  assert.equal(badgeOperation.status, "completed"); assert.ok(output.badge.mapping.every(metric => metric.value === null));
  assert.equal(output.badge.parameters.facets, 6); assert.equal(output.badge.parameters.ior, 1.4);
  assert.match(output.limitations.join(" "), /未知/);
});

async function publicationFixture(fixture: Fixture, selected = input()) {
  const created = await fixture.studio.createContext(selected, access), context = created.context;
  const pending = await fixture.committee(committeeBody(context.id, fixture), access), operation = await finished(fixture.studio, context.id, pending.id);
  const publication = await fixture.studio.publicationReview({ contextId: context.id, operationId: operation.id, claimId: "claim-1", expectedClaimHash: created.claimHashes["claim-1"], disclosure: "publishable",
    review: { kind: "implementation", action: "本人实现租约接纳。", role: "开发者", deployment: "未提供上线证据。" }, consent: true, idempotencyKey: "publish-metrics" }, access);
  return { context, publication };
}

test("badge Host reads actual selected JSON and bound LCOV through broker and exposes source hashes distinct from claim hash", async t => {
  const fixture = await setup(t), { context, publication } = await publicationFixture(fixture);
  const source = await fs.readFile(fixture.sourceFile, "utf8"), table = '{"idle":{"START":"running"},"running":{"DONE":"done","FAIL":"idle"}}', report = "SF:src/service.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record";
  await fs.writeFile(path.join(fixture.sourceRoot, "states.json"), table); await fs.writeFile(path.join(fixture.sourceRoot, "hits.txt"), report);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  await fs.writeFile(path.join(fixture.sourceRoot, "manifest.json"), JSON.stringify({ protocol: "betterme.coverage-source-binding.v1", reportHash: digest(report), files: [{ reportPath: "src/service.ts", sourcePath: "service.ts", sourceHash: digest(source) }] }));
  const pending = await fixture.studio.badge({ contextId: context.id, publicationId: publication.id, render: false, consent: true, idempotencyKey: "badge-measured",
    metricSources: { root: fixture.sourceRoot, transition: { file: { path: "states.json", startLine: 1, endLine: 1 }, format: "json" },
      coverage: { report: { path: "hits.txt", startLine: 1, endLine: 6 }, manifest: { path: "manifest.json", startLine: 1, endLine: 1 }, sources: [{ path: "service.ts", startLine: 1, endLine: 2 }], format: "lcov" } } }, access);
  const operation = await finished(fixture.studio, context.id, pending.id), output = operation.output as { badge: { observation: { sourceHash: string }; parameters: { facets: number; ior: number } }; measurement: { status: string; metrics: Record<string, { value: number; sourceHashes: string[] }>; metricReceipts: Array<{ targetHash: string; executionVerified: boolean; inputs: unknown[] }> } };
  assert.equal(operation.status, "completed", operation.errorCode); assert.equal(output.measurement.status, "observed");
  assert.equal(output.badge.parameters.facets, 8); assert.equal(output.badge.parameters.ior, 1.5); assert.equal(output.measurement.metrics["testCoveragePercent"]!.value, 50);
  assert.deepEqual(output.measurement.metrics["declaredTransitionEntries"]!.sourceHashes, [digest(table)]); assert.notEqual(digest(table), output.badge.observation.sourceHash);
  assert.ok(output.measurement.metricReceipts.every(receipt => receipt.targetHash === publication.claimHash && receipt.executionVerified === false));
  await assert.rejects(fixture.studio.badge({ contextId: context.id, publicationId: publication.id, render: false, consent: true, idempotencyKey: "badge-forged", metrics: { testCoveragePercent: 99 } }, access));
});

test("badge map links ignore fabricated HTTP coordinate authority and only use independently registered same-job authority", async t => {
  const coordinates = { longitude: 1, latitude: 2, verified: true, precision: "office" as const, persisted: true, indexed: true }, selected = input(); selected.jobs[0]!.coordinates = coordinates;
  const untrusted = await setup(t), first = await publicationFixture(untrusted, selected);
  const a = await untrusted.studio.badge({ contextId: first.context.id, publicationId: first.publication.id, render: false, consent: true, idempotencyKey: "no-fake-map" }, access);
  const untrustedOutput = (await finished(untrusted.studio, first.context.id, a.id)).output as { links: { links: unknown[] } }; assert.deepEqual(untrustedOutput.links.links, []);
  const trusted = await setup(t, undefined, async jobId => ({ jobId, locationId: "real-source-office", sourceHash: "d".repeat(64), locationHash: "e".repeat(64), snapshotRevision: 7, persisted: true, indexed: true,
    verification: "verified", kind: "office", precision: "address", coordinates: { longitude: 121.5, latitude: 31.2, coordinateSystem: "WGS84" } })), second = await publicationFixture(trusted, selected);
  const b = await trusted.studio.badge({ contextId: second.context.id, publicationId: second.publication.id, render: false, consent: true, idempotencyKey: "trusted-map" }, access);
  const links = ((await finished(trusted.studio, second.context.id, b.id)).output as { links: { links: Array<{ longitude: number; sourceHash: string }> } }).links.links;
  assert.equal(links.length, 1); assert.equal(links[0]!.longitude, 121.5); assert.equal(links[0]!.sourceHash, "d".repeat(64)); assert.notEqual(links[0]!.longitude, coordinates.longitude);
});

test("metric bytes changed after provisional measurement invalidate the entire badge instead of retaining measured geometry", async t => {
  const fixture = await setup(t), { context, publication } = await publicationFixture(fixture), tablePath = path.join(fixture.sourceRoot, "states.json");
  await fs.writeFile(tablePath, '{"idle":{"START":"running"}}');
  const execute = fixture.broker.execute.bind(fixture.broker); let reads = 0;
  t.mock.method(fixture.broker, "execute", async (...args: Parameters<EvidenceBroker["execute"]>) => {
    const value = await execute(...args); if (args[1].operation === "read" && args[1].path === "states.json" && ++reads === 3) await fs.writeFile(tablePath, '{"idle":{"START":"running","FAIL":"done"}}'); return value;
  });
  const pending = await fixture.studio.badge({ contextId: context.id, publicationId: publication.id, render: false, consent: true, idempotencyKey: "badge-late-source",
    metricSources: { root: fixture.sourceRoot, transition: { file: { path: "states.json", startLine: 1, endLine: 1 }, format: "json" } } }, access);
  const operation = await finished(fixture.studio, context.id, pending.id); assert.equal(operation.status, "failed"); assert.equal(operation.errorCode, "studio_badge_measurement_stale"); assert.equal(operation.output, undefined);
});
