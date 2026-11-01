/** Manual browser acceptance. Temporary fictional data only; never jobs/resume storage. */
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { ChatGptPlanService } from "../src/chatgpt/service.js";
import { chatGptProviderFixture } from "./fixtures/chatgpt-provider.js";

const mode = process.env.BETTER_ME_CHATGPT_BROWSER_MODE ?? "fixture";
if (!["fixture", "authorization"].includes(mode)) throw new Error("Choose explicit fixture or authorization mode.");
const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-chatgpt-browser-"));
const evidence = path.join(directory, "fictional-dispatch.ts");
await writeFile(evidence, "// Fictional browser fixture only. No real customer code.\nexport const tasks = ['fetch', 'put'];\n", { mode: 0o600 });
const provider = mode === "fixture" ? await chatGptProviderFixture() : undefined;
const transport: typeof fetch | undefined = provider ? async (url, init) => {
  if (String(url).endsWith("/responses")) {
    const body = JSON.parse(String(init?.body)); const text = JSON.stringify(body.input);
    provider.settings.responseStatus = text.includes("测试额度") ? 429 : 200;
    provider.settings.errorCode = text.includes("测试额度") ? "subscription_sharing_usage_limit_exceeded" : "";
    provider.settings.noTerminal = text.includes("测试中断"); provider.settings.responseDelayMs = 600;
    if (String(body.instructions).includes("project-understanding")) {
      const ready = text.includes("只负责编排");
      provider.settings.responseText = JSON.stringify({ kind: "reply", message: ready ? "已根据你的纠正更新理解，请核对后确认。" : "先对齐这个虚构项目的边界，不假定个人贡献。",
        understanding: { summary: "虚构 RCS 是运单与搬运任务之间的编排层，不直接控制车辆。", terms: [{ term: "RCS", meaning: "本项目的任务编排层", evidenceIds: [] }], boundaries: ["下游调度执行车辆运动", "项目能力不等于个人贡献"], claims: [], unknowns: ["个人负责范围尚未访谈"] }, readyForConfirmation: ready,
        ...(ready ? {} : { question: { id: "boundary", text: "这个 RCS 在项目里属于哪一层？", why: "同一缩写在不同项目可能含义不同。", options: [{ id: "orchestration", label: "接收运单并编排搬运任务" }, { id: "control", label: "直接控制车辆运动" }, { id: "other", label: "都不完全符合，我补充" }], allowMultiple: false } }) });
    } else provider.settings.responseText = JSON.stringify({ questions: [], rationale: "只整理已核对的本人补充，不从项目共识推断个人贡献。", evidenceQuotes: ["编写了任务状态校验逻辑"], proposedText: "编写了任务状态校验逻辑" });
  }
  return provider.fetch(url, init);
} : undefined;
const service = new ChatGptPlanService({ directory: path.join(directory, "oauth"), fetch: transport });
if (provider) await provider.login(service);
const server = createAgentServer({ port: 5207, host: "127.0.0.1", authToken: "isolated_chatgpt_fixture_token_not_a_real_secret",
  allowedOrigins: ["http://127.0.0.1:5197"], checkpointer: new MemorySaver() as never, runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "sessions"),
  runtimeDefinitions: [], chatGptService: service, understandingReasoner: async () => { throw new Error("This harness has no configured-model/API fallback"); },
});
console.log(JSON.stringify({ mode, directory, authorizedFixture: evidence, browser: `http://127.0.0.1:5197/tests/ui-lab/chatgpt-plan.html?chatgpt=${mode}`,
  note: provider ? "Cryptographically signed fictional provider; no OpenAI traffic or real account" : "Real official transport; waiting for the user to click login. Fictional resume only." }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
