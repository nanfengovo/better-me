import { z } from "zod";
import hash from "hash.js";
import { PersonalStatementSchema } from "@better-me/core";

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const inventoryDigest = (data: unknown) => hash.sha256().update(JSON.stringify(data)).digest("hex");
export const InventoryGroupSchema = z.object({
  id, kind: z.enum(["work", "opensource", "other", "education", "link", "unparsed"]),
  label: z.string().min(1).max(12000), period: z.string().max(200).optional(),
  experienceId: id.optional(), evidence: z.array(z.string().max(32000)).max(2000),
}).strict();
export type InventoryGroup = z.infer<typeof InventoryGroupSchema>;
export const InventorySourceSchema = z.object({
  documentId: id, resumeId: id, importedAt: z.string().datetime().optional(), fileModifiedAt: z.string().datetime().optional(),
  groups: z.array(InventoryGroupSchema).max(2000), fingerprint: digest,
}).strict().superRefine(({ fingerprint, ...source }, ctx) => {
  if (fingerprint !== inventoryDigest(source) || new Set(source.groups.map(g => g.id)).size !== source.groups.length)
    ctx.addIssue({ code: "custom", message: "盘点来源或材料编号不一致。" });
});
export type InventorySource = z.infer<typeof InventorySourceSchema>;
export const inventoryKey = (source: Pick<InventorySource,"documentId"|"resumeId">) => inventoryDigest([source.documentId, source.resumeId]);
// Parse first to canonicalize the ordering of keys before computing an integrity fingerprint.
export function makeInventorySource(input: Omit<InventorySource, "fingerprint">): InventorySource {
  const source = { documentId: input.documentId, resumeId: input.resumeId,
    importedAt: input.importedAt, fileModifiedAt: input.fileModifiedAt, groups: input.groups.map(g => InventoryGroupSchema.parse(g)) };
  return InventorySourceSchema.parse({ ...source, fingerprint: inventoryDigest(source) });
}

export const profileTopics = ["current", "style", "like", "atmosphere", "avoid", "redline", "intent"] as const;
export const ProfileTopicSchema = z.enum(profileTopics);
const use = z.enum(["strategy", "jd", "planning"]);
const quote = z.string().trim().min(1).max(7000);
const disposition = z.enum(["feature","compress","omit","pending"]);
const category = z.enum(["work","portfolio","education","other"]);
export const InventoryAnswerSchema = z.object({
  id, target:id, text:quote, category:category.optional(), disposition:disposition.optional(),
  uses:z.array(use).optional(), matchTerm:z.string().trim().max(120).optional(), strategyTerm:z.string().trim().max(120).optional(),
  question:z.string().max(2000).optional(),
}).strict();
export type InventoryAnswer = z.infer<typeof InventoryAnswerSchema>;
export const ProfileEntrySchema = z.object({
  id, topic:ProfileTopicSchema, quote, uses:z.array(use), matchTerm:z.string().max(120).optional(), strategyTerm:z.string().max(120).optional(),
  confirmedAt:z.string().datetime(), sessionId:id, answerId:id, revision:z.number().int().positive(),
}).strict();
export const InventoryProfileSchema = z.object({ revision:z.number().int().nonnegative(), entries:z.array(ProfileEntrySchema).max(500) }).strict();
export type InventoryProfile = z.infer<typeof InventoryProfileSchema>;
const strategyItem = z.object({ groupId:id, kind:z.string(), label:z.string(), disposition, reason:z.string() }).strict();
export const InventoryReceiptSchema = z.object({
  confirmedAt:z.string().datetime(), reviewHash:digest, selected:z.array(id), profileEntryIds:z.array(id),
  baseline:z.object({ text:quote, documentId:id, fingerprint:digest, confirmedAt:z.string().datetime() }).optional(),
  statements:z.array(PersonalStatementSchema), strategy:z.array(strategyItem), nextSteps:z.array(z.string()), direction:z.array(quote),
}).strict();
export const InventorySessionSchema = z.object({
  id:z.string().uuid(), revision:z.number().int().nonnegative(), source:InventorySourceSchema,
  phase:z.enum(["interview","review","confirmed"]), cursor:z.number().int().nonnegative(),
  answers:z.array(InventoryAnswerSchema).max(4100), skipped:z.array(id).max(2100), receipt:InventoryReceiptSchema.optional(),
  previousAt:z.string().datetime().optional(), last:z.object({ commandId:id, hash:digest }).optional(),
}).strict();
export type InventorySession = z.infer<typeof InventorySessionSchema>;
export const InventoryViewSchema = z.object({ session:InventorySessionSchema, reviewHash:digest, profile:InventoryProfileSchema }).strict();
export type InventoryView = z.infer<typeof InventoryViewSchema>;
export const inventoryTargets = (source:InventorySource) => ["baseline","current","new",...source.groups.map(g=>g.id),...profileTopics.filter(t=>t!=="current")];
const cmd = z.object({ expectedRevision:z.number().int().nonnegative(),commandId:z.string().uuid(),fingerprint:digest }).strict();
export const InventoryCommandSchema = z.discriminatedUnion("kind",[
  cmd.extend({kind:z.literal("answer"),target:id,text:quote,disposition:disposition.optional(),uses:z.array(use).optional(),matchTerm:z.string().trim().max(120).optional(),strategyTerm:z.string().trim().max(120).optional(),question:z.string().max(2000).optional()}),
  cmd.extend({kind:z.literal("add"),target:z.literal("new"),text:quote,category,more:z.boolean()}),
  cmd.extend({kind:z.literal("skip"),target:id}), cmd.extend({kind:z.literal("review")}), cmd.extend({kind:z.literal("back")}),
  cmd.extend({kind:z.literal("edit"),answerId:id,text:quote,disposition:disposition.optional()}),
  cmd.extend({kind:z.literal("confirm"),selected:z.array(id).max(4100),reviewHash:digest}),
  cmd.extend({kind:z.literal("again")}),
]);
export type InventoryCommand = z.infer<typeof InventoryCommandSchema>;
export type InventoryAction = InventoryCommand extends infer V ? V extends InventoryCommand ? Omit<V, keyof z.infer<typeof cmd>> : never : never;
/** User previews these exact fields; no implicit read of the interview ledger, profile or entire resume. */
export const InventoryProbeRequestSchema = z.object({ sessionId:z.string().uuid(),revision:z.number().int().positive(),
  target:id,prompt:z.string().min(1).max(2000),priorAnswer:quote }).strict();
export const InventoryProbeResultSchema = z.object({question:z.string().trim().min(1).max(600)}).strict();
export type InventoryProbeRequest = z.infer<typeof InventoryProbeRequestSchema>;
export const inventoryProbeTaskId=(ownerId:string,idempotencyKey:string)=>"ct_"+inventoryDigest([ownerId,idempotencyKey]).slice(0,32);

/** Only explicit user-selected JD phrases are compared, locally. Never rank people or certify company culture. */
export function inventoryJobSignals(profile:InventoryProfile, jd:string) {
  const lines=jd.split(/[。！？!?\n；;]/u).map(s=>s.trim()).filter(Boolean);
  return profile.entries.filter(e=>e.uses.includes("jd")).map(e=>{
    const term=e.matchTerm?.trim(), matches=term ? lines.filter(s=>s.toLowerCase().includes(term.toLowerCase())) : [];
    const positive=matches.find(s=>!/(?:不|无|免|可选|视情况|协商|并非|非必|without|optional|not\b|no\b)/iu.test(s) &&
      /(?:需|必须|要求|每周|每月|接受|负责|must|required|mandatory)/iu.test(s));
    const conflict=(e.topic==="redline"||e.topic==="avoid") && positive && matches.length===1;
    return {id:e.id, preference:e.quote, quote:positive??matches[0], state:conflict?"conflict" as const : matches.length?"check" as const:"unknown" as const};
  });
}
