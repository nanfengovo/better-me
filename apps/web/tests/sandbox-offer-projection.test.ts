import assert from "node:assert/strict";
import test from "node:test";
import { sandboxOfferProjection } from "../src/lib/sandbox-offer-projection";
import type { OfferBackcheckProjection } from "../src/lib/micro-app-registry";

test("a sandbox scope is not record selection, and selected offers do not implicitly include notes",()=>{
  const offer:OfferBackcheckProjection={id:"synthetic-id",company:"Example",role:"Test",nominalAnnualWan:10,monthlyBaseK:8,
    months:12,providentFundRate:.1,commuteMinutes:20,scheduleText:"9–5",weeklyHours:40,bonusRealizationRate:.9,
    tier1Compliance:"example",tier2Business:"example",tier3Sentiment:"SYNTHETIC-PRIVATE-NOTES",sampleCount:2,directionMatch:"SYNTHETIC-NEXT-ACTION"};
  assert.deepEqual(sandboxOfferProjection(["selected_offers"]),[]);
  assert.deepEqual(sandboxOfferProjection(["backcheck_summary"],[offer]),[]);
  const read=sandboxOfferProjection(["selected_offers"],[offer]);
  assert.equal(read[0]?.id,offer.id);assert.doesNotMatch(JSON.stringify(read),/SYNTHETIC-/);
  const reviewed=sandboxOfferProjection(["selected_offers","backcheck_summary"],[offer]);
  assert.match(JSON.stringify(reviewed),/SYNTHETIC-PRIVATE-NOTES/);
  assert.doesNotMatch(JSON.stringify(reviewed),/NEXT-ACTION/);
});
