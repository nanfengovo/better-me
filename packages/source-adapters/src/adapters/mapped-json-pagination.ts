import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ToolError } from '@better-me/opportunities';
import type { SourceAdapterRequest } from '../contracts.js';
import type { JsonFieldMapping } from '../mapping-contracts.js';
import { publicUrl } from './common.js';

const CursorSchema = z.object({
  version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.number().int().min(1).max(1_000_000_000).nullable(),
  offset: z.number().int().min(0).max(1_000_000),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => value.offset > 0 ? !!value.snapshot : value.snapshot === undefined);
type PageState = z.infer<typeof CursorSchema> & { url: string; entry: URL; parameter: string };
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
export const jsonPageFingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function numericPage(value: string): number | undefined {
  if (!/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const page = Number(value); return page <= 1_000_000_000 ? page : undefined;
}
function urlFor(entry: URL, parameter: string, page: number | null): string {
  const url = new URL(entry);
  if (page !== null) url.searchParams.set(parameter, String(page));
  return url.toString();
}

/** Private cursors can name only a numeric page of the reviewed endpoint, never an arbitrary URL. */
export function resolveJsonPage(request: SourceAdapterRequest, mapping: JsonFieldMapping): PageState {
  if (!mapping.nextPageUrlPath || !request.source.entryUrl || !publicUrl(request.source.entryUrl)) throw new ToolError('invalid-input');
  const entry = new URL(request.source.entryUrl), parameter = mapping.pageParameter;
  if (entry.hash || entry.searchParams.getAll(parameter).length > 1) throw new ToolError('invalid-input');
  const initial = entry.searchParams.has(parameter) ? numericPage(entry.searchParams.get(parameter)!) : null;
  if (initial === undefined) throw new ToolError('invalid-input');
  const { maxRecords: _remaining, ...refreshPolicy } = request.source.refreshPolicy;
  const fingerprint = jsonPageFingerprint({ source: { ...request.source, refreshPolicy }, mapping, scope: request.scope });
  let state: z.infer<typeof CursorSchema> = { version: 1, fingerprint, page: initial, offset: 0 };
  if (request.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1000}$/.test(request.cursor)) throw new Error();
      const value = CursorSchema.parse(JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')));
      if (value.fingerprint !== fingerprint || value.page !== null && value.page < (initial ?? 1)) throw new Error();
      state = value;
    } catch { throw new ToolError('invalid-input'); }
  }
  return { ...state, url: urlFor(entry, parameter, state.page), entry, parameter };
}

/** Only the configured page parameter may differ; static query terms, origin and path remain exact. */
export function readJsonNextPage(value: unknown, state: PageState): { page?: number; invalid: boolean } {
  if (value === null) return { invalid: false };
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\\\s\p{Cc}\p{Cs}]/u.test(value)) return { invalid: true };
  try {
    const next = new URL(value, state.url);
    if (!publicUrl(next.toString()) || next.hash || next.origin !== state.entry.origin || next.pathname !== state.entry.pathname
      || next.searchParams.getAll(state.parameter).length !== 1) return { invalid: true };
    const page = numericPage(next.searchParams.get(state.parameter)!);
    if (page === undefined || page <= (state.page ?? 1)) return { invalid: true };
    const expected = new URL(urlFor(state.entry, state.parameter, page));
    next.searchParams.sort(); expected.searchParams.sort();
    return next.toString() === expected.toString() ? { page, invalid: false } : { invalid: true };
  } catch { return { invalid: true }; }
}

export function jsonContinuation(state: PageState, page: number | null, offset = 0, snapshot?: string): string {
  return Buffer.from(JSON.stringify(CursorSchema.parse({ version: 1, fingerprint: state.fingerprint, page, offset,
    ...(snapshot === undefined ? {} : { snapshot }) }))).toString('base64url');
}
