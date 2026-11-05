/** Actual pinned Casdoor + NEW disposable bootstrap; never opens installed accounts/configuration. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { provisionIdentityDeployment } from "../src/identity/bootstrap.js";
import { loadIdentityDeployment } from "../src/identity/deployment.js";
import { checkIdentityDeployment } from "../src/identity/deployment-check.js";
import { IdentityService } from "../src/identity/service.js";
import { OidcService } from "../src/identity/oidc.js";

const [binary, webRoot] = process.argv.slice(2);
if (!binary || !webRoot || !path.isAbsolute(binary) || !path.isAbsolute(webRoot)) throw new Error("absolute_public_binary_and_web_directory_required");
const directory = await mkdtemp(path.join(tmpdir(), "betterme-new-identity-live-"));
let child: ChildProcess | undefined;
try {
  const probe = net.createServer().listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const issuer = `http://127.0.0.1:${port}`, root = path.join(directory, "new-identity");
  await provisionIdentityDeployment({ directory: root, issuer, publicOrigin: "http://auth-deployment-fixture.localhost:5437", allowLoopbackHttp: true });
  await mkdir(path.join(root, "logs"));
  const conf = path.join(root, "conf/app.conf");
  await writeFile(conf, (await readFile(conf, "utf8")).replace("httpaddr = 0.0.0.0", "httpaddr = 127.0.0.1").replace("httpport = 8000", `httpport = ${port}`)
    .replaceAll("/logs", path.join(root, "logs")).replace("/init_data.json", path.join(root, "init_data.json")).replace("/web/build", webRoot), { mode: 0o600 });
  child = spawn(binary, [], { cwd: root, stdio: "ignore" });
  const deadline = Date.now() + 30_000;
  while (true) {
    try { if ((await fetch(issuer + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* fixture startup */ }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("new_disposable_identity_did_not_start");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const deployment = await loadIdentityDeployment({ env: { BETTERME_AUTH_MODE: "unified", BETTERME_OIDC_CONFIG: path.join(root, "oidc.json") } });
  assert.ok(deployment.oidc); assert.equal((await checkIdentityDeployment(deployment)).status, "unified_ready");
  const identities = new IdentityService(path.join(directory, "host")), oidc = new OidcService(deployment.oidc, identities);
  const password = randomBytes(24).toString("base64url");
  const user = { name: "synthetic-" + randomBytes(6).toString("hex"), password };
  const signup = await (await fetch(issuer + "/api/signup", { method: "POST", headers: { "Content-Type": "application/json", Origin: issuer },
    body: JSON.stringify({ application: "app-betterme", organization: "betterme", username: user.name, name: "Synthetic deployment acceptance", password }) })).json();
  assert.equal(signup.status === "ok", true, "new bootstrap must support a disposable account, not just discovery");
  const local = await identities.signIn({ username: "synthetic-local-alice", password }, true, "fixture");
  async function complete(intent: "login" | "link") {
    const started = await oidc.start({ intent, ...(intent === "link" ? { password } : {}) }, intent === "link" ? identities.cookie(local.token, false) : undefined, intent === "link" ? local.principal.id : undefined, "fixture");
    const auth = new URL(started.url), query = new URLSearchParams();
    for (const [to, from] of Object.entries({ clientId: "client_id", responseType: "response_type", redirectUri: "redirect_uri", scope: "scope", state: "state", nonce: "nonce", code_challenge: "code_challenge", code_challenge_method: "code_challenge_method" })) query.set(to, auth.searchParams.get(from)!);
    const login = await (await fetch(issuer + "/api/login?" + query, { method: "POST", headers: { "Content-Type": "application/json", Origin: issuer },
      body: JSON.stringify({ type: "code", signinMethod: "Password", application: "app-betterme", organization: "betterme", username: user.name, password, autoSignin: false }) })).json();
    assert.equal(login.status === "ok" && typeof login.data === "string", true, "fresh signing keys must work for real code flow");
    return oidc.complete(new URLSearchParams({ code: login.data, state: auth.searchParams.get("state")!, iss: issuer }).toString(), started.cookie.split(";")[0]);
  }
  assert.equal((await complete("link")).principal.id, local.principal.id);
  assert.equal((await complete("login")).principal.id, local.principal.id);
  console.log(JSON.stringify({ status: "fresh-native-casdoor-deployment-passed", independentSigningKeys: true, realCodePkceSignedJwt: true, explicitLinkAndRepeatSameOwner: true,
    realSupplierLogin: "not attempted", installedAccountsReadOrChanged: false }));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }
  await rm(directory, { recursive: true, force: true });
}
