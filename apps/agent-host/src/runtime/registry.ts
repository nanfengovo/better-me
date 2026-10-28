import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  RuntimeAgentDefSchema,
  RuntimeAgentInfoSchema,
  type RuntimeAgentDef,
  type RuntimeAgentInfo,
} from "@better-me/agent-contracts";
import { BUILTIN_RUNTIME_DEFINITIONS } from "./definitions.js";

const execFileAsync = promisify(execFile);

export interface RuntimeProbeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  timeoutMs?: number;
  now?: () => Date;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function candidateDirectories(options: RuntimeProbeOptions): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? env["HOME"] ?? os.homedir();
  const pathEntries = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const platform = options.platform ?? process.platform;
  const standard = platform === "win32"
    ? [path.join(home, "AppData", "Local", "Programs"), path.join(home, "scoop", "shims"), "C:\\Windows\\System32"]
    : [
        path.join(home, ".local", "bin"),
        path.join(home, "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ];
  return unique([...pathEntries, ...standard]);
}

function commandNames(command: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [command];
  const ext = process.env["PATHEXT"]?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT"];
  return [command, ...ext.map((suffix) => `${command}${suffix.toLowerCase()}`)];
}

/** Resolve a binary without invoking a shell. This also covers Homebrew paths when PATH is stale. */
export async function resolveExecutable(command: string, options: RuntimeProbeOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (path.isAbsolute(command)) {
    try {
      await fs.access(command);
      return command;
    } catch {
      return undefined;
    }
  }

  for (const directory of candidateDirectories(options)) {
    for (const name of commandNames(command, platform)) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Continue through fallback directories and names.
      }
    }
  }
  return undefined;
}

function firstLine(value: string): string | undefined {
  const line = value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line?.slice(0, 300);
}

function outputFrom(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const value = error as { stdout?: unknown; stderr?: unknown };
  return [value.stdout, value.stderr]
    .filter((item): item is string => typeof item === "string")
    .join("\n")
    .trim();
}

function probeEnvironment(options: RuntimeProbeOptions, runtimeId: string): NodeJS.ProcessEnv {
  const base = { ...process.env, ...(options.env ?? {}) };
  const runtimeEnv = runtimeId === "gemini-cli" ? { GEMINI_CLI_NO_RELAUNCH: "1" } : {};
  return { ...base, NO_COLOR: "1", CI: "1", ...runtimeEnv };
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith(`~${path.sep}`)) return path.join(home, value.slice(2));
  return value;
}

async function pathExists(value: string): Promise<boolean> {
  return fs.access(value).then(() => true).catch(() => false);
}

async function inspectAuth(definition: RuntimeAgentDef, options: RuntimeProbeOptions): Promise<{
  state: "configured" | "missing" | "unsupported" | "unknown";
  detail?: string;
}> {
  if (definition.authEnvVars.length === 0 && definition.authFiles.length === 0) return { state: "unknown" };
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? env["HOME"] ?? os.homedir();
  const hasEnvironmentAuth = definition.authEnvVars.some((name) => Boolean(env[name]?.trim()));
  if (hasEnvironmentAuth) return { state: "configured" };

  // Gemini's personal OAuth flow is retired server-side even though the CLI
  // and cached credentials remain installed. Detect it without reading tokens.
  if (definition.id === "gemini-cli") {
    const settingsPath = path.join(home, ".gemini", "settings.json");
    const settingsText = await fs.readFile(settingsPath, "utf8").catch(() => "");
    if (settingsText) {
      try {
        const settings = JSON.parse(settingsText) as { security?: { auth?: { selectedType?: unknown } }; authType?: unknown };
        const selectedType = settings.security?.auth?.selectedType ?? settings.authType;
        if (selectedType === "oauth-personal") {
          return {
            state: "unsupported",
            detail: "当前 Gemini CLI 的个人 Code Assist 登录通道已停用，请迁移到 Antigravity，或改用 GEMINI_API_KEY / Vertex AI。",
          };
        }
        if (selectedType === "gemini-api-key") {
          return { state: "missing", detail: "Gemini 已选择 API Key 登录，但当前环境没有 GEMINI_API_KEY。" };
        }
        if (selectedType === "vertex-ai") {
          const vertexConfigured = env["GOOGLE_GENAI_USE_VERTEXAI"] === "true"
            && Boolean(env["GOOGLE_CLOUD_PROJECT"]?.trim())
            && Boolean(env["GOOGLE_CLOUD_LOCATION"]?.trim());
          return vertexConfigured ? { state: "configured" } : { state: "missing", detail: "Vertex AI 需要 GOOGLE_GENAI_USE_VERTEXAI、GOOGLE_CLOUD_PROJECT 和 GOOGLE_CLOUD_LOCATION。" };
        }
        if (selectedType === "oauth-personal" || selectedType === "oauth") {
          return { state: "unsupported", detail: "当前 Gemini CLI 的个人 OAuth 登录通道未通过非交互认证探测，请改用 API Key 或 Vertex AI。" };
        }
      } catch {
        // A malformed settings file is reported as missing/unknown below;
        // never treat unreadable config as a successful login.
      }
    }
  }

  const hasAuthFile = await Promise.any(
    definition.authFiles.map((candidate) => pathExists(expandHome(candidate, home))),
  ).catch(() => false);
  return hasAuthFile ? { state: "configured" } : { state: "missing" };
}

function readinessFor(input: {
  version: "passed" | "failed" | "skipped";
  protocol: "passed" | "failed" | "skipped";
  auth: "configured" | "missing" | "unsupported" | "unknown";
}): { readiness: "unknown" | "ready" | "needs-auth" | "unsupported" | "error"; canRun: boolean } {
  if (input.version === "failed") return { readiness: "error", canRun: false };
  if (input.protocol === "failed" || input.auth === "unsupported") return { readiness: "unsupported", canRun: false };
  if (input.auth === "missing") return { readiness: "needs-auth", canRun: false };
  if (input.protocol === "passed" && input.auth === "configured") return { readiness: "ready", canRun: true };
  return { readiness: "unknown", canRun: true };
}

function replaceSnapshotItem(snapshot: RuntimeAgentInfo[], next: RuntimeAgentInfo): RuntimeAgentInfo[] {
  return snapshot.map((item) => item.id === next.id ? next : item);
}

export async function probeRuntime(
  definition: RuntimeAgentDef,
  options: RuntimeProbeOptions = {}
): Promise<RuntimeAgentInfo> {
  const parsedDefinition = RuntimeAgentDefSchema.parse(definition);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const candidates = unique([parsedDefinition.command, ...parsedDefinition.fallbackCommands]);
  let resolvedCommand: string | undefined;

  for (const candidate of candidates) {
    resolvedCommand = await resolveExecutable(candidate, options);
    if (resolvedCommand) break;
  }

  if (!resolvedCommand) {
    return RuntimeAgentInfoSchema.parse({
      ...parsedDefinition,
      status: "not-installed",
      checkedAt: now,
      detail: `未找到 ${candidates.join(" / ")}`,
      checks: { version: "skipped", protocol: "skipped", auth: "unknown" },
      canRun: false,
    });
  }

  const timeout = options.timeoutMs ?? 4_000;
  const env = probeEnvironment(options, parsedDefinition.id);
  let version: string | undefined;
  let versionCheck: "passed" | "failed" = "passed";
  let versionDetail: string | undefined;
  try {
    const result = await execFileAsync(resolvedCommand, parsedDefinition.versionArgs, {
      timeout,
      windowsHide: true,
      env,
      maxBuffer: 64 * 1024,
    });
    version = firstLine(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (!version) versionDetail = "已找到可执行文件，版本命令未返回文本";
  } catch (error) {
    versionCheck = "failed";
    versionDetail = error instanceof Error ? error.message.slice(0, 500) : "版本探测失败";
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return RuntimeAgentInfoSchema.parse({
        ...parsedDefinition,
        status: "not-installed",
        resolvedCommand,
        checkedAt: now,
        detail: versionDetail,
        checks: { version: "failed", protocol: "skipped", auth: "unknown" },
        readiness: "error",
        canRun: false,
      });
    }
  }

  let protocol: "passed" | "failed" | "skipped" = "skipped";
  let protocolDetail: string | undefined;
  if (parsedDefinition.probeArgs?.length) {
    try {
      const result = await execFileAsync(resolvedCommand, parsedDefinition.probeArgs, {
        timeout: Math.min(timeout, 3_000),
        windowsHide: true,
        env,
        maxBuffer: 128 * 1024,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const missingFlag = parsedDefinition.requiredFlags.find((flag) => !output.includes(flag));
      if (missingFlag) {
        protocol = "failed";
        protocolDetail = `协议探测未发现 ${missingFlag}`;
      } else {
        protocol = "passed";
      }
    } catch (error) {
      protocol = "failed";
      protocolDetail = firstLine(outputFrom(error)) ?? (error instanceof Error ? error.message.slice(0, 300) : "协议探测失败");
    }
  }

  const auth = await inspectAuth(parsedDefinition, options);
  const checks = { version: versionCheck, protocol, auth: auth.state };
  const readiness = readinessFor(checks);
  const detail = auth.detail ?? (protocolDetail ? `协议探测失败：${protocolDetail}` : versionDetail);
  return RuntimeAgentInfoSchema.parse({
    ...parsedDefinition,
    status: "available",
    resolvedCommand,
    version,
    checkedAt: now,
    ...(detail ? { detail } : {}),
    checks,
    ...readiness,
  });
}

export interface RuntimeRegistryOptions extends RuntimeProbeOptions {
  definitions?: RuntimeAgentDef[];
}

export class RuntimeRegistry {
  private readonly definitions: RuntimeAgentDef[];
  private snapshot: RuntimeAgentInfo[] = [];

  constructor(options: RuntimeRegistryOptions = {}) {
    this.definitions = (options.definitions ?? BUILTIN_RUNTIME_DEFINITIONS).map((definition) => RuntimeAgentDefSchema.parse(definition));
    this.probeOptions = options;
  }

  private readonly probeOptions: RuntimeProbeOptions;

  async scan(): Promise<RuntimeAgentInfo[]> {
    const next = await Promise.all(this.definitions.map((definition) => probeRuntime(definition, this.probeOptions)));
    this.snapshot = next;
    return this.list();
  }

  list(): RuntimeAgentInfo[] {
    return this.snapshot.map((item) => ({
      ...item,
      capabilities: [...item.capabilities],
      fallbackCommands: [...item.fallbackCommands],
      versionArgs: [...item.versionArgs],
      promptArgs: [...item.promptArgs],
      probeArgs: item.probeArgs ? [...item.probeArgs] : undefined,
      requiredFlags: [...item.requiredFlags],
      authEnvVars: [...item.authEnvVars],
      authFiles: [...item.authFiles],
      checks: { ...item.checks },
    }));
  }

  get(id: string): RuntimeAgentInfo | undefined {
    return this.snapshot.find((item) => item.id === id);
  }

  getDefinition(id: string): RuntimeAgentDef | undefined {
    return this.definitions.find((definition) => definition.id === id);
  }

  reportSuccess(id: string): void {
    const current = this.snapshot.find((item) => item.id === id);
    if (!current || current.status !== "available") return;
    const next = RuntimeAgentInfoSchema.parse({
      ...current,
      readiness: "ready",
      canRun: true,
      checks: { ...current.checks, protocol: "passed" },
      detail: undefined,
    });
    this.snapshot = replaceSnapshotItem(this.snapshot, next);
  }

  reportFailure(id: string, error: string): void {
    const current = this.snapshot.find((item) => item.id === id);
    if (!current || current.status !== "available") return;
    const lower = error.toLowerCase();
    const unsupported = lower.includes("unsupported_client") || lower.includes("no longer supported") || lower.includes("incompatible") || lower.includes("unknown option");
    const needsAuth = lower.includes("api key") || lower.includes("authentication") || lower.includes("auth method") || lower.includes("not authenticated");
    const readiness = unsupported ? "unsupported" : needsAuth ? "needs-auth" : "error";
    const next = RuntimeAgentInfoSchema.parse({
      ...current,
      readiness,
      canRun: false,
      detail: error.slice(0, 1000),
      checks: { ...current.checks, auth: unsupported ? "unsupported" : needsAuth ? "missing" : current.checks.auth },
    });
    this.snapshot = replaceSnapshotItem(this.snapshot, next);
  }
}

export { BUILTIN_RUNTIME_DEFINITIONS } from "./definitions.js";
