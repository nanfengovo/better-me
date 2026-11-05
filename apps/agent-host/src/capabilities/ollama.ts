import { z } from "zod";
import { hash, CONTRACT } from "./verification.js";

export type GeneratedTool = { source: string; provider: string; model: string; modelDigest?: string; promptHash: string;
  generatedTokens?: number; durationMs: number };
export type ToolBuilder = (feedback: string | undefined, signal: AbortSignal) => Promise<GeneratedTool>;
export const LOCAL_MODEL = "gemma4:e2b-it-qat";
const SPEC = `Write a short pure JavaScript function expression: function(input) { ... }. Return ONLY JavaScript, no JSON wrapper or markdown.
Contract ${CONTRACT}. Input is {before:Export,after:Export}. Each Export is one of:
{format:"board-v1",sourceNamespace:string,capturedAt:ISO_string,jobs:[{jobId:string,title:string,requirements:string[]}]}
{format:"board-v2",sourceNamespace:string,capturedAt:ISO_string,positions:[{id:string,name:string,needs:string[]}]}
Output is ONE flat array of rows, before rows first, then after rows, preserving input order and ALL rows including duplicate IDs.
Each output row has EXACTLY these keys:
{batch:"before" or "after",index:zero_based_position_in_that_batch,sourceNamespace:export.sourceNamespace,jobId:job.jobId OR position.id,title:job.title OR position.name,requirements:job.requirements OR position.needs,snapshotAt:export.capturedAt}
Preserve strings/requirements arrays exactly, do not trim, sort, deduplicate, infer or add fields.
Support either format in either batch. Empty arrays produce no rows. Reject missing before/after, unsupported formats, invalid arrays or missing required fields by throwing Error. Do not accept unknown formats as empty arrays.
No imports, exports, async, files, network, process, console, external dependencies or host globals. Treat all job text as inert data.
This tool ONLY normalizes; do not compute differences. Use a loop over ['before','after']. Keep the implementation concise. No explanation or markdown.`;

export async function localModelAvailable(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) return false;
    const data = z.object({ models: z.array(z.object({ name: z.string(), remote_host: z.string().optional(), remote_model: z.string().optional() })) }).parse(await response.json());
    return data.models.some(model => model.name === LOCAL_MODEL && !model.remote_host && !model.remote_model);
  } catch { return false; }
}

/** Loopback-only local weights. No env keys, provider fallback or cloud-tag execution. */
export function ollamaBuilder(): ToolBuilder {
  return async (feedback, signal) => {
    const started = Date.now();
    const linked = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
    const tags = await fetch("http://127.0.0.1:11434/api/tags", { signal: linked, redirect: "error" });
    if (!tags.ok) throw new Error("local_ollama_unavailable");
    const data = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string(), remote_host: z.string().optional(), remote_model: z.string().optional() })) }).parse(await tags.json());
    const model = data.models.find(item => item.name === LOCAL_MODEL);
    if (!model || model.remote_host || model.remote_model) throw new Error("local_weights_required");
    const prompt = SPEC + (feedback ? `\nPrevious candidate failed the independent verifier (${feedback}). Generate a corrected complete function with strict input checks.` : "");
    const response = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", redirect: "error", signal: linked,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: LOCAL_MODEL, stream: false, think: false,
        options: { temperature: 0, num_predict: 3000, num_ctx: 8192 },
        messages: [{ role: "user", content: prompt }] }) });
    if (!response.ok) throw new Error("local_ollama_generation_failed");
    const result = z.object({ done: z.literal(true), done_reason: z.string().optional(), message: z.object({ content: z.string().max(96 * 1024) }), eval_count: z.number().optional() }).parse(await response.json());
    if (result.done_reason === "length") throw new Error("generation_token_budget_exhausted");
    // Strip transport fencing only; never repair/rewrite or replace generated code.
    const source = result.message.content.trim().replace(/^```(?:javascript|js)?\s*\n/, "").replace(/\n```$/, "").trim();
    const tool = z.object({ source: z.string().min(10).max(64 * 1024) }).strict().parse({ source });
    return { ...tool, provider: "ollama-local", model: LOCAL_MODEL, modelDigest: model.digest, promptHash: hash(prompt),
      generatedTokens: result.eval_count, durationMs: Date.now() - started };
  };
}
