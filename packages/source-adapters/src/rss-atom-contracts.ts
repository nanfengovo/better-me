import { z } from "zod";

/** Host-reviewed metadata only; source JSON cannot provide endpoints, code or credentials. */
export const RssAtomSourceOptionsSchema = z.object({
  companyName: z.string().trim().min(1).max(500).optional(),
  enumerationComplete: z.boolean().optional(),
}).strict();
export type RssAtomSourceOptions = z.infer<typeof RssAtomSourceOptionsSchema>;
