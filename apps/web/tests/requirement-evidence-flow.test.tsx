import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  careerJobSnapshotVersion, careerRequirementCapabilityId, careerTrainingRequirements, TrainingView,
} from "@better-me/agent-contracts";
import { createDefaultResumeView, createDemoFactBase, parseFactBase } from "@better-me/core";
import { exportDocumentJson, parseDocumentJson, type BetterMeDocument } from "@better-me/storage";
import { RequirementEvidencePanel } from "../src/components/RequirementEvidencePanel";
import {
  evidenceSources, preserveRequirementReviews, recommendationReviewReader, requirementRetest, requirementSourceKey, withRequirementEvidence,
} from "../src/lib/requirement-evidence";

const at = "2026-11-20T00:00:00.000Z";
const completedAt = "2026-11-21T00:00:00.000Z";
const job = { id: "synthetic-role", title: "工程师", company: "测试组织", description: "岗位要求：独立设计数据库" };
const item = careerTrainingRequirements(job)[0]!;
const snapshotVersion = careerJobSnapshotVersion(job);
const capabilityId = careerRequirementCapabilityId(snapshotVersion, item.id, item.originalQuote);
const work = "我独立设计库存数据库，比较两种隔离策略并记录取舍。";
const facts = parseFactBase({ schemaVersion: 1, updatedAt: at, profile: { displayName: { zh: "合成人员" } },
  experiences: [{ id: "work-1", type: "work", org: { zh: "测试组织" }, title: { zh: "工程师" }, start: "2020-01", end: null,
    claims: [{ id: "design", kind: "action", text: { zh: work } }] }] });
const view = createDefaultResumeView(facts);
const initial: BetterMeDocument = { documentId: "synthetic-doc", activeResumeId: view.id, resumeViews: [view], factBase: facts };

function fixture() {
  const screen = { instruction: "说明隔离策略", brief: "给出选择的理由", notes: ["合成库存记录"],
    fields: [{ control: "quantity", key: "part1", label: "应用所选事务策略后产生多少条写入？" }] };
  const practice = { at, round: "practice", usedPreview: true, questionVersion: "1".repeat(64), question: screen,
    answer: { parts: { part1: "2" } },
    feedback: { met: false, detail: "已记录", evidence: [{ key: "part1", status: "recorded", detail: "已记录作答", nextStep: "说明失败路径" }] } };
  const retest = { ...practice, at: completedAt, round: "retest", usedPreview: false, questionVersion: "2".repeat(64),
    answer: { parts: { part1: "1" } },
    feedback: { met: true, detail: "已核对", evidence: [{ key: "part1", status: "met", detail: "只有一条写入", nextStep: "解释幂等策略" }] },
    aids: { preview: false, practiceReference: false },
    retestChange: { key: "part1", before: "首次发起提交", after: "首次提交状态未知后重复发起", criterion: "解释如何避免重复写入" } };
  return TrainingView.parse({ id: "0d3f509e-aa34-4fed-931d-237832625292", ownerId: "synthetic-owner", title: "库存设计复测",
    goal: "解释库存数据库策略", career: { workspaceKey: view.id, targetId: "c4f950d9-6950-4ac0-b3af-6b5d09785d25",
      goalId: "goal", goal: "说明事务取舍", planId: "plan", planTitle: "方案", taskId: "task", taskTitle: "练习设计",
      competency: "选择事务策略", capabilityId, criterion: "解释如何避免重复写入",
      requirement: { jobId: job.id, title: job.title, company: job.company, snapshotVersion, itemId: item.id, quote: item.originalQuote } },
    focus: "故障后的选择", kind: "studio", version: "c".repeat(64), origin: "local", modelCalls: 2,
    verifiedCases: 1, saved: true, revision: 3, stage: "complete", attempts: [practice, retest], screen, questionVersion: retest.questionVersion });
}

test("one requirement retains independent work and retest history and updates the current advice on withdrawal", async t => {
  const kit = fixture();
  const retest = requirementRetest(kit)!;
  const dom = new Window({ url: "http://127.0.0.1:52992" });
  const globals = { window: dom, document: dom.document, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previousGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let current = initial;
  let root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, value] of previousGlobals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function Harness({ postedJob = job }) {
    const [doc, setDoc] = useState(current);
    return createElement(RequirementEvidencePanel, { job: postedJob, workspace: { facts, links: doc.requirementEvidence ?? [],
      async loadRetests() { return [retest]; },
      async save(command) {
        current = withRequirementEvidence(doc, facts, command, completedAt, kit, [view.id]);
        setDoc(current);
      },
    } });
  }
  async function open() {
    const panel = container.querySelector("details")!;
    await act(async () => { panel.open = true; panel.dispatchEvent(new dom.Event("toggle", { bubbles: true })); });
  }
  async function click(label: string, scope = container) {
    const button = [...scope.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
    assert.ok(button, label);
    await act(async () => button.click());
  }
  function withdraw(kind: string) {
    const card = [...container.querySelectorAll("article")].find(node => node.querySelector("strong")?.textContent?.startsWith(kind));
    assert.ok(card);
    return click("撤回关联", card as typeof container);
  }
  const review = () => recommendationReviewReader(current.requirementEvidence ?? [], facts)(job);
  await act(async () => root.render(createElement(Harness)));
  await open();
  const source = evidenceSources(facts)[0]!;
  const [claim, contribution] = [...container.querySelectorAll("select")].slice(1);
  assert.ok(claim);
  await act(async () => { claim.value = requirementSourceKey({ experienceId: source.experience.id, claimId: source.claim.id }); claim.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  const role = contribution ?? container.querySelectorAll("select")[2];
  assert.ok(role);
  await act(async () => { role.value = "design"; role.dispatchEvent(new dom.Event("change", { bubbles: true })); });
  await click("确认支持这项要求");
  assert.equal(review()?.supported, 1);
  assert.match(container.textContent!, /已有工作依据/);
  await click("查找独立复测");
  await click("关联这次独立复测");
  assert.deepEqual(current.requirementEvidence?.map(link => [link.capabilityId, link.sourceKind, link.contribution]), [
    [capabilityId, "work", "design"], [capabilityId, "independent-retest", "design"],
  ]);
  assert.match(container.textContent!, /准备面试案例/);
  const earlier = current;
  await withdraw("工作材料");
  assert.equal(review()?.supported, 0);
  assert.equal(review()?.partial, 1);
  assert.match(container.textContent!, /下一步补一份实际工作成果/);
  await withdraw("独立复测");
  assert.equal(review()?.partial, 0);
  assert.match(container.textContent!, /先找一条能说明本人做了什么的材料/);
  assert.equal(recommendationReviewReader(earlier.requirementEvidence!, facts)(job)?.supported, 1);
  assert.equal(current.requirementEvidence?.length, 4);
  const restored = preserveRequirementReviews(earlier, current);
  assert.deepEqual(recommendationReviewReader(restored.requirementEvidence!, facts)(job), { supported: 0, partial: 0, total: 1 });
  assert.deepEqual(preserveRequirementReviews(earlier, { ...current, documentId: "different-document" }), earlier);
  await act(async () => root.unmount());
  current = parseDocumentJson(exportDocumentJson(current));
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement(Harness)));
  await open();
  assert.match(container.textContent!, /查看这条要求的历史证据/);
  assert.match(container.textContent!, /首次提交状态未知后重复发起/);
  assert.match(container.textContent!, /已撤回/);
  assert.equal(review()?.partial, 0);
  const changedJob = { ...job, description: "岗位要求：验证数据库故障恢复" };
  await act(async () => root.render(createElement(Harness, { postedJob: changedJob })));
  assert.match(container.textContent!, /查看此前岗位版本的证据/);
  assert.match(container.textContent!, /独立设计数据库/);
  assert.equal(recommendationReviewReader(current.requirementEvidence!, facts)(changedJob), undefined);
});

test("retest provenance is exact and cannot be inferred from a copied or assisted answer", () => {
  const kit = fixture();
  const command = { job, itemId: item.id, quote: item.originalQuote, kitId: kit.id, sourceKind: "independent-retest",
    sourceVersion: requirementRetest(kit)!.version, assessment: "partial", contribution: "design" } as const;
  assert.throws(() => withRequirementEvidence(initial, facts, command, at, kit, ["elsewhere"]), /独立换情境/);
  assert.throws(() => withRequirementEvidence(initial, facts, { ...command, job: { ...job, id: "other-job" } }, at, kit, [view.id]), /独立换情境/);
  assert.throws(() => withRequirementEvidence(initial, facts, { ...command, assessment: "supports" }, at, kit, [view.id]), /独立换情境/);
  const [practice, retest] = kit.attempts;
  assert.ok(practice && retest);
  assert.throws(() => withRequirementEvidence(initial, facts, command, at,
    { ...kit, attempts: [practice, { ...retest, usedPreview: true }] }, [view.id]), /独立换情境/);
});


test("bundled example material and duplicate copies cannot create independent work evidence", () => {
  const sample = createDemoFactBase(at);
  const templateSources = evidenceSources(sample);
  assert.ok(templateSources.length);
  assert.ok(templateSources.every(source => source.kind === "unconfirmed"));
  const copied = structuredClone(facts);
  const experience = copied.experiences[0]!;
  experience.claims.push({ ...experience.claims[0]!, id: "extra-copy", tags: ["UI-only tag"] });
  const [original, duplicate] = evidenceSources(copied);
  assert.ok(original && duplicate);
  const command = { job, itemId: item.id, quote: item.originalQuote, experienceId: experience.id, claimId: original.claim.id,
    sourceVersion: original.sourceVersion, contribution: "design", assessment: "supports" } as const;
  const approved = withRequirementEvidence({ ...initial, factBase: copied }, copied, command, at);
  assert.throws(() => withRequirementEvidence(approved, copied, { ...command, claimId: duplicate.claim.id, sourceVersion: duplicate.sourceVersion }, at), /副本/);
});
