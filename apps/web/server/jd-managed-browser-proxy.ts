import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);
const PROXY = "http://127.0.0.1:17891";
const CONFIG_SHA = "ab39c59d8efe8669239223e227225fed3481c006172ec27762f1106e9704caac";
// Derived from the sole executable in the official v1.19.32 archive whose pinned
// SHA256 is 974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0.
const EXE_SHA = "04f8d7fc2b314771e1ecbf15951d59f0e1cb7914503c88cfb6972ff6a824e314";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const samePath = (first: string, second: string) => path.win32.resolve(first).toLowerCase() === path.win32.resolve(second).toLowerCase();
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;

export type ManagedProxyEvidence = {
  config: Uint8Array; configModifiedAt: number; state: unknown; manifest: unknown;
  executableSha256: string; identity: string;
};
export type ManagedProxyMachine = {
  process?: { processId: number; createdAt: string; executable: string; command: string };
  listeners: Array<{ processId: number; address: string; port: number }>;
};
export type ManagedProxyVerifierOptions = {
  rootDirectory?: string;
  readEvidence?: () => Promise<ManagedProxyEvidence>;
  readMachine?: (processId: number) => Promise<ManagedProxyMachine>;
};

/** Read-only, fail-closed attestation of this repository's one already-managed helper.
 * It never probes a proxy, executes the helper, writes files, or changes networking.
 * The helper has no hot-reload/controller: this checks startup ownership and the
 * unchanged on-disk startup configuration, not the helper's private memory.
 */
export function createManagedDomesticBrowserProxyVerifier(options: ManagedProxyVerifierOptions = {}) {
  const root = path.resolve(options.rootDirectory ?? path.join(import.meta.dirname, "../../.."));
  const directory = path.join(root, "data/domestic-route");
  const executable = path.join(directory, "mihomo-windows-amd64-compatible.exe");
  const configuration = path.join(directory, "config.yaml");
  const processFile = path.join(directory, "process.json");
  const manifestFile = path.join(directory, "candidates/20261018T002530801Z-51job-verification-tenant-verify/manifest.json");
  let executableCache: { identity: string; hash: string } | undefined;
  const fileIdentity = async (file: string) => {
    const value = await stat(file, { bigint: true });
    if (!value.isFile()) throw new Error("invalid file");
    return { identity: [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs].join("/"), size: Number(value.size), modified: Number(value.mtimeMs) };
  };
  const smallFile = async (file: string) => {
    const before = await fileIdentity(file);
    if (before.size < 1 || before.size > 8192) throw new Error("invalid file");
    const bytes = await readFile(file);
    const after = await fileIdentity(file);
    if (before.identity !== after.identity || bytes.length !== before.size) throw new Error("file changed");
    return { bytes, ...after };
  };
  const readEvidence = options.readEvidence ?? (async (): Promise<ManagedProxyEvidence> => {
    const before = await fileIdentity(executable);
    if (before.size !== 61_276_672) throw new Error("invalid executable");
    if (executableCache?.identity !== before.identity) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(executable)) hash.update(chunk as Buffer);
      if ((await fileIdentity(executable)).identity !== before.identity) throw new Error("executable changed");
      executableCache = { identity: before.identity, hash: hash.digest("hex") };
    }
    const [config, state, manifest] = await Promise.all([smallFile(configuration), smallFile(processFile), smallFile(manifestFile)]);
    return {
      config: config.bytes, configModifiedAt: config.modified,
      state: JSON.parse(state.bytes.toString("utf8")) as unknown,
      manifest: JSON.parse(manifest.bytes.toString("utf8")) as unknown,
      executableSha256: executableCache.hash,
      identity: [before.identity, config.identity, state.identity, manifest.identity].join("|"),
    };
  });
  const readMachine = options.readMachine ?? (async (processId: number): Promise<ManagedProxyMachine> => {
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId}';if($p){[pscustomobject]@{processId=[int]$p.ProcessId;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress}else{'null'}`;
    // netstat avoids the much slower Get-NetTCPConnection enumeration. Both
    // commands are read-only; only this recorded process's metadata is queried.
    const [processResult, listenerResult] = await Promise.all([
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000, maxBuffer: 16_384 }),
      exec("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }),
    ]);
    const listeners: ManagedProxyMachine["listeners"] = [];
    for (const line of listenerResult.stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 5 || fields[0] !== "TCP" || fields[3] !== "LISTENING") continue;
      const endpoint = fields[1].match(/^(.*):17891$/);
      if (endpoint) listeners.push({ processId: Number(fields[4]), address: endpoint[1], port: 17891 });
    }
    const process = JSON.parse(processResult.stdout.trim()) as ManagedProxyMachine["process"] | null;
    return { ...(process ? { process } : {}), listeners };
  });
  return async function verify(proxyUrl: string | undefined): Promise<boolean> {
    if (proxyUrl !== PROXY || (!options.readMachine && process.platform !== "win32")) return false;
    try {
      const before = await readEvidence();
      const state = object(before.state), manifest = object(before.manifest);
      if (!state || !manifest || sha(before.config) !== CONFIG_SHA || before.executableSha256 !== EXE_SHA) return false;
      // The pinned bytes include the complete existing allow rules, final
      // MATCH,REJECT, loopback-only binding, disabled TUN/controller, and DNS.
      // Any extra bypass, domain, port, rule provider or changed setting fails.
      if (!Number.isSafeInteger(state.processId) || Number(state.processId) <= 0 || state.port !== 17891
        || state.interfaceName !== "WLAN" || state.interfaceIndex !== 14
        || manifest.candidateSha256 !== CONFIG_SHA || manifest.activeProcessId !== state.processId
        || manifest.engineValidation !== "passed_exit_0" || manifest.activeConfigurationChanged !== true) return false;
      const machine = await readMachine(Number(state.processId));
      const owned = machine.process;
      if (!owned || owned.processId !== state.processId || !samePath(owned.executable, executable)
        || machine.listeners.length !== 1 || machine.listeners[0].processId !== state.processId
        || machine.listeners[0].address !== "127.0.0.1" || machine.listeners[0].port !== 17891) return false;
      // Match the exact canonical command generated by domestic-route.ps1;
      // extra arguments, a different working directory or config are refused.
      const args = owned.command.match(/^"([^"\r\n]+)" -d "([^"\r\n]+)" -f "([^"\r\n]+)"\s*$/);
      if (!args || !samePath(args[1], executable) || !samePath(args[2], directory) || !samePath(args[3], configuration)) return false;
      const created = timestamp(owned.createdAt), started = timestamp(state.startedAt);
      const manifestCreated = timestamp(manifest.createdAt), activated = timestamp(manifest.activatedAt);
      if (![created, started, manifestCreated, activated, before.configModifiedAt].every(Number.isFinite)
        || created > started || started - created > 15_000 || before.configModifiedAt > created
        || manifestCreated > created || activated < started) return false;
      const after = await readEvidence();
      return before.identity === after.identity && sha(after.config) === CONFIG_SHA
        && after.executableSha256 === EXE_SHA && JSON.stringify(before.state) === JSON.stringify(after.state)
        && JSON.stringify(before.manifest) === JSON.stringify(after.manifest);
    } catch { return false; }
  };
}

export const verifyManagedDomesticBrowserProxy = createManagedDomesticBrowserProxyVerifier();
