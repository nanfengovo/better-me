import { z } from "zod";
import { canonicalJson, hashCommitteeText } from "./contracts.js";

export const IntelligenceIdSchema = z.string().trim().min(1).max(240);
export const IntelligenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const IntelligenceBindingSchema = z.object({
  ownerId: IntelligenceIdSchema, workspaceId: IntelligenceIdSchema, sessionGeneration: IntelligenceIdSchema,
  factRevision: IntelligenceIdSchema, rulesVersion: IntelligenceIdSchema,
}).strict();
export type IntelligenceBinding = z.infer<typeof IntelligenceBindingSchema>;
/** The Host binds this reference to an actual disclosure; the hash is not an authenticity certificate. */
export const IntelligenceSourceSchema = z.object({
  id: IntelligenceIdSchema, hash: IntelligenceHashSchema, capturedAt: z.string().datetime(),
  url: z.string().url().max(3000).refine(value => /^https?:\/\//i.test(value), "Only HTTP(S) disclosure URLs are accepted.").optional(),
}).strict();
export type IntelligenceSource = z.infer<typeof IntelligenceSourceSchema>;
export const IntelligenceAuthorizationSchema = z.object({
  grantId: IntelligenceIdSchema, expiresAt: z.string().datetime(), sourceIds: z.array(IntelligenceIdSchema).max(2000),
}).strict();
export const IntelligenceSalarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown"), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ status: z.literal("comparable"), min: z.number().finite().nonnegative(), max: z.number().finite().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/), period: z.literal("annual"), tax: z.literal("gross"), kind: z.literal("base"),
    sourceId: IntelligenceIdSchema, disclosedAt: z.string().datetime(),
  }).strict(),
]).superRefine((salary, context) => {
  if (salary.status === "comparable" && salary.min > salary.max) context.addIssue({ code: "custom", message: "Salary bounds are reversed." });
});
export type IntelligenceSalary = z.infer<typeof IntelligenceSalarySchema>;
export type IntelligenceAccessOptions<T> = { isCurrent: (snapshot: T) => boolean | Promise<boolean>; now?: () => number };

export class IntelligenceInputError extends Error {
  constructor(readonly code: string) { super(code); this.name = "IntelligenceInputError"; }
}
export const intelligenceHash = (value: unknown) => hashCommitteeText(canonicalJson(value));
export function assertUniqueIds(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new IntelligenceInputError(code);
}
export function assertSources(references: readonly string[], sources: readonly IntelligenceSource[], allowed: readonly string[]): void {
  for (const id of references) {
    if (!sources.some(source => source.id === id)) throw new IntelligenceInputError("missing_source_reference");
    if (!allowed.includes(id)) throw new IntelligenceInputError("source_not_authorized");
  }
}
export function ageDays(capturedAt: string, asOf: string): number | undefined {
  const age = (Date.parse(asOf) - Date.parse(capturedAt)) / 86_400_000;
  return age >= 0 ? age : undefined;
}
export async function intelligenceIsCurrent<T extends { authorization: { expiresAt: string } }>(snapshot: T, options: IntelligenceAccessOptions<T>): Promise<boolean> {
  return Date.parse(snapshot.authorization.expiresAt) > (options.now ?? Date.now)() && await options.isCurrent(snapshot);
}
