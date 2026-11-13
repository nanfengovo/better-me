import { z } from "zod";
import { JdMatchReportSchema } from "@better-me/core";

const id=z.string().min(1).max(300);
/** Browser claims are self-report. An allowlisted identifier is not independent verification. */
export const JdMatchMaterialSchema=z.object({
  rawJd:z.string().min(1).max(250000),
  allowedProfileEntryIds:z.array(id).max(10000),
  sessionClaims:z.record(z.string().min(1).max(280),z.string().max(1000000)),
  reportRequested:z.literal(true).optional(),
}).strict().superRefine((value,ctx)=>{
  if(Object.keys(value.sessionClaims).length>1000||JSON.stringify(value).length>1000000)
    ctx.addIssue({code:"custom",message:"JD material capacity exceeded; no text is discarded"});
});
export const JdMatchStructuredSchema=z.object({
  title:z.string(),company:z.string(),location:z.string(),requirements:z.array(z.string()),
  responsibilities:z.array(z.string()),qualifications:z.array(z.string()),preferences:z.array(z.string()),
  compensationRaw:z.string().nullable(),techStack:z.array(z.string()),
}).strict();
export const JdMatchProposalSchema=z.object({
  id, jdItem:z.string().min(1),evidenceType:z.enum(["claimed","gap"]),profileEntryId:id.optional(),
  suggestion:z.string().min(1),rationale:z.string().min(1),evidenceIds:z.array(id),
}).strict();
const report=JdMatchReportSchema.strict();
export const JdMatchResultSchema=z.object({proposals:z.array(JdMatchProposalSchema).max(1000),report:report.optional()}).strict();
export const JdMatchDecisionSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("read_evidence"),handle:id,offset:z.number().int().nonnegative(),length:z.number().int().positive().max(4000)}).strict(),
  z.object({kind:z.literal("match"),proposals:z.array(JdMatchProposalSchema.omit({id:true})).max(1000),report:report.optional()}).strict(),
]);
export const JdMatchReviewSchema=z.record(z.discriminatedUnion("status",[
  z.object({status:z.literal("accepted")}).strict(),
  z.object({status:z.literal("rejected"),reason:z.string().optional()}).strict(),
  z.object({status:z.literal("edited"),editedSuggestion:z.string().min(1)}).strict(),
]));
export type JdMatchMaterial=z.infer<typeof JdMatchMaterialSchema>;
export type JdMatchResult=z.infer<typeof JdMatchResultSchema>;
