export type TwinField = "statement" | "contribution" | "design" | "outcome" | "limitations" | "evidence" | "diagram";
export type TwinDiagram = { nodes: { id: string; label: string }[]; edges: { from: string; to: string; label: string }[] };
export type TwinVerifiedFact = {
  id: string; revision: string; status: "verified" | "self_reported" | "unknown"; disclosure: "local_only" | "publishable";
  statement: string; contribution?: string; design?: string; outcome?: string; limitations?: string;
  evidence?: { id: string; revision: string; summary: string; publicUrl?: string }[];
  diagram?: TwinDiagram;
  /** A receipt is supplied/validated by Workspace, not inferred from Git authorship. */
  verificationReceiptHash: string;
};
export type TwinAccess = {
  ownerId: string; sessionId: string; sessionGeneration: number; authorizationGeneration: number;
  valid(): Promise<boolean>;
};
export type TwinAuthStamp = Omit<TwinAccess, "valid">;
export type TwinWorkspaceAdapter = {
  currentRevision(ownerId: string): Promise<number>;
  /** Resolve only within this authenticated owner. Never return raw private code. */
  snapshot(input: { ownerId: string; expectedRevision: number; factIds: readonly string[] }): Promise<{ ownerId: string; revision: number; facts: TwinVerifiedFact[] }>;
  /** Must verify current receipt, personal contribution semantics and revocation. */
  publicationEligible(input: { ownerId: string; expectedRevision: number; fact: TwinVerifiedFact }): Promise<boolean>;
};
export type TwinPublishedFact = { id: string; revision: string; verificationReceiptHash: string; fields: Partial<Record<Exclude<TwinField, "evidence" | "diagram">, string>>; evidence?: NonNullable<TwinVerifiedFact["evidence"]>; diagram?: TwinDiagram };
export type CandidateCapsule = {
  protocol: "betterme.candidate-capsule.v1"; id: string; version: 1; createdAt: string; expiresAt: string;
  workspaceRevision: number; displayName: string; selectedFields: TwinField[]; facts: TwinPublishedFact[]; limitations: string[]; hash: string;
};
export type TwinPreview = { id: string; capsule: CandidateCapsule; previewHash: string; expiresAt: string; redactions: { category: string; count: number }[] };
export type StoredCapsule = { ownerId: string; capsule: CandidateCapsule; revokedAt?: string };
/** Publication artifacts, never a new Fact authority. Host must implement the
 * commit with its existing session-generation + Workspace CAS transaction/gate. */
export type CandidateCapsuleStore = {
  publish(input: { auth: TwinAuthStamp; expectedWorkspaceRevision: number; previewHash: string; capsule: CandidateCapsule }): Promise<boolean>;
  read(capsuleId: string): Promise<StoredCapsule | undefined>;
  revoke(input: { auth: TwinAuthStamp; capsuleId: string; expectedHash: string; at: string }): Promise<boolean>;
};
export type TwinReaderGrant = {
  capsuleId: string; capsuleHash: string; scopes: readonly ("capsule:read" | "capsule:ask")[]; expiresAt: string;
  valid(): Promise<boolean>;
};
export class CandidateTwinError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CandidateTwinError"; }
}
