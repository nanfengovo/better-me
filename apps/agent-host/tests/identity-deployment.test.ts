import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentityDeployment, publicOrigins } from "../src/identity/deployment.js";

test("local mode never reads a configured secret or changes existing account files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-auth-local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "oidc.json");
  await writeFile(file, "existing-private-config-not-json", { mode: 0o600 });
  const loaded = await loadIdentityDeployment({ env: { BETTERME_AUTH_MODE: "local", BETTERME_OIDC_CONFIG: file }, defaultConfigPath: file });
  assert.equal(loaded.mode, "local"); assert.equal(loaded.oidc, undefined); assert.equal(loaded.issue, undefined);
  assert.equal(await readFile(file, "utf8"), "existing-private-config-not-json");
});

test("an unchanged legacy private OIDC file is still loaded without migrating its issuer or owner", async t => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-auth-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "oidc.json");
  const options = { issuer: "http://127.0.0.1:18000", clientId: "synthetic-legacy", clientSecret: "synthetic-only-secret", callbackUrl: "http://localhost:5173/api/v1/agent/identity/oidc/callback", allowLoopbackHttp: true };
  await writeFile(file, JSON.stringify(options), { mode: 0o600 });
  const loaded = await loadIdentityDeployment({ env: {}, defaultConfigPath: file });
  assert.equal(loaded.mode, "unified"); assert.equal(loaded.source, "legacy_file"); assert.deepEqual(loaded.oidc, options);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), options);
});

test("unified deployments derive one exact HTTPS callback and read only the server secret file", async t => {
  const directory = await mkdtemp(join(tmpdir(), "betterme-auth-unified-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = join(directory, "client-secret"); await writeFile(secret, "synthetic-secret-mount\n", { mode: 0o600 });
  const env = { BETTERME_AUTH_MODE: "unified", BETTER_ME_PUBLIC_ORIGIN: "https://workspace.example.invalid", BETTERME_OIDC_ISSUER: "https://identity.example.invalid", BETTERME_OIDC_CLIENT_ID: "synthetic-client", BETTERME_OIDC_CLIENT_SECRET_FILE: secret };
  const loaded = await loadIdentityDeployment({ env });
  assert.equal(loaded.issue, undefined); assert.equal(loaded.source, "environment");
  assert.equal(loaded.oidc?.callbackUrl, env.BETTER_ME_PUBLIC_ORIGIN + "/api/v1/agent/identity/oidc/callback");
  assert.equal(loaded.oidc?.clientSecret === "synthetic-secret-mount", true);
  assert.deepEqual(publicOrigins(env, ["http://localhost:8080"]), [env.BETTER_ME_PUBLIC_ORIGIN, "http://localhost:8080"]);
});

test("broken explicit configuration has a fixed diagnostic, not a crash or a fallback to a different issuer", async () => {
  const missing = await loadIdentityDeployment({ env: { BETTERME_AUTH_MODE: "unified" } });
  assert.equal(missing.issue, "oidc_configuration_missing"); assert.equal(missing.oidc, undefined);
  const conflict = await loadIdentityDeployment({ env: { BETTERME_OIDC_CONFIG: "/never-read", BETTERME_OIDC_ISSUER: "https://identity.example.invalid" } });
  assert.equal(conflict.issue, "oidc_configuration_conflict");
  const invalid = await loadIdentityDeployment({ env: { BETTERME_AUTH_MODE: "typo" } });
  assert.equal(invalid.issue, "invalid_auth_mode");
  assert.deepEqual(publicOrigins({ BETTER_ME_PUBLIC_ORIGIN: "http://isolated-fixture.localhost:5437" }, []), ["http://isolated-fixture.localhost:5437"]);
  for (const value of ["http://workspace.example.invalid", "http://localhost.evil.invalid", "https://user:secret@example.invalid", "https://workspace.example.invalid/path", "https://workspace.example.invalid/?token=secret"]) {
    assert.throws(() => publicOrigins({ BETTER_ME_PUBLIC_ORIGIN: value }, []), /invalid_public_origin/);
  }
});
