import { applyCompanyControlReviewConfirmation, buildCompanyControlReviewMaterials, captureCompanyControlReviewSourceBinding,
  projectCompanyControlReviews, validateCompanyControlReviewProposal, type CompanyControlReviewConfirmation, type CompanyControlReviewReadResult,
  type CompanyControlReviewPreview, type CompanyControlReviewReceipt } from "@better-me/opportunities";
import { companyControlAt, companyControlCompanyId, companyControlDataset, companyControlJobId, companyControlJobIds,
  companyControlProposal, companyControlReason } from "./atlas-company-control.ts";

export const companyData = companyControlDataset();
export const companySource = companyData.companies.find(company => company.id === companyControlCompanyId)!;
export const companyRead: CompanyControlReviewReadResult = { schemaVersion: 1, revision: 0, jobId: companyControlJobId, companyId: companyControlCompanyId,
  sourceCompany: companySource, current: companySource, affectedJobIds: companyControlJobIds, history: [] };
export const companyPreview: CompanyControlReviewPreview = { expectedRevision: 0, previewFingerprint: "a".repeat(64), jobId: companyControlJobId,
  companyId: companyControlCompanyId, sourceCompany: companySource, current: companySource, affectedJobIds: companyControlJobIds, warnings: [],
  proposed: validateCompanyControlReviewProposal(companyData, { jobId: companyControlJobId, companyId: companyControlCompanyId, sourceCompany: companySource, proposal: companyControlProposal }) };
export const companyDecision: CompanyControlReviewConfirmation = { id: "synthetic-company-control-confirm", kind: "confirm", jobId: companyControlJobId,
  companyId: companyControlCompanyId, actorScope: "synthetic-company-review-ui", at: companyControlAt, revision: 1, reason: companyControlReason,
  sourceCompany: companySource, sourceBinding: captureCompanyControlReviewSourceBinding(companyData, { jobId: companyControlJobId, companyId: companyControlCompanyId, sourceCompany: companySource }),
  proposal: companyControlProposal, materials: await buildCompanyControlReviewMaterials(companyControlProposal, { now: companyControlAt }), affectedJobIds: companyControlJobIds };
export const companyEffective = applyCompanyControlReviewConfirmation(companySource, companyDecision);
export const companyReceipt: CompanyControlReviewReceipt = { ok: true, revision: 1, jobId: companyControlJobId, companyId: companyControlCompanyId,
  decisionId: companyDecision.id, activeDecisionId: companyDecision.id, company: companyEffective, affectedJobIds: companyControlJobIds };
export const companySavedData = projectCompanyControlReviews({ ...companyData, revision: 1 }, [companyDecision]);
export const companySavedRead: CompanyControlReviewReadResult = { ...companyRead, revision: 1, current: companyEffective, activeDecisionId: companyDecision.id, history: [companyDecision] };
