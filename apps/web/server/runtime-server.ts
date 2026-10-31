import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { startLocalJobService } from "../../job-service/src/lifecycle.js";
import { createAgentServer } from "../../agent-host/src/server.js";
import { createCheckpointer } from "../../agent-host/src/checkpointer.js";
import { createRuntimeGateway } from "./runtime-gateway.js";
import { acquireRuntimeVolume } from "./runtime-volume.js";

const port = Number(process.env.BETTER_ME_INTERNAL_PORT ?? 8080);
const publicPort = Number(process.env.BETTER_ME_PORT ?? 8080);
const jobPort = Number(process.env.BETTER_ME_JOB_PORT ?? 5178);
const agentPort = Number(process.env.BETTER_ME_AGENT_PORT ?? 5179);
if (![port, publicPort, jobPort, agentPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) throw new Error("Runtime ports must be 1-65535.");
const origins = ["http://127.0.0.1:" + publicPort, "http://localhost:" + publicPort];
const data = resolve(process.env.BETTER_ME_DATA_DIR ?? "/data");
const volume = await acquireRuntimeVolume(data);
const agentTokenFile = resolve(data, "agent.token");
try { await writeFile(agentTokenFile, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const agentToken = (await readFile(agentTokenFile, "utf8")).trim();
if (!/^[A-Za-z0-9_-]{43,128}$/.test(agentToken)) throw new Error("Invalid agent.token; existing data preserved.");
const lockDirectory = await mkdtemp(resolve(tmpdir(), "better-me-runtime-lock-"));
const job = await startLocalJobService({ dataDirectory: resolve(data, "jobs"), port: jobPort, host: "127.0.0.1", allowedOrigins: origins }, { lockDirectory });
const jobToken = (await readFile(job.tokenPath, "utf8")).trim();
const checkpointer = createCheckpointer(resolve(data, "agent", "checkpoints.sqlite"));
const agentEndpoint = "http://127.0.0.1:" + agentPort;
const agent = createAgentServer({ host: "127.0.0.1", port: agentPort, allowedOrigins: origins, authToken: agentToken, checkpointer, runsDirectory: resolve(data, "agent", "runs"), runtimeDefinitions: [], sandboxMode: "disabled" });
if (!agent.listening) await once(agent, "listening");
let stopping = false;
async function healthy() {
  try {
    const responses = await Promise.all([
      fetch(job.url + "/healthz", { headers: { Authorization: "Bearer " + jobToken }, signal: AbortSignal.timeout(2000) }),
      fetch(agentEndpoint + "/api/v1/agent/health", { headers: { Authorization: "Bearer " + agentToken }, signal: AbortSignal.timeout(2000) }),
    ]);
    for (const response of responses) await response.body?.cancel();
    return !stopping && responses.every(response => response.ok);
  } catch { return false; }
}
const gateway = createRuntimeGateway({ root: resolve("apps/web/dist"), origins, jobEndpoint: job.url, agentEndpoint, jobToken, agentToken, health: healthy, ollamaEndpoint: process.env.BETTER_ME_OLLAMA_ENDPOINT ?? "http://host.docker.internal:11434" });
await new Promise<void>((accept, reject) => { gateway.once("error", reject); gateway.listen(port, "0.0.0.0", accept); });
let failures = 0, checking = false;
const watch = setInterval(() => {
  if (checking || stopping) return;
  checking = true;
  void healthy().then(ok => { failures = ok ? 0 : failures + 1; if (failures >= 3) { console.error("[runtime] dependent service unavailable; restarting container"); void close(1); } }).finally(() => { checking = false; });
}, 10_000);
async function close(code: number) {
  if (stopping) return;
  stopping = true; clearInterval(watch);
  // Let SQLite writes drain. A bounded final exit also handles a hung compute lane.
  const deadline = setTimeout(() => process.exit(code || 1), 25_000); deadline.unref();
  gateway.close(); agent.close();
  await job.close().catch(() => { code = 1; });
  volume.close();
  process.exit(code);
}
process.once("SIGTERM", () => { void close(0); });
process.once("SIGINT", () => { void close(0); });
console.log("[runtime] BetterMe ready: web + Agent Host + job index; data in " + data);
