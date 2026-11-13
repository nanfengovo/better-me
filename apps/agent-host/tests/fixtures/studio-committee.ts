import assert from "node:assert/strict";
import { careerRuntimeBinding, studioAnalysisRuntime, studioCommitteeOperation, type StudioCommitteeTask } from "@better-me/agent-contracts";
import { StudioCommitteeRequestSchema, type StudioAccess } from "../../src/career-studio/contracts.js";
import { CareerStudio } from "../../src/career-studio/service.js";
import { StudioError, studioHash } from "../../src/career-studio/storage.js";
import { AgentTaskKernel, CareerTaskError } from "../../src/kernel/service.js";
import type { EvidenceBroker } from "../../src/understanding/evidence-broker.js";
import type { LocalCompletionRequest } from "../../src/privacy/local-ollama.js";
import type { CommitteeTasks } from "../../src/career-studio/committee-tasks.js";

/** Test-only composition: real kernel/context/Broker/ledger, scripted model at
 * the reasoner seam. It never invokes CareerStudio's retired execution loop. */
export function createStudioCommitteeHarness(options: { ownerId: string; directory: string; broker: EvidenceBroker;
  studio(): CareerStudio; complete(request: LocalCompletionRequest): Promise<string> }) {
  const kernel = new AgentTaskKernel({ ownerId: options.ownerId, directory: options.directory, broker: options.broker,
    validateStudioCommittee: async (task, access) => {
      try { return await options.studio().validateAnalysis(task, access); }
      catch (error) { if (error instanceof StudioError) throw new CareerTaskError(error.code, error.status); throw error; }
    } });
  const tasks: CommitteeTasks = {
    get: async (id, access) => { await options.studio().assertAccess(access); const task = await kernel.readTask(id); assert.equal(task.kind, "studio_committee"); return task as StudioCommitteeTask; },
    list: async (contextId, access) => { await options.studio().assertAccess(access); return (await kernel.listTasks()).filter((task): task is StudioCommitteeTask => task.kind === "studio_committee" && task.request.contextId === contextId); },
    describe: (id, access) => kernel.describeStudioCommittee(id, access),
    review: (id, access) => kernel.reviewStudioCommittee(id, access),
  };
  const creationBudgets = new Map<string, { maxModelCalls: number; maxToolCalls: number; maxActiveMs: number } | undefined>();
  async function start(raw: unknown, access: StudioAccess) {
    const request = StudioCommitteeRequestSchema.parse(raw), context = await options.studio().getContext(request.contextId, access);
    const runtime = studioAnalysisRuntime(request.runtime.model);
    const idempotencyKey = studioHash({ context: context.id, key: request.idempotencyKey });
    if (!creationBudgets.has(idempotencyKey)) creationBudgets.set(idempotencyKey,
      !(await kernel.listTasks()).some(row => row.rootScopeKey === context.workspaceKey) ? { maxModelCalls: 100, maxToolCalls: 500, maxActiveMs: 120000 } : undefined);
    const budget = creationBudgets.get(idempotencyKey);
    let task = await kernel.createTask({ kind: "studio_committee", workspaceKey: `studio-committee:${context.workspaceKey}`, rootScopeKey: context.workspaceKey,
      objective: "合成委员会证据审查", request, runtimeBinding: careerRuntimeBinding(runtime), consent: true,
      idempotencyKey, ...(budget ? { budget } : {}) }, access) as StudioCommitteeTask;
    if (task.status === "ready") task = await kernel.run(task.id, "start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint,
      runtimeBinding: task.runtimeBinding, consent: true }, { runtimeFingerprint: `synthetic-studio:${options.ownerId}:${request.runtime.modelDigest}`,
      reasoner: async (prompt, signal, phase, _images, _source, jsonSchema) => {
        assert.equal(phase, "studio_committee");
        return options.complete({ prompt, signal, jsonSchema, budget: { maxInputBytes: 2_000_000, maxOutputBytes: 256_000, maxActiveMs: 120000 } });
      } }, access) as StudioCommitteeTask;
    return studioCommitteeOperation(task);
  }
  async function pause(id: string, access: StudioAccess) { const task = await kernel.readTask(id); return kernel.stop(id, task.revision, false, access); }
  return { kernel, tasks, start, pause, close: () => kernel.close() };
}

export function committeeSchema(request: LocalCompletionRequest) {
  const schema = request.jsonSchema as { anyOf?: Array<{ properties: { kind: { const: string } } }>; properties: { kind: { const: string } } };
  return schema.anyOf?.[0] ?? schema;
}
