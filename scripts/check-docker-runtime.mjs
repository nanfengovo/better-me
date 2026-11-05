import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = `betterme-smoke-${randomUUID().slice(0, 8)}`;
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, BETTER_ME_PORT: String(port), BETTER_ME_IMAGE: process.env.BETTER_ME_IMAGE || `better-me:${project}` };
const skipBuild = process.argv.includes("--skip-build");
function docker(args, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { output += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Docker command timed out: ${args.slice(0, 3).join(" ")}`)); }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(output)); });
  });
}
const compose = (...args) => docker(["compose", "--project-name", project, ...args], 25 * 60_000);
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
async function request(path, options = {}, expected = 200) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10_000), redirect: "error" });
  const body = await response.text();
  assert.equal(response.status, expected, `${path}: ${body.slice(0, 200)}`);
  return body;
}
async function bootstrap() {
  const text = await request("/__better-me/runtime.js");
  const config = JSON.parse(text.replace(/^window\.__BETTER_ME_RUNTIME__=/, "").replace(/;$/, ""));
  assert.equal(config.origin, base);
  assert.match(config.agentToken, /^[\w-]{43}$/);
  assert.match(config.jobToken, /^[\w-]{43}$/);
  return config;
}
const source = {
  sourceId: "synthetic-docker-smoke", name: "Synthetic Docker persistence fixture (disabled)", adapterId: "ashby", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "disabled", remoteFilters: [],
  entryUrl: "https://api.ashbyhq.com/posting-api/job-board/synthetic-smoke", options: { boardToken: "synthetic-smoke", companyName: "Synthetic fixture" },
  endpointPolicy: { allowedHosts: ["api.ashbyhq.com"], allowedPathPrefixes: ["/posting-api/job-board/synthetic-smoke"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic disabled test fixture", homepageUrl: "https://example.test", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 20 },
};
let id;
try {
  console.log(`Starting isolated Compose project ${project}; this does not use your normal volume.`);
  await compose("up", "-d", ...(skipBuild ? [] : ["--build"]), "--wait", "--wait-timeout", "120");
  id = (await compose("ps", "-q", "web")).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  const inspect = async () => JSON.parse(await docker(["inspect", id]))[0];
  const state = await inspect();
  assert.equal(state.State.Health.Status, "healthy");
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.ok(state.HostConfig.CapDrop.includes("ALL"));
  assert.equal(state.HostConfig.RestartPolicy.Name, "unless-stopped");
  assert.notEqual(state.Config.User, "root");
  assert.deepEqual(Object.keys(state.NetworkSettings.Ports), ["8080/tcp"]);
  assert.equal(state.NetworkSettings.Ports["8080/tcp"][0].HostIp, "127.0.0.1");
  assert.ok(state.Mounts.some(mount => mount.Type === "volume" && mount.Destination === "/data"));
  assert.ok(!state.Mounts.some(mount => mount.Type === "bind"), "No host profile, socket, source or secret mounts");
  assert.deepEqual(JSON.parse(await request("/healthz")), { mode: "full", status: "ok" });
  assert.match(await request("/"), /__better-me\/runtime\.js/);
  await request("/assets/missing.js", {}, 404);
  await request("/__better-me/runtime.js", { headers: { Origin: "https://unrelated.example" } }, 403);
  await request("/api/v1/agent/health", {}, 401);
  const config = await bootstrap();
  const headers = { Authorization: `Bearer ${config.jobToken}`, Origin: base, "Content-Type": "application/json" };
  const agentTransport = { ...headers, Authorization: `Bearer ${config.agentToken}` };
  const register = async username => {
    const response = await fetch(`${base}/api/v1/agent/identity/register`, { method: "POST", headers: agentTransport,
      body: JSON.stringify({ username, password: "synthetic-docker-only-password-2026" }), signal: AbortSignal.timeout(10_000), redirect: "error" });
    assert.equal(response.status, 200, "Isolated synthetic account registration succeeds");
    const { principal } = await response.json();
    assert.equal(typeof principal?.id, "string");
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("betterme_session="));
    assert.ok(cookie, "Synthetic registration issues an HttpOnly session");
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    return { principal, headers: { ...agentTransport, Cookie: cookie.split(";")[0], "X-BetterMe-Owner": principal.id } };
  };
  const alice = await register("synthetic-docker-alice");
  const bob = await register("synthetic-docker-bob");
  assert.notEqual(alice.principal.id, bob.principal.id);
  const agentHeaders = alice.headers;
  assert.equal(JSON.parse(await request("/api/v1/agent/health", { headers: { Authorization: `Bearer ${config.agentToken}` } })).status, "ok");
  const understanding = "/api/v1/agent/understanding";
  await request(`${understanding}/capabilities`, {}, 401);
  await request(`${understanding}/capabilities`, { headers: agentTransport }, 401);
  await request(`${understanding}/capabilities`, { headers: { ...agentTransport, Cookie: alice.headers.Cookie } }, 409);
  await request(`${understanding}/capabilities`, { headers: { ...bob.headers, "X-BetterMe-Owner": alice.principal.id } }, 409);
  assert.deepEqual(JSON.parse(await request(`${understanding}/capabilities`, { headers: agentHeaders })).runtimes, [], "Container must not pretend host CLIs are installed");
  const session = JSON.parse(await request(`${understanding}/sessions`, { method: "POST", headers: agentHeaders,
    body: JSON.stringify({ workspaceKey: "synthetic-docker-smoke", projectKey: "synthetic-project", label: "Synthetic project only", sourceText: "Fictional dispatch orchestration, not personal contribution." }),
  }, 201));
  assert.equal(session.phase, "idle");
  assert.equal(session.turnCount, 0, "Creating a session must not start a model or read source files");
  const sessionUrl = `${understanding}/sessions/${session.id}`;
  await request(sessionUrl, { headers: bob.headers }, 404);
  // Grant only a file inside the public image. No host profile/source mounts or model calls.
  const granted = JSON.parse(await request(`${sessionUrl}/grants`, { method: "POST", headers: agentHeaders,
    body: JSON.stringify({ path: "/workspace/apps/agent-host/src/understanding/http.ts" }),
  }));
  assert.equal(granted.grants.length, 1);
  assert.deepEqual(granted.evidence, [], "Authorizing a file is not itself permission to send it to a model");
  await request(`${sessionUrl}/confirm`, { method: "POST", headers: agentHeaders,
    body: JSON.stringify({ expectedRevision: granted.revision, summaryHash: "not-a-generated-consensus" }),
  }, 409);
  const revoked = JSON.parse(await request(`${sessionUrl}/grants/${granted.grants[0].id}`, { method: "DELETE", headers: agentHeaders }));
  assert.ok(revoked.grants[0].revokedAt);
  assert.equal(revoked.confirmation, undefined);
  const savedSession = JSON.parse(await request(`${sessionUrl}/source`, { method: "POST", headers: agentHeaders,
    body: JSON.stringify({ expectedRevision: revoked.revision, sourceText: "Fictional project clarification retained across container recreation." }),
  }));
  assert.equal(JSON.parse(await request("/api/v1/jobs/search", { method: "POST", headers, body: "{}" })).ok, true);
  const receipt = JSON.parse(await request("/api/v1/sources", { method: "POST", headers: { ...headers, "Idempotency-Key": "synthetic-docker-smoke" }, body: JSON.stringify({ source }) }));
  assert.equal(receipt.ok, true);
  const checkPersisted = async () => {
    assert.deepEqual(await bootstrap(), config, "Both tokens survive recovery and container recreation");
    const sources = JSON.parse(await request("/api/v1/sources", { headers }));
    assert.ok(sources.value.sources.some(item => item.sourceId === source.sourceId), "SQLite write survives recovery");
    assert.equal(JSON.parse(await request("/api/v1/agent/identity/session", { headers: agentHeaders })).principal.id, alice.principal.id,
      "The same synthetic account session survives recovery and recreation");
    await request(sessionUrl, { headers: bob.headers }, 404);
    await request(sessionUrl, { headers: { ...bob.headers, "X-BetterMe-Owner": alice.principal.id } }, 409);
    assert.deepEqual(JSON.parse(await request(sessionUrl, { headers: agentHeaders })), savedSession, "Project history, source revision and revoked grant survive recovery without touching the job index");
  };
  await checkPersisted();
  // Kill only this test container's exact runtime process, not Docker Desktop or host services.
  await docker(["exec", id, "node", "-e", `const fs=require('node:fs'); const ids=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).filter(x=>{try{const a=fs.readFileSync('/proc/'+x+'/cmdline','utf8').split('\\0');return a[1]==='--import'&&a[2]==='tsx'&&a[3]==='apps/web/server/runtime-server.ts'}catch{return false}});if(ids.length!==1)process.exit(2);process.kill(Number(ids[0]),'SIGKILL');`]);
  const deadline = Date.now() + 90_000;
  let recovered = false;
  while (Date.now() < deadline) {
    const current = await inspect();
    if (current.RestartCount > state.RestartCount && current.State.Health?.Status === "healthy") { recovered = true; break; }
    await pause();
  }
  assert.equal(recovered, true, "Crash must restart and become healthy");
  await checkPersisted();
  await compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120");
  id = (await compose("ps", "-q", "web")).trim();
  await checkPersisted();
  console.log("PASS: full Compose startup, auth/origin, synthetic account login and cross-account isolation, APIs, project-understanding grant/revocation and session persistence, SQLite/token persistence, process crash recovery and container recreation. No model or host source access.");
} catch (error) {
  console.error(await compose("logs", "--tail", "80", "web").catch(() => "No test container logs available."));
  throw error;
} finally {
  // This random project was created above; never remove another project's data.
  await compose("down", "--volumes", "--remove-orphans").catch(error => console.error(`Test cleanup: ${error.message}`));
}
