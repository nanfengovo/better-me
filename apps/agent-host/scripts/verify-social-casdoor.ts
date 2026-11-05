/** Opt-in pinned Casdoor acceptance against a disposable database, never the installed account store. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { SOCIAL_PROVIDERS } from "@better-me/agent-contracts";
import { IdentityService } from "../src/identity/service.js";
import { OidcService } from "../src/identity/oidc.js";

const [binary, webRoot] = process.argv.slice(2);
if (!binary || !webRoot || !path.isAbsolute(binary) || !path.isAbsolute(webRoot)) throw new Error("Usage: tsx verify-social-casdoor.ts /absolute/casdoor /absolute/public-web-directory");
const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-social-casdoor-"));
let child: ChildProcess | undefined;
try {
  const probe = net.createServer().listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const issuer = `http://127.0.0.1:${port}`, callbackUrl = "http://localhost:5393/api/v1/agent/identity/oidc/callback";
  await mkdir(path.join(directory, "conf")); await mkdir(path.join(directory, "data")); await mkdir(path.join(directory, "logs"));
  await symlink(webRoot, path.join(directory, "web"), "dir");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Synthetic BetterMe Social Acceptance",
    "-keyout", path.join(directory, "data/signing.key"), "-out", path.join(directory, "data/signing.crt")], { stdio: "ignore" });
  const secret = randomBytes(32).toString("base64url"), org = "synthetic-social", clientId = "synthetic-social-client";
  const providers = SOCIAL_PROVIDERS.map(provider => ({ owner: "admin", name: "synthetic-" + provider.id, category: "OAuth", type: provider.type,
    displayName: provider.label, clientId: "synthetic-provider-client", clientSecret: secret }));
  const data = { organizations: [{ owner: "admin", name: org, displayName: "Synthetic acceptance only", passwordType: "bcrypt", defaultApplication: "synthetic-social" }],
    applications: [{ owner: "admin", name: "synthetic-social", organization: org, displayName: "Synthetic acceptance", clientId, clientSecret: secret,
      cert: "synthetic-social", enablePassword: true, enableSignUp: true, signinMethods: [{ name: "Password", rule: "All" }],
      providers: providers.map(provider => ({ owner: "admin", name: provider.name, canSignIn: true, canSignUp: true, bindingRule: [] })),
      redirectUris: [callbackUrl], grantTypes: ["authorization_code"], tokenFormat: "JWT", expireInHours: 1 }], users: [], providers,
    certs: [{ owner: "admin", name: "synthetic-social", scope: "JWT", type: "x509", cryptoAlgorithm: "RS256", bitSize: 2048,
      certificate: await readFile(path.join(directory, "data/signing.crt"), "utf8"), privateKey: await readFile(path.join(directory, "data/signing.key"), "utf8") }] };
  await writeFile(path.join(directory, "init_data.json"), JSON.stringify(data), { mode: 0o600 });
  await writeFile(path.join(directory, "conf/app.conf"), ["appname = casdoor", "httpaddr = 127.0.0.1", `httpport = ${port}`, "radiusServerPort = -1", "runmode = prod",
    "copyrequestbody = true", "driverName = sqlite3", "dataSourceName = ./data/casdoor.db?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)", "dbName = casdoor",
    `origin = ${issuer}`, `originFrontend = ${issuer}`, "isDemoMode = false", "initDataNewOnly = true", "initDataFile = ./init_data.json", "frontendBaseDir = ./web",
    `initAdminPassword = ${secret}`, "enableErrorMask = true", "socks5Proxy =", "showSql = false"].join("\n"), { mode: 0o600 });
  child = spawn(binary, [], { cwd: directory, stdio: "ignore" });
  const until = Date.now() + 25_000;
  while (true) {
    try { const response = await fetch(issuer + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch { /* startup */ }
    if (Date.now() >= until || child.exitCode !== null) throw new Error("isolated_casdoor_did_not_start");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const oidc = new OidcService({ issuer, clientId, clientSecret: secret, callbackUrl, allowLoopbackHttp: true }, new IdentityService(path.join(directory, "host")));
  const catalog = await oidc.social.list();
  assert.equal(catalog.service, "ready");
  assert.deepEqual(catalog.channels.map(channel => channel.state), SOCIAL_PROVIDERS.map(() => "available"));
  assert.ok(!JSON.stringify(catalog).includes(secret));
  for (const provider of SOCIAL_PROVIDERS) {
    const flow = await oidc.start({ intent: "login", provider: provider.id }, undefined, undefined, "isolated-casdoor");
    const url = new URL(flow.url); assert.equal(url.searchParams.get("provider_hint"), "synthetic-" + provider.id);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.origin, issuer);
    const response = await fetch(url, { redirect: "manual" }); assert.ok([200, 302, 303].includes(response.status));
  }
  console.log(JSON.stringify({ realCasdoor: "passed", publicCatalog: `${SOCIAL_PROVIDERS.length} configured synthetic providers`, oidcEntrypoints: `${SOCIAL_PROVIDERS.length} passed`,
    secretsExposed: false, realSupplierLogin: "not tested; requires approved platform applications", installedAccountsChanged: false }));
} finally {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }
  await rm(directory, { recursive: true, force: true });
}
