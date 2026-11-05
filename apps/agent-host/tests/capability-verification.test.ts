import test from "node:test";
import assert from "node:assert/strict";
import { syntheticJobComparison } from "@better-me/agent-contracts";
import { compareJobs, qualify, verifyTaskOutput } from "../src/capabilities/verification.js";
import { executeTransform } from "../src/capabilities/sandbox.js";
import { fixtureSource } from "./fixtures/capability-source.js";

test("namespace collisions never become same-job comparisons; missing batch rows never imply closure", async () => {
  const input = syntheticJobComparison(); input.after.sourceNamespace = "synthetic:other-company-board";
  const report = compareJobs(verifyTaskOutput(input, await executeTransform(fixtureSource, input)));
  assert.equal(report.changes.length, 0); assert.equal(report.unmatched.length, 4);
  assert.ok(report.unmatched.every(item => item.reason.includes("不代表关闭")));
});
test("duplicate source IDs are retained and surfaced for review rather than arbitrarily paired", async () => {
  const input = syntheticJobComparison();
  if (input.before.format !== "board-v1") throw new Error("fixture_format");
  input.before.jobs.push({ jobId: "101", title: "冲突", requirements: ["Python"] });
  const report = compareJobs(verifyTaskOutput(input, await executeTransform(fixtureSource, input)));
  assert.equal(report.rowsBefore, 3); assert.equal(report.changes.length, 0);
  assert.equal(report.unmatched.filter(item => item.reason.includes("重复")).length, 3);
});
test("schema-valid fabricated sources, altered requirements and omitted rows do not pass independent result verification", async () => {
  const input = syntheticJobComparison(), output = await executeTransform(fixtureSource, input) as Array<Record<string, unknown>>;
  for (const field of ["sourceNamespace", "jobId", "snapshotAt", "title", "requirements"] as const) {
    const forged = structuredClone(output); forged[0]![field] = field === "requirements" ? ["invented"] : field === "snapshotAt" ? "2020-01-01T00:00:00Z" : "forged";
    assert.throws(() => verifyTaskOutput(input, forged));
  }
  assert.throws(() => verifyTaskOutput(input, output.slice(1)));
  assert.equal((await qualify("() => []")).status, "failed");
});
