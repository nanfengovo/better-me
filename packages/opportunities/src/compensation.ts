import { z } from 'zod';
import { CompensationSchema, EntityIdSchema, EvidenceRefSchema, VerificationSchema, type Compensation } from './schema.js';

const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected a real calendar date');

/** A reproducible, dated snapshot. Rates always mean one original unit in CNY. */
export const FxSnapshotSchema = z.object({
  id: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(200),
  date: CalendarDateSchema,
  ratesToCny: z.record(CurrencySchema, z.number().finite().positive()).refine(
    (rates) => rates.CNY === undefined || rates.CNY === 1,
    'A CNY-to-CNY rate must equal 1',
  ),
}).strict();
export type FxSnapshot = z.infer<typeof FxSnapshotSchema>;

export const CompensationNormalizationOptionsSchema = z.object({
  fx: FxSnapshotSchema.optional(),
  allowMonthlyEstimate: z.boolean().default(false),
  now: z.union([z.date(), z.string().datetime({ offset: true }), z.number().finite()]).optional(),
  maxFxAgeDays: z.number().finite().min(0).max(3660).default(30),
}).strict();
export type CompensationNormalizationOptions = z.input<typeof CompensationNormalizationOptionsSchema>;

const AnnualBounds = { min: z.number().finite().nonnegative().optional(), max: z.number().finite().nonnegative().optional() };
export const AnnualAmountSchema = z.object({ currency: CurrencySchema, ...AnnualBounds }).strict().refine(
  (amount) => (amount.min !== undefined || amount.max !== undefined) && (amount.min === undefined || amount.max === undefined || amount.min <= amount.max),
  'Annual amounts require an actual side and ordered bounds',
);
export const CnyAnnualAmountSchema = z.object({ currency: z.literal('CNY'), ...AnnualBounds }).strict().refine(
  (amount) => (amount.min !== undefined || amount.max !== undefined) && (amount.min === undefined || amount.max === undefined || amount.min <= amount.max),
  'Annual amounts require an actual side and ordered bounds',
);
export type AnnualAmount = z.infer<typeof AnnualAmountSchema>;
export const CompensationReasonSchema = z.enum([
  'comparable', 'invalid-compensation', 'invalid-options', 'unverified-amount', 'conflicting-amount', 'missing-evidence',
  'not-base-salary', 'net-salary', 'unknown-tax-basis', 'missing-amount', 'unknown-currency', 'unknown-period',
  'missing-months-per-year', 'missing-hours-per-year', 'missing-days-per-year', 'missing-weeks-per-year',
  'annual-amount-overflow', 'fx-missing', 'fx-rate-missing', 'fx-future', 'fx-stale', 'fx-amount-overflow',
]);
export type CompensationReason = z.infer<typeof CompensationReasonSchema>;

export interface NormalizedCompensation {
  schemaVersion: 1;
  ruleVersion: 'annual-base-v1';
  compensationId: string;
  locationIds?: string[];
  raw: string;
  verification: Compensation['verification'];
  evidence: Compensation['evidence'];
  status: 'comparable' | 'original-only' | 'unavailable';
  reason: CompensationReason;
  estimated: boolean;
  assumptions: string[];
  originalAnnual?: AnnualAmount;
  cnyAnnual?: AnnualAmount & { currency: 'CNY' };
  fx?: { id: string; provider: string; date: string; rateToCny: number; ageDays: number };
}

/** Validate a transport/tool result instead of merely asserting its TypeScript type. */
export const NormalizedCompensationSchema: z.ZodType<NormalizedCompensation> = z.object({
  schemaVersion: z.literal(1),
  ruleVersion: z.literal('annual-base-v1'),
  compensationId: z.string().max(240),
  locationIds: z.array(EntityIdSchema).max(1000).refine((ids) => new Set(ids).size === ids.length, 'Location IDs must be unique').optional(),
  raw: z.string().max(5000),
  verification: VerificationSchema,
  evidence: z.array(EvidenceRefSchema).max(200),
  status: z.enum(['comparable', 'original-only', 'unavailable']),
  reason: CompensationReasonSchema,
  estimated: z.boolean(),
  assumptions: z.array(z.enum(['monthly-base-times-12'])).max(1),
  originalAnnual: AnnualAmountSchema.optional(),
  cnyAnnual: CnyAnnualAmountSchema.optional(),
  fx: z.object({
    id: z.string().trim().min(1).max(200), provider: z.string().trim().min(1).max(200), date: CalendarDateSchema,
    rateToCny: z.number().finite().positive(), ageDays: z.number().finite().nonnegative().int(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.estimated !== (value.assumptions.length > 0)) {
    context.addIssue({ code: 'custom', path: ['assumptions'], message: 'Estimates require an explicit annualization assumption.' });
  }
  if (value.status === 'comparable') {
    if (!value.cnyAnnual || !value.originalAnnual || value.reason !== 'comparable') {
      context.addIssue({ code: 'custom', path: ['status'], message: 'Comparable salary requires both amounts and a comparable reason.' });
    }
    if (value.verification === 'unknown' || value.verification === 'conflicting' || !value.evidence.some((entry) => entry.quote?.trim() || entry.selector?.trim())) {
      context.addIssue({ code: 'custom', path: ['verification'], message: 'Comparable salary must retain bound disclosure evidence.' });
    }
    if (value.originalAnnual?.currency !== 'CNY' && !value.fx) {
      context.addIssue({ code: 'custom', path: ['fx'], message: 'Currency conversion requires a dated FX reference.' });
    }
  } else {
    if (value.cnyAnnual || value.reason === 'comparable' || value.fx) {
      context.addIssue({ code: 'custom', path: ['cnyAnnual'], message: 'Noncomparable salary cannot expose a usable CNY/FX result.' });
    }
    if (value.status === 'original-only' && (!value.originalAnnual || !value.reason.startsWith('fx-'))) {
      context.addIssue({ code: 'custom', path: ['originalAnnual'], message: 'Original-only salary must explain an FX limitation.' });
    }
    if (value.status === 'unavailable' && value.originalAnnual) {
      context.addIssue({ code: 'custom', path: ['originalAnnual'], message: 'Unavailable salary cannot expose a usable annual amount.' });
    }
  }
});

/**
 * Derive annual gross fixed cash without changing or claiming verification of the source.
 * Unknown sides stay absent; bonuses, equity, tax assumptions and work-hour guesses never enter.
 */
export function normalizeCompensation(
  compensation: Compensation,
  options: CompensationNormalizationOptions = {},
): NormalizedCompensation {
  const result: NormalizedCompensation = {
    schemaVersion: 1,
    ruleVersion: 'annual-base-v1',
    compensationId: typeof compensation?.id === 'string' ? compensation.id : '',
    raw: typeof compensation?.raw === 'string' ? compensation.raw : '',
    verification: compensation?.verification ?? 'unknown',
    evidence: Array.isArray(compensation?.evidence) ? structuredClone(compensation.evidence) : [],
    status: 'unavailable',
    reason: 'invalid-compensation',
    estimated: false,
    assumptions: [],
  };
  const parsed = CompensationSchema.safeParse(compensation);
  if (!parsed.success) return result;
  const comp = parsed.data;
  if (comp.locationIds !== undefined) result.locationIds = [...comp.locationIds];
  const parsedOptions = CompensationNormalizationOptionsSchema.safeParse(options);
  if (!parsedOptions.success) return { ...result, reason: 'invalid-options' };
  const opts = parsedOptions.data;
  const now = opts.now === undefined ? new Date() : new Date(opts.now instanceof Date ? opts.now.getTime() : opts.now);
  if (!Number.isFinite(now.getTime())) return { ...result, reason: 'invalid-options' };
  if (comp.verification === 'conflicting') return { ...result, reason: 'conflicting-amount' };
  if (comp.verification === 'unknown') return { ...result, reason: 'unverified-amount' };
  // A source URL alone does not bind the extracted number to a passage/structured field.
  if (!comp.evidence.some((entry) => entry.quote?.trim() || entry.selector?.trim())) {
    return { ...result, reason: 'missing-evidence' };
  }
  if (comp.kind !== 'base') return { ...result, reason: 'not-base-salary' };
  if (comp.tax === 'net') return { ...result, reason: 'net-salary' };
  if (comp.tax !== 'gross') return { ...result, reason: 'unknown-tax-basis' };
  if (comp.min === undefined && comp.max === undefined) return { ...result, reason: 'missing-amount' };
  if (!comp.currency) return { ...result, reason: 'unknown-currency' };

  let factor: number;
  switch (comp.period) {
    case 'year': factor = 1; break;
    case 'month': {
      if (comp.monthsPerYear !== undefined) factor = comp.monthsPerYear;
      else if (opts.allowMonthlyEstimate) {
        factor = 12;
        result.estimated = true;
        result.assumptions.push('monthly-base-times-12');
      } else return { ...result, reason: 'missing-months-per-year' };
      break;
    }
    case 'hour': {
      if (comp.hoursPerYear === undefined) return { ...result, reason: 'missing-hours-per-year' };
      factor = comp.hoursPerYear;
      break;
    }
    case 'day': {
      if (comp.daysPerYear === undefined) return { ...result, reason: 'missing-days-per-year' };
      factor = comp.daysPerYear;
      break;
    }
    case 'week': {
      if (comp.weeksPerYear === undefined) return { ...result, reason: 'missing-weeks-per-year' };
      factor = comp.weeksPerYear;
      break;
    }
    default: return { ...result, reason: 'unknown-period' };
  }
  const annual: AnnualAmount = { currency: comp.currency };
  if (comp.min !== undefined) annual.min = comp.min * factor;
  if (comp.max !== undefined) annual.max = comp.max * factor;
  if (!finiteBounds(annual)) return { ...result, reason: 'annual-amount-overflow' };
  result.originalAnnual = annual;
  result.status = 'original-only';
  if (comp.currency === 'CNY') {
    return { ...result, status: 'comparable', reason: 'comparable', cnyAnnual: { ...annual, currency: 'CNY' } };
  }
  if (!opts.fx) return { ...result, reason: 'fx-missing' };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = (today - Date.parse(`${opts.fx.date}T00:00:00.000Z`)) / 86_400_000;
  if (ageDays < 0) return { ...result, reason: 'fx-future' };
  if (ageDays > opts.maxFxAgeDays) return { ...result, reason: 'fx-stale' };
  const rate = opts.fx.ratesToCny[comp.currency];
  if (rate === undefined) return { ...result, reason: 'fx-rate-missing' };
  const cny: AnnualAmount & { currency: 'CNY' } = { currency: 'CNY' };
  if (annual.min !== undefined) cny.min = annual.min * rate;
  if (annual.max !== undefined) cny.max = annual.max * rate;
  if (!finiteBounds(cny)) return { ...result, reason: 'fx-amount-overflow' };
  return {
    ...result,
    status: 'comparable',
    reason: 'comparable',
    cnyAnnual: cny,
    fx: { id: opts.fx.id, provider: opts.fx.provider, date: opts.fx.date, rateToCny: rate, ageDays },
  };
}

function finiteBounds(value: AnnualAmount): boolean {
  return [value.min, value.max].every((amount) => amount === undefined || (Number.isFinite(amount) && amount >= 0));
}

export type SalaryMetric = 'min' | 'mid' | 'max';

/** Use a specified comparison currency; changing display currency cannot mix raw numbers. */
export function salaryMetric(
  compensation: NormalizedCompensation,
  metric: SalaryMetric = 'min',
  currency = 'CNY',
): number | undefined {
  const annual = currency === 'CNY' ? compensation.cnyAnnual : compensation.originalAnnual;
  if (!annual || annual.currency !== currency) return undefined;
  if (metric === 'min') return annual.min;
  if (metric === 'max') return annual.max;
  return annual.min === undefined || annual.max === undefined ? undefined : annual.min / 2 + annual.max / 2;
}
