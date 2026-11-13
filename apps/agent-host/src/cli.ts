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
 *   --career-config <path>    Explicit private operator MCP/cloud/Vork manifest
 */

import { resolveCheckpointPath, createCheckpointer } from "./checkpointer.js";
import { createAgentServer } from "./server.js";
import path from "node:path";
import { loadIdentityDeployment, publicOrigins } from "./identity/deployment.js";
import { ensureBuiltinOrConfiguredOidc } from "./identity/builtin-idp.js";
import { loadCareerOperatorConfig } from "./career-studio/operator-config.js";
import { createConfiguredPrivacyProviderFromEnvironment } from "./career-studio/operator-provider.js";
import { careerExportRendererFromEnvironment } from "./career-studio/export-config.js";
import { createLoopbackVerifiedJobResolver, type VerifiedJobResolver } from "./career-studio/verified-jobs.js";

function parseArgs(argv: string[]): {
  port: number;
  host: string;
  origins: string[];
  checkpointDir?: string;
  runsDirectory?: string;
  sandboxMode: "auto" | "required" | "disabled";
  token: string;
  careerConfigPath?: string;
} {
  const args = argv.slice(2);
  let port = 5179;
  let host = "127.0.0.1";
  const origins: string[] = [];
  let checkpointDir: string | undefined;
  let runsDirectory: string | undefined;
  let sandboxMode: "auto" | "required" | "disabled" = "auto";
  let token = process.env["AGENT_HOST_TOKEN"] ?? "";
  let careerConfigPath = process.env["BETTERME_CAREER_OPERATOR_CONFIG"];

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
    else if (flag === "--career-config" && next) { careerConfigPath = next; i++; }
  }

  if (!token) {
    console.error("[agent-host] Missing --token or AGENT_HOST_TOKEN");
    process.exit(1);
  }

  return { port, host, origins, checkpointDir, runsDirectory, sandboxMode, token, careerConfigPath };
}

const { port, host, origins, checkpointDir, runsDirectory, sandboxMode, token, careerConfigPath } = parseArgs(process.argv);
// No implicit provider, key discovery or community executable installation.
// Invalid optional integrations stay unavailable without disabling old flows.
let careerOperator: Awaited<ReturnType<typeof loadCareerOperatorConfig>> | undefined;
if (careerConfigPath) {
  try { careerOperator = await loadCareerOperatorConfig({ configPath: careerConfigPath, resolvePrivacyProvider: createConfiguredPrivacyProviderFromEnvironment() }); }
  catch { console.error("[career-studio] Operator configuration is unavailable or invalid; optional MCP/cloud/Vork integrations were not enabled."); }
}
const cpPath = resolveCheckpointPath(checkpointDir);
let careerFinalExportRenderer: ReturnType<typeof careerExportRendererFromEnvironment>;
try { careerFinalExportRenderer = careerExportRendererFromEnvironment(); }
catch { console.error("[career-studio] Final export renderer configuration is invalid; optional file checks were not enabled."); }
let careerVerifiedJobResolver: VerifiedJobResolver | undefined;
// A named, explicitly supplied environment reference only. Do not discover or
// read the user's existing JobService token files/browser connection state.
const jobTokenReference = process.env.BETTERME_CAREER_JOB_AUTHORITY_TOKEN_ENV;
if (jobTokenReference) {
  try {
    if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(jobTokenReference)) throw new Error("invalid_job_authority_reference");
    careerVerifiedJobResolver = createLoopbackVerifiedJobResolver({ token: process.env[jobTokenReference] ?? "" });
  } catch { console.error("[career-studio] Read-only job authority is unavailable; office links remain unknown."); }
}
console.log(`[agent-host] checkpoint: ${cpPath}`);
const checkpointer = createCheckpointer(cpPath);
const allowedOrigins = publicOrigins(process.env, origins.length > 0 ? origins : ["http://localhost:5173", "http://127.0.0.1:5173"]);
const primaryOrigin = allowedOrigins.find((item) => item.includes("localhost")) ?? allowedOrigins[0] ?? "http://localhost:5173";
const identity = await loadIdentityDeployment({ defaultConfigPath: path.join(path.dirname(cpPath), "oidc.json") });
if (identity.issue) console.error(`[identity] ${identity.issue}; local accounts remain available. Run pnpm auth:check.`);
const { oidc, builtinHandle } = await ensureBuiltinOrConfiguredOidc({
  storageDir: path.join(path.dirname(cpPath), "builtin-idp"),
  primaryOrigin,
  configuredOidc: identity.oidc,
  authMode: process.env["BETTERME_AUTH_MODE"],
  hasExplicitIssue: Boolean(identity.issue),
});
if (builtinHandle) {
  console.log(`[identity] built-in zero-install OIDC & social auth broker active at ${builtinHandle.issuer}`);
}

const server = createAgentServer({
  port,
  host,
  allowedOrigins,
  authToken: token,
  checkpointer,
  runsDirectory,
  sandboxMode,
  oidc,
  careerOperator,
  careerFinalExportRenderer,
  careerVerifiedJobResolver,
});
server.once("close", () => {
  void builtinHandle?.close();
});
