import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

test("oversized constrained collections fail before visiting untrusted elements", () => {
  let visits = 0;
  const element = z.string().transform(value => { visits++; return value; });
  const result = z.array(element).max(2).safeParse(Array(1000).fill("synthetic"));
  assert.equal(result.success, false);
  assert.equal(visits, 0, "length bound must precede per-element allocations");
  assert.equal(result.error.issues.length, 1);
});
