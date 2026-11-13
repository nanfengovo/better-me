import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { resumeCandidateSource } from "../../packages/agent-contracts/src/agent-task.ts";
import { freeChatPrompt } from "../../apps/agent-host/src/kernel/free-chat.ts";
import { careerTaskProtocol } from "../../apps/agent-host/src/kernel/model-protocol.ts";
import { loadGoldCase, prepareBenchmarkRequest } from "./freeze.mjs";
const { toJsonSchema } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/core/utils/json_schema");

export async function localCatalog(model) {
  const get = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:11434/api/${route}`, { method: body ? "POST" : "GET", redirect: "error",
      signal: AbortSignal.timeout(10_000), ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error("ollama_catalog_unavailable"); return response.json();
  };
  const tags = await get("tags"), matches = tags.models?.filter(m => m.name === model || m.model === model);
  if (matches?.length !== 1 || matches[0].remote_host || matches[0].remote_model || !/^[a-f0-9]{64}$/.test(matches[0].digest)) throw Error("installed_local_model_required_cloud_alias_rejected");
  const show = await get("show", { model }), running = await get("ps");
  if (show.remote_host || show.remote_model) throw Error("installed_local_model_required_cloud_alias_rejected");
  return { entry: matches[0], show, running };
}

/** Conservative capacity guard, not an exact tokenizer or proof of semantic attention.
 * UTF-8 byte bound + explicit protocol/template/output reserve; no source shortening.
 * One-call sampling avoids a repair appending another full output beyond this initial bound.
 */
export function contextCheck({ requests, show, entry, running }) {
  const explicit = /^num_ctx\s+(\d+)\s*$/m.exec(show.parameters ?? "");
  const loaded = running.models?.filter(m => (m.name === entry.name || m.model === entry.model) && m.digest === entry.digest);
  const configured = explicit ? Number(explicit[1]) : undefined;
  const effective = configured ?? (loaded?.length === 1 ? loaded[0].context_length : undefined);
  const nativeMaximum = Object.entries(show.model_info ?? {}).filter(([key]) => key.endsWith(".context_length")).map(([, value]) => value);
  const extra = Buffer.byteLength((show.system ?? "") + (show.template ?? ""), "utf8") + 8192;
  const cases = requests.map(({ caseId, request }) => {
    if (request.budget.maxModelCalls !== 1) throw Error("context_guard_requires_one_call_sampling");
    const prompt = freeChatPrompt({ ...request, turn: 1, usage: { modelCalls: 1, toolCalls: 0, activeMs: 0 },
      rootLedger: { rootTaskId: "ct_" + "f".repeat(32), budget: request.budget, usage: { modelCalls: 1, toolCalls: 0, activeMs: 99999999 }, memberCount: 1 } }, []);
    const bound = ["resume_candidate_v2", "resume_candidate_v3", "resume_candidate_v4", "resume_candidate_v5"].includes(request.responseContract);
    const phase = bound ? "resume_candidate_bound" : request.responseContract === "resume_candidate_v1" ? "resume_candidate" : "free_chat";
    const protocol = careerTaskProtocol(phase, resumeCandidateSource(request));
    // Historical protocols keep their exact capacity receipts. The new v4
    // contract explicitly budgets the complete dynamic grammar as well.
    const schema = bound ? JSON.stringify(toJsonSchema(protocol.schema)) : "";
    const fullPromptBytes = Buffer.byteLength(prompt + protocol.instructions + schema, "utf8");
    return { caseId, fullPromptBytes, conservativeRequiredContext: fullPromptBytes + extra };
  });
  const required = Math.max(...cases.map(c => c.conservativeRequiredContext));
  const passed = !entry.remote_host && !entry.remote_model && !show.remote_host && !show.remote_model && /^[a-f0-9]{64}$/.test(entry.digest)
    && Number.isSafeInteger(effective) && effective >= required && nativeMaximum.length > 0 && nativeMaximum.every(n => Number.isSafeInteger(n) && n >= effective)
    && (!loaded?.length || loaded.every(m => m.context_length >= required));
  return { passed, effectiveContext: effective ?? null, explicitContext: configured ?? null, required, cases,
    method: "UTF-8 byte upper-bound guard plus full template/system and 8192 reserve, not an exact tokenizer or provider attestation" };
}

export async function goldContextRequests(datasetDirectory, runtimeBinding, budget) {
  const caseIds = (await fs.readdir(path.join(datasetDirectory, "cases"))).filter(n => n.endsWith(".case.json")).map(n => n.slice(0, -".case.json".length)).sort();
  const requests = [];
  for (const caseId of caseIds) {
    const { test, groups, mapping } = await loadGoldCase(datasetDirectory, caseId);
    const request = await prepareBenchmarkRequest(test, groups, mapping, { workspaceKey: `benchmark-context-${caseId}`, rootScopeKey: `benchmark-context-${caseId}`,
      runtimeBinding, budget, idempotencyKey: `benchmark-context-${caseId}` });
    requests.push({ caseId, request });
  }
  return requests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [datasetDirectory, model] = process.argv.slice(2);
  if (!datasetDirectory || !model || process.argv.length !== 4) throw Error("Usage: node --import tsx ollama-context.mjs DATASET EXACT_LOCAL_MODEL");
  const catalog = await localCatalog(model);
  const requests = await goldContextRequests(datasetDirectory, { id: "context-capacity-probe", label: "Read-only capacity probe", location: "local" }, { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 300_000 });
  const result = contextCheck({ requests, ...catalog }); console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
