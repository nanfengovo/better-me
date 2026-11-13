import type { InstalledMicroApp, OfferBackcheckProjection } from "./micro-app-registry";

// No ambient library reads. The caller must supply the records the user selected
// for this instance; granting selected_offers does not grant communication notes.
export function sandboxOfferProjection(scopes: InstalledMicroApp["grantedScopes"], selected?: OfferBackcheckProjection[]) {
  if (!scopes.includes("selected_offers") || !selected) return [];
  return selected.slice(0, 20).map(o => {
    const { id, company, role, nominalAnnualWan, monthlyBaseK, months, providentFundRate, commuteMinutes, scheduleText, weeklyHours, bonusRealizationRate } = o;
    return { id,company,role,nominalAnnualWan,monthlyBaseK,months,providentFundRate,commuteMinutes,scheduleText,weeklyHours,bonusRealizationRate,
      ...(scopes.includes("backcheck_summary")?{tier1Compliance:o.tier1Compliance,tier2Business:o.tier2Business,tier3Sentiment:o.tier3Sentiment,sampleCount:o.sampleCount}:{}) };
  });
}
