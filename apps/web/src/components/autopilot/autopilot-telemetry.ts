import { AgentTaskListSummarySchema, type AgentTaskSummary, type AgentTaskListSummary } from "@better-me/agent-contracts";
import { agentOrigin, captureIdentityLease, ownedFetch } from "../../lib/identity";
import { readRuntimeConnection } from "../../lib/runtime-connection";
import { fetchUsage, type UsageSnapshot } from "../../services/system-status-client";
import type { StudioNode } from "../AutopilotStudioWorkspace";

export type KernelTaskSummary = AgentTaskSummary;

export type AutopilotKernelTelemetry = Omit<AgentTaskListSummary, "ownerId"> & {
  authenticated: boolean;
  usage?: UsageSnapshot;
};

export const EMPTY_AUTOPILOT_TELEMETRY: AutopilotKernelTelemetry = {
  authenticated: false,
  totalTasks: 0,
  runningCount: 0,
  awaitingCount: 0,
  completedCount: 0,
  pausedCount: 0,
  failedCount: 0,
  tasks: [],
};

/**
 * Fetches live AgentTaskKernel and host model-usage telemetry for authenticated workspaces.
 * Unauthenticated or mocked offline renders fail closed to EMPTY_AUTOPILOT_TELEMETRY without throwing.
 */
export async function fetchAutopilotKernelTelemetry(): Promise<AutopilotKernelTelemetry> {
  const lease = captureIdentityLease();
  if (!lease.ownerId) return EMPTY_AUTOPILOT_TELEMETRY;
  try {
    const token = readRuntimeConnection()?.agentToken ?? "better-me-agent-token";
    const [response, usage] = await Promise.all([
      ownedFetch(`${agentOrigin()}/api/v1/agent/tasks/summary`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      }),
      fetchUsage().catch(() => undefined),
    ]);
    if (!response.ok) return EMPTY_AUTOPILOT_TELEMETRY;
    const { ownerId, ...summary } = AgentTaskListSummarySchema.parse(await response.json());
    lease.assert();
    if (lease.ownerId !== ownerId) return EMPTY_AUTOPILOT_TELEMETRY;
    return { ...summary, authenticated: true, usage: usage ?? undefined };
  } catch {
    return EMPTY_AUTOPILOT_TELEMETRY;
  }
}

const NODE_KIND_MAP: Record<string, AgentTaskSummary["kind"][]> = {
  CORE: ["career_inventory", "project_understanding"],
  SOURCING: ["jd_intake", "jd_ocr"],
  GUARD: ["jd_intake", "career_inventory"],
  ANALYSIS: ["jd_match", "studio_analysis", "project_understanding"],
  TRIAGE: ["jd_match", "career_coach"],
  TAILOR: ["resume_tailor", "experience_refine", "studio_committee"],
  VERIFY: ["studio_committee", "resume_tailor"],
  INTERVIEW: ["mock_interview", "career_coach", "growth_practice"],
  SANDBOX: ["free_chat"],
};

export function selectNodeKernelTasks(node: Pick<StudioNode, "tag">, telemetry: AutopilotKernelTelemetry): KernelTaskSummary[] {
  const matchingKinds = NODE_KIND_MAP[node.tag];
  if (!matchingKinds?.length) return telemetry.tasks.slice(0, 3);
  const matched = telemetry.tasks.filter((task) => matchingKinds.includes(task.kind));
  return (matched.length > 0 ? matched : telemetry.tasks).slice(0, 3);
}
