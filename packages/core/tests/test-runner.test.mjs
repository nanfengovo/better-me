import assert from "node:assert/strict";
import test from "node:test";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverUnitTests, pdfParserTest, planUnitTests, runUnitTests, unitTestPatterns } from "../../../scripts/run-unit-tests.mjs";

test("unit plan isolates the bounded PDF worker without omitting or duplicating any original test glob", () => {
  assert.deepEqual(unitTestPatterns, [
    "packages/core/tests/*.test.mjs", "packages/storage/tests/*.test.ts",
    "packages/opportunities/tests/*.test.ts", "packages/source-adapters/tests/*.test.ts",
    "apps/job-service/tests/*.test.ts", "apps/agent-host/tests/*.test.ts",
    "apps/web/tests/*.test.ts", "apps/web/tests/*.test.tsx",
  ]);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = discoverUnitTests(root), plan = planUnitTests(files);
  const originalFiles = [...new Set(unitTestPatterns.flatMap(pattern =>
    [...globSync(pattern, { cwd: root })].map(file => file.split(path.sep).join("/"))))].sort();
  assert.deepEqual(files, originalFiles);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].files, [pdfParserTest]);
  assert.equal(plan[0].concurrency, 1);
  assert.equal(plan[1].concurrency, 4);
  const planned = plan.flatMap(group => group.files);
  assert.equal(new Set(planned).size, planned.length, "each file must execute exactly once");
  assert.deepEqual(planned.sort(), originalFiles, "the full original suite must still run");
});

test("unit plan fails closed when the PDF regression file is absent", () => {
  assert.throws(() => planUnitTests(["packages/core/tests/core.test.mjs"]), /Missing bounded PDF parser regression/);
});

test("unit runner propagates either group's failures and never masks child startup errors", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  for (const statuses of [[7], [0, 9], [0, null], [0, 0]]) {
    let calls = 0;
    assert.equal(runUnitTests(root, (_exe, args, options) => {
      assert.equal(options.shell, undefined, "paths are passed directly, not through a shell");
      assert.equal(options.stdio, "inherit");
      assert.ok(args.includes("--test-reporter=tap"));
      assert.ok(!args.some(arg => arg.startsWith("--test-skip")));
      return { status: statuses[calls++] };
    }), statuses.at(-1) ?? 1);
    assert.equal(calls, statuses.length);
  }
  const failure = new Error("synthetic child startup denied");
  assert.throws(() => runUnitTests(root, () => ({ error: failure })), error => error === failure);
});
