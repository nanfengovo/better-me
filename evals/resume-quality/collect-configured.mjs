import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createAgentServer } from "../../apps/agent-host/src/server.ts";
import { ModelSettingsSchema } from "../../apps/agent-host/src/model.ts";
import { careerRuntimeBinding } from "../../packages/agent-contracts/src/career-task.ts";
import { collectBenchmark } from "./collect.mjs";

const { MemorySaver } = createRequire(new URL("../../apps/agent-host/package.json", import.meta.url))("@langchain/langgraph");
const caseIds = ["gold-backend", "gold-data-engineer", "gold-frontend", "gold-fullstack", "gold-sre"];

/** Existing provider configuration in memory; normal Host + authenticated tasks,
 * no second SDK, personal identity/session, source store, environment-key lookup,
 * provider probe, automatic retry or fallback. Each of five roots has one call.
 * allowLoopbackFixture is a trusted test-only seam, never HTTP-configurable.
 */
export async function runIsolatedConfigured({ datasetDirectory, modelSettings, outputDirectory, declaredRevision,
  allowLoopbackFixture = false, onProgress = () => {} }) {
  let settings;
  try { settings = ModelSettingsSchema.parse(modelSettings); } catch { throw Error("configured_model_invalid"); }
  if (!settings.baseUrl || !settings.apiKey?.trim() || typeof declaredRevision !== "string" || !declaredRevision.length || declaredRevision.length > 200) throw Error("explicit_configured_model_required");
  const endpoint = new URL(settings.baseUrl), fixture = allowLoopbackFixture === true
    && endpoint.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (!fixture && (endpoint.protocol !== "https:"
    || ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) throw Error("explicit_cloud_endpoint_required");
  const runtime = { kind: "model", modelSettings: settings }, runtimeBinding = careerRuntimeBinding(runtime);
  if (!fixture && runtimeBinding.location !== "cloud") throw Error("explicit_cloud_runtime_required");
  await fs.mkdir(outputDirectory, { mode: 0o700 }); outputDirectory = await fs.realpath(outputDirectory);
  const { apiKey: _credential, ...declaration } = settings;
  await fs.writeFile(path.join(outputDirectory, "configured-model.json"), JSON.stringify({ ...declaration,
    declaredRevision, execution: fixture ? "scripted_fixture" : "model",
    limitation: "Selected configured endpoint/model and declared revision, not an attestation of cloud weights or monetary billing." }, null, 2), { flag: "wx", mode: 0o600 });
  const token = randomBytes(32).toString("hex"), identityDirectory = path.join(outputDirectory, "accounts");
  const server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
    identityDirectory, runsDirectory: path.join(outputDirectory, "runs"), understandingDirectory: path.join(outputDirectory, "understanding"),
    checkpointer: new MemorySaver() });
  try {
    await once(server, "listening"); const address = server.address();
    if (!address || typeof address === "string") throw Error("isolated_host_not_listening");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/v1/agent/identity/register`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: `configured-gold-${randomBytes(6).toString("hex")}`, password: randomBytes(32).toString("hex"), displayName: "Isolated configured public Gold benchmark" }) });
    if (!response.ok) throw Error("isolated_identity_registration_failed");
    const { principal } = await response.json(), cookie = response.headers.getSetCookie()[0]?.split(";")[0];
    if (!principal?.id || !cookie) throw Error("isolated_identity_session_missing");
    const summary = await collectBenchmark({ datasetDirectory, caseIds, campaignId: `configured-${randomBytes(8).toString("hex")}`,
      ownerId: principal.id, recordDirectory: path.join(identityDirectory, "owners", principal.id, "career-tasks-v1"),
      metadata: { execution: fixture ? "scripted_fixture" : "model", provider: endpoint.hostname === "api.deepseek.com" ? "deepseek" : settings.provider ?? "custom",
        id: settings.model, revision: declaredRevision, runtimeId: runtimeBinding.id },
      runtimeBinding, runtime, budget: { maxModelCalls: 1, maxToolCalls: 1, maxActiveMs: 300_000 },
      outputDirectory: path.join(outputDirectory, "campaign"), baseUrl,
      headers: { Authorization: `Bearer ${token}`, Cookie: cookie, "X-BetterMe-Owner": principal.id }, onProgress });
    return { ...summary, outputDirectory };
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
