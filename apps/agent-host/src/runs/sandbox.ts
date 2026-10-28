import fs from "node:fs/promises";
import path from "node:path";
import type { RunIsolation } from "@better-me/agent-contracts";

export type SandboxMode = "auto" | "required" | "disabled";
export type SandboxProvider = "macos-sandbox-exec" | "linux-bubblewrap" | "none";

export interface SandboxPlan {
  command: string;
  args: string[];
  isolation: RunIsolation;
  provider: SandboxProvider;
  detail: string;
  profilePath?: string;
}

export interface SandboxPlanInput {
  command: string;
  args: string[];
  cwd: string;
  runDirectory: string;
  allowedReadPaths: string[];
  mode?: SandboxMode;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

async function executable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (path.isAbsolute(command)) {
    try {
      await fs.access(command);
      return command;
    } catch {
      return undefined;
    }
  }
  for (const directory of (env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  return undefined;
}

function profilePathLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function macosPlan(input: SandboxPlanInput, sandboxExecutable: string): Promise<SandboxPlan> {
  const runDirectory = await fs.realpath(input.runDirectory).catch(() => path.resolve(input.runDirectory));
  const commandPath = await fs.realpath(input.command).catch(() => path.resolve(input.command));
  const readable = [...new Set([
    runDirectory,
    ...input.allowedReadPaths,
    path.dirname(commandPath),
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/dev",
    "/private/tmp",
  ])];
  const readRules = readable.map((item) => `(allow file-read* (subpath "${profilePathLiteral(item)}"))`).join("\n");
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    readRules,
    `(allow file-write* (subpath "${profilePathLiteral(runDirectory)}"))`,
    "(allow file-write* (subpath \"/dev\"))",
    "(allow file-write* (subpath \"/private/tmp\"))",
    "(allow network-outbound)",
  ].join("\n");
  const profilePath = path.join(input.runDirectory, "input", "sandbox.sb");
  await fs.writeFile(profilePath, `${profile}\n`, { mode: 0o600 });
  return {
    command: sandboxExecutable,
    args: ["-f", profilePath, input.command, ...input.args],
    isolation: "os-sandbox",
    provider: "macos-sandbox-exec",
    detail: "macOS sandbox-exec: writes limited to the run directory; reads limited to declared paths and runtime system paths",
    profilePath,
  };
}

async function linuxPlan(input: SandboxPlanInput, bubblewrapExecutable: string): Promise<SandboxPlan> {
  const bindArgs = input.allowedReadPaths.flatMap((item) => ["--ro-bind", item, item]);
  return {
    command: bubblewrapExecutable,
    args: [
      "--die-with-parent",
      "--new-session",
      "--ro-bind", "/", "/",
      "--bind", input.runDirectory, input.runDirectory,
      ...bindArgs,
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--chdir", input.cwd,
      "--",
      input.command,
      ...input.args,
    ],
    isolation: "os-sandbox",
    provider: "linux-bubblewrap",
    detail: "bubblewrap: root filesystem read-only; run directory is the only writable project mount",
  };
}

/**
 * Build a shell-free launch plan. `auto` deliberately falls back to process
 * isolation unless BETTER_ME_ENABLE_OS_SANDBOX=1, so an installation is never
 * silently treated as a production permission boundary.
 */
export async function createSandboxPlan(input: SandboxPlanInput): Promise<SandboxPlan> {
  const mode = input.mode ?? "auto";
  if (mode === "disabled") {
    return { command: input.command, args: [...input.args], isolation: "none", provider: "none", detail: "OS sandbox disabled by request" };
  }

  const env = input.env ?? process.env;
  const optIn = env["BETTER_ME_ENABLE_OS_SANDBOX"] === "1" || mode === "required";
  if (!optIn) {
    return { command: input.command, args: [...input.args], isolation: "process", provider: "none", detail: "shell-free process isolation only; OS sandbox is opt-in" };
  }

  const platform = input.platform ?? process.platform;
  if (platform === "darwin") {
    const sandboxExecutable = await executable("sandbox-exec", env);
    if (sandboxExecutable) return macosPlan(input, sandboxExecutable);
  } else if (platform === "linux") {
    const bubblewrapExecutable = await executable("bwrap", env) ?? await executable("bubblewrap", env);
    if (bubblewrapExecutable) return linuxPlan(input, bubblewrapExecutable);
  }

  if (mode === "required") throw new Error(`os_sandbox_unavailable:${platform}`);
  return { command: input.command, args: [...input.args], isolation: "process", provider: "none", detail: `OS sandbox unavailable on ${platform}; using shell-free process isolation` };
}
