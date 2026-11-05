import type http from "node:http";
import { z } from "zod";
import { CapabilityTaskRequest, EvidenceReviewCommand, EvidenceProposalCommand, CreateSyntheticResumeCommand, ResumeChangeRequest, SaveResumeChangeCommand, RevokeResumePreviewCommand } from "@better-me/agent-contracts";
import { CareerCapabilities, type TaskAccess } from "./service.js";

export async function handleCapabilities(req: http.IncomingMessage, res: http.ServerResponse, pathname: string,
  service: CareerCapabilities, access: TaskAccess, readBody: (req: http.IncomingMessage) => Promise<unknown>,
  send: (res: http.ServerResponse, status: number, body: unknown) => void): Promise<boolean> {
  const root = "/api/v1/agent/capabilities";
  if (!pathname.startsWith(root)) return false;
  try {
    if (req.method === "GET" && pathname === root) send(res, 200, await service.snapshot());
    else if (req.method === "POST" && pathname === `${root}/assess`) {
      const body = z.object({ input: z.unknown().optional(), evidence: z.unknown().optional(), consent: z.boolean().optional(), intent: z.string().max(80).optional(), idempotencyKey: z.string().max(120).optional() }).strict().parse(await readBody(req));
      const snapshot = await service.snapshot(); send(res, 200, { ownerId: snapshot.ownerId, assessment: await service.assess(body, access) });
    }
    else if (req.method === "POST" && pathname === `${root}/tasks`) {
      const task = await service.start(CapabilityTaskRequest.parse(await readBody(req)), access);
      send(res, 202, { ownerId: task.ownerId, task });
    } else if (req.method === "POST" && pathname === `${root}/evidence-review`) {
      const review = await service.reviewEvidence(EvidenceReviewCommand.parse(await readBody(req)), access);
      send(res, 200, { ownerId: (await service.snapshot()).ownerId, review });
    } else if (req.method === "POST" && pathname === `${root}/evidence-proposal`) {
      const proposal = await service.proposeEvidence(EvidenceProposalCommand.parse(await readBody(req)), access);
      send(res, 200, { ownerId: (await service.snapshot()).ownerId, proposal });
    } else if (req.method === "POST" && pathname === `${root}/resumes/synthetic`) {
      const asset = await service.createSyntheticResume(CreateSyntheticResumeCommand.parse(await readBody(req)), access);
      send(res, 200, { ownerId: (await service.snapshot()).ownerId, asset });
    } else if (req.method === "POST" && pathname === `${root}/resumes/preview`) {
      const preview = await service.previewResumeChange(ResumeChangeRequest.parse(await readBody(req)), access);
      send(res, 200, { ownerId: (await service.snapshot()).ownerId, preview });
    } else if (req.method === "POST" && pathname === `${root}/resumes/save`) {
      const receipt = await service.saveResumeChange(SaveResumeChangeCommand.parse(await readBody(req)), access);
      send(res, 200, { ownerId: (await service.snapshot()).ownerId, receipt });
    } else if (req.method === "POST" && pathname === `${root}/resumes/revoke-preview`) {
      const receipt = await service.revokeResumePreview(RevokeResumePreviewCommand.parse(await readBody(req)), access);
      send(res, 200, { ownerId: (await service.snapshot()).ownerId, receipt });
    } else if (req.method === "POST" && pathname === `${root}/revoke`) {
      const { taskId } = z.object({ taskId: z.string().uuid() }).strict().parse(await readBody(req));
      await service.revoke(taskId, access); send(res, 200, await service.snapshot());
    } else if (req.method === "POST" && pathname === `${root}/retry-save`) {
      const { taskId } = z.object({ taskId: z.string().uuid(), consent: z.literal(true) }).strict().parse(await readBody(req));
      await service.retrySave(taskId, access); send(res, 200, await service.snapshot());
    } else if (req.method === "POST" && pathname === `${root}/revalidate`) {
      const body = z.object({ version: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(), consent: z.literal(true) }).strict().parse(await readBody(req));
      await service.revalidate(body.version, body.expectedRevision, access); send(res, 200, await service.snapshot());
    } else if (req.method === "POST" && pathname === `${root}/disable`) {
      const body = z.object({ version: z.number().int().positive(), expectedRevision: z.number().int().nonnegative() }).strict().parse(await readBody(req));
      await service.disable(body.version, body.expectedRevision, access); send(res, 200, await service.snapshot());
    } else send(res, 404, { error: "capability_route_not_found" });
  } catch (error) {
    const known = error as { status?: number; code?: string };
    send(res, error instanceof z.ZodError ? 400 : known.status ?? 500,
      { error: error instanceof z.ZodError ? "invalid_capability_request" : known.code ?? "capability_operation_failed" });
  }
  return true;
}
