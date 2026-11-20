import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InterviewFollowUpSummary } from "../src/components/InterviewFollowUpSummary";

Object.assign(globalThis, { React });

test("retest progress counts due practice separately from a learner's assessment", () => {
  const completed = {
    path: "practice", retestDueAt: "2000-01-01T00:00:00Z", retestAt: "2000-01-02T12:00:00Z", independent: true, assessment: "met",
  } as const;
  const html = renderToStaticMarkup(<InterviewFollowUpSummary items={[
    completed,
    { ...completed, retestAt: null, assessment: null },
    { ...completed, assessment: null },
    { ...completed, assessment: "retry" },
    { ...completed, independent: false },
    { ...completed, retestDueAt: "2100-01-01T00:00:00Z", retestAt: null, assessment: null },
    { ...completed, path: "facts" },
    { ...completed, path: "defer" },
    { ...completed, retestDueAt: null },
  ]}/>);
  assert.match(html, /到期复测已提交 4\/5 项/);
  assert.match(html, /2 项本人确认达到原定标准（1 项独立作答），1 项待本人核对/);
  assert.equal(renderToStaticMarkup(<InterviewFollowUpSummary items={[]}/>), "");
});
