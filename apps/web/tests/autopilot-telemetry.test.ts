import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_AUTOPILOT_TELEMETRY,
  fetchAutopilotKernelTelemetry,
  selectNodeKernelTasks,
  type AutopilotKernelTelemetry,
} from "../src/components/autopilot/autopilot-telemetry";
import { activatePrincipal } from "../src/lib/identity";

test("only matching pipeline tasks appear, even outside the global recent list", () => {
  const recent = [
    { id: "t3", kind: "mock_interview" as const, status: "completed" as const, title: "System Design", updatedAt: "2026-11-18T12:00:00Z" },
    { id: "t2", kind: "resume_tailor" as const, status: "awaiting_review" as const, title: "Tailor Resume", updatedAt: "2026-11-18T11:00:00Z" },
  ];
  const telemetry: AutopilotKernelTelemetry = {
    ...EMPTY_AUTOPILOT_TELEMETRY,
    authenticated: true,
    totalTasks: 3,
    readyCount: 1,
    awaitingCount: 1,
    completedCount: 1,
    tasks: recent,
    recentByKind: [
      ...recent,
      { id: "t1", kind: "jd_intake", status: "ready", title: "Job Intake", updatedAt: "2026-11-18T10:00:00Z" },
    ],
  };
  assert.deepEqual(selectNodeKernelTasks({ tag: "SOURCING" }, telemetry).map((item) => [item.id, item.status]), [["t1", "ready"]]);
  assert.deepEqual(selectNodeKernelTasks({ tag: "INTERVIEW" }, telemetry).map((item) => item.id), ["t3"]);
  assert.deepEqual(selectNodeKernelTasks({ tag: "SANDBOX" }, telemetry), []);
  assert.deepEqual(selectNodeKernelTasks({ tag: "UNKNOWN" }, telemetry), []);
});

test("an old owner's refresh cannot add results to that owner's cache after switching", async t => {
  const first = "832136ee-a4db-419d-8aa4-7ef798ba597b";
  const second = "ec1e5eef-85ac-41c4-8d4e-4928db115178";
  const requests = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected fetch"); });
  t.after(() => activatePrincipal(undefined));
  activatePrincipal({ id: second, username: "second", displayName: "Second" });
  assert.equal(await fetchAutopilotKernelTelemetry(first), EMPTY_AUTOPILOT_TELEMETRY);
  assert.equal(requests.mock.callCount(), 0);
});
