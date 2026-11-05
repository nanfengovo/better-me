import { randomUUID } from "node:crypto";
import { DocumentSchema, type RecoveryDocument } from "@better-me/core/document";
import { FactBaseSchema, FactClaimSchema, createDefaultResumeView, projectResume, projectedResumeToMarkdown, scanClaim } from "@better-me/core/resume-business";
import type { CreateSyntheticResumeCommand, ResumeBusinessAsset, ResumeBusinessReceipt, ResumeChangeRequest, ResumeChangePreview,
  SaveResumeChangeCommand, WorkspaceEvidenceSnapshot, EvidenceChangeProposal, RevokeResumePreviewCommand } from "@better-me/agent-contracts";
import { IdentityError } from "../identity/service.js";
import { hash } from "../capabilities/verification.js";

const RULES = "resume-personal-evidence-v1";
// Match existing history semantics: timestamps alone do not change document content.
const contentHash = (document: RecoveryDocument) => hash(JSON.parse(JSON.stringify(document, (key, value) => key === "updatedAt" || key === "createdAt" ? undefined : value)));
const projection = (document: RecoveryDocument) => projectedResumeToMarkdown(projectResume(document.factBase, document.resumeViews.find(view => view.id === document.activeResumeId)!));
const fail = (status: number, code: string): never => { throw new IdentityError(status, code); };
export function resumeAsset(state: WorkspaceEvidenceSnapshot, id: string) {
  return state.resumeAssets?.find(asset => asset.id === id) ?? fail(404, "resume_asset_not_found");
}
function head(asset: ResumeBusinessAsset) {
  const version = asset.versions.find(item => item.id === asset.headVersionId) ?? fail(409, "resume_head_invalid");
  const document = DocumentSchema.parse(version.document);
  if (!asset.synthetic || document.documentId !== asset.id || contentHash(document) !== version.documentHash) fail(409, "resume_document_invalid");
  return { version, document };
}
export function priorResumeReceipt(state: WorkspaceEvidenceSnapshot, key: string, commandHash: string): ResumeBusinessReceipt | undefined {
  const receipt = state.resumeAssets?.flatMap(asset => [...asset.versions.map(version => version.receipt), ...asset.revocations]).find(item => item.key === key);
  if (receipt && receipt.commandHash !== commandHash) fail(409, "resume_idempotency_conflict");
  return receipt;
}
function append(asset: ResumeBusinessAsset, document: RecoveryDocument, receipt: ResumeBusinessReceipt) {
  const parsed = DocumentSchema.parse(document);
  asset.versions.push({ id: receipt.versionId, document: parsed, documentHash: contentHash(parsed), projection: projection(parsed), receipt });
  asset.headVersionId = receipt.versionId;
}
export function createSyntheticResume(state: WorkspaceEvidenceSnapshot, command: CreateSyntheticResumeCommand): ResumeBusinessAsset {
  const commandHash = hash({ kind: "create-synthetic-resume", ...command, expectedRevision: undefined });
  const existing = priorResumeReceipt(state, command.idempotencyKey, commandHash);
  if (existing) return resumeAsset(state, existing.assetId);
  if (state.revision !== command.expectedRevision) fail(409, "workspace_revision_conflict");
  const at = new Date().toISOString(), id = randomUUID();
  const factBase = FactBaseSchema.parse({ schemaVersion: 1, updatedAt: at,
    profile: { displayName: { zh: "合成候选人" }, headline: { zh: "合成后端工程师" } },
    experiences: ["缓存实验", "调度实验"].map((name, index) => ({ id: `synthetic-experience-${index + 1}`, type: "other", org: { zh: "合成实验室" },
      title: { zh: "合成项目维护者" }, projectName: { zh: name }, start: "2026-01", end: null,
      claims: [{ id: `synthetic-original-${index + 1}`, kind: "note", text: { zh: `${name}原有说明，必须保留。` } }] })) });
  const document = DocumentSchema.parse({ documentId: id, activeResumeId: "synthetic-resume", factBase,
    resumeViews: [{ ...createDefaultResumeView(factBase, at), id: "synthetic-resume", name: command.name, themeId: "forest-professional" }] });
  const asset: ResumeBusinessAsset = { id, name: command.name, synthetic: true, authorizationRevision: 0, headVersionId: "", versions: [], revocations: [],
    targets: document.factBase.experiences.map(item => ({ resumeId: document.activeResumeId, experienceId: item.id, label: `${command.name} / ${item.projectName!.zh}` })) };
  append(asset, document, { id: randomUUID(), key: command.idempotencyKey, commandHash, at, kind: "create", assetId: id, versionId: randomUUID() });
  (state.resumeAssets ??= []).push(asset); state.revision++; return asset;
}

export function prepareResumeChange(state: WorkspaceEvidenceSnapshot, request: ResumeChangeRequest, scope: string, proposal?: EvidenceChangeProposal) {
  const asset = resumeAsset(state, request.assetId), { version, document } = head(asset);
  if (request.expectedVersionId !== version.id) fail(409, "resume_version_conflict");
  const next = structuredClone(document), warnings = ["仅采用本人明确自述，不代表系统认证真实性。", "这是独立合成业务简历，不连接浏览器真实文档。"];
  let label: string, before: string, after: string, effect: Pick<ResumeBusinessReceipt, "proposalId" | "experienceId" | "claimId" | "claimHash" | "source" | "undoesReceiptId">;
  if (request.kind === "adopt") {
    if (!proposal || proposal.id !== request.proposalId) fail(404, "evidence_proposal_not_found");
    const activeAdoptions = asset.versions.map(item => item.receipt).filter(item => item.kind === "adopt" && item.proposalId === proposal!.id
      && !asset.versions.some(version => version.receipt.undoesReceiptId === item.id));
    if (activeAdoptions.length) fail(409, "proposal_already_adopted");
    const target = next.factBase.experiences.find(item => item.id === request.experienceId);
    const view = next.resumeViews.find(item => item.id === request.resumeId);
    if (!target || !view || !asset.targets.some(item => item.resumeId === request.resumeId && item.experienceId === request.experienceId)) fail(404, "resume_target_not_found");
    // First release is an explicitly created single-view Chinese document, not a hidden multi-resume update.
    if (next.resumeViews.length !== 1 || view!.locale !== "zh" || view!.claimSelection !== "all" || view!.experienceSelection !== "all") fail(409, "resume_target_not_supported");
    const candidate = proposal!.candidate, claimId = `evidence-${hash({ proposal: proposal!.id, asset: asset.id, version: version.id }).slice(0, 24)}`;
    const text = `${candidate.kind === "design" ? "仅设计（本人自述）" : "本人自述实现"}：${candidate.action}${candidate.role ? `\n职责：${candidate.role}` : ""}${candidate.deployment ? `\n实际阶段：${candidate.deployment}` : ""}`;
    const claim = FactClaimSchema.parse({ id: claimId, kind: "action", text: { zh: text }, tags: ["本人核对", candidate.kind === "design" ? "仅设计" : "本人实现"] });
    if (next.factBase.experiences.some(item => item.claims.some(entry => entry.id === claimId))) fail(409, "resume_claim_conflict");
    target!.claims.push(claim); warnings.push(...scanClaim(claim, target!.id).map(issue => issue.message));
    label = `新增要点 · ${target!.projectName?.zh ?? target!.org.zh}`; before = "不新增要点，原有内容保持"; after = text;
    effect = { proposalId: proposal!.id, experienceId: target!.id, claimId, claimHash: hash(claim), source: structuredClone(proposal!.source) };
  } else {
    const adopted = asset.versions.map(item => item.receipt).find(item => item.id === request.adoptionReceiptId && item.kind === "adopt") ?? fail(404, "adoption_receipt_not_found");
    if (asset.versions.some(item => item.receipt.undoesReceiptId === adopted.id)) fail(409, "adoption_already_undone");
    const target = next.factBase.experiences.find(item => item.id === adopted.experienceId), claim = target?.claims.find(item => item.id === adopted.claimId);
    if (!target || !claim || hash(claim) !== adopted.claimHash) fail(409, "adopted_claim_changed_recompare_required");
    // A compensating change removes only the exact adopted claim, never restores a whole old document.
    target!.claims = target!.claims.filter(item => item.id !== adopted.claimId);
    label = `撤销本次采用 · ${target!.projectName?.zh ?? target!.org.zh}`; before = claim!.text.zh; after = "仅移除本次采用的要点，其余当前内容保持";
    effect = { undoesReceiptId: adopted.id, experienceId: adopted.experienceId, claimId: adopted.claimId };
  }
  DocumentSchema.parse(next);
  const preview: ResumeChangePreview = { request, authorizationRevision: asset.authorizationRevision, beforeHash: version.documentHash,
    afterHash: contentHash(next), hash: hash({ rules: RULES, scope, request, authorizationRevision: asset.authorizationRevision,
      beforeHash: version.documentHash, afterHash: contentHash(next), source: proposal?.source, candidate: proposal?.candidate }),
    diff: [{ label, before, after }], beforeProjection: version.projection, afterProjection: projection(next), warnings };
  return { preview, next, effect };
}
export function savePreparedResumeChange(state: WorkspaceEvidenceSnapshot, command: SaveResumeChangeCommand, prepared: ReturnType<typeof prepareResumeChange>): ResumeBusinessReceipt {
  if (prepared.preview.hash !== command.previewHash) fail(409, "resume_preview_invalidated");
  const asset = resumeAsset(state, command.preview.assetId), at = new Date().toISOString(), document = prepared.next;
  document.factBase.updatedAt = at; document.resumeViews[0]!.updatedAt = at;
  const receipt: ResumeBusinessReceipt = { id: randomUUID(), key: command.idempotencyKey, commandHash: hash({ kind: "save-resume-change", ...command }),
    at, kind: command.preview.kind, assetId: asset.id, versionId: randomUUID(), previousVersionId: asset.headVersionId, ...prepared.effect };
  append(asset, document, receipt); state.revision++; return receipt;
}
export function revokeResumePreview(state: WorkspaceEvidenceSnapshot, command: RevokeResumePreviewCommand): ResumeBusinessReceipt {
  const commandHash = hash({ kind: "revoke-resume-preview", ...command, expectedAuthorizationRevision: undefined });
  const saved = priorResumeReceipt(state, command.idempotencyKey, commandHash); if (saved) return saved;
  const asset = resumeAsset(state, command.assetId);
  if (asset.authorizationRevision !== command.expectedAuthorizationRevision) fail(409, "resume_authorization_conflict");
  const receipt: ResumeBusinessReceipt = { id: randomUUID(), key: command.idempotencyKey, commandHash, at: new Date().toISOString(), kind: "revoke-preview", assetId: asset.id, versionId: asset.headVersionId };
  asset.authorizationRevision++; asset.revocations.push(receipt); state.revision++; return receipt;
}
