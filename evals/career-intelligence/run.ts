import { createCareerIntelligenceGoldenFixtures, runCareerIntelligenceGoldenFixture } from "./fixtures.js";
import { runGoldenEvals } from "../../packages/core/src/career-intelligence/evals.js";
import { createLocalOllamaClient } from "../../apps/agent-host/src/privacy/local-ollama.js";
import { createLocalCommitteeReasoner } from "../../apps/agent-host/src/career-studio/committee-model.js";

const args = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]!, value = args[i + 1];
  if (!["--case", "--local-model", "--digest", "--debug-report"].includes(flag) || !value || value.startsWith("--") || options.has(flag)) throw new Error("Unknown, duplicate or missing eval option. Use --case ID or --local-model MODEL --digest SHA256; optional --debug-report true; no external/cloud fallback.");
  options.set(flag, value);
}
const model = options.get("--local-model"), digest = options.get("--digest"), caseId = options.get("--case");
const debugOption = options.get("--debug-report");
if (debugOption !== undefined && !["true", "false"].includes(debugOption)) throw new Error("--debug-report accepts true or false only.");
const debugReports: Array<{ id: string; report: unknown }> = [];
if (Boolean(model) !== Boolean(digest)) throw new Error("A real local eval requires explicit model AND exact installed digest.");
const all = await createCareerIntelligenceGoldenFixtures(), fixtures = caseId ? all.filter(f => f.id === caseId) : all;
if (!fixtures.length) throw new Error("Unknown Golden case.");
const client = model && digest ? createLocalOllamaClient({ model, expectedDigest: digest }) : undefined;
const summary = await runGoldenEvals(fixtures, { adapterId: client ? `real-local:${model}:${digest}` : "scripted-protocol-regression",
  run: async fixture => {
    const report = await runCareerIntelligenceGoldenFixture(fixture, client ? createLocalCommitteeReasoner(client, fixture.snapshot) : undefined);
    // These are repository-authored synthetic fixtures only. Public decisions,
    // guard issues and citation IDs help distinguish conservative model choices
    // from deterministic guard downgrades; no prompt, source bytes, credentials
    // or private model chain-of-thought is logged.
    if (debugOption === "true") debugReports.push({ id: fixture.id, report: { status: report.status, stopReason: report.stopReason,
      claims: report.claims.map(claim => ({ claimId: claim.claimId, support: claim.support, contribution: claim.contribution, risks: claim.risks, missing: claim.missing,
        questions: claim.questions, defense: claim.defense, citations: claim.citations.map(citation => ({ evidenceId: citation.evidenceId, startLine: citation.startLine, endLine: citation.endLine })) })),
      issues: report.issues, roles: report.roles.map(role => ({ role: role.role, stage: role.stage, issues: role.issues, error: role.error,
        decision: role.decision && { summary: role.decision.summary, claims: role.decision.claims.map(claim => ({ claimId: claim.claimId, support: claim.support, risks: claim.risks, missing: claim.missing })) } })) } });
    return report;
  },
});
console.log(JSON.stringify(debugOption === "true" ? { ...summary, debugReports } : summary, null, 2));
if (summary.cases.some(result => !result.passed)) process.exitCode = 1;
