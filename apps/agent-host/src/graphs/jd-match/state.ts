/**
 * JD Match Graph — state schema.
 *
 * The graph receives only:
 *   - The raw JD text (discarded after structuring, not persisted in checkpoint)
 *   - A list of verified profile entry IDs (not the content — content is fetched
 *     per-tool-call via read-index tools)
 *   - A working copy of unverified profile claims supplied by the browser for
 *     this session only
 *
 * What the checkpoint stores after interrupt():
 *   - The structured JD fields (no resume text)
 *   - Profile entry IDs (references, not content)
 *   - The generated proposals (match analysis + gap list)
 *   - Which proposals have been confirmed / rejected
 *   - Step counters and error log
 *
 * Resume text and API keys are NOT in the checkpoint.
 */

import { Annotation, UntrackedValueChannel } from "@langchain/langgraph";

export const JdMatchAnnotation = Annotation.Root({
  // ── Input (provided once at thread start) ──────────────────────────────────

  /** Raw JD text — used only in structureJd node, not persisted after that. */
  rawJd: new UntrackedValueChannel<string>({ initialValueFactory: () => "" }),

  /** IDs of verified profile entries the user allows this thread to read. */
  allowedProfileEntryIds: Annotation<string[]>({
    reducer: (_old, next) => next,
  }),

  /**
   * Unverified profile claims from the browser (e.g. a draft section not yet
   * committed to the verified store). Only present during this session.
   */
  sessionClaims: new UntrackedValueChannel<Record<string, string>>({
    initialValueFactory: () => ({}),
  }),

  // ── Derived by structureJd ─────────────────────────────────────────────────

  structuredJd: Annotation<StructuredJd | undefined>({
    reducer: (_old, next) => next,
    default: () => undefined,
  }),

  // ── Derived by matchProfile ────────────────────────────────────────────────

  proposals: Annotation<MatchProposal[]>({
    reducer: (_old, next) => next,
    default: () => [],
  }),

  // ── Set by confirmProposals (human-in-the-loop) ────────────────────────────

  /** Map from proposal.id → "accepted" | "rejected" | "edited" */
  decisions: Annotation<Record<string, ProposalDecision>>({
    reducer: (old, patch) => ({ ...old, ...patch }),
    default: () => ({}),
  }),

  // ── Diagnostic ────────────────────────────────────────────────────────────

  errors: Annotation<string[]>({
    reducer: (old, next) => old.concat(next),
    default: () => [],
  }),

  stepLog: Annotation<string[]>({
    reducer: (old, next) => old.concat(next),
    default: () => [],
  }),
});

export type JdMatchState = typeof JdMatchAnnotation.State;

// ── Domain types ──────────────────────────────────────────────────────────────

export interface StructuredJd {
  title: string;
  company: string;
  location: string;
  /** Hard requirements extracted from JD */
  requirements: string[];
  /** Nice-to-haves extracted from JD */
  preferences: string[];
  /** Compensation as stated in JD, or null */
  compensationRaw: string | null;
  /** Detected tech stack / tools */
  techStack: string[];
}

export interface MatchProposal {
  /** Stable ID for this proposal within the thread */
  id: string;
  /** Which JD requirement or preference this addresses */
  jdItem: string;
  /**
   * "verified"  — backed by a confirmed profile entry (id in allowedProfileEntryIds)
   * "claimed"   — backed only by sessionClaims (unverified)
   * "gap"       — no evidence found; candidate should address or note
   */
  evidenceType: "verified" | "claimed" | "gap";
  /** Profile entry ID if evidenceType === "verified" */
  profileEntryId?: string;
  /** Suggested resume bullet or talking point */
  suggestion: string;
  /** Brief rationale shown to user for review */
  rationale: string;
}

export type ProposalDecision =
  | { status: "accepted" }
  | { status: "rejected"; reason?: string }
  | { status: "edited"; editedSuggestion: string };
