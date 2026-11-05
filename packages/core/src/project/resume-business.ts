/** Pure business-document entry point: usable by Host without importing AI clients. */
export { FactBaseSchema, FactClaimSchema } from "../schema/fact.js";
export { createDefaultResumeView, projectResume } from "./resume-projection.js";
export { projectedResumeToMarkdown } from "./markdown-export.js";
export { scanClaim } from "../validation/claims.js";
