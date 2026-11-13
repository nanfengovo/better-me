import assert from "node:assert/strict";
import test from "node:test";
import { emptyCareerJobObservation, parseCareerJobObservation } from "../src/components/CareerJobObservationEditor";

test("unknown observation stays unknown and never derives salary, grouping or requirements from labels", () => {
  assert.deepEqual(parseCareerJobObservation(emptyCareerJobObservation(), ["sqlite"]), { companyKey: null, roleKey: null, locationKey: null, departmentKey: null, refreshTimes: [] });
});
test("explicit requirements retain hard gates/contribution and duplicate timestamps normalize with timezone", () => {
  const result = parseCareerJobObservation({ ...emptyCareerJobObservation(), companyKey: "company-a", roleKey: "role-a", locationKey: "office-a", detailedRequirements: true,
    requirements: [{ skillId: "sqlite", weight: 5, hard: true, knowledge: "known", contribution: "implementation" }], refreshTimes: "2026-11-09T08:00:00+08:00\n2026-11-09T00:00:00Z" }, ["sqlite", "rust"]);
  assert.deepEqual(result.refreshTimes, ["2026-11-09T00:00:00.000Z"]); assert.equal(result.requirements![0]!.hard, true); assert.equal(result.requirements![1]!.knowledge, "unknown");
});
test("salary requires explicit annual/gross/base values and order; no monthly or timezone guessing", () => {
  const draft = { ...emptyCareerJobObservation(), comparableSalary: true, salaryMin: "300000", salaryMax: "500000", salaryCurrency: "cny", salaryDisclosedAt: "2026-11-09T08:00:00+08:00" };
  const result = parseCareerJobObservation(draft, []); assert.equal(result.comparableSalary!.period, "annual"); assert.equal(result.comparableSalary!.currency, "CNY");
  for (const patch of [{ salaryMin: "30k/月" }, { salaryMin: "600000" }, { salaryDisclosedAt: "2026-11-09T08:00:00" }, { salaryCurrency: "人民币" }, { refreshTimes: "2026-11-09T08:00:00" }]) assert.throws(() => parseCareerJobObservation({ ...draft, ...patch }, []));
});
