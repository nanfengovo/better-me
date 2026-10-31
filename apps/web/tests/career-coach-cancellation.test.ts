import assert from "node:assert/strict";
import test from "node:test";
import { fetchChatCompletion, fetchChatCompletionResult } from "../../../packages/core/src/ai/client.ts";

const config = { provider: "ollama" as const, baseUrl: "https://synthetic-model.invalid/v1", model: "synthetic-model", apiKey: "" };
const messages = [{ role: "user" as const, content: "synthetic input" }];

test("coach caller cancellation rejects before any provider request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchChatCompletionResult(config, messages, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests, 0);
});

test("coach cancellation reaches provider transport and keeps a sanitized cancellation message", async (t) => {
  let transportSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    transportSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => transportSignal?.addEventListener("abort", () => reject(new DOMException("synthetic abort", "AbortError")), { once: true }));
  });
  const controller = new AbortController();
  const pending = fetchChatCompletion(config, messages, { signal: controller.signal });
  controller.abort(new Error("private cancellation reason"));
  await assert.rejects(pending, (error: Error) => error.name === "AbortError" && !error.message.includes("private"));
  assert.equal(transportSignal?.aborted, true);
});

test("late successful provider reply cannot revive a cancelled generation", async (t) => {
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const pending = fetchChatCompletionResult(config, messages, { signal: controller.signal });
  controller.abort();
  finish(Response.json({ choices: [{ message: { content: "late synthetic output" }, finish_reason: "stop" }] }));
  await assert.rejects(pending, { name: "AbortError" });
});
