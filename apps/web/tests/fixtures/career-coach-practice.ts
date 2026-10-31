// Synthetic learner submission for the opt-in real-model acceptance run.
// This is not a user project, resume fact, or production task-state implementation.
import assert from "node:assert/strict";
import test from "node:test";

type State = "todo" | "doing" | "done";
type Result = { ok: true; state: State } | { ok: false; state: State; error: "illegal_transition" };
const allowed: Record<State, readonly State[]> = { todo: ["doing"], doing: ["done"], done: [] };
export function transition(current: State, next: State): Result {
  if (current === next || allowed[current].includes(next)) return { ok: true, state: next };
  return { ok: false, state: current, error: "illegal_transition" };
}

const expected: Record<State, readonly State[]> = { todo: ["todo", "doing"], doing: ["doing", "done"], done: ["done"] };
for (const current of ["todo", "doing", "done"] as const) {
  for (const next of ["todo", "doing", "done"] as const) {
    test(`synthetic exercise ${current} -> ${next}`, () => {
      const result = transition(current, next);
      const ok = expected[current].includes(next);
      assert.equal(result.ok, ok);
      assert.equal(result.state, ok ? next : current);
      if (!result.ok) assert.equal(result.error, "illegal_transition");
    });
  }
}
