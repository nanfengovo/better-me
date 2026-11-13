import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

interface HostRuntime { executable: string; electron: boolean }

// Match apps/agent-host/package.json engines. A matching major alone does not prove SQLite is available.
function supportsHost(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!parts && (Number(parts[1]) >= 26 || Number(parts[1]) === 24 && Number(parts[2]) >= 15);
}

// macOS Homebrew directories are often group-writable by admin (80) or wheel (0).
// Resolve the symlink once, validate its *actual* binary and ancestors, then execute only that real path.
function homebrewNode(prefix: string): string | undefined {
  try {
    const executable = realpathSync(`${prefix}/bin/node`);
    if (!/^Cellar\/node(?:@\d+)?\/\d+\.\d+\.\d+(?:_\d+)?\/bin\/node$/.test(path.posix.relative(prefix, executable))) return;
    for (let entry = executable; ; entry = path.posix.dirname(entry)) {
      const stat = statSync(entry);
      const file = entry === executable;
      if (!(file ? stat.isFile() && (stat.mode & 0o111) !== 0 : stat.isDirectory())) return;
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) return;
      if ((stat.mode & 0o002) !== 0 || (stat.mode & 0o020) !== 0 && stat.gid !== 0 && stat.gid !== 80) return;
      if (entry === "/") break;
    }
    return executable;
  } catch { return; }
}

export function resolveAgentHostRuntime(): HostRuntime {
  if (path.isAbsolute(process.execPath) && supportsHost(process.versions.node)) {
    try {
      if (typeof process.getBuiltinModule?.("node:sqlite")?.DatabaseSync === "function") {
        return { executable: process.execPath, electron: Boolean(process.versions.electron) };
      }
    } catch { /* The embedded build can omit a builtin even on a compatible Node. */ }
  }
  if (process.platform === "darwin") {
    for (const prefix of ["/opt/homebrew", "/usr/local"]) {
      const executable = homebrewNode(prefix);
      if (!executable) continue;
      const probe = spawnSync(executable, ["--no-warnings", "-e",
        'if(typeof require("node:sqlite").DatabaseSync==="function")process.stdout.write(process.versions.node)'],
      { cwd: "/", env: {}, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, killSignal: "SIGKILL", maxBuffer: 128 });
      if (!probe.error && probe.status === 0 && typeof probe.stdout === "string" && supportsHost(probe.stdout)) return { executable, electron: false };
    }
  }
  throw new Error("desktop_agent_host_runtime_unavailable：没有能运行 Agent Host 的可信 Node。请先用支持 node:sqlite 的 Node 24.x（≥24.15）或 26+ 启动本机 Host，再打开工作台。");
}

export function agentHostEnvironment(runtime: HostRuntime, packaged: boolean): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:NODE_OPTIONS|NODE_PATH|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE|ESBUILD_BINARY_PATH|TSX_TSCONFIG_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(key)));
  env.NODE_ENV = packaged ? "production" : "development";
  if (runtime.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}
