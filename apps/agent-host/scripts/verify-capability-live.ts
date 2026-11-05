/** Actual local model acceptance. No injected builder or prewritten candidate. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DocumentSchema } from "@better-me/core/document";
import { MemorySaver } from "@langchain/langgraph";
import { syntheticJobComparison, syntheticEvidenceReview, type EvidenceReviewInput, type CapabilitySnapshot, type CapabilityTask } from "@better-me/agent-contracts";
import { createAgentServer } from "../src/server.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-live-"));
const serve = process.argv.includes("--serve"), adoption = process.argv.includes("--adoption"), handoff = adoption || process.argv.includes("--handoff"), m2 = handoff || process.argv.includes("--m2");
const webPort = adoption ? 5396 : handoff ? 5395 : m2 ? 5394 : 5393, port = serve ? adoption ? 5402 : handoff ? 5401 : m2 ? 5400 : 5399 : 0;
const webHost = adoption ? "capability-adoption.localhost" : handoff ? "capability-review.localhost" : m2 ? "capability-m2.localhost" : "capability-regression.localhost";
const server = createAgentServer({ host: "127.0.0.1", port, authToken: "better-me-agent-token",
  allowedOrigins: [`http://${webHost}:${webPort}`, `http://127.0.0.1:${webPort}`],
  identityDirectory: path.join(directory, "accounts"), runsDirectory: path.join(directory, "runs"),
  runtimeDefinitions: [], checkpointer: new MemorySaver() as never });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const auth = { Authorization: "Bearer better-me-agent-token", "Content-Type": "application/json" };
const register = await fetch(`${origin}/api/v1/agent/identity/register`, { method: "POST", headers: auth,
  body: JSON.stringify({ username: "capability-lab", password: "synthetic-career-only-2026", displayName: "合成验收账号" }) });
assert.equal(register.status, 200); const identity = await register.json() as { principal: { id: string } };
const headers = { ...auth, Cookie: register.headers.getSetCookie()[0]!.split(";")[0]!, "X-BetterMe-Owner": identity.principal.id };
async function snapshot() {
  const response = await fetch(`${origin}/api/v1/agent/capabilities`, { headers });
  assert.equal(response.status, 200, await response.clone().text()); return await response.json() as CapabilitySnapshot;
}
async function run(round: number, evidence?: EvidenceReviewInput) {
  const prior = await snapshot();
  const response = await fetch(`${origin}/api/v1/agent/capabilities/tasks`, { method: "POST", headers,
    body: JSON.stringify({ input: evidence ? syntheticEvidenceReview(round).input : syntheticJobComparison(round),
      ...(evidence ? { evidence, intent: "prepare-evidence-review" } : {}), idempotencyKey: `live-${evidence ? "evidence" : "comparison"}-${round}`,
      expectedCatalogRevision: prior.catalogRevision, consent: true }) });
  assert.equal(response.status, 202, await response.clone().text());
  const { task } = await response.json() as { task: CapabilityTask }; let last = "";
  const deadline = Date.now() + 560_000;
  while (Date.now() < deadline) {
    const current = (await snapshot()).tasks.find(item => item.id === task.id)!;
    const progress = `${current.stage}:${current.builderCalls}:${current.events.at(-1)?.detail}`;
    if (last !== progress) { console.log(JSON.stringify({ business: evidence ? "evidence-review" : "comparison", round, progress })); last = progress; }
    if (["completed", "failed", "cancelled", "partial", "interrupted"].includes(current.stage)) return current;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error("live_acceptance_deadline");
}
try {
  console.log(JSON.stringify({ isolation: "synthetic-only", directory, host: origin, provider: "ollama-local", model: "gemma4:e2b-it-qat" }));
  const first = await run(1);
  assert.equal(first.stage, "completed", JSON.stringify({ error: first.error, builds: first.builds.map(b => ({ status: b.status, error: b.error, qualification: b.qualification })) }));
  assert.ok(first.builderCalls > 0); assert.equal(first.builds.at(-1)?.provider, "ollama-local");
  assert.equal(first.qualification?.status, "passed"); assert.equal(first.taskVerification?.status, "passed"); assert.ok(first.receipt);
  assert.deepEqual(first.output?.changes[0]?.added, ["PostgreSQL"]);
  const second = await run(2);
  assert.equal(second.stage, "completed"); assert.equal(second.builderCalls, 0); assert.deepEqual(second.selected, first.selected);
  assert.notEqual(second.inputHash, first.inputHash); assert.notEqual(second.receipt?.id, first.receipt?.id);
  assert.deepEqual(second.output?.changes[0]?.added, ["Kubernetes"]);
  assert.ok(!JSON.stringify(second).includes("FIRST-ONLY-CANARY-7319"));
  console.log(JSON.stringify({ passed: true, directory, ownerId: identity.principal.id,
    first: { id: first.id, inputHash: first.inputHash, builderCalls: first.builderCalls, selected: first.selected, receipt: first.receipt },
    second: { id: second.id, inputHash: second.inputHash, builderCalls: second.builderCalls, selected: second.selected, receipt: second.receipt } }));
  if (m2) {
    const a = await run(1, syntheticEvidenceReview(1).evidence), b = await run(2, syntheticEvidenceReview(2).evidence);
    for (const task of [a, b]) {
      assert.equal(task.stage, "completed"); assert.equal(task.builderCalls, 0); assert.deepEqual(task.selected, first.selected);
      assert.equal(task.taskVerification?.status, "passed"); assert.equal(task.taskVerification?.verifierVersion, "job-evidence-check-v1");
      assert.equal(task.evidenceReport?.items.length, 4); assert.ok(task.receipt); assert.equal(task.output, undefined);
      assert.ok(task.evidenceReport.items.every(item => ["needs_evidence", "needs_personal_confirmation"].includes(item.status)));
    }
    assert.equal(a.evidenceReport?.items[2]?.status, "needs_personal_confirmation");
    assert.equal(b.evidenceReport?.items[1]?.status, "needs_personal_confirmation");
    assert.equal(b.evidenceReport?.items[2]?.status, "needs_evidence");
    assert.notEqual(a.inputHash, b.inputHash); assert.notEqual(a.receipt?.id, b.receipt?.id); assert.deepEqual(a.composition, b.composition);
    assert.ok(!JSON.stringify(b).includes("EVIDENCE-FIRST-ONLY-8421"));
    const state = await snapshot(); assert.equal(state.versions.length, 1);
    assert.equal(state.tasks.reduce((sum, task) => sum + task.builderCalls, 0), first.builderCalls);
    assert.deepEqual(state.tasks.find(task => task.id === first.id), first);
    console.log(JSON.stringify({ m2Passed: true, directory, ownerId: identity.principal.id,
      tasks: [a, b].map(task => ({ id: task.id, builderCalls: task.builderCalls, inputHash: task.inputHash,
        selected: task.selected, composition: task.composition, receipt: task.receipt })) }));
    if (handoff) {
      async function command(route: string, body: unknown, status = 200) {
        const response = await fetch(`${origin}/api/v1/agent/capabilities/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, status, await response.clone().text()); return response.json();
      }
      const binding = { taskId: b.id, reportReceiptId: b.receipt!.id, reportHash: b.outputHash!, itemIndex: 1, consent: true };
      const reviewed = await command("evidence-review", { ...binding, expectedRevision: 0, idempotencyKey: "live-personal-review-first",
        decision: { kind: "implementation", action: "本人实现了合成缓存的失效处理。", role: "合成实现者", deployment: "仅合成实验，未上线" } });
      const proposalRequest = { reviewId: reviewed.review.id, expectedRevision: 1, idempotencyKey: "live-personal-proposal-first", consent: true };
      const proposed = await command("evidence-proposal", proposalRequest), repeated = await command("evidence-proposal", proposalRequest);
      assert.equal(proposed.proposal.receipt.id, repeated.proposal.receipt.id);
      await command("evidence-review", { ...binding, expectedRevision: 2, idempotencyKey: "live-personal-correction",
        decision: { kind: "not-mine", note: "纠正：实现由同事完成，不能认领为我的实现。" } });
      await command("evidence-proposal", { ...proposalRequest, expectedRevision: 3, idempotencyKey: "live-obsolete-proposal-rejected" }, 409);
      const corrected = await command("evidence-review", { ...binding, expectedRevision: 3, idempotencyKey: "live-personal-design-review",
        decision: { kind: "design", action: "本人仅设计了合成缓存的失效方案。", role: "合成方案设计", deployment: "未声明实现或上线" } });
      const final = await command("evidence-proposal", { reviewId: corrected.review.id, expectedRevision: 4,
        idempotencyKey: "live-personal-design-proposal", consent: true });
      const saved = await snapshot(); assert.equal(saved.workspace?.revision, 5); assert.equal(saved.workspace.reviews.length, 3);
      assert.equal(saved.workspace.proposals.length, 2); assert.equal(saved.workspace.proposals[0]?.eligibility, "review_superseded");
      assert.equal(saved.workspace.proposals[1]?.eligibility, "current"); assert.equal(final.proposal.candidate.kind, "design");
      assert.deepEqual(saved.tasks, state.tasks); assert.deepEqual(saved.versions, state.versions);
      console.log(JSON.stringify({ handoffPassed: true, directory, ownerId: identity.principal.id,
        reviewIds: saved.workspace.reviews.map(item => item.id), proposals: saved.workspace.proposals.map(item => ({ id: item.id,
          reviewId: item.reviewId, eligibility: item.eligibility, receipt: item.receipt })), revision: saved.workspace.revision,
        additionalBuilderCalls: 0, originalReportsUnchanged: true }));
      if (adoption) {
        const created = await command("resumes/synthetic", { name: "合成职业简历 · 采用与撤销", expectedRevision: saved.workspace.revision, idempotencyKey: "live-create-synthetic-resume", consent: true });
        const asset = created.asset;
        const target = asset.targets[0];
        const request = { kind: "adopt", assetId: asset.id, expectedVersionId: asset.headVersionId, proposalId: final.proposal.id, resumeId: target.resumeId, experienceId: target.experienceId };
        const beforePreview = await snapshot();
        const compared = await command("resumes/preview", request); assert.deepEqual(await snapshot(), beforePreview);
        const saveRequest = { preview: request, previewHash: compared.preview.hash, idempotencyKey: "live-adopt-synthetic-proposal", consent: true };
        const accepted = await command("resumes/save", saveRequest), retried = await command("resumes/save", saveRequest);
        assert.deepEqual(accepted, retried);
        await command("resumes/save", { ...saveRequest, idempotencyKey: "live-stale-preview-rejected" }, 409);
        const undoRequest = { kind: "undo", assetId: asset.id, expectedVersionId: accepted.receipt.versionId, adoptionReceiptId: accepted.receipt.id };
        const undoPreview = await command("resumes/preview", undoRequest);
        await command("resumes/revoke-preview", { assetId: asset.id, expectedAuthorizationRevision: 0, idempotencyKey: "live-revoke-undo-preview" });
        await command("resumes/save", { preview: undoRequest, previewHash: undoPreview.preview.hash, idempotencyKey: "live-revoked-undo-rejected", consent: true }, 409);
        const freshUndo = await command("resumes/preview", undoRequest);
        const undone = await command("resumes/save", { preview: undoRequest, previewHash: freshUndo.preview.hash, idempotencyKey: "live-undo-synthetic-adoption", consent: true });
        const completed = await snapshot(), stored = completed.workspace!.resumeAssets![0]!;
        assert.equal(stored.versions.length, 3); assert.deepEqual(stored.versions[0], asset.versions[0]);
        const initial = DocumentSchema.parse(stored.versions[0]!.document), restored = DocumentSchema.parse(stored.versions[2]!.document);
        assert.deepEqual(restored.factBase.experiences, initial.factBase.experiences); assert.deepEqual(restored.factBase.profile, initial.factBase.profile);
        assert.match(stored.versions[1]!.projection, /仅设计/); assert.match(stored.versions[1]!.projection, /未声明实现或上线/);
        assert.deepEqual(completed.tasks, saved.tasks); assert.deepEqual(completed.versions, saved.versions);
        console.log(JSON.stringify({ adoptionPassed: true, directory, ownerId: identity.principal.id, assetId: asset.id,
          receipts: stored.versions.map(item => item.receipt), headVersionId: stored.headVersionId, undoReceiptId: undone.receipt.id,
          additionalBuilderCalls: 0, originalReportsUnchanged: true, originalVersionUnchanged: true, restoredOriginalClaims: true }));
      }
    }
  }
  if (serve) console.log("Synthetic preview login: capability-lab / synthetic-career-only-2026 (temporary data only)");
} catch (error) { console.error(error); process.exitCode = 1; server.close(); }
if (!serve) server.close();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
