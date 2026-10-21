import { AtlasDatasetSchema, type AtlasDataset } from "@better-me/opportunities";
import { createAtlasDemo } from "../../src/components/atlas/demo.ts";

export const companyControlAt = "2026-10-21T12:00:00.000Z";
export const companyControlJobId = "demo-0";
export const companyControlCompanyId = "demo-company-0";
export const companyControlJobIds = ["demo-0", "demo-12"];
export const companyControlReason = "Synthetic evidence reviewed for a real HTTP integration test; no actual company claim.";
const legalEntityName = "Synthetic Controls (China) Co., Ltd.";
const controllerName = "Synthetic Controls Holding SE";
const quotes = {
  legalEntityName: `Actual hiring employer: ${legalEntityName}.`,
  status: "Control assessment: resolved.",
  controlMode: "Control mode: single controller.",
  controllerName,
  controllerControl: `${controllerName} wholly owns and ultimately controls ${legalEntityName}.`,
  controllerKind: "The controlling entity is privately controlled.",
  controllerJurisdiction: "The controlling origin is Germany (DE).",
};

export const companyControlProposal = {
  basis: "manual-evidence-review" as const,
  documents: [{
    sourceUrl: "https://company-control.example.invalid/synthetic-public-report",
    retrievedAt: "2026-10-20T10:00:00.000Z",
    rawText: ["SYNTHETIC EVIDENCE. No real employer or shareholder is represented.", ...Object.values(quotes)].join("\n"),
  }],
  legalEntityName,
  status: "resolved" as const,
  controlMode: "single" as const,
  controllers: [{ name: controllerName, kind: "private" as const, jurisdictionCode: "DE" }],
  supports: Object.entries(quotes).map(([field, quote]) => ({
    field: field as keyof typeof quotes,
    documentIndex: 0,
    quote,
    ...(field.startsWith("controller") ? { controllerIndex: 0 } : {}),
  })),
};

export function companyControlDataset(): AtlasDataset {
  const data = createAtlasDemo();
  data.revision = 0;
  for (const company of data.companies) {
    company.ultimateControllers = { value: [], evidence: [], method: "source-structured", verification: "unknown", revision: 0 };
    company.manualOverrides = [];
  }
  data.companies.find(company => company.id === companyControlCompanyId)!.names = ["Synthetic Controls employer"];
  return AtlasDatasetSchema.parse(data);
}
