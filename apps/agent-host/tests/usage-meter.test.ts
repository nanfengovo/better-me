import assert from "node:assert/strict";
import test from "node:test";
import { ModelUsageMeter, providerTokenUsage } from "../src/tasks/usage-meter.ts";

test("only provider-reported tokens are counted; unmetered runtimes keep calls without estimates", () => {
  let now = new Date(2026, 10, 14, 9, 0);
  const meter = new ModelUsageMeter(() => now);
  const first = meter.begin("deepseek-chat", "model");
  assert.deepEqual(meter.snapshot().active.map(item => item.label), ["deepseek-chat"]);
  first({ ok: true, usage: providerTokenUsage({ input_tokens: 120, output_tokens: 30, total_tokens: 150 }) });
  meter.begin("deepseek-chat", "model")({ ok: false });
  meter.begin("codex", "native")({ ok: true });
  const snapshot = meter.snapshot();
  assert.equal(snapshot.active.length, 0);
  assert.deepEqual(snapshot.models.map(({ lastAt: _lastAt, ...rest }) => rest), [
    { label: "deepseek-chat", kind: "model", calls: 2, failures: 1, metered: true, inputTokens: 120, outputTokens: 30 },
    { label: "codex", kind: "native", calls: 1, failures: 0, metered: false, inputTokens: 0, outputTokens: 0 },
  ]);
  now = new Date(2026, 10, 15, 0, 1);
  assert.deepEqual(meter.snapshot().models, []);
});

test("malformed provider usage is ignored and finishing twice records once", () => {
  assert.equal(providerTokenUsage({ input_tokens: -1, output_tokens: 3 }), undefined);
  assert.equal(providerTokenUsage(null), undefined);
  const meter = new ModelUsageMeter();
  const finish = meter.begin("m", "model");
  finish({ ok: true }); finish({ ok: true });
  assert.equal(meter.snapshot().models[0]?.calls, 1);
});
