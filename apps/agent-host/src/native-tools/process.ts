import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export class NativeToolError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code); }
}
export type NativeProcessInput = {
  command: string; args: string[]; directory: string; environment?: Record<string, string>;
  hosts: string[]; stdin?: string; signal?: AbortSignal; timeoutMs?: number;
  onOutput?: (chunk: string) => void;
  /** Device login only: parsed in memory, never returned as diagnostics. */
  onControlOutput?: (chunk: string) => void;
  /** Trusted login adapter only. No HTTP caller can set sandbox capabilities. */
  loopbackLoginListener?: boolean;
  /** Trusted Codex adapter only: read its managed-policy preference domain. */
  codexManagedPreferences?: boolean;
  onStdinReady?: (write: (text: string) => void) => void;
};
/** Trusted test/embedding seam. No part of this interface is accepted from HTTP. */
export interface NativeProcessRunner {
  isolation(): Promise<boolean>;
  run(input: NativeProcessInput): Promise<string>;
}
const quote = (value: string) => JSON.stringify(value);
const execFileAsync = promisify(execFile);
const libraries = new Map<string, Promise<string[]>>();

function dynamicLibraries(binary: string): Promise<string[]> {
  let cached = libraries.get(binary);
  if (cached) return cached;
  cached = (async () => {
    const found = new Set<string>(), queue = [binary];
    while (queue.length && found.size < 180) {
      const current = queue.shift()!;
      const output = await execFileAsync("/usr/bin/otool", ["-L", current], { timeout: 3000, maxBuffer: 100_000 })
        .then(result => result.stdout).catch(() => "");
      for (const line of output.split("\n").slice(1)) {
        let dependency: string | undefined = line.trim().split(" (")[0];
        if (!dependency || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/")) continue;
        if (dependency.startsWith("@")) {
          const relative = dependency.replace(/^@(?:rpath|loader_path|executable_path)\//, "");
          const candidates = [path.resolve(path.dirname(current), relative), path.resolve(path.dirname(binary), "../lib", relative)];
          dependency = undefined;
          for (const candidate of candidates) if (await fs.access(candidate).then(() => true).catch(() => false)) { dependency = candidate; break; }
        }
        if (!dependency || !path.isAbsolute(dependency) || !/\.dylib$/.test(dependency)) continue;
        const real = await fs.realpath(dependency).catch(() => dependency!);
        if (!found.has(real)) { found.add(dependency); found.add(real); queue.push(real); }
      }
    }
    return [...found];
  })();
  libraries.set(binary, cached); return cached;
}

export function nativeEnvironment(directory: string): Record<string, string> {
  // Deliberately not process.env: no shared credentials, startup hooks, proxies,
  // NODE_OPTIONS, keychain helpers, telemetry exporters or parent auth homes.
  return {
    PATH: "/usr/bin:/bin", HOME: directory, USERPROFILE: directory, CFFIXED_USER_HOME: directory,
    CODEX_HOME: path.join(directory, "codex"), CODEX_SQLITE_HOME: path.join(directory, "codex"),
    CLAUDE_CONFIG_DIR: path.join(directory, "claude"), CLAUDE_CODE_TMPDIR: path.join(directory, "tmp"), GEMINI_CLI_HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state"),
    TMPDIR: path.join(directory, "tmp"), TMP: path.join(directory, "tmp"), TEMP: path.join(directory, "tmp"),
    LANG: "en_US.UTF-8", NO_COLOR: "1", CI: "1", DO_NOT_TRACK: "1", OPENSSL_CONF: "/dev/null",
    // The sandbox already permits this public OS bundle. Make CA discovery
    // explicit without importing owner keychains or disabling TLS validation.
    ...(process.platform === "darwin" ? { SSL_CERT_FILE: "/private/etc/ssl/cert.pem" } : {}),
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    OTEL_SDK_DISABLED: "true", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOCOMPACT: "true",
    GEMINI_CLI_NO_RELAUNCH: "1", GEMINI_TELEMETRY_ENABLED: "false",
    NODE_USE_ENV_PROXY: "1",
  };
}

export async function executablePlan(command: string) {
  const resolved = await fs.realpath(command);
  const handle = await fs.open(resolved, "r");
  const bytes = Buffer.alloc(180);
  try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
  const isNode = /^#![^\n]*\bnode\b/.test(bytes.toString());
  const interpreter = await fs.realpath(process.execPath);
  // Only installation code, never the host home, /tmp, /Library or an owner root.
  const formula = resolved.match(/^(\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+)\//)?.[1];
  const npm = resolved.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
  const code = formula ?? npm ?? resolved;
  const nodeFormula = interpreter.match(/^(\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+)\//)?.[1];
  // dyld follows both Homebrew's opt symlink and versioned dylib links. Grant
  // their installation package, not global metadata or the whole Homebrew tree.
  const dependencyCode = (await dynamicLibraries(isNode ? interpreter : resolved)).map(dependency =>
    dependency.match(/^(\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+)\//)?.[1]
      ?? dependency.match(/^(\/opt\/homebrew\/opt\/[^/]+)\//)?.[1] ?? dependency);
  return { command: isNode ? interpreter : resolved, prefix: isNode ? [resolved] : [],
    readable: [...new Set([code, interpreter, ...(nodeFormula ? [nodeFormula] : []), ...dependencyCode])] };
}

export function nativeSandboxProfile(directory: string, readable: string[], proxyPort: number, loopbackLoginListener = false, codexManagedPreferences = false): string {
  const roots = [directory, "/System/Library", "/System/Cryptexes/OS/System", "/System/Cryptexes/App/System",
    "/System/Volumes/Preboot/Cryptexes/OS/System", "/System/Volumes/Preboot/Cryptexes/App/System",
    "/usr/lib", "/usr/share", "/usr/bin", "/bin", ...readable];
  const ancestors = new Set(["/", "/etc", "/tmp", "/var", "/private/etc", "/dev"]);
  for (const root of roots) for (let parent = path.dirname(root); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  return ["(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)",
    "(allow process-info* (target self))", "(allow signal (target self))", "(allow sysctl-read)",
    // dyld/Node need to stat code-path ancestors, not every private file on the
    // machine. Ancestor metadata grants do not allow enumerating directories.
    ...[...ancestors].map(value => `(allow file-read-metadata (literal ${quote(value)}))`),
    // Never allow /System wholesale: /System/Volumes/Data is an alternate path
    // to user data. Only immutable system runtime/framework locations belong here.
    ...roots
      .map(value => `(allow file-read* (subpath ${quote(value)}))`),
    ...["/", "/dev/null", "/dev/urandom", "/dev/random", "/private/etc/localtime", "/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/ssl/cert.pem"]
      .map(value => `(allow file-read* (literal ${quote(value)}))`),
    `(allow file-write* (subpath ${quote(directory)}))`, "(allow file-write* (literal \"/dev/null\"))",
    "(allow mach-lookup (global-name \"com.apple.trustd.agent\") (global-name \"com.apple.trustd\") (global-name \"com.apple.system.logger\"))",
    // CFPreferencesAppSynchronize must succeed before Codex loads forced MDM
    // requirements. These exact read-only generation counters are not a grant
    // to read other preference domains, write defaults, or read host files.
    ...(codexManagedPreferences ? [
      '(allow user-preference-read (preference-domain "com.openai.codex"))',
      '(allow mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))',
      `(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata (ipc-posix-name "apple.cfprefs.${os.userInfo().uid}v1") (ipc-posix-name "apple.cfprefs.daemonv1"))`,
    ] : []),
    ...(proxyPort ? [`(allow network-outbound (remote tcp "localhost:${proxyPort}"))`] : []),
    // Claude's official OAuth CLI binds an ephemeral IPv4 loopback listener even
    // for its manual-code flow. Login only; no LAN listener, outbound loopback,
    // shared filesystem, keychain or generic-run permission is added.
    ...(loopbackLoginListener ? ['(allow network-bind (local tcp "localhost:*"))', '(allow network-inbound (local tcp "localhost:*"))'] : []),
  ].join("\n");
}

export function isPublicProviderAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    const third = Number(address.split(".")[2]);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 && (third === 0 || third === 2)))
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19 || b === 51 && third === 100))
      && !(a === 203 && b === 0 && third === 113);
  }
  // Require global-unicast IPv6; reject translated/tunnel address mechanisms
  // that could smuggle a private IPv4 target through an apparently public AAAA.
  if (net.isIP(address) !== 6) return false;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return /^[23][0-9a-f]{3}:/i.test(canonical)
    && !/^2002:/i.test(canonical) && !/^2001:(?:0:|:|db8:|2:)/i.test(canonical);
}

/** The child can reach only this short-lived proxy, not other local services.
 * CONNECT destinations are exact HTTPS provider hosts; no arbitrary proxying,
 * redirects to LAN, DNS rebinding, cookies or credentials from another run. */
type ProviderConnector = (host: string) => Promise<net.Socket>;
async function providerProxy(hosts: string[], connector?: ProviderConnector) {
  const token = randomBytes(32).toString("hex");
  const authorization = `Basic ${Buffer.from(`betterme:${token}`).toString("base64")}`;
  const allowed = new Set(hosts.map(host => host.toLowerCase()));
  const sockets = new Set<net.Socket>();
  let closed = false;
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  server.on("connect", (req, client, head) => {
    const denied = () => { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); };
    const match = req.url?.match(/^([a-z0-9.-]+):443$/i);
    if (req.headers["proxy-authorization"] !== authorization || !match || !allowed.has(match[1]!.toLowerCase())) { denied(); return; }
    void (async () => {
      let upstream: net.Socket;
      if (connector) upstream = await connector(match[1]!);
      else {
        const addresses = await dns.lookup(match[1]!, { all: true });
        if (!addresses.length || addresses.some(item => !isPublicProviderAddress(item.address)) || closed || client.destroyed) { denied(); return; }
        upstream = net.connect({ host: addresses[0]!.address, port: 443 });
      }
      if (closed || client.destroyed) { upstream.destroy(); return; }
      sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
      upstream.setTimeout(120_000, () => upstream.destroy());
      const connected = () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      };
      if (upstream.connecting) upstream.once("connect", connected); else connected();
      client.on("close", () => upstream.destroy());
    })().catch(denied);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => socket.destroy()); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new NativeToolError("sandbox_unavailable");
  return { port: address.port, url: `http://betterme:${token}@127.0.0.1:${address.port}`,
    async close() { closed = true; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function execute(input: NativeProcessInput, command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: input.directory, env: environment, shell: false, detached: true, stdio: "pipe" });
    let output = "", size = 0, issue: unknown, diagnosticTail = "", managedPolicyFailed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already exited */ } };
    const stop = (error: unknown) => {
      if (issue) return; issue = error; kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 250); force.unref();
    };
    const abort = () => stop(new NativeToolError("cancelled", 409));
    const timer = setTimeout(() => stop(new NativeToolError("timeout", 408)), input.timeoutMs ?? 120_000); timer.unref();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2_000_000) { stop(new NativeToolError("output_limit")); return; }
      output += chunk;
      try { input.onOutput?.(chunk); input.onControlOutput?.(chunk); } catch { stop(new NativeToolError("protocol_violation")); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length; if (size > 2_000_000) stop(new NativeToolError("output_limit"));
      diagnosticTail = (diagnosticTail + chunk.toString("utf8")).slice(-2000);
      if (diagnosticTail.includes("Failed to synchronize managed preferences")) managedPolicyFailed = true;
      try { input.onControlOutput?.(chunk.toString("utf8")); } catch { stop(new NativeToolError("protocol_violation")); }
    });
    child.stdin.on("error", () => stop(new NativeToolError("process_failed")));
    child.once("error", () => stop(new NativeToolError("process_failed")));
    child.once("close", (code, signal) => {
      kill("SIGKILL"); // also stop helpers that inherited the CLI's process group
      clearTimeout(timer); if (force) clearTimeout(force); input.signal?.removeEventListener("abort", abort);
      // Never return stderr or attach provider/process errors to persistent state.
      diagnosticTail = "";
      if (issue) reject(issue);
      else if (managedPolicyFailed) reject(new NativeToolError("managed_policy_unavailable"));
      else if (signal) reject(new NativeToolError("runtime_terminated"));
      else if (code !== 0) reject(new NativeToolError("process_failed")); else resolve(output);
    });
    if (input.onStdinReady) input.onStdinReady(text => { if (!issue && !child.stdin.destroyed) child.stdin.write(text); });
    else child.stdin.end(input.stdin ?? "");
  });
}

export class IsolatedNativeProcess implements NativeProcessRunner {
  /** Trusted in-process acceptance seam only. Still enforces the same OS sandbox,
   * per-run proxy authentication and exact provider-host allowlist. Never exposed
   * from HTTP or installation settings; production always performs public DNS validation. */
  constructor(private readonly acceptance?: { connectProvider?: ProviderConnector }) {}
  private checked?: Promise<boolean>;
  isolation(): Promise<boolean> {
    return this.checked ??= this.check();
  }
  private async check(): Promise<boolean> {
    if (process.platform !== "darwin") return false; // fail closed; no pretend cross-platform sandbox
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-native-isolation-"));
    const own = path.join(root, "own"), other = path.join(root, "other");
    await fs.mkdir(own, { mode: 0o700 }); await fs.writeFile(other, "synthetic-other-account", { mode: 0o600 });
    try {
      const aliases = [other];
      const dataAlias = `/System/Volumes/Data${await fs.realpath(other)}`;
      if (await fs.access(dataAlias).then(() => true).catch(() => false)) aliases.push(dataAlias);
      await fs.symlink(other, path.join(own, "linked-other")); aliases.push(path.join(own, "linked-other"));
      const script = "const f=require('node:fs');for(const p of process.argv.slice(1)){let denied=false;try{f.readFileSync(p)}catch{denied=true}if(!denied)process.exit(9)}f.writeFileSync('allowed','ok');";
      await this.launch({ command: process.execPath, args: ["-e", script, ...aliases], directory: own, hosts: [], timeoutMs: 5000 });
      return await fs.readFile(path.join(own, "allowed"), "utf8") === "ok";
    } catch { return false; } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  async run(input: NativeProcessInput): Promise<string> {
    if (!await this.isolation()) throw new NativeToolError("sandbox_unavailable");
    return this.launch(input);
  }
  private async launch(input: NativeProcessInput): Promise<string> {
    input.signal?.throwIfAborted();
    const directory = await fs.realpath(input.directory);
    const plan = await executablePlan(input.command);
    for (const name of ["tmp", "config", "cache", "data", "state", "codex", "claude", ".gemini"]) {
      await fs.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    }
    const proxy = await providerProxy(input.hosts, this.acceptance?.connectProvider);
    try {
      const environment = { ...nativeEnvironment(directory), ...input.environment,
        HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, NO_PROXY: "" };
      return await execute({ ...input, directory }, "/usr/bin/sandbox-exec",
        ["-p", nativeSandboxProfile(directory, plan.readable, proxy.port, input.loopbackLoginListener, input.codexManagedPreferences), plan.command, ...plan.prefix, ...input.args], environment);
    } finally { await proxy.close(); }
  }
}
