import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionIdentityDeployment } from "../src/identity/bootstrap.js";
import { loadIdentityDeployment } from "../src/identity/deployment.js";
import { checkIdentityDeployment } from "../src/identity/deployment-check.js";
import { socialIdp } from "./fixtures/social-idp.js";

test("operator bootstrap is outside the repo, private, exclusive and starts with no claimed users or providers", async t => {
  const parent = await mkdtemp(join(tmpdir(), "betterme-identity-bootstrap-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "new-identity");
  const input = { directory, issuer: "https://identity.example.invalid", publicOrigin: "https://workspace.example.invalid" };
  const result = await provisionIdentityDeployment(input);
  const privateText = await readFile(join(directory, "oidc.json"), "utf8");
  const oidc = JSON.parse(privateText);
  assert.equal(JSON.stringify(result).includes(oidc.clientSecret), false);
  assert.equal(oidc.callbackUrl, input.publicOrigin + "/api/v1/agent/identity/oidc/callback");
  const data = JSON.parse(await readFile(join(directory, "init_data.json"), "utf8"));
  assert.deepEqual(data.users, []); assert.deepEqual(data.providers, []);
  assert.deepEqual(data.applications[0].providers, []);
  assert.deepEqual(data.applications[0].redirectUris, [oidc.callbackUrl]);
  assert.ok(data.certs.every((cert: Record<string, unknown>) => cert.cryptoAlgorithm === "RS256" && !cert.privateKey));
  assert.match(await readFile(join(directory, "conf/app.conf"), "utf8"), /initDataNewOnly = true/);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of ["oidc.json", "init_data.json", "bootstrap.private.json", "client-secret", "deployment.env", "conf/app.conf"]) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  await assert.rejects(provisionIdentityDeployment(input), /EEXIST/);
  assert.equal((await readFile(join(directory, "oidc.json"), "utf8")) === privateText, true);
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  await assert.rejects(provisionIdentityDeployment({ ...input, directory: join(repository, "must-not-create-private-auth") }), /outside_repository/);
});

test("operator checks distinguish local, unavailable, unsafe and ready without returning secrets", async t => {
  const callback = "http://localhost:5383/api/v1/agent/identity/oidc/callback";
  const idp = await socialIdp(callback); t.after(() => idp.close());
  const deployment = { mode: "unified" as const, source: "file" as const, oidc: idp.options };
  const ready = await checkIdentityDeployment(deployment);
  assert.equal(ready.ready, true); assert.equal(ready.status, "unified_ready");
  assert.equal(JSON.stringify(ready).includes(idp.options.clientSecret), false);
  idp.controls.offline = true;
  assert.equal((await checkIdentityDeployment(deployment)).status, "oidc_catalog_unavailable");
  const offline = await checkIdentityDeployment(deployment, async () => { throw new Error("synthetic-secret-must-not-be-repeated"); });
  assert.equal(offline.status, "oidc_discovery_unavailable"); assert.equal(JSON.stringify(offline).includes("synthetic-secret"), false);
  let cancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  assert.equal((await checkIdentityDeployment(deployment, async () => oversized)).status, "oidc_discovery_unavailable");
  assert.equal(cancelled, true, "oversized discovery is stopped without buffering an unlimited response");
  assert.equal((await checkIdentityDeployment(await loadIdentityDeployment({ env: { BETTERME_AUTH_MODE: "local" } }))).status, "local_only");
});
