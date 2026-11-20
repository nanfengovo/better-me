import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokenCost } from "./token-cost.mjs";

const rates = { provider: "fixture-provider", model: "sample", revision: "r1", currency: "CNY", inputPerMillion: 1, outputPerMillion: 4 };
const receipt = {
  metadata: { execution: "model", provider: rates.provider, id: rates.model, revision: rates.revision },
  planned: 2, unresolved: 0,
  runtimeQuality: { ledgerCoverage: { numerator: 2, denominator: 2 },
    providerUsage: { tokenCoverage: { numerator: 2, denominator: 2 }, pairedTokens: { inputTokens: 1_000_000, outputTokens: 500_000 } } },
};

test("a supplied flat token rate applies only to the named model revision and fully metered calls", () => {
  const estimate = estimateTokenCost(rates, receipt);
  assert.equal(estimate.observedTokenEstimate, 3);
  assert.equal(estimate.fullCampaignTokenEstimate, 3);
  assert.equal(estimate.billedAmount, null);
  const part = structuredClone(receipt);
  part.runtimeQuality.providerUsage.tokenCoverage.denominator++;
  assert.equal(estimateTokenCost(rates, part).observedTokenEstimate, 3);
  assert.equal(estimateTokenCost(rates, part).fullCampaignTokenEstimate, null);
  assert.equal(estimateTokenCost(rates, { ...receipt, unresolved: 1 }).fullCampaignTokenEstimate, null);
  part.runtimeQuality.providerUsage.tokenCoverage.numerator = 0;
  assert.equal(estimateTokenCost(rates, part).observedTokenEstimate, null);
  assert.equal(estimateTokenCost({ ...rates, inputPerMillion: 0, outputPerMillion: 0 }, receipt).fullCampaignTokenEstimate, 0);
  assert.throws(() => estimateTokenCost({ ...rates, model: "another" }, receipt), /model_mismatch/);
  assert.throws(() => estimateTokenCost({ ...rates, inputPerMillion: -1 }, receipt));
  assert.throws(() => estimateTokenCost(rates, { ...receipt, metadata: { ...receipt.metadata, execution: "scripted_fixture" } }), /model_mismatch/);
});
