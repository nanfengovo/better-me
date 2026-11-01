import type { ProjectUnderstanding, UnderstandingSession } from "@better-me/agent-contracts";

export const fixtureUnderstanding: ProjectUnderstanding = {
  summary: "合成项目只协调订单与任务回执，不负责车辆路线规划。",
  terms: [{ term: "调度", meaning: "在本合成项目中指任务提交与回执协调", evidenceIds: [] }],
  boundaries: ["不负责车辆控制"], claims: [{ id: "scope", text: "任务协调属于项目范围，不等于个人贡献", kind: "user", evidenceIds: [] }],
  unknowns: ["失败回执如何处理仍需说明"],
};
export function fixtureSession(patch: Partial<UnderstandingSession> = {}): UnderstandingSession {
  return { version: 1, id: "synthetic-understanding", workspaceKey: "synthetic-workspace", projectKey: "synthetic-project",
    label: "合成项目", sourceText: "负责合成项目接口开发，参与任务协调。", revision: 1, phase: "idle", turnCount: 0,
    createdAt: "2026-11-01T01:00:00.000Z", updatedAt: "2026-11-01T01:00:00.000Z", grants: [], evidence: [], messages: [], events: [], ...patch };
}
