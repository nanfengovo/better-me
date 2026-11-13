import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { contextCheck, goldContextRequests } from "./ollama-context.mjs";
import { freeChatPrompt } from "../../apps/agent-host/src/kernel/free-chat.js";
import { careerTaskProtocol } from "../../apps/agent-host/src/kernel/model-protocol.js";
import { resumeCandidateSource } from "../../packages/agent-contracts/src/agent-task.js";
const { toJsonSchema } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/core/utils/json_schema");

const dataset = fileURLToPath(new URL("./gold/v1/", import.meta.url));
const binding = { id: "local-context-test", label: "Offline capacity test", location: "local" };
const budget = { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 300_000 };
const entry = { name: "local-capacity-fixture", model: "local-capacity-fixture", digest: "a".repeat(64) };
test("whole Gold prompts exceed a loaded 4096 window; explicit 65536 passes without changing any source bytes", async () => {
  const requests = await goldContextRequests(dataset, binding, budget), before = JSON.stringify(requests);
  const small = contextCheck({ requests, entry, show: { model_info: { "gemma4.context_length": 131072 } },
    running: { models: [{ ...entry, context_length: 4096 }] } });
  assert.equal(small.passed, false); assert.equal(small.effectiveContext, 4096); assert.ok(small.required > 40_000);
  const large = contextCheck({ requests, entry, show: { parameters: "num_ctx 65536\ntemperature 1", model_info: { "gemma4.context_length": 131072 } }, running: { models: [] } });
  assert.equal(large.passed, true); assert.equal(large.cases.length, 5); assert.ok(large.cases.every(c => c.fullPromptBytes > 10_000));
  assert.equal(JSON.stringify(requests), before);
});
test("source-bound capacity includes the exact full dynamic schema, not only its instruction and source text", async () => {
  const requests = await goldContextRequests(dataset, binding, budget), request = requests[0].request;
  const result = contextCheck({ requests, entry, show: { parameters: "num_ctx 65536", model_info: { "gemma4.context_length": 131072 } }, running: { models: [] } });
  assert.equal(request.responseContract, "resume_candidate_v5");
  const prompt = freeChatPrompt({ ...request, turn: 1, usage: { modelCalls: 1, toolCalls: 0, activeMs: 0 },
    rootLedger: { rootTaskId: "ct_" + "f".repeat(32), budget, usage: { modelCalls: 1, toolCalls: 0, activeMs: 99999999 }, memberCount: 1 } }, []);
  const protocol = careerTaskProtocol("resume_candidate_bound", resumeCandidateSource(request));
  const expected = Buffer.byteLength(prompt + protocol.instructions + JSON.stringify(toJsonSchema(protocol.schema)));
  assert.equal(result.cases[0].fullPromptBytes, expected);
  assert.ok(expected > Buffer.byteLength(prompt + protocol.instructions));
});
test("training maximum is not effective context; loaded lower capacity, excessive configuration and repair loops fail closed", async () => {
  const requests = await goldContextRequests(dataset, binding, budget), show = { parameters: "num_ctx 65536", model_info: { "gemma4.context_length": 131072 } };
  assert.equal(contextCheck({ requests, entry, show: { model_info: show.model_info }, running: { models: [] } }).passed, false);
  assert.equal(contextCheck({ requests, entry, show, running: { models: [{ ...entry, context_length: 4096 }] } }).passed, false);
  assert.equal(contextCheck({ requests, entry, show: { ...show, model_info: { "gemma4.context_length": 32768 } }, running: { models: [] } }).passed, false);
  assert.equal(contextCheck({ requests, entry: { ...entry, remote_host: "https://ollama.com" }, show, running: { models: [] } }).passed, false);
  assert.equal(contextCheck({ requests, entry, show: { ...show, remote_model: "cloud-alias" }, running: { models: [] } }).passed, false);
  const repairs = structuredClone(requests); repairs[0].request.budget.maxModelCalls = 3;
  assert.throws(() => contextCheck({ requests: repairs, entry, show, running: { models: [] } }), /one_call_sampling/);
});
