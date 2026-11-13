import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadCareerOperatorConfig } from "../src/career-studio/operator-config.js";
import type { CareerOperatorConfig } from "../src/career-studio/operator-config.js";
import type { CloudPrivacyAdapter, CloudRuntimeBinding, CloudDisclosureEnvelope } from "../src/privacy/index.js";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const remote = { id: "reviewed-remote", label: "Operator reviewed remote", server: { id: "reviewed-remote", version: "v1", transport: { kind: "streamable-http" as const, endpoint: "https://synthetic-mcp.invalid/mcp" }, allowedTools: ["public_evidence"], allowedResources: ["synthetic://public"], maxInputBytes: 64_000, maxOutputBytes: 64_000, maxActiveMs: 5000 } };
const binding: CloudRuntimeBinding = { id: "existing-synthetic-provider", version: "credential-generation-1", location: "cloud", recipientOrigin: "https://synthetic-cloud.invalid", endpointFingerprint: "f".repeat(64), model: "explicit-synthetic-model" };
const envelope: CloudDisclosureEnvelope = { protocol: "betterme.disclosure.v1", taskId: "task-1", operationId: "operation-1", model: binding.model, summary: { evidence: "Implemented CAS guarded state restoration." }, sources: [{ id: "fact-1", revision: "v1", hash: "e".repeat(64) }] };
async function fixture(t: { after(fn: () => Promise<void> | void): void }, value: CareerOperatorConfig = { version: 1, revision: "v1", mcpServers: [remote] }) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "betterme-operator-config-"))), filename = path.join(directory, "operator.json");
  await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // A real production Windows deployment must use its trusted ACL adapter.
  // These isolated test files are synthetic, not real account configurations.
  const reviewWindowsAcl = async () => true;
  return { directory, filename, reviewWindowsAcl, write: async (config: unknown) => fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 }) };
}

test("operator absent fixed path remains entirely unconfigured and never resolves a provider or default API", async () => {
  let calls = 0;
  const config = await loadCareerOperatorConfig({ resolvePrivacyProvider: async () => { calls++; return undefined; } });
  assert.equal(config.configured, false); assert.deepEqual(config.status, { mcpServerCount: 0, cloudReferenced: false, cloudAdapterAvailable: false, vorkConfigured: false });
  assert.deepEqual(await config.getMcpServers(), []); assert.equal(await config.getVorkBinary(), undefined); assert.equal(config.configuredCloud, undefined); assert.equal(calls, 0);
  await assert.rejects(loadCareerOperatorConfig({ configPath: "./operator.json" }), /operator_config_path_must_be_fixed_absolute/);
});

test("operator fixed private configuration pins hash and rejects credential/env/HTTP command injection without echoing contents", async t => {
  const f = await fixture(t), content = await fs.readFile(f.filename, "utf8"), config = await loadCareerOperatorConfig({ configPath: f.filename, expectedConfigHash: sha(content), reviewWindowsAcl: f.reviewWindowsAcl });
  assert.equal(config.configHash, sha(content)); assert.deepEqual(await config.getMcpServers(), [remote]);
  await assert.rejects(loadCareerOperatorConfig({ configPath: f.filename, expectedConfigHash: "0".repeat(64), reviewWindowsAcl: f.reviewWindowsAcl }), /operator_config_hash_mismatch/);
  await f.write({ version: 1, revision: "v1", mcpServers: [remote], apiKey: "SYNTHETIC_UNAUTHORIZED_CREDENTIAL_CANARY_18467", env: { OPENAI_API_KEY: "MUST_NOT_BE_CONSUMED" } });
  await assert.rejects(loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl }), error => { assert.equal(String(error).includes("CANARY"), false); return String(error).includes("operator_config_unavailable_or_invalid"); });
  await f.write({ version: 1, revision: "v1", mcpServers: [{ ...remote, server: { ...remote.server, transport: { kind: "streamable-http", endpoint: "http://127.0.0.1/mcp", executable: "/bin/sh" } } }] });
  await assert.rejects(loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl }), /operator_config_unavailable_or_invalid/);
});

test("operator refuses symlink configuration and POSIX public permissions or missing Windows ACL review", async t => {
  const f = await fixture(t), link = path.join(f.directory, "alias.json"); await fs.symlink(f.filename, link);
  await assert.rejects(loadCareerOperatorConfig({ configPath: link, reviewWindowsAcl: f.reviewWindowsAcl }), /operator_config_not_canonical_file/);
  if (process.platform === "win32") await assert.rejects(loadCareerOperatorConfig({ configPath: f.filename }), /operator_windows_acl_review_required/);
  else { await fs.chmod(f.filename, 0o644); await assert.rejects(loadCareerOperatorConfig({ configPath: f.filename }), /operator_config_permissions_untrusted/); }
});

test("operator validates reviewed stdio artifacts and Vork binary without executing; later artifact/config edits revoke capability", async t => {
  const f = await fixture(t), executable = path.join(f.directory, "reviewed-runtime"), entrypoint = path.join(f.directory, "reviewed-server.js"), vork = path.join(f.directory, "reviewed-vork");
  await fs.writeFile(executable, "SYNTHETIC_RUNTIME_NOT_EXECUTED", { mode: 0o700 }); await fs.writeFile(entrypoint, "SYNTHETIC_MCP_NOT_EXECUTED", { mode: 0o600 }); await fs.writeFile(vork, "SYNTHETIC_VORK_NOT_EXECUTED", { mode: 0o700 });
  const local = { ...remote, server: { ...remote.server, transport: { kind: "stdio" as const, spec: { command: executable, args: [entrypoint], executableHash: sha("SYNTHETIC_RUNTIME_NOT_EXECUTED"), artifacts: [{ path: entrypoint, hash: sha("SYNTHETIC_MCP_NOT_EXECUTED") }], allowedReadPaths: [entrypoint] } } } };
  await f.write({ version: 1, revision: "reviewed-v1", mcpServers: [local], vork: { binaryPath: vork, sha256: sha("SYNTHETIC_VORK_NOT_EXECUTED") } });
  const config = await loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl });
  assert.equal((await config.getMcpServers())[0]!.server.transport.kind, "stdio"); assert.equal(await config.getVorkBinary(), vork);
  await fs.writeFile(entrypoint, "CHANGED_SYNTHETIC_MCP"); await assert.rejects(config.getMcpServers(), /operator_artifact_hash_mismatch/);
  await fs.writeFile(entrypoint, "SYNTHETIC_MCP_NOT_EXECUTED"); await config.assertCurrent();
  await fs.writeFile(vork, "CHANGED_SYNTHETIC_VORK"); await assert.rejects(config.getVorkBinary(), /operator_artifact_hash_mismatch/);
  await fs.writeFile(vork, "SYNTHETIC_VORK_NOT_EXECUTED"); await f.write({ version: 1, revision: "v2", mcpServers: [] });
  await assert.rejects(config.getMcpServers(), /operator_configuration_changed_reload_required/);
});

test("operator remote endpoint scopes and immutable server clones cannot silently expand a manifest", async t => {
  const f = await fixture(t), config = await loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl });
  const selected = await config.getMcpServers(); selected[0]!.server.allowedTools.push("write_fact"); assert.deepEqual((await config.getMcpServers())[0]!.server.allowedTools, ["public_evidence"]);
  for (const endpoint of ["http://synthetic-mcp.invalid/mcp", "https://user:pass@synthetic-mcp.invalid/mcp", "https://synthetic-mcp.invalid/mcp?token=CANARY", "https://localhost/mcp"]) {
    await f.write({ version: 1, revision: "v1", mcpServers: [{ ...remote, server: { ...remote.server, transport: { kind: "streamable-http", endpoint } } }] });
    await assert.rejects(loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl }), /operator_mcp_endpoint_untrusted/);
  }
});

test("operator cloud DI resolves only explicit existing provider reference and only strict approved summaries reach it", async t => {
  const f = await fixture(t, { version: 1, revision: "v1", mcpServers: [], privacyCloud: { providerId: "existing-provider" } }), references: unknown[] = [], delivered: unknown[] = [];
  const adapter: CloudPrivacyAdapter = { binding: async () => binding, dispatch: async data => { delivered.push(data); return { text: "Only supplied synthetic evidence.", sourceIds: ["fact-1"], unknowns: [] }; } };
  const config = await loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl, resolvePrivacyProvider: async reference => { references.push(reference); return adapter; } });
  assert.equal(references.length, 0); const selected = await config.configuredCloud!.binding(); assert.equal(selected.model, binding.model); assert.notEqual(selected.version, binding.version);
  assert.deepEqual(references[0], { providerId: "existing-provider", configRevision: "v1", configHash: config.configHash });
  await assert.rejects(config.configuredCloud!.dispatch({ ...envelope, summary: { evidence: 'api_key="SYNTHETIC_CREDENTIAL_CANARY_825791"' } }, new AbortController().signal), /operator_cloud_unsafe_summary/); assert.equal(delivered.length, 0);
  await assert.rejects(config.configuredCloud!.dispatch({ ...envelope, sources: [{ id: "fact-1", revision: "v1", hash: "f".repeat(64), raw: "SOURCE_CANARY" }] } as unknown as CloudDisclosureEnvelope, new AbortController().signal), /operator_cloud_approved_summary_required/); assert.equal(delivered.length, 0);
  const output = await config.configuredCloud!.dispatch(envelope, new AbortController().signal); assert.ok(output); assert.deepEqual(delivered, [envelope]);
  config.close(); await assert.rejects(config.configuredCloud!.binding(), /operator_configuration_closed/);
  const unavailable = await loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl }); assert.equal(unavailable.configuredCloud, undefined); assert.equal(unavailable.status.cloudReferenced, true); assert.equal(unavailable.status.cloudAdapterAvailable, false);
});

test("operator cloud endpoint/version/config drift and cancellation after dispatch reject late results without a second call", async t => {
  const f = await fixture(t, { version: 1, revision: "v1", mcpServers: [], privacyCloud: { providerId: "existing-provider" } }), started = deferred<void>(), done = deferred<void>();
  let version = "v1", dispatches = 0;
  const adapter: CloudPrivacyAdapter = { binding: async () => ({ ...binding, version }), dispatch: async () => { dispatches++; started.resolve(); await done.promise; return { text: "LATE_SYNTHETIC_OUTPUT", sourceIds: ["fact-1"], unknowns: [] }; } };
  const config = await loadCareerOperatorConfig({ configPath: f.filename, reviewWindowsAcl: f.reviewWindowsAcl, resolvePrivacyProvider: async () => adapter }); await config.configuredCloud!.binding();
  const pending = config.configuredCloud!.dispatch(envelope, new AbortController().signal); await started.promise; version = "v2"; done.resolve(); await assert.rejects(pending, /operator_cloud_binding_changed/); assert.equal(dispatches, 1);
  await assert.rejects(config.configuredCloud!.dispatch(envelope, new AbortController().signal), /operator_cloud_binding_changed/); assert.equal(dispatches, 1);
  const g = await fixture(t, { version: 1, revision: "v1", mcpServers: [], privacyCloud: { providerId: "existing-provider" } }), cancel = new AbortController();
  const other = await loadCareerOperatorConfig({ configPath: g.filename, reviewWindowsAcl: g.reviewWindowsAcl, resolvePrivacyProvider: async () => ({ binding: async () => binding, dispatch: async () => { cancel.abort(); return "LATE"; } }) });
  await assert.rejects(other.configuredCloud!.dispatch(envelope, cancel.signal), /privacy_cancelled/);
});
