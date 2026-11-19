import assert from "node:assert/strict";
import type { TestContext } from "node:test";

export function mockLocalGeneration(t: TestContext, model: string, pin: string, generate: (request: { messages: { content: string }[]; format: object }) => unknown) {
  t.mock.method(globalThis, "fetch", async (address: string, init?: RequestInit) => {
    const url = new URL(address);
    assert.equal(url.origin, "http://127.0.0.1:11434");
    if (url.pathname === "/api/version") return Response.json({ version: "0.40.16" });
    if (url.pathname === "/api/tags") return Response.json({ models: [{ name: model, model, digest: pin, size: 1 }] });
    if (url.pathname === "/api/show") return Response.json({ details: { format: "gguf" },
      model_info: { "general.architecture": "synthetic", "general.parameter_count": 1 } });
    assert.equal(url.pathname, "/api/chat");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, model + ":local");
    return Response.json({ model: model + ":local", done: true, done_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(generate(payload)) } });
  });
}
