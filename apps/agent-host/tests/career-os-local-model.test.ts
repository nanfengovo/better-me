import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createLocalOllamaClient } from "../src/privacy/local-ollama.js";
import { EvidenceHarvester } from "../src/evidence-harvester/service.js";
import { SqliteHarvesterLedger } from "../src/evidence-harvester/sqlite-ledger.js";
import { createCommitteeSnapshot, runHiringCommittee, hashCommitteeText } from "@better-me/core/career-intelligence";
import { createLocalCommitteeReasoner } from "../src/career-studio/committee-model.js";

const enabled = process.env["BETTERME_TEST_LOCAL_MODEL"] === "1";
const exec = promisify(execFile);
async function client() {
  const name = process.env["BETTERME_TEST_LOCAL_MODEL_NAME"];
  if (!name || /cloud/i.test(name)) throw Error("Explicit installed local model name required");
  const tags = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000), redirect: "error" }).then(res => res.json()) as { models: { name: string; digest: string; remote_host?: unknown; remote_model?: unknown }[] };
  const local = tags.models.find(item => item.name === name);
  assert.ok(local && !local.remote_host && !local.remote_model, "Cloud proxy models are not local evidence processing");
  return createLocalOllamaClient({ model: name, expectedDigest: local.digest });
}

test("opt-in LIVE: actual local Ollama + isolated real Git → inbox → self-review → pending Workspace proposal", { skip: !enabled, timeout: 180_000 }, async t => {
  const local = await client(), bound = await local.binding();
  const runtime = { id: bound.id, location: bound.location, endpointFingerprint: bound.endpointFingerprint, model: bound.model, modelDigest: bound.modelDigest };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-live-local-harvest-")), directory = await fs.realpath(temp), repo = path.join(directory, "repo"); await fs.mkdir(repo);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();
  await git("init", "--initial-branch=main"); await git("config", "user.name", "Synthetic Local QA"); await git("config", "user.email", "synthetic@example.invalid");
  await fs.writeFile(path.join(repo, "state.ts"), "export const state = 'pending';\n"); await git("add", "state.ts"); await git("commit", "-m", "synthetic baseline");
  const ledger = new SqliteHarvesterLedger("synthetic-owner", path.join(directory, "store"));
  let proposed = 0;
  const service = new EvidenceHarvester({ ledger, model: { binding: async () => runtime, complete: input => local.complete(input) }, workspace: {
    findReceipt: async () => undefined, propose: async input => { assert.equal(input.entry.personalContribution, "unknown"); proposed++; return { id: "synthetic-workspace-receipt", proposalId: "synthetic-pending-proposal", status: "pending_business_review" }; },
  } });
  t.after(async () => { service.close(); ledger.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const access = { session: "synthetic-session", valid: async () => true }, preview = await service.preview(repo, access);
  const subscription = await service.subscribe({ previewId: preview.previewId, runtime, consent: true, idempotencyKey: "live-local-harvest", policy: { expiresAt: Date.now() + 180_000, maxCommitsPerDay: 2, maxModelCallsPerDay: 2, maxInputBytes: 32_000, maxOutputBytes: 16_000, maxActiveMs: 150_000 } }, access);
  await fs.writeFile(path.join(repo, "state.ts"), "export function compareAndSet(current: string, expected: string, next: string) {\n  return current === expected ? next : current;\n}\n");
  await git("add", "state.ts"); await git("commit", "-m", "synthetic compare-and-set implementation");
  const result = await service.poll(subscription.id, access), entry = result.entries[0]!;
  assert.equal(entry.status, "awaiting_review", entry.errorCode); assert.ok(entry.citations.length > 0); assert.equal(proposed, 0);
  await service.review(entry.id, { kind: "implementation", action: "本人为合成样例实现了字符串比较更新函数，仅在本地演示。", role: "样例实现", deployment: "未上线" }, access);
  const saved = await service.propose(entry.id, true, access);
  assert.equal(saved.proposalReceipt?.status, "pending_business_review"); assert.equal(proposed, 1);
  t.diagnostic(JSON.stringify({ runtime: runtime.model, digest: runtime.modelDigest, status: saved.status, citations: saved.citations.length, scope: "synthetic only; no career Fact accepted" }));
});

test("opt-in LIVE: four actual local-model committee roles, bounded cross-review and evidence adjudication", { skip: !enabled, timeout: 360_000 }, async t => {
  const local = await client(), source = "export function next(current, expected, value) { return current === expected ? value : current; }";
  const snapshot = await createCommitteeSnapshot({ binding: { ownerId: "synthetic-owner", workspaceId: "synthetic-workspace", sessionGeneration: "1", resumeId: "synthetic-resume", resumeRevision: "1", factRevision: "1", jdSnapshotIds: [], rulesVersion: "qa-v1" },
    authorization: { grantId: "synthetic-grant", evidenceIds: ["source-1", "statement-1"], purpose: "resume_stress_test", expiresAt: new Date(Date.now() + 350_000).toISOString() },
    claims: [{ id: "claim-1", text: "本人在合成样例中实现字符串比较更新函数，未上线。", contribution: "implementation" }],
    evidence: [{ id: "source-1", sourceId: "synthetic/state.ts", sourceHash: await hashCommitteeText(source), label: "合成样例源码", provenance: "source", excerpt: source, startLine: 1, endLine: 1 },
      { id: "statement-1", sourceId: "synthetic/user-statement", sourceHash: await hashCommitteeText("本人实现此合成样例，未上线。"), label: "本人明确自述（未独立核验）", provenance: "user_statement", excerpt: "本人实现此合成样例，未上线。", startLine: 1, endLine: 1 }], jobText: "岗位要求：解释状态比较更新；不要求上线业绩。" });
  const report = await runHiringCommittee(snapshot, { isCurrent: async () => true, budget: { maxModelCalls: 28, maxTurnsPerRole: 4, maxDurationMs: 330_000, maxOutputCharacters: 120_000 },
    reasoner: createLocalCommitteeReasoner(local, snapshot),
  });
  t.diagnostic(JSON.stringify({ status: report.status, roles: report.roles.map(role => ({ role: role.role, stage: role.stage, error: role.error, issues: role.issues.map(issue => issue.code) })), usage: report.usage, stopReason: report.stopReason }));
  assert.equal(report.status, "completed"); assert.equal(report.roles.length, 7); assert.equal(report.claims.length, 1);
  assert.ok(report.usage.modelCalls >= 7); assert.ok(report.claims.every(claim => claim.limitations.length > 0));
});
