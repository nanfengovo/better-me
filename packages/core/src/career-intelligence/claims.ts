import {
  CommitteeSnapshotSchema, committeeFingerprint, hashCommitteeText,
  type ClaimEvidenceSidecar, type CommitteeCitation, type CommitteeClaim, type CommitteeEvidence,
  type CommitteeIssue, type CommitteeSnapshot, type RoleClaimAssessment,
} from "./contracts.js";

export type EvidenceReadRange = { evidenceId: string; startLine: number; endLine: number };
export class CommitteeInputError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CommitteeInputError"; }
}
export async function validateCommitteeSnapshot(input: CommitteeSnapshot): Promise<CommitteeSnapshot> {
  const snapshot = CommitteeSnapshotSchema.parse(input);
  if (JSON.stringify(snapshot).length > 2_000_000) throw new CommitteeInputError("snapshot_size_exceeded");
  for (const ids of [snapshot.claims.map(item => item.id), snapshot.evidence.map(item => item.id), snapshot.authorization.evidenceIds])
    if (new Set(ids).size !== ids.length) throw new CommitteeInputError("duplicate_snapshot_identity");
  const { fingerprint, ...unsigned } = snapshot;
  if (await committeeFingerprint(unsigned) !== fingerprint) throw new CommitteeInputError("snapshot_fingerprint_changed");
  for (const claim of snapshot.claims)
    if (await hashCommitteeText(claim.text) !== claim.hash) throw new CommitteeInputError("claim_hash_changed");
  for (const evidence of snapshot.evidence)
    if (await hashCommitteeText(evidence.excerpt) !== evidence.excerptHash) throw new CommitteeInputError("excerpt_hash_changed");
  if (snapshot.authorization.evidenceIds.some(id => !snapshot.evidence.some(item => item.id === id)))
    throw new CommitteeInputError("grant_references_missing_evidence");
  return snapshot;
}

export function validateCommitteeCitation(citation: CommitteeCitation, snapshot: CommitteeSnapshot, readRanges: readonly EvidenceReadRange[]): CommitteeIssue | undefined {
  const evidence = snapshot.evidence.find(item => item.id === citation.evidenceId);
  const issue = (code: CommitteeIssue["code"], detail: string): CommitteeIssue => ({ code, evidenceId: citation.evidenceId, detail });
  if (!evidence || !snapshot.authorization.evidenceIds.includes(citation.evidenceId))
    return issue("evidence_not_granted", "Citation is outside the explicit evidence grant.");
  if (!readRanges.some(range => range.evidenceId === citation.evidenceId && range.startLine <= citation.startLine && range.endLine >= citation.endLine))
    return issue("unread_evidence", "The role did not read this exact evidence range.");
  if (citation.sourceHash !== evidence.sourceHash || citation.excerptHash !== evidence.excerptHash)
    return issue("invalid_citation", "Citation hashes do not match the immutable source/excerpt version.");
  if (citation.startLine < evidence.startLine || citation.endLine > evidence.endLine || citation.endLine < citation.startLine)
    return issue("invalid_citation", "Citation lines are outside the selected excerpt.");
  const citedText = evidence.excerpt.split(/\r?\n/).slice(citation.startLine - evidence.startLine, citation.endLine - evidence.startLine + 1).join("\n");
  if (!citedText.includes(citation.quote) || !citation.quote.trim())
    return issue("invalid_citation", "Citation quote does not occur verbatim inside the cited lines.");
  return undefined;
}

/** Tokens preserve units. Similar-looking numbers in JD/configuration are not measurements. */
export function committeeNumericTokens(text: string): string[] {
  const normalized = text.normalize("NFKC").replace(/,/g, "");
  const tokens: string[] = [];
  const ranges: Array<[number, number]> = [];
  for (const match of normalized.matchAll(/\b(QPS|TPS)\s*[:=]?\s*(\d+(?:\.\d+)?)/gi)) {
    tokens.push(`${match[2]}${match[1]!.toLowerCase()}`); ranges.push([match.index, match.index + match[0].length]);
  }
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?\s*(?:%|QPS\b|TPS\b|ms\b|毫秒|秒|倍|万|亿|年|个月|天|人|次|台|元|k\b)/gi)) {
    if (!ranges.some(([start, end]) => match.index >= start && match.index < end)) {
      tokens.push(match[0].replace(/\s/g, "").toLowerCase());
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  // Also catch quantities without a familiar metric unit ("processed 10000 requests").
  // Digits embedded in a technology identifier such as SQLite3 are not an impact metric.
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?/g)) {
    if (!ranges.some(([start, end]) => match.index >= start && match.index < end)
      && !/[A-Za-z]/.test(normalized[match.index - 1] ?? "")) tokens.push(match[0]);
  }
  return [...new Set(tokens)];
}
const normalizeToken = (value: string) => committeeNumericTokens(value)[0] ?? value.normalize("NFKC").replace(/\s|,/g, "").toLowerCase();
const attributionRank = (text: string) => /主导|牵头|独立|led\b|owned\b/i.test(text) ? 3 : /实现|开发|搭建|负责|优化|修复|重构|解决|构建|维护|完成|设计|研发|implemented\b|built\b|designed\b|optimized\b|refactored\b|fixed\b|maintained\b/i.test(text) ? 2 : /参与|协助|contributed\b|assisted\b/i.test(text) ? 1 : 0;
const implementation = /实现|开发|搭建|部署|上线|交付|优化|修复|重构|构建|研发|implemented\b|built\b|deployed\b|production\b|optimized\b|refactored\b|fixed\b/i;
const deployment = /上线|投产|生产环境|deployed\b|production\b/i;
const notImplemented = /仅设计|未实现|尚未实现|未开发|not implemented|design only/i;
const notDeployed = /未上线|尚未上线|未部署|未投产|not deployed|not in production/i;
// Negative deployment qualifiers contain the same verbs as affirmative claims.
// Remove only those exact phrases, not an entire sentence: a later positive
// assertion must still be compared against the cited non-deployment evidence.
const assertsDeployment = (text: string) => deployment.test(text.replace(/尚未上线|未上线|未部署|未投产|not deployed|not in production/gi, ""));
const impactfulTerms = ["主导", "独立", "稳定上线", "指标提升", "零故障", "高并发", "分布式", "收益", "营收"];
const englishExcluded = new Set("the and with for from that this into using used built implemented developed led owned improved reduced increased contributed assisted on in to of a an as by is was are were we i my our system project service".split(" "));

function allowedNumericTokens(claim: CommitteeClaim, citations: CommitteeCitation[], evidence: CommitteeEvidence[]): Set<string> {
  const allowed = new Set<string>();
  for (const citation of citations) {
    const item = evidence.find(value => value.id === citation.evidenceId)!;
    if (item.provenance === "user_statement") {
      const confirmed = new Set(claim.confirmedNumericTokens.map(normalizeToken));
      for (const token of committeeNumericTokens(citation.quote)) if (confirmed.has(token)) allowed.add(token);
    }
    if (item.provenance === "assessment" && item.measurement?.result === "passed" && item.measurement.claimIds.includes(claim.id))
      for (const token of committeeNumericTokens(citation.quote)) allowed.add(token);
  }
  return allowed;
}

function wordingSupported(text: string, claim: CommitteeClaim, citations: CommitteeCitation[], evidence: CommitteeEvidence[]): boolean {
  const grounded = [claim.text, ...citations.filter(citation => !["job", "inference"].includes(evidence.find(item => item.id === citation.evidenceId)!.provenance)).map(citation => citation.quote)].join("\n");
  if (committeeNumericTokens(text).some(token => !allowedNumericTokens(claim, citations, evidence).has(token))) return false;
  if (attributionRank(text) > attributionRank(claim.text)) return false;
  if (claim.contribution !== "implementation" && implementation.test(text) && !notImplemented.test(text)) return false;
  if (impactfulTerms.some(term => text.includes(term) && !grounded.includes(term))) return false;
  const technologies = text.match(/\b[A-Za-z][A-Za-z0-9.+#_-]{2,}\b/g) ?? [];
  if (technologies.some(term => !englishExcluded.has(term.toLowerCase()) && !grounded.toLowerCase().includes(term.toLowerCase()))) return false;
  if (deployment.test(text) && !deployment.test(grounded)) return false;
  if (deployment.test(text) && notDeployed.test(grounded) && !notDeployed.test(text)) return false;
  if (implementation.test(text) && notImplemented.test(grounded) && !notImplemented.test(text)) return false;
  // Conservative automatic gate: novel paraphrases need another explicit human/evidence review.
  // Extractive shortening is allowed; arbitrary new Chinese business claims must not slip past a keyword list.
  const clauses = text.split(/[。！？!?，,；;\n]/).map(clause => clause.trim()).filter(Boolean);
  if (clauses.some(clause => clause.length > 1 && !grounded.includes(clause))) return false;
  return true;
}

export function adjudicateClaim(snapshot: CommitteeSnapshot, claim: CommitteeClaim, opinion: RoleClaimAssessment | undefined,
  readRanges: readonly EvidenceReadRange[]): { sidecar: ClaimEvidenceSidecar; issues: CommitteeIssue[] } {
  const issues: CommitteeIssue[] = [];
  const add = (code: CommitteeIssue["code"], detail: string) => issues.push({ code, claimId: claim.id, detail });
  const filterCitations = (citations: CommitteeCitation[]) => citations.filter(citation => {
    const issue = validateCommitteeCitation(citation, snapshot, readRanges);
    if (issue) issues.push({ ...issue, claimId: claim.id });
    return !issue;
  });
  const citations = filterCitations(opinion?.citations ?? []);
  const counterCitations = filterCitations(opinion?.counterCitations ?? []);
  let support = opinion?.support ?? "unknown";
  if (!opinion) add("missing_claim_assessment", "No final assessment exists for this claim.");
  if (issues.length) support = "unknown";
  const sourceItems = citations.map(citation => snapshot.evidence.find(item => item.id === citation.evidenceId)!);
  const usable = sourceItems.filter(item => item.provenance !== "inference" && item.provenance !== "job");
  const usableCounter = counterCitations.filter(citation => !["inference", "job"].includes(snapshot.evidence.find(item => item.id === citation.evidenceId)!.provenance));
  if ((support === "supported" || support === "partial") && !usable.length) {
    add(citations.length ? "inference_is_not_proof" : "no_supporting_evidence", "A supported claim needs granted, non-JD, non-inference evidence."); support = "unknown";
  }
  if (support === "contradicted" && !usable.length && !usableCounter.length) {
    add("no_supporting_evidence", "A red-team contradiction also needs cited evidence; missing evidence is unknown, not proof of falsehood."); support = "unknown";
  }
  if (attributionRank(claim.text) > 0) {
    if (claim.contribution === "not_mine") { add("personal_contribution_denied", "The user explicitly declined personal contribution."); support = "contradicted"; }
    else if (claim.contribution === "unknown") { add("personal_contribution_unknown", "Source code and Git authorship do not establish personal contribution."); if (support !== "contradicted") support = "unknown"; }
  }
  if (claim.contribution === "design" && implementation.test(claim.text) && !notImplemented.test(claim.text)) {
    add("design_is_not_implementation", "A design-only contribution does not support an implementation/deployment claim."); support = "contradicted";
  }
  const allCitedText = [...citations, ...counterCitations].map(citation => citation.quote).join("\n");
  if ((assertsDeployment(claim.text) && notDeployed.test(allCitedText)) || (implementation.test(claim.text) && !notImplemented.test(claim.text) && notImplemented.test(allCitedText))) {
    add("design_is_not_implementation", "The cited source explicitly limits implementation or deployment."); support = "contradicted";
  }
  if (committeeNumericTokens(claim.text).some(token => !allowedNumericTokens(claim, citations, snapshot.evidence).has(token))) {
    add("unsupported_number", "A numeric statement lacks explicit self-confirmation or a matching passed measurement receipt.");
    if (support === "supported") support = "partial";
  }
  let rewriteProposal: ClaimEvidenceSidecar["rewriteProposal"];
  if (opinion?.rewrite && opinion.rewrite.trim() !== claim.text.trim()) {
    if (!citations.length || !wordingSupported(opinion.rewrite, claim, citations, snapshot.evidence))
      add("unsupported_rewrite", "The rewrite introduced unsupported numbers, technology, outcomes, attribution or implementation scope.");
    else rewriteProposal = { originalText: claim.text, proposedText: opinion.rewrite, evidenceIds: [...new Set(citations.map(item => item.evidenceId))], status: "pending_review" };
  }
  const defense = (opinion?.defense ?? []).filter(text => wordingSupported(text, claim, citations, snapshot.evidence));
  if (defense.length !== (opinion?.defense.length ?? 0)) add("unsupported_rewrite", "An unsupported factual defense statement was omitted.");
  const critical = issues.some(issue => ["invalid_citation", "unread_evidence", "evidence_not_granted", "unsupported_number", "personal_contribution_denied", "design_is_not_implementation", "unsupported_rewrite"].includes(issue.code));
  const sidecar: ClaimEvidenceSidecar = {
    schemaVersion: 1, claimId: claim.id, claimHash: claim.hash, snapshotFingerprint: snapshot.fingerprint,
    support, contribution: claim.contribution, provenance: [...new Set(sourceItems.map(item => item.provenance))], citations, counterCitations,
    riskLevel: critical || support === "contradicted" ? "high" : support === "supported" ? "low" : "medium",
    risks: [...(opinion?.risks ?? []), ...issues.map(issue => issue.detail)], missing: opinion?.missing ?? [],
    questions: opinion?.questions ?? [], defense,
    ...(rewriteProposal ? { rewriteProposal } : {}),
    limitations: ["Evidence support is limited to this authorized snapshot; it is not a Fact promotion or external authenticity certificate.",
      "Source and excerpt hashes prove version consistency, not authorship, deployment or business impact.",
      "Deterministic citation and wording checks do not prove general semantic entailment; human review remains required.",
      ...(sourceItems.some(item => item.provenance === "user_statement") ? ["Personal statements and confirmed numbers remain self-reported unless separately measured."] : [])],
  };
  return { sidecar, issues };
}
