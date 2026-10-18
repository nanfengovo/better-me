import { z } from 'zod';
import { CompanyManualOverrideSchema, type Company } from './schema.js';
import defaultColorsJson from './default-colors.json' with { type: 'json' };

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const LabelSchema = z.string().trim().min(1).max(120);
const JurisdictionSchema = z.string().regex(/^[A-Z]{2}$/);
const JurisdictionsSchema = z.array(JurisdictionSchema).min(1).max(300).refine(
  (values) => new Set(values).size === values.length,
  'Jurisdictions must be unique',
);
export const CompanyOwnershipSchema = z.enum(['state', 'private', 'dispersed', 'joint', 'unknown']);
export type CompanyOwnership = z.infer<typeof CompanyOwnershipSchema>;
export const JurisdictionGroupSchema = z.object({
  id: IdSchema,
  label: LabelSchema,
  match: z.enum(['include', 'all-except']),
  jurisdictions: JurisdictionsSchema,
}).strict();
export const CompanyColorRuleSchema = z.object({
  id: IdSchema,
  priority: z.number().int().min(-10000).max(10000),
  jurisdictions: JurisdictionsSchema.optional(),
  group: IdSchema.optional(),
  ownership: CompanyOwnershipSchema.optional(),
  color: ColorSchema,
  label: LabelSchema,
}).strict().refine(
  (rule) => rule.jurisdictions !== undefined || rule.group !== undefined || rule.ownership !== undefined,
  'At least one finite classification condition is required',
);

/** Data only. No CSS properties, expressions, arbitrary selectors or executable conditions. */
export const CompanyColorConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  defaultColor: ColorSchema,
  defaultLabel: LabelSchema,
  unverifiedLabel: LabelSchema,
  conflictingColor: ColorSchema,
  conflictingLabel: LabelSchema,
  groups: z.array(JurisdictionGroupSchema).max(64),
  rules: z.array(CompanyColorRuleSchema).max(128),
}).strict().superRefine((config, ctx) => {
  const groupIds = new Set<string>();
  config.groups.forEach((group, index) => {
    if (groupIds.has(group.id)) ctx.addIssue({ code: 'custom', path: ['groups', index, 'id'], message: 'Duplicate group ID' });
    groupIds.add(group.id);
  });
  const ruleIds = new Set<string>();
  config.rules.forEach((rule, index) => {
    if (ruleIds.has(rule.id)) ctx.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: 'Duplicate rule ID' });
    ruleIds.add(rule.id);
    if (rule.group && !groupIds.has(rule.group)) {
      ctx.addIssue({ code: 'custom', path: ['rules', index, 'group'], message: 'Unknown jurisdiction group' });
    }
  });
});
export type CompanyColorConfig = z.infer<typeof CompanyColorConfigSchema>;
export type CompanyColorRule = z.infer<typeof CompanyColorRuleSchema>;

/** Return an independent configuration for editing; never mutate a global theme or company fact. */
export function getDefaultCompanyColorConfig(): CompanyColorConfig {
  return CompanyColorConfigSchema.parse(defaultColorsJson);
}

export function importCompanyColorConfig(input: string | unknown): CompanyColorConfig {
  return CompanyColorConfigSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
}

export function exportCompanyColorConfig(config: CompanyColorConfig): string {
  return `${JSON.stringify(CompanyColorConfigSchema.parse(config), null, 2)}\n`;
}

export interface CompanyClassification {
  status: 'verified' | 'unverified' | 'unknown' | 'conflicting';
  ownership: CompanyOwnership;
  jurisdictions: string[];
  controllerNames: string[];
  jointControl: boolean;
  jurisdictionComplete: boolean;
}
export interface CompanyColorMatch {
  configId: string;
  ruleId: string;
  label: string;
  color: string;
  reason: 'matched-rule' | 'controllers-unverified' | 'controllers-conflicting' | 'controllers-unknown' | 'controllers-evidence-missing' | 'no-rule';
  ownershipLabel: string;
  classification: CompanyClassification;
}

export const CompanyClassificationSchema: z.ZodType<CompanyClassification> = z.object({
  status: z.enum(['verified', 'unverified', 'unknown', 'conflicting']),
  ownership: CompanyOwnershipSchema,
  jurisdictions: z.array(JurisdictionSchema).max(100).refine((codes) => new Set(codes).size === codes.length, 'Jurisdictions must be unique'),
  controllerNames: z.array(z.string().min(1).max(500)).max(100).refine((names) => new Set(names).size === names.length, 'Controllers must be unique'),
  jointControl: z.boolean(),
  jurisdictionComplete: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.jointControl !== (value.ownership === 'joint')) {
    context.addIssue({ code: 'custom', path: ['jointControl'], message: 'Joint control and ownership must agree.' });
  }
  if (value.status !== 'verified' && (value.jurisdictions.length || value.controllerNames.length || value.ownership !== 'unknown' || value.jurisdictionComplete)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Unverified controllers cannot become classified facts.' });
  }
  if (value.jurisdictionComplete && (!value.jurisdictions.length || !value.controllerNames.length)) {
    context.addIssue({ code: 'custom', path: ['jurisdictionComplete'], message: 'Complete jurisdiction requires a known controller and origin.' });
  }
});
export const CompanyColorMatchReasonSchema = z.enum([
  'matched-rule', 'controllers-unverified', 'controllers-conflicting', 'controllers-unknown', 'controllers-evidence-missing', 'no-rule',
]);
export const CompanyColorMatchSchema: z.ZodType<CompanyColorMatch> = z.object({
  configId: IdSchema,
  ruleId: IdSchema,
  label: LabelSchema,
  color: ColorSchema,
  reason: CompanyColorMatchReasonSchema,
  ownershipLabel: LabelSchema,
  classification: CompanyClassificationSchema,
}).strict().superRefine((value, context) => {
  const requiredStatus = value.reason === 'controllers-conflicting' ? 'conflicting'
    : value.reason === 'controllers-unverified' ? 'unverified'
      : value.reason === 'controllers-unknown' ? 'unknown' : 'verified';
  if (value.classification.status !== requiredStatus) {
    context.addIssue({ code: 'custom', path: ['classification', 'status'], message: 'Color decision must retain its verification state.' });
  }
});

const OWNERSHIP_LABELS: Record<CompanyOwnership, string> = {
  state: '国有控制', private: '私人控制', dispersed: '股权分散 / 无实际控制人', joint: '共同控制 / 合资', unknown: '所有制待核实',
};

/** Resolve audited manual edits without overwriting source observations or accepting future revisions. */
export function effectiveCompanyControllers(company: Company): Company['ultimateControllers'] {
  const base = company.ultimateControllers;
  let effective = base;
  const knownManualRevisions = new Set<number>();
  const edits = [...company.manualOverrides].sort((left, right) =>
    Date.parse(left.at) - Date.parse(right.at) || compareIds(left.id, right.id));
  for (const input of edits) {
    const parsed = CompanyManualOverrideSchema.safeParse(input);
    if (!parsed.success || parsed.data.field !== 'ultimateControllers') continue;
    const edit = parsed.data;
    if (edit.value.method !== 'manual' || edit.value.revision <= edit.basedOnRevision) continue;
    if (edit.basedOnRevision > base.revision && !knownManualRevisions.has(edit.basedOnRevision)) continue;
    effective = edit.value;
    knownManualRevisions.add(edit.value.revision);
  }
  return structuredClone(effective);
}

/** Only evidenced, verified ultimate control participates. Office location is deliberately unused. */
export function classifyCompany(company: Company): CompanyClassification {
  const controllers = effectiveCompanyControllers(company);
  const classification: CompanyClassification = {
    status: controllers?.verification ?? 'unknown',
    ownership: 'unknown',
    jurisdictions: [],
    controllerNames: [],
    jointControl: false,
    jurisdictionComplete: false,
  };
  if (!controllers || controllers.verification !== 'verified' || controllers.evidence.length === 0 || controllers.method === 'model-proposal') {
    return classification;
  }
  const values = controllers.value;
  if (values.length === 0) return { ...classification, status: 'unknown' };
  classification.jurisdictions = [...new Set(values.flatMap((entry) => entry.jurisdictionCode ? [entry.jurisdictionCode] : []))].sort();
  classification.controllerNames = [...new Set(values.map((entry) => entry.name))].sort();
  classification.jurisdictionComplete = values.every((entry) => Boolean(entry.jurisdictionCode));
  classification.jointControl = values.length > 1 || values.some((entry) => entry.kind === 'joint');
  classification.ownership = classification.jointControl ? 'joint' : values[0]?.kind ?? 'unknown';
  return classification;
}

export function resolveCompanyColor(company: Company, config?: CompanyColorConfig): CompanyColorMatch {
  const settings = config === undefined ? getDefaultCompanyColorConfig() : CompanyColorConfigSchema.parse(config);
  const classification = classifyCompany(company);
  const base: CompanyColorMatch = {
    configId: settings.id,
    ruleId: 'unknown',
    color: settings.defaultColor,
    label: settings.defaultLabel,
    reason: 'controllers-unknown',
    ownershipLabel: OWNERSHIP_LABELS[classification.ownership],
    classification,
  };
  if (classification.status === 'conflicting') {
    return { ...base, ruleId: 'conflicting', color: settings.conflictingColor, label: settings.conflictingLabel, reason: 'controllers-conflicting' };
  }
  if (classification.status === 'unverified') {
    return { ...base, ruleId: 'unverified', label: settings.unverifiedLabel, reason: 'controllers-unverified' };
  }
  if (classification.status !== 'verified') return base;
  const effectiveControllers = effectiveCompanyControllers(company);
  if (!effectiveControllers.evidence.length || effectiveControllers.method === 'model-proposal') {
    return { ...base, reason: 'controllers-evidence-missing' };
  }
  const rules = [...settings.rules].sort((left, right) => right.priority - left.priority || compareIds(left.id, right.id));
  for (const rule of rules) {
    if (rule.ownership && rule.ownership !== classification.ownership) continue;
    // A multi-country controller set only matches a regional rule when all known parties match.
    // Joint-control styling has its own configurable rule, never an arbitrary first controller.
    if (rule.jurisdictions && (!classification.jurisdictionComplete || classification.jurisdictions.length === 0 || !classification.jurisdictions.every((code) => rule.jurisdictions!.includes(code)))) continue;
    if (rule.group) {
      const group = settings.groups.find((item) => item.id === rule.group)!;
      if (!classification.jurisdictionComplete || classification.jurisdictions.length === 0 || !classification.jurisdictions.every((code) =>
        group.match === 'include' ? group.jurisdictions.includes(code) : !group.jurisdictions.includes(code))) continue;
    }
    return { ...base, ruleId: rule.id, color: rule.color, label: rule.label, reason: 'matched-rule' };
  }
  return { ...base, reason: 'no-rule' };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
