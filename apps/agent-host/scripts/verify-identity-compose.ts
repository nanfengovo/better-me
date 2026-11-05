/** Configuration-only acceptance. Never starts Docker, downloads images or uses existing secrets. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { provisionIdentityDeployment } from "../src/identity/bootstrap.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "betterme-identity-compose-"));
try {
  const directory = path.join(root, "private");
  await provisionIdentityDeployment({ directory, issuer: "https://identity.example.invalid", publicOrigin: "https://workspace.example.invalid" });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BETTER") && !key.startsWith("CASDOOR")));
  const run = (files: string[]) => JSON.parse(execFileSync("docker", ["compose", "--env-file", path.join(directory, "deployment.env"), ...files.flatMap(file => ["-f", file]), "config", "--format", "json"],
    { cwd: repository, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const application = run(["compose.yaml", "compose.oidc.yaml"]), identity = run(["deploy/identity/compose.yaml"]);
  assert.equal(application.services.web.environment.BETTER_ME_PUBLIC_ORIGIN, "https://workspace.example.invalid");
  assert.equal(application.services.web.environment.BETTERME_OIDC_CLIENT_SECRET_FILE, "/run/secrets/betterme_oidc_client_secret");
  assert.equal(application.services.web.environment.BETTERME_OIDC_CLIENT_SECRET, undefined);
  assert.equal(application.services.web.ports[0].host_ip, "127.0.0.1");
  assert.deepEqual(Object.keys(application.services), ["web"]);
  assert.equal(identity.services.casdoor.ports[0].host_ip, "127.0.0.1");
  assert.equal(identity.services.casdoor.image, "casbin/casdoor:v4.25.0");
  assert.ok(identity.services.casdoor.volumes.some((volume: { target: string; type: string }) => volume.target === "/logs" && volume.type === "volume"));
  const value = await readFile(path.join(directory, "client-secret"), "utf8");
  assert.equal(JSON.stringify({ application, identity }).includes(value), false);
  console.log(JSON.stringify({ applicationOverlay: "valid", independentIdentityCompose: "valid", noCasdoorRequirementForWebUsers: true, secretValuesInRenderedConfig: false, dockerDaemonStarted: false }));
} catch {
  // execFile error objects can contain rendered config. Print only a fixed diagnostic.
  console.error("identity_compose_acceptance_failed"); process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
