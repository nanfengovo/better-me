import { z } from "zod";
import type { CapabilitySnapshot, JobComparisonInput, EvidenceReviewInput, EvidenceReviewCommand, EvidenceProposalCommand,
  CreateSyntheticResumeCommand, ResumeChangeRequest, ResumeChangePreview, SaveResumeChangeCommand, RevokeResumePreviewCommand } from "@better-me/agent-contracts";
import { agentOrigin, captureIdentityLease, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";

/** A client belongs to one identity GENERATION, not merely an equal owner string. */
export function createCapabilityClient(fetcher: typeof fetch = fetch) {
  const lease = captureIdentityLease();
  async function call(route = "", body?: unknown) {
    lease.assert(); if (!lease.ownerId) throw new Error("请先登录当前 BetterMe 账号");
    const response = await ownedFetch(`${agentOrigin()}/api/v1/agent/capabilities${route}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]),
      headers: { Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, fetcher);
    const value: unknown = await response.json(); lease.assert();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(value);
      throw new Error(error.success ? error.data.error : "能力任务未完成；没有覆盖已有资料");
    }
    z.object({ ownerId: z.literal(lease.ownerId) }).passthrough().parse(value);
    return value;
  }
  return {
    async load() { return await call() as CapabilitySnapshot; },
    async start(input: JobComparisonInput, catalogRevision: number, key: string = crypto.randomUUID()) {
      return call("/tasks", { input, consent: true, expectedCatalogRevision: catalogRevision, idempotencyKey: key });
    },
    async startEvidenceReview(input: JobComparisonInput, evidence: EvidenceReviewInput, catalogRevision: number, key: string = crypto.randomUUID()) {
      return call("/tasks", { input, evidence, intent: "prepare-evidence-review", consent: true, expectedCatalogRevision: catalogRevision, idempotencyKey: key });
    },
    async revoke(taskId: string) { return call("/revoke", { taskId }); },
    async reviewEvidence(command: EvidenceReviewCommand) { return call("/evidence-review", command); },
    async proposeEvidence(command: EvidenceProposalCommand) { return call("/evidence-proposal", command); },
    async createSyntheticResume(command: CreateSyntheticResumeCommand) { return call("/resumes/synthetic", command); },
    async previewResumeChange(command: ResumeChangeRequest) { return (await call("/resumes/preview", command) as { preview: ResumeChangePreview }).preview; },
    async saveResumeChange(command: SaveResumeChangeCommand) { return call("/resumes/save", command); },
    async revokeResumePreview(command: RevokeResumePreviewCommand) { return call("/resumes/revoke-preview", command); },
    async retrySave(taskId: string) { return call("/retry-save", { taskId, consent: true }); },
    async disable(version: number, expectedRevision: number) { return call("/disable", { version, expectedRevision }); },
    async revalidate(version: number, expectedRevision: number) { return call("/revalidate", { version, expectedRevision, consent: true }); },
    assert: lease.assert,
  };
}
