import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createAgentServer } from "../../apps/agent-host/src/server.ts";
import { careerRuntimeBinding } from "../../packages/agent-contracts/src/career-task.ts";
import { collectBenchmark } from "./collect.mjs";
import { contextCheck, goldContextRequests, localCatalog } from "./ollama-context.mjs";

const { MemorySaver } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/langgraph");

/** Explicit local-only acceptance harness using the unmodified production Host resolver. */
export async function runIsolatedOllama({ datasetDirectory, model, outputDirectory, onProgress = () => {} }) {
  if (typeof model !== "string" || !model.length || model.length > 100) throw Error("explicit_local_model_required");
  const catalog = await localCatalog(model);
  const runtime = { kind: "model", modelSettings: { provider: "ollama", model, baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama-key", temperature: 0 } };
  const runtimeBinding = careerRuntimeBinding(runtime), budget = { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 300_000 };
  const requests = await goldContextRequests(datasetDirectory, runtimeBinding, budget);
  const capacity = contextCheck({ requests, ...catalog });
  if (!capacity.passed) throw Error("ollama_context_capacity_unverified_no_inference");
  const caseIds = requests.map(r => r.caseId); if (caseIds.length < 5) throw Error("five_gold_cases_required");
  await fs.mkdir(outputDirectory, { mode: 0o700 }); outputDirectory = await fs.realpath(outputDirectory);
  await fs.writeFile(path.join(outputDirectory, "local-model.json"), JSON.stringify({ model, ...catalog, capacity,
    limitation: "Read-only local catalog digest, not a cryptographic attestation of every inference." }, null, 2), { flag: "wx", mode: 0o600 });
  const token = randomBytes(32).toString("hex"), username = `benchmark-${randomBytes(6).toString("hex")}`;
  const identityDirectory = path.join(outputDirectory, "accounts");
  // No injected reasoner, native bypass, copied account credentials or pre-existing user stores.
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory, runsDirectory: path.join(outputDirectory, "runs"), understandingDirectory: path.join(outputDirectory, "understanding"),
    checkpointer: new MemorySaver() });
  try {
    await once(server, "listening"); const address = server.address();
    if (!address || typeof address === "string") throw Error("isolated_host_not_listening");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/v1/agent/identity/register`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: randomBytes(32).toString("hex"), displayName: "Isolated public Gold benchmark" }) });
    if (!response.ok) throw Error("isolated_identity_registration_failed");
    const { principal } = await response.json(), cookie = response.headers.getSetCookie()[0]?.split(";")[0];
    if (!principal?.id || !cookie) throw Error("isolated_identity_session_missing");
    const summary = await collectBenchmark({ datasetDirectory, caseIds, campaignId: `local-${randomBytes(8).toString("hex")}`,
      ownerId: principal.id, recordDirectory: path.join(identityDirectory, "owners", principal.id, "career-tasks-v1"),
      metadata: { execution: "model", provider: "ollama", id: model, revision: catalog.entry.digest, runtimeId: runtimeBinding.id },
      runtimeBinding, runtime, budget,
      outputDirectory: path.join(outputDirectory, "campaign"), baseUrl,
      headers: { Authorization: `Bearer ${token}`, Cookie: cookie, "X-BetterMe-Owner": principal.id }, onProgress: async event => {
        if (event.stage === "start_intent" || event.stage === "case_result") {
          const current = await localCatalog(model), checked = contextCheck({ requests, ...current });
          const loaded = current.running.models?.filter(m => m.name === current.entry.name || m.model === current.entry.model);
          await fs.writeFile(path.join(outputDirectory, `${event.caseId}-${event.stage}.context.json`), JSON.stringify({ ...current, checked }, null, 2), { flag: "wx", mode: 0o600 });
          if (current.entry.digest !== catalog.entry.digest || !checked.passed || event.stage === "case_result" && loaded?.length !== 1) throw Error("ollama_context_changed_campaign_not_validated");
        }
        await onProgress(event);
      } });
    return { ...summary, outputDirectory };
  } finally {
    // Only this fresh server is owned by the harness. Closing it never restarts/replays requests.
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), flags = ["--dataset", "--model", "--out"];
  if (args.length !== 6 || flags.some((flag, i) => args[i * 2] !== flag)) throw Error("Usage: node --import tsx collect-ollama.mjs --dataset DIR --model EXACT_INSTALLED_LOCAL_MODEL --out NEW_DIR");
  const summary = await runIsolatedOllama({ datasetDirectory: path.resolve(args[1]), model: args[3], outputDirectory: path.resolve(args[5]),
    onProgress: event => { if (!["observation_error"].includes(event.stage)) console.log(JSON.stringify(event)); } });
  console.log(JSON.stringify(summary));
}
