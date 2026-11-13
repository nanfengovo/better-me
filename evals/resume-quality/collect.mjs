import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentTaskSchema } from "../../packages/agent-contracts/src/agent-task.ts";
import { CareerTaskBudgetSchema, CareerRuntimeBindingSchema } from "../../packages/agent-contracts/src/career-task.ts";
import { archiveTaskFailure, freezeTaskCandidate, loadGoldCase, metadataSchema, prepareBenchmarkRequest } from "./freeze.mjs";
import { digest } from "./gold/extract.mjs";

export const COLLECTION_PROTOCOL = "resume-quality-http-collection-v1";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
class CollectionError extends Error { constructor(code) { super(code); this.code = code; } }
const code = (error, fallback) => error instanceof CollectionError ? error.code
  : typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : fallback;
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const write = (file, value) => fs.writeFile(file, jsonBytes(value), { flag: "wx", mode: 0o600 });

/** Only normal authenticated loopback tasks HTTP. Credentials stay in memory; no SDK or retry/fallback executor. */
export function taskHttp({ baseUrl, headers, requestTimeoutMs = 30_000, transport = fetch }) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || !url.port) throw new CollectionError("explicit_loopback_host_required");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw new CollectionError("invalid_request_timeout");
  return async (suffix = "", body) => {
    if (!/^(?:\/ct_[a-f0-9]{32}(?:\/start)?)?$/.test(suffix)) throw new CollectionError("tasks_route_required");
    let response;
    try {
      response = await transport(`${url.origin}/api/v1/agent/tasks${suffix}`, { method: body === undefined ? "GET" : "POST",
        headers: { ...headers, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new CollectionError("http_receipt_unknown"); }
    // Whole JSON response, including all task input/output; no substring or response-size clipping.
    let payload;
    try { payload = JSON.parse(await response.text()); } catch { throw new CollectionError("http_response_invalid"); }
    if (!response.ok) throw new CollectionError(typeof payload.error === "string" && /^[a-z][a-z0-9_]{1,100}$/.test(payload.error) ? payload.error : "http_request_rejected");
    return payload;
  };
}

function matches(task, request, ownerId) {
  return task.kind === "free_chat" && task.ownerId === ownerId && task.workspaceKey === request.workspaceKey
    && task.rootScopeKey === request.rootScopeKey && same(task.runtimeBinding, request.runtimeBinding)
    && task.responseContract === request.responseContract
    && JSON.stringify(task.candidateSource) === JSON.stringify(request.candidateSource)
    && same(task.budget, request.budget) && task.objective === request.objective
    && same(task.conversation.messages[0], request.conversation.messages[0]);
}

/** One fresh campaign = one explicitly selected runtime, all planned cases, one original task per case.
 * A lost create acknowledgement is reconciled read-only and never implicitly authorized to start.
 * A lost start acknowledgement is observed on the original ID; no second mutation is sent.
 */
export async function collectBenchmark({ datasetDirectory, caseIds, campaignId, ownerId, recordDirectory, metadata, runtimeBinding,
  runtime, budget, outputDirectory, baseUrl, headers, requestTimeoutMs = 30_000, pollMs = 500,
  observationMs = budget?.maxActiveMs + 60_000, transport, onProgress = () => {} }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(campaignId) || !ownerId || !Array.isArray(caseIds) || !caseIds.length
    || new Set(caseIds).size !== caseIds.length || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 2000
    || !Number.isInteger(observationMs) || observationMs < 1) throw new CollectionError("invalid_campaign");
  budget = CareerTaskBudgetSchema.parse(budget); runtimeBinding = CareerRuntimeBindingSchema.parse(runtimeBinding);
  metadata = metadataSchema.parse(metadata);
  if (metadata.runtimeId !== runtimeBinding.id || !["model", "scripted_fixture"].includes(metadata.execution)) throw new CollectionError("metadata_runtime_changed");
  const call = taskHttp({ baseUrl, headers, requestTimeoutMs, transport });
  const plans = [];
  // Validate every source and request before writing the campaign or starting a task.
  for (const caseId of caseIds) {
    const bundle = await loadGoldCase(datasetDirectory, caseId);
    const identity = digest(JSON.stringify([campaignId, ownerId, metadata, caseId]));
    const request = await prepareBenchmarkRequest(bundle.test, bundle.groups, bundle.mapping, {
      workspaceKey: `benchmark-${identity}`, rootScopeKey: `benchmark-${identity}`, runtimeBinding, budget,
      idempotencyKey: `benchmark-${identity}` });
    plans.push({ caseId, bundle, request });
  }
  // Never use a new output folder to silently restart an existing campaign task.
  const existing = (await call()).tasks.map(t => AgentTaskSchema.parse(t));
  if (existing.some(t => plans.some(p => t.workspaceKey === p.request.workspaceKey))) throw new CollectionError("campaign_task_already_exists_observe_original");
  await fs.mkdir(outputDirectory, { mode: 0o700 }); outputDirectory = await fs.realpath(outputDirectory);
  const intent = { schemaVersion: 1, protocolVersion: COLLECTION_PROTOCOL, campaignId, ownerId, metadata, runtimeBinding, budget,
    caseIds, requests: plans.map(({ caseId, request }) => ({ caseId, request })),
    limits: ["One initial create/start per case; unknown acknowledgement never triggers another mutation.",
      "A frozen candidate is review-only. Failures and unknown outcomes remain in the planned-case denominator.",
      "Runtime credentials are supplied in memory only; revision is declared metadata, not provider attestation."] };
  await write(path.join(outputDirectory, "campaign.json"), intent);
  const journal = async event => {
    await fs.appendFile(path.join(outputDirectory, "events.ndjson"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
    await onProgress(event);
  };
  const results = [];
  for (const { caseId, bundle, request } of plans) {
    const directory = path.join(outputDirectory, caseId); await fs.mkdir(directory, { mode: 0o700 });
    const emit = event => journal({ caseId, ...event });
    let task, reason, unresolved;
    await write(path.join(directory, "request.json"), request);
    await emit({ stage: "create_intent", requestSha256: digest(JSON.stringify(request)) });
    try {
      task = AgentTaskSchema.parse((await call("", request)).task);
      if (!matches(task, request, ownerId) || task.status !== "ready" || task.usage.modelCalls !== 0) throw new CollectionError("created_task_changed");
      await emit({ stage: "created", taskId: task.id });
    } catch (error) {
      reason = { stage: "dispatch", code: code(error, "create_receipt_unknown") };
      task = undefined;
      // Find the original task by exact owner/workspace/material, not by the latest task or guessed ID.
      try {
        const found = (await call()).tasks.map(t => AgentTaskSchema.parse(t)).filter(t => matches(t, request, ownerId));
        if (found.length === 1) task = found[0];
      } catch { /* The journal retains the unresolved creation; no second POST. */ }
      if (!task) unresolved = "create_unresolved";
      await emit({ stage: "create_reconciled", taskId: task?.id ?? null, reason });
    }
    if (task && !reason) {
      // Persist original ID before any operation that can cause inference.
      await write(path.join(directory, "created.task.json"), task);
      await emit({ stage: "start_intent", taskId: task.id, expectedRevision: task.revision });
      try {
        const started = AgentTaskSchema.parse((await call(`/${task.id}/start`, { expectedRevision: task.revision,
          sourceFingerprint: task.sourceFingerprint, runtimeBinding, runtime, consent: true })).task);
        if (started.id !== task.id || !matches(started, request, ownerId)) throw new CollectionError("started_task_changed");
        task = started;
      } catch (error) {
        reason = { stage: "dispatch", code: code(error, "start_receipt_unknown") };
        await emit({ stage: "start_receipt_unknown", taskId: task.id, reason });
      }
      const deadline = Date.now() + observationMs;
      for (;;) {
        try {
          const observed = AgentTaskSchema.parse((await call(`/${task.id}`)).task);
          if (observed.id !== task.id || !matches(observed, request, ownerId)) throw new CollectionError("observed_task_changed");
          task = observed;
          if (task.status !== "running" && task.status !== "ready") { reason = undefined; break; }
        } catch (error) {
          await emit({ stage: "observation_error", taskId: task.id, code: code(error, "observation_failed") });
        }
        if (Date.now() >= deadline) { unresolved = "observation_deadline_original_task_retained"; break; }
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
    }
    let result = { caseId, taskId: task?.id ?? null, outcome: "unresolved", reason: unresolved ?? reason?.code ?? "task_unresolved",
      observed: null };
    if (task && task.status !== "running" && !unresolved) {
      const options = { sourceBundle: bundle, caseId, recordDirectory, taskId: task.id, ownerId, metadata };
      try {
        if (reason || task.status !== "awaiting_answer") throw new CollectionError(reason?.code ?? (task.error && /^[a-z][a-z0-9_]{1,100}$/.test(task.error) ? task.error : "task_not_complete"));
        const frozen = await freezeTaskCandidate({ ...options, outputDirectory: path.join(directory, "frozen") });
        result = { caseId, taskId: task.id, outcome: "frozen", stem: frozen.stem, observed: frozen.run.observed };
      } catch (error) {
        reason ??= { stage: task.status === "awaiting_answer" ? "candidate" : "execution", code: code(error, "invalid_candidate") };
        try {
          const archived = await archiveTaskFailure({ ...options, outputDirectory: path.join(directory, "failure"), reason });
          result = { caseId, taskId: task.id, outcome: "failure", stem: archived.stem, reason, observed: archived.failure.observed };
        } catch (archiveError) {
          result.reason = code(archiveError, "failure_archive_unavailable");
        }
      }
    }
    await write(path.join(directory, "result.json"), result); results.push(result);
    await emit({ stage: "case_result", ...result });
  }
  const summary = { schemaVersion: 1, protocolVersion: COLLECTION_PROTOCOL, campaignId, metadata, planned: caseIds.length,
    frozen: results.filter(r => r.outcome === "frozen").length, failed: results.filter(r => r.outcome === "failure").length,
    unresolved: results.filter(r => r.outcome === "unresolved").length,
    observedModelCalls: results.every(r => r.observed !== null) ? results.reduce((sum, r) => sum + r.observed.modelCalls, 0) : null,
    comparable: false, results };
  await write(path.join(outputDirectory, "summary.json"), summary);
  return summary;
}
