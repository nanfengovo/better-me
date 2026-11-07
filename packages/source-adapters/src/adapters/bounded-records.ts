import { SourceJobRecordSchema, type SourceAdapterRequest, type SourceJobRecord } from '../contracts.js';
import { assessSourceScopeMatch } from '../local-match.js';

/** Allocate the existing output allowance across an already downloaded page.
 * Matching records precede unread candidates and known exclusions when choosing
 * slots; selected records retain their original source order and selectors. */
export function allocateDownloadedRecordQuota(records: readonly SourceJobRecord[], request: SourceAdapterRequest, limit: number): {
  records: SourceJobRecord[]; invalidRecords: number;
} {
  let invalidRecords = 0;
  const candidates: Array<{ record: SourceJobRecord; index: number; priority: number }> = [];
  for (const [index, input] of records.entries()) {
    if (index % 64 === 0) request.context.throwIfCancelled();
    const parsed = SourceJobRecordSchema.safeParse(input);
    if (!parsed.success) { invalidRecords++; continue; }
    const match = assessSourceScopeMatch(parsed.data, request.scope);
    candidates.push({ record: parsed.data, index, priority: match.status === 'matched' ? 0 : match.status === 'unknown' ? 1 : 2 });
  }
  request.context.throwIfCancelled();
  return {
    records: candidates.sort((left, right) => left.priority - right.priority || left.index - right.index)
      .slice(0, limit).sort((left, right) => left.index - right.index).map(({ record }) => record),
    invalidRecords,
  };
}
