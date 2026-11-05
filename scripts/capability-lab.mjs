/** One-command synthetic-only live acceptance. Never adopts/kills existing services. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const adoption = process.argv.includes("--adoption"), handoff = adoption || process.argv.includes("--handoff"), m2 = handoff || process.argv.includes("--m2");
const webPort = adoption ? 5396 : handoff ? 5395 : m2 ? 5394 : 5393, hostPort = adoption ? 5402 : handoff ? 5401 : m2 ? 5400 : 5399;
for (const port of [webPort, hostPort]) {
  await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once("error", () => reject(new Error(`Port ${port} already in use; existing service was NOT stopped.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const vite = path.join(path.dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");
const children = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
};
const start = (args, cwd, env = process.env) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" }); children.push(child);
  child.once("error", () => stop(1));
  child.once("exit", code => stop(code ?? 0));
  return child;
};
process.once("SIGINT", () => stop()); process.once("SIGTERM", () => stop());
start(["--import", "tsx", "apps/agent-host/scripts/verify-capability-live.ts", "--serve", ...(adoption ? ["--adoption"] : handoff ? ["--handoff"] : m2 ? ["--m2"] : [])], root);
// Start the page only after the synthetic Host is ready, not on a proxy-error login screen.
let ready = false;
for (let i = 0; i < 50 && !stopping; i++) {
  try { const response = await fetch(`http://127.0.0.1:${hostPort}/api/v1/agent/identity/session`, {
    headers: { Authorization: "Bearer better-me-agent-token" }, signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch { /* bounded startup wait */ }
  await new Promise(resolve => setTimeout(resolve, 300));
}
if (!ready) stop(1);
else if (!stopping) {
  start([vite, "--config", "tests/ui-lab/capability.config.ts"], path.join(root, "apps/web"), { ...process.env, CAPABILITY_LAB_M2: m2 ? "1" : "0", CAPABILITY_LAB_HANDOFF: handoff ? "1" : "0", CAPABILITY_LAB_ADOPTION: adoption ? "1" : "0" });
  console.log(`Synthetic Career Workspace: http://${adoption ? "capability-adoption.localhost" : handoff ? "capability-review.localhost" : m2 ? "capability-m2.localhost" : "capability-regression.localhost"}:${webPort}/tests/ui-lab/capability.html`);
}
