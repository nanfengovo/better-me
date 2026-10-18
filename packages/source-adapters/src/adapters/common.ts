import { HttpUrlSchema, ToolError, type SourceDefinition } from '@better-me/opportunities';
import { isIP } from 'node:net';
import type { SourceAdapterRequest, SourceJobRecord, SourcePage } from '../contracts.js';
import { SourceJobRecordSchema, SourcePageSchema } from '../contracts.js';
import { SourceTransportError } from '../transport.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function own(value: unknown, key: string): unknown {
  const object = record(value);
  return Object.hasOwn(object, key) ? object[key] : undefined;
}
export function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const decode = (input: string) => input.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity.toLowerCase()] ?? entity)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_all, number: string) => {
      const code = number[0]?.toLowerCase() === 'x' ? Number.parseInt(number.slice(1), 16) : Number(number);
      return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
  return decode(decode(value)).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function idValue(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : stringValue(value);
}
export function publicUrl(value: unknown): string | undefined {
  const parsed = HttpUrlSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const url = new URL(parsed.data);
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.port && !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.')
    && !/(?:^|\.)(?:localhost|local|internal|lan)$/.test(host) && !host.endsWith('.home.arpa') ? url.toString() : undefined;
}
export function timeValue(value: unknown): { raw?: string; at?: string } {
  if (typeof value !== 'string' || !value.trim()) return {};
  const raw = value.trim();
  // Date-only or timezone-free strings remain raw, with no invented UTC/time-of-day.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return { raw };
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return { raw };
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? { raw, at: date.toISOString() } : { raw };
}
export function slug(source: SourceDefinition): string {
  const value = source.options?.boardToken ?? source.options?.company;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new ToolError('invalid-input');
  return encodeURIComponent(value);
}
export function companyName(source: SourceDefinition): string | undefined {
  return stringValue(source.options?.companyName) ?? stringValue(source.options?.company);
}
export function baseRecord(title: string, sourceUrl: string, selector: string): SourceJobRecord {
  return {
    entityType: 'job-posting', title, locations: [], compensations: [], workMode: 'unknown', employmentType: 'unknown',
    remoteEligibleRegions: [], availability: 'unknown', completeness: 'excerpt',
    evidence: [{ field: 'title', selector, quote: title, sourceUrl }],
    warnings: ['Listing presence does not verify current availability or final controlling ownership.'],
  };
}
export async function jsonResponse(request: SourceAdapterRequest, url: string): Promise<{ data: unknown; url: string }> {
  request.context.throwIfCancelled();
  const response = await request.transport.request({ url, source: request.source, context: request.context });
  if (response.status < 200 || response.status >= 300) throw new SourceTransportError(response.status === 429 ? 'rate-limited' : 'http-error', response.status);
  try { return { data: JSON.parse(response.text), url: response.url }; } catch { throw new ToolError('source-changed'); }
}
export function page(
  request: SourceAdapterRequest,
  records: SourceJobRecord[],
  args: { totalAvailable?: number; fetchedRecords?: number; nextCursor?: string; partial?: boolean; warning?: string; stopReason?: SourcePage['stopReason'] } = {},
): SourcePage {
  const ignoredFilters = (['roles', 'regions', 'companyNames'] as const).filter((key) => request.scope[key].length > 0);
  const valid: SourceJobRecord[] = [];
  let invalidCount = 0;
  for (const item of records) {
    const parsed = SourceJobRecordSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data); else invalidCount++;
  }
  const partial = args.partial || invalidCount > 0;
  return SourcePageSchema.parse({
    records: valid, observedAt: request.context.observedAt,
    ...(args.nextCursor ? { nextCursor: args.nextCursor } : {}),
    coverage: { complete: !partial && !args.nextCursor, partial: Boolean(partial), fetchedRecords: args.fetchedRecords ?? records.length,
      ...(args.totalAvailable !== undefined ? { totalAvailable: args.totalAvailable } : {}), appliedFilters: [], ignoredFilters },
    ...(partial ? { stopReason: args.stopReason ?? 'source-error' } : {}),
    warnings: [
      ...(ignoredFilters.length ? ['This source enumerates a configured company/feed; requested role/region/company filters must be applied locally.'] : []),
      ...(invalidCount ? [`${invalidCount} source records failed validation and were omitted; enumeration is partial.`] : []),
      ...(args.warning ? [args.warning] : []),
    ],
  });
}
export function workMode(value: unknown): SourceJobRecord['workMode'] {
  const mode = typeof value === 'string' ? value.toLowerCase() : '';
  return mode === 'remote' ? 'remote' : mode === 'hybrid' ? 'hybrid' : ['onsite', 'on-site', 'on_site'].includes(mode) ? 'on-site' : 'unknown';
}
