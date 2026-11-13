import { createHash } from "node:crypto";
import type { CareerTaskEvidence } from "@better-me/agent-contracts";

export const EVIDENCE_RETRIEVAL_POLICY = { version: "bm25-v1", topK: 6, passageChars: 2400 } as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const lineCount = (text: string) => text.split("\n").length - 1;
const sourceKey = (item: CareerTaskEvidence) => JSON.stringify([item.sourceId, item.path ?? null, item.hash]);
const spanKey = (item: CareerTaskEvidence) => JSON.stringify([sourceKey(item), item.startOffset, item.endOffset]);

/** Local lexical retrieval only: no filesystem, embedding endpoint, generated summary or new grant. */
export function evidenceTerms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms: string[] = normalized.match(/[a-z0-9_]+(?:[.+#-][a-z0-9_]+|[+#])*/g) ?? [];
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = Array.from(match[0]);
    if (characters.length === 1) terms.push(characters[0]!);
    else for (let i = 0; i + 1 < characters.length; i++) terms.push(characters[i]! + characters[i + 1]!);
  }
  return terms;
}

/** Lossless passage partition. Coordinates are absolute, end-exclusive UTF-16 offsets.
 * Paragraph/newline boundaries are preferred; long lines are explicitly pageable, never shortened in storage. */
export function evidencePassages(item: CareerTaskEvidence, maxChars: number = EVIDENCE_RETRIEVAL_POLICY.passageChars): CareerTaskEvidence[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 64) throw new Error("invalid_passage_size");
  // Historical records may have line spans but no absolute character origin.
  // Keep that record intact; ranking requires a coordinate-bearing reread first.
  if (item.excerpt.length <= maxChars || item.startOffset === undefined) return [item];
  const text = item.excerpt, base = item.startOffset ?? 0, result: CareerTaskEvidence[] = [];
  const paragraphEnds = [...text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)].map(m => m.index! + m[0].length);
  let start = 0, startLine = item.startLine ?? 1;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const paragraphEnd = paragraphEnds.find(offset => offset > start && offset <= end);
      const newline = text.lastIndexOf("\n", end - 1) + 1;
      if (paragraphEnd !== undefined) end = paragraphEnd;
      else if (newline > start) end = newline;
      if (text[end - 1] === "\r" && text[end] === "\n") end--;
      const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    const excerpt = text.slice(start, end), startOffset = base + start, endOffset = base + end;
    result.push({ ...item, id: `ev_${hash([sourceKey(item), startOffset, endOffset, excerpt]).slice(0, 28)}`,
      excerpt, startOffset, endOffset, startLine, endLine: startLine + lineCount(excerpt),
      sourceLength: item.sourceLength });
    startLine += lineCount(excerpt); start = end;
  }
  return result;
}

export function evidenceManifest(items: CareerTaskEvidence[]) {
  return items.map(({ id, excerpt: _, ...metadata }) => ({
    handle: `ref_${hash([id, metadata]).slice(0, 28)}`, ...metadata,
    readWith: "read_evidence" as const,
  }));
}

export function resolveEvidenceHandle(items: CareerTaskEvidence[], handle: string) {
  const index = evidenceManifest(items).findIndex(item => item.handle === handle);
  return index < 0 ? undefined : items[index];
}

/** Phase 1 BM25 over every collected authorized passage; phase 2 query-coverage
 * reranking and exact-span deduplication. Stable ties make the projection reproducible. */
export function rankEvidence(items: CareerTaskEvidence[], query: string, topK: number = EVIDENCE_RETRIEVAL_POLICY.topK) {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 40) throw new Error("invalid_retrieval_top_k");
  const passages = new Map<string, CareerTaskEvidence>();
  const unlocatedEvidenceIds = items.filter(item => item.startOffset === undefined).map(item => item.id).sort();
  for (const item of items.filter(item => !unlocatedEvidenceIds.includes(item.id))) for (const passage of evidencePassages(item)) {
    const key = passage.startOffset === undefined ? passage.id : spanKey(passage);
    if (!passages.has(key)) passages.set(key, passage);
  }
  const documents = [...passages.values()].map(passage => {
    const tokens = evidenceTerms(passage.excerpt), frequencies = new Map<string, number>();
    for (const term of tokens) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { passage, frequencies, size: tokens.length };
  });
  const terms = [...new Set(evidenceTerms(query))], df = new Map<string, number>();
  for (const term of terms) df.set(term, documents.filter(d => d.frequencies.has(term)).length);
  const averageSize = documents.reduce((sum, d) => sum + d.size, 0) / (documents.length || 1) || 1;
  const ranked = documents.map(({ passage, frequencies, size }) => {
    let coarseScore = 0, matches = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      matches++;
      const inverseFrequency = Math.log(1 + (documents.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      coarseScore += inverseFrequency * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * size / averageSize));
    }
    const queryCoverage = matches / (terms.length || 1);
    return { evidence: passage, coarseScore, queryCoverage, score: coarseScore * (1 + 0.25 * queryCoverage) };
  }).sort((a, b) => b.score - a.score || sourceKey(a.evidence).localeCompare(sourceKey(b.evidence))
    || (a.evidence.startOffset ?? 0) - (b.evidence.startOffset ?? 0) || a.evidence.id.localeCompare(b.evidence.id));
  return { selected: ranked.filter(item => item.evidence.excerpt.trim()).slice(0, topK), totalPassages: documents.length, unlocatedEvidenceIds };
}
