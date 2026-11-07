import { z } from "zod";
import { FxSnapshotSchema } from "./compensation.js";
import { CurrencyCodeSchema, HttpUrlSchema, RevisionSchema, TimestampSchema } from "./schema.js";

export const MAX_FX_RAW_BYTES = 256 * 1024;
export const MAX_FX_SNAPSHOTS = 1000;
export const MAX_FX_AGE_DAYS = 30;
const dayMs = 86_400_000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotId = z.string().regex(/^fx_[a-f0-9]{64}$/);
const provider = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value), "Use an exact, plain provider name.");
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date.");
/** Only public reference selectors may appear in a publication URL, never account secrets. */
export const FxSourceUrlSchema = HttpUrlSchema.refine(value => {
  const url = new URL(value);
  if (url.protocol !== "https:" || value.includes("#")) return false;
  const seen = new Set<string>();
  for (const [key, selector] of url.searchParams) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "providers") { if (!/^[A-Z0-9_,-]{1,160}$/.test(selector)) return false; }
    else if (key === "base") { if (selector !== "EUR") return false; }
    else if (key === "date") { if (!calendarDate.safeParse(selector).success) return false; }
    else if (key === "quotes") { if (!/^[A-Z]{3}(?:,[A-Z]{3}){0,199}$/.test(selector)) return false; }
    else return false;
  }
  return true;
}, "Use an HTTPS publication URL without credentials or fragments and only bounded public providers/base/date/quotes selectors.");
const raw = z.string().min(1).max(MAX_FX_RAW_BYTES).refine(value => new TextEncoder().encode(value).byteLength <= MAX_FX_RAW_BYTES, "FX evidence exceeds the UTF-8 byte limit.");
export const FxImportFormatSchema = z.enum(["eur-reference-json-v1", "frankfurter-v2-eur-json-v1"]);
export type FxImportFormat = z.infer<typeof FxImportFormatSchema>;

export const FxImportDraftSchema = z.object({
  schemaVersion: z.literal(1), provider, sourceUrl: FxSourceUrlSchema,
  retrievedAt: TimestampSchema, raw, format: FxImportFormatSchema,
}).strict();
export type FxImportDraft = z.infer<typeof FxImportDraftSchema>;

/** The raw response remains evidence; manually supplying a publication never certifies its issuer. */
export const FxReferenceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  fx: FxSnapshotSchema.extend({ id: snapshotId, provider }).strict(),
  sourceUrl: FxSourceUrlSchema, retrievedAt: TimestampSchema, raw,
  format: FxImportFormatSchema, contentHash: hash,
  provenance: z.literal("manual-import"),
}).strict();
export type FxReferenceSnapshot = z.infer<typeof FxReferenceSnapshotSchema>;

export const FxQueryContextSchema = z.object({
  schemaVersion: z.literal(1), datasetRevision: RevisionSchema, asOf: TimestampSchema,
  activeSnapshot: FxReferenceSnapshotSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.activeSnapshot && !availableBy(value.activeSnapshot, value.asOf)) context.addIssue({ code: "custom", path: ["activeSnapshot"], message: "An FX reference must exist by the fixed query time." });
});
export type FxQueryContext = z.infer<typeof FxQueryContextSchema>;

export const FxStateSchema = z.object({
  schemaVersion: z.literal(1), revision: RevisionSchema, context: FxQueryContextSchema,
  snapshots: z.array(FxReferenceSnapshotSchema).max(MAX_FX_SNAPSHOTS),
}).strict().superRefine((value, context) => {
  if (value.revision !== value.context.datasetRevision) context.addIssue({ code: "custom", path: ["revision"], message: "FX and jobs must use the same dataset revision." });
  if (new Set(value.snapshots.map(entry => entry.fx.id)).size !== value.snapshots.length) context.addIssue({ code: "custom", path: ["snapshots"], message: "FX snapshot identities must be unique." });
  if (value.context.activeSnapshot && !value.snapshots.some(entry => equalValue(entry, value.context.activeSnapshot))) context.addIssue({ code: "custom", path: ["context", "activeSnapshot"], message: "The active FX reference must match an immutable saved snapshot." });
});
export type FxState = z.infer<typeof FxStateSchema>;

export const PreviewFxImportInputSchema = z.object({ draft: FxImportDraftSchema, expectedRevision: RevisionSchema }).strict();
export type PreviewFxImportInput = z.infer<typeof PreviewFxImportInputSchema>;
export const FxImportPreviewSchema = z.object({ expectedRevision: RevisionSchema, snapshot: FxReferenceSnapshotSchema, previewFingerprint: hash }).strict();
export type FxImportPreview = z.infer<typeof FxImportPreviewSchema>;
export const ConfirmFxImportInputSchema = z.object({
  draft: FxImportDraftSchema, expectedRevision: RevisionSchema, previewFingerprint: hash,
  reviewed: z.literal(true), activate: z.boolean(),
}).strict();
export type ConfirmFxImportInput = z.infer<typeof ConfirmFxImportInputSchema>;
export const ActivateFxSnapshotInputSchema = z.object({ snapshotId: snapshotId.nullable(), expectedRevision: RevisionSchema, reviewed: z.literal(true) }).strict();
export type ActivateFxSnapshotInput = z.infer<typeof ActivateFxSnapshotInputSchema>;
export const FxMutationReceiptSchema = z.object({ ok: z.literal(true), revision: RevisionSchema, snapshotId: snapshotId.nullable(), activeSnapshotId: snapshotId.nullable() }).strict();
export type FxMutationReceipt = z.infer<typeof FxMutationReceiptSchema>;
export const ReadFxStateInputSchema = z.object({ expectedRevision: RevisionSchema.optional() }).strict();
export type ReadFxStateInput = z.infer<typeof ReadFxStateInputSchema>;

const referenceDocument = z.object({
  date: calendarDate, base: z.literal("EUR"), amount: z.literal(1).optional(),
  rates: z.record(CurrencyCodeSchema, z.number().finite().positive()).superRefine((rates, context) => {
    if (Object.keys(rates).length > 200) context.addIssue({ code: "custom", message: "A reference has at most 200 currencies." });
    if (rates.CNY === undefined) context.addIssue({ code: "custom", path: ["CNY"], message: "The source must explicitly quote CNY per EUR." });
    if (rates.EUR !== undefined && rates.EUR !== 1) context.addIssue({ code: "custom", path: ["EUR"], message: "An explicit EUR base quote must equal 1." });
  }),
}).strict();
const frankfurterReferenceDocument = z.array(z.object({
  date: calendarDate, base: z.literal("EUR"), quote: CurrencyCodeSchema, rate: z.number().finite().positive(),
}).strict()).min(1).max(200).superRefine((values, context) => {
  if (new Set(values.map(value => value.quote)).size !== values.length) context.addIssue({ code: "custom", message: "An FX publication cannot repeat currency quotes." });
  if (new Set(values.map(value => value.date)).size !== 1) context.addIssue({ code: "custom", message: "An FX publication must use one reference date." });
  if (!values.some(value => value.quote === "CNY")) context.addIssue({ code: "custom", message: "The source must explicitly quote CNY per EUR." });
  if (values.some(value => value.quote === "EUR" && value.rate !== 1)) context.addIssue({ code: "custom", message: "An explicit EUR base quote must equal 1." });
});
export type FxBuildOptions = { now?: Date | string | number };

/** One source unit in CNY is the EUR/CNY quote divided by that currency's EUR quote. */
export async function buildFxReferenceSnapshot(input: unknown, options: FxBuildOptions = {}): Promise<FxReferenceSnapshot> {
  const draft = FxImportDraftSchema.parse(input);
  const now = validNow(options.now);
  const document = parseReference(draft);
  if (Date.parse(draft.retrievedAt) > now.getTime() || utcDay(document.date) > utcDay(now.toISOString()) || utcDay(document.date) > utcDay(draft.retrievedAt)) throw new TypeError("fx-future");
  const contentHash = await sha256(draft.raw);
  const id = `fx_${await sha256(JSON.stringify(["better-me/fx-reference", 1, draft.provider, draft.sourceUrl, draft.retrievedAt, draft.format, contentHash]))}`;
  const quote = document.rates.CNY!;
  const ratesToCny: Record<string, number> = {};
  for (const currency of Object.keys(document.rates).sort()) {
    const rate = currency === "CNY" ? 1 : quote / document.rates[currency]!;
    if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("fx-rate-overflow");
    ratesToCny[currency] = rate;
  }
  ratesToCny.EUR = quote;
  const result = FxReferenceSnapshotSchema.parse({
    schemaVersion: 1, fx: { id, provider: draft.provider, date: document.date, ratesToCny },
    sourceUrl: draft.sourceUrl, retrievedAt: draft.retrievedAt, raw: draft.raw,
    format: draft.format, contentHash, provenance: "manual-import",
  });
  Object.freeze(result.fx.ratesToCny); Object.freeze(result.fx);
  return Object.freeze(result);
}

/** Rebuild from the retained publication: valid-looking hashes and computed rates are not trusted. */
export async function validateFxReferenceSnapshot(input: unknown, options: FxBuildOptions = {}): Promise<FxReferenceSnapshot> {
  const snapshot = FxReferenceSnapshotSchema.parse(input);
  const rebuilt = await buildFxReferenceSnapshot({ schemaVersion: 1, provider: snapshot.fx.provider, sourceUrl: snapshot.sourceUrl, retrievedAt: snapshot.retrievedAt, raw: snapshot.raw, format: snapshot.format }, options);
  if (!equalValue(snapshot, rebuilt)) throw new TypeError("invalid-fx-reference-snapshot");
  return rebuilt;
}

/** A retained context is validated at its own fixed time, never the browser's later clock. */
export async function validateFxQueryContext(input: unknown): Promise<FxQueryContext> {
  const context = FxQueryContextSchema.parse(input);
  if (context.activeSnapshot) context.activeSnapshot = await validateFxReferenceSnapshot(context.activeSnapshot, { now: context.asOf });
  return Object.freeze(context);
}

export async function validateFxState(input: unknown, options: FxBuildOptions = {}): Promise<FxState> {
  const state = FxStateSchema.parse(input);
  const now = validNow(options.now);
  // Unselected references may have been imported after this query's fixed time.
  const snapshots = await Promise.all(state.snapshots.map(value => validateFxReferenceSnapshot(value, { now })));
  const context = await validateFxQueryContext(state.context);
  return FxStateSchema.parse({ ...state, context, snapshots });
}

export async function buildFxImportPreview(input: unknown, options: FxBuildOptions = {}): Promise<FxImportPreview> {
  const { draft, expectedRevision } = PreviewFxImportInputSchema.parse(input);
  const snapshot = await buildFxReferenceSnapshot(draft, options);
  const previewFingerprint = await sha256(JSON.stringify(["better-me/fx-import-preview", 1, expectedRevision, snapshot.fx.id]));
  return Object.freeze({ expectedRevision, snapshot, previewFingerprint });
}

/** Age uses the same UTC calendar days and inclusive 30-day window as salary normalization. */
export function fxReferenceAgeDays(snapshot: Pick<FxReferenceSnapshot, "fx">, asOf: string): number {
  const date = calendarDate.parse(snapshot.fx.date);
  const at = TimestampSchema.parse(asOf);
  return (utcDay(at) - utcDay(date)) / dayMs;
}

function validNow(value: FxBuildOptions["now"]): Date {
  if (value !== undefined && !(value instanceof Date) && typeof value !== "string" && typeof value !== "number") throw new TypeError("invalid-fx-time");
  if (typeof value === "string") TimestampSchema.parse(value);
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("invalid-fx-time");
  return date;
}
function parseReference(draft: FxImportDraft) {
  const value = parseExactJson(draft.raw);
  if (draft.format === "eur-reference-json-v1") return referenceDocument.parse(value);
  const entries = frankfurterReferenceDocument.parse(value);
  return { date: entries[0]!.date, base: "EUR" as const, rates: Object.fromEntries(entries.map(entry => [entry.quote, entry.rate])) };
}
function utcDay(value: string): number { return Date.parse(`${new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value).toISOString().slice(0, 10)}T00:00:00.000Z`); }
function availableBy(value: FxReferenceSnapshot, asOf: string): boolean {
  return Date.parse(value.retrievedAt) <= Date.parse(asOf) && utcDay(value.fx.date) <= utcDay(asOf);
}
function stable(value: unknown): unknown {
  return Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)])) : value;
}
function equalValue(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON.parse otherwise silently accepts duplicate evidence fields, including escaped aliases. */
function parseExactJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "{") scopes.push(new Set());
    else if (character === "[") scopes.push(null);
    else if (character === "}" || character === "]") scopes.pop();
    else if (character === '"') {
      const start = index++;
      for (; index < value.length; index++) {
        if (value[index] === "\\") index++;
        else if (value[index] === '"') break;
      }
      let after = index + 1;
      while (/\s/.test(value[after] ?? "") && after < value.length) after++;
      if (value[after] === ":") {
        const scope = scopes.at(-1);
        const key = JSON.parse(value.slice(start, index + 1)) as string;
        if (!scope || scope.has(key)) throw new TypeError("duplicate-fx-json-field");
        scope.add(key);
      }
    }
  }
  return parsed;
}
