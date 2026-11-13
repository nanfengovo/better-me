/** Opt-in manual acceptance service: real HTTP, private SQLite, local Ollama,
 * actual Vork. No fake model, account credentials, source or business data. */
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCheckpointer } from "../src/checkpointer.js";
import { createAgentServer } from "../src/server.js";
import { careerExportRendererFromEnvironment } from "../src/career-studio/export-config.js";

const requested = process.env.BETTERME_STUDIO_QA_DIRECTORY;
if (requested && (!path.isAbsolute(requested) || !path.basename(requested).startsWith("betterme-studio-acceptance-") || ![os.tmpdir(), await realpath(os.tmpdir())].includes(path.dirname(requested)))) throw new Error("isolated_qa_directory_required");
const directory = await realpath(requested ?? await mkdtemp(path.join(os.tmpdir(), "betterme-studio-acceptance-")));
const server = createAgentServer({ port: 5279, host: "127.0.0.1", allowedOrigins: ["http://127.0.0.1:5273"], authToken: "better-me-agent-token",
  checkpointer: createCheckpointer(path.join(directory, "checkpoints.sqlite")), identityDirectory: path.join(directory, "accounts"),
  runsDirectory: path.join(directory, "runs"), runtimeDefinitions: [], sandboxMode: "required",
  careerVorkBinary: "/Users/feng/.local/lib/vork/vork",
  careerFinalExportRenderer: careerExportRendererFromEnvironment(),
});
server.once("listening", () => console.info(JSON.stringify({ service: "isolated-career-studio", port: 5279, directory, model: "explicit-local-selection-only", cloudConfigured: false })));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.closeAllConnections(); server.close(); });
