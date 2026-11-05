/** Isolated A/B browser acceptance. Does not load old stores, model credentials or job services. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-identity-browser-"));
const project = path.join(directory, "fictional-source"); await mkdir(project);
await writeFile(path.join(project, "plan.ts"), "// Synthetic project only, not a business system.\nexport const plan = ['fetch', 'put'];\n");
const server = createAgentServer({ port: 5329, host: "127.0.0.1", allowedOrigins: ["http://identity-regression.localhost:5323"],
  authToken: "better-me-agent-token", checkpointer: new MemorySaver() as never, identityDirectory: path.join(directory, "private"),
  runsDirectory: path.join(directory, "runs"), runtimeDefinitions: [],
  understandingReasoner: async () => async prompt => JSON.stringify({ kind: "reply", message: "隔离验证：只使用本账号已提供的项目材料，请核对后确认。",
    understanding: { summary: prompt.includes("ALICE-ONLY") ? "ALICE-ONLY：此合成项目把运单拆成取送任务，不控制车辆。" : "BOB-ONLY：此合成项目负责库存检查，不代表个人贡献。",
      terms: [], claims: [], boundaries: ["合成验证，不访问业务项目"], unknowns: ["个人贡献仍需确认"] }, readyForConfirmation: true }),
});
console.log(JSON.stringify({ isolation: "synthetic-only", directory, authorizedFixture: project, browser: "http://identity-regression.localhost:5323/" }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
