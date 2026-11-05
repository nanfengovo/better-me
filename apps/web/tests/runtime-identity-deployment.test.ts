import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { socialIdp } from "../../agent-host/tests/fixtures/social-idp.js";

async function freePorts() {
  const servers = [createServer(), createServer(), createServer()];
  const ports: number[] = [];
  for (const server of servers) {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string"); ports.push(address.port);
  }
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  return ports as [number, number, number];
}

test("the actual packaged entry loads OIDC, preserves existing owners and data across modes, and survives IdP downtime", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-runtime-auth-"));
  const [webPort, jobPort, agentPort] = await freePorts();
  const origin = `http://127.0.0.1:${webPort}`, callback = origin + "/api/v1/agent/identity/oidc/callback";
  const idp = await socialIdp(callback);
  const sentinel = join(directory, "existing-resume.private.json"), content = '{"syntheticResume":"existing workspace stays untouched"}';
  await writeFile(sentinel, content, { mode: 0o600 });
  let child: ChildProcess | undefined, diagnostics = "";
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }
  };
  t.after(async () => { await stop(); await idp.close(); await rm(directory, { recursive: true, force: true }); });
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BETTER") && !key.startsWith("AGENT_")));
  const launch = async (extra: Record<string, string>) => {
    diagnostics = "";
    child = spawn(process.execPath, ["--import", "tsx", "apps/web/server/runtime-server.ts"], { env: { ...baseEnv, BETTER_ME_DATA_DIR: directory,
      BETTER_ME_INTERNAL_PORT: String(webPort), BETTER_ME_PORT: String(webPort), BETTER_ME_JOB_PORT: String(jobPort), BETTER_ME_AGENT_PORT: String(agentPort), ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", value => { diagnostics = (diagnostics + value).slice(-4000); });
    child.stderr?.on("data", value => { diagnostics = (diagnostics + value).slice(-4000); });
    const deadline = Date.now() + 25_000;
    while (true) {
      assert.equal(child.exitCode, null, "synthetic runtime exited before readiness");
      try { if ((await fetch(origin + "/healthz", { signal: AbortSignal.timeout(400) })).ok) break; } catch { /* isolated startup */ }
      if (Date.now() > deadline) throw new Error("synthetic_runtime_readiness_timeout");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const token = async () => JSON.parse((await (await fetch(origin + "/__better-me/runtime.js")).text()).replace("window.__BETTER_ME_RUNTIME__=", "").replace(/;$/, "")).agentToken as string;
  let transport = "";
  const call = (route: string, body?: unknown, cookie?: string, owner?: string) => fetch(origin + "/api/v1/agent/identity/" + route, { method: body ? "POST" : "GET", redirect: "manual",
    headers: { Authorization: "Bearer " + transport, Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(owner ? { "X-BetterMe-Owner": owner } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const credentials = { username: "synthetic-existing-alice", password: "synthetic-runtime-password-2026" };
  await launch({ BETTERME_AUTH_MODE: "local" }); transport = await token();
  const registered = await call("register", credentials); assert.equal(registered.status, 200);
  const original = (await registered.json()).principal;
  const store = join(directory, "agent", "runs", "accounts-v1", "identities.json");
  const users = JSON.stringify(JSON.parse(await readFile(store, "utf8")).users);
  assert.equal((await (await call("providers")).json()).service, "not_configured");
  await stop();
  await launch({ BETTERME_AUTH_MODE: "unified", BETTER_ME_PUBLIC_ORIGIN: origin, BETTERME_OIDC_ISSUER: idp.issuer, BETTERME_OIDC_CLIENT_ID: idp.options.clientId,
    BETTERME_OIDC_CLIENT_SECRET: idp.options.clientSecret, BETTERME_OIDC_ALLOW_LOOPBACK_HTTP: "true" });
  transport = await token();
  assert.equal((await (await call("providers")).json()).service, "ready", "production entry must actually load the shared OIDC configuration");
  assert.equal(JSON.stringify(JSON.parse(await readFile(store, "utf8")).users) === users, true);
  const signedIn = await call("sign-in", credentials); assert.equal(signedIn.status, 200); assert.deepEqual((await signedIn.json()).principal, original);
  const cookie = signedIn.headers.getSetCookie()[0]!.split(";")[0]!;
  const start = await call("oidc/start", { intent: "link", provider: "github", password: credentials.password }, cookie, original.id);
  assert.equal(start.status, 200);
  const auth = new URL((await start.json()).url), browserCookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
  const done = await fetch(callback + "?" + idp.issue(auth), { headers: { Cookie: browserCookie, "Sec-Fetch-Site": "cross-site" }, redirect: "manual" });
  assert.equal(done.status, 303); assert.equal(done.headers.get("location"), origin + "/?identity=linked");
  assert.deepEqual(await (await call("account", undefined, cookie, original.id)).json(), { localPassword: true, unifiedLinked: true });
  idp.controls.offline = true;
  assert.equal((await (await call("providers?refresh=1")).json()).service, "offline");
  assert.equal((await call("sign-in", credentials)).status, 200, "offline IdP must not block local sign-in");
  assert.equal((await readFile(sentinel, "utf8")) === content, true);
  assert.equal(JSON.stringify(JSON.parse(await readFile(store, "utf8")).users) === users, true);
  assert.equal(diagnostics.includes(idp.options.clientSecret), false);
  await stop();
  await launch({ BETTERME_AUTH_MODE: "unified", BETTERME_OIDC_CONFIG: join(directory, "missing-oidc.json") }); transport = await token();
  assert.equal((await call("sign-in", credentials)).status, 200, "missing online config still preserves local recovery");
  assert.match(diagnostics, /oidc_configuration_missing/);
});
