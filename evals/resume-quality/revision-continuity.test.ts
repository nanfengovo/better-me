import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CareerTask, CareerTaskCreate } from "../../packages/agent-contracts/src/career-task.js";
import { CareerTaskService } from "../../apps/agent-host/src/tasks/service.js";
import { inspectCareerTaskWorkspace, resumeSaveCommand } from "../../apps/web/src/lib/career-task-reconciliation.js";
import { careerTaskSourceFingerprint, createCareerTaskResume } from "../../packages/core/src/project/career-task-resume.js";
import { createDefaultResumeView, projectResume } from "../../packages/core/src/project/resume-projection.js";
import { DocumentSchema, LocalJsonStore } from "../../packages/storage/src/local-json.js";
import type { BetterMeDocument } from "../../packages/storage/src/types.js";

const access = { session: "synthetic-editor", valid: async () => true };
const binding = { id: "scripted-editor", label: "固定合成回复", location: "local" } as const;
const original = ["记录 Redis 缓存失效。", "保留请求样本。", "核对重试结果。"];
const firstEdit = "记录 Redis 缓存失效与回放用例。";
const secondEdit = "保留请求样本与边界说明。";
const neighbor = "核对 SQLite 事务回滚。";
const firstAnswer = firstEdit;
const secondAnswer = "保留请求样本与边界说明。";
const jobs = [
  { id: "cache", title: "缓存测试", company: "合成实验室", description: "核对 Redis 的失效行为。旧岗位标记。" },
  { id: "incident", title: "故障复盘", company: "合成实验室", description: "复核边界说明与请求样本。新岗位标记。" },
];
const materials = [
  { id: "fixture-cache-test", kind: "source" as const, label: "合成缓存回放测试", text: "expect(cache.read(expiredKey)).toBeUndefined(); // 首轮材料标记" },
  { id: "fixture-case-table", kind: "source" as const, label: "合成请求样本表", text: "case: retry-at-boundary -> retain request sample" },
];
const time = "2026-11-20T00:00:00.000Z";

function fixtureDocument(): BetterMeDocument {
  const factBase = {
    schemaVersion: 1 as const, updatedAt: time,
    profile: { displayName: { zh: "合成候选人" }, links: [], traits: [], targetRoles: [], constraints: [] },
    experiences: [{ id: "lab", type: "other" as const, org: { zh: "合成实验室" }, title: { zh: "回放测试" },
      start: "2025-01", end: "2025-03", techStack: [], claims: [
        { id: "cache", kind: "action" as const, text: { zh: original.join("") }, tags: [] },
        { id: "db", kind: "action" as const, text: { zh: neighbor }, tags: [] },
      ] }],
  };
  const view = createDefaultResumeView(factBase, time);
  return DocumentSchema.parse({ documentId: "synthetic-revision", factBase, activeResumeId: view.id, resumeViews: [view] });
}

// Exercise the production document codec/store against an actual temporary disk, including a fresh reader.
function openDocument(directory: string) {
  const location = (key: string) => path.join(directory, encodeURIComponent(key) + ".json");
  return new LocalJsonStore("revision-eval", {
    getItem: key => existsSync(location(key)) ? readFileSync(location(key), "utf8") : null,
    setItem: (key, value) => writeFileSync(location(key), value, "utf8"),
    removeItem: key => rmSync(location(key), { force: true }),
  });
}

function visible(doc: BetterMeDocument, id = doc.activeResumeId) {
  const view = doc.resumeViews.find(item => item.id === id)!;
  return projectResume(doc.factBase, view).experiences[0]!.claims;
}
type State = Pick<CareerTask, "resume" | "evidence" | "job"> & { writingPhase: "plan" | "draft" };
const own = (state: State, sourceId: string) => {
  const ref = state.evidence.find(item => item.sourceId === sourceId);
  assert.ok(ref, sourceId);
  return ref.id;
};
const ownAnswer = (state: Pick<CareerTask, "evidence">, text: string) => {
  const ref = state.evidence.find(item => item.kind === "user_statement" && item.excerpt === text);
  assert.ok(ref, text);
  return ref.id;
};
function plan(state: State) {
  return {
    kind: "material_plan",
    selections: state.resume.fields.map(field => ({ fieldId: field.id, include: true,
      reason: "列出所选项目中的两项技术证据供核对。", evidenceIds: [own(state, "resume:" + field.id)] })),
    questions: state.resume.fields.map(field => ({ id: "ask-" + field.id, fieldId: field.id,
      question: "这项工作需要补充哪一条说明？", evidenceIds: [own(state, "resume:" + field.id)] })),
  };
}
function draft(state: State, fieldId: string, sentences: string[], extraReferences: string[], edited: string) {
  const field = state.resume.fields.find(item => item.id === fieldId)!;
  const source = own(state, "resume:" + fieldId);
  return { kind: "draft", unknowns: [], patches: [{
    fieldId, targetRef: field.targetRef, originalText: field.originalText, proposedText: sentences.join(""),
    evidenceIds: [source, ...extraReferences], rationale: "按本轮确认只修改选中句。",
    sentences: sentences.map(text => ({ text, evidenceIds: text === edited ? [source, ...extraReferences] : [source] })),
  }] };
}

async function settled(host: CareerTaskService, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const task = await host.get(id);
    if (task.status !== "running") return task;
    await delay(10);
  }
  throw Error("Isolated resume task did not settle");
}

async function write(host: CareerTaskService, doc: BetterMeDocument, round: number, scenario: string,
  draftOutput: (state: State) => unknown, omitInventory = false) {
  const source = doc.resumeViews.find(view => view.id === doc.activeResumeId)!;
  const fields = visible(doc).map(claim => ({ id: claim.id, originalText: claim.text,
    targetRef: { kind: "claim_text" as const, locale: "zh" as const, experienceId: "lab", claimId: claim.id } }));
  const input: CareerTaskCreate = {
    workspaceKey: doc.documentId!, idempotencyKey: "revision-" + scenario, workflow: "text_v1",
    objective: round === 0 ? "只补充缓存回放用例。" : "只改请求样本这句，保留已确认原句及 SQLite 工作。",
    resume: { id: source.id, name: source.name, sourceFingerprint: await careerTaskSourceFingerprint(doc, source.id), fields },
    job: jobs[round]!, materials: [materials[round]!], consent: true, runtimeBinding: binding,
    budget: { maxModelCalls: 2, maxToolCalls: 1, maxActiveMs: 60_000 },
  };
  const dispatched: string[] = [];
  const runtime = { runtimeFingerprint: "in-process-scripted-revisions", reasoner: async (prompt: string) => {
    const state: State = JSON.parse(prompt.split("\n\n").at(-1)!);
    dispatched.push(state.writingPhase);
    if (round === 1) {
      assert.doesNotMatch(prompt, /旧岗位标记|首轮材料标记/);
      assert.ok(!state.evidence.some(item => item.kind === "user_statement" && item.excerpt === firstAnswer));
      assert.equal(state.resume.fields.find(field => field.id === "cache")?.originalText, [firstEdit, ...original.slice(1)].join(""));
    }
    if (state.writingPhase === "draft") return JSON.stringify(draftOutput(state));
    const result = plan(state);
    if (omitInventory) result.selections.pop();
    return JSON.stringify(result);
  } };
  const command = (task: CareerTask) => ({ expectedRevision: task.revision, sourceFingerprint: task.resume.sourceFingerprint, runtimeBinding: binding, consent: true as const });
  let task = await host.create(input, access);
  await host.run(task.id, "start", command(task), runtime, access);
  task = await settled(host, task.id);
  if (omitInventory) {
    assert.deepEqual(dispatched, ["plan"]);
    return task;
  }
  assert.equal(task.status, "awaiting_answer", task.error);
  const answer = { planHash: task.writingPlan!.hash, selectedFieldIds: ["cache"], confirmed: true,
    answers: [{ questionId: "ask-cache", text: round === 0 ? firstAnswer : secondAnswer },
      { questionId: "ask-db", text: "保留 SQLite 的独立记录，不并入缓存工作。" }] };
  await host.run(task.id, "answer", { ...command(task), answer: JSON.stringify(answer) }, runtime, access);
  task = await settled(host, task.id);
  assert.deepEqual(dispatched, ["plan", "draft"]);
  assert.equal(task.usage.modelCalls, 2);
  return task;
}

async function approveAndRead(host: CareerTaskService, directory: string, doc: BetterMeDocument, task: CareerTask) {
  assert.equal(task.status, "awaiting_review", task.error);
  const ids = task.draft!.patches.map(patch => patch.id);
  const saved = await createCareerTaskResume(doc, resumeSaveCommand(task, ids), time);
  await openDocument(directory).save(saved.document);
  const disk = (await openDocument(directory).load())!;
  const checked = await inspectCareerTaskWorkspace(disk, task, { kind: "resume" });
  assert.ok(checked.state === "current" && checked.receipt, checked.state);
  assert.equal(checked.receipt.versionId, disk.activeResumeId);
  await host.receipt(task.id, { ...checked.receipt, expectedRevision: task.revision }, access);
  return disk;
}

test("reviewed resume revisions preserve confirmed sentences and isolate each job's evidence", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-synthetic-resume-revision-"));
  const hostOptions = { ownerId: "synthetic-editor", directory: path.join(directory, "tasks") };
  let host = new CareerTaskService(hostOptions);
  try {
    const base = fixtureDocument();
    const first = await write(host, base, 0, "first", state => draft(state, "cache", [firstEdit, ...original.slice(1)],
      [ownAnswer(state, firstAnswer), own(state, "material:" + materials[0]!.id)], firstEdit));
    const reviewed = await approveAndRead(host, directory, base, first);
    const firstWords = [firstEdit, ...original.slice(1)].join("");
    const secondWords = [firstEdit, secondEdit, original[2]!];
    assert.deepEqual(visible(reviewed).map(c => c.text), [firstWords, neighbor]);
    assert.deepEqual(visible(reviewed, base.activeResumeId).map(c => c.text), [original.join(""), neighbor]);

    const priorAnswer = ownAnswer(first, firstAnswer);
    const rejected = [
      { name: "missing technical field in inventory", code: "writing_inventory_incomplete", reply: () => null },
      { name: "unselected SQLite field", code: "writing_unselected_field", reply: (s: State) => draft(s, "db", ["复核 SQLite 事务回滚。"], [], "复核 SQLite 事务回滚。") },
      { name: "prior job answer", code: "unknown_evidence", reply: (s: State) => draft(s, "cache", secondWords, [priorAnswer], secondEdit) },
      { name: "neighbor field answer", code: "writing_cross_field_answer", reply: (s: State) => draft(s, "cache", secondWords, [ownAnswer(s, "保留 SQLite 的独立记录，不并入缓存工作。")], secondEdit) },
      { name: "invented performance metric", code: "unsupported_number", reply: (s: State) => {
        const invented = "将延迟降低了 90%。";
        return draft(s, "cache", [firstEdit, invented, original[2]!], [ownAnswer(s, secondAnswer)], invented);
      } },
      { name: "reordered confirmed sentences plus a rewrite", code: "one_sentence_change_per_patch",
        reply: (s: State) => draft(s, "cache", [original[2]!, secondEdit, firstEdit], [ownAnswer(s, secondAnswer)], secondEdit) },
      { name: "duplicate confirmed sentence plus a rewrite", code: "one_sentence_change_per_patch",
        reply: (s: State) => draft(s, "cache", [...secondWords, firstEdit], [ownAnswer(s, secondAnswer)], secondEdit) },
    ];
    for (const [index, example] of rejected.entries()) {
      await t.test(example.name, async () => {
        const result = await write(host, reviewed, 1, "rejected-" + index, example.reply, example.code === "writing_inventory_incomplete");
        assert.equal(result.error, example.code);
        assert.equal(result.status, "failed");
        assert.equal(result.draft, undefined);
        assert.equal(result.receipt, undefined);
        assert.deepEqual(await openDocument(directory).load(), reviewed);
      });
    }
    await t.test("approve a single change, restart, reconcile both receipts and read exact sources", async () => {
      const next = await write(host, reviewed, 1, "next", state => draft(state, "cache", secondWords,
        [ownAnswer(state, secondAnswer), own(state, "material:" + materials[1]!.id)], secondEdit));
      const final = await approveAndRead(host, directory, reviewed, next);
      await host.close();
      host = new CareerTaskService(hostOptions);
      const reopened = (await openDocument(directory).load())!;
      assert.deepEqual(reopened, final);
      assert.equal(reopened.resumeViews.length, 3);
      assert.deepEqual(reopened.factBase, base.factBase);
      assert.deepEqual(visible(reopened).map(c => c.text), [secondWords.join(""), neighbor]);
      assert.deepEqual(visible(reopened, reviewed.activeResumeId).map(c => c.text), [firstWords, neighbor]);
      for (const [index, task] of [first, next].entries()) {
        const fromDisk = await host.get(task.id);
        assert.equal(fromDisk.status, "completed");
        assert.equal(fromDisk.job.id, jobs[index]!.id);
        assert.equal(fromDisk.draft!.patches[0]!.sentences!.filter(s => s.evidenceIds.length > 1).length, 1);
        const changed = fromDisk.draft!.patches[0]!.sentences!.find(s => s.evidenceIds.length > 1)!;
        assert.deepEqual(changed.evidenceIds.map(id => fromDisk.evidence.find(source => source.id === id)?.excerpt), [
          index === 0 ? original.join("") : firstWords, index === 0 ? firstAnswer : secondAnswer, materials[index]!.text,
        ]);
        assert.equal((await inspectCareerTaskWorkspace(reopened, fromDisk, { kind: "resume" })).state, "current");
        assert.equal(fromDisk.receipt?.versionId, index === 0 ? reviewed.activeResumeId : reopened.activeResumeId);
      }
    });
  } finally {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
