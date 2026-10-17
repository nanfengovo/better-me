import test from "node:test";
import assert from "node:assert/strict";
import { formatVersionTime } from "../src/components/VersionHistoryPanel.tsx";

test("history timestamps use the client Asia/Shanghai timezone including date rollover", () => {
  assert.equal(formatVersionTime("2026-10-17T10:30:00.000Z"), "2026/10/17 18:30:00");
  assert.equal(formatVersionTime("2026-10-17T18:30:00.000Z"), "2026/10/18 02:30:00");
});
