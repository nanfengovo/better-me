import assert from "node:assert/strict";
import test from "node:test";
import { ModelUsageMeter } from "../src/tasks/usage-meter.js";
import {
  meteredCodingGenerator,
  meteredLocalOllamaClient,
  meteredToolBuilder,
  meteredTrainingAuthor,
  meteredTranslationEngine,
} from "../src/tasks/metered-adapters.js";
import type { TrainingPlan } from "@better-me/agent-contracts";

test("metered adapters record calls, failures, and token counts into the owner ModelUsageMeter", async () => {
  const meter = new ModelUsageMeter(() => new Date("2026-11-18T12:00:00.000Z"));
  const controller = new AbortController();

  const builder = meteredToolBuilder(meter, async () => ({
    source: "function(x){return x}",
    provider: "ollama-local",
    model: "gemma4:e2b-it-qat",
    promptHash: "a".repeat(64),
    generatedTokens: 420,
    durationMs: 12,
  }));
  await builder(undefined, controller.signal);

  const coding = meteredCodingGenerator(meter, async () => {
    throw new Error("synthetic_coding_failure");
  });
  await assert.rejects(() => coding({
    goal: "norm",
    model: "qwen2.5-coder:7b",
    modelDigest: "b".repeat(64),
    cases: [{ id: "c1", input: {}, expected: {} }],
    targetCaseId: "c1",
    previousChecks: [],
  }, controller.signal), /synthetic_coding_failure/);

  const author = meteredTrainingAuthor(meter, {
    pin: async () => "c".repeat(64),
    diagnose: async () => ({ route: "rewrite", observation: "ok", nextStep: "go" }),
    design: async () => ({ title: "t", cards: [], scenes: [] }),
    program: async () => "input => input",
  });
  const plan: TrainingPlan = {
    id: "p1",
    goal: "g",
    evidence: "e",
    advice: { route: "rewrite", observation: "ok", nextStep: "go" },
    origin: "local",
    model: "qwen2.5-coder:7b",
    modelCalls: 1,
  };
  await author.diagnose("qwen2.5-coder:7b", "c".repeat(64), "g", "e", controller.signal);
  await author.design(plan, "c".repeat(64), "rewrite", controller.signal);

  const translation = meteredTranslationEngine(meter, {
    backend: async () => ({ id: "b", engine: "e", location: "local", ready: true, simulation: false, models: [] }),
    run: async (input) => {
      await input.modelCall("hello", async () => "world");
      return { mono: new Uint8Array([1]) };
    },
  })!;
  await translation.run({
    request: {
      requestId: "req-1",
      consent: true,
      materialId: "m1",
      materialHash: "a".repeat(64),
      materialRevision: 1,
      backendId: "pdf2zh-local-v1",
      model: { name: "qwen", digest: "b".repeat(64) },
      sourceLanguage: "zh",
      targetLanguage: "en",
      bilingual: false,
      glossary: [],
    },
    source: new Uint8Array([1]),
    signal: controller.signal,
    progress: async () => {},
    modelCall: async (_p, complete) => complete(controller.signal),
  });

  const localClient = meteredLocalOllamaClient(meter, {
    binding: async () => ({ kind: "local-ollama", id: "ollama", model: "qwen", expectedDigest: "d".repeat(64) } as never),
    complete: async () => "done",
  }, "qwen");
  await localClient.complete({
    prompt: "hi",
    signal: controller.signal,
    budget: { maxInputBytes: 100, maxOutputBytes: 100, maxActiveMs: 1000 },
  });

  const snap = meter.snapshot();
  const byLabel = new Map(snap.models.map((item) => [item.label, item]));
  assert.equal(byLabel.get("capability:ollama")?.calls, 1);
  assert.equal(byLabel.get("capability:ollama")?.outputTokens, 420);
  assert.equal(byLabel.get("capability:ollama")?.metered, true);
  assert.equal(byLabel.get("coding:qwen2.5-coder:7b")?.calls, 1);
  assert.equal(byLabel.get("coding:qwen2.5-coder:7b")?.failures, 1);
  assert.equal(byLabel.get("training-diagnose:qwen2.5-coder:7b")?.calls, 1);
  assert.equal(byLabel.get("training-design:qwen2.5-coder:7b")?.calls, 1);
  assert.equal(byLabel.get("pdf2zh:en")?.calls, 1);
  assert.equal(byLabel.get("local:qwen")?.calls, 1);
});
