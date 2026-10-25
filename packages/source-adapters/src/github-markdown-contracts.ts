import { z } from "zod";

/**
 * Options for a reviewed GitHub Raw Markdown table. The adapter intentionally
 * exposes column names, rather than selectors or executable mapping code.
 */
export const GithubMarkdownSourceOptionsSchema = z.object({
  tableIndex: z.number().int().min(0).max(20).optional(),
  tableIndexes: z.array(z.number().int().min(0).max(20)).max(20).optional(),
  companyHeader: z.string().trim().min(1).max(120).optional(),
  titleHeader: z.string().trim().min(1).max(120).optional(),
  locationHeader: z.string().trim().min(1).max(120).optional(),
  urlHeader: z.string().trim().min(1).max(120).optional(),
  publishedHeader: z.string().trim().min(1).max(120).optional(),
  /** A table is complete only when the source itself makes that claim. */
  enumerationComplete: z.boolean().default(false),
}).strict().superRefine((options, context) => {
  if (options.tableIndex !== undefined && options.tableIndexes !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tableIndexes"], message: "Choose tableIndex or tableIndexes, not both." });
  }
  if (options.tableIndexes && new Set(options.tableIndexes).size !== options.tableIndexes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["tableIndexes"], message: "tableIndexes must be unique." });
  }
});

export type GithubMarkdownSourceOptions = z.infer<typeof GithubMarkdownSourceOptionsSchema>;
