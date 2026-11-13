import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createSandboxPlan } from "../runs/sandbox.js";
import { privacyDigest } from "../privacy/content-guard.js";
import { CareerMcpError } from "./grants.js";

export type ReviewedStdioSpec = {
  command: string; args: string[]; executableHash: string;
  /** Full reviewed server entrypoint/installation artifact manifest. System
   * runtime libraries can instead be explicitly listed in allowedReadPaths. */
  artifacts: { path: string; hash: string }[];
  allowedReadPaths: string[];
};
export const reviewedStdioHash = (spec: ReviewedStdioSpec): string => privacyDigest(spec);
const digestFile = async (target: string) => createHash("sha256").update(await fs.readFile(target)).digest("hex");
const profileLiteral = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Official stdio transport behind a mandatory OS sandbox. No model-controlled
 * command expansion, inherited credentials, shell, networking or broad home
 * reads. No supported OS sandbox means UNAVAILABLE, never process-only fallback.
 * OS sandbox is not a semantic guarantee that an MCP tool is safe; tool calls
 * still require the separate manifest/toolset/input authorization gates. */
export async function createReviewedStdioTransport(input: { spec: ReviewedStdioSpec; approvedSpecHash: string; maxMessageBytes?: number }): Promise<{ transport: Transport; isolation: "os-sandbox"; provider: string; close(): Promise<void> }> {
  const spec = structuredClone(input.spec), maxBytes = input.maxMessageBytes ?? 64_000;
  if (reviewedStdioHash(spec) !== input.approvedSpecHash || !path.isAbsolute(spec.command) || /^(?:ba|z|fi|k|c)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(path.basename(spec.command)) || spec.args.length > 100 || spec.args.some(arg => typeof arg !== "string" || arg.length > 4000 || arg.includes("\0") || /[\r\n]/.test(arg)) || !/^[a-f0-9]{64}$/.test(spec.executableHash) || !spec.artifacts.length || spec.artifacts.length > 200 || spec.allowedReadPaths.length > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256_000) throw new CareerMcpError("mcp_stdio_review_invalid");
  let command: string, reads: string[];
  try {
    command = await fs.realpath(spec.command);
    if (/^(?:ba|z|fi|k|c)?sh(?:\.exe)?$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(path.basename(command))) throw new Error();
    if (await digestFile(command) !== spec.executableHash) throw new Error();
    for (const artifact of spec.artifacts) if (!path.isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.hash) || await digestFile(await fs.realpath(artifact.path)) !== artifact.hash) throw new Error();
    reads = [...new Set((await Promise.all([...spec.allowedReadPaths, ...spec.artifacts.map(artifact => artifact.path), command].map(async selected => {
      if (!path.isAbsolute(selected)) throw new Error();
      const real = await fs.realpath(selected);
      // Explicit files/subtrees, never a root/home/workspace-wide implicit grant.
      if (real === path.parse(real).root || real === os.homedir() || real === "/Users" || real === "/home" || real === os.tmpdir() || real === "/private/tmp") throw new Error();
      // Dynamic loaders may open a reviewed symlink spelling before the real
      // path. Both remain scoped to this explicitly selected subtree/file.
      return [path.resolve(selected), real];
    }))).flat())];
  } catch { throw new CareerMcpError("mcp_stdio_artifact_changed_or_scope_invalid"); }
  const runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-mcp-"));
  const cleanup = async () => fs.rm(runDirectory, { recursive: true, force: true });
  try {
    await fs.mkdir(path.join(runDirectory, "input"), { mode: 0o700 });
    const env: Record<string, string> = { HOME: runDirectory, LOGNAME: "mcp", USER: "mcp", SHELL: "", TERM: "dumb", PATH: "/usr/bin:/bin", TMPDIR: runDirectory, LANG: "C.UTF-8", OPENSSL_CONF: "/dev/null" };
    const plan = await createSandboxPlan({ command, args: spec.args, cwd: runDirectory, runDirectory, allowedReadPaths: reads, mode: "required", env });
    if (plan.isolation !== "os-sandbox") throw new CareerMcpError("mcp_os_sandbox_unavailable");
    let args = plan.args;
    if (plan.provider === "macos-sandbox-exec" && plan.profilePath) {
      // Do not allow all /System (whose Data volume aliases user files), all
      // /Library (third-party app data), or /usr/local configuration by default.
      const readable = [...new Set([runDirectory, ...reads, "/System/Library", "/System/Cryptexes", "/System/Volumes/Preboot", "/usr/lib", "/usr/share", "/usr/bin", "/usr/libexec", "/bin", "/sbin", "/dev"])];
      const ancestors = new Set<string>();
      for (const selected of readable) { let parent = path.dirname(selected); for (;;) { ancestors.add(parent); if (parent === path.dirname(parent)) break; parent = path.dirname(parent); } }
      const profile = ["(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)", ...[...ancestors].map(selected => `(allow file-read* (literal "${profileLiteral(selected)}"))`), ...readable.map(selected => `(allow file-read* (subpath "${profileLiteral(selected)}"))`), `(allow file-write* (subpath "${profileLiteral(runDirectory)}"))`, '(allow file-write* (subpath "/dev"))', "(deny network*)"].join("\n");
      // Tighten the shared plan before any process starts (it otherwise permits
      // outbound networking and all of /private/tmp for general run workloads).
      await fs.writeFile(plan.profilePath, `${profile}\n`, { mode: 0o600 });
    } else if (plan.provider === "linux-bubblewrap") {
      const system = [];
      for (const candidate of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) if (await fs.stat(candidate).then(() => true, () => false)) system.push(candidate);
      args = ["--die-with-parent", "--new-session", "--unshare-all", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", ...[...new Set([...system, ...reads])].flatMap(selected => ["--ro-bind", selected, selected]), "--bind", runDirectory, runDirectory, "--chdir", runDirectory, "--", command, ...spec.args];
    } else throw new CareerMcpError("mcp_os_sandbox_unavailable");
    const transport = new StdioClientTransport({ command: plan.command, args, cwd: runDirectory, env, stderr: "ignore", maxBufferSize: maxBytes });
    let closed = false;
    return { transport, isolation: "os-sandbox", provider: plan.provider, close: async () => { if (closed) return; closed = true; try { await transport.close(); } finally { await cleanup(); } } };
  } catch (error) {
    await cleanup();
    if (error instanceof CareerMcpError) throw error;
    throw new CareerMcpError("mcp_os_sandbox_unavailable");
  }
}
