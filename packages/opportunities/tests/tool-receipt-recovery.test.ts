import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createToolRegistry, defineTool, type ToolResult, type TrustedToolContext } from "../src/tools.js";

function context(key = "original-key", overrides: Partial<TrustedToolContext> = {}): TrustedToolContext { return { requestId: "receipt-recovery-fixture", actorScope: "local-owner", idempotencyKey: key, signal: new AbortController().signal, allowedEffects: ["local-write"], budget: { requests: 0, bytes: 10000, timeoutMs: 5000 }, ...overrides }; }
const inputSchema = z.object({ value: z.number() }).strict();
const outputSchema = z.object({ committed: z.number() }).strict();
function errorCode(result: ToolResult) { assert.equal(result.ok, false, JSON.stringify(result)); return result.ok ? undefined : result.error.code; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("an interrupted mutation recovers only through its trusted read-only callback with original actor and key", async () => {
  const entered = deferred<void>(), release = deferred<{ committed: number }>(); let writes = 0, reads = 0;
  const registry = createToolRegistry([defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic durable write", effect: "local-write", inputSchema, outputSchema,
    execute: input => { writes++; entered.resolve(); return release.promise.then(() => ({ committed: input.value })); },
    recoverInterrupted: (input, ctx) => { reads++; assert.equal(ctx.actorScope, "local-owner"); assert.equal(ctx.idempotencyKey, "original-key"); return { committed: input.value }; },
  })]);
  const active = new AbortController(); const first = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: active.signal }));
  await entered.promise; active.abort(); assert.equal(errorCode(await first), "cancelled");
  const recovered = await registry.execute("jobs.synthetic-write", { value: 7 }, context()); assert.deepEqual(recovered, { ok: true, requestId: "receipt-recovery-fixture", value: { committed: 7 } });
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.deepEqual(await registry.execute("jobs.synthetic-write", { value: 7 }, context()), recovered); assert.equal(reads, 1);
  assert.equal(errorCode(await registry.execute("jobs.synthetic-write", { value: 8 }, context())), "idempotency-conflict"); assert.equal(reads, 1);
  release.resolve({ committed: 7 });
});

test("an absent durable receipt retains the unknown state, never resubmits the mutation and can be recovered later", async () => {
  const entered = deferred<void>(), release = deferred<{ committed: number }>(); let receipt: { committed: number } | undefined = undefined; let writes = 0, reads = 0;
  const registry = createToolRegistry([defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic durable write", effect: "local-write", inputSchema, outputSchema,
    execute: () => { writes++; entered.resolve(); return release.promise; }, recoverInterrupted: () => { reads++; return receipt; },
  })]);
  const active = new AbortController(); const first = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: active.signal }));
  await entered.promise; active.abort(); assert.equal(errorCode(await first), "cancelled");
  assert.equal(errorCode(await registry.execute("jobs.synthetic-write", { value: 7 }, context())), "cancelled"); assert.equal(writes, 1); assert.equal(reads, 1);
  assert.equal(errorCode(await registry.execute("jobs.synthetic-write", { value: 9 }, context())), "idempotency-conflict");
  receipt = { committed: 7 };
  assert.equal((await registry.execute("jobs.synthetic-write", { value: 7 }, context())).ok, true); assert.equal(writes, 1); assert.equal(reads, 2);
  release.resolve(receipt);
});

test("committed writes recover from cached output schema, byte budget and internal failures without resubmission", async () => {
  for (const scenario of ["invalid-output", "budget-exceeded", "internal-error"] as const) {
    let writes = 0, reads = 0; let receipt: { committed: number } | undefined;
    const registry = createToolRegistry([defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic durable write with failed result", effect: "local-write", inputSchema, outputSchema,
      execute: () => {
        writes++; receipt = { committed: 7 };
        if (scenario === "internal-error") throw new Error("synthetic after-commit failure");
        return scenario === "invalid-output" ? { ...receipt, forbidden: true } : receipt;
      },
      recoverInterrupted: () => { reads++; return receipt; },
    })]);
    const first = await registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", scenario === "budget-exceeded" ? { budget: { requests: 0, timeoutMs: 5000, bytes: 12 } } : {}));
    assert.equal(errorCode(first), scenario);
    assert.equal(errorCode(await registry.execute("jobs.synthetic-write", { value: 8 }, context())), "idempotency-conflict"); assert.equal(reads, 0);
    assert.deepEqual(await registry.execute("jobs.synthetic-write", { value: 7 }, context()), { ok: true, requestId: "receipt-recovery-fixture", value: { committed: 7 } });
    assert.equal(writes, 1); assert.equal(reads, 1);
    assert.equal((await registry.execute("jobs.synthetic-write", { value: 7 }, context())).ok, true); assert.equal(reads, 1);
  }
});

test("concurrent receipt recoveries share one read and retain independent caller cancellation", async () => {
  const entered = deferred<void>(), release = deferred<{ committed: number }>(), recoveryEntered = deferred<void>(), recovered = deferred<{ committed: number }>(); let writes = 0, reads = 0;
  const registry = createToolRegistry([defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic durable write", effect: "local-write", inputSchema, outputSchema,
    execute: () => { writes++; entered.resolve(); return release.promise; }, recoverInterrupted: () => { reads++; recoveryEntered.resolve(); return recovered.promise; },
  })]);
  const original = new AbortController(); const first = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: original.signal }));
  await entered.promise; original.abort(); assert.equal(errorCode(await first), "cancelled");
  const retry = registry.execute("jobs.synthetic-write", { value: 7 }, context()); await recoveryEntered.promise;
  const cancelled = new AbortController(); const other = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { requestId: "other-retry", signal: cancelled.signal })); cancelled.abort();
  assert.equal(errorCode(await other), "cancelled"); recovered.resolve({ committed: 7 }); assert.equal((await retry).ok, true); assert.equal(writes, 1); assert.equal(reads, 1); release.resolve({ committed: 7 });
});

test("receipt recovery retains effect authorization, strict output validation and byte budget", async () => {
  for (const scenario of ["permission", "private-output", "bytes"] as const) {
    const entered = deferred<void>(), release = deferred<{ committed: number }>(); let reads = 0;
    const registry = createToolRegistry([defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic durable write", effect: "local-write", inputSchema, outputSchema,
      execute: () => { entered.resolve(); return release.promise; }, recoverInterrupted: () => { reads++; return scenario === "private-output" ? { committed: 7, privateResume: "synthetic-forbidden" } : { committed: 7 }; },
    })]);
    const original = new AbortController(); const first = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: original.signal }));
    await entered.promise; original.abort(); await first;
    const result = await registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", scenario === "permission" ? { allowedEffects: ["read-index"] } : scenario === "bytes" ? { budget: { requests: 0, timeoutMs: 5000, bytes: 12 } } : {}));
    assert.equal(errorCode(result), scenario === "permission" ? "not-authorized" : scenario === "private-output" ? "invalid-output" : "budget-exceeded");
    assert.equal(reads, scenario === "permission" ? 0 : 1); release.resolve({ committed: 7 });
  }
});

test("recovery callback has its own deadline and signal, and never replaces cancellation with late output", async () => {
  const entered = deferred<void>(), release = deferred<{ committed: number }>(), recoveryEntered = deferred<void>(), late = deferred<{ committed: number }>(); let recoverySignal: AbortSignal | undefined;
  const registry = createToolRegistry([defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic durable write", effect: "local-write", inputSchema, outputSchema,
    execute: () => { entered.resolve(); return release.promise; }, recoverInterrupted: (_input, ctx) => { recoverySignal = ctx.signal; recoveryEntered.resolve(); return late.promise; },
  })]);
  const firstAbort = new AbortController(); const first = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: firstAbort.signal })); await entered.promise; firstAbort.abort(); await first;
  const recoveryAbort = new AbortController(); const retry = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: recoveryAbort.signal })); await recoveryEntered.promise; recoveryAbort.abort();
  assert.equal(errorCode(await retry), "cancelled"); assert.equal(recoverySignal?.aborted, true);
  late.resolve({ committed: 7 }); release.resolve({ committed: 7 });
});

test("ordinary tools retain interrupted result caching and read effects cannot declare mutation recovery", async () => {
  let writes = 0; const entered = deferred<void>(), release = deferred<{ committed: number }>();
  const definition = defineTool({ name: "jobs.synthetic-write", version: 1, description: "Synthetic write without receipt support", effect: "local-write", inputSchema, outputSchema,
    execute: () => { writes++; entered.resolve(); return release.promise; } });
  const registry = createToolRegistry([definition]); const abort = new AbortController(); const first = registry.execute("jobs.synthetic-write", { value: 7 }, context("original-key", { signal: abort.signal })); await entered.promise; abort.abort();
  assert.equal(errorCode(await first), "cancelled"); assert.equal(errorCode(await registry.execute("jobs.synthetic-write", { value: 7 }, context())), "cancelled"); assert.equal(writes, 1);
  assert.throws(() => defineTool({ ...definition, effect: "read-index", recoverInterrupted: () => ({ committed: 7 }) })); release.resolve({ committed: 7 });
});
