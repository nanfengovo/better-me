import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanyControlReviewProposalSchema, ConfirmCompanyControlReviewInputSchema,
  activeCompanyControlReviewDecision, applyCompanyControlReviewConfirmation, buildCompanyControlReviewMaterials,
  captureCompanyControlReviewSourceBinding, getInvalidatedCompanyControlReviewIds, isCompanyControlReviewEntityId,
  projectCompanyControlReviews, sameCompanyControlReviewValue, stripCompanyControlReviewProjection,
  validateCompanyControlReviewHistory, validateCompanyControlReviewProposal,
  type CompanyControlReviewConfirmation, type CompanyControlReviewDecision, type CompanyControlReviewProposal,
} from "../src/company-control-review.js";
import { AtlasDatasetSchema, CompanySchema, type AtlasDataset } from "../src/schema.js";
import { classifyCompany, CompanyClassificationSchema, effectiveCompanyControllers, resolveCompanyColor } from "../src/colors.js";

const at = "2026-10-21T12:00:00Z";
const sourceAt = "2026-10-20T12:00:00Z";
const url = "https://disclosures.example.test/annual-report";
const rawText = "Synthetic Employer Ltd. is a subsidiary of Synthetic Parent Group. Its ultimate controlling owner is Synthetic Holding, a privately controlled German company. The registered employer office is in China. These are synthetic fixtures, not real corporate facts.";
function base(): AtlasDataset {
  const company = { id: "company.one", names: ["Synthetic brand"], domains: ["example.test"], parentCompanyIds: [], manualOverrides: [], ultimateControllers: { value: [], evidence: [], method: "manual", verification: "unknown", revision: 0 } };
  const job = { id: "job.one", companyId: company.id, title: { value: "Synthetic engineer", evidence: [], method: "manual", verification: "unverified", revision: 0 }, description: "Synthetic job", locationIds: [], compensationIds: [], listingIds: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], status: "open", revision: 0, updatedAt: sourceAt };
  return AtlasDatasetSchema.parse({ schemaVersion: 1, revision: 20, companies: [company, { ...company, id: "company.other" }], jobs: [job, { ...job, id: "job.two" }, { ...job, id: "job.other", companyId: "company.other" }], sources: [], listings: [], observations: [], snapshots: [], locations: [], compensations: [] });
}
function proposal(overrides: Partial<CompanyControlReviewProposal> = {}): CompanyControlReviewProposal {
  const fields = { basis: "manual-evidence-review" as const, documents: [{ sourceUrl: url, retrievedAt: sourceAt, rawText }], legalEntityName: "Synthetic Employer Ltd.", parentCompanyName: "Synthetic Parent Group", status: "resolved" as const, controlMode: "single" as const, controllers: [{ name: "Synthetic Holding", kind: "private" as const, jurisdictionCode: "DE" }], ...overrides };
  const supports: CompanyControlReviewProposal["supports"] = ["legalEntityName", "parentCompanyName", "status", "controlMode"].filter(field => field !== "parentCompanyName" || !!fields.parentCompanyName).map(field => ({ field: field as "legalEntityName", documentIndex: 0, quote: fields.documents[0]!.rawText }));
  fields.controllers.forEach((controller, controllerIndex) => {
    for (const field of ["controllerName", "controllerKind", "controllerControl", ...(controller.jurisdictionCode ? ["controllerJurisdiction"] : [])]) supports.push({ field: field as "controllerName", documentIndex: 0, quote: fields.documents[0]!.rawText, controllerIndex });
  });
  return CompanyControlReviewProposalSchema.parse({ ...fields, supports: overrides.supports ?? supports });
}
async function confirmation(dataset = base(), proposed = proposal(), revision = 10, id = "review.one"): Promise<CompanyControlReviewConfirmation> {
  const sourceCompany = structuredClone(dataset.companies[0]!);
  return { id, kind: "confirm", at, actorScope: "local.user", revision, reason: "本人核对引用原文和控制关系；非发布机构认证。", jobId: "job.one", companyId: sourceCompany.id, affectedJobIds: dataset.jobs.filter(job => job.companyId === sourceCompany.id).map(job => job.id), sourceCompany, sourceBinding: captureCompanyControlReviewSourceBinding(dataset, { jobId: "job.one", companyId: sourceCompany.id, sourceCompany }), proposal: proposed, materials: await buildCompanyControlReviewMaterials(proposed, { now: at }) };
}
function revocation(dataset: AtlasDataset, target: CompanyControlReviewConfirmation, revision = 11): CompanyControlReviewDecision {
  return { id: "revoke.one", kind: "revoke", at, actorScope: target.actorScope, revision, reason: "撤回本人的核对", jobId: "job.two", companyId: target.companyId, affectedJobIds: ["job.one", "job.two"], targetDecisionId: target.id, sourceCompany: structuredClone(dataset.companies[0]!), sourceBinding: captureCompanyControlReviewSourceBinding(dataset, { jobId: "job.two", companyId: target.companyId, sourceCompany: dataset.companies[0]! }) };
}

test("company review requires every actual field and every controller relationship to cite retained exact text", () => {
  const value = proposal();
  assert.equal(ConfirmCompanyControlReviewInputSchema.safeParse({ jobId: "job.one", companyId: "company.one", expectedRevision: 20, reason: "review", proposal: value, previewFingerprint: "a".repeat(64), reviewed: true }).success, true);
  for (const field of ["legalEntityName", "parentCompanyName", "status", "controlMode", "controllerName", "controllerKind", "controllerControl", "controllerJurisdiction"]) {
    assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...value, supports: value.supports.filter(support => support.field !== field) }).success, false, field);
  }
  assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...value, supports: [...value.supports, { field: "controllerName", documentIndex: 0, quote: "Not present", controllerIndex: 0 }] }).success, false);
  assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...value, supports: [...value.supports, { field: "controllerName", documentIndex: 0, quote: rawText, controllerIndex: 1 }] }).success, false);
  assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...value, css: "red" }).success, false);
  assert.equal(ConfirmCompanyControlReviewInputSchema.safeParse({ jobId: "job.one", companyId: "company.one", expectedRevision: 20, reason: "review", proposal: value, previewFingerprint: "a".repeat(64), reviewed: false }).success, false);
});

test("document byte budgets, URL credentials and malformed Unicode are rejected without altering the raw text", async () => {
  const unicode = proposal({ documents: [{ sourceUrl: url, retrievedAt: sourceAt, rawText: "合成公开材料 😀\r\n逐字保留" }] });
  assert.equal((await buildCompanyControlReviewMaterials(unicode, { now: at }))[0]!.rawText, unicode.documents[0]!.rawText);
  const value = proposal();
  for (const raw of ["汉".repeat(100_000), "\uD800", "test\u0000text"]) assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...value, documents: [{ sourceUrl: url, retrievedAt: sourceAt, rawText: raw }] }).success, false);
  assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...value, documents: [{ ...value.documents[0], sourceUrl: "https://user:secret@example.test/doc" }] }).success, false);
  await assert.rejects(buildCompanyControlReviewMaterials(proposal({ documents: [{ sourceUrl: url, retrievedAt: "2026-10-22T12:00:00Z", rawText }] }), { now: at }), /future-company/);
});

test("a review changes only the specified company and supplies real reference-closed company-directory materials", async () => {
  const dataset = base(); const original = structuredClone(dataset); const decision = await confirmation(dataset);
  const projected = projectCompanyControlReviews(dataset, [decision]);
  assert.deepEqual(dataset, original);
  assert.deepEqual(projected.jobs, dataset.jobs);
  assert.deepEqual(projected.snapshots, []);
  assert.deepEqual(projected.companies[1], dataset.companies[1]);
  assert.equal(classifyCompany(projected.companies[0]!).jurisdictions[0], "DE");
  assert.equal(resolveCompanyColor(projected.companies[0]!).ruleId, "de-fr");
  assert.equal(projected.companies[0]!.controlReview!.method, "manual-evidence-review");
  assert.equal(projected.companies[0]!.controlReview!.parentCompanyName, "Synthetic Parent Group");
  assert.equal(projected.companies[0]!.parentCompanyIds.length, 0, "a parent name never invents a company entity");
  assert.equal(projected.sources[0]!.entityType, "company-directory");
  assert.equal(projected.sources[0]!.enabled, false);
  assert.deepEqual(projected.sources[0]!.capabilities, []);
  assert.equal(projected.listings[0]!.canonicalJobId, undefined);
  assert.equal(projected.observations[0]!.contentHash, decision.materials[0]!.contentHash);
  assert.equal(projected.observations[0]!.availability, "unknown");
  assert.equal(AtlasDatasetSchema.safeParse(projected).success, true);
  assert.deepEqual(stripCompanyControlReviewProjection(projected, [decision]), dataset);
  assert.deepEqual(projectCompanyControlReviews(projected, [decision]), projected, "projection is idempotent");
});

test("only an existing exact job and company binding may be reviewed, never a matching brand", () => {
  const dataset = base(); const sourceCompany = dataset.companies[0]!;
  assert.throws(() => validateCompanyControlReviewProposal(dataset, { jobId: "job.other", companyId: sourceCompany.id, sourceCompany, proposal: proposal() }), /source/);
  assert.throws(() => validateCompanyControlReviewProposal(dataset, { jobId: "job.absent", companyId: sourceCompany.id, sourceCompany, proposal: proposal() }), /source/);
  const proposed = validateCompanyControlReviewProposal(dataset, { jobId: "job.one", companyId: sourceCompany.id, sourceCompany, proposal: proposal() });
  assert.equal(proposed.controlReview!.decisionId, "company-control-review-preview");
});

test("explicit joint control keeps all controllers and all countries, and no actual controller invents no person or jurisdiction", async () => {
  const dataset = base();
  const joint = await confirmation(dataset, proposal({ controlMode: "joint", controllers: [{ name: "Synthetic First", kind: "private", jurisdictionCode: "DE" }, { name: "Synthetic Second", kind: "state", jurisdictionCode: "CN" }] }));
  const company = projectCompanyControlReviews(dataset, [joint]).companies[0]!;
  assert.deepEqual(classifyCompany(company), { status: "verified", ownership: "joint", jurisdictions: ["CN", "DE"], controllerNames: ["Synthetic First", "Synthetic Second"], jointControl: true, jurisdictionComplete: true });
  assert.equal(resolveCompanyColor(company).ruleId, "joint");
  const dispersed = await confirmation(dataset, proposal({ controlMode: "dispersed", controllers: [], documents: [{ sourceUrl: url, retrievedAt: sourceAt, rawText: "Synthetic Employer Ltd. expressly discloses no actual controller. Its group parent name does not establish an ultimate controlling party." }] }));
  const facts = classifyCompany(projectCompanyControlReviews(dataset, [dispersed]).companies[0]!);
  assert.deepEqual(facts, { status: "verified", ownership: "dispersed", jurisdictions: [], controllerNames: [], jointControl: false, jurisdictionComplete: false });
  assert.equal(CompanyClassificationSchema.safeParse(facts).success, true);
  assert.equal(CompanyClassificationSchema.safeParse({ ...facts, controllerNames: ["Invented controlling party"] }).success, false);
  assert.equal(CompanyClassificationSchema.safeParse({ ...facts, jurisdictions: ["CN"] }).success, false);
  const legacy = structuredClone(company);
  delete legacy.controlReview;
  legacy.ultimateControllers.value = [{ name: "A listed group is not necessarily a controller", kind: "dispersed", jurisdictionCode: "CN" }];
  assert.deepEqual(classifyCompany(legacy), facts, "legacy no-controller disclosures also cannot turn registration into control origin");
  assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...proposal(), controlMode: "dispersed" }).success, false);
  assert.equal(CompanyControlReviewProposalSchema.safeParse({ ...proposal(), controlMode: "joint" }).success, false);
});

test("only latest effective cited materials enter public datasets; a revocation may restore the prior live review", async () => {
  const dataset = base(); const first = await confirmation(dataset); const next = await confirmation(dataset, proposal({ documents: [{ sourceUrl: "https://disclosures.example.test/new-report", retrievedAt: sourceAt, rawText: `${rawText}\nA later personal interpretation.` }] }), 11, "review.two");
  const projected = projectCompanyControlReviews(dataset, [first, next]);
  assert.equal(projected.observations.length, 1);
  assert.equal(projected.listings[0]!.canonicalUrl, next.materials[0]!.sourceUrl);
  assert.equal(projected.companies[0]!.controlReview!.decisionId, next.id);
  const revoke = revocation(dataset, next, 12);
  const restored = projectCompanyControlReviews(projected, [first, next, revoke]);
  assert.equal(restored.observations.length, 1);
  assert.equal(restored.listings[0]!.canonicalUrl, first.materials[0]!.sourceUrl);
  assert.equal(restored.companies[0]!.controlReview!.decisionId, first.id);
  assert.equal(next.materials[0]!.rawText.endsWith("A later personal interpretation."), true);
});

test("unknown and conflicting disclosures stay unclassified after an explicit personal review", async () => {
  for (const status of ["unknown", "conflicting"] as const) {
    const dataset = base(); const decision = await confirmation(dataset, proposal({ status, controlMode: "unknown", controllers: [] }));
    const current = projectCompanyControlReviews(dataset, [decision]).companies[0]!;
    assert.equal(current.controlReview!.status, status);
    assert.deepEqual(classifyCompany(current), { status, ownership: "unknown", jurisdictions: [], controllerNames: [], jointControl: false, jurisdictionComplete: false });
    assert.equal(current.legalEntity!.verification, "verified", "a reviewed employer name does not resolve its control");
  }
});

test("legacy manual controller overrides are preserved but cannot conceal the effective personal review", async () => {
  const dataset = base();
  const seed = await confirmation(dataset); const materials = projectCompanyControlReviews(dataset, [seed]);
  const source = { ...materials.sources[0]!, sourceId: "source.legacy", adapterId: "synthetic" };
  dataset.sources = [source]; dataset.listings = [{ ...materials.listings[0]!, id: "listing.legacy", sourceId: source.sourceId, observationIds: ["observation.legacy"] }];
  dataset.observations = [{ ...materials.observations[0]!, id: "observation.legacy", listingId: "listing.legacy" }];
  dataset.companies[0]!.manualOverrides.push({ id: "legacy.override", field: "ultimateControllers", reason: "An older manual interpretation", at: sourceAt, basedOnRevision: 0, value: { value: [{ name: "Legacy Holding", kind: "private", jurisdictionCode: "US" }], method: "manual", verification: "verified", revision: 1, evidence: [{ observationId: "observation.legacy", sourceUrl: url, quote: rawText, observedAt: sourceAt }] } });
  assert.equal(classifyCompany(dataset.companies[0]!).jurisdictions[0], "US");
  const decision = await confirmation(dataset); const current = projectCompanyControlReviews(dataset, [decision]).companies[0]!;
  assert.deepEqual(current.manualOverrides, dataset.companies[0]!.manualOverrides);
  assert.equal(effectiveCompanyControllers(current).value[0]!.jurisdictionCode, "DE");
  const changed = structuredClone(dataset); changed.observations[0]!.rawText = "Replaced disclosure";
  assert.deepEqual(getInvalidatedCompanyControlReviewIds(changed, [decision]), [decision.id]);
});

test("alias additions, new same-company jobs and unrelated job edits do not invalidate a reviewed employer", async () => {
  const dataset = base(); const decision = await confirmation(dataset); const changed = structuredClone(dataset);
  changed.companies[0]!.names.push("Synthetic alias"); changed.companies[0]!.domains.push("new.example.test");
  changed.jobs[0]!.description = "Updated JD and salary discussion";
  changed.jobs.push({ ...changed.jobs[1]!, id: "job.new" });
  assert.deepEqual(getInvalidatedCompanyControlReviewIds(changed, [decision]), []);
  const current = projectCompanyControlReviews(changed, [decision]);
  assert.equal(current.companies[0]!.names.includes("Synthetic alias"), true);
  assert.deepEqual(decision.affectedJobIds, ["job.one", "job.two"], "the original receipt scope is stable");
});

test("source identity/control changes are invalidated permanently so A to B to A cannot resurrect a decision", async () => {
  const dataset = base(); const decision = await confirmation(dataset);
  const mutations: Array<(value: AtlasDataset) => void> = [
    value => { value.companies[0]!.names = ["Different employer"]; },
    value => { value.companies[0]!.domains = []; },
    value => { value.companies[0]!.parentCompanyIds = ["company.other"]; },
    value => { value.companies[0]!.ultimateControllers.revision++; },
    value => { value.companies[0]!.legalEntity = { value: "Different legal employer", evidence: [], method: "parser", verification: "unverified", revision: 1 }; },
    value => { value.jobs[0]!.companyId = "company.other"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(dataset); mutate(changed);
    assert.deepEqual(getInvalidatedCompanyControlReviewIds(changed, [decision]), [decision.id]);
    assert.equal(projectCompanyControlReviews(changed, [decision]).companies[0]!.controlReview, undefined);
  }
  const invalidation: CompanyControlReviewDecision = { id: "invalidate.one", kind: "invalidate", at, actorScope: "local.system", revision: 11, reason: "source-changed", targetDecisionIds: [decision.id] };
  assert.equal(activeCompanyControlReviewDecision(dataset, [decision, invalidation], decision.companyId), undefined);
  assert.equal(projectCompanyControlReviews(dataset, [decision, invalidation]).companies[0]!.controlReview, undefined);
  assert.equal(projectCompanyControlReviews(dataset, [decision, invalidation]).observations.length, 0, "inactive history does not inflate the public dataset");
  assert.equal(decision.materials[0]!.rawText, rawText, "history keeps its exact archived material");
});

test("revocation is append-only, scoped to the same company and actor, and keeps archived materials", async () => {
  const dataset = base(); const decision = await confirmation(dataset); const revoke = revocation(dataset, decision);
  const current = projectCompanyControlReviews(dataset, [decision, revoke]);
  assert.deepEqual(current.companies, dataset.companies); assert.equal(current.observations.length, 0); assert.equal(decision.materials[0]!.rawText, rawText);
  assert.throws(() => projectCompanyControlReviews(dataset, [decision, { ...revoke, actorScope: "other.user" }]), /revocation/);
  assert.throws(() => projectCompanyControlReviews(dataset, [decision, revoke, { ...revoke, id: "revoke.two", revision: 12 }]), /revocation/);
  assert.throws(() => projectCompanyControlReviews(dataset, [decision, decision]), /decision/);
});

test("archive validation rehashes documents, rejects future histories, and validates old receipts independently of changed source identity", async () => {
  const dataset = base(); const decision = await confirmation(dataset);
  await validateCompanyControlReviewHistory(dataset, [decision], { now: at });
  const tampered = structuredClone(decision); tampered.materials[0]!.contentHash = "0".repeat(64);
  await assert.rejects(validateCompanyControlReviewHistory(dataset, [tampered], { now: at }), /hash/);
  await assert.rejects(validateCompanyControlReviewHistory(dataset, [decision], { now: sourceAt }), /future/);
  const changed = structuredClone(dataset); changed.companies[0]!.names = ["A later source identity"];
  const invalidation: CompanyControlReviewDecision = { id: "invalidate.one", kind: "invalidate", at, actorScope: "local.system", revision: 11, reason: "source-changed", targetDecisionIds: [decision.id] };
  await validateCompanyControlReviewHistory(changed, [decision, invalidation], { now: at });
});

test("reserved projection records and markers cannot be forged, copied into jobs, or stripped without matching history", async () => {
  const dataset = base(); const decision = await confirmation(dataset); const projected = projectCompanyControlReviews(dataset, [decision]);
  assert.equal(isCompanyControlReviewEntityId(projected.observations[0]!.id), true);
  const materialTampered = structuredClone(projected); materialTampered.observations[0]!.rawText = "Forged material";
  assert.throws(() => stripCompanyControlReviewProjection(materialTampered, [decision]), /forged/);
  assert.throws(() => stripCompanyControlReviewProjection(projected, []), /forged/);
  const copied = structuredClone(projected); copied.jobs[0]!.listingIds = [copied.listings[0]!.id];
  assert.throws(() => stripCompanyControlReviewProjection(copied, [decision]), /job-material/);
  const changed = structuredClone(projected); changed.companies[0]!.ultimateControllers.value[0]!.jurisdictionCode = "US";
  assert.throws(() => stripCompanyControlReviewProjection(changed, [decision]), /changed/);
  const fake = structuredClone(projected.companies[0]!); fake.controlReview!.controlMode = "dispersed";
  assert.equal(CompanySchema.safeParse(fake).success, false);
});

test("rebuilding a confirmation is deterministic and returns an independent company", async () => {
  const dataset = base(); const decision = await confirmation(dataset); const first = applyCompanyControlReviewConfirmation(decision.sourceCompany, decision); const second = applyCompanyControlReviewConfirmation(decision.sourceCompany, decision);
  assert.equal(sameCompanyControlReviewValue(first, second), true);
  first.names.push("Only the result was edited");
  assert.equal(second.names.includes("Only the result was edited"), false);
  assert.equal(decision.sourceCompany.names.includes("Only the result was edited"), false);
});
