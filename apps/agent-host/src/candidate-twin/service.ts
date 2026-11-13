import { randomUUID } from "node:crypto";
import { z } from "zod";
import { disclosureViolations, privacyDigest, redactDisclosureText } from "../privacy/content-guard.js";
import { CandidateTwinError } from "./types.js";
import { renderTwinDiagramHtml } from "./diagram-html.js";
import type { CandidateCapsule, CandidateCapsuleStore, TwinAccess, TwinAuthStamp, TwinField, TwinPreview, TwinPublishedFact, TwinReaderGrant, TwinWorkspaceAdapter } from "./types.js";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const fields: readonly TwinField[] = ["statement", "contribution", "design", "outcome", "limitations", "evidence", "diagram"];
const clone = <T>(value: T): T => structuredClone(value);
const stamp = ({ ownerId, sessionId, sessionGeneration, authorizationGeneration }: TwinAccess): TwinAuthStamp => ({ ownerId, sessionId, sessionGeneration, authorizationGeneration });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
type HeldPreview = { preview: TwinPreview; auth: TwinAuthStamp; revision: number };

/** Deterministic publication compiler + extractive read-only twin. It cannot
 * read code, invoke a model/tool, mutate a Fact or refresh itself from Workspace.
 * New facts/versions require a new preview and a new explicit publication. */
export class CandidateTwinService {
  private readonly previews = new Map<string, HeldPreview>();
  constructor(private readonly workspace: TwinWorkspaceAdapter, private readonly store: CandidateCapsuleStore, private readonly now: () => number = Date.now) {}
  private async owner(access: TwinAccess, expectedRevision?: number): Promise<void> {
    let valid: boolean, revision: number;
    try { valid = await access.valid(); revision = await this.workspace.currentRevision(access.ownerId); } catch { throw new CandidateTwinError("twin_authorization_unavailable"); }
    if (!opaque.safeParse(access.ownerId).success || !opaque.safeParse(access.sessionId).success || !Number.isSafeInteger(access.sessionGeneration) || !Number.isSafeInteger(access.authorizationGeneration) || !valid) throw new CandidateTwinError("twin_authorization_changed");
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new CandidateTwinError("twin_workspace_revision_changed");
  }
  async preview(input: { access: TwinAccess; expectedWorkspaceRevision: number; factIds: readonly string[]; selectedFields: readonly TwinField[]; displayName: string; privateTerms?: readonly string[]; expiresAt: string; signal?: AbortSignal }): Promise<TwinPreview> {
    for (const [key, value] of this.previews) if (Date.parse(value.preview.expiresAt) <= this.now()) this.previews.delete(key);
    if (this.previews.size >= 100) throw new CandidateTwinError("twin_preview_limit");
    const factIds = [...input.factIds], selectedFields = [...input.selectedFields], privateTerms = [...(input.privateTerms ?? [])];
    if (!Number.isSafeInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 0 || !factIds.length || factIds.length > 100 || factIds.some(id => !opaque.safeParse(id).success) || new Set(factIds).size !== factIds.length || !selectedFields.length || new Set(selectedFields).size !== selectedFields.length || selectedFields.some(field => !fields.includes(field)) || !selectedFields.includes("statement") || privateTerms.length > 200 || privateTerms.some(term => typeof term !== "string" || term.length < 2 || term.length > 500) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= this.now() || Date.parse(input.expiresAt) > this.now() + 365 * 24 * 60 * 60 * 1000) throw new CandidateTwinError("invalid_twin_selection");
    if (input.signal?.aborted) throw new CandidateTwinError("twin_cancelled");
    await this.owner(input.access, input.expectedWorkspaceRevision);
    let snapshot: Awaited<ReturnType<TwinWorkspaceAdapter["snapshot"]>>;
    try { snapshot = clone(await this.workspace.snapshot({ ownerId: input.access.ownerId, expectedRevision: input.expectedWorkspaceRevision, factIds })); } catch { throw new CandidateTwinError("twin_snapshot_unavailable"); }
    if (snapshot.ownerId !== input.access.ownerId || snapshot.revision !== input.expectedWorkspaceRevision || snapshot.facts.length !== factIds.length || new Set(snapshot.facts.map(fact => fact.id)).size !== factIds.length || snapshot.facts.some(fact => !factIds.includes(fact.id))) throw new CandidateTwinError("twin_snapshot_binding_mismatch");
    const redactions = new Map<string, number>();
    const sanitize = (text: string, max = 8000): string => {
      if (typeof text !== "string" || !text.trim() || text.length > max || disclosureViolations(text).length) throw new CandidateTwinError("unsafe_twin_public_field");
      const sanitized = redactDisclosureText(text, privateTerms);
      for (const entry of sanitized.redactions) redactions.set(entry.category, (redactions.get(entry.category) ?? 0) + entry.count);
      return sanitized.text;
    };
    const displayName = sanitize(input.displayName, 200);
    const published: TwinPublishedFact[] = [];
    for (const id of factIds) {
      const fact = snapshot.facts.find(item => item.id === id)!;
      if (fact.status !== "verified" || fact.disclosure !== "publishable" || !opaque.safeParse(fact.revision).success || !/^[a-f0-9]{64}$/.test(fact.verificationReceiptHash)) throw new CandidateTwinError("twin_fact_not_publication_eligible");
      let eligible: boolean;
      try { eligible = await this.workspace.publicationEligible({ ownerId: input.access.ownerId, expectedRevision: input.expectedWorkspaceRevision, fact }); } catch { throw new CandidateTwinError("twin_receipt_check_unavailable"); }
      if (!eligible) throw new CandidateTwinError("twin_receipt_not_current");
      const value: TwinPublishedFact = { id: fact.id, revision: fact.revision, verificationReceiptHash: fact.verificationReceiptHash, fields: {} };
      for (const field of selectedFields) {
        if (field === "evidence") {
          if (fact.evidence && fact.evidence.length > 50) throw new CandidateTwinError("unsafe_twin_public_field");
          value.evidence = (fact.evidence ?? []).map(evidence => {
            if (!opaque.safeParse(evidence.id).success || !opaque.safeParse(evidence.revision).success) throw new CandidateTwinError("unsafe_twin_public_field");
            let publicUrl: string | undefined;
            if (evidence.publicUrl) {
              let url: URL; try { url = new URL(evidence.publicUrl); } catch { throw new CandidateTwinError("unsafe_twin_public_link"); }
              if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href.length > 2000 || disclosureViolations(url.href).length || privateTerms.some(term => url.href.toLowerCase().includes(term.toLowerCase()))) throw new CandidateTwinError("unsafe_twin_public_link");
              publicUrl = url.href;
            }
            return { id: evidence.id, revision: evidence.revision, summary: sanitize(evidence.summary), ...(publicUrl ? { publicUrl } : {}) };
          });
        } else if (field === "diagram") {
          if (fact.diagram) {
            if (fact.diagram.nodes.length > 100 || fact.diagram.edges.length > 200 || new Set(fact.diagram.nodes.map(node => node.id)).size !== fact.diagram.nodes.length) throw new CandidateTwinError("invalid_twin_diagram");
            const nodes = fact.diagram.nodes.map(node => { if (!opaque.safeParse(node.id).success) throw new CandidateTwinError("invalid_twin_diagram"); return { id: node.id, label: sanitize(node.label, 200) }; });
            const edges = fact.diagram.edges.map(edge => { if (!nodes.some(node => node.id === edge.from) || !nodes.some(node => node.id === edge.to)) throw new CandidateTwinError("invalid_twin_diagram"); return { from: edge.from, to: edge.to, label: edge.label === "" ? "" : sanitize(edge.label, 200) }; });
            value.diagram = { nodes, edges };
          }
        } else if (fact[field] !== undefined) value.fields[field] = sanitize(fact[field]!);
      }
      published.push(value);
    }
    if (input.signal?.aborted) throw new CandidateTwinError("twin_cancelled");
    await this.owner(input.access, input.expectedWorkspaceRevision);
    const body = { protocol: "betterme.candidate-capsule.v1" as const, id: randomUUID(), version: 1 as const, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(input.expiresAt).toISOString(), workspaceRevision: input.expectedWorkspaceRevision, displayName, selectedFields, facts: published, limitations: ["Read-only frozen publication; not a live view of private Workspace or code.", "Receipt/version hashes bind the selected evidence, not independent proof of every achievement.", "Unknown questions are not answered by inference. Downloaded/exported copies cannot be remotely revoked."] };
    const capsule: CandidateCapsule = { ...body, hash: privacyDigest(body) };
    if (Buffer.byteLength(JSON.stringify(capsule)) > 256_000) throw new CandidateTwinError("twin_capsule_limit");
    const preview = { id: randomUUID(), capsule, previewHash: privacyDigest({ capsule, auth: stamp(input.access), revision: input.expectedWorkspaceRevision }), expiresAt: new Date(this.now() + 300_000).toISOString(), redactions: [...redactions].map(([category, count]) => ({ category, count })) };
    this.previews.set(preview.id, { preview: clone(preview), auth: stamp(input.access), revision: input.expectedWorkspaceRevision });
    return clone(preview);
  }

  async publish(input: { previewId: string; expectedPreviewHash: string; access: TwinAccess; consent: true }): Promise<CandidateCapsule> {
    const held = this.previews.get(input.previewId);
    if (!held || Date.parse(held.preview.expiresAt) <= this.now() || Date.parse(held.preview.capsule.expiresAt) <= this.now()) throw new CandidateTwinError("twin_preview_expired_or_unknown");
    if (input.consent !== true || input.expectedPreviewHash !== held.preview.previewHash || privacyDigest(stamp(input.access)) !== privacyDigest(held.auth)) throw new CandidateTwinError("twin_publication_consent_mismatch");
    await this.owner(input.access, held.revision);
    let accepted: boolean;
    try { accepted = await this.store.publish({ auth: stamp(input.access), expectedWorkspaceRevision: held.revision, previewHash: held.preview.previewHash, capsule: clone(held.preview.capsule) }); } catch { throw new CandidateTwinError("twin_publication_unavailable"); }
    if (!accepted) throw new CandidateTwinError("twin_publication_cas_or_authorization_conflict");
    this.previews.delete(input.previewId);
    return clone(held.preview.capsule);
  }

  private async publicCapsule(grant: TwinReaderGrant, scope: "capsule:read" | "capsule:ask"): Promise<CandidateCapsule> {
    let valid: boolean;
    try { valid = await grant.valid(); } catch { throw new CandidateTwinError("twin_reader_authorization_unavailable"); }
    if (!valid || !grant.scopes.includes(scope) || Date.parse(grant.expiresAt) <= this.now() || !Number.isFinite(Date.parse(grant.expiresAt))) throw new CandidateTwinError("twin_reader_not_authorized");
    let stored: Awaited<ReturnType<CandidateCapsuleStore["read"]>>;
    try { stored = await this.store.read(grant.capsuleId); } catch { throw new CandidateTwinError("twin_publication_unavailable"); }
    if (!stored || stored.revokedAt || stored.capsule.hash !== grant.capsuleHash || Date.parse(stored.capsule.expiresAt) <= this.now()) throw new CandidateTwinError("twin_publication_revoked_expired_or_changed");
    const { hash, ...body } = stored.capsule;
    if (privacyDigest(body) !== hash) throw new CandidateTwinError("twin_publication_hash_mismatch");
    try { if (!await grant.valid()) throw new CandidateTwinError("twin_reader_not_authorized"); } catch { throw new CandidateTwinError("twin_reader_not_authorized"); }
    let latest: Awaited<ReturnType<CandidateCapsuleStore["read"]>>;
    try { latest = await this.store.read(grant.capsuleId); } catch { throw new CandidateTwinError("twin_publication_unavailable"); }
    if (!latest || latest.revokedAt || latest.capsule.hash !== hash) throw new CandidateTwinError("twin_publication_revoked_expired_or_changed");
    return clone(stored.capsule);
  }
  async read(grant: TwinReaderGrant): Promise<CandidateCapsule> { return this.publicCapsule(grant, "capsule:read"); }

  async ask(input: { grant: TwinReaderGrant; question: string; maxResults?: number }): Promise<{ capsuleHash: string; unknown: boolean; reason?: string; citations: { factId: string; field: string; text: string }[] }> {
    if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 4000 || !Number.isSafeInteger(input.maxResults ?? 3) || (input.maxResults ?? 3) < 1 || (input.maxResults ?? 3) > 5) throw new CandidateTwinError("invalid_twin_question");
    const capsule = await this.publicCapsule(input.grant, "capsule:ask");
    // Extractive retrieval only. A question (including prompt injection) can
    // select existing public passages but cannot execute commands or add facts.
    const chinese = input.question.match(/[\p{Script=Han}]{2,}/gu) ?? [];
    const tokens = [...new Set([...(input.question.toLowerCase().match(/[a-z0-9_-]{2,}/g) ?? []), ...chinese.flatMap(text => Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)))])].filter(token => !["the", "and", "show", "please", "candidate", "what", "does", "this", "with"].includes(token));
    const passages = capsule.facts.flatMap(fact => [...Object.entries(fact.fields).map(([field, text]) => ({ factId: fact.id, field, text })), ...(fact.evidence ?? []).map(evidence => ({ factId: fact.id, field: "evidence", text: evidence.summary }))]);
    const citations = passages.map(passage => ({ passage, score: tokens.reduce((sum, token) => sum + ((/^[a-z0-9_-]+$/.test(token) ? new RegExp(`\\b${token}\\b`, "i").test(passage.text) : passage.text.includes(token)) ? 1 : 0), 0) })).filter(value => value.score > 0).sort((a, b) => b.score - a.score).slice(0, input.maxResults ?? 3).map(value => value.passage);
    await this.publicCapsule(input.grant, "capsule:ask");
    return { capsuleHash: capsule.hash, unknown: citations.length === 0, ...(citations.length ? {} : { reason: "no_authorized_evidence" }), citations };
  }

  async revoke(input: { capsuleId: string; expectedHash: string; access: TwinAccess }): Promise<void> {
    await this.owner(input.access);
    let accepted: boolean;
    try { accepted = await this.store.revoke({ auth: stamp(input.access), capsuleId: input.capsuleId, expectedHash: input.expectedHash, at: new Date(this.now()).toISOString() }); } catch { throw new CandidateTwinError("twin_revocation_unavailable"); }
    if (!accepted) throw new CandidateTwinError("twin_revocation_cas_or_authorization_conflict");
  }

  async exportStatic(grant: TwinReaderGrant): Promise<{ json: string; html: string }> {
    const capsule = await this.publicCapsule(grant, "capsule:read");
    const sections = capsule.facts.map(fact => `<article><h2>${escapeHtml(fact.id)}</h2>${Object.entries(fact.fields).map(([field, text]) => `<section><h3>${escapeHtml(field)}</h3><p>${escapeHtml(text)}</p></section>`).join("")}${(fact.evidence ?? []).map(evidence => `<p>Evidence ${escapeHtml(evidence.id)}: ${escapeHtml(evidence.summary)}${evidence.publicUrl ? ` <a href="${escapeHtml(evidence.publicUrl)}" rel="noreferrer noopener">public reference</a>` : ""}</p>`).join("")}${fact.diagram ? renderTwinDiagramHtml(fact.diagram, fact.id) : ""}</article>`).join("");
    return { json: JSON.stringify(capsule, null, 2), html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(capsule.displayName)} — verified evidence capsule</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:56rem;margin:3rem auto;padding:0 1.5rem;color:#172033}article{border-top:1px solid #ccd4e0;padding:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}p{overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(capsule.displayName)}</h1><p>Frozen capsule ${escapeHtml(capsule.hash)} · expires ${escapeHtml(capsule.expiresAt)}</p>${sections}<footer>${capsule.limitations.map(text => `<p>${escapeHtml(text)}</p>`).join("")}</footer></body></html>` };
  }
}
