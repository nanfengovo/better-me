import { z } from "zod";

/**
 * Options for a reviewed GitHub Raw Markdown table. The adapter intentionally
 * exposes column names, rather than selectors or executable mapping code.
 */
export const GithubMarkdownSourceOptionsSchema = z.object({
  tableIndex: z.number().int().min(0).max(20).default(0),
  companyHeader: z.string().trim().min(1).max(120).optional(),
  titleHeader: z.string().trim().min(1).max(120).optional(),
  locationHeader: z.string().trim().min(1).max(120).optional(),
  urlHeader: z.string().trim().min(1).max(120).optional(),
  publishedHeader: z.string().trim().min(1).max(120).optional(),
  /** A table is complete only when the source itself makes that claim. */
  enumerationComplete: z.boolean().default(false),
}).strict();

export type GithubMarkdownSourceOptions = z.infer<typeof GithubMarkdownSourceOptionsSchema>;
