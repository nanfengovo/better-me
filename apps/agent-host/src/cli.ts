/**
 * cli.ts — Entry point for `pnpm --filter @better-me/agent-host start`
 *
 * Usage:
 *   tsx src/cli.ts [options]
 *
 * Options:
 *   --port <number>            HTTP port (default: 5179)
 *   --host <ip>               Bind address (default: 127.0.0.1)
 *   --origin <url>            Allowed CORS origin (repeatable)
 *   --checkpoint-dir <path>   Override checkpoint SQLite directory
 *   --runs-dir <path>         Override isolated Agent run directory
 *   --sandbox <mode>          OS sandbox mode: auto, required, or disabled
 *   --token <string>          Bearer token (falls back to AGENT_HOST_TOKEN env)
 */

import { resolveCheckpointPath, createCheckpointer } from "./checkpointer.js";
import { createAgentServer } from "./server.js";

function parseArgs(argv: string[]): {
  port: number;
  host: string;
  origins: string[];
  checkpointDir?: string;
  runsDirectory?: string;
  sandboxMode: "auto" | "required" | "disabled";
  token: string;
} {
  const args = argv.slice(2);
  let port = 5179;
  let host = "127.0.0.1";
  const origins: string[] = [];
  let checkpointDir: string | undefined;
  let runsDirectory: string | undefined;
  let sandboxMode: "auto" | "required" | "disabled" = "auto";
  let token = process.env["AGENT_HOST_TOKEN"] ?? "";

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];
    if (flag === "--port" && next) { port = parseInt(next, 10); i++; }
    else if (flag === "--host" && next) { host = next; i++; }
    else if (flag === "--origin" && next) { origins.push(next); i++; }
    else if (flag === "--checkpoint-dir" && next) { checkpointDir = next; i++; }
    else if (flag === "--runs-dir" && next) { runsDirectory = next; i++; }
    else if (flag === "--sandbox" && next && ["auto", "required", "disabled"].includes(next)) { sandboxMode = next as typeof sandboxMode; i++; }
    else if (flag === "--token" && next) { token = next; i++; }
  }

  if (!token) {
    console.error("[agent-host] Missing --token or AGENT_HOST_TOKEN");
    process.exit(1);
  }

  return { port, host, origins, checkpointDir, runsDirectory, sandboxMode, token };
}

const { port, host, origins, checkpointDir, runsDirectory, sandboxMode, token } = parseArgs(process.argv);
const cpPath = resolveCheckpointPath(checkpointDir);
console.log(`[agent-host] checkpoint: ${cpPath}`);
const checkpointer = createCheckpointer(cpPath);

createAgentServer({
  port,
  host,
  allowedOrigins: origins.length > 0 ? origins : ["http://localhost:5173", "http://127.0.0.1:5173"],
  authToken: token,
  checkpointer,
  runsDirectory,
  sandboxMode,
});
