import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { localOllamaOrigin } from "./ollama-context.mjs";
import { makeTurn, grade } from "./version-matrix/experiment.mjs";
import { auditMatrix, priceMatrix } from "./version-matrix-audit.mjs";
import { replayMatrix, runMatrix } from "./version-matrix.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./gold/warehouse-replay-v1.json", import.meta.url), "utf8"),
);
const profiles = JSON.parse(
  await readFile(new URL("./version-matrix/profiles.json", import.meta.url), "utf8"),
);
const correct = { facts: fixture.expectedFacts, interpretation: "inference", productionBenefit: "unknown" };
function body(answer: unknown, model = "test-a:latest") {
  return {
    model,
    done: true,
    done_reason: "stop",
    message: { content: JSON.stringify(answer) },
    prompt_eval_count: 80,
    eval_count: 22,
  };
}

test("warehouse answer requires both complete quotes as retrieved, proper attribution, inference and an unknown benefit", () => {
  for (const agent of profiles.agents) {
    const turn = makeTurn(fixture, profiles.prompts[0], agent, "test-a:latest");
    const actual = JSON.parse(turn.request.messages[1].content);
    assert.deepEqual(Object.keys(actual), ["question", "sources"]);
    assert.ok(!JSON.stringify(turn.request).includes("expectedFacts"));
    assert.equal(grade(fixture, turn.selected, body(correct)).passed, true);
    const swapped = fixture.expectedFacts.map((f: any, i: number) => ({
      ...f,
      sourceId: fixture.expectedFacts[1 - i].sourceId,
    }));
    for (const changed of [
      { facts: swapped },
      { facts: [fixture.expectedFacts[0]] },
      { interpretation: "fact" },
      { productionBenefit: "supported" },
    ]) {
      assert.equal(grade(fixture, turn.selected, body({ ...correct, ...changed })).passed, false);
    }
    assert.equal(grade(fixture, [actual.sources[0]], body(correct)).passed, false);
    assert.equal(
      grade(fixture, turn.selected, { ...body(correct), done_reason: "length" }).reason,
      "incomplete_response",
    );
  }
});
test("matrix only accepts literal loopback origins without credentials and routes", () => {
  assert.equal(localOllamaOrigin("http://127.0.0.1:11435/"), "http://127.0.0.1:11435");
  assert.equal(localOllamaOrigin("http://[::1]:11435"), "http://[::1]:11435");
  for (const endpoint of [
    "https://127.0.0.1",
    "http://model.example",
    "http://127.0.0.1/elsewhere",
    "http://user@127.0.0.1",
    "http://localhost:1234",
  ]) {
    assert.throws(() => localOllamaOrigin(endpoint), /loopback/);
  }
});

test("isolated protocol fixture exercises all 8 cells, single-axis comparisons, partial archives, and mismatched raw receipts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "synthetic-matrix-test-"));
  const models = ["test-a:latest", "test-b:latest", "alias-of-a:latest"];
  const tags = models.map((name, i) => ({ name, model: name, digest: String(i + 1).repeat(64) }));
  let inferenceRequests = 0;
  // A local transport fixture only. Its results are deleted at test exit and never used as model acceptance data.
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const input = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
    let output: unknown;
    if (req.url === "/api/tags") output = { models: tags };
    else if (req.url === "/api/ps") output = { models: [] };
    else if (req.url === "/api/show") {
      const weights = input.model === models[1] ? "b" : "a";
      output = { modelfile: "FROM /synthetic-models/blobs/sha256-" + weights.repeat(64) };
    } else if (req.url === "/api/chat") {
      inferenceRequests++;
      assert.ok(input.options.seed === 42 && input.options.num_ctx === 4096);
      if (inferenceRequests === 1) {
        res.writeHead(503).end();
        return;
      }
      output = body(correct, input.model);
    } else {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(output));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = "http://127.0.0.1:" + address.port,
      directory = path.join(tmp, "experiment");
    await assert.rejects(runMatrix({ endpoint, models: [models[0], models[2]], directory }), /share_weights/);
    assert.equal(inferenceRequests, 0);
    const report = await runMatrix({ endpoint, models: models.slice(0, 2), directory });
    assert.equal(report.planned, 8);
    assert.equal(report.distinctModels, 2);
    assert.equal(report.rows.length, 8);
    assert.equal(report.failed, 1);
    assert.equal(report.unresolved, 0);
    assert.deepEqual(report.completion, { numerator: 7, denominator: 8, percent: 87.5 });
    assert.equal(report.providerUsage.tokenCoverage.numerator, 7);
    assert.equal(report.providerUsage.tokenCoverage.denominator, 8);
    assert.equal(report.providerUsage.pairedTokens.inputTokens, 560);
    assert.equal(report.monetaryCost, null);
    assert.equal(report.retrievalSuccess.numerator, 8);
    assert.equal(report.contrasts.length, 12);
    assert.deepEqual(
      new Set(report.contrasts.map((c: any) => c.dimension)),
      new Set(["modelKey", "prompt", "agent"]),
    );
    assert.equal(new Set(report.rows.map((r: any) => r.taskInputSha256)).size, 1);
    assert.equal(new Set(report.rows.map((r: any) => r.agentSha256)).size, 2);
    assert.equal(new Set(report.rows.map((r: any) => r.promptSha256)).size, 2);
    assert.deepEqual(await replayMatrix(directory), report);
    await assert.rejects(runMatrix({ endpoint, models: [models[0]], directory }), /EEXIST/);
    assert.equal(inferenceRequests, 8);

    const resultFile = path.join(directory, "cell-002.result.json"),
      original = await readFile(resultFile, "utf8");
    const checked = await auditMatrix(directory);
    assert.equal(checked.integrity.state, "sealed_complete");
    assert.equal(checked.integrity.rawResultHashesVerified, 8);
    const cards = tags.slice(0, 2).map((m) => ({
      provider: "ollama",
      model: m.name,
      revision: m.digest,
      currency: "CNY",
      inputPerMillion: 1,
      outputPerMillion: 2,
    }));
    const priced = priceMatrix(checked, cards);
    // First model had a failed call with no token observation. Price just the three metered calls.
    assert.equal(priced.models[0].observedTokenEstimate, (240 + 2 * 66) / 1e6);
    assert.equal(priced.models[0].fullModelTokenEstimate, null);
    assert.equal(priced.models[1].fullModelTokenEstimate, (320 + 2 * 88) / 1e6);
    assert.equal(priced.total.fullMatrixTokenEstimate, null);
    assert.equal(priced.total.billedAmount, null);
    assert.equal(priceMatrix(checked, cards.slice(0, 1)).models[1].observedTokenEstimate, null);
    assert.throws(() => priceMatrix(checked, [cards[0], cards[0]]), /duplicate_matrix_rate/);
    assert.throws(() => priceMatrix(checked, [{ ...cards[0], revision: "unknown" }]), /revision_mismatch/);

    const allMetered = {
      ...checked,
      report: {
        ...report,
        rows: report.rows.map((r: any) => ({
          ...r,
          observation: { wallMs: 10, inputTokens: 100, outputTokens: 50 },
        })),
      },
    };
    const sameCurrency = priceMatrix(allMetered, cards);
    assert.equal(sameCurrency.total.fullMatrixTokenEstimate, (800 + 2 * 400) / 1e6);
    assert.equal(sameCurrency.total.currency, "CNY");
    assert.equal(
      priceMatrix(allMetered, [cards[0], { ...cards[1], currency: "USD" }]).total.fullMatrixTokenEstimate,
      null,
    );

    const changedBody = JSON.parse(original);
    changedBody.body.eval_count += 1;
    await writeFile(resultFile, JSON.stringify(changedBody));
    await assert.rejects(auditMatrix(directory), /sealed_result_changed:cell-002/);
    await writeFile(resultFile, original);
    await rename(resultFile, resultFile + ".withheld");
    await assert.rejects(auditMatrix(directory), /sealed_result_missing:cell-002/);
    await rename(path.join(directory, "report.json"), path.join(directory, "report.withheld"));
    const interrupted = await auditMatrix(directory);
    assert.equal(interrupted.integrity.state, "unsealed");
    assert.deepEqual(interrupted.integrity.unresolvedCells, ["cell-002"]);
    assert.equal(priceMatrix(interrupted, cards).models[1].fullModelTokenEstimate, null);
    const partial = await replayMatrix(directory);
    assert.equal(partial.failed, 1);
    assert.equal(partial.unresolved, 1);
    assert.equal(partial.completion.denominator, 8);
    assert.equal(partial.completion.numerator, 6);
    assert.equal(partial.providerUsage.tokenCoverage.denominator, 8);
    assert.equal(partial.providerUsage.tokenCoverage.numerator, 6);
    assert.equal(inferenceRequests, 8, "replay never calls the provider");
    await writeFile(resultFile, JSON.stringify({ ...JSON.parse(original), cell: "cell-003" }));
    await assert.rejects(replayMatrix(directory), /binding_changed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  }
});
