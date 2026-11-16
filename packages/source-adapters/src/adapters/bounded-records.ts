import { SourceJobRecordSchema, type SourceAdapterRequest, type SourceJobRecord } from '../contracts.js';
import { assessSourceScopeMatch } from '../local-match.js';

function recordRecencyTimestamp(record: Pick<SourceJobRecord, 'sourceUpdatedAt' | 'sourcePublishedAt'>): number {
  const updated = record.sourceUpdatedAt ? Date.parse(record.sourceUpdatedAt) : Number.NaN;
  if (Number.isFinite(updated)) return updated;
  const published = record.sourcePublishedAt ? Date.parse(record.sourcePublishedAt) : Number.NaN;
  return Number.isFinite(published) ? published : Number.NEGATIVE_INFINITY;
}

/** Compares two records newest-first by updated/published timestamp while treating missing dates as equal. */
export function compareRecordRecencyDesc(
  left: Pick<SourceJobRecord, 'sourceUpdatedAt' | 'sourcePublishedAt'>,
  right: Pick<SourceJobRecord, 'sourceUpdatedAt' | 'sourcePublishedAt'>,
): number {
  const leftTs = recordRecencyTimestamp(left);
  const rightTs = recordRecencyTimestamp(right);
  if (leftTs === rightTs) return 0;
  return leftTs > rightTs ? -1 : 1;
}

/** Allocate the existing output allowance across an already downloaded page.
 * Matching records precede unread candidates and known exclusions when choosing
 * slots, preferring newest records within each tier when truncating above `limit`;
 * selected records retain their original source order and selectors. */
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
  const selected = candidates.length <= limit
    ? candidates
    : candidates.sort((left, right) => left.priority - right.priority || compareRecordRecencyDesc(left.record, right.record) || left.index - right.index)
        .slice(0, limit).sort((left, right) => left.index - right.index);
  return {
    records: selected.map(({ record }) => record),
    invalidRecords,
  };
}
