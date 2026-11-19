import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("ModelUsageMeter persists same-day usage to private JSON across restarts and resets on next local day", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-usage-meter-"));
  const filePath = path.join(dir, "usage-metrics.json");
  try {
    let now = new Date(2026, 10, 18, 10, 0);
    const first = new ModelUsageMeter({ now: () => now, filePath });
    first.begin("deepseek-chat", "model")({ ok: true, usage: { inputTokens: 100, outputTokens: 25 } });
    await first.flush();

    const reopenedSameDay = new ModelUsageMeter({ now: () => new Date(2026, 10, 18, 18, 0), filePath });
    const sameDaySnap = reopenedSameDay.snapshot();
    assert.equal(sameDaySnap.models.length, 1);
    assert.equal(sameDaySnap.models[0]?.inputTokens, 100);
    assert.equal(sameDaySnap.models[0]?.outputTokens, 25);

    now = new Date(2026, 10, 19, 8, 0);
    const nextDay = new ModelUsageMeter({ now: () => now, filePath });
    assert.deepEqual(nextDay.snapshot().models, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
