import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedConfigured } from "./collect-configured.mjs";

const datasetDirectory = fileURLToPath(new URL("./gold/v1/", import.meta.url));
test("configured collector uses normal authenticated tasks, retains all five failures, and never archives the credential or repeats a campaign", { timeout: 60_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-configured-gold-test-"));
  const credential = "SYNTHETIC-CONFIGURED-KEY-DO-NOT-ARCHIVE";
  let calls = 0;
  const provider = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    assert.equal(body.model, "configured-fixture-not-real");
    assert.ok(body.messages.some((message: { content: string }) => message.content.includes("resume-quality-task-candidate-v7")));
    calls++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "fixture-output", model: body.model, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: "Deliberately invalid candidate, retain this complete failure." } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  const outputDirectory = path.join(directory, "run");
  const options = { datasetDirectory, outputDirectory, modelSettings: { provider: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "configured-fixture-not-real", apiKey: credential },
    declaredRevision: "scripted-fixture-v1", allowLoopbackFixture: true };
  try {
    const result = await runIsolatedConfigured(options);
    assert.equal(result.planned, 5); assert.equal(result.failed, 5); assert.equal(result.unresolved, 0);
    assert.equal(result.observedModelCalls, 5); assert.equal(calls, 5);
    assert.equal(result.metadata.execution, "scripted_fixture");
    async function inspect(current: string) {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await inspect(file);
        else if (entry.isFile()) assert.equal((await fs.readFile(file)).includes(Buffer.from(credential)), false, `credential archived in ${entry.name}`);
      }
    }
    await inspect(outputDirectory);
    await assert.rejects(runIsolatedConfigured(options), /EEXIST|configured_output_exists/);
    assert.equal(calls, 5);
  } finally { await new Promise<void>(resolve => provider.close(() => resolve())); }
});
