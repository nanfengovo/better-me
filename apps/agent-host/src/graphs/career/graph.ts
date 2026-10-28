import { randomUUID } from "node:crypto";
import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { ArtifactEnvelopeSchema } from "@better-me/agent-contracts";
import { CareerAnnotation, type CareerState, type CareerWorkerId, type WorkerStatus } from "./state.js";

export const DEFAULT_CAREER_WORKERS: Array<{ id: CareerWorkerId; label: string; role: string }> = [
  { id: "discovery", label: "岗位发现", role: "只读搜索平台，返回带来源的 JobCandidate" },
  { id: "company-research", label: "公司研究", role: "收集公开官网与企业证据，返回 CompanyEvidence" },
  { id: "match", label: "简历匹配", role: "比较已授权履历条目与岗位要求，返回 MatchProposal" },
  { id: "location-evidence", label: "地点核验", role: "解析来源地址，不生成推测坐标，返回 LocationCandidate" },
  { id: "fact-check", label: "事实检查", role: "检查冲突、来源、TTL 与覆盖缺口，返回 CoverageReceipt" },
];

function artifact(runId: string, type: "SearchPlan" | "CoverageReceipt", payload: Record<string, string | number | boolean | null | string[]>): CareerState["artifacts"][number] {
  return ArtifactEnvelopeSchema.parse({
    id: `${type.toLowerCase()}-${randomUUID()}`,
    type,
    version: 1,
    createdAt: new Date().toISOString(),
    runId,
    sourceRefs: [],
    payload,
  });
}

function readyWorkers(requestedRuntimeId?: string): WorkerStatus[] {
  return DEFAULT_CAREER_WORKERS.map((worker) => ({
    id: worker.id,
    status: "ready",
    ...(requestedRuntimeId ? { runtimeId: requestedRuntimeId } : {}),
  }));
}

export function buildCareerOrchestrator(checkpointer: BaseCheckpointSaver) {
  const graph = new StateGraph(CareerAnnotation)
    .addNode("intake", async (state: CareerState): Promise<Partial<CareerState>> => {
      if (!state.task.trim()) return { currentStep: "response", errors: ["intake: task is empty"], stepLog: ["intake: rejected empty task"] };
      return { currentStep: "plan", stepLog: ["intake: accepted task without persisting private conversation"] };
    })
    .addNode("plan", async (state: CareerState): Promise<Partial<CareerState>> => ({
      currentStep: "fanout",
      workers: readyWorkers(state.requestedRuntimeId),
      artifacts: [artifact(state.workspaceId, "SearchPlan", {
        scope: "better-me-career",
        task: state.task,
        workerCount: DEFAULT_CAREER_WORKERS.length,
        runtimeId: state.requestedRuntimeId ?? null,
      })],
      stepLog: ["plan: created SearchPlan and minimum ContextPack boundaries"],
    }))
    .addNode("fanout", async (state: CareerState): Promise<Partial<CareerState>> => ({
      currentStep: "normalize",
      workers: state.workers.map((worker) => ({ ...worker, status: "queued" })),
      stepLog: ["fanout: queued discovery, research, match, location and fact-check workers"],
    }))
    .addNode("normalize", async (state: CareerState): Promise<Partial<CareerState>> => ({
      currentStep: "locationEvidence",
      stepLog: ["normalize: worker output must become versioned artifacts before sharing"],
    }))
    .addNode("locationEvidence", async (_state: CareerState): Promise<Partial<CareerState>> => ({
      currentStep: "factCheck",
      stepLog: ["locationEvidence: no coordinate is inferred from a city or company name"],
    }))
    .addNode("factCheck", async (_state: CareerState): Promise<Partial<CareerState>> => ({
      currentStep: "coverage",
      stepLog: ["factCheck: source references and conflicts are required for promotion"],
    }))
    .addNode("coverageCheck", async (state: CareerState): Promise<Partial<CareerState>> => {
      const completed = state.workers.filter((worker) => worker.status === "completed").length;
      const missing = state.workers.filter((worker) => worker.status !== "completed").map((worker) => worker.id);
      return {
        currentStep: "approval",
        coverage: { attempted: state.workers.length, completed, missing },
        artifacts: [artifact(state.workspaceId, "CoverageReceipt", {
          attempted: state.workers.length,
          completed,
          missing: missing.join(","),
        })],
        stepLog: [`coverage: ${completed}/${state.workers.length} workers have promotable output`],
      };
    })
    .addNode("approvalGate", async (state: CareerState): Promise<Partial<CareerState>> => {
      if (state.approval) return { currentStep: state.approval.status === "approved" ? "commit" : "response", stepLog: [`approval: ${state.approval.status}`] };
      const decision = interrupt({
        type: "career_approval",
        artifactRefs: state.artifacts.map((item) => item.id),
        coverage: state.coverage,
        impact: "仅提交已批准 Artifact；不会直接修改岗位库、地图坐标或用户事实",
      }) as CareerState["approval"];
      return { approval: decision, currentStep: decision?.status === "approved" ? "commit" : "response", stepLog: ["approval: received human decision"] };
    })
    .addNode("commit", async (state: CareerState): Promise<Partial<CareerState>> => {
      if (state.approval?.status !== "approved") return { currentStep: "response", errors: ["commit: approval is required"], stepLog: ["commit: fail-closed"] };
      return { currentStep: "response", stepLog: ["commit: emitted proposal; deterministic business tools own the actual write"] };
    })
    .addNode("response", async (state: CareerState): Promise<Partial<CareerState>> => ({ currentStep: "response", stepLog: ["response: returned artifacts, coverage and audit trail"] }))
    .addEdge(START, "intake")
    .addEdge("intake", "plan")
    .addEdge("plan", "fanout")
    .addEdge("fanout", "normalize")
    .addEdge("normalize", "locationEvidence")
    .addEdge("locationEvidence", "factCheck")
    .addEdge("factCheck", "coverageCheck")
    .addEdge("coverageCheck", "approvalGate")
    .addEdge("approvalGate", "commit")
    .addEdge("commit", "response")
    .addEdge("response", END);

  return graph.compile({ checkpointer });
}

export type CareerOrchestrator = ReturnType<typeof buildCareerOrchestrator>;
