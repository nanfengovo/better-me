import { z } from "zod";
import { FactBaseSchema } from "./fact.js";
import { ResumeViewSchema } from "./resume.js";

/** Pure document contract shared by browser persistence and private recovery; no browser or AI imports. */
export const DocumentSchema = z.object({
  documentId: z.string().min(1).max(200).optional(),
  factBase: FactBaseSchema,
  resumeViews: z.array(ResumeViewSchema).min(1),
  activeResumeId: z.string().min(1),
}).refine(doc => doc.resumeViews.some(view => view.id === doc.activeResumeId), {
  message: "当前简历视图不存在，请检查备份中的 activeResumeId。", path: ["activeResumeId"],
});
export type RecoveryDocument = z.infer<typeof DocumentSchema>;
