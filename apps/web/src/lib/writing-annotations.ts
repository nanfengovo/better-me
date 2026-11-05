import { writingTargetKey, type WritingNote, type WritingSource } from "./resume-copilot";

export const WRITING_ANNOTATION_TONES = ["blue", "violet", "teal", "amber", "rose", "cyan"] as const;
export type WritingAnnotation = { id: string; number: number; tone: typeof WRITING_ANNOTATION_TONES[number]; source: WritingSource };

/** Color follows the source's document position, not the current page or random note ID.
 * Numbers disambiguate long documents and multiple quotes from the same source. */
export function writingAnnotations(notes: WritingNote[], sources: WritingSource[]): WritingAnnotation[] {
  const positions = new Map(sources.map((source, index) => [writingTargetKey(source.targetRef), index]));
  return notes.map((note, index) => ({ id: note.id, number: index + 1, source: note.source,
    tone: WRITING_ANNOTATION_TONES[(positions.get(writingTargetKey(note.source.targetRef)) ?? index) % WRITING_ANNOTATION_TONES.length]!,
  }));
}

export function writingPreviewAnchor(source: WritingSource): string {
  return source.targetRef.kind === "claim_text" ? `claim:${source.targetRef.claimId}` : "profile:headline";
}
