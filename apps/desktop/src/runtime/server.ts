import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { startLocalJobService } from "../../../job-service/src/lifecycle.js";
import { createAgentServer } from "../../../agent-host/src/server.js";
import { createCheckpointer } from "../../../agent-host/src/checkpointer.js";
import { loadIdentityDeployment } from "../../../agent-host/src/identity/deployment.js";
import { createRuntimeGateway } from "../../../web/server/runtime-gateway.js";
import { acquireRuntimeVolume } from "../../../web/server/runtime-volume.js";

if (!process.send || !process.env.BETTERME_DESKTOP_DATA) throw new Error("Desktop runtime requires its owning application and a private data directory.");
const data = resolve(process.env.BETTERME_DESKTOP_DATA);
const smoke = process.env.BETTERME_DESKTOP_SMOKE === "1";
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}
// The production origin must remain stable across restarts: browser storage is
// origin-bound. Never adopt another listener or silently move a user's storage.
const [port, agentPort, jobPort] = smoke ? await Promise.all([freePort(), freePort(), freePort()]) : [32741, 32742, 32743];
const origin = `http://127.0.0.1:${port}`;
const volume = await acquireRuntimeVolume(data);
await mkdir(resolve(data, "agent"), { recursive: true, mode: 0o700 });
const tokenFile = resolve(data, "agent.token");
try { await writeFile(tokenFile, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const agentToken = (await readFile(tokenFile, "utf8")).trim();
if (!/^[A-Za-z0-9_-]{43,128}$/.test(agentToken)) throw new Error("Invalid desktop token; data preserved.");
const identity = await loadIdentityDeployment({ defaultConfigPath: resolve(data, "agent", "oidc.json") });
const job = await startLocalJobService({ dataDirectory: resolve(data, "jobs"), host: "127.0.0.1", port: jobPort!, allowedOrigins: [origin] });
const jobToken = (await readFile(job.tokenPath, "utf8")).trim();
const agentEndpoint = `http://127.0.0.1:${agentPort}`;
const checkpointer = createCheckpointer(resolve(data, "agent", "checkpoints.sqlite"));
// A portable release must not silently lose checkpoints if a native dependency
// was omitted or built for the wrong Electron ABI.
if (!checkpointer.db) throw new Error("Persistent checkpoint storage is unavailable; data preserved.");
checkpointer.db.prepare("SELECT 1").get();
const agent = createAgentServer({ host: "127.0.0.1", port: agentPort!, allowedOrigins: [origin], authToken: agentToken,
  checkpointer, runsDirectory: resolve(data, "agent", "runs"), runtimeDefinitions: [], sandboxMode: "disabled", oidc: identity.oidc,
});
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
const gateway = createRuntimeGateway({ mode: "desktop", root: resolve("web"), origins: [origin], jobEndpoint: job.url, agentEndpoint, jobToken, agentToken, health: healthy });
gateway.listen(port, "127.0.0.1"); await once(gateway, "listening");
async function close(code = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15_000); deadline.unref();
  gateway.close(); agent.close();
  await job.close().catch(() => { code = 1; });
  checkpointer.db.close();
  volume.close();
  process.exit(code);
}
process.on("message", message => { if ((message as { type?: string })?.type === "shutdown") void close(); });
process.once("disconnect", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
if (!await healthy()) throw new Error("Bundled services failed their startup health checks.");
process.send({ type: "betterme:ready", origin, agentEndpoint, agentToken, port: agentPort, runtimePid: process.pid, node: process.versions.node });
