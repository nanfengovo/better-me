import assert from "node:assert/strict";
import test from "node:test";
import { extractWorkingConditions } from "../src/components/atlas/job-working-conditions";
const context = { origin: "card-excerpt" as const, sourceUrl: "https://example.invalid/job/1", observedAt: "2026-10-31T00:00:00Z" };
test("work conditions are separate source-stated claims with literal quotes", () => {
  const claims = extractWorkingConditions("周末双休；每天8小时；混合办公；需要值班", context);
  assert.deepEqual(claims.map(claim => claim.value), ["双休", "日工时8小时", "混合办公", "加班／值班声明"]);
  assert.ok(claims.every(claim => claim.verification === "source-stated" && claim.sourceUrl === context.sourceUrl && claim.quote));
});
test("negation, historical claims, uncertainty and company labels never become promises", () => {
  for (const text of ["不保证双休", "非双休", "以前双休", "可能全远程", "不支持居家办公", "不居家办公", "不能远程办公", "非全远程", "不需要加班", "无需值班", "no hybrid working", "双休吗？", "955公司名单", "996公司", "not fully remote", "例如每天8小时"]) {
    assert.deepEqual(extractWorkingConditions(text, context), [], text);
  }
});
test("conflicting rest declarations remain separate and remote does not infer hours or country", () => {
  assert.deepEqual(extractWorkingConditions("双休；单休；全远程", context).map(claim => claim.value), ["双休", "单休", "全远程"]);
  assert.deepEqual(extractWorkingConditions("薪资20K，8年以上经验", context), []);
});
