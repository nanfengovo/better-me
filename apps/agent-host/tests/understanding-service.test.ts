import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectUnderstandingService } from "../src/understanding/service.ts";

const reply = (summary = "Synthetic source receives orders.") => JSON.stringify({ kind: "reply", message: "请核对我的理解。", understanding: { summary, terms: [], boundaries: ["Not personal contribution"], claims: [{ id: "u1", text: "A synthetic project", kind: "inference", evidenceIds: [] }], unknowns: [] }, readyForConfirmation: true });
async function settled(service: ProjectUnderstandingService, id: string) {
  for (let i = 0; i < 200; i++) { const session = await service.get(id); if (session.phase !== "running") return session; await delay(5); }
  throw new Error("Synthetic turn did not settle");
}

test("a stale stop request cannot cancel a replacement turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-stale-stop-"));
  const service = new ProjectUnderstandingService({ storageDir: directory });
  try {
    let session = await service.create({ workspaceKey: "fixture", projectKey: "stop", label: "Fixture", sourceText: "Synthetic source" });
    const hanging = async () => new Promise<string>(() => undefined);
    session = await service.turn(session.id, { expectedRevision: session.revision, idempotencyKey: "stop-first", answer: "", selectedOptionIds: [], consentToSend: true }, hanging);
    const oldTurn = session.turnCount;
    session = await service.cancel(session.id, oldTurn);
    session = await service.turn(session.id, { expectedRevision: session.revision, idempotencyKey: "stop-second", answer: "", selectedOptionIds: [], consentToSend: true }, hanging);
    await assert.rejects(service.cancel(session.id, oldTurn), error => error instanceof Error && "code" in error && error.code === "turn_changed");
    assert.equal((await service.get(session.id)).phase, "running");
    assert.equal((await service.cancel(session.id, session.turnCount)).phase, "cancelled");
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("protocol repair is bounded, observable and never adopts an invalid claim", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-protocol-repair-"));
  const service = new ProjectUnderstandingService({ storageDir: directory });
  try {
    let session = await service.create({ workspaceKey: "fixture", projectKey: "repair", label: "Fixture", sourceText: "Synthetic source" });
    let calls = 0;
    await service.turn(session.id, { expectedRevision: session.revision, idempotencyKey: "repair-invalid-output", answer: "", selectedOptionIds: [], consentToSend: true }, async prompt => {
      if (calls++ === 0) return "INVALID_SECRETLIKE_OUTPUT_MUST_NOT_PERSIST";
      assert.match(prompt, /protocolError/);
      assert.equal(prompt.includes("INVALID_SECRETLIKE_OUTPUT_MUST_NOT_PERSIST"), false);
      return reply("Corrected valid understanding");
    });
    session = await settled(service, session.id);
    assert.equal(calls, 2);
    assert.equal(session.phase, "awaiting-confirmation");
    assert.equal(session.messages.filter(message => message.role === "agent").length, 1);
    assert.ok(session.events.some(item => item.label.includes("纠正推理输出")));
    calls = 0;
    await service.turn(session.id, { expectedRevision: session.revision, idempotencyKey: "repair-still-invalid", answer: "", selectedOptionIds: [], consentToSend: true }, async () => { calls++; return "still-invalid"; });
    session = await settled(service, session.id);
    assert.equal(calls, 3, "two repairs, not an unbounded retry loop");
    assert.equal(session.error?.code, "invalid_decision");
    assert.equal(session.confirmation, undefined);
    assert.equal(session.messages.filter(message => message.role === "agent").length, 1);
    assert.equal((await fs.readFile(path.join(directory, `${session.id}.json`), "utf8")).includes("INVALID_SECRETLIKE_OUTPUT_MUST_NOT_PERSIST"), false);
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("durable understanding requires exact revision and complete-summary confirmation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-service-"));
  const service = new ProjectUnderstandingService({ storageDir: directory });
  try {
    const created = await service.create({ workspaceKey: "synthetic", projectKey: "project-one", label: "Fixture", sourceText: "A synthetic project" });
    const input = { expectedRevision: created.revision, idempotencyKey: "first-turn-fixture", answer: "", selectedOptionIds: [], consentToSend: true as const };
    await service.turn(created.id, input, async () => reply());
    const ready = await settled(service, created.id);
    assert.equal(ready.phase, "awaiting-confirmation");
    await assert.rejects(service.confirm(ready.id, { expectedRevision: created.revision, summaryHash: ready.summaryHash! }));
    const confirmed = await service.confirm(ready.id, { expectedRevision: ready.revision, summaryHash: ready.summaryHash! });
    assert.equal(confirmed.confirmation?.revision, confirmed.revision);
    assert.equal((await service.turn(created.id, input, async () => { throw new Error("must not replay"); })).turnCount, 1);
    const reopened = new ProjectUnderstandingService({ storageDir: directory });
    assert.equal((await reopened.get(created.id)).confirmation?.summaryHash, ready.summaryHash);
    await reopened.dispose();
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("cancellation and timeout stop late writes without storing runtime errors or credentials", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-lifecycle-"));
  const service = new ProjectUnderstandingService({ storageDir: directory, turnTimeoutMs: 40 });
  try {
    const created = await service.create({ workspaceKey: "fixture", projectKey: "cancel", label: "Fixture", sourceText: "Synthetic lifecycle" });
    let finish!: (value: string) => void;
    let runtimeSignal: AbortSignal | undefined;
    await service.turn(created.id, { expectedRevision: 0, idempotencyKey: "cancel-fixture", answer: "", selectedOptionIds: [], consentToSend: true }, async (_prompt, signal) => {
      runtimeSignal = signal;
      return new Promise<string>(resolve => { finish = resolve; });
    });
    for (let index = 0; index < 20 && !finish; index++) await delay(2);
    const cancelled = await service.cancel(created.id);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(runtimeSignal?.aborted, true);
    finish(reply("late output must not overwrite cancellation"));
    await delay(15);
    assert.equal((await service.get(created.id)).revision, cancelled.revision);
    await service.turn(created.id, { expectedRevision: cancelled.revision, idempotencyKey: "timeout-fixture", answer: "", selectedOptionIds: [], consentToSend: true }, async () => new Promise<string>(() => undefined));
    const timedOut = await settled(service, created.id);
    assert.equal(timedOut.error?.code, "turn_timeout");
    await service.turn(created.id, { expectedRevision: timedOut.revision, idempotencyKey: "runtime-failure-fixture", answer: "", selectedOptionIds: [], consentToSend: true }, async () => { throw new Error("SYNTHETIC_RUNTIME_CREDENTIAL_DO_NOT_STORE"); });
    const failed = await settled(service, created.id);
    assert.equal(failed.error?.code, "reasoning_failed");
    const stored = await fs.readFile(path.join(directory, `${created.id}.json`), "utf8");
    assert.equal(stored.includes("SYNTHETIC_RUNTIME_CREDENTIAL_DO_NOT_STORE"), false);
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(directory, `${created.id}.json`))).mode & 0o777, 0o600);
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("orphaned running records recover after restart and source edits preserve long-term history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-recovery-"));
  const service = new ProjectUnderstandingService({ storageDir: directory });
  try {
    const created = await service.create({ workspaceKey: "fixture", projectKey: "recovery", label: "Fixture", sourceText: "Old source" });
    const filename = path.join(directory, `${created.id}.json`);
    const persisted = JSON.parse(await fs.readFile(filename, "utf8"));
    persisted.session.phase = "running";
    await fs.writeFile(filename, JSON.stringify(persisted));
    const recovered = await service.get(created.id);
    assert.equal(recovered.error?.code, "host_restarted");
    const edited = await service.updateSource(created.id, { expectedRevision: recovered.revision, sourceText: "Corrected source" });
    assert.equal(edited.phase, "idle");
    assert.equal(edited.sourceText, "Corrected source");
    assert.equal(edited.messages[0]?.text, "Old source");
    assert.match(edited.messages[1]?.text ?? "", /Corrected source/);
    await assert.rejects(service.updateSource(created.id, { expectedRevision: recovered.revision, sourceText: "Stale source" }));
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("dynamic option IDs resolve against server labels and submissions are idempotent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-options-"));
  const service = new ProjectUnderstandingService({ storageDir: directory });
  try {
    const created = await service.create({ workspaceKey: "fixture", projectKey: "options", label: "Fixture", sourceText: "Synthetic dispatch" });
    const input = { expectedRevision: 0, idempotencyKey: "question-fixture", answer: "", selectedOptionIds: [], consentToSend: true as const };
    const questionReply = { ...JSON.parse(reply()), readyForConfirmation: false, question: { id: "dispatch-layer", text: "Which layer?", why: "Task means different layers", options: [{ id: "subtask", label: "The internal movement subtask" }], allowMultiple: false } };
    await service.turn(created.id, input, async () => JSON.stringify(questionReply));
    const asking = await settled(service, created.id);
    assert.equal(asking.phase, "awaiting-answer");
    await assert.rejects(service.turn(created.id, { ...input, answer: "different" }, async () => reply()), { code: "idempotency_conflict" });
    await assert.rejects(service.turn(created.id, { ...input, expectedRevision: asking.revision, idempotencyKey: "wrong-option-fixture", selectedOptionIds: ["client-invented-label"] }, async () => reply()));
    let seenPrompt = "";
    await service.turn(created.id, { ...input, expectedRevision: asking.revision, idempotencyKey: "selected-option-fixture", selectedOptionIds: ["subtask"] }, async prompt => { seenPrompt = prompt; return reply(); });
    const ready = await settled(service, created.id);
    assert.match(seenPrompt, /The internal movement subtask/);
    assert.match(ready.messages.filter(message => message.role === "user").at(-1)?.text ?? "", /The internal movement subtask/);
    const confirmed = await service.confirm(created.id, { expectedRevision: ready.revision, summaryHash: ready.summaryHash! });
    const edited = await service.updateSource(created.id, { expectedRevision: confirmed.revision, sourceText: "The corrected dispatch layer" });
    assert.equal(edited.confirmation, undefined);
    assert.equal(edited.understanding, undefined);
    assert.equal(edited.question, undefined);
    assert.ok(edited.messages.length > confirmed.messages.length);
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("actual broker evidence grounds source claims and revocation prevents old derived history from resurfacing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-grounding-"));
  const service = new ProjectUnderstandingService({ storageDir: path.join(directory, "store") });
  try {
    const project = path.join(directory, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "flow.ts"), "const REVOCABLE_SOURCE_MARKER = true;\n");
    const created = await service.create({ workspaceKey: "fixture", projectKey: "grounding", label: "Fixture", sourceText: "Synthetic granted project" });
    const granted = await service.grant(created.id, project);
    let calls = 0;
    await service.turn(created.id, { expectedRevision: granted.revision, idempotencyKey: "source-grounding-fixture", answer: "", selectedOptionIds: [], consentToSend: true }, async prompt => {
      if (calls++ === 0) return JSON.stringify({ kind: "read", requests: [{ grantId: granted.grants[0]!.id, operation: "read", path: "flow.ts" }] });
      const evidenceId = prompt.match(/ev_[a-f0-9]{24}/)?.[0];
      assert.ok(evidenceId);
      const output = JSON.parse(reply());
      output.message = "Observed REVOCABLE_SOURCE_MARKER in the synthetic source.";
      output.understanding.claims = [{ id: "s1", text: "A source marker exists", kind: "source", evidenceIds: [evidenceId] }];
      return JSON.stringify(output);
    });
    const ready = await settled(service, created.id);
    assert.equal(ready.phase, "awaiting-confirmation");
    const oldAgent = ready.messages.find(message => message.role === "agent")!;
    let historyCalls = 0;
    await service.turn(created.id, { expectedRevision: ready.revision, idempotencyKey: "history-source-fixture", answer: "Review previous wording", selectedOptionIds: [], consentToSend: true }, async () => historyCalls++ === 0 ? JSON.stringify({ kind: "read", requests: [{ grantId: "conversation", operation: "read", path: oldAgent.id }] }) : reply());
    const withHistory = await settled(service, created.id);
    const oldHistoryId = withHistory.evidence.find(item => item.grantId === "conversation")!.id;
    const revoked = await service.revoke(created.id, granted.grants[0]!.id);
    assert.equal(revoked.understanding, undefined);
    assert.equal(revoked.evidence.find(item => item.id === oldHistoryId)?.excerpt, "");
    assert.ok(revoked.messages.some(message => message.text.includes("REVOCABLE_SOURCE_MARKER")), "Audit history remains intact locally");
    let promptAfterRevoke = "";
    await service.turn(created.id, { expectedRevision: revoked.revision, idempotencyKey: "after-revoke-fixture", answer: "Continue without that source", selectedOptionIds: [], consentToSend: true }, async prompt => {
      promptAfterRevoke = prompt;
      const output = JSON.parse(reply());
      output.understanding.claims = [{ id: "bad", text: "Old derived text", kind: "inference", evidenceIds: [oldHistoryId] }];
      return JSON.stringify(output);
    });
    assert.equal((await settled(service, created.id)).error?.code, "unknown_evidence");
    assert.equal(promptAfterRevoke.includes("REVOCABLE_SOURCE_MARKER"), false);
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("unlimited persisted interview turns use bounded recent context and can retrieve older corrections", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-history-"));
  const service = new ProjectUnderstandingService({ storageDir: directory });
  try {
    let current = await service.create({ workspaceKey: "fixture", projectKey: "history", label: "Fixture", sourceText: "Synthetic long-lived project" });
    for (let index = 0; index < 18; index++) {
      await service.turn(current.id, { expectedRevision: current.revision, idempotencyKey: `long-history-turn-${index}`, answer: index === 0 ? "EARLY_USER_CORRECTION: task acceptance is not completion" : `Follow-up ${index} ${"detail ".repeat(300)}`, selectedOptionIds: [], consentToSend: true }, async () => reply());
      current = await settled(service, current.id);
    }
    let calls = 0;
    await service.turn(current.id, { expectedRevision: current.revision, idempotencyKey: "retrieve-old-correction", answer: "Recall the early correction", selectedOptionIds: [], consentToSend: true }, async prompt => {
      if (calls++ === 0) {
        assert.equal(prompt.includes("EARLY_USER_CORRECTION"), false);
        assert.match(prompt, /omittedMessages/);
        return JSON.stringify({ kind: "read", requests: [{ grantId: "conversation", operation: "search", path: "", query: "EARLY_USER_CORRECTION" }] });
      }
      assert.match(prompt, /EARLY_USER_CORRECTION/);
      return reply("Acceptance is not completion; prior correction retrieved.");
    });
    const final = await settled(service, current.id);
    assert.equal(final.turnCount, 19);
    assert.ok(final.messages.length >= 39);
    assert.equal(final.phase, "awaiting-confirmation");
    assert.ok(final.evidence.some(item => item.grantId === "conversation" && item.excerpt.includes("EARLY_USER_CORRECTION")));
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("unsupported claims and inconsistent readiness are rejected, and read budgets are per-turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-validation-"));
  const service = new ProjectUnderstandingService({ storageDir: directory, maxToolCalls: 1 });
  try {
    let current = await service.create({ workspaceKey: "fixture", projectKey: "validation", label: "Fixture", sourceText: "Synthetic evidence boundaries" });
    for (const [kind, expectedCode] of [["source", "unsupported_source_claim"], ["user", "unsupported_user_claim"]] as const) {
      await service.turn(current.id, { expectedRevision: current.revision, idempotencyKey: `unsupported-${kind}-claim`, answer: "", selectedOptionIds: [], consentToSend: true }, async () => {
        const output = JSON.parse(reply()); output.understanding.claims[0].kind = kind; return JSON.stringify(output);
      });
      current = await settled(service, current.id);
      assert.equal(current.error?.code, expectedCode);
    }
    await service.turn(current.id, { expectedRevision: current.revision, idempotencyKey: "per-turn-budget-fixture", answer: "", selectedOptionIds: [], consentToSend: true }, async () => JSON.stringify({ kind: "read", requests: [{ grantId: "conversation", operation: "list", path: "" }] }));
    current = await settled(service, current.id);
    assert.equal(current.error?.code, "turn_budget");
    await service.turn(current.id, { expectedRevision: current.revision, idempotencyKey: "new-turn-after-budget", answer: "", selectedOptionIds: [], consentToSend: true }, async () => reply());
    current = await settled(service, current.id);
    assert.equal(current.phase, "awaiting-confirmation");
    const priorHash = current.summaryHash;
    await service.turn(current.id, { expectedRevision: current.revision, idempotencyKey: "full-structured-hash", answer: "", selectedOptionIds: [], consentToSend: true }, async () => {
      const output = JSON.parse(reply()); output.understanding.terms = [{ term: "task", meaning: "Internal subtask, not order", evidenceIds: [] }]; return JSON.stringify(output);
    });
    current = await settled(service, current.id);
    assert.notEqual(current.summaryHash, priorHash, "Hash includes terms, not only unchanged summary text");
  } finally { await service.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
