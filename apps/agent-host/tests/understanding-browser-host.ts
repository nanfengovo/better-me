/** Manual isolated browser harness. Never imports the jobs/resume repositories. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { createUnderstandingReasoner } from "../src/understanding/http.js";
import { RuntimeRegistry } from "../src/runtime/registry.js";

const existing = process.env.BETTER_ME_UNDERSTANDING_TEST_DIR;
if (existing && (!path.isAbsolute(existing) || !path.basename(existing).startsWith("betterme-understanding-browser-"))) throw new Error("Use only a previously created isolated understanding test directory.");
const directory = existing ?? await mkdtemp(path.join(os.tmpdir(), "betterme-understanding-browser-"));
const project = path.join(directory, "fictional-project");
await mkdir(project, { recursive: true });
await writeFile(path.join(project, "dispatch.ts"), [
  "// Fictional regression fixture. Not a real customer or business project.",
  "export function plan(order: { id: string; pickup: string; destination: string }) {",
  "  return [{ type: 'fetch', location: order.pickup }, { type: 'put', location: order.destination }];",
  "}",
  "// The downstream system, not this module, controls vehicle movement.",
].join("\n"));
const registry = new RuntimeRegistry({ definitions: [] });
let responseNumber = 0;
const timeoutMs = process.env.BETTER_ME_UNDERSTANDING_TEST_TIMEOUT_MS ? Number(process.env.BETTER_ME_UNDERSTANDING_TEST_TIMEOUT_MS) : undefined;
if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000)) throw new Error("Invalid isolated test timeout.");
const server = createAgentServer({
  port: 5206, host: "127.0.0.1", authToken: "isolated_understanding_fixture_token_not_a_real_secret",
  allowedOrigins: ["http://127.0.0.1:5196"], checkpointer: new MemorySaver() as never,
  runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "sessions"),
  runtimeDefinitions: [], understandingTurnTimeoutMs: timeoutMs,
  understandingReasoner: async runtime => {
    if (runtime.kind !== "model" || runtime.modelSettings.model !== "test-fixture") {
      const reason = await createUnderstandingReasoner(runtime, registry);
      return async (prompt, signal) => {
        const output = await reason(prompt, signal);
        // Test fixture materials only; production never persists raw provider output.
        await writeFile(path.join(directory, `fixture-model-response-${++responseNumber}.txt`), output, { mode: 0o600 });
        return output;
      };
    }
    return async (prompt, signal) => {
      signal.throwIfAborted();
      // A real model is used by ?live=true. This explicit test provider permits
      // deterministic cancellation/retry/confirmation checks through real HTTP.
      const contextLine = prompt.split("\n\n").find(line => line.startsWith('{"project":'));
      const lastMessage = contextLine ? String(JSON.parse(contextLine).context?.messages?.at(-1)?.text ?? "") : "";
      if (lastMessage.includes("测试超时")) await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (lastMessage.includes("测试停住")) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      const ready = prompt.includes("我确认示例系统只编排任务");
      return JSON.stringify({ kind: "reply", message: ready ? "已按你的补充更新项目理解，请逐项核对后确认。" : "先对齐项目的边界，再讨论你负责的工作。这里的 RCS 指哪一层？",
        understanding: { summary: "虚构示例中的 RCS 是运单与搬运任务之间的编排层，不等同于车端运动控制。", terms: [{ term: "RCS", meaning: "本项目的任务编排层", evidenceIds: [] }], boundaries: ["下游系统执行车辆运动", "项目能力不代表用户个人贡献"], claims: [{ id: "draft-boundary", text: "关于任务拆分的理解仍需用户核对", kind: "inference", evidenceIds: [] }], unknowns: ["个人负责的模块仍未访谈"] },
        ...(ready ? {} : { question: { id: "project-role", text: "这个项目中的 RCS 主要负责哪一层？", why: "同一缩写在不同项目中可能承担不同职责。", options: [{ id: "orchestration", label: "接收运单并编排搬运任务" }, { id: "vehicle", label: "直接控制车辆运动" }, { id: "different", label: "都不完全符合，我来补充" }], allowMultiple: false } }), readyForConfirmation: ready });
    };
  },
});
console.log(JSON.stringify({ isolation: "synthetic-only", directory, authorizedFixture: project }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
