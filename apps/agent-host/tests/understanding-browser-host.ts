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
await writeFile(path.join(project, "roadmap.md"), "# Fictional design proposal\nFuture design: replicated queues. Not implemented or deployed.\n");
const contributionTest = process.env.BETTER_ME_UNDERSTANDING_CONTRIBUTION_TEST === "1";
const port = Number(process.env.BETTER_ME_UNDERSTANDING_TEST_PORT ?? 5206);
const webPort = Number(process.env.BETTER_ME_UNDERSTANDING_WEB_PORT ?? 5196);
if (![port, webPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535)) throw new Error("Invalid fixture port");
const registry = new RuntimeRegistry({ definitions: [] });
let responseNumber = 0;
const timeoutMs = process.env.BETTER_ME_UNDERSTANDING_TEST_TIMEOUT_MS ? Number(process.env.BETTER_ME_UNDERSTANDING_TEST_TIMEOUT_MS) : undefined;
if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000)) throw new Error("Invalid isolated test timeout.");
const server = createAgentServer({
  port, host: "127.0.0.1", authToken: "isolated_understanding_fixture_token_not_a_real_secret",
  allowedOrigins: [`http://127.0.0.1:${webPort}`], checkpointer: new MemorySaver() as never,
  runsDirectory: path.join(directory, "runs"), understandingDirectory: path.join(directory, "sessions"),
  runtimeDefinitions: [], understandingTurnTimeoutMs: timeoutMs,
  understandingReasoner: async runtime => {
    if (runtime.kind !== "model" || runtime.modelSettings.model !== "test-fixture") {
      if (contributionTest) throw new Error("This fixture forbids all real providers");
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
      const context = contextLine ? JSON.parse(contextLine) : {};
      if (lastMessage.includes("测试超时")) await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (lastMessage.includes("测试停住")) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      if (contributionTest && context.grants?.length) {
        const read = { kind: "read", requests: [
          { grantId: context.grants[0].id, operation: "list", path: "" },
          { grantId: context.grants[0].id, operation: "read", path: "dispatch.ts" },
          { grantId: context.grants[0].id, operation: "read", path: "roadmap.md" },
          ...Array.from({ length: 5 }, () => ({ grantId: context.grants[0].id, operation: "list", path: "" })),
        ] };
        if (lastMessage.includes("测试预算不总结")) return JSON.stringify(read);
        if (!prompt.includes("SYNTHESIS_ONLY") && lastMessage.includes("读取")) return JSON.stringify(read);
        const code = context.context.evidence.find((item: { path: string }) => item.path === "dispatch.ts");
        const doc = context.context.evidence.find((item: { path: string }) => item.path === "roadmap.md");
        if (code && doc) return JSON.stringify({ kind: "reply", message: "已更新阶段理解：代码与未来设计分开记录。请核对背景后认领你实际负责的部分。",
          understanding: { summary: "已读取示例代码：plan 将运单拆成取、送两项计划，尚未证明下发成功或现场投产。副本队列只在路线图中出现，是未来设计。", terms: [], boundaries: ["只验证已读片段，未遍历整个项目", "代码存在不证明个人贡献或客户使用"],
            claims: [{ id: "split", text: "plan 返回取送计划", kind: "source", evidenceIds: [code.id] }, { id: "future", text: "副本队列是未来方案，未发现实现证据", kind: "design", evidenceIds: [doc.id] }], unknowns: ["谁编写此模块、是否交付客户、本人职责均待确认"],
            contributionLeads: [{ id: "split-role", title: "运单拆解与下游边界", hypothesis: "你可能做过取送拆解，也可能只负责接口联调；代码不能确定归属", category: "responsibility", evidenceIds: [code.id], question: "取送计划由你实现，还是你只负责与下游联调？哪部分是团队完成的？", options: ["我实现拆解，下游运动控制由其他团队负责", "我只负责接口联调", "不是我做的／不确定"] },
              { id: "customer", title: "客户现场与使用阶段", hypothesis: "此模块可能用于物料搬运现场，但材料未证明具体客户或上线", category: "deployment", evidenceIds: [code.id], question: "你做的部分用于内部测试、客户试点还是正式现场？可以只说行业，不披露客户名称。", options: ["内部测试，尚未交付", "客户试点，未正式上线", "不确定／不方便披露"] }],
          }, readyForConfirmation: true });
      }
      const ready = prompt.includes("我确认示例系统只编排任务");
      return JSON.stringify({ kind: "reply", message: ready ? "已按你的补充更新项目理解，请逐项核对后确认。" : "先对齐项目的边界，再讨论你负责的工作。这里的 RCS 指哪一层？",
        understanding: { summary: "虚构示例中的 RCS 是运单与搬运任务之间的编排层，不等同于车端运动控制。", terms: [{ term: "RCS", meaning: "本项目的任务编排层", evidenceIds: [] }], boundaries: ["下游系统执行车辆运动", "项目能力不代表用户个人贡献"], claims: [{ id: "draft-boundary", text: "关于任务拆分的理解仍需用户核对", kind: "inference", evidenceIds: [] }], unknowns: ["个人负责的模块仍未访谈"] },
        ...(ready ? {} : { question: { id: "project-role", text: "这个项目中的 RCS 主要负责哪一层？", why: "同一缩写在不同项目中可能承担不同职责。", options: [{ id: "orchestration", label: "接收运单并编排搬运任务" }, { id: "vehicle", label: "直接控制车辆运动" }, { id: "different", label: "都不完全符合，我来补充" }], allowMultiple: false } }), readyForConfirmation: ready });
    };
  },
});
console.log(JSON.stringify({ isolation: "synthetic-only", directory, authorizedFixture: project }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
