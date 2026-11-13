import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudRuntimeBindingSchema, PrivacyError, privacyDigest, privacyRuntimeFingerprint } from "../privacy/index.js";
import type { CloudPrivacyAdapter, CloudRuntimeBinding } from "../privacy/index.js";
import { disclosureViolations } from "../privacy/content-guard.js";
import type { ConfiguredCareerMcpServer } from "./mcp-client-http.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const selectedPath = z.string().min(1).max(4000).refine(value => path.isAbsolute(value) && !/[\0\r\n]/.test(value));
const stdio = z.object({ command: selectedPath, args: z.array(z.string().max(4000).refine(value => !/[\0\r\n]/.test(value))).max(100), executableHash: hash, artifacts: z.array(z.object({ path: selectedPath, hash }).strict()).min(1).max(200), allowedReadPaths: z.array(selectedPath).max(100) }).strict();
const server = z.object({ id, version: id, transport: z.discriminatedUnion("kind", [z.object({ kind: z.literal("stdio"), spec: stdio }).strict(), z.object({ kind: z.literal("streamable-http"), endpoint: z.string().url().max(2000) }).strict()]), allowedTools: z.array(id).max(50), allowedResources: z.array(z.string().min(1).max(2000)).max(50), maxInputBytes: z.number().int().min(1).max(256_000), maxOutputBytes: z.number().int().min(1).max(256_000), maxActiveMs: z.number().int().min(1).max(600_000) }).strict();
export const CareerOperatorConfigSchema = z.object({
  version: z.literal(1), revision: id,
  mcpServers: z.array(z.object({ id, label: z.string().min(1).max(200), server }).strict()).max(50).default([]),
  /** This is a reference to an existing owner-bound Host provider, not a key,
   * endpoint override, credential discovery request or a default API. */
  privacyCloud: z.object({ providerId: id }).strict().optional(),
  vork: z.object({ binaryPath: selectedPath, sha256: hash }).strict().optional(),
}).strict();
export type CareerOperatorConfig = z.infer<typeof CareerOperatorConfigSchema>;
export type PrivacyProviderReference = { providerId: string; configRevision: string; configHash: string };
export type ResolveOperatorPrivacyProvider = (reference: PrivacyProviderReference) => Promise<CloudPrivacyAdapter | undefined>;
export class CareerOperatorConfigError extends Error { constructor(readonly code: string) { super(code); this.name = "CareerOperatorConfigError"; } }

const envelope = z.object({ protocol: z.literal("betterme.disclosure.v1"), taskId: id, operationId: id, model: z.string().min(1).max(200), summary: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().min(1).max(12_000)).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 20), sources: z.array(z.object({ id, revision: id, hash }).strict()).min(1).max(200) }).strict();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const shell = /^(?:(?:ba|z|fi|k|c)?sh|cmd|powershell|pwsh|env|xargs|osascript|open)(?:\.exe)?$/i;

/** Reads exactly one explicitly configured operator-owned JSON file. This
 * function never scans a home directory, reads browser/provider credentials,
 * runs a process, contacts a provider, or accepts an HTTP-supplied path.
 * No path means an intentionally unconfigured deployment. Configuration is
 * immutable for this instance; edits require an explicit Host reload/mount.
 * Root must bind the optional provider resolver to the authenticated owner.
 * Every returned capability rechecks this file and its reviewed artifacts.
 */
export async function loadCareerOperatorConfig(options: {
  configPath?: string; expectedConfigHash?: string;
  resolvePrivacyProvider?: ResolveOperatorPrivacyProvider;
  /** POSIX permissions are enforced directly. Windows requires a trusted Host
   * ACL adapter; ordinary chmod bits are not claimed to establish a Windows ACL. */
  reviewWindowsAcl?: (input: { canonicalPath: string; fileHash: string }) => Promise<boolean>;
}) {
  let closed = false;
  const supplied = options.configPath;
  if (options.expectedConfigHash !== undefined && !hash.safeParse(options.expectedConfigHash).success) throw new CareerOperatorConfigError("operator_expected_hash_invalid");
  if (supplied !== undefined && (!selectedPath.safeParse(supplied).success || path.resolve(supplied) !== supplied)) throw new CareerOperatorConfigError("operator_config_path_must_be_fixed_absolute");
  if (supplied === undefined && options.expectedConfigHash !== undefined) throw new CareerOperatorConfigError("operator_hash_without_config");
  async function readConfiguration(): Promise<{ value: CareerOperatorConfig; hash: string }> {
    if (!supplied) return { value: { version: 1, revision: "unconfigured", mcpServers: [] }, hash: privacyDigest({ version: 1, revision: "unconfigured", mcpServers: [] }) };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const canonicalPath = await fs.realpath(supplied);
      if (canonicalPath !== supplied || !(await fs.lstat(supplied)).isFile()) throw new CareerOperatorConfigError("operator_config_not_canonical_file");
      handle = await fs.open(supplied, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > 256_000n) throw new CareerOperatorConfigError("operator_config_file_limit");
      if (process.platform !== "win32") {
        if ((Number(before.mode) & 0o077) !== 0 || (Number(before.uid) !== 0 && Number(before.uid) !== process.getuid?.())) throw new CareerOperatorConfigError("operator_config_permissions_untrusted");
      } else if (!options.reviewWindowsAcl) throw new CareerOperatorConfigError("operator_windows_acl_review_required");
      const bytes = Buffer.alloc(256_001); let length = 0;
      while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (length > 256_000 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new CareerOperatorConfigError("operator_config_changed_during_read");
      const content = bytes.subarray(0, length), fileHash = digest(content);
      if (process.platform === "win32" && !await options.reviewWindowsAcl!({ canonicalPath, fileHash })) throw new CareerOperatorConfigError("operator_windows_acl_untrusted");
      const value = CareerOperatorConfigSchema.parse(JSON.parse(content.toString("utf8")));
      return { value, hash: fileHash };
    } catch (error) { if (error instanceof CareerOperatorConfigError) throw error; throw new CareerOperatorConfigError("operator_config_unavailable_or_invalid"); }
    finally { await handle?.close().catch(() => undefined); }
  }
  const initial = await readConfiguration(), configuration = initial.value;
  if (options.expectedConfigHash && options.expectedConfigHash !== initial.hash) throw new CareerOperatorConfigError("operator_config_hash_mismatch");
  if (new Set(configuration.mcpServers.map(item => item.id)).size !== configuration.mcpServers.length) throw new CareerOperatorConfigError("operator_duplicate_server_id");
  const reviewedFiles = new Map<string, { signature: string; hash: string }>();
  async function verifyFile(selected: string, expectedHash: string, executable = false): Promise<string> {
    try {
      const canonical = await fs.realpath(selected), stat = await fs.stat(canonical, { bigint: true });
      if (!stat.isFile() || stat.size > 512_000_000n || (executable && shell.test(path.basename(canonical)))) throw new CareerOperatorConfigError("operator_artifact_not_reviewed_file");
      if (process.platform !== "win32" && ((Number(stat.mode) & 0o022) !== 0 || (Number(stat.uid) !== 0 && Number(stat.uid) !== process.getuid?.()) || (executable && !(Number(stat.mode) & 0o111)))) throw new CareerOperatorConfigError("operator_artifact_permissions_untrusted");
      const signature = [canonical, stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.mtimeNs, stat.ctimeNs].join(":");
      let actual = reviewedFiles.get(selected);
      if (actual?.signature !== signature) { actual = { signature, hash: digest(await fs.readFile(canonical)) }; reviewedFiles.set(selected, actual); }
      if (actual.hash !== expectedHash) throw new CareerOperatorConfigError("operator_artifact_hash_mismatch");
      if (process.platform === "win32" && (!options.reviewWindowsAcl || !await options.reviewWindowsAcl({ canonicalPath: canonical, fileHash: actual.hash }))) throw new CareerOperatorConfigError("operator_windows_acl_untrusted");
      return canonical;
    } catch (error) { if (error instanceof CareerOperatorConfigError) throw error; throw new CareerOperatorConfigError("operator_artifact_unavailable"); }
  }
  async function verifyArtifacts() {
    for (const registered of configuration.mcpServers) {
      const spec = registered.server;
      if (new Set(spec.allowedTools).size !== spec.allowedTools.length || new Set(spec.allowedResources).size !== spec.allowedResources.length) throw new CareerOperatorConfigError("operator_duplicate_mcp_scope");
      if (spec.transport.kind === "streamable-http") {
        const url = new URL(spec.transport.endpoint);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new CareerOperatorConfigError("operator_mcp_endpoint_untrusted");
      } else {
        if (shell.test(path.basename(spec.transport.spec.command))) throw new CareerOperatorConfigError("operator_shell_not_allowed");
        await verifyFile(spec.transport.spec.command, spec.transport.spec.executableHash, true);
        for (const artifact of spec.transport.spec.artifacts) await verifyFile(artifact.path, artifact.hash);
        for (const selected of spec.transport.spec.allowedReadPaths) {
          let canonical: string; try { canonical = await fs.realpath(selected); } catch { throw new CareerOperatorConfigError("operator_read_scope_unavailable"); }
          if ([path.parse(canonical).root, os.homedir(), "/Users", "/home", os.tmpdir(), "/private/tmp"].includes(canonical)) throw new CareerOperatorConfigError("operator_read_scope_too_broad");
        }
      }
    }
    if (configuration.vork) await verifyFile(configuration.vork.binaryPath, configuration.vork.sha256, true);
  }
  await verifyArtifacts();
  async function assertCurrent(): Promise<void> {
    if (closed) throw new CareerOperatorConfigError("operator_configuration_closed");
    if ((await readConfiguration()).hash !== initial.hash) throw new CareerOperatorConfigError("operator_configuration_changed_reload_required");
    await verifyArtifacts();
    if (closed) throw new CareerOperatorConfigError("operator_configuration_closed");
  }
  let pinnedProvider: CloudRuntimeBinding | undefined;
  async function provider() {
    await assertCurrent();
    if (!configuration.privacyCloud || !options.resolvePrivacyProvider) throw new PrivacyError("operator_cloud_not_configured");
    let adapter: CloudPrivacyAdapter | undefined, binding: CloudRuntimeBinding;
    try {
      adapter = await options.resolvePrivacyProvider({ providerId: configuration.privacyCloud.providerId, configRevision: configuration.revision, configHash: initial.hash });
      if (!adapter) throw new PrivacyError("operator_cloud_provider_unavailable");
      const source = CloudRuntimeBindingSchema.parse(await adapter.binding()), url = new URL(source.recipientOrigin);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new PrivacyError("operator_cloud_recipient_untrusted");
      binding = { ...source, version: `operator-${privacyDigest({ configHash: initial.hash, providerId: configuration.privacyCloud.providerId, runtime: source })}` };
    } catch (error) { if (error instanceof PrivacyError) throw error; throw new PrivacyError("operator_cloud_provider_unavailable"); }
    await assertCurrent();
    if (pinnedProvider && privacyRuntimeFingerprint(binding) !== privacyRuntimeFingerprint(pinnedProvider)) throw new PrivacyError("operator_cloud_binding_changed");
    pinnedProvider ??= binding;
    return { adapter, binding };
  }
  const configuredCloud: CloudPrivacyAdapter | undefined = configuration.privacyCloud && options.resolvePrivacyProvider ? {
    binding: async () => structuredClone((await provider()).binding),
    async dispatch(input, signal) {
      if (signal.aborted) throw new PrivacyError("privacy_cancelled");
      let safe: z.infer<typeof envelope>;
      try { safe = envelope.parse(input); } catch { throw new PrivacyError("operator_cloud_approved_summary_required"); }
      if (Buffer.byteLength(JSON.stringify(safe)) > 256_000 || Object.values(safe.summary).some(text => disclosureViolations(text).length)) throw new PrivacyError("operator_cloud_unsafe_summary");
      const resolved = await provider();
      if (safe.model !== resolved.binding.model || signal.aborted) throw new PrivacyError("operator_cloud_binding_or_cancellation_changed");
      let output: unknown;
      try { output = await resolved.adapter.dispatch(safe, signal); } catch { throw new PrivacyError(signal.aborted ? "privacy_cancelled" : "operator_cloud_dispatch_failed"); }
      await provider();
      if (signal.aborted) throw new PrivacyError("privacy_cancelled");
      return output;
    },
  } : undefined;
  return {
    revision: configuration.revision, configHash: initial.hash, configured: supplied !== undefined, configuredCloud,
    status: { mcpServerCount: configuration.mcpServers.length, cloudReferenced: !!configuration.privacyCloud, cloudAdapterAvailable: !!configuredCloud, vorkConfigured: !!configuration.vork },
    assertCurrent,
    async getMcpServers(): Promise<ConfiguredCareerMcpServer[]> { await assertCurrent(); return structuredClone(configuration.mcpServers); },
    async getVorkBinary(): Promise<string | undefined> { await assertCurrent(); return configuration.vork ? verifyFile(configuration.vork.binaryPath, configuration.vork.sha256, true) : undefined; },
    /** Invoke from Host logout/remount; no operation is retried or migrated. */
    close(): void { closed = true; },
  };
}
