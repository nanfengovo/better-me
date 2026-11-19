import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_AUTOPILOT_TELEMETRY, selectNodeKernelTasks } from "../src/components/autopilot/autopilot-telemetry";

test("selectNodeKernelTasks matches tasks by pipeline tag and falls back to recent tasks", () => {
  const telemetry = {
    ...EMPTY_AUTOPILOT_TELEMETRY,
    authenticated: true,
    totalTasks: 3,
    runningCount: 1,
    awaitingCount: 1,
    completedCount: 1,
    tasks: [
      { id: "t1", kind: "jd_intake" as const, status: "running" as const, title: "Job Intake", updatedAt: "2026-11-18T10:00:00Z" },
      { id: "t2", kind: "resume_tailor" as const, status: "awaiting_review" as const, title: "Tailor Resume", updatedAt: "2026-11-18T11:00:00Z" },
      { id: "t3", kind: "mock_interview" as const, status: "completed" as const, title: "System Design", updatedAt: "2026-11-18T12:00:00Z" },
    ],
  };
  assert.deepEqual(selectNodeKernelTasks({ tag: "SOURCING" }, telemetry).map((item) => item.id), ["t1"]);
  assert.deepEqual(selectNodeKernelTasks({ tag: "INTERVIEW" }, telemetry).map((item) => item.id), ["t3"]);
  assert.equal(selectNodeKernelTasks({ tag: "SANDBOX" }, telemetry).length, 3);
});
