import test from "node:test";
import assert from "node:assert/strict";
import { createDemoFactBase, createDefaultResumeView, syncResumeViewsWithFactBase, projectResume } from "../dist/index.js";

function fixture() {
  const base = createDemoFactBase();
  const seed = base.experiences[0];
  base.experiences = ["a", "b"].map((id) => ({ ...structuredClone(seed), id }));
  const added = { ...structuredClone(seed), id: "new" };
  return { base, added, view: createDefaultResumeView(base) };
}

test("default and legacy complete views follow newly added experiences", () => {
  const { base, added, view } = fixture();
  const next = { ...base, experiences: [...base.experiences, added] };
  const legacy = { ...view, id: "legacy", experienceSelection: undefined, includedExperienceIds: ["a", "b"] };
  const synced = syncResumeViewsWithFactBase(base, next, [view, legacy], view.id);
  for (const item of synced) assert.deepEqual(projectResume(next, item).experiences.map((e) => e.id), ["a", "b", "new"]);
});

test("active selected view adds new experience and keeps previously hidden ones hidden", () => {
  const { base, added, view } = fixture();
  const selected = { ...view, experienceSelection: "selected", includedExperienceIds: ["a"] };
  const other = { ...selected, id: "other" };
  const next = { ...base, experiences: [...base.experiences, added] };
  const synced = syncResumeViewsWithFactBase(base, next, [selected, other], selected.id);
  assert.deepEqual(projectResume(next, synced[0]).experiences.map((e) => e.id), ["a", "new"]);
  assert.deepEqual(projectResume(next, synced[1]).experiences.map((e) => e.id), ["a"]);
});

test("deleting the last selected experience does not expose excluded experiences", () => {
  const { base, view } = fixture();
  const selected = { ...view, experienceSelection: "selected", includedExperienceIds: ["a"] };
  const next = { ...base, experiences: base.experiences.filter((e) => e.id === "b") };
  const [synced] = syncResumeViewsWithFactBase(base, next, [selected], selected.id);
  assert.deepEqual(synced.includedExperienceIds, []);
  assert.deepEqual(projectResume(next, synced).experiences, []);
});

test("unverified metrics stay out of output until user confirmation", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = [{ id: "metric", kind: "metric", text: { zh: "降低延迟37%" }, metric: { value: 37, unit: "%", confirmed: false }, tags: [] }];
  assert.equal(projectResume(base, view).experiences[0].claims.length, 0);
  base.experiences[0].claims[0].metric.confirmed = true;
  assert.equal(projectResume(base, view).experiences[0].claims[0].text, "降低延迟37%");
});

test("selected claim views follow new claims without exposing old exclusions or deleted selections", () => {
  const { base, view } = fixture();
  base.experiences[0].claims = ["a", "b"].map((id) => ({ id, kind: "action", text: { zh: id }, tags: [] }));
  const selected = { ...view, claimSelection: "selected", includedClaimIds: ["a"] };
  const next = structuredClone(base);
  next.experiences[0].claims = [next.experiences[0].claims[1], { id: "new", kind: "action", text: { zh: "new" }, tags: [] }];
  const [synced] = syncResumeViewsWithFactBase(base, next, [selected], selected.id);
  assert.deepEqual(synced.includedClaimIds, ["new"]);
  assert.deepEqual(projectResume(next, synced).experiences[0].claims.map((claim) => claim.id), ["new"]);
  const last = structuredClone(next);
  last.experiences[0].claims = [next.experiences[0].claims[0]];
  const [empty] = syncResumeViewsWithFactBase(next, last, [synced], synced.id);
  assert.deepEqual(projectResume(last, empty).experiences[0].claims, []);
});
