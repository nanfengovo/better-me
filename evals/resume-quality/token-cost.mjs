import { createRequire } from "node:module";

const { z } = createRequire(new URL("../../packages/core/package.json", import.meta.url))("zod");
export const rateCard = z.object({
  provider: z.string().min(1), model: z.string().min(1), revision: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(),
}).strict();

/** A caller-supplied flat token tariff. Invoices and unmetered calls cannot be inferred. */
export function estimateTokenCost(rawRates, collection) {
  const rates = rateCard.parse(rawRates);
  const { metadata, runtimeQuality } = collection;
  if (metadata.execution !== "model" || rates.provider !== metadata.provider || rates.model !== metadata.id
    || rates.revision !== metadata.revision) throw Error("rate_card_model_mismatch");
  const { pairedTokens, tokenCoverage } = runtimeQuality.providerUsage;
  const { ledgerCoverage } = runtimeQuality;
  if (tokenCoverage.numerator > 0 && ![pairedTokens?.inputTokens, pairedTokens?.outputTokens]
    .every(n => Number.isSafeInteger(n) && n >= 0)) throw Error("incomplete_paired_token_counts");
  const subtotal = tokenCoverage.numerator > 0
    ? (pairedTokens.inputTokens * rates.inputPerMillion + pairedTokens.outputTokens * rates.outputPerMillion) / 1_000_000
    : null;
  if (subtotal !== null && !Number.isFinite(subtotal)) throw Error("invalid_token_cost");
  const complete = subtotal !== null && tokenCoverage.numerator === tokenCoverage.denominator
    && ledgerCoverage.numerator === collection.planned && collection.unresolved === 0;
  return { rates, coveredCalls: tokenCoverage.numerator, registeredCalls: tokenCoverage.denominator,
    observedTokenEstimate: subtotal, fullCampaignTokenEstimate: complete ? subtotal : null, billedAmount: null };
}
