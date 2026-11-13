import { z } from "zod";
import { StudioContextInputSchema, StudioOperationSchema, StudioLocalRuntimeSchema, type StudioContext, type StudioLocalRuntime, type StudioOperation } from "@better-me/agent-contracts/career-studio";
import { agentOrigin, captureIdentityLease, IdentityBoundaryError, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { StudioAnalysisRequestSchema } from "@better-me/agent-contracts";
import { createStudioAnalysisTaskClient } from "./studio-analysis-task-client";
import { createStudioCommitteeTaskClient } from "./studio-committee-task-client";
import { AgentTaskClientError } from "./agent-task-transport";

export class CareerStudioClientError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = "CareerStudioClientError"; }
}
export type StudioRequest = (route: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
const contextResponse = z.object({ context: StudioContextInputSchema.omit({ consent: true }).extend({ id: z.string(), ownerId: z.string(), session: z.string(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), revoked: z.boolean(), hostGeneration: z.string().optional() }).strict(), revision: z.number().int().positive(), claimHashes: z.record(z.string()), limitations: z.array(z.string()) }).strict();

/** Fixed paired Host only. No browser-stored token/context, arbitrary endpoint,
 * owner override, retry or alternate paid-model fallback. */
export function createCareerStudioClient(fetcher: typeof fetch = fetch) {
  const contexts = new Map<string, StudioContext>(), analysis = createStudioAnalysisTaskClient({ fetch: fetcher }), committee = createStudioCommitteeTaskClient({ fetch: fetcher });
  const request: StudioRequest = async (route, body, signal) => {
    if (!/^\/[a-z][a-z0-9/-]*$/.test(route)) throw new CareerStudioClientError("invalid_studio_route");
    const lease = captureIdentityLease(); lease.assert(); if (!lease.ownerId) throw new CareerStudioClientError("identity_required", 401);
    if (route === "/committee/start" || route === "/committee/resume" || ["/operation/read", "/operation/cancel"].includes(route) && z.object({ operationId: z.string().startsWith("ct_") }).safeParse(body).success) {
      const input = z.object({ contextId: z.string(), operationId: z.string().optional(), runtime: StudioLocalRuntimeSchema.optional(), consent: z.boolean().optional() }).passthrough().parse(body), context = contexts.get(input.contextId);
      if (!context || context.ownerId !== lease.ownerId || context.revoked) throw new CareerStudioClientError("studio_context_stale", 409);
      const result = route === "/committee/start" ? await committee.start(body, context, signal)
        : route === "/operation/read" ? await committee.get(input.operationId!, context, signal)
        : route === "/operation/cancel" ? await committee.pause(input.operationId!, context)
        : input.consent === true ? await committee.resume(input.operationId!, context, input.runtime, signal) : (() => { throw new CareerStudioClientError("explicit_committee_resume_consent_required", 422); })();
      lease.assert(); return result;
    }
    if (route === "/model") {
      const input = StudioAnalysisRequestSchema.parse(body), context = contexts.get(input.contextId);
      if (!context || context.ownerId !== lease.ownerId || context.revoked || Date.parse(context.expiresAt) <= Date.now()) throw new CareerStudioClientError("studio_context_stale", 409);
      const result = await analysis.generate(input, context.workspaceKey, signal); lease.assert(); return result;
    }
    let response: Response;
    try { response = await ownedFetch(`${agentOrigin()}/api/v1/agent/career-studio${route}`, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([lease.signal, AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]) }, fetcher); }
    catch (error) { lease.assert(); if (error instanceof IdentityBoundaryError || signal?.aborted) throw error; throw new CareerStudioClientError("studio_outcome_unknown_check_state"); }
    const length = Number(response.headers.get("content-length") ?? 0); if (length > 16_000_000) throw new CareerStudioClientError("studio_response_too_large");
    const text = await response.text(); lease.assert(); if (text.length > 16_000_000) throw new CareerStudioClientError("studio_response_too_large");
    let payload: unknown; try { payload = JSON.parse(text); } catch { throw new CareerStudioClientError("invalid_studio_response"); }
    if (!response.ok) { const error = z.object({ error: z.string().max(300) }).safeParse(payload); throw new CareerStudioClientError(error.success ? error.data.error : "studio_request_failed", response.status); }
    if (route === "/context/revoke") {
      const revoked = z.object({ contextId: z.string() }).parse(body), context = contexts.get(revoked.contextId);
      if (context) contexts.set(context.id, { ...context, revoked: true });
    }
    return payload;
  };
  return {
    request,
    async runtimes(signal?: AbortSignal): Promise<StudioLocalRuntime[]> { return z.object({ runtimes: z.array(StudioLocalRuntimeSchema) }).parse(await request("/runtimes", undefined, signal)).runtimes; },
    async context(raw: z.input<typeof StudioContextInputSchema>): Promise<{ context: StudioContext; revision: number; claimHashes: Record<string, string>; limitations: string[] }> {
      const lease = captureIdentityLease(), result = contextResponse.parse(await request("/context/create", StudioContextInputSchema.parse(raw))); lease.assert();
      if (result.context.ownerId !== lease.ownerId) throw new IdentityBoundaryError(); contexts.set(result.context.id, result.context); return result;
    },
    async operation(contextId: string, operationId: string, signal?: AbortSignal): Promise<StudioOperation> {
      const operation = StudioOperationSchema.parse(await request("/operation/read", { contextId, operationId }, signal));
      if (operation.contextId !== contextId || operation.id !== operationId) throw new CareerStudioClientError("studio_operation_scope_mismatch"); return operation;
    },
  };
}

export function careerStudioError(error: unknown): string {
  if (error instanceof IdentityBoundaryError) return error.message;
  if (error instanceof AgentTaskClientError) return error.message;
  const code = error instanceof CareerStudioClientError ? error.code : error instanceof Error ? error.message : "studio_request_failed";
  const labels: Record<string, string> = { identity_required: "请先登录 BetterMe 账号。", studio_context_stale: "资料或授权已失效，请重新建立分析快照。",
    studio_outcome_unknown_check_state: "操作结果尚未确认。请刷新状态对账，不要重复派送。", studio_idempotency_conflict: "该操作编号对应另一份内容；未覆盖，也未重跑。",
    explicit_local_runtime_required: "请明确选择已安装的本地模型；没有换用云端。", local_models_unavailable: "本地 Ollama 暂不可用；没有创建云端请求。",
    studio_source_changed_new_review_required: "源码已变化，旧证据不能采用。请创建新审查。", studio_publication_evidence_ineligible: "这条陈述尚无足够的受支持证据，不能生成公开核对记录。",
    badge_renderer_unavailable: "Vork 渲染器未配置或不可用；尚未渲染图片。", studio_operation_busy: "已有有界分析在运行，请先完成或取消。",
    studio_sensitive_or_large_input: "资料含疑似秘密或超出预算；请缩小选择，不会发送给模型。" };
  return labels[code] ?? `操作未确认（${code.slice(0, 180)}）。没有自动重试、改写事实或切换模型。`;
}
