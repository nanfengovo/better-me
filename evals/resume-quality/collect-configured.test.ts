import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedConfigured } from "./collect-configured.mjs";
import { reviewCollection } from "./collection-report.mjs";
import { archivedProviderObservations, summarizeProviderObservations } from "./runtime-quality.mjs";

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
    if (calls === 4) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "unavailable synthetic endpoint", type: "test" } }));
      return;
    }
    const usage = calls === 2 ? { completion_tokens: 13 } : calls === 3 ? undefined
      : { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    response.end(JSON.stringify({ id: "fixture-output", model: body.model, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: "Deliberately invalid candidate, retain this complete failure." } }], usage }));
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
    const campaignDirectory = path.join(outputDirectory, "campaign"), reviewed = path.join(directory, "verified");
    const receipt = await reviewCollection({ datasetDirectory, campaignDirectory, outputDirectory: reviewed });
    assert.equal(receipt.metadata.execution, "scripted_fixture");
    assert.deepEqual(receipt.runtimeQuality.providerUsage.tokenCoverage, { numerator: 0, denominator: 5, percent: 0 });
    assert.equal(receipt.runtimeQuality.providerUsage.inputTokens, null);
    assert.equal(receipt.runtimeQuality.providerUsage.hostWaitMs.median, null);
    // The following diagnostics concern the local HTTP test server only.
    // Exercise the same readers on the verified Host bytes without reclassifying the campaign.
    const observed = [];
    for (const row of receipt.results) {
      const filename = path.join(reviewed, row.caseId, "failure", row.stem + ".records", row.taskId + ".json");
      const record = JSON.parse(await fs.readFile(filename, "utf8"));
      assert.equal(record.task.usage.modelCalls, 1);
      observed.push(...archivedProviderObservations(record));
    }
    const measured = summarizeProviderObservations(observed, receipt.observedModelCalls);
    assert.deepEqual(measured.tokenCoverage, { numerator: 2, denominator: 5, percent: 40 });
    assert.deepEqual(measured.timingCoverage, { numerator: 4, denominator: 5, percent: 80 });
    assert.equal(measured.inputTokenCoverage.numerator, 2);
    assert.equal(measured.outputTokenCoverage.numerator, 3);
    assert.equal(measured.inputTokens, 200);
    assert.equal(measured.outputTokens, 33);
    assert.deepEqual(measured.pairedTokens, { inputTokens: 200, outputTokens: 20 });
    assert.ok(typeof measured.hostWaitMs.median === "number" && measured.hostWaitMs.median >= 0);
    assert.equal(measured.chargesWithoutProviderObservation, 1);
    assert.equal(measured.billedAmount, null);
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
  } finally {
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
